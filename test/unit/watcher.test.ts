import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  LeaseStore,
  type Lease,
  type NewLease,
} from '../../src/core/leases/store.js';
import {
  watchLeases,
  defaultWatcherDeps,
  leaseDirWatch,
  type WatcherDeps,
} from '../../src/core/leases/watcher.js';
import { ownsManifest } from '../../src/core/leases/siblings.js';
import { McprocError } from '../../src/core/errors.js';
import { abortableSleep } from '../../src/core/wait.js';

const vars = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'projects',
  'vars'
);

const input = (over: Partial<NewLease> = {}): NewLease => ({
  kind: 'start',
  project: 'demo-w1',
  root: '/w/a',
  slot: 1,
  repo: '/w/demo',
  target: 'dev',
  apps: ['db', 'api'],
  reload: false,
  estimate_mib: 768,
  need_mib: 845,
  margin: 0.1,
  reserve_mib: 1024,
  sources: {
    db: { mib: 512, source: 'declared' },
    api: { mib: 256, source: 'declared' },
  },
  note: null,
  requester_pid: process.pid,
  ...over,
});

describe('watchLeases', () => {
  let dir: string;
  let store: LeaseStore;
  let now: number;
  let available: number;
  let started: string[];
  let online: Set<string>;
  const deps = (): WatcherDeps => ({
    store,
    memory: async () => ({ total_mib: 8000, available_mib: available }),
    estimate: async (l) => ({
      estimate_mib: l.estimate_mib,
      need_mib: l.need_mib,
      reserve_mib: l.reserve_mib,
      sources: l.sources,
    }),
    runStart: async (l) => {
      started.push(l.id);
      await store.transition(l.id, 'running', { child_pid: null }); // what the child does
    },
    onlineApps: async () => online,
    settleMs: () => 5,
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    log: () => undefined,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-watch-'));
    now = 1_700_000_000_000;
    store = new LeaseStore(dir, { now: () => now });
    available = 5000;
    started = [];
    online = new Set(['db', 'api']);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('admits the head when it fits, settles, then the next; exits when idle', async () => {
    const a = await store.create(input(), 'pending');
    const b = await store.create(
      input({ project: 'demo-w2', root: '/w/b' }),
      'pending'
    );
    const r = await watchLeases(deps(), { tickMs: 10, idleExitMs: 50 });
    expect(r).toBe('idle');
    expect(started).toEqual([a.id, b.id]);
    expect(store.get(a.id)?.state).toBe('running');
    expect(store.get(b.id)?.state).toBe('running');
  });

  it('leaves the head pending with its reason while memory is short, and admits it once memory frees up', async () => {
    available = 1500;
    const a = await store.create(input(), 'pending');
    const d = deps();
    const memory = d.memory;
    let calls = 0;
    d.memory = async () => {
      calls++;
      if (calls >= 3) available = 5000;
      return memory();
    };
    const r = await watchLeases(d, { tickMs: 10, idleExitMs: 50 });
    expect(r).toBe('idle');
    expect(started).toEqual([a.id]);
    const l = store.get(a.id)!;
    expect(l.state).toBe('running');
  });

  it('estimates a head that does not fit once per 30 s, not once per tick, keeps its reason current from the memory reading, and estimates and admits it on the tick memory frees', async () => {
    available = 1500;
    const a = await store.create(input(), 'pending');
    const t0 = now;
    const d = deps();
    const estimates: number[] = [];
    const estimate = d.estimate;
    d.estimate = async (l) => {
      estimates.push(now - t0);
      return estimate(l);
    };
    let reads = 0;
    let seen: string | null | undefined;
    d.memory = async () => {
      reads++;
      if (now - t0 === 14_000) seen = store.get(a.id)?.waiting_for;
      if (now - t0 >= 10_000) available = 1600;
      if (now - t0 >= 64_000) available = 5000;
      return { total_mib: 8000, available_mib: available };
    };
    expect(await watchLeases(d, { tickMs: 2000, idleExitMs: 10_000 })).toBe(
      'idle'
    );
    // a full estimate when it became the head, at 30 s and 60 s, then on the tick the reading lets it fit
    expect(estimates).toEqual([0, 30_000, 60_000, 64_000]);
    expect(reads).toBe(33); // the memory alone on every tick from 0 to 64 s
    // the reading of 10 s on, recorded by a tick that did not estimate
    expect(seen).toBe(
      'needs 845M, host has 576M over the reserve (269M short)'
    );
    expect(started).toEqual([a.id]);
    expect(store.get(a.id)?.state).toBe('running');
  });

  it('records what the head waits for', async () => {
    available = 1500;
    const a = await store.create(input(), 'pending');
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(a.id)?.waiting_for).toBe(
      'needs 845M, host has 476M over the reserve (369M short)'
    );
    expect(started).toEqual([]);
  });

  it('frees a running lease whose apps are all gone (reconciliation)', async () => {
    const a = await store.create(input(), 'running');
    online = new Set();
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(a.id)?.state).toBe('freed');
  });

  it('fails a starting lease that never recorded its child, after the stuck time', async () => {
    const a = await store.create(input(), 'pending');
    await store.transition(a.id, 'starting', { child_pid: null });
    now += 9 * 60 * 1000; // within the grace: left alone
    await watchLeases(deps(), {
      tickMs: 10,
      once: true,
      stuckMs: 10 * 60 * 1000,
    });
    expect(store.get(a.id)?.state).toBe('starting');
    now += 2 * 60 * 1000;
    await watchLeases(deps(), {
      tickMs: 10,
      once: true,
      stuckMs: 10 * 60 * 1000,
    });
    expect(store.get(a.id)).toMatchObject({
      state: 'failed',
      error: 'the start did not answer within 600 s',
    });
  });

  it('marks an exec lease starting and leaves the run to its owner', async () => {
    const a = await store.create(
      input({ kind: 'exec', apps: [], target: 'bun test' }),
      'pending'
    );
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(started).toEqual([]);
    expect(store.get(a.id)?.state).toBe('starting');
  });

  it('ends an exec lease whose requester is gone on the next tick: a running one freed, a starting one failed', async () => {
    const gone = spawnSync(process.execPath, ['-e', '0']).pid as number;
    const exec = { kind: 'exec' as const, apps: [], target: 'bun test' };
    const running = await store.create(
      input({ ...exec, requester_pid: gone }),
      'running'
    );
    const starting = await store.create(
      input({ ...exec, requester_pid: gone }),
      'pending'
    );
    await store.transition(starting.id, 'starting');
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(running.id)).toMatchObject({
      state: 'freed',
      error: 'requester gone',
    });
    expect(store.get(starting.id)).toMatchObject({
      state: 'failed',
      error: 'requester gone',
    });
  });

  it('leaves the exec leases of a live requester alone, running, starting or pending', async () => {
    const exec = { kind: 'exec' as const, apps: [], target: 'bun test' };
    const running = await store.create(input(exec), 'running');
    const starting = await store.create(input(exec), 'pending');
    await store.transition(starting.id, 'starting');
    const pending = await store.create(input(exec), 'pending');
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(running.id)?.state).toBe('running');
    expect(store.get(starting.id)?.state).toBe('starting');
    expect(store.get(pending.id)).toMatchObject({
      state: 'pending',
      error: null,
    });
  });

  it('fails an exec lease its live owner left starting for longer than 60 s, and leaves a younger one alone', async () => {
    const exec = { kind: 'exec' as const, apps: [], target: 'bun test' };
    const old = await store.create(input(exec), 'pending');
    await store.transition(old.id, 'starting');
    now += 30_000;
    const young = await store.create(input(exec), 'pending');
    await store.transition(young.id, 'starting');
    now += 31_000; // the first one 61 s starting, the second 31 s
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(old.id)).toMatchObject({
      state: 'failed',
      error: 'the exec did not take its turn',
    });
    expect(store.get(young.id)?.state).toBe('starting');
  });

  it('cancels a pending exec at the head whose requester is gone and judges the next one at once', async () => {
    const t0 = now;
    const gone = spawnSync(process.execPath, ['-e', '0']).pid as number;
    const dead = await store.create(
      input({
        kind: 'exec',
        apps: [],
        target: 'bun test',
        requester_pid: gone,
      }),
      'pending'
    );
    const b = await store.create(input({ project: 'demo-w2' }), 'pending');
    const d = deps();
    const at: number[] = [];
    const run = d.runStart;
    d.runStart = async (l) => {
      at.push(now - t0);
      await run(l);
    };
    expect(await watchLeases(d, { tickMs: 10, idleExitMs: 50 })).toBe('idle');
    expect(store.get(dead.id)).toMatchObject({
      state: 'cancelled',
      error: 'requester gone',
    });
    expect(started).toEqual([b.id]);
    expect(at).toEqual([0]); // no tick passed between the cancel and the next judgement
  });

  it('cancels a head that stopped fitting at all', async () => {
    const a = await store.create(input({ need_mib: 20000 }), 'pending');
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(a.id)).toMatchObject({ state: 'cancelled' });
    expect(store.get(a.id)?.error).toMatch(/never/);
  });

  it('stops on the signal', async () => {
    await store.create(input(), 'pending');
    const ac = new AbortController();
    const d = deps();
    d.runStart = async () => {
      ac.abort();
    };
    expect(await watchLeases(d, { tickMs: 10, signal: ac.signal })).toBe(
      'aborted'
    );
  });

  it('fails a lease the start left starting once its run has ended', async () => {
    const a = await store.create(input(), 'pending');
    const d = deps();
    d.runStart = async (l) => {
      started.push(l.id); // the child exited before it reached its answer
    };
    await watchLeases(d, { tickMs: 10, once: true });
    expect(started).toEqual([a.id]);
    expect(store.get(a.id)).toMatchObject({
      state: 'failed',
      error: 'the start ended without an answer',
    });
  });

  it('a lease cancelled while the head was judged is not written over, and nothing is started', async () => {
    const a = await store.create(input(), 'pending');
    const d = deps();
    d.memory = async () => {
      // a stop of its apps lands between the read of the head and its admission
      await store.withLock(() =>
        store.transition(a.id, 'cancelled', { error: 'stop of db' })
      );
      return { total_mib: 8000, available_mib: available };
    };
    const lines: string[] = [];
    d.log = (line) => lines.push(line);
    expect(await watchLeases(d, { tickMs: 10, once: true })).toBe('idle');
    expect(started).toEqual([]);
    expect(store.get(a.id)).toMatchObject({
      state: 'cancelled',
      error: 'stop of db',
    });
    expect(lines.filter((l) => l.startsWith('error'))).toEqual([]);
  });

  it('charges the running leases that still ramp against the reading, like the gate', async () => {
    available = 2500;
    await store.create(input({ project: 'demo-w0', root: '/w/z' }), 'running'); // admitted just now: ramping
    const a = await store.create(input(), 'pending');
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(started).toEqual([]);
    expect(store.get(a.id)?.waiting_for).toBe(
      'needs 845M, host has 631M over the reserve (214M short, 845M ramping)'
    );
    now += 5; // settled: the reading shows it now
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(started).toEqual([a.id]);
  });

  it('a tick that throws is logged and the loop goes on', async () => {
    const a = await store.create(input(), 'running');
    const lines: string[] = [];
    const d = deps();
    let calls = 0;
    d.onlineApps = async () => {
      if (++calls === 1) throw new Error('pm2 down');
      return new Set();
    };
    d.log = (line) => lines.push(line);
    expect(await watchLeases(d, { tickMs: 10, idleExitMs: 30 })).toBe('idle');
    expect(lines.some((l) => l.includes('pm2 down'))).toBe(true);
    expect(store.get(a.id)?.state).toBe('freed');
  });

  it('spares a running lease whose starter is alive (its apps may not be up yet), and frees it once the starter is gone', async () => {
    const a = await store.create(input(), 'running', {
      child_pid: process.pid,
    });
    online = new Set();
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(a.id)?.state).toBe('running');
    const gone = spawnSync(process.execPath, ['-e', '0']).pid as number;
    await store.patch(a.id, { child_pid: gone });
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(a.id)?.state).toBe('freed');
  });

  it('leaves a note in the state directory when it exits idle', async () => {
    expect(await watchLeases(deps(), { tickMs: 10, idleExitMs: 20 })).toBe(
      'idle'
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'watcher.json'), 'utf8'))
    ).toEqual({
      exiting_at: new Date(now).toISOString(),
    });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('does not exit idle when a lease queued in the moment before: it takes it first', async () => {
    const d = deps();
    const t0 = now;
    let queued: Lease | null = null;
    d.now = () => {
      // the start queues between the idle decision and the exit
      if (!queued && now - t0 >= 20)
        void store.create(input(), 'pending').then((l) => {
          queued = l;
        });
      return now;
    };
    expect(await watchLeases(d, { tickMs: 10, idleExitMs: 20 })).toBe('idle');
    expect(queued).not.toBeNull();
    expect(started).toEqual([queued!.id]);
    expect(fs.existsSync(path.join(dir, 'watcher.json'))).toBe(true);
  });

  it('fails a starting lease whose recorded child is gone at once', async () => {
    const a = await store.create(input(), 'pending');
    const gone = spawnSync(process.execPath, ['-e', '0']).pid as number;
    await store.transition(a.id, 'starting', { child_pid: gone });
    await watchLeases(deps(), { tickMs: 10, once: true });
    expect(store.get(a.id)).toMatchObject({
      state: 'failed',
      error: "the start's child is gone",
    });
  });

  it('cancels a head whose checkout is gone and judges the next one at once', async () => {
    const t0 = now;
    const gone = await store.create(
      input({ root: path.join(dir, 'gone') }),
      'pending'
    );
    const b = await store.create(
      input({ project: 'demo-w2', root: vars }),
      'pending'
    );
    const d = deps();
    d.gone = (l) => !ownsManifest(l.root);
    const at: number[] = [];
    const run = d.runStart;
    d.runStart = async (l) => {
      at.push(now - t0);
      await run(l);
    };
    expect(await watchLeases(d, { tickMs: 10, idleExitMs: 50 })).toBe('idle');
    expect(store.get(gone.id)).toMatchObject({
      state: 'cancelled',
      error: 'checkout gone',
    });
    expect(started).toEqual([b.id]);
    expect(at).toEqual([0]); // no tick passed between the cancel and the next judgement
  });

  it('frees a running lease whose checkout is gone, without an error every tick', async () => {
    const a = await store.create(
      input({ root: path.join(dir, 'gone') }),
      'running'
    );
    const lines: string[] = [];
    const d = deps();
    d.gone = (l) => !ownsManifest(l.root);
    d.log = (line) => lines.push(line);
    await watchLeases(d, { tickMs: 10, once: true });
    expect(store.get(a.id)).toMatchObject({
      state: 'freed',
      error: 'checkout gone',
    });
    // the same when only pm2's side finds the manifest missing
    const b = await store.create(input(), 'running');
    d.gone = undefined;
    d.onlineApps = async () => {
      throw new McprocError(
        'MANIFEST_NOT_FOUND',
        'No .mcproc/mcproc.yaml found in /w/a or its parents'
      );
    };
    await watchLeases(d, { tickMs: 10, once: true });
    expect(store.get(b.id)).toMatchObject({
      state: 'freed',
      error: 'checkout gone',
    });
    expect(lines.filter((l) => l.startsWith('error'))).toEqual([]);
  });

  it('a lease queued while the head is judged is taken at once: the queue is compared as it was before the judgement, not as it is at the sleep', async () => {
    available = 1500; // the head does not fit: it waits
    const a = await store.create(input(), 'pending');
    const events: string[] = [];
    let wake: (() => void) | null = null;
    const ac = new AbortController();
    let b: Lease | null = null;
    const d: WatcherDeps = {
      ...deps(),
      estimate: async (l) => {
        events.push(`estimate ${l.id === a.id ? 'a' : 'b'}`);
        // a long estimate: a start queues meanwhile, and its file event fires while the loop is not asleep
        if (!b) {
          b = await store.create(
            input({ project: 'demo-w2', root: '/w/b' }),
            'pending'
          );
          wake?.();
        }
        return {
          estimate_mib: l.estimate_mib,
          need_mib: l.need_mib,
          reserve_mib: l.reserve_mib,
          sources: l.sources,
        };
      },
      watch: (cb) => {
        wake = cb;
        return () => undefined;
      },
      sleep: async (ms) => {
        events.push(`sleep ${ms}`);
        now += ms;
        ac.abort();
      },
    };
    expect(await watchLeases(d, { tickMs: 2000, signal: ac.signal })).toBe(
      'aborted'
    );
    // the head is judged again at once (the queue changed during the first judgement), and only then does it sleep
    expect(events).toEqual(['estimate a', 'estimate a', 'sleep 2000']);
  });

  it("wakes on a change of the queue only, through the CLI's fs.watch wiring: its own patch of waiting_for does not wake it, a new pending lease does", async () => {
    const real = new LeaseStore(dir);
    await real.withLock(() => real.create(input(), 'pending'));
    let reads = 0;
    let estimates = 0;
    const base = deps();
    const d: WatcherDeps = {
      ...base,
      store: real,
      // the reading moves 1 MiB per read: waiting_for changes, and is written, on every judgement
      memory: async () => ({ total_mib: 8000, available_mib: 1500 - ++reads }),
      estimate: async (l) => {
        estimates++;
        return base.estimate(l);
      },
      sleep: abortableSleep,
      now: () => Date.now(),
      watch: leaseDirWatch(real.dir),
    };
    const ac = new AbortController();
    const run = watchLeases(d, { tickMs: 2000, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 600));
    expect([reads, estimates]).toEqual([1, 1]);
    await real.withLock(() =>
      real.create(input({ project: 'demo-w2', root: '/w/b' }), 'pending')
    );
    await new Promise((r) => setTimeout(r, 400));
    // the wake judges the head in full: its estimate is taken again, well within its 30 s
    expect([reads, estimates]).toEqual([2, 2]);
    ac.abort();
    expect(await run).toBe('aborted');
  });
});

describe('defaultWatcherDeps', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-watchdeps-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runStart runs the start as a child under the lease, and fails a lease the child left starting with its exit code', async () => {
    const entry = path.join(dir, 'cli.js');
    const argvFile = path.join(dir, 'argv.json');
    fs.writeFileSync(
      entry,
      `require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ argv: process.argv.slice(2), state: process.env.MCPROC_STATE_DIR })); process.exit(3);`
    );
    const deps = defaultWatcherDeps(dir, entry);
    const l = await deps.store.withLock(() =>
      deps.store.create(input({ reload: true, root: vars }), 'pending')
    );
    const admitted = await deps.store.withLock(() =>
      deps.store.transition(l.id, 'starting')
    );
    await deps.runStart(admitted);
    expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toEqual({
      argv: ['--project', vars, 'start', 'dev', '--reload', '--lease', l.id],
      state: dir,
    });
    expect(deps.store.get(l.id)).toMatchObject({
      state: 'failed',
      error: 'child exited 3',
      exit_code: 3,
      child_pid: null,
    });
  });

  it('runStart leaves a lease the child answered alone', async () => {
    const entry = path.join(dir, 'cli.js');
    // the child's own answer, running, written to the lease file as the store writes it
    fs.writeFileSync(
      entry,
      `const fs = require('node:fs'); const path = require('node:path'); const d = path.join(process.env.MCPROC_STATE_DIR, 'leases'); const id = process.argv[process.argv.length - 1]; const f = path.join(d, fs.readdirSync(d).find((n) => n.endsWith('-' + id + '.json'))); const l = JSON.parse(fs.readFileSync(f, 'utf8')); fs.writeFileSync(f, JSON.stringify({ ...l, state: 'running', child_pid: null }));`
    );
    const deps = defaultWatcherDeps(dir, entry);
    const l = await deps.store.withLock(() =>
      deps.store.create(input({ root: vars }), 'pending')
    );
    const admitted = await deps.store.withLock(() =>
      deps.store.transition(l.id, 'starting')
    );
    await deps.runStart(admitted);
    expect(deps.store.get(l.id)).toMatchObject({
      state: 'running',
      error: null,
    });
  });

  it('runStart drops a lease whose checkout is gone instead of starting it', async () => {
    const entry = path.join(dir, 'cli.js');
    const ran = path.join(dir, 'ran');
    fs.writeFileSync(
      entry,
      `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '1');`
    );
    const deps = defaultWatcherDeps(dir, entry);
    const l = await deps.store.withLock(() =>
      deps.store.create(input({ root: path.join(dir, 'gone') }), 'pending')
    );
    const admitted = await deps.store.withLock(() =>
      deps.store.transition(l.id, 'starting')
    );
    await deps.runStart(admitted);
    expect(fs.existsSync(ran)).toBe(false);
    expect(deps.store.get(l.id)).toMatchObject({
      state: 'cancelled',
      error: 'checkout gone',
    });
  });

  it('a queued exec keeps its own estimate: not admitted with 500M over the reserve, admitted with 1200M', async () => {
    const deps = defaultWatcherDeps(dir, '/nowhere/cli.js');
    let available = 1024 + 500; // the vars manifest keeps a 1G reserve
    deps.memory = async () => ({ total_mib: 8000, available_mib: available });
    deps.sleep = async () => undefined;
    deps.log = () => undefined;
    const l = await deps.store.withLock(() =>
      deps.store.create(
        input({
          kind: 'exec',
          apps: [],
          target: 'bun test',
          root: vars,
          estimate_mib: 1000,
          need_mib: 1200,
          margin: 0.2,
          reserve_mib: 1024,
          sources: {},
        }),
        'pending'
      )
    );
    await watchLeases(deps, { tickMs: 1, once: true });
    expect(deps.store.get(l.id)).toMatchObject({
      state: 'pending',
      estimate_mib: 1000,
      need_mib: 1200,
    });
    expect(deps.store.get(l.id)?.waiting_for).toMatch(/needs 1\.2G/);
    available = 1024 + 1200;
    await watchLeases(deps, { tickMs: 1, once: true });
    expect(deps.store.get(l.id)).toMatchObject({
      state: 'starting',
      estimate_mib: 1000,
      need_mib: 1200,
      reserve_mib: 1024,
      sources: {},
    });
  });

  it("estimate of an exec takes the reserve from its manifest and the current reading, else the lease's own", async () => {
    const deps = defaultWatcherDeps(dir, '/nowhere/cli.js');
    deps.memory = async () => ({ total_mib: 8000, available_mib: 4000 });
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(path.join(proj, '.mcproc'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.mcproc', 'mcproc.yaml'),
      'version: 1\nproject: p\nresources: { reserve: 10% }\napps:\n  a: { description: a, run: echo a }\n'
    );
    const exec = (root: string) =>
      ({
        ...input({ kind: 'exec', apps: [], root, estimate_mib: 1000 }),
        need_mib: 1100,
        reserve_mib: 777,
      }) as Lease;
    expect(await deps.estimate(exec(proj))).toEqual({
      estimate_mib: 1000,
      need_mib: 1100,
      reserve_mib: 800,
      sources: {},
    });
    expect(await deps.estimate(exec(path.join(dir, 'gone')))).toEqual({
      estimate_mib: 1000,
      need_mib: 1100,
      reserve_mib: 777,
      sources: {},
    });
  });

  it('settleMs reads the manifest of the lease, and the default where there is none', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const deps = defaultWatcherDeps(dir, '/nowhere/cli.js');
    const vars = path.join(here, '..', 'fixtures', 'projects', 'vars');
    expect(deps.settleMs({ root: vars } as Lease)).toBe(5000);
    expect(deps.settleMs({ root: path.join(dir, 'gone') } as Lease)).toBe(
      20_000
    );
  });
});

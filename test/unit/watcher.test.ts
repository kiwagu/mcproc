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
  type WatcherDeps,
} from '../../src/core/leases/watcher.js';

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

  it('fails a starting lease whose child died without an answer, after the stuck time', async () => {
    const a = await store.create(input(), 'pending');
    await store.transition(a.id, 'starting', { child_pid: 999999 });
    now += 11 * 60 * 1000;
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
      deps.store.create(input({ reload: true }), 'pending')
    );
    const admitted = await deps.store.withLock(() =>
      deps.store.transition(l.id, 'starting')
    );
    await deps.runStart(admitted);
    expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toEqual({
      argv: ['--project', '/w/a', 'start', 'dev', '--reload', '--lease', l.id],
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
      deps.store.create(input(), 'pending')
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

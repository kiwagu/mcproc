import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepare,
  connect,
  clearResolutionCache,
  type Context,
} from '../../src/core/resolve.js';
import { actOn, Fleet } from '../../src/core/fleet.js';
import { listApps } from '../../src/core/list.js';
import { loadManifest } from '../../src/core/manifest.js';
import type { HostMemory } from '../../src/core/memory.js';
import { writeOverride } from '../../src/core/override.js';
import { findProcess } from '../../src/core/pm2.js';
import {
  emptyRegistry,
  registryPath,
  withMain,
  writeRegistry,
} from '../../src/core/slots.js';
import { waitFor } from '../../src/core/wait.js';
import { defaultGateDeps, type GateDeps } from '../../src/core/leases/gate.js';
import {
  ensureWatcher,
  WATCHER_NAME,
  WATCHER_NS,
} from '../../src/core/leases/ensure.js';
import { LeaseStore, type Lease } from '../../src/core/leases/store.js';
import { leasesView } from '../../src/core/leases/view.js';
import {
  defaultWatcherDeps,
  watchLeases,
  type WatcherDeps,
} from '../../src/core/leases/watcher.js';

// the server holds 64 MiB of its own, so a running one measures at least its 64M declaration and a sibling's
// estimate comes from that measurement
const SERVER = `const hold = Buffer.alloc(64 * 1024 * 1024, 1); require('http').createServer((q, s) => s.end('ok ' + hold.length)).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until `ok` holds, for up to `ms`; false when it never did. */
async function eventually(ok: () => boolean, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(100))
    if (ok()) return true;
  return ok();
}
const PORT_A = 38321; // slot 0; slot 1 is 100 above
const PORT_B = 38421;

/** One checkout of the same manifest text: slot 0 by default, another slot through its override. */
function checkout(dir: string, home: string) {
  fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), SERVER);
  fs.writeFileSync(
    path.join(dir, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      'project: itl',
      `vars: { slot: 0, port: '{{ ${PORT_A} + slot * 100 }}' }`,
      'resources: { reserve: 1M, margin: 0%, settle: 0 }',
      'apps:',
      '  web:',
      '    description: http server',
      '    run: node server.js',
      "    env: { PORT: '{{ port }}' }",
      "    port: '{{ port }}'",
      '    url: http://127.0.0.1:{{ port }}/',
      '    memory: 64M',
      'hosts:',
      '  local:',
      `    pm2_home: ${home}`,
      '',
    ].join('\n')
  );
}

let base: string;
let state: string;
let a: string;
let b: string;
let ctxA: Context;
let ctxB: Context;
let prevState: string | undefined;
let prevEntry: string | undefined;
let watcherLaunched = false;
/** the in-process watcher of the queue case, ended before the daemon goes */
let watching: Promise<'idle' | 'aborted'> | null = null;
const stopWatching = new AbortController();
/** each project a gate asked the watcher for */
const ensured: string[] = [];
const fleetOf = (root: string) => new Fleet(loadManifest(root), undefined);
const store = () => new LeaseStore(state);
/** the real gate on this file's state directory, with a fake memory reading and a watcher that is only counted */
const gateOf = (
  memory: () => HostMemory,
  over: Partial<GateDeps> = {}
): GateDeps => ({
  ...defaultGateDeps(state),
  memory: async () => memory(),
  ensureWatcher: async (ctx) => {
    ensured.push(ctx.manifest.project);
    return 'online';
  },
  ...over,
});
const leaseOf = (project: string, after = 0): Lease => {
  const l = store()
    .list()
    .filter((x) => x.project === project && x.seq > after)
    .at(-1);
  if (!l) throw new Error(`no lease of ${project} after #${after}`);
  return l;
};

beforeAll(async () => {
  prevState = process.env.MCPROC_STATE_DIR;
  prevEntry = process.env.MCPROC_CLI_ENTRY;
  base = fs.mkdtempSync('/tmp/mcproc-lt-'); // short on purpose: unix socket paths are capped at 108 bytes
  state = path.join(base, 'state');
  process.env.MCPROC_STATE_DIR = state;
  const home = path.join(base, 'home');
  a = path.join(base, 'a');
  b = path.join(base, 'b');
  checkout(a, home);
  checkout(b, home);
  writeOverride(b, { project: 'itl-w1', repo: a, vars: { slot: 1 } });
  // slot 0 and 1 of the repository, as worktree add would have registered them
  const reg = withMain(emptyRegistry(a), {
    path: a,
    branch: 'main',
    project: 'itl',
  });
  writeRegistry(registryPath(state, 'itl', a), {
    ...reg,
    slots: {
      ...reg.slots,
      '1': { path: b, branch: 'w1', project: 'itl-w1' },
    },
  });
  clearResolutionCache();
  ctxA = await connect(prepare({ project: a }));
  ctxB = await connect(prepare({ project: b }));
});
afterAll(async () => {
  stopWatching.abort();
  await watching?.catch(() => undefined);
  if (watcherLaunched)
    try {
      await ctxA.pm2.run(['delete', WATCHER_NAME]);
    } catch {
      /* gone already */
    }
  try {
    await ctxA.pm2.run(['kill']);
  } catch {
    /* daemon already gone */
  }
  if (prevState === undefined) delete process.env.MCPROC_STATE_DIR;
  else process.env.MCPROC_STATE_DIR = prevState;
  if (prevEntry === undefined) delete process.env.MCPROC_CLI_ENTRY;
  else process.env.MCPROC_CLI_ENTRY = prevEntry;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('memory leases against real pm2', () => {
  it('two checkouts side by side: their own pm2 names and ports, a running lease each, the second measured from the first', async () => {
    const gate = gateOf(() => ({ total_mib: 100000, available_mib: 100000 }));
    expect(loadManifest(b)).toMatchObject({
      project: 'itl-w1',
      base_project: 'itl',
      repo: a,
      slot: 1,
    });
    await actOn(fleetOf(a), 'web', 'start', { gate });
    expect(
      await waitFor(ctxA, 'web', { kind: 'listening' }, { timeoutMs: 15_000 })
    ).toMatchObject({ ok: true });
    await actOn(fleetOf(b), 'web', 'start', { gate });
    expect(
      await waitFor(ctxB, 'web', { kind: 'listening' }, { timeoutMs: 15_000 })
    ).toMatchObject({ ok: true });
    for (const [ctx, port] of [
      [ctxA, PORT_A],
      [ctxB, PORT_B],
    ] as const) {
      const rows = await listApps(ctx);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ app: 'web', status: 'online' });
      expect(rows[0].ports.checks).toEqual([{ port, status: 'listening' }]);
    }
    const procs = await ctxA.pm2.jlist();
    expect(findProcess(procs, 'itl', 'web')).toMatchObject({
      name: 'itl-web',
      namespace: 'itl',
      status: 'online',
    });
    expect(findProcess(procs, 'itl-w1', 'web')).toMatchObject({
      name: 'itl-w1-web',
      namespace: 'itl-w1',
      status: 'online',
    });
    const leases = store().list();
    expect(leases.map((l) => [l.project, l.slot, l.state])).toEqual([
      ['itl', 0, 'running'],
      ['itl-w1', 1, 'running'],
    ]);
    expect(leases[0].sources.web).toEqual({ mib: 64, source: 'declared' });
    // the real probe measured the running node of slot 0: its resident set, at least the 64 MiB it holds
    expect(leases[1].sources.web.source).toBe('measured from slot 0');
    expect(leases[1].sources.web.mib).toBeGreaterThanOrEqual(64);
    expect(leases[1].estimate_mib).toBe(leases[1].sources.web.mib);
    expect(ensured).toEqual([]);
  }, 60_000);

  it('queue, watcher, release: B waits for memory, the watcher starts it once A is stopped', async () => {
    // both stands down: their leases are freed. B's process is deleted, so its start is a request for an app with no
    // process yet, which is what wait rides through
    await actOn(fleetOf(a), 'web', 'stop');
    await actOn(fleetOf(b), 'web', 'delete');
    expect(
      store()
        .list()
        .map((l) => l.state)
    ).toEqual(['freed', 'freed']);
    const last = store().list().at(-1)!.seq;

    // reserve 1M, need 64M: 99M over the reserve fits one
    let available = 100;
    const memory = () => ({ total_mib: 1000, available_mib: available });
    const gate = gateOf(memory, { siblings: async () => new Map() });
    const rowsA = await actOn(fleetOf(a), 'web', 'start', { gate });
    expect(rowsA[0].status).not.toMatch(/queued/);
    const leaseA = leaseOf('itl', last);
    expect(leaseA).toMatchObject({ state: 'running', need_mib: 64 });
    expect(leaseA.sources.web.source).toBe('declared');
    // A now holds what it was admitted with
    available = 30;
    const rowsB = await actOn(fleetOf(b), 'web', 'start', { gate });
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].status).toBe('queued #1');
    expect(rowsB[0].lease?.position).toBe(1);
    expect(ensured).toEqual(['itl-w1']);
    const leaseB = leaseOf('itl-w1', last);
    expect(leaseB).toMatchObject({ state: 'pending', need_mib: 64 });
    expect(leaseB.waiting_for).toMatch(/needs 64M/);
    expect((await listApps(ctxB))[0].status).toBe('queued #1');
    expect(
      await waitFor(ctxB, 'web', { kind: 'listening' }, { timeoutMs: 2000 })
    ).toMatchObject({ ok: false, reason: 'timeout', status: 'queued #1' });

    // the watcher in this process: the fake reading, the declared estimate, the admitted start run in-process
    const logged: string[] = [];
    const deps: WatcherDeps = {
      ...defaultWatcherDeps(state, process.env.MCPROC_CLI ?? 'cli.js'),
      memory: async () => memory(),
      estimate: async (l) => ({
        estimate_mib: l.estimate_mib,
        need_mib: l.need_mib,
        reserve_mib: l.reserve_mib,
        sources: l.sources,
      }),
      runStart: async (l) => {
        await actOn(
          new Fleet(loadManifest(l.root), undefined),
          l.target,
          'start',
          {
            lease: l.id,
            gate: gateOf(memory),
          }
        );
      },
      log: (line) => logged.push(line),
    };
    watching = watchLeases(deps, {
      tickMs: 200,
      idleExitMs: 500,
      signal: stopWatching.signal,
    });
    await sleep(800); // a few ticks: B still does not fit
    expect(store().get(leaseB.id)?.state).toBe('pending');
    await actOn(fleetOf(a), 'web', 'stop');
    expect(store().get(leaseA.id)?.state).toBe('freed');
    available = 100;
    expect(
      await waitFor(ctxB, 'web', { kind: 'listening' }, { timeoutMs: 20_000 })
    ).toMatchObject({ ok: true });
    // the port answers before the admitted start has ended: the lease is running once it has
    expect(
      await eventually(
        () => store().get(leaseB.id)?.state === 'running',
        10_000
      )
    ).toBe(true);
    expect(store().get(leaseA.id)?.state).toBe('freed');
    expect(logged.some((l) => l.startsWith(`admit ${leaseB.id}`))).toBe(true);
    const view = await leasesView(state, ctxA);
    expect(view.state_dir).toBe(state);
    expect(view.watcher).toEqual({ online: false, pid: null });
    expect(view.memory?.total_mib).toBeGreaterThan(0);
    expect(
      view.leases
        .filter((l) => l.seq > last)
        .map((l) => [l.id, l.state, l.position])
    ).toEqual([
      [leaseA.id, 'freed', 0],
      [leaseB.id, 'running', 0],
    ]);
    await actOn(fleetOf(b), 'web', 'delete');
    expect(store().get(leaseB.id)?.state).toBe('freed');
    expect(await watching).toBe('idle');
    watching = null;
    expect(ensured).toEqual(['itl-w1']);
  }, 60_000);

  // the watcher under pm2 runs a built cli.js: the side build that MCPROC_CLI names
  (process.env.MCPROC_CLI ? it : it.skip)(
    'ensureWatcher under pm2 starts mcproc-watcher once, then finds it online (needs MCPROC_CLI naming a side build)',
    async () => {
      process.env.MCPROC_CLI_ENTRY = process.env.MCPROC_CLI;
      watcherLaunched = true;
      expect(await ensureWatcher(ctxA, state)).toBe('started');
      const w = (await ctxA.pm2.jlist()).find((p) => p.name === WATCHER_NAME);
      expect(w).toMatchObject({ namespace: WATCHER_NS, status: 'online' });
      expect(await ensureWatcher(ctxA, state)).toBe('online');
      expect((await leasesView(state, ctxA)).watcher).toEqual({
        online: true,
        pid: w!.pid,
      });
    },
    60_000
  );
});

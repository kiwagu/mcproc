import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fakeCtx } from '../helpers/ctx.js';
import {
  LeaseStore,
  pidAlive,
  type NewLease,
} from '../../src/core/leases/store.js';
import {
  cancelBefore,
  finishLeasedStart,
  freeAfter,
  freeOnFailure,
  gateStart,
  type GateDeps,
} from '../../src/core/leases/gate.js';
import { cancelLease, leasesView } from '../../src/core/leases/view.js';
import { unreachableRow } from '../../src/core/list.js';
import { parseJlist } from '../../src/core/pm2.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const varsProj = path.join(here, '..', 'fixtures', 'projects', 'vars');
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
/** One pm2 process as the gate gets it: a jlist entry, normalised as Pm2Client.jlist does. */
const proc = (name: string, ns: string, status = 'online') =>
  parseJlist(
    JSON.stringify([
      {
        pid: 100,
        name,
        pm_id: 0,
        pm2_env: { status, namespace: ns, pm_cwd: varsProj },
      },
    ])
  )[0];

describe('gateStart', () => {
  let dir: string;
  let store: LeaseStore;
  let ensured = 0;
  const deps = (
    memory: { total_mib: number; available_mib: number } | null,
    measured = new Map()
  ): GateDeps => ({
    store,
    memory: async () => memory,
    siblings: async () => measured,
    ensureWatcher: async () => {
      ensured++;
    },
    pid: 7,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-gate-'));
    store = new LeaseStore(dir);
    ensured = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('proceeds without a lease when no app of the start declares memory', async () => {
    const ctx = fakeCtx(basic, 'local', []);
    const r = await gateStart(
      ctx,
      ['api'],
      { target: 'api', procs: [] },
      deps({ total_mib: 100, available_mib: 1 })
    );
    expect(r).toEqual({ kind: 'proceed', lease: null });
    expect(store.list()).toEqual([]);
  });

  it('admits at once when the queue is empty and memory fits: a running lease', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const r = await gateStart(
      ctx,
      ['db', 'api'],
      { target: 'dev', note: 'dev up', procs: [] },
      deps({ total_mib: 8000, available_mib: 4000 })
    );
    expect(r.kind).toBe('proceed');
    const l = (
      r as { lease: NonNullable<typeof r & { lease: unknown }>['lease'] }
    ).lease!;
    expect(l).toMatchObject({
      state: 'running',
      kind: 'start',
      project: 'demo-w2',
      root: varsProj,
      slot: 2,
      repo: '/w/demo',
      target: 'dev',
      apps: ['db', 'api'],
      estimate_mib: 768,
      need_mib: 922,
      margin: 0.2,
      reserve_mib: 1024,
      sources: {
        db: { mib: 512, source: 'declared' },
        api: { mib: 256, source: 'declared' },
      },
      note: 'dev up',
      requester_pid: 7,
    });
    expect(ensured).toBe(0);
  });

  it('counts online apps as zero and uses the measured sibling value', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const r = await gateStart(
      ctx,
      ['db', 'api'],
      { target: 'dev', procs: [proc('demo-w2-db', 'demo-w2')] as never },
      deps(
        { total_mib: 8000, available_mib: 4000 },
        new Map([['api', { mib: 300, slot: 0 }]])
      )
    );
    expect(r.kind).toBe('proceed');
    expect(store.list()[0]).toMatchObject({
      apps: ['api'],
      estimate_mib: 300,
      sources: { api: { mib: 300, source: 'measured from slot 0' } },
    });
  });

  it('queues when memory does not fit, starts the watcher, and reports the same lease on a repeat', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const r = await gateStart(
      ctx,
      ['db', 'api'],
      { target: 'dev', procs: [] },
      deps({ total_mib: 8000, available_mib: 1500 })
    );
    expect(r.kind).toBe('queued');
    if (r.kind !== 'queued') return;
    expect(r.position).toBe(1);
    expect(r.waiting_for).toBe(
      'needs 922M, host has 476M over the reserve (446M short)'
    );
    expect(r.lease.state).toBe('pending');
    expect(store.get(r.lease.id)?.waiting_for).toBe(r.waiting_for);
    expect(ensured).toBe(1);
    const again = await gateStart(
      ctx,
      ['db', 'api'],
      { target: 'dev', procs: [] },
      deps({ total_mib: 8000, available_mib: 1500 })
    );
    expect(again.kind).toBe('queued');
    expect((again as { lease: { id: string } }).lease.id).toBe(r.lease.id);
    expect(store.list()).toHaveLength(1);
  });

  it('queues behind a pending lease even when memory would do, in FIFO order', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    await store.create(
      {
        kind: 'start',
        project: 'other',
        root: '/o',
        slot: null,
        repo: '/o',
        target: 'x',
        apps: ['x'],
        reload: false,
        estimate_mib: 1,
        need_mib: 1,
        margin: 0,
        reserve_mib: 0,
        sources: {},
        note: null,
        requester_pid: 1,
      },
      'pending'
    );
    const r = await gateStart(
      ctx,
      ['db'],
      { target: 'db', procs: [] },
      deps({ total_mib: 8000, available_mib: 7000 })
    );
    expect(r).toMatchObject({
      kind: 'queued',
      position: 2,
      waiting_for: '1 ahead in the queue',
    });
  });

  it('refuses what can never fit, and a budgeted app on a remote host', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    await expect(
      gateStart(
        ctx,
        ['db'],
        { target: 'db', procs: [] },
        deps({ total_mib: 1200, available_mib: 1100 })
      )
    ).rejects.toMatchObject({ code: 'NEVER_FITS' });
    const remote = fakeCtx(
      path.join(here, '..', 'fixtures', 'projects', 'fleet'),
      'box',
      []
    );
    (
      remote.manifest.apps[Object.keys(remote.manifest.apps)[0]] as {
        memory_mib: number | null;
      }
    ).memory_mib = 100;
    await expect(
      gateStart(
        remote,
        [Object.keys(remote.manifest.apps)[0]],
        { target: Object.keys(remote.manifest.apps)[0], procs: [] },
        deps(null)
      )
    ).rejects.toMatchObject({ code: 'LEASE_UNSUPPORTED_HOST' });
  });

  it('charges the running leases younger than the settle time: two starts seconds apart are not both admitted on one reading', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const other: NewLease = {
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
      sources: {},
      note: null,
      requester_pid: 1,
    };
    // settled: running for longer than the manifest's settle (5 s), the reading shows it already
    await new LeaseStore(dir, { now: () => Date.now() - 6000 }).create(
      other,
      'running'
    );
    const fits = await gateStart(
      ctx,
      ['db'],
      { target: 'db', procs: [] },
      deps({ total_mib: 8000, available_mib: 2500 })
    );
    expect(fits.kind).toBe('proceed');
    // the one just admitted (db, 615M) still ramps: charged on top of the reading
    const r = await gateStart(
      ctx,
      ['api'],
      { target: 'api', procs: [] },
      deps({ total_mib: 8000, available_mib: 1700 })
    );
    expect(r).toMatchObject({
      kind: 'queued',
      waiting_for:
        'needs 308M, host has 61M over the reserve (247M short, 615M ramping)',
    });
    if (r.kind === 'queued')
      expect(store.get(r.lease.id)?.waiting_for).toBe(r.waiting_for);
  });

  it('admits in FIFO order without a memory reading', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const r = await gateStart(
      ctx,
      ['db'],
      { target: 'db', procs: [] },
      deps(null)
    );
    expect(r.kind).toBe('proceed');
  });
});

describe('finishing and releasing', () => {
  let dir: string;
  let store: LeaseStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-gate-'));
    store = new LeaseStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fresh = () =>
    store.create(
      {
        kind: 'start',
        project: 'demo-w2',
        root: varsProj,
        slot: 2,
        repo: '/w/demo',
        target: 'dev',
        apps: ['db', 'api'],
        reload: false,
        estimate_mib: 768,
        need_mib: 922,
        margin: 0.2,
        reserve_mib: 1024,
        sources: {},
        note: null,
        requester_pid: 1,
      },
      'pending'
    );

  it('finishLeasedStart: running when any app started, failed when none did, the errors kept', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const a = await fresh();
    await store.transition(a.id, 'starting');
    const ok = await finishLeasedStart(store, a.id, [
      {
        ...unreachableRow(ctx.manifest.apps.db, 'local', '', 'online'),
        error: undefined,
      },
      unreachableRow(
        ctx.manifest.apps.api,
        'local',
        'skipped: db was not started',
        'skipped'
      ),
    ]);
    expect(ok.state).toBe('running');
    expect(ok.error).toBe('api: skipped: db was not started');
    const b = await fresh();
    await store.transition(b.id, 'starting');
    const bad = await finishLeasedStart(store, b.id, [
      unreachableRow(ctx.manifest.apps.db, 'local', 'boom', 'failed'),
    ]);
    expect(bad.state).toBe('failed');
    expect(bad.error).toBe('db: boom');
  });

  it('freeOnFailure frees a running lease with the error', async () => {
    const a = await store.create(
      {
        kind: 'start',
        project: 'p',
        root: '/r',
        slot: null,
        repo: '/r',
        target: 't',
        apps: ['a'],
        reload: false,
        estimate_mib: 1,
        need_mib: 1,
        margin: 0,
        reserve_mib: 0,
        sources: {},
        note: null,
        requester_pid: 1,
      },
      'running'
    );
    await freeOnFailure(store, a, new Error('pm2 down'));
    expect(store.get(a.id)).toMatchObject({
      state: 'freed',
      error: 'pm2 down',
    });
  });

  const lease = (over: Partial<NewLease>): NewLease => ({
    kind: 'start',
    project: 'demo-w2',
    root: varsProj,
    slot: 2,
    repo: '/w/demo',
    target: 'dev',
    apps: ['db', 'api'],
    reload: false,
    estimate_mib: 1,
    need_mib: 1,
    margin: 0,
    reserve_mib: 0,
    sources: {},
    note: null,
    requester_pid: 1,
    ...over,
  });

  it('cancelBefore cancels the pending and starting leases of this checkout that overlap the stopped apps, and nothing else', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const running = await store.create(lease({}), 'running');
    const pending = await fresh();
    const starting = await store.create(
      lease({ target: 'api', apps: ['api'] }),
      'pending'
    );
    await store.transition(starting.id, 'starting');
    const other = await store.create(
      lease({ target: 'tool', apps: ['tool'] }),
      'pending'
    );
    const elsewhere = await store.create(
      lease({ project: 'x', root: '/x', repo: '/x', target: 'api' }),
      'pending'
    );
    expect(await cancelBefore(store, ctx, ['api'])).toEqual([
      pending.id,
      starting.id,
    ]);
    expect(store.get(pending.id)).toMatchObject({
      state: 'cancelled',
      error: 'stop of api',
    });
    expect(store.get(starting.id)?.state).toBe('cancelled');
    expect(store.get(running.id)?.state).toBe('running');
    expect(store.get(other.id)?.state).toBe('pending');
    expect(store.get(elsewhere.id)?.state).toBe('pending');
  });

  it("cancelBefore ends a starting lease's child with SIGTERM and waits for it to exit", async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on('exit', (_code, signal) => resolve(signal))
    );
    try {
      const l = await fresh();
      await store.transition(l.id, 'starting', { child_pid: child.pid });
      expect(pidAlive(child.pid!)).toBe(true);
      expect(await cancelBefore(store, ctx, ['db'])).toEqual([l.id]);
      // the wait is over only once the child is gone
      expect(pidAlive(child.pid!)).toBe(false);
      expect(await exited).toBe('SIGTERM');
      expect(store.get(l.id)).toMatchObject({
        state: 'cancelled',
        error: 'stop of db',
      });
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('cancelBefore leaves the store alone when nothing of this checkout is live', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    expect(await cancelBefore(store, ctx, ['db'])).toEqual([]);
    expect(fs.existsSync(store.dir)).toBe(false);
  });

  it('freeAfter frees a running lease of this checkout once none of its apps is online', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const running = await store.create(lease({}), 'running');
    const pending = await fresh();
    const elsewhere = await store.create(
      lease({ project: 'x', root: '/x', repo: '/x', apps: ['db'] }),
      'running'
    );
    // db still online after the stop of api: the running lease stays
    expect(
      await freeAfter(store, ctx, [proc('demo-w2-db', 'demo-w2')] as never)
    ).toEqual([]);
    expect(
      await freeAfter(store, ctx, [
        proc('demo-w2-db', 'demo-w2', 'stopped'),
      ] as never)
    ).toEqual([running.id]);
    expect(store.get(running.id)?.state).toBe('freed');
    expect(store.get(pending.id)?.state).toBe('pending');
    expect(store.get(elsewhere.id)?.state).toBe('running');
  });
});

describe('leasesView and cancelLease', () => {
  let dir: string;
  let store: LeaseStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-gate-'));
    store = new LeaseStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (state: 'pending' | 'running') =>
    store.create(
      {
        kind: 'start',
        project: 'demo-w2',
        root: varsProj,
        slot: 2,
        repo: '/w/demo',
        target: 'dev',
        apps: ['db'],
        reload: false,
        estimate_mib: 512,
        need_mib: 615,
        margin: 0.2,
        reserve_mib: 1024,
        sources: {},
        note: null,
        requester_pid: 1,
      },
      state
    );

  it('lists every lease with its position; without a context there is no memory or watcher', async () => {
    const r = await make('running');
    const a = await make('pending');
    const b = await make('pending');
    const v = await leasesView(dir);
    expect(v).toMatchObject({ state_dir: dir, memory: null, watcher: null });
    expect(v.leases.map((l) => [l.id, l.position])).toEqual([
      [r.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]);
  });

  it('reads the memory and the watcher on a local context', async () => {
    const ctx = fakeCtx(varsProj, 'local', [
      {
        match: '__MCPROC_MEM__',
        result: {
          stdout:
            '__MCPROC_MEM__\nMemTotal: 8192000 kB\nMemAvailable: 4096000 kB\n',
        },
      },
      {
        match: /pm2 'jlist'/,
        result: {
          stdout: JSON.stringify([
            {
              pid: 77,
              name: 'mcproc-watcher',
              pm_id: 9,
              pm2_env: { status: 'online', namespace: 'mcproc' },
            },
          ]),
        },
      },
    ]);
    const v = await leasesView(dir, ctx);
    expect(v.memory).toEqual({ total_mib: 8000, available_mib: 4000 });
    expect(v.watcher).toEqual({ online: true, pid: 77 });
  });

  it('cancels a pending lease and refuses a starting or running one', async () => {
    const a = await make('pending');
    expect(await cancelLease(a.id, dir)).toMatchObject({
      state: 'cancelled',
      error: 'cancelled by request',
    });
    const b = await make('pending');
    await store.transition(b.id, 'starting');
    await expect(cancelLease(b.id, dir)).rejects.toMatchObject({
      code: 'LEASE_NOT_PENDING',
    });
    expect(store.get(b.id)?.state).toBe('starting');
    const c = await make('running');
    await expect(cancelLease(c.id, dir)).rejects.toMatchObject({
      code: 'LEASE_NOT_PENDING',
    });
    await expect(cancelLease('l_nope', dir)).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    });
  });
});

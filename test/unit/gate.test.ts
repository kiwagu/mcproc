import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import {
  finishLeasedStart,
  freeOnFailure,
  gateStart,
  releaseAfter,
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

  it('releaseAfter frees a running lease with no online app, cancels pending and starting ones that overlap', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const running = await store.create(
      {
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
      },
      'running'
    );
    const pending = await fresh();
    const other = await store.create(
      {
        kind: 'start',
        project: 'demo-w2',
        root: varsProj,
        slot: 2,
        repo: '/w/demo',
        target: 'tool',
        apps: ['tool'],
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
    const elsewhere = await store.create(
      {
        kind: 'start',
        project: 'x',
        root: '/x',
        slot: null,
        repo: '/x',
        target: 'db',
        apps: ['db'],
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
    // db still online after the stop of api: the running lease stays
    let r = await releaseAfter(store, ctx, ['api'], [
      proc('demo-w2-db', 'demo-w2'),
    ] as never);
    expect(r).toEqual({ freed: [], cancelled: [pending.id] });
    r = await releaseAfter(store, ctx, ['db'], [
      proc('demo-w2-db', 'demo-w2', 'stopped'),
    ] as never);
    expect(r).toEqual({ freed: [running.id], cancelled: [] });
    expect(store.get(other.id)?.state).toBe('pending');
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

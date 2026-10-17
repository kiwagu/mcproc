import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../../src/core/state.js';
import { LeaseStore, type NewLease } from '../../src/core/leases/store.js';

const input = (over: Partial<NewLease> = {}): NewLease => ({
  kind: 'start',
  project: 'demo-w1',
  root: '/w/demo-w1',
  slot: 1,
  repo: '/w/demo',
  target: 'dev',
  apps: ['db', 'api'],
  reload: false,
  estimate_mib: 768,
  need_mib: 845,
  margin: 0.1,
  reserve_mib: 2048,
  sources: {
    db: { mib: 512, source: 'declared' },
    api: { mib: 256, source: 'declared' },
  },
  note: null,
  requester_pid: 4242,
  ...over,
});

describe('stateDir', () => {
  it('prefers MCPROC_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state', () => {
    expect(stateDir({ MCPROC_STATE_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(stateDir({ XDG_STATE_HOME: '/xdg' })).toBe('/xdg/mcproc');
    expect(stateDir({})).toBe(
      path.join(os.homedir(), '.local', 'state', 'mcproc')
    );
  });
});

describe('LeaseStore', () => {
  let dir: string;
  let now = 1_700_000_000_000;
  let store: LeaseStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-lease-'));
    store = new LeaseStore(dir, { now: () => now, pid: 4242 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('creates leases with a growing sequence and lists them in order', async () => {
    const a = await store.create(input(), 'pending');
    const b = await store.create(input({ project: 'demo-w2' }), 'running');
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.id).toMatch(/^l_[a-z0-9]{10}$/);
    expect(a.state).toBe('pending');
    expect(a.queued_at).toBe(new Date(now).toISOString());
    expect(b.running_at).toBe(new Date(now).toISOString());
    expect(store.list().map((l) => l.id)).toEqual([a.id, b.id]);
    expect(store.get(a.id)).toEqual(a);
    expect(store.get('l_nope')).toBeNull();
    expect(fs.readdirSync(path.join(dir, 'leases')).sort()).toEqual([
      '.seq',
      `000001-${a.id}.json`,
      `000002-${b.id}.json`,
    ]);
  });

  it('walks the allowed transitions and refuses the others', async () => {
    const a = await store.create(input(), 'pending');
    now += 1000;
    const s = await store.transition(a.id, 'starting', { child_pid: 99 });
    expect(s.state).toBe('starting');
    expect(s.admitted_at).toBe(new Date(now).toISOString());
    expect(s.child_pid).toBe(99);
    const r = await store.transition(a.id, 'running');
    expect(r.running_at).toBe(new Date(now).toISOString());
    await expect(store.transition(a.id, 'pending')).rejects.toThrow(
      /running, cannot become pending/
    );
    const f = await store.transition(a.id, 'freed');
    expect(f.ended_at).toBe(new Date(now).toISOString());
    await expect(store.transition(a.id, 'cancelled')).rejects.toMatchObject({
      code: 'LEASE_NOT_PENDING',
    });
    const b = await store.create(input(), 'pending');
    expect((await store.transition(b.id, 'cancelled')).ended_at).not.toBeNull();
    const c = await store.create(input(), 'pending');
    await store.transition(c.id, 'starting');
    expect(
      (await store.transition(c.id, 'failed', { error: 'boom' })).error
    ).toBe('boom');
    const d = await store.create(input(), 'pending');
    const patched = await store.patch(d.id, {
      waiting_for: '1 ahead',
      state: 'running',
    } as never);
    expect(patched.state).toBe('pending'); // patch never changes the state
    expect(patched.waiting_for).toBe('1 ahead');
  });

  it('pending() is FIFO by sequence; head and positions follow', async () => {
    const a = await store.create(input(), 'pending');
    const b = await store.create(input(), 'pending');
    const c = await store.create(input(), 'running');
    expect(store.pending().map((l) => l.id)).toEqual([a.id, b.id]);
    expect(store.head()?.id).toBe(a.id);
    expect(store.positionOf(b.id)).toBe(2);
    expect(store.positionOf(c.id)).toBe(0);
    await store.transition(a.id, 'cancelled');
    expect(store.head()?.id).toBe(b.id);
    expect(store.positionOf(b.id)).toBe(1);
  });

  it('prunes ended leases older than a day and keeps live ones', async () => {
    const a = await store.create(input(), 'running');
    await store.transition(a.id, 'freed');
    const b = await store.create(input(), 'pending');
    now += 25 * 3600 * 1000;
    expect(store.prune()).toBe(1);
    expect(store.list().map((l) => l.id)).toEqual([b.id]);
  });

  it('serialises writers with the lock and breaks a stale one', async () => {
    const order: string[] = [];
    await Promise.all([
      store.withLock(async () => {
        order.push('a-in');
        await new Promise((r) => setTimeout(r, 50));
        order.push('a-out');
      }),
      store.withLock(async () => {
        order.push('b');
      }),
    ]);
    expect(order).toEqual(['a-in', 'a-out', 'b']);
    // a lock left by a dead process, older than 30 s, is broken
    fs.mkdirSync(path.join(dir, 'leases'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'leases', '.lock'),
      JSON.stringify({ pid: 999999, at: now - 60_000 })
    );
    await expect(store.withLock(() => 'ok')).resolves.toBe('ok');
  });
});

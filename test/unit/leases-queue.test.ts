import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aheadOf,
  assertGroupName,
  groupBlocked,
  groupBusy,
  groupOnly,
  groupReason,
  groupWait,
  holderNote,
  holderOf,
  memoryPosition,
  memoryQueue,
} from '../../src/core/leases/queue.js';
import {
  LeaseStore,
  type Lease,
  type NewLease,
} from '../../src/core/leases/store.js';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
let seq = 0;
/** A lease as the store lists it: an exec of one group, pending, unless `over` says otherwise. */
const mk = (over: Partial<Lease> = {}): Lease => ({
  id: `l_${String(++seq).padStart(10, '0')}`,
  seq,
  state: 'pending',
  kind: 'exec',
  project: 'demo',
  root: '/w/demo',
  slot: null,
  repo: '/w/demo',
  target: 'bun test',
  host: null,
  apps: [],
  reload: false,
  estimate_mib: 100,
  need_mib: 100,
  margin: 0,
  reserve_mib: 0,
  sources: {},
  note: null,
  requester_pid: 1234,
  child_pid: null,
  queued_at: ago(300),
  admitted_at: null,
  running_at: null,
  ended_at: null,
  waiting_for: null,
  error: null,
  exit_code: null,
  exclusive: 'suite',
  boot_id: null,
  requester_start: null,
  command_pid: null,
  command_start: null,
  ...over,
});
const running = (over: Partial<Lease> = {}) =>
  mk({
    state: 'running',
    admitted_at: ago(192),
    running_at: ago(192),
    ...over,
  });

describe('the queue rules', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('a holder blocks its group, and only its group', () => {
    const h = running();
    const w = mk();
    const x = mk({ exclusive: 'other' });
    const p = mk({ exclusive: null });
    const all = [h, w, x, p];
    expect(holderOf(all, 'suite')).toBe(h);
    expect(holderOf(all, 'other')).toBeNull();
    expect(groupBlocked(all, w)).toBe(true);
    expect(groupBlocked(all, x)).toBe(false);
    expect(groupBlocked(all, p)).toBe(false);
    expect(groupBusy(all, 'suite')).toBe(true);
    expect(groupBusy([h], 'other')).toBe(false);
  });

  it('FIFO inside a group: a younger member waits for an older pending one, with no holder', () => {
    const w1 = mk();
    const w2 = mk();
    const all = [w1, w2];
    expect(groupBlocked(all, w1)).toBe(false);
    expect(groupBlocked(all, w2)).toBe(true);
    expect(groupWait(all, w1)).toBeNull();
    expect(groupWait(all, w2)).toEqual({
      name: 'suite',
      place: 2,
      holder: null,
      before: w1,
    });
    expect(groupBusy(all, 'suite')).toBe(true);
  });

  it('the memory queue skips group-blocked and group-only leases', () => {
    const h = running();
    const w = mk();
    const g = mk({ exclusive: 'other', estimate_mib: 0, need_mib: 0 });
    const s = mk({ kind: 'start', exclusive: null, need_mib: 845 });
    const all = [h, w, g, s];
    expect(groupOnly(g)).toBe(true);
    expect(groupOnly(w)).toBe(false);
    expect(memoryQueue(all)).toEqual([s]);
    expect(aheadOf(all)).toBe(1);
    expect(memoryPosition(all, s.id)).toBe(1);
    expect(memoryPosition(all, w.id)).toBe(0);
    expect(memoryPosition(all, g.id)).toBe(0);
    expect(memoryPosition(all, h.id)).toBe(0);
  });

  it('a starting group-only lease is not ahead; a starting memory lease is', () => {
    const g = mk({
      state: 'starting',
      exclusive: 'other',
      estimate_mib: 0,
      need_mib: 0,
    });
    const m = mk({ state: 'starting', exclusive: null });
    const s = mk({ kind: 'start', exclusive: null });
    expect(aheadOf([g])).toBe(0);
    expect(aheadOf([g, m])).toBe(1);
    expect(memoryPosition([g, m, s], s.id)).toBe(2);
  });

  it('group names are exact: Suite and suite are two groups', () => {
    const h = running({ exclusive: 'Suite' });
    const w = mk({ exclusive: 'suite' });
    expect(groupBlocked([h, w], w)).toBe(false);
    expect(holderOf([h, w], 'suite')).toBeNull();
  });

  it('groupReason names the holder, or the member before; holderNote the holder itself', () => {
    const h = running({
      project: 'demo-w5',
      slot: 5,
      requester_pid: 1234,
      command_pid: 1240,
    });
    const w = mk();
    expect(groupReason(groupWait([h, w], w)!, NOW)).toBe(
      `group suite: held by ${h.id} (demo-w5 slot 5, pid 1234, 3m), #1 in group`
    );
    expect(holderNote(h, NOW)).toBe('holds suite 3m, pid 1234, command 1240');
    expect(holderNote({ ...h, command_pid: null }, NOW)).toBe(
      'holds suite 3m, pid 1234'
    );
    const w1 = mk({ project: 'demo' });
    const w2 = mk();
    expect(groupReason(groupWait([w1, w2], w2)!, NOW)).toBe(
      `group suite: behind ${w1.id} (needs memory), #2 in group`
    );
    const g1 = mk({ estimate_mib: 0, need_mib: 0 });
    const g2 = mk({ estimate_mib: 0, need_mib: 0 });
    expect(groupReason(groupWait([g1, g2], g2)!, NOW)).toBe(
      `group suite: behind ${g1.id} (taking its turn), #2 in group`
    );
  });

  it('assertGroupName takes 1-64 letters, digits, dots, dashes and underscores, and keeps ":" for later', () => {
    for (const ok of ['suite', 'e2e', 'a.b_c-d', 'x'.repeat(64)])
      expect(() => assertGroupName(ok), ok).not.toThrow();
    for (const bad of ['', '-x', 'a b', 'x'.repeat(65), 'é'])
      expect(() => assertGroupName(bad), bad).toThrowError(
        expect.objectContaining({
          code: 'BAD_ARGUMENT',
          message: `exclusive group "${bad}" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
          hint: 'Use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.',
        })
      );
    expect(() => assertGroupName('e2e:2')).toThrowError(
      expect.objectContaining({
        code: 'BAD_ARGUMENT',
        message: 'exclusive group "e2e:2": ":" is reserved',
        hint: 'One holder per group is all this version supports; name the group without ":".',
      })
    );
  });
});

describe('the store follows the queue rules', () => {
  let dir: string;
  let store: LeaseStore;
  const input = (over: Partial<NewLease> = {}): NewLease => ({
    kind: 'exec',
    project: 'demo',
    root: '/w/demo',
    slot: null,
    repo: '/w/demo',
    target: 'bun test',
    host: null,
    apps: [],
    reload: false,
    estimate_mib: 100,
    need_mib: 100,
    margin: 0,
    reserve_mib: 0,
    sources: {},
    note: null,
    requester_pid: 1234,
    exclusive: 'suite',
    ...over,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-queue-'));
    store = new LeaseStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('head and positions skip group-blocked and group-only leases', async () => {
    await store.create(input(), 'running');
    const w = await store.create(input(), 'pending');
    const g = await store.create(
      input({ exclusive: 'other', estimate_mib: 0, need_mib: 0 }),
      'pending'
    );
    const s = await store.create(
      input({ kind: 'start', exclusive: null }),
      'pending'
    );
    expect(store.head()?.id).toBe(s.id);
    expect(store.positionOf(s.id)).toBe(1);
    expect(store.positionOf(w.id)).toBe(0);
    expect(store.positionOf(g.id)).toBe(0);
  });
});

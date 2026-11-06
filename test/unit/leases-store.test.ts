import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stateDir } from '../../src/core/state.js';
import {
  keepCallerEnv,
  takeCallerEnv,
} from '../../src/core/leases/callerenv.js';
import {
  commandAlive,
  LOCK_STALE_MS,
  LeaseStore,
  pidAlive,
  requesterAlive,
  sameProcess,
  starterAlive,
  STARTER_TRUST_MS,
  type NewLease,
} from '../../src/core/leases/store.js';
import {
  bootId,
  procAvailable,
  processStart,
  type ProcFs,
} from '../../src/core/procfs.js';

const input = (over: Partial<NewLease> = {}): NewLease => ({
  kind: 'start',
  project: 'demo-w1',
  root: '/w/demo-w1',
  slot: 1,
  repo: '/w/demo',
  target: 'dev',
  host: null,
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
  it('the unit suite keeps its own state directory under the OS temp dir (test/setup.ts), never the real one', () => {
    expect(stateDir().startsWith(os.tmpdir() + path.sep)).toBe(true);
    expect(stateDir()).not.toBe(stateDir({}));
  });
  it('prefers MCPROC_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state', () => {
    expect(stateDir({ MCPROC_STATE_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(stateDir({ XDG_STATE_HOME: '/xdg' })).toBe('/xdg/mcproc');
    expect(stateDir({})).toBe(
      path.join(os.homedir(), '.local', 'state', 'mcproc')
    );
  });
});

describe('process identity', () => {
  const dead = () => spawnSync('true').pid as number;
  it.skipIf(!procAvailable())(
    'sameProcess: the pid alive, and the start time and boot as recorded when they were',
    () => {
      const start = processStart(process.pid);
      expect(sameProcess(process.pid, null, null)).toBe(true);
      expect(sameProcess(process.pid, start, bootId())).toBe(true);
      expect(sameProcess(process.pid, (start as number) + 1, null)).toBe(false);
      expect(sameProcess(process.pid, null, 'another-boot')).toBe(false);
      expect(sameProcess(dead(), null, null)).toBe(false);
    }
  );
  it('sameProcess answers by the pid alone where /proc cannot be read now', () => {
    const thrower = (f: string): string => {
      throw new Error(`ENOENT ${f}`);
    };
    const reading = (files: Record<string, string>): ProcFs => ({
      readdir: () => [],
      read: (f) => (f in files ? files[f] : thrower(f)),
      readlink: thrower,
    });
    const stat = `${process.pid} (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0`;
    // nothing readable: a live pid is the recorded process, whatever was recorded
    expect(sameProcess(process.pid, 1, 'recorded-boot', reading({}))).toBe(
      true
    );
    // the boot reads the same, the stat does not read: the pid decides
    const bootOnly = reading({
      '/proc/sys/kernel/random/boot_id': 'recorded-boot\n',
    });
    expect(sameProcess(process.pid, 1, 'recorded-boot', bootOnly)).toBe(true);
    // the boot does not read, the stat does: the start time decides
    const statOnly = reading({ [`/proc/${process.pid}/stat`]: stat });
    expect(sameProcess(process.pid, 5000, 'recorded-boot', statOnly)).toBe(
      true
    );
    expect(sameProcess(process.pid, 5001, 'recorded-boot', statOnly)).toBe(
      false
    );
  });

  it('sameProcess takes a zombie for gone, whether or not its start was recorded', () => {
    const stat = (state: string) =>
      `${process.pid} (node) ${state} 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 5000 0`;
    const withState = (state: string): ProcFs => ({
      readdir: () => [],
      read: (f) => {
        if (f === `/proc/${process.pid}/stat`) return stat(state);
        throw new Error(`ENOENT ${f}`);
      },
      readlink: (f) => {
        throw new Error(`ENOENT ${f}`);
      },
    });
    for (const state of ['Z', 'X']) {
      expect(
        sameProcess(process.pid, 5000, null, withState(state)),
        state
      ).toBe(false);
      expect(
        sameProcess(process.pid, null, null, withState(state)),
        state
      ).toBe(false);
    }
    expect(sameProcess(process.pid, 5000, null, withState('S'))).toBe(true);
  });

  it('requesterAlive reads the requester; commandAlive is false without a command', () => {
    const l = {
      requester_pid: process.pid,
      requester_start: null,
      boot_id: null,
      command_pid: null,
      command_start: null,
    };
    expect(requesterAlive(l)).toBe(true);
    expect(commandAlive(l)).toBe(false);
    expect(commandAlive({ ...l, command_pid: process.pid })).toBe(true);
    expect(requesterAlive({ ...l, requester_pid: dead() })).toBe(false);
  });
});

describe('LeaseStore', () => {
  let dir: string;
  let now = 1_700_000_000_000;
  let store: LeaseStore;
  beforeEach(() => {
    now = 1_700_000_000_000;
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

  it('create fills the group and identity fields with null when not given', async () => {
    const a = await store.create(input(), 'pending');
    expect(a).toMatchObject({
      exclusive: null,
      boot_id: null,
      requester_start: null,
      command_pid: null,
      command_start: null,
    });
    const b = await store.create(
      input({ exclusive: 'suite', boot_id: 'b-1', requester_start: 77 }),
      'running'
    );
    expect(store.get(b.id)).toMatchObject({
      exclusive: 'suite',
      boot_id: 'b-1',
      requester_start: 77,
      command_pid: null,
      command_start: null,
    });
  });

  it('a lease written before groups reads with null fields', async () => {
    const a = await store.create(input(), 'running');
    // the file as an earlier version wrote it: none of the group or identity fields
    const file = path.join(dir, 'leases', `000001-${a.id}.json`);
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of [
      'exclusive',
      'boot_id',
      'requester_start',
      'command_pid',
      'command_start',
    ])
      delete old[k];
    fs.writeFileSync(file, JSON.stringify(old));
    expect(store.get(a.id)).toEqual(a);
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

  it('positionOf counts the starting leases ahead too, as the gate counts them', async () => {
    const s = await store.create(input(), 'pending');
    const a = await store.create(input(), 'pending');
    const b = await store.create(input(), 'pending');
    await store.transition(s.id, 'starting');
    expect(store.head()?.id).toBe(a.id);
    expect(store.positionOf(s.id)).toBe(0);
    expect(store.positionOf(a.id)).toBe(2);
    expect(store.positionOf(b.id)).toBe(3);
  });

  it('patch with an expected state refuses a lease in another state and leaves it as it was', async () => {
    const a = await store.create(input(), 'pending');
    await expect(
      store.patch(a.id, { child_pid: 5 }, { expect: 'starting' })
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      message: `lease ${a.id} is pending, expected starting`,
    });
    expect(store.get(a.id)?.child_pid).toBeNull();
    await store.transition(a.id, 'starting');
    expect(
      (await store.patch(a.id, { child_pid: 5 }, { expect: 'starting' }))
        .child_pid
    ).toBe(5);
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
    // a lock left by a process that has exited, older than 30 s, is broken
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid as number;
    fs.mkdirSync(path.join(dir, 'leases'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'leases', '.lock'),
      JSON.stringify({ pid: deadPid, at: now - 60_000, token: 'dead' })
    );
    await expect(store.withLock(() => 'ok')).resolves.toBe('ok');
  });

  it('breaks an empty lock file whose mtime is older than 30 s', async () => {
    fs.mkdirSync(path.join(dir, 'leases'), { recursive: true });
    const lock = path.join(dir, 'leases', '.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    await expect(store.withLock(() => 'ok')).resolves.toBe('ok');
  });

  it('callers in one process take the lock in turn, without polling for it', async () => {
    const one = new LeaseStore(dir);
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const a = one.withLock(async () => {
        order.push('a in');
        await Promise.resolve();
        order.push('a out');
      });
      const b = one.withLock(async () => {
        order.push('b');
      });
      // no timer runs: a lock waited for by polling would never be taken
      await Promise.all([a, b]);
      expect(order).toEqual(['a in', 'a out', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a caller whose turn never comes still fails as a held lock does', async () => {
    const one = new LeaseStore(dir);
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const outer = one.withLock(() => new Promise<void>((r) => (release = r)));
      const inner = one.withLock(() => 'never');
      const seen = inner.catch((e) => e);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await seen).toMatchObject({ code: 'TIMEOUT' });
      release();
      await outer;
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the break guard', () => {
    let leases: string;
    let lock: string;
    let guard: string;
    let deadPid: number;
    beforeEach(() => {
      leases = path.join(dir, 'leases');
      lock = path.join(leases, '.lock');
      guard = `${lock}.break`;
      fs.mkdirSync(leases, { recursive: true });
      deadPid = spawnSync(process.execPath, ['-e', '0']).pid as number;
    });
    const staleLock = () =>
      fs.writeFileSync(
        lock,
        JSON.stringify({ pid: deadPid, at: now - 60_000, token: 'dead' })
      );
    const tokenOf = () => JSON.parse(fs.readFileSync(lock, 'utf8')).token;
    const lockNames = () =>
      fs.readdirSync(leases).filter((n) => n.startsWith('.lock'));

    it('breaks a stale lock and takes it, leaving no guard, token or moved file behind', async () => {
      staleLock();
      let seen: string | null = null;
      await expect(
        store.withLock(() => {
          seen = tokenOf();
          return 'ok';
        })
      ).resolves.toBe('ok');
      expect(seen).toMatch(/^4242-[0-9a-f]{12}$/);
      expect(lockNames()).toEqual([]);
    });

    it('waits while a fresh guard is held and leaves the lock alone, then breaks it once the guard is gone', async () => {
      staleLock();
      fs.mkdirSync(guard);
      fs.writeFileSync(
        path.join(guard, 'holder'),
        JSON.stringify({ pid: process.pid, at: now, token: 'breaking' })
      );
      let atRelease: string | null = null;
      let released = 0;
      setTimeout(() => {
        atRelease = tokenOf(); // the waiting breaker has not touched the lock
        released = Date.now();
        fs.rmSync(guard, { recursive: true, force: true });
      }, 200);
      let took = 0;
      await store.withLock(() => {
        took = Date.now();
      });
      expect(atRelease).toBe('dead');
      expect(released).toBeGreaterThan(0);
      expect(took).toBeGreaterThanOrEqual(released);
      expect(lockNames()).toEqual([]);
    });

    it('removes a stale guard (an old holder whose pid is dead, or none and an old mtime) and goes on with the break', async () => {
      staleLock();
      fs.mkdirSync(guard);
      fs.writeFileSync(
        path.join(guard, 'holder'),
        JSON.stringify({ pid: deadPid, at: now - 60_000, token: 'crashed' })
      );
      const t0 = Date.now();
      await expect(store.withLock(() => 'ok')).resolves.toBe('ok');
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(lockNames()).toEqual([]);
      // a breaker that died before writing its holder: judged by the directory's mtime
      staleLock();
      fs.mkdirSync(guard);
      const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
      fs.utimesSync(guard, old, old);
      await expect(store.withLock(() => 'ok')).resolves.toBe('ok');
      expect(lockNames()).toEqual([]);
    });

    it('under the guard, a lock whose token changed since it was judged stale is not unlinked: its fresh holder keeps it', async () => {
      staleLock();
      let hooked = 0;
      const breaker = new LeaseStore(dir, {
        now: () => now,
        pid: 4242,
        beforeUnlink: () => {
          hooked++;
          // a fresh holder took the lock between the judgement and the guard (pid 1 lives)
          if (hooked === 1)
            fs.writeFileSync(
              lock,
              JSON.stringify({ pid: 1, at: now, token: 'fresh' })
            );
        },
      });
      let atRelease: string | null = null;
      setTimeout(() => {
        atRelease = tokenOf();
        fs.rmSync(lock, { force: true }); // the fresh holder releases
      }, 200);
      const t0 = Date.now();
      await expect(breaker.withLock(() => 'ok')).resolves.toBe('ok');
      expect(hooked).toBe(1);
      expect(atRelease).toBe('fresh');
      expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
      expect(lockNames()).toEqual([]);
    });

    it('two breakers and a plain acquirer of one stale lock never hold it at the same time', async () => {
      staleLock();
      let inside = 0;
      let most = 0;
      const order: string[] = [];
      const section = (name: string) => async () => {
        inside++;
        most = Math.max(most, inside);
        order.push(`${name}-in`);
        await new Promise((r) => setTimeout(r, 60));
        order.push(`${name}-out`);
        inside--;
      };
      const other = new LeaseStore(dir, { now: () => now, pid: 4343 });
      const late: Promise<void>[] = [];
      // while the first breaker holds the guard, the second breaker and the plain acquirer try their own take: each
      // sees the stale lock and the busy guard, and waits
      const first = new LeaseStore(dir, {
        now: () => now,
        pid: 4242,
        beforeUnlink: () => {
          if (late.length) return;
          late.push(other.withLock(section('second')));
          late.push(store.withLock(section('plain')));
          expect(tokenOf()).toBe('dead');
        },
      });
      await Promise.all([first.withLock(section('first')), ...late]);
      expect(late).toHaveLength(2);
      expect(most).toBe(1);
      expect(order.slice(0, 2)).toEqual(['first-in', 'first-out']);
      expect(order).toHaveLength(6);
      expect(lockNames()).toEqual([]);
    });
  });

  it('release does not remove a lock it does not own', async () => {
    const lock = path.join(dir, 'leases', '.lock');
    await store.withLock(() => {
      fs.writeFileSync(
        lock,
        JSON.stringify({ pid: 1, at: now, token: 'other' })
      );
    });
    expect(fs.existsSync(lock)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lock, 'utf8')).token).toBe('other');
    fs.rmSync(lock, { force: true });
  });

  it('breaks a lock that names this process with a token it does not hold (one a release that threw left)', async () => {
    fs.mkdirSync(path.join(dir, 'leases'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'leases', '.lock'),
      JSON.stringify({ pid: process.pid, at: now, token: 'released' })
    );
    await expect(store.withLock(() => 'ok')).resolves.toBe('ok');
  });

  it("keeps this process's own live locks: two holders without a pid override still take turns", async () => {
    // two stores: callers of one store take their turns before the lock file
    const real = new LeaseStore(dir, { now: () => now });
    const twin = new LeaseStore(dir, { now: () => now });
    const order: string[] = [];
    await Promise.all([
      real.withLock(async () => {
        order.push('a-in');
        await new Promise((r) => setTimeout(r, 50));
        order.push('a-out');
      }),
      twin.withLock(async () => {
        order.push('b');
      }),
    ]);
    expect(order).toEqual(['a-in', 'a-out', 'b']);
  });

  it('breaks a lock taken before this boot, even when its pid is alive again', async () => {
    fs.mkdirSync(path.join(dir, 'leases'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'leases', '.lock'),
      JSON.stringify({
        pid: process.ppid,
        at: now - (os.uptime() + 3600) * 1000,
        token: 'before-boot',
      })
    );
    await expect(store.withLock(() => 'ok')).resolves.toBe('ok');
  });

  it('sweeps stray lock temp and stale files older than LOCK_STALE_MS when the lock is contended', async () => {
    const leases = path.join(dir, 'leases');
    fs.mkdirSync(leases, { recursive: true });
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    const stray = (name: string, aged: boolean) => {
      const f = path.join(leases, name);
      fs.writeFileSync(f, '{}');
      if (aged) fs.utimesSync(f, old, old);
      return f;
    };
    const oldTmp = stray('.lock.1-dead.tmp', true);
    const oldStale = stray('.lock.1-dead.stale', true);
    const freshTmp = stray('.lock.2-waiting.tmp', false);
    const other = stray('000001-l_kept.json.1.tmp', true);
    // a guard a breaker moved aside and died before removing: a directory with its holder inside
    const movedGuard = (name: string, aged: boolean) => {
      const d = path.join(leases, name);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'holder'), '{}');
      if (aged) fs.utimesSync(d, old, old);
      return d;
    };
    const oldGuard = movedGuard('.lock.break.1-dead.stale', true);
    const freshGuard = movedGuard('.lock.break.2-live.stale', false);
    // a second store contends for the lock file: callers of one store take their turns before it
    const twin = new LeaseStore(dir, { now: () => now, pid: 4242 });
    await Promise.all([
      store.withLock(() => new Promise((r) => setTimeout(r, 100))),
      new Promise((r) => setTimeout(r, 20)).then(() =>
        twin.withLock(() => 'ok')
      ),
    ]);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(oldStale)).toBe(false);
    expect(fs.existsSync(oldGuard)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
    expect(fs.existsSync(freshGuard)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('writes its token file again when a sweep took it during a long wait, and takes the lock', async () => {
    const leases = path.join(dir, 'leases');
    let swept = 0;
    // a second store waits on the lock file: callers of one store take their turns before it
    const twin = new LeaseStore(dir, { now: () => now, pid: 4242 });
    await Promise.all([
      store.withLock(async () => {
        await new Promise((r) => setTimeout(r, 30));
        // the waiter's token file is gone, as a sweep after a stall of more than LOCK_STALE_MS leaves it
        for (const n of fs.readdirSync(leases))
          if (/^\.lock\..+\.tmp$/.test(n)) {
            fs.rmSync(path.join(leases, n));
            swept++;
          }
        await new Promise((r) => setTimeout(r, 30));
      }),
      new Promise((r) => setTimeout(r, 10)).then(() =>
        twin.withLock(() => 'ok')
      ),
    ]).then(([, b]) => expect(b).toBe('ok'));
    expect(swept).toBe(1);
    expect(fs.readdirSync(leases).filter((n) => n.startsWith('.lock'))).toEqual(
      []
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    'a release that throws does not leave its token live: the next take breaks the lock it left',
    async () => {
      const real = new LeaseStore(dir, { now: () => now });
      const leases = path.join(dir, 'leases');
      await expect(
        real.withLock(() => {
          fs.chmodSync(leases, 0o555); // the lock cannot be unlinked: release throws
        })
      ).rejects.toMatchObject({ code: 'EACCES' });
      fs.chmodSync(leases, 0o755);
      expect(fs.existsSync(path.join(leases, '.lock'))).toBe(true);
      const t0 = Date.now();
      await expect(real.withLock(() => 'ok')).resolves.toBe('ok');
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  );

  it('pidAlive: this process and pid 1 exist (another user counts), an exited one does not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(1)).toBe(true);
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid as number;
    expect(pidAlive(deadPid)).toBe(false);
  });

  it('starterAlive: a live starter is trusted for ten minutes from running (else admitted), a dead or missing one never', () => {
    const now = 1_700_000_000_000;
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid as number;
    expect(STARTER_TRUST_MS).toBe(600_000);
    const live = { child_pid: process.pid, admitted_at: null };
    expect(starterAlive({ ...live, running_at: ago(10_000) }, now)).toBe(true);
    // a fast start inside a long-lived process whose clear failed pins its lease no longer than that
    expect(starterAlive({ ...live, running_at: ago(600_001) }, now)).toBe(
      false
    );
    expect(
      starterAlive(
        { child_pid: process.pid, running_at: null, admitted_at: ago(1000) },
        now
      )
    ).toBe(true);
    expect(
      starterAlive(
        { child_pid: process.pid, running_at: null, admitted_at: ago(700_000) },
        now
      )
    ).toBe(false);
    // running_at wins over an older admitted_at: the start under the watcher began when it reached running
    expect(
      starterAlive(
        {
          child_pid: process.pid,
          running_at: ago(1000),
          admitted_at: ago(700_000),
        },
        now
      )
    ).toBe(true);
    expect(
      starterAlive(
        { child_pid: deadPid, running_at: ago(1000), admitted_at: null },
        now
      )
    ).toBe(false);
    expect(
      starterAlive(
        { child_pid: null, running_at: ago(1000), admitted_at: null },
        now
      )
    ).toBe(false);
    expect(
      starterAlive(
        { child_pid: process.pid, running_at: null, admitted_at: null },
        now
      )
    ).toBe(false);
  });

  it('recovers the sequence when .seq is missing or garbled', async () => {
    const a = await store.create(input(), 'pending');
    const b = await store.create(input(), 'pending');
    expect(b.seq).toBe(2);
    fs.rmSync(path.join(dir, 'leases', '.seq'));
    const c = await store.create(input(), 'pending');
    expect(c.seq).toBe(3);
    fs.writeFileSync(path.join(dir, 'leases', '.seq'), 'junk');
    const d = await store.create(input(), 'pending');
    expect(d.seq).toBe(4);
    const files = fs
      .readdirSync(path.join(dir, 'leases'))
      .filter((f) => f.endsWith('.json'))
      .sort();
    expect(files).toEqual([
      `000001-${a.id}.json`,
      `000002-${b.id}.json`,
      `000003-${c.id}.json`,
      `000004-${d.id}.json`,
    ]);
  });
});

describe('caller environments', () => {
  let dir: string;
  let store: LeaseStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-callerenv-'));
    store = new LeaseStore(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fileOf = (id: string) => path.join(dir, 'caller-env', `${id}.json`);

  it('keeps an environment only its owner can read, without pm2 keys, and hands it over once', () => {
    keepCallerEnv(dir, 'l_aaaaaaaaaa', {
      CALLER_MARK: 'caller',
      namespace: 'mcproc',
      pm_id: '3',
      UNSET: undefined,
    });
    expect(fs.statSync(path.join(dir, 'caller-env')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileOf('l_aaaaaaaaaa')).mode & 0o777).toBe(0o600);
    expect(takeCallerEnv(dir, 'l_aaaaaaaaaa')).toEqual({
      CALLER_MARK: 'caller',
    });
    expect(fs.existsSync(fileOf('l_aaaaaaaaaa'))).toBe(false);
    expect(takeCallerEnv(dir, 'l_aaaaaaaaaa')).toBeNull();
  });

  it('a kept environment that does not parse is dropped and taken as none', () => {
    fs.mkdirSync(path.join(dir, 'caller-env'), { recursive: true });
    fs.writeFileSync(fileOf('l_bbbbbbbbbb'), '{not json');
    expect(takeCallerEnv(dir, 'l_bbbbbbbbbb')).toBeNull();
    expect(fs.existsSync(fileOf('l_bbbbbbbbbb'))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    'a kept environment that cannot be read is dropped and taken as none',
    () => {
      fs.mkdirSync(path.join(dir, 'caller-env'), { recursive: true });
      fs.writeFileSync(fileOf('l_cccccccccc'), '{"X":"1"}', { mode: 0o000 });
      expect(takeCallerEnv(dir, 'l_cccccccccc')).toBeNull();
      expect(fs.existsSync(fileOf('l_cccccccccc'))).toBe(false);
    }
  );

  it('a lease that ends, or runs without the watcher starting it, drops its kept environment; one admitted keeps it', async () => {
    const a = await store.withLock(() => store.create(input(), 'pending'));
    const b = await store.withLock(() => store.create(input(), 'pending'));
    const c = await store.withLock(() => store.create(input(), 'pending'));
    keepCallerEnv(dir, a.id, { X: '1' });
    keepCallerEnv(dir, b.id, { X: '2' });
    keepCallerEnv(dir, c.id, { X: '3' });
    await store.withLock(() => store.transition(a.id, 'cancelled'));
    await store.withLock(() => store.transition(b.id, 'starting'));
    await store.withLock(() => store.transition(c.id, 'running'));
    expect(fs.existsSync(fileOf(a.id))).toBe(false);
    expect(fs.existsSync(fileOf(b.id))).toBe(true);
    expect(fs.existsSync(fileOf(c.id))).toBe(false);
  });

  it('prune sweeps the kept environments whose lease does not wait any more', async () => {
    const waiting = await store.withLock(() =>
      store.create(input(), 'pending')
    );
    keepCallerEnv(dir, waiting.id, { X: '1' });
    // one whose lease is gone, and one left behind by a lease that ended without dropping it
    keepCallerEnv(dir, 'l_gonegonego', { X: '2' });
    const ended = await store.withLock(() => store.create(input(), 'running'));
    await store.withLock(() => store.transition(ended.id, 'freed'));
    keepCallerEnv(dir, ended.id, { X: '3' });
    await store.withLock(() => store.prune());
    expect(fs.existsSync(fileOf(waiting.id))).toBe(true);
    expect(fs.existsSync(fileOf('l_gonegonego'))).toBe(false);
    expect(fs.existsSync(fileOf(ended.id))).toBe(false);
  });
});

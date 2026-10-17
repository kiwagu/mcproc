import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McprocError } from '../errors.js';

/** Where a lease stands: queued (pending), handed to a watcher (starting), up (running), or ended (freed, cancelled, failed). */
export type LeaseState =
  | 'pending'
  | 'starting'
  | 'running'
  | 'freed'
  | 'cancelled'
  | 'failed';
/** Whether a lease claims memory for a start of apps or for a one-off exec. */
export type LeaseKind = 'start' | 'exec';
/** Where one app's share of an estimate came from: `declared`, `measured from slot N`, or `none`. */
export interface LeaseSource {
  mib: number;
  source: string;
}
/** One claim on the host's memory: a start of apps, or a one-off exec; its estimate and where it stands in the queue. */
export interface Lease {
  id: string;
  seq: number;
  state: LeaseState;
  kind: LeaseKind;
  project: string;
  root: string;
  slot: number | null;
  repo: string | null;
  target: string;
  /** the `--host` the caller gave the start, else null: the watcher's child starts the target again on the same hosts */
  host: string | null;
  apps: string[];
  reload: boolean;
  estimate_mib: number;
  need_mib: number;
  margin: number;
  reserve_mib: number;
  sources: Record<string, LeaseSource>;
  note: string | null;
  requester_pid: number;
  /** the process running the start: the watcher's child while starting, the admitted caller while a start admitted at once runs */
  child_pid: number | null;
  queued_at: string;
  admitted_at: string | null;
  running_at: string | null;
  ended_at: string | null;
  waiting_for: string | null;
  error: string | null;
  exit_code: number | null;
}
/** The fields a caller supplies to create a lease; the store fills in the id, sequence and times. */
export type NewLease = Omit<
  Lease,
  | 'id'
  | 'seq'
  | 'state'
  | 'child_pid'
  | 'queued_at'
  | 'admitted_at'
  | 'running_at'
  | 'ended_at'
  | 'waiting_for'
  | 'error'
  | 'exit_code'
>;

/** The lease state machine: for each state, the states it may move to. */
export const ALLOWED: Record<LeaseState, readonly LeaseState[]> = {
  pending: ['starting', 'running', 'cancelled'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['freed'],
  freed: [],
  cancelled: [],
  failed: [],
};
const ENDED = new Set<LeaseState>(['freed', 'cancelled', 'failed']);
/** Age after which a lock whose holder is dead may be broken, in milliseconds. */
export const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const PRUNE_AFTER_MS = 24 * 3600 * 1000;

/** Whether a process with that pid exists, as `kill -0` tells it (a process of another user, EPERM, exists too). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How long a lease's live starter is trusted after its start began, in milliseconds: ten minutes. */
export const STARTER_TRUST_MS = 600_000;

/**
 * Whether the process running a lease's start is still there (see `child_pid`) and the start began (`running_at`, else
 * `admitted_at`) less than STARTER_TRUST_MS before `now`: a start that runs may not have its apps up yet, and a start
 * admitted at once inside a long-lived process (the MCP server) whose clear failed pins its lease no longer than that.
 */
export function starterAlive(
  l: Pick<Lease, 'child_pid' | 'running_at' | 'admitted_at'>,
  now = Date.now()
): boolean {
  if (typeof l.child_pid !== 'number') return false;
  const began = l.running_at ?? l.admitted_at;
  if (began === null || !(now - Date.parse(began) < STARTER_TRUST_MS))
    return false;
  return pidAlive(l.child_pid);
}

/** The tokens of the locks this process holds right now: a lock naming this pid with another token is a leftover. */
const LIVE_TOKENS = new Set<string>();
/** What a crashed holder or breaker leaves: token files, and guard directories moved aside (`.lock.break.<token>.stale`). */
const STRAY = /^\.lock\..+\.(tmp|stale)$/;
/** What a stale-lock break can come to: the lock taken by the breaker, a retry at once, or a wait before the next try. */
type BreakResult = 'taken' | 'retry' | 'wait';

interface Held {
  pid: number;
  at: number;
  token: string;
}
/** Parses the content of a lock file, or null when it is empty, half-written or of another shape. */
function parseHeld(raw: string): Held | null {
  try {
    const v = JSON.parse(raw) as Partial<Held>;
    return typeof v.pid === 'number' &&
      typeof v.at === 'number' &&
      typeof v.token === 'string'
      ? (v as Held)
      : null;
  } catch {
    return null;
  }
}
/** Reads a lock file's holder, or null when the file is missing or unreadable as a holder. */
function readHeld(file: string): Held | null {
  try {
    return parseHeld(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The host's leases as files under `<state>/leases`: one JSON per lease named by sequence and id, a `.seq` counter,
 * and a `.lock` around every change, hard-linked atomically from a token file its holder wrote first. Reads need no
 * lock: a write is a rename, so a reader sees a whole file or none. Every mutator (`create`, `transition`, `patch`,
 * `prune`) is called under `withLock`, which is not reentrant: a mutator never takes the lock itself.
 */
export class LeaseStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly beforeUnlink: (() => void) | undefined;
  /**
   * Opens the lease directory under the given state directory, with optional clock and pid overrides for tests;
   * `beforeUnlink` (tests only) runs while a breaker holds the break guard, before the re-read that decides the unlink.
   */
  constructor(
    stateDir: string,
    deps: { now?: () => number; pid?: number; beforeUnlink?: () => void } = {}
  ) {
    this.dir = path.join(stateDir, 'leases');
    this.now = deps.now ?? (() => Date.now());
    this.pid = deps.pid ?? process.pid;
    this.beforeUnlink = deps.beforeUnlink;
  }
  private file(l: Pick<Lease, 'seq' | 'id'>): string {
    return path.join(
      this.dir,
      `${String(l.seq).padStart(6, '0')}-${l.id}.json`
    );
  }
  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
  private write(l: Lease): Lease {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(l);
    const tmp = `${f}.${this.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
    fs.renameSync(tmp, f);
    return l;
  }
  /**
   * Runs `fn` holding the lock (not reentrant). A lock is stale when it is older than LOCK_STALE_MS and its holder is
   * dead, when it was taken before this boot, when it names this process with a token this process does not hold, or,
   * unparseable, when its file's mtime is older than LOCK_STALE_MS; a stale lock is broken under the break guard (see
   * breakIfStale), never by moving it aside, so the lock path is never left free while a live holder has it.
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, '.lock');
    const token = `${this.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const tmp = path.join(this.dir, `.lock.${token}.tmp`);
    const writeToken = () => {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(
        tmp,
        JSON.stringify({ pid: this.pid, at: this.now(), token })
      );
    };
    writeToken();
    const start = Date.now();
    let swept = false;
    try {
      for (;;) {
        if (this.tryLink(tmp, lock, writeToken)) break;
        if (!swept) {
          this.sweepStrays();
          swept = true;
        }
        const r = this.breakIfStale(lock, token, () =>
          this.tryLink(tmp, lock, writeToken)
        );
        if (r === 'taken') break;
        if (r === 'retry') continue;
        if (Date.now() - start > LOCK_WAIT_MS)
          throw new McprocError(
            'TIMEOUT',
            `the lease lock ${lock} is held by pid ${readHeld(lock)?.pid ?? '?'} for more than ${LOCK_WAIT_MS / 1000} s`,
            { hint: 'If that process is gone, remove the file.' }
          );
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    LIVE_TOKENS.add(token);
    try {
      return await fn();
    } finally {
      // the token leaves the live set before the release: a release that throws must not leave it live
      try {
        LIVE_TOKENS.delete(token);
      } finally {
        this.release(lock, token);
      }
    }
  }
  /** Whether a parsed lock is a leftover: from before this boot, this process's own but not held, or old with a dead holder. */
  private heldStale(held: Held): boolean {
    // pids are reused after a reboot and the state directory outlives it: a lock from before the boot is nobody's
    if (held.at < this.now() - os.uptime() * 1000) return true;
    // this process knows every lock it holds: one naming it with another token is a leftover (a release that threw)
    if (held.pid === process.pid && !LIVE_TOKENS.has(held.token)) return true;
    return this.now() - held.at > LOCK_STALE_MS && !pidAlive(held.pid);
  }
  /**
   * Removes the `.lock.*.tmp` files and the `.lock.*.stale` entries (guard directories moved aside) a crashed holder or
   * breaker left, once older than LOCK_STALE_MS by mtime.
   */
  private sweepStrays(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!STRAY.test(n)) continue;
      const f = path.join(this.dir, n);
      if (this.mtimeAgeMs(f) > LOCK_STALE_MS)
        fs.rmSync(f, { recursive: true, force: true });
    }
  }
  /**
   * Takes the lock by hard-linking the prepared file, which is atomic: the lock never exists empty; false when it is
   * held. A token file that is gone (a sweep took it while this process stalled for longer than LOCK_STALE_MS) is
   * written again by `rewrite` and the link is tried once more.
   */
  private tryLink(tmp: string, lock: string, rewrite: () => void): boolean {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.linkSync(tmp, lock);
        return true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return false;
        if (code === 'ENOENT' && attempt === 0 && !fs.existsSync(tmp)) {
          rewrite();
          continue;
        }
        throw e;
      }
    }
  }
  /** Whether the lock as read now is the one judged stale: the same token, or for an unparseable one, still unparseable and old. */
  private stillStale(lock: string, judged: Held | null): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(lock, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
    const now = parseHeld(raw);
    return judged
      ? now?.token === judged.token
      : now === null && this.mtimeAgeMs(lock) > LOCK_STALE_MS;
  }
  /**
   * Whether the break guard was left by a breaker that died with it: its holder is older than LOCK_STALE_MS and dead,
   * or, with no readable holder, the directory's mtime is older than LOCK_STALE_MS.
   */
  private guardStale(guard: string): boolean {
    const held = readHeld(path.join(guard, 'holder'));
    if (held)
      return this.now() - held.at > LOCK_STALE_MS && !pidAlive(held.pid);
    return this.mtimeAgeMs(guard) > LOCK_STALE_MS;
  }
  /**
   * Breaks the lock when its holder is judged stale. The breaker first takes the guard `<lock>.break`, a directory made
   * with mkdir (atomic, one winner), its holder written inside; with the guard busy it waits, unless the guard is
   * itself stale: then it is moved aside (one winner) and removed. Under the guard the lock is read again, and only
   * the very lock judged stale is unlinked, the breaker's own token file linked in its place at once (`take`; a lock
   * linked in between by a plain acquirer wins). The guard is removed in every case. Residual, a double-hold window:
   * when a breaker dies holding the guard, two breakers that judge that guard stale within microseconds of each other
   * can each move a guard aside (the second one the first's fresh guard), both break under their own guard and both
   * hold the lock. It needs a crashed guard holder plus two breakers inside microseconds.
   */
  private breakIfStale(
    lock: string,
    token: string,
    take: () => boolean
  ): BreakResult {
    let raw: string;
    try {
      raw = fs.readFileSync(lock, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'retry';
      throw e;
    }
    const held = parseHeld(raw);
    const stale = held
      ? this.heldStale(held)
      : this.mtimeAgeMs(lock) > LOCK_STALE_MS;
    if (!stale) return 'wait';
    const guard = `${lock}.break`;
    try {
      fs.mkdirSync(guard);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (!this.guardStale(guard)) return 'wait';
      const moved = `${guard}.${token}.stale`;
      try {
        fs.renameSync(guard, moved);
      } catch (err) {
        // someone else moved it first
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'retry';
        throw err;
      }
      fs.rmSync(moved, { recursive: true, force: true });
      return 'retry';
    }
    try {
      fs.writeFileSync(
        path.join(guard, 'holder'),
        JSON.stringify({ pid: this.pid, at: this.now(), token })
      );
      this.beforeUnlink?.();
      // a lock that changed since it was judged belongs to a fresh holder: it is left alone
      if (!this.stillStale(lock, held)) return 'retry';
      try {
        fs.unlinkSync(lock);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      // EEXIST: a plain acquirer linked first and holds the lock; the loop waits for it
      return take() ? 'taken' : 'retry';
    } finally {
      fs.rmSync(guard, { recursive: true, force: true });
    }
  }
  /** Age of a lock file by its modification time on the file system's clock; 0 when it is gone. */
  private mtimeAgeMs(lock: string): number {
    try {
      return Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      return 0;
    }
  }
  /** Unlinks the lock only when it still carries this holder's token; a lock it does not own is never removed. */
  private release(lock: string, token: string): void {
    if (readHeld(lock)?.token === token) fs.rmSync(lock, { force: true });
  }
  /** Every readable lease, in sequence order; a half-written file is skipped. */
  list(): Lease[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .flatMap((f) => {
        try {
          return [
            JSON.parse(
              fs.readFileSync(path.join(this.dir, f), 'utf8')
            ) as Lease,
          ];
        } catch {
          return []; // half-written by a crashed writer: skipped
        }
      });
  }
  /** The lease with this id, or null when there is none. */
  get(id: string): Lease | null {
    return this.list().find((l) => l.id === id) ?? null;
  }
  private nextSeq(): number {
    const f = path.join(this.dir, '.seq');
    const onDisk = Math.max(
      0,
      ...fs
        .readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => Number(name.split('-')[0]))
        .filter(Number.isFinite)
    );
    const parsed = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
    const n = Math.max(Number.isFinite(parsed) ? parsed : 0, onDisk);
    const tmp = `${f}.${this.pid}.tmp`;
    fs.writeFileSync(tmp, String(n + 1));
    fs.renameSync(tmp, f);
    return n + 1;
  }
  /** A new lease, pending (queued) or running (admitted at once), with `child_pid` the process running its start; call it under the lock. */
  async create(
    input: NewLease,
    state: 'pending' | 'running',
    opts: { child_pid?: number | null } = {}
  ): Promise<Lease> {
    fs.mkdirSync(this.dir, { recursive: true });
    const at = this.stamp();
    const l: Lease = {
      ...input,
      id: `l_${crypto
        .randomBytes(8)
        .toString('base64url')
        .replace(/[^a-z0-9]/gi, '')
        .toLowerCase()
        .padEnd(10, '0')
        .slice(0, 10)}`,
      seq: this.nextSeq(),
      state,
      child_pid: opts.child_pid ?? null,
      queued_at: at,
      admitted_at: state === 'running' ? at : null,
      running_at: state === 'running' ? at : null,
      ended_at: null,
      waiting_for: null,
      error: null,
      exit_code: null,
    };
    return this.write(l);
  }
  /** Moves a lease along ALLOWED, stamping the time it reached the new state; `patch` sets other fields with it. */
  async transition(
    id: string,
    to: LeaseState,
    patch: Partial<Lease> = {}
  ): Promise<Lease> {
    const l = this.get(id);
    if (!l) throw new McprocError('BAD_ARGUMENT', `no lease ${id}`);
    if (!ALLOWED[l.state].includes(to))
      throw new McprocError(
        to === 'cancelled' ? 'LEASE_NOT_PENDING' : 'BAD_ARGUMENT',
        `lease ${id} is ${l.state}, cannot become ${to}`,
        {
          hint:
            to === 'cancelled'
              ? 'Only a pending or starting lease can be cancelled; stop the target to free a running one.'
              : undefined,
        }
      );
    const at = this.stamp();
    const next: Lease = { ...l, ...patch, state: to };
    if (to === 'starting') next.admitted_at = at;
    if (to === 'running') {
      next.admitted_at ??= at;
      next.running_at = at;
    }
    if (ENDED.has(to)) next.ended_at = at;
    if (to !== 'pending') next.waiting_for = null;
    return this.write(next);
  }
  /**
   * Rewrites fields of a lease without a state change: the watcher's `waiting_for`, a child pid, a refreshed estimate.
   * With `expect`, a lease that is no longer in that state is refused (BAD_ARGUMENT) and left as it was.
   */
  async patch(
    id: string,
    fields: Partial<Lease>,
    opts: { expect?: LeaseState } = {}
  ): Promise<Lease> {
    const l = this.get(id);
    if (!l) throw new McprocError('BAD_ARGUMENT', `no lease ${id}`);
    if (opts.expect && l.state !== opts.expect)
      throw new McprocError(
        'BAD_ARGUMENT',
        `lease ${id} is ${l.state}, expected ${opts.expect}`
      );
    return this.write({
      ...l,
      ...fields,
      id: l.id,
      seq: l.seq,
      state: l.state,
    });
  }
  /** The queue: pending leases oldest first. */
  pending(): Lease[] {
    return this.list().filter((l) => l.state === 'pending');
  }
  /** The pending lease at the front of the queue, or null when the queue is empty. */
  head(): Lease | null {
    return this.pending()[0] ?? null;
  }
  /** 1-based place in the queue, the starting leases counted ahead of every pending one; 0 when the lease is not pending. */
  positionOf(id: string): number {
    const all = this.list();
    const i = all
      .filter((l) => l.state === 'pending')
      .findIndex((l) => l.id === id);
    if (i < 0) return 0;
    return all.filter((l) => l.state === 'starting').length + i + 1;
  }
  /** Removes ended leases older than `maxAgeMs` (a day); returns how many. */
  prune(maxAgeMs = PRUNE_AFTER_MS): number {
    let n = 0;
    for (const l of this.list()) {
      if (!ENDED.has(l.state) || !l.ended_at) continue;
      if (this.now() - Date.parse(l.ended_at) > maxAgeMs) {
        fs.rmSync(this.file(l), { force: true });
        n++;
      }
    }
    return n;
  }
}

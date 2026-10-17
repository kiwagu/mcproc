import crypto from 'node:crypto';
import fs from 'node:fs';
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
  apps: string[];
  reload: boolean;
  estimate_mib: number;
  need_mib: number;
  margin: number;
  reserve_mib: number;
  sources: Record<string, LeaseSource>;
  note: string | null;
  requester_pid: number;
  /** the watcher's child running the start, while starting */
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The host's leases as files under `<state>/leases`: one JSON per lease named by sequence and id, a `.seq` counter,
 * and a `.lock` taken with O_EXCL around every change. Reads need no lock: a write is a rename, so a reader sees a
 * whole file or none.
 */
export class LeaseStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly pid: number;
  /** Opens the lease directory under the given state directory, with optional clock and pid overrides for tests. */
  constructor(
    stateDir: string,
    deps: { now?: () => number; pid?: number } = {}
  ) {
    this.dir = path.join(stateDir, 'leases');
    this.now = deps.now ?? (() => Date.now());
    this.pid = deps.pid ?? process.pid;
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
  /** Runs `fn` holding the lock; a lock older than LOCK_STALE_MS whose holder is dead is broken. */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = path.join(this.dir, '.lock');
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: this.pid, at: this.now() }));
        fs.closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        let held: { pid: number; at: number } | null = null;
        try {
          held = JSON.parse(fs.readFileSync(lock, 'utf8'));
        } catch {
          /* being written, or gone */
        }
        if (held && this.now() - held.at > LOCK_STALE_MS && !alive(held.pid)) {
          fs.rmSync(lock, { force: true });
          continue;
        }
        if (Date.now() - start > LOCK_WAIT_MS)
          throw new McprocError(
            'TIMEOUT',
            `the lease lock ${lock} is held by pid ${held?.pid ?? '?'} for more than ${LOCK_WAIT_MS / 1000} s`,
            { hint: 'If that process is gone, remove the file.' }
          );
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
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
    const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) || 0 : 0;
    fs.writeFileSync(f, String(n + 1));
    return n + 1;
  }
  /** A new lease, pending (queued) or running (admitted at once); call it under the lock. */
  async create(input: NewLease, state: 'pending' | 'running'): Promise<Lease> {
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
      child_pid: null,
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
  /** Rewrites fields of a lease without a state change: the watcher's `waiting_for`, a child pid, a refreshed estimate. */
  async patch(id: string, fields: Partial<Lease>): Promise<Lease> {
    const l = this.get(id);
    if (!l) throw new McprocError('BAD_ARGUMENT', `no lease ${id}`);
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
  /** 1-based position among the pending leases; 0 when the lease is not pending. */
  positionOf(id: string): number {
    return this.pending().findIndex((l) => l.id === id) + 1;
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

import { describeError, isMcprocError, McprocError } from '../errors.js';
import type { LsRow } from '../list.js';
import { readHostMemory, type HostMemory } from '../memory.js';
import { findProcess, isRunning, type Pm2Process } from '../pm2.js';
import type { Context } from '../resolve.js';
import { stateDir } from '../state.js';
import { abortableSleep } from '../wait.js';
import {
  admit,
  estimateApps,
  needOf,
  rampingMib,
  reserveMib,
  type AppMeasure,
} from './admission.js';
import { ensureWatcher } from './ensure.js';
import { listCheckout, measureSiblings, registryOf } from './siblings.js';
import {
  LeaseStore,
  pidAlive,
  starterAlive,
  type Lease,
  type NewLease,
} from './store.js';

/** What the gate reads and writes: the lease store, the host's memory, the sibling measurement and the watcher. */
export interface GateDeps {
  store: LeaseStore;
  /** the host's memory reading, or null where it has none */
  memory(ctx: Context): Promise<HostMemory | null>;
  /** what the running sibling checkouts show per app */
  siblings(ctx: Context): Promise<Map<string, AppMeasure>>;
  /** makes sure the watcher runs once a lease is pending: the pm2 process mcproc-watcher on the context's daemon */
  ensureWatcher(ctx: Context): Promise<unknown>;
  /** the requester's pid kept on the lease; default this process */
  pid?: number;
}
/** A lease that still waits for memory: queued, or handed to the watcher and not up yet. */
export type QueuedLease = Lease & { state: 'pending' | 'starting' };
/** The gate's answer: go ahead (under a running lease, or none when nothing is budgeted), or queued behind others. */
export type GateResult =
  | { kind: 'proceed'; lease: Lease | null }
  | {
      kind: 'queued';
      lease: QueuedLease;
      position: number;
      waiting_for: string;
    };
/** How long a stop waits for the child of a starting lease it cancelled to exit after SIGTERM, in milliseconds. */
export const CANCEL_WAIT_MS = 10_000;
const CANCEL_POLL_MS = 200;

/** The real deps: the host state directory, the host's meminfo, the sibling checkouts of the registry, the pm2 watcher. */
export function defaultGateDeps(dir = stateDir()): GateDeps {
  return {
    store: new LeaseStore(dir),
    memory: (ctx) => readHostMemory(ctx.transport, ctx.host),
    siblings: (ctx) =>
      measureSiblings(ctx.manifest, {
        registry: registryOf(ctx.manifest, dir),
        list: (root) => listCheckout(root),
      }),
    ensureWatcher: (ctx) => ensureWatcher(ctx, dir),
  };
}

/**
 * Whether a start of `apps` on this context may run now. Apps already online count zero; a start with no declared
 * memory never touches the queue. Otherwise the estimate (measured from a sibling slot where one runs, else declared,
 * plus the margin) is judged under the lock, the running leases younger than the manifest's settle time charged on
 * top of the reading: admitted at once as a running lease, or queued as a pending one behind whatever is pending
 * already, in which case the watcher is made sure of and the caller returns. When the watcher cannot be launched, the
 * pending lease is cancelled with the reason and the start fails (the McprocError as it came, else PM2_FAILED).
 */
export async function gateStart(
  ctx: Context,
  apps: string[],
  opts: {
    /** the target as the caller named it (an app, a profile, all): the watcher starts it again by this name */
    target: string;
    /** the `--host` the caller gave, else none: kept on the lease so the watcher's child acts on the same hosts */
    host?: string | null;
    reload?: boolean;
    note?: string | null;
    procs: Pm2Process[];
  },
  deps: GateDeps
): Promise<GateResult> {
  const m = ctx.manifest;
  const toStart = apps.filter((n) => {
    const p = findProcess(opts.procs, m.project, n);
    return !(p && isRunning(p.status));
  });
  const budgeted = toStart.filter((n) => m.apps[n].memory_mib !== null);
  if (budgeted.length === 0) return { kind: 'proceed', lease: null };
  if (!ctx.host.local)
    throw new McprocError(
      'LEASE_UNSUPPORTED_HOST',
      `${budgeted.join(', ')} declare memory but run on host ${ctx.host.name}; the lease queue works on the local host only in this version`,
      { hint: 'Drop memory: from apps bound to remote hosts.' }
    );
  const memory = await deps.memory(ctx);
  const measured = await deps.siblings(ctx);
  const { estimate_mib, sources } = estimateApps(
    toStart.map((n) => m.apps[n]),
    measured
  );
  if (estimate_mib === 0) return { kind: 'proceed', lease: null };
  const need_mib = needOf(estimate_mib, m.resources.margin);
  const reserve_mib = reserveMib(m.resources.reserve, memory);
  const target = opts.target;
  const host = opts.host ?? null;
  const input: NewLease = {
    kind: 'start',
    project: m.project,
    root: m.root,
    slot: m.slot,
    repo: m.repo,
    target,
    host,
    apps: toStart,
    reload: Boolean(opts.reload),
    estimate_mib,
    need_mib,
    margin: m.resources.margin,
    reserve_mib,
    sources,
    note: opts.note ?? null,
    requester_pid: deps.pid ?? process.pid,
  };
  const result = await deps.store.withLock(async (): Promise<GateResult> => {
    const same = deps.store
      .list()
      .find(
        (l): l is QueuedLease =>
          (l.state === 'pending' || l.state === 'starting') &&
          l.root === m.root &&
          l.project === m.project &&
          l.target === target &&
          (l.host ?? null) === host
      );
    if (same)
      return {
        kind: 'queued',
        lease: same,
        position: deps.store.positionOf(same.id),
        waiting_for: same.waiting_for ?? same.state,
      };
    const all = deps.store.list();
    const ahead = all.filter(
      (l) => l.state === 'pending' || l.state === 'starting'
    ).length;
    // a start admitted seconds ago is not in the reading yet: two starts on one reading must not both fit
    const ramping_mib = rampingMib(all, Date.now(), m.resources.settle * 1000);
    const d = admit({ ahead, memory, need_mib, reserve_mib, ramping_mib });
    if (!d.ok && d.reason === 'never')
      throw new McprocError('NEVER_FITS', `${target}: ${d.waiting_for}`, {
        hint: "Lower the apps' memory: declarations or the resources.reserve, or run fewer apps.",
      });
    if (d.ok) {
      // this process runs the start: until it is done, the watcher must not judge the lease by its apps
      const lease = await deps.store.create(input, 'running', {
        child_pid: process.pid,
      });
      return { kind: 'proceed', lease };
    }
    const created = await deps.store.create(input, 'pending');
    const lease = await deps.store.patch(created.id, {
      waiting_for: d.waiting_for,
    });
    return {
      kind: 'queued',
      lease: { ...lease, state: 'pending' },
      position: deps.store.positionOf(lease.id),
      waiting_for: d.waiting_for,
    };
  });
  if (result.kind === 'queued')
    try {
      await deps.ensureWatcher(ctx);
    } catch (e) {
      // nothing would ever admit it, and it would hold every later start of the host behind it
      const error = `the watcher could not be launched: ${describeError(e)}`;
      const id = result.lease.id;
      await deps.store
        .withLock(async () => {
          if (deps.store.get(id)?.state === 'pending')
            await deps.store.transition(id, 'cancelled', { error });
        })
        .catch(() => undefined);
      throw isMcprocError(e) ? e : new McprocError('PM2_FAILED', error);
    }
  return result;
}

/** After the watcher's child ran the start, under the lock: running when any app came up (failures noted), failed when none did. */
export async function finishLeasedStart(
  store: LeaseStore,
  id: string,
  rows: LsRow[]
): Promise<Lease> {
  const bad = rows.filter((r) => r.error);
  const error = bad.length
    ? bad.map((r) => `${r.app}: ${r.error}`).join('; ')
    : null;
  return store.withLock(() =>
    bad.length === rows.length
      ? store.transition(id, 'failed', { error, child_pid: null })
      : store.transition(id, 'running', { error, child_pid: null })
  );
}

/** A start admitted at once that then threw: its running lease is freed with the error and without its starter, under the lock. */
export async function freeOnFailure(
  store: LeaseStore,
  lease: Lease,
  e: unknown
): Promise<void> {
  const error = e instanceof Error ? e.message : String(e);
  try {
    await store.withLock(() =>
      store.transition(lease.id, 'freed', { error, child_pid: null })
    );
  } catch {
    /* already ended by someone else */
  }
}

/** How many times endFastStart tries its clear, and how long it pauses between two tries, in milliseconds. */
const END_FAST_TRIES = 3;
const END_FAST_PAUSE_MS = 2000;

/**
 * A start admitted at once that went through: its starter is cleared under the lock, while the lease is still running
 * and still names it. A clear that fails (the lock is busy) is tried END_FAST_TRIES times END_FAST_PAUSE_MS apart before
 * the last error is let through; a lease left naming its starter is then trusted no longer than STARTER_TRUST_MS.
 */
export async function endFastStart(
  store: LeaseStore,
  lease: Lease,
  sleep: (ms: number) => Promise<void> = abortableSleep
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.withLock(async () => {
        const cur = store.get(lease.id);
        if (
          cur?.state === 'running' &&
          cur.child_pid !== null &&
          cur.child_pid === lease.child_pid
        )
          await store.patch(lease.id, { child_pid: null });
      });
      return;
    } catch (e) {
      if (attempt >= END_FAST_TRIES) throw e;
      await sleep(END_FAST_PAUSE_MS);
    }
  }
}

/** The leases of this checkout that still wait for or hold memory (pending, starting, running), read without the lock. */
export function liveLeasesOf(store: LeaseStore, ctx: Context): Lease[] {
  const m = ctx.manifest;
  return store
    .list()
    .filter(
      (l) =>
        l.root === m.root &&
        l.project === m.project &&
        (l.state === 'pending' ||
          l.state === 'starting' ||
          l.state === 'running')
    );
}

/**
 * Before a stop or delete of `stopped` on this checkout: every pending or starting lease of it whose apps overlap the
 * stopped ones is cancelled under the lock; then the child of each cancelled starting lease is sent SIGTERM and
 * waited for, up to CANCEL_WAIT_MS, so it cannot launch an app after the stop. Returns the cancelled ids.
 */
export async function cancelBefore(
  store: LeaseStore,
  ctx: Context,
  stopped: string[]
): Promise<string[]> {
  const m = ctx.manifest;
  // nothing of this checkout is live: the lock (and the state directory) is left alone
  if (liveLeasesOf(store, ctx).length === 0) return [];
  const cancelled: string[] = [];
  const children: number[] = [];
  await store.withLock(async () => {
    for (const l of store.list()) {
      if (l.root !== m.root || l.project !== m.project) continue;
      if (l.state !== 'pending' && l.state !== 'starting') continue;
      if (!l.apps.some((a) => stopped.includes(a))) continue;
      await store.transition(l.id, 'cancelled', {
        error: `stop of ${stopped.join(', ')}`,
      });
      cancelled.push(l.id);
      if (l.state === 'starting' && l.child_pid) children.push(l.child_pid);
    }
  });
  // outside the lock: the child may want it on its way out, and the wait can take seconds
  await Promise.all(children.map((pid) => endChild(pid)));
  return cancelled;
}

/** Sends SIGTERM to a lease's child and polls until it is gone, for up to CANCEL_WAIT_MS. */
async function endChild(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // gone meanwhile
  }
  const until = Date.now() + CANCEL_WAIT_MS;
  while (pidAlive(pid) && Date.now() < until)
    await new Promise((r) => setTimeout(r, CANCEL_POLL_MS));
}

/**
 * After a stop or delete on this checkout: every running start lease of it none of whose apps is online in `procs` is
 * freed, unless its starter is still alive (another process is still starting it); an exec lease belongs to its own
 * process and ends with it. Returns the freed ids.
 */
export async function freeAfter(
  store: LeaseStore,
  ctx: Context,
  procs: Pm2Process[]
): Promise<string[]> {
  const m = ctx.manifest;
  const online = (app: string) => {
    const p = findProcess(procs, m.project, app);
    return Boolean(p && isRunning(p.status));
  };
  const freed: string[] = [];
  if (liveLeasesOf(store, ctx).length === 0) return freed;
  await store.withLock(async () => {
    for (const l of store.list()) {
      if (l.root !== m.root || l.project !== m.project) continue;
      if (
        l.kind === 'start' &&
        l.state === 'running' &&
        !starterAlive(l) &&
        !l.apps.some(online)
      ) {
        await store.transition(l.id, 'freed');
        freed.push(l.id);
      }
    }
  });
  return freed;
}

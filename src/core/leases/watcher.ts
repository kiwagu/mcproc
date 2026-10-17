import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createTransport } from '../../transport/index.js';
import { describeError, isMcprocError } from '../errors.js';
import {
  DEFAULT_SHELL,
  type Host,
  loadManifest,
  parseShell,
  type Resources,
  SETTLE_DEFAULT_S,
} from '../manifest.js';
import type { HostMemory } from '../memory.js';
import { readHostMemory } from '../memory.js';
import { findProcess, isRunning } from '../pm2.js';
import { connect, prepare } from '../resolve.js';
import { abortableSleep } from '../wait.js';
import {
  admit,
  estimateApps,
  needOf,
  rampingMib,
  reserveMib,
} from './admission.js';
import { WATCHER_NOTE } from './ensure.js';
import {
  listCheckout,
  measureSiblings,
  ownsManifest,
  registryOf,
} from './siblings.js';
import {
  type Lease,
  type LeaseSource,
  type LeaseState,
  LeaseStore,
  pidAlive,
  starterAlive,
} from './store.js';

/** What the watcher reads and runs: the lease store, the host's memory, each lease's estimate, start and pm2 state, and its clock. */
export interface WatcherDeps {
  store: LeaseStore;
  memory(): Promise<HostMemory | null>;
  /** the head's estimate taken again, live: a sibling may have grown or gone since it was queued (an exec keeps its own); see watchLeases for when */
  estimate(l: Lease): Promise<{
    estimate_mib: number;
    need_mib: number;
    reserve_mib: number;
    sources: Record<string, LeaseSource>;
  }>;
  /** runs the admitted start and resolves when it has ended; the child itself writes running or failed */
  runStart(l: Lease): Promise<void>;
  onlineApps(l: Lease): Promise<Set<string>>;
  settleMs(l: Lease): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  log(line: string): void;
  /** wakes the loop on a change of the queue; returns the unsubscribe */
  watch?(cb: () => void): () => void;
  /** whether the lease's checkout is gone (its root has no manifest of its own any more); absent, none is */
  gone?(l: Lease): boolean;
}

/**
 * Under the lock, moves a lease only while it is still in `from` (and, with `also`, while that still holds of it): a
 * change that landed meanwhile (a cancel, a stop, a starter recorded) is not written over.
 */
async function moveIf(
  store: LeaseStore,
  id: string,
  from: LeaseState,
  to: LeaseState,
  patch: Partial<Lease> = {},
  also: (cur: Lease) => boolean = () => true
): Promise<Lease | null> {
  return store.withLock(async () => {
    const cur = store.get(id);
    return cur?.state === from && also(cur)
      ? store.transition(id, to, patch)
      : null;
  });
}

/** How long an exec lease may stay starting before the watcher fails it, in milliseconds: its owner polls every second. */
const EXEC_TURN_GRACE_MS = 60_000;

/**
 * A running lease whose apps all left pm2 or stopped holds nothing, nor one whose checkout is gone (both spared while
 * their starter lives, for at most STARTER_TRUST_MS, see starterAlive); a starting one whose recorded child is gone is
 * over at once, one that never recorded a child after `stuckMs`. An exec lease belongs to its requester: once that
 * process is gone, a running one is freed and a starting one failed at once; a starting one its live owner has not
 * taken within EXEC_TURN_GRACE_MS (its wait ended without the cancel landing) is failed too, so it cannot hold the queue.
 */
async function reconcile(deps: WatcherDeps, stuckMs: number): Promise<void> {
  const { store } = deps;
  for (const l of store.list()) {
    try {
      if (l.kind === 'exec') {
        // nothing else ends it: its process died without its own cleanup (a kill, a closed terminal)
        if (
          (l.state === 'running' || l.state === 'starting') &&
          !pidAlive(l.requester_pid)
        )
          await moveIf(
            store,
            l.id,
            l.state,
            l.state === 'running' ? 'freed' : 'failed',
            { error: 'requester gone' }
          );
        else if (
          l.state === 'starting' &&
          l.admitted_at &&
          deps.now() - Date.parse(l.admitted_at) > EXEC_TURN_GRACE_MS
        )
          await moveIf(store, l.id, 'starting', 'failed', {
            error: 'the exec did not take its turn',
          });
        continue;
      }
      if (
        l.state === 'running' &&
        l.kind === 'start' &&
        !starterAlive(l, deps.now())
      ) {
        let gone = deps.gone?.(l) ?? false;
        let online = new Set<string>();
        if (!gone)
          try {
            online = await deps.onlineApps(l);
          } catch (e) {
            if (!isMcprocError(e) || e.code !== 'MANIFEST_NOT_FOUND') throw e;
            gone = true;
          }
        if (gone || !l.apps.some((a) => online.has(a)))
          await moveIf(
            store,
            l.id,
            'running',
            'freed',
            { error: gone ? 'checkout gone' : 'no app online any more' },
            (cur) => !starterAlive(cur, deps.now())
          );
      }
      if (l.state !== 'starting') continue;
      if (l.kind === 'start' && l.child_pid !== null) {
        if (!pidAlive(l.child_pid))
          await moveIf(
            store,
            l.id,
            'starting',
            'failed',
            { error: "the start's child is gone", child_pid: null },
            (cur) => cur.child_pid === l.child_pid
          );
        continue;
      }
      if (l.admitted_at && deps.now() - Date.parse(l.admitted_at) > stuckMs)
        await moveIf(
          store,
          l.id,
          'starting',
          'failed',
          { error: `the start did not answer within ${stuckMs / 1000} s` },
          (cur) => cur.child_pid === null
        );
    } catch (e) {
      deps.log(`error: ${l.id}: ${describeError(e)}`);
    }
  }
}

/** How long the waiting head's full estimate (its siblings measured) holds while the memory reading says it cannot fit yet. */
const ESTIMATE_EVERY_MS = 30_000;

/** Records why the head still waits, under the lock and only while it is still pending: a cancel that landed meanwhile must not be written over. */
async function noteWaiting(
  store: LeaseStore,
  head: Lease,
  fields: Partial<Lease> & { waiting_for: string }
): Promise<void> {
  await store
    .withLock(() => store.patch(head.id, fields, { expect: 'pending' }))
    .catch(() => undefined);
}

/**
 * One judgement of the head: admitted (and, for a start, run to its end), still waiting (its reason recorded), or
 * changed under the watcher (cancelled meanwhile, or cancelled now because it can never fit), so the next head is
 * judged at once. Without `full`, the memory reading is judged against the head's last recorded need first, and its
 * estimate (the sibling measurement, seconds of docker stats) is taken again only when that check lets it fit; `last`
 * is set to the head and the time of each estimate taken.
 */
async function judgeHead(
  deps: WatcherDeps,
  head: Lease,
  last: { id: string | null; at: number },
  full: boolean
): Promise<'admitted' | 'waiting' | 'changed'> {
  const { store } = deps;
  // its checkout was removed (or is now only a path inside another one): it can never start, and it must not hold
  // every later lease behind it
  if (deps.gone?.(head)) {
    const c = await moveIf(store, head.id, 'pending', 'cancelled', {
      error: 'checkout gone',
    });
    if (c) deps.log(`cancel ${head.id}: checkout gone (${head.root})`);
    return 'changed';
  }
  // an exec whose requester is gone would be marked starting for nobody, and hold every later lease behind it
  if (head.kind === 'exec' && !pidAlive(head.requester_pid)) {
    const c = await moveIf(store, head.id, 'pending', 'cancelled', {
      error: 'requester gone',
    });
    if (c)
      deps.log(`cancel ${head.id}: requester gone (pid ${head.requester_pid})`);
    return 'changed';
  }
  let memory: HostMemory | null;
  let est: Awaited<ReturnType<WatcherDeps['estimate']>>;
  try {
    memory = await deps.memory();
    if (!full) {
      const cheap = admit({
        ahead: 0,
        memory,
        need_mib: head.need_mib,
        reserve_mib: head.reserve_mib,
        ramping_mib: rampingMib(store.list(), deps.now(), deps.settleMs(head)),
      });
      if (!cheap.ok && cheap.reason === 'memory') {
        if (head.waiting_for !== cheap.waiting_for)
          await noteWaiting(store, head, { waiting_for: cheap.waiting_for });
        return 'waiting';
      }
    }
    est = await deps.estimate(head);
    last.id = head.id;
    last.at = deps.now();
  } catch (e) {
    // its checkout cannot be read now: the reason shows in `leases`, the next tick tries again
    const why = `cannot estimate: ${describeError(e)}`;
    if (head.waiting_for !== why) {
      deps.log(`${head.id}: ${why}`);
      await noteWaiting(store, head, { waiting_for: why });
    }
    return 'waiting';
  }
  // a start admitted seconds ago is not in the reading yet, as the gate charges it
  const ramping_mib = rampingMib(store.list(), deps.now(), deps.settleMs(head));
  const d = admit({
    ahead: 0,
    memory,
    need_mib: est.need_mib,
    reserve_mib: est.reserve_mib,
    ramping_mib,
  });
  if (d.ok) {
    const admitted = await moveIf(store, head.id, 'pending', 'starting', {
      ...est,
      waiting_for: null,
    });
    if (!admitted) return 'changed';
    deps.log(
      `admit ${admitted.id} ${admitted.project} ${admitted.target} (${est.need_mib}M, free ${d.free_mib ?? '?'}M)`
    );
    if (admitted.kind === 'start') {
      try {
        await deps.runStart(admitted);
      } catch (e) {
        await moveIf(store, admitted.id, 'starting', 'failed', {
          error: describeError(e),
          child_pid: null,
        });
      }
      // a start that ended without its answer (the child threw before it, or was killed) is over
      await moveIf(store, admitted.id, 'starting', 'failed', {
        error: 'the start ended without an answer',
        child_pid: null,
      });
    }
    return 'admitted';
  }
  if (d.reason === 'never') {
    const c = await moveIf(store, head.id, 'pending', 'cancelled', {
      error: `never fits now: ${d.waiting_for}`,
    });
    if (c) deps.log(`cancel ${head.id}: ${d.waiting_for}`);
    return 'changed';
  }
  if (head.waiting_for !== d.waiting_for || head.need_mib !== est.need_mib)
    await noteWaiting(store, head, { ...est, waiting_for: d.waiting_for });
  return 'waiting';
}

/**
 * The last look before an idle exit, under the lock: false when something is pending or starting after all; else the
 * exit is noted in `<state>/watcher.json` (`exiting_at`), so a start that queues while this process is still on its way
 * out launches a fresh watcher instead of trusting this one.
 */
async function leaveIdle(deps: WatcherDeps): Promise<boolean> {
  const { store } = deps;
  return store.withLock(() => {
    if (
      store.list().some((l) => l.state === 'pending' || l.state === 'starting')
    )
      return false;
    const file = path.join(path.dirname(store.dir), WATCHER_NOTE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ exiting_at: new Date(deps.now()).toISOString() })
    );
    fs.renameSync(tmp, file);
    return true;
  });
}

/**
 * The watcher loop: on every tick (or wake) prune, reconcile running leases against what is online, then judge the
 * head of the FIFO: admit it (starting → the child runs the start → running / failed; an exec lease is only marked
 * starting, its owner runs it), then settle before the next head; or record why it waits. The running leases that
 * have not settled yet are charged on top of the memory reading, and a running lease whose starter still lives is not
 * reconciled. A head is estimated in full when it becomes the head, when the queue changed, when the memory reading
 * lets its last need fit, and at least every ESTIMATE_EVERY_MS; the ticks between read the memory alone. A lease
 * directory that cannot be read is logged once (a failing prune too) and the tick goes on as if nothing were queued,
 * never into an idle exit it cannot judge. Exits once nothing has been pending or starting for `idleExitMs` (leaving the exit note, see
 * leaveIdle); a starting lease that never recorded a child for `stuckMs` is failed, an exec lease whose requester
 * is gone is ended at once (cancelled at the head, failed while starting, freed while running), and one left starting
 * for EXEC_TURN_GRACE_MS is failed. A tick that throws is logged, not fatal.
 */
export async function watchLeases(
  deps: WatcherDeps,
  opts: {
    tickMs?: number;
    idleExitMs?: number;
    stuckMs?: number;
    signal?: AbortSignal;
    once?: boolean;
  } = {}
): Promise<'idle' | 'aborted'> {
  const tickMs = opts.tickMs ?? 2000;
  const idleExitMs = opts.idleExitMs ?? 60_000;
  const stuckMs = opts.stuckMs ?? 10 * 60 * 1000;
  const { store } = deps;
  let idleSince = deps.now();
  let tick: AbortController | null = null;
  // what the queue looked like before the head was judged: only a change of it wakes the loop, so the watcher's own
  // patches (a waiting_for with live figures), the lock's files and the temp files never do; one made during the
  // judgement (a lease queued or cancelled while a long estimate ran) skips the sleep
  let asleepOn = '';
  // the head's last full estimate, and whether the queue changed since the last judgement: both call for a new one
  const last: { id: string | null; at: number } = { id: null, at: 0 };
  let woken = false;
  // a failure that repeats every tick is logged once, and again only once it changed or cleared
  const said = new Map<string, string>();
  const sayOnce = (key: string, line: string | null) => {
    if (line === null) said.delete(key);
    else if (said.get(key) !== line) {
      said.set(key, line);
      deps.log(line);
    }
  };
  // whether a read of the lease directory failed in this tick: nothing is known about the queue then
  let blind = false;
  const unreadable = (e: unknown) => {
    blind = true;
    sayOnce(
      'read',
      `error: the lease directory cannot be read: ${describeError(e)}`
    );
  };
  const readable = <T>(read: () => T, fallback: T): T => {
    try {
      const v = read();
      sayOnce('read', null);
      return v;
    } catch (e) {
      unreadable(e);
      return fallback;
    }
  };
  const queueOf = () =>
    readable(
      () =>
        store
          .list()
          .map((l) => `${l.id}:${l.state}`)
          .join(','),
      asleepOn
    );
  const unwatch = deps.watch?.(() => {
    if (tick && queueOf() !== asleepOn) tick.abort();
  });
  try {
    for (;;) {
      if (opts.signal?.aborted) return 'aborted';
      blind = false;
      try {
        await store.withLock(() => store.prune());
        sayOnce('prune', null);
      } catch (e) {
        sayOnce('prune', `error: prune: ${describeError(e)}`);
      }
      try {
        await reconcile(deps, stuckMs);
      } catch (e) {
        unreadable(e); // its own list: each lease's errors are caught inside
      }
      asleepOn = queueOf();
      const starting = readable(
        () => store.list().some((l) => l.state === 'starting'),
        false
      );
      const head = readable(() => store.head(), null);
      const now = deps.now();
      if (!head && !starting && !blind) {
        if (now - idleSince >= idleExitMs) {
          if (await leaveIdle(deps)) return 'idle';
          // a start queued in the moment before the exit: it is taken first
          idleSince = now;
          continue;
        }
      } else idleSince = now;
      if (head && !starting) {
        const full =
          woken ||
          last.id !== head.id ||
          deps.now() - last.at >= ESTIMATE_EVERY_MS;
        woken = false;
        let r: 'admitted' | 'waiting' | 'changed' = 'waiting';
        try {
          r = await judgeHead(deps, head, last, full);
        } catch (e) {
          deps.log(`error: ${head.id}: ${describeError(e)}`);
        }
        if (r === 'admitted')
          await deps.sleep(deps.settleMs(head), opts.signal);
        if (r !== 'waiting') {
          if (opts.once) return 'idle';
          continue;
        }
      }
      if (opts.once) return 'idle';
      if (queueOf() !== asleepOn) {
        woken = true;
        continue;
      }
      tick = new AbortController();
      const onAbort = () => tick?.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      await deps.sleep(tickMs, tick.signal);
      opts.signal?.removeEventListener('abort', onAbort);
      woken = tick.signal.aborted;
      tick = null;
    }
  } finally {
    unwatch?.();
  }
}

/**
 * The wake of the pm2-managed watcher: `fs.watch` on the lease directory. The lock's own files (`.lock`, its token
 * and stale files, `.seq`) are dot-names and never wake it.
 */
export function leaseDirWatch(dir: string): (cb: () => void) => () => void {
  return (cb) => {
    const w = fs.watch(dir, (_e, name) => {
      if (!name?.startsWith('.')) cb();
    });
    return () => w.close();
  };
}

/** The local host the watcher reads its memory on: a plain local shell in `cwd`, no ssh, no docker. */
const localHost = (cwd: string): Host => ({
  name: 'local',
  local: true,
  ssh_args: [],
  cwd,
  readonly: false,
  shell: parseShell(DEFAULT_SHELL),
  env: {},
});

/**
 * The real deps of the pm2-managed watcher: the state directory's store, the host's meminfo, each lease's checkout for
 * its estimate and pm2 state, the CLI entry for the child starts. An exec lease keeps the size its caller named, with
 * the reserve taken again from its manifest and the current reading (`memory`, as the deps hold it at the call).
 */
export function defaultWatcherDeps(dir: string, entry: string): WatcherDeps {
  const store = new LeaseStore(dir);
  const host = localHost(dir);
  const transport = createTransport(host);
  const ctxOf = async (l: Lease) => connect(prepare({ project: l.root }));
  const deps: WatcherDeps = {
    store,
    memory: () => readHostMemory(transport, host),
    estimate: async (l) => {
      // an exec has no apps to measure: what it needs is what its caller named, never a sum over `apps` (none)
      if (l.kind === 'exec') {
        let reserve: Resources['reserve'] | null = null;
        try {
          reserve = loadManifest(l.root).resources.reserve;
        } catch {
          // its checkout cannot be read: the reserve it was queued with
        }
        return {
          estimate_mib: l.estimate_mib,
          need_mib: l.need_mib,
          reserve_mib: reserve
            ? reserveMib(reserve, await deps.memory())
            : l.reserve_mib,
          sources: {},
        };
      }
      const m = loadManifest(l.root);
      const measured = await measureSiblings(m, {
        registry: registryOf(m, dir),
        list: (root) => listCheckout(root),
      });
      const apps = l.apps
        .filter((a) => Object.hasOwn(m.apps, a))
        .map((a) => m.apps[a]);
      const { estimate_mib, sources } = estimateApps(apps, measured);
      const memory = await readHostMemory(transport, host);
      return {
        estimate_mib,
        need_mib: needOf(estimate_mib, m.resources.margin),
        reserve_mib: reserveMib(m.resources.reserve, memory),
        sources,
      };
    },
    gone: (l) => !ownsManifest(l.root),
    runStart: async (l) => {
      // the checkout went away since the head was judged: nothing to start there (nor the project around it)
      if (!ownsManifest(l.root)) {
        await moveIf(store, l.id, 'starting', 'cancelled', {
          error: 'checkout gone',
        });
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            entry,
            '--project',
            l.root,
            'start',
            l.target,
            ...(l.reload ? ['--reload'] : []),
            '--lease',
            l.id,
          ],
          { stdio: 'inherit', env: { ...process.env, MCPROC_STATE_DIR: dir } }
        );
        const pid = child.pid;
        const patched = pid
          ? store
              .withLock(() =>
                store.patch(l.id, { child_pid: pid }, { expect: 'starting' })
              )
              .then(
                () => undefined,
                () => {
                  // the lease ended before its child was recorded (a stop cancelled it): the start must not go on
                  if (store.get(l.id)?.state !== 'starting')
                    child.kill('SIGTERM');
                }
              )
          : Promise.resolve();
        child.on('error', (e) => {
          void patched.then(() => reject(e));
        });
        child.on('exit', (code, signal) => {
          // a child that exited without its answer (it threw before it, or was killed) leaves the lease failed
          void patched
            .then(() =>
              moveIf(store, l.id, 'starting', 'failed', {
                error: `child exited ${code ?? signal}`,
                exit_code: code,
                child_pid: null,
              })
            )
            .then(() => resolve(), reject);
        });
      });
    },
    onlineApps: async (l) => {
      const ctx = await ctxOf(l);
      const procs = await ctx.pm2.jlist();
      return new Set(
        l.apps.filter((a) => {
          const p = findProcess(procs, ctx.manifest.project, a);
          return Boolean(p && isRunning(p.status));
        })
      );
    },
    settleMs: (l) => {
      try {
        return loadManifest(l.root).resources.settle * 1000;
      } catch {
        return SETTLE_DEFAULT_S * 1000;
      }
    },
    sleep: abortableSleep,
    now: () => Date.now(),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  };
  return deps;
}

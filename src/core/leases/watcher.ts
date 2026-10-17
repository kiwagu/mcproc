import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createTransport } from '../../transport/index.js';
import { describeError } from '../errors.js';
import {
  DEFAULT_SHELL,
  type Host,
  loadManifest,
  parseShell,
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
import { listCheckout, measureSiblings, registryOf } from './siblings.js';
import {
  type Lease,
  type LeaseSource,
  type LeaseState,
  LeaseStore,
  pidAlive,
} from './store.js';

/** What the watcher reads and runs: the lease store, the host's memory, each lease's estimate, start and pm2 state, and its clock. */
export interface WatcherDeps {
  store: LeaseStore;
  memory(): Promise<HostMemory | null>;
  /** the head's estimate taken again, live: a sibling may have grown or gone since it was queued */
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

/** Whether the process running a lease's start is still there: a start admitted at once may not have its apps up yet. */
const starterAlive = (l: Lease): boolean =>
  l.child_pid !== null && pidAlive(l.child_pid);

/** A running lease whose apps all left pm2 or stopped holds nothing; a starting one without a live owner after `stuckMs` is over. */
async function reconcile(deps: WatcherDeps, stuckMs: number): Promise<void> {
  const { store } = deps;
  for (const l of store.list()) {
    try {
      if (l.state === 'running' && l.kind === 'start' && !starterAlive(l)) {
        const online = await deps.onlineApps(l);
        if (!l.apps.some((a) => online.has(a)))
          await moveIf(
            store,
            l.id,
            'running',
            'freed',
            { error: 'no app online any more' },
            (cur) => !starterAlive(cur)
          );
      }
      if (
        l.state === 'starting' &&
        l.admitted_at &&
        deps.now() - Date.parse(l.admitted_at) > stuckMs
      ) {
        const owner = l.kind === 'start' ? l.child_pid : l.requester_pid;
        if (!owner || !pidAlive(owner))
          await moveIf(store, l.id, 'starting', 'failed', {
            error: `the start did not answer within ${stuckMs / 1000} s`,
          });
      }
    } catch (e) {
      deps.log(`error: ${l.id}: ${describeError(e)}`);
    }
  }
}

/**
 * One judgement of the head: admitted (and, for a start, run to its end), still waiting (its reason recorded), or
 * changed under the watcher (cancelled meanwhile, or cancelled now because it can never fit), so the next head is
 * judged at once.
 */
async function judgeHead(
  deps: WatcherDeps,
  head: Lease
): Promise<'admitted' | 'waiting' | 'changed'> {
  const { store } = deps;
  let memory: HostMemory | null;
  let est: Awaited<ReturnType<WatcherDeps['estimate']>>;
  try {
    memory = await deps.memory();
    est = await deps.estimate(head);
  } catch (e) {
    // its checkout cannot be read now: the reason shows in `leases`, the next tick tries again
    const why = `cannot estimate: ${describeError(e)}`;
    if (head.waiting_for !== why) {
      deps.log(`${head.id}: ${why}`);
      await store
        .withLock(() =>
          store.patch(head.id, { waiting_for: why }, { expect: 'pending' })
        )
        .catch(() => undefined);
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
    // under the lock and only while still pending: a cancel that landed meanwhile must not be written over
    await store
      .withLock(() =>
        store.patch(
          head.id,
          { ...est, waiting_for: d.waiting_for },
          { expect: 'pending' }
        )
      )
      .catch(() => undefined);
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
 * reconciled. Exits once nothing has been pending or starting for `idleExitMs` (leaving the exit note, see
 * leaveIdle); a starting lease without a live owner for `stuckMs` is failed. A tick that throws is logged, not fatal.
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
  const unwatch = deps.watch?.(() => tick?.abort());
  try {
    for (;;) {
      if (opts.signal?.aborted) return 'aborted';
      try {
        await store.withLock(() => store.prune());
      } catch (e) {
        deps.log(`error: prune: ${describeError(e)}`);
      }
      await reconcile(deps, stuckMs);
      const starting = store.list().some((l) => l.state === 'starting');
      const head = store.head();
      const now = deps.now();
      if (!head && !starting) {
        if (now - idleSince >= idleExitMs) {
          if (await leaveIdle(deps)) return 'idle';
          // a start queued in the moment before the exit: it is taken first
          idleSince = now;
          continue;
        }
      } else idleSince = now;
      if (head && !starting) {
        let r: 'admitted' | 'waiting' | 'changed' = 'waiting';
        try {
          r = await judgeHead(deps, head);
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
      tick = new AbortController();
      const onAbort = () => tick?.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      await deps.sleep(tickMs, tick.signal);
      opts.signal?.removeEventListener('abort', onAbort);
      tick = null;
    }
  } finally {
    unwatch?.();
  }
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

/** The real deps of the pm2-managed watcher: the state directory's store, the host's meminfo, each lease's checkout for its estimate and pm2 state, the CLI entry for the child starts. */
export function defaultWatcherDeps(dir: string, entry: string): WatcherDeps {
  const store = new LeaseStore(dir);
  const host = localHost(dir);
  const transport = createTransport(host);
  const ctxOf = async (l: Lease) => connect(prepare({ project: l.root }));
  return {
    store,
    memory: () => readHostMemory(transport, host),
    estimate: async (l) => {
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
    runStart: (l) =>
      new Promise<void>((resolve, reject) => {
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
      }),
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
}

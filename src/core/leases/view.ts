import fs from 'node:fs';
import { McprocError } from '../errors.js';
import type { Manifest } from '../manifest.js';
import { readHostMemory, type HostMemory } from '../memory.js';
import type { Pm2Process } from '../pm2.js';
import type { Context } from '../resolve.js';
import { stateDir } from '../state.js';
import { WATCHER_NAME, WATCHER_NS } from './ensure.js';
import {
  groupReason,
  groupWait,
  holderNote,
  memoryPosition,
  type GroupWait,
} from './queue.js';
import { LeaseStore, type Lease } from './store.js';

/** The host's queue as `leases` shows it: the state directory, the memory reading, the watcher and every lease. */
export interface LeasesView {
  state_dir: string;
  /** the host's memory; null without a local context or where there is no reading */
  memory: HostMemory | null;
  /** the watcher's pm2 process; null without a local context */
  watcher: { online: boolean; pid: number | null } | null;
  /**
   * oldest first, each with its 1-based position in the memory queue (0 when not in it), what it waits for in its
   * group (null when it does not), and the reason shown for it: what it waits for in its group, or, for a holder, how
   * long and by whom it holds it (null otherwise)
   */
  leases: (Lease & {
    position: number;
    group: GroupWait | null;
    reason: string | null;
  })[];
}

/**
 * The host's queue as `leases` shows it: every lease with its position, its group's wait or hold (all from one
 * listing, ages as of `now`), the memory reading and the watcher's state when a context is given. A read never fails
 * on the extras: the prune is skipped when the lease lock cannot be taken, and the memory or the watcher is null when
 * meminfo or pm2's list does not answer.
 */
export async function leasesView(
  dir = stateDir(),
  ctx?: Context,
  now = Date.now()
): Promise<LeasesView> {
  const store = new LeaseStore(dir);
  // a host that never queued anything keeps no state directory: the read does not make one
  if (fs.existsSync(store.dir))
    await store
      .withLock(() => store.prune())
      .catch(() => {
        /* the lock is busy: the ended leases are pruned by a later read or the watcher */
      });
  const all = store.list();
  const leases = all.map((l) => {
    const group = groupWait(all, l);
    const holds =
      l.exclusive !== null && (l.state === 'starting' || l.state === 'running');
    return {
      ...l,
      position: memoryPosition(all, l.id),
      group,
      reason: group
        ? groupReason(group, now)
        : holds
          ? holderNote(l, now)
          : null,
    };
  });
  let memory: HostMemory | null = null;
  let watcher: LeasesView['watcher'] = null;
  if (ctx?.host.local) {
    memory = await readHostMemory(ctx.transport, ctx.host).catch(() => null);
    watcher = await ctx.pm2.jlist().then(watcherIn, () => null);
  }
  return { state_dir: dir, memory, watcher, leases };
}

/** The watcher's state in a pm2 list: online or not, and its pid (null when it has none). */
export function watcherIn(procs: Pm2Process[]): {
  online: boolean;
  pid: number | null;
} {
  const w = procs.find(
    (p) => p.name === WATCHER_NAME && p.namespace === WATCHER_NS
  );
  return {
    online: Boolean(w && w.status === 'online'),
    pid: w && w.pid > 0 ? w.pid : null,
  };
}

/** A lease that covers apps not running yet, as ls and wait show it: queued (its position) or starting. */
export interface LeaseView {
  id: string;
  state: 'pending' | 'starting';
  /** 1-based place in the queue, the starting leases counted ahead; 0 for a starting lease */
  position: number;
  waiting_for: string | null;
  apps: string[];
}

/**
 * The pending and starting leases of one checkout, with their queue positions: what ls and wait show for apps that are
 * not running yet; none when the lease directory cannot be read (its permissions, a file in its place).
 */
export function leasesCovering(
  dir: string,
  m: Pick<Manifest, 'root' | 'project'>
): LeaseView[] {
  const store = new LeaseStore(dir);
  try {
    return store
      .list()
      .filter(
        (l): l is Lease & { state: 'pending' | 'starting' } =>
          (l.state === 'pending' || l.state === 'starting') &&
          l.root === m.root &&
          l.project === m.project
      )
      .map((l) => ({
        id: l.id,
        state: l.state,
        position: store.positionOf(l.id),
        waiting_for: l.waiting_for,
        apps: l.apps,
      }));
  } catch {
    // the queue's bookkeeping must not fail ls, monit or wait: the apps are shown as pm2 has them
    return [];
  }
}

/**
 * Cancels a pending lease, or a starting exec lease (it has no child to end: its owner's wait ends on the cancel); a
 * starting start or an ended lease is refused (LEASE_NOT_PENDING).
 */
export function cancelLease(id: string, dir = stateDir()): Promise<Lease> {
  const store = new LeaseStore(dir);
  return store.withLock(() => {
    const l = store.get(id);
    // the store lets a starting lease be cancelled (a stop does that, ending its child); a request may only end a
    // starting exec, which has no child
    if (
      l &&
      l.state !== 'pending' &&
      !(l.state === 'starting' && l.kind === 'exec')
    )
      throw new McprocError(
        'LEASE_NOT_PENDING',
        `lease ${id} is ${l.state}, only a pending lease or a starting exec can be cancelled`,
        {
          hint:
            l.kind !== 'exec'
              ? 'Stop its target to end a starting or running start.'
              : l.state === 'running'
                ? 'A running exec frees its lease when its command exits: wait for it to end.'
                : 'The exec has ended: there is nothing left to cancel.',
        }
      );
    return store.transition(id, 'cancelled', {
      error: 'cancelled by request',
    });
  });
}

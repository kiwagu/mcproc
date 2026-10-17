import fs from 'node:fs';
import { McprocError } from '../errors.js';
import { readHostMemory, type HostMemory } from '../memory.js';
import type { Context } from '../resolve.js';
import { stateDir } from '../state.js';
import { WATCHER_NAME, WATCHER_NS } from './ensure.js';
import { LeaseStore, type Lease } from './store.js';

/** The host's queue as `leases` shows it: the state directory, the memory reading, the watcher and every lease. */
export interface LeasesView {
  state_dir: string;
  /** the host's memory; null without a local context or where there is no reading */
  memory: HostMemory | null;
  /** the watcher's pm2 process; null without a local context */
  watcher: { online: boolean; pid: number | null } | null;
  /** oldest first, each with its 1-based position among the pending ones (0 when not pending) */
  leases: (Lease & { position: number })[];
}

/** The host's queue as `leases` shows it: every lease with its position, the memory reading and the watcher's state when a context is given. */
export async function leasesView(
  dir = stateDir(),
  ctx?: Context
): Promise<LeasesView> {
  const store = new LeaseStore(dir);
  // a host that never queued anything keeps no state directory: the read does not make one
  if (fs.existsSync(store.dir)) await store.withLock(() => store.prune());
  const leases = store
    .list()
    .map((l) => ({ ...l, position: store.positionOf(l.id) }));
  let memory: HostMemory | null = null;
  let watcher: LeasesView['watcher'] = null;
  if (ctx?.host.local) {
    memory = await readHostMemory(ctx.transport, ctx.host);
    const w = (await ctx.pm2.jlist()).find(
      (p) => p.name === WATCHER_NAME && p.namespace === WATCHER_NS
    );
    watcher = {
      online: Boolean(w && w.status === 'online'),
      pid: w && w.pid > 0 ? w.pid : null,
    };
  }
  return { state_dir: dir, memory, watcher, leases };
}

/** Cancels a pending lease; a starting or ended one is refused (LEASE_NOT_PENDING). */
export function cancelLease(id: string, dir = stateDir()): Promise<Lease> {
  const store = new LeaseStore(dir);
  return store.withLock(() => {
    const l = store.get(id);
    // the store lets a starting lease be cancelled (a stop does that, ending its child); a request may not
    if (l && l.state !== 'pending')
      throw new McprocError(
        'LEASE_NOT_PENDING',
        `lease ${id} is ${l.state}, only a pending lease can be cancelled`,
        {
          hint: 'Stop its target to end a starting or running lease.',
        }
      );
    return store.transition(id, 'cancelled', {
      error: 'cancelled by request',
    });
  });
}

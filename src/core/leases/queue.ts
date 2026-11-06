import { McprocError } from '../errors.js';
import { fmtUptime } from '../sizes.js';
import type { Lease } from './store.js';

/**
 * The queue's rules over one listing of the leases (in sequence order): who holds an exclusive group, who waits for
 * it, and which leases wait for memory. A group has one holder at a time, host-wide; a lease waiting for its group
 * never holds the memory queue, and gets its place back by its sequence once its group frees.
 */

/** What an exclusive group may be called: 1-64 letters, digits, dots, dashes and underscores, from a letter or digit. */
export const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Refuses a group name GROUP_NAME does not take (BAD_ARGUMENT); `:` is kept for a later "N at a time" form. */
export function assertGroupName(name: string): void {
  if (name.includes(':'))
    throw new McprocError(
      'BAD_ARGUMENT',
      `exclusive group "${name}": ":" is reserved`,
      {
        hint: 'One holder per group is all this version supports; name the group without ":".',
      }
    );
  if (!GROUP_NAME.test(name))
    throw new McprocError(
      'BAD_ARGUMENT',
      `exclusive group "${name}" must match ${GROUP_NAME.source}`,
      {
        hint: 'Use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit.',
      }
    );
}

/** A lease that waits for its group alone: an exclusive exec that named no memory. */
export const groupOnly = (l: Lease): boolean =>
  l.exclusive !== null && l.need_mib === 0;

const holds = (l: Lease, group: string): boolean =>
  l.exclusive === group && (l.state === 'starting' || l.state === 'running');

/** The lease that holds the group now (starting or running), or null. */
export function holderOf(all: Lease[], group: string): Lease | null {
  return all.find((l) => holds(l, group)) ?? null;
}

/** Whether a new lease of the group would have to wait: it has a holder, or members already waiting. */
export function groupBusy(all: Lease[], group: string): boolean {
  return all.some(
    (l) => l.exclusive === group && (l.state === 'pending' || holds(l, group))
  );
}

/** The pending members of the group, oldest first. */
const waiters = (all: Lease[], group: string): Lease[] =>
  all
    .filter((l) => l.exclusive === group && l.state === 'pending')
    .sort((a, b) => a.seq - b.seq);

/** Whether a pending lease waits for its group: it has a holder, or an older member waits before it. */
export function groupBlocked(all: Lease[], l: Lease): boolean {
  if (l.state !== 'pending' || l.exclusive === null) return false;
  if (holderOf(all, l.exclusive)) return true;
  return waiters(all, l.exclusive).some((o) => o.seq < l.seq);
}

/** The memory queue: the pending leases that wait for memory, by sequence (neither group-only nor group-blocked). */
export function memoryQueue(all: Lease[]): Lease[] {
  return all
    .filter(
      (l) => l.state === 'pending' && !groupOnly(l) && !groupBlocked(all, l)
    )
    .sort((a, b) => a.seq - b.seq);
}

/** The starting leases that claim memory: they are ahead of every waiting one. */
const startingClaims = (all: Lease[]): number =>
  all.filter((l) => l.state === 'starting' && !groupOnly(l)).length;

/** How many leases a new one that claims memory would be behind: the starting claims and the memory queue. */
export function aheadOf(all: Lease[]): number {
  return startingClaims(all) + memoryQueue(all).length;
}

/** The 1-based place of a lease in the memory queue, the starting claims counted ahead; 0 when it is not in it. */
export function memoryPosition(all: Lease[], id: string): number {
  const i = memoryQueue(all).findIndex((l) => l.id === id);
  return i < 0 ? 0 : startingClaims(all) + i + 1;
}

/** Why a lease waits for its group: its 1-based place among the group's waiters, and the holder or the waiter before. */
export interface GroupWait {
  name: string;
  place: number;
  /** the lease that holds the group now */
  holder: Lease | null;
  /** with no holder: the oldest waiter, which takes the group next */
  before: Lease | null;
}

/** What a group-blocked lease waits for, or null when it does not wait for its group. */
export function groupWait(all: Lease[], l: Lease): GroupWait | null {
  if (!groupBlocked(all, l) || l.exclusive === null) return null;
  const queue = waiters(all, l.exclusive);
  const holder = holderOf(all, l.exclusive);
  return {
    name: l.exclusive,
    place: queue.findIndex((o) => o.id === l.id) + 1,
    holder,
    before: holder ? null : (queue[0] ?? null),
  };
}

/** How long a lease has held (or waited), from when it ran, else was admitted, else queued. */
const ageOf = (l: Lease, now: number): string =>
  fmtUptime(
    Math.max(0, now - Date.parse(l.running_at ?? l.admitted_at ?? l.queued_at))
  );

/** The reason a group-blocked lease shows: `group <g>: held by <id> (<project>[ slot N], pid P, <age>), #N in group`. */
export function groupReason(w: GroupWait, now: number): string {
  const place = `#${w.place} in group`;
  if (w.holder) {
    const h = w.holder;
    return `group ${w.name}: held by ${h.id} (${h.project}${h.slot !== null ? ` slot ${h.slot}` : ''}, pid ${h.requester_pid}, ${ageOf(h, now)}), ${place}`;
  }
  const b = w.before;
  const why = b && groupOnly(b) ? 'taking its turn' : 'needs memory';
  return `group ${w.name}: behind ${b?.id ?? '?'} (${why}), ${place}`;
}

/** What a group's holder shows: `holds <g> <age>, pid P[, command C]`. */
export function holderNote(l: Lease, now: number): string {
  return `holds ${l.exclusive} ${ageOf(l, now)}, pid ${l.requester_pid}${l.command_pid !== null ? `, command ${l.command_pid}` : ''}`;
}

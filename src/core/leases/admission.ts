import type { App, Resources } from '../manifest.js';
import { RESERVE_DEFAULT_MIB } from '../manifest.js';
import type { HostMemory } from '../memory.js';
import { fmtMib } from '../sizes.js';
import type { LeaseSource } from './store.js';

/** What a running sibling slot showed for an app: its resident set plus containers, in MiB, and which slot. */
export interface AppMeasure {
  mib: number;
  slot: number;
}

/** The estimate of starting `apps`: per app the larger of a running sibling's measurement and the declared memory, else nothing. */
export function estimateApps(
  apps: App[],
  measured: Map<string, AppMeasure>
): { estimate_mib: number; sources: Record<string, LeaseSource> } {
  const sources: Record<string, LeaseSource> = {};
  let estimate_mib = 0;
  for (const a of apps) {
    const m = measured.get(a.name);
    const declared = a.memory_mib ?? 0;
    // the larger of the two: a sibling that grew past its declaration counts as it is, and a measurement that
    // missed its containers (docker stats answered nothing) never undercuts what the manifest declares
    const src: LeaseSource =
      m && m.mib > 0 && m.mib >= declared
        ? { mib: m.mib, source: `measured from slot ${m.slot}` }
        : declared > 0
          ? { mib: declared, source: 'declared' }
          : { mib: 0, source: 'none' };
    sources[a.name] = src;
    estimate_mib += src.mib;
  }
  return { estimate_mib, sources };
}

/** The estimate with the safety margin on top, rounded up. */
export const needOf = (estimate_mib: number, margin: number): number =>
  Math.ceil(estimate_mib * (1 + margin));

/** The reserve in MiB: as declared, or a percent of the host's total; the default when a percent has no reading to apply to. */
export function reserveMib(
  reserve: Resources['reserve'],
  memory: HostMemory | null
): number {
  if (reserve.kind === 'mib') return reserve.mib;
  return memory
    ? Math.ceil(memory.total_mib * reserve.ratio)
    : RESERVE_DEFAULT_MIB;
}

/** Whether a lease may run now, and when not, why and how much memory the host had over the reserve. */
export type Admission =
  | { ok: true; free_mib: number | null }
  | {
      ok: false;
      reason: 'never' | 'queue' | 'memory';
      waiting_for: string;
      free_mib: number | null;
    };

/**
 * Whether a lease may run now: not when it can never fit the host, not while others are ahead of it (strict FIFO),
 * and only when what the host can give minus the reserve covers the need. Without a memory reading only the queue counts.
 */
export function admit(opts: {
  ahead: number;
  memory: HostMemory | null;
  need_mib: number;
  reserve_mib: number;
}): Admission {
  const { memory, need_mib, reserve_mib } = opts;
  const free_mib = memory ? memory.available_mib - reserve_mib : null;
  if (memory && need_mib > memory.total_mib - reserve_mib)
    return {
      ok: false,
      reason: 'never',
      waiting_for: `needs ${fmtMib(need_mib)} but the host has at most ${fmtMib(memory.total_mib - reserve_mib)} over the reserve`,
      free_mib,
    };
  if (opts.ahead > 0)
    return {
      ok: false,
      reason: 'queue',
      waiting_for: `${opts.ahead} ahead in the queue`,
      free_mib,
    };
  if (free_mib !== null && free_mib < need_mib)
    return {
      ok: false,
      reason: 'memory',
      waiting_for: `needs ${fmtMib(need_mib)}, host has ${fmtMib(Math.max(0, free_mib))} over the reserve (${fmtMib(need_mib - free_mib)} short)`,
      free_mib,
    };
  return { ok: true, free_mib };
}

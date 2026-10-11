import type { Listener } from './ports.js';
import type { ProcStats, StatSample } from './stats.js';

export interface TreeMetrics { memory: number; cpu: number | null; procs: number; runtime: string | null; metrics_source: 'tree' | 'pm2-root' }

/** Percent of one core used by the tree between two samples; pids absent from either sample contribute nothing. */
export function cpuPercent(pids: Set<number>, before: StatSample, after: StatSample, clkTck: number, intervalSec: number): number {
  let delta = 0;
  for (const pid of pids) {
    const a = before.ticks.get(pid);
    const b = after.ticks.get(pid);
    if (a !== undefined && b !== undefined && b >= a) delta += b - a;
  }
  if (intervalSec <= 0 || clkTck <= 0) return 0;
  return (delta / clkTck / intervalSec) * 100;
}

export function shortCommand(args: string): string {
  const [argv0, ...rest] = args.trim().split(/\s+/);
  return [argv0.includes('/') ? argv0.slice(argv0.lastIndexOf('/') + 1) : argv0, ...rest].join(' ');
}

const INLINE_INTERVAL_SEC = 0.5; // the `sleep 0.5` between the probe's two samples

export function treeMetrics(pids: Set<number>, stats: ProcStats, listeners: Listener[], opts: { prev?: StatSample; intervalSec?: number } = {}): TreeMetrics | null {
  if (stats.samples.length === 0) return null;
  let memory = 0;
  let biggest: { pid: number; kb: number } | null = null;
  for (const pid of pids) {
    const kb = stats.rssKb.get(pid) ?? 0;
    memory += kb * 1024;
    if (!biggest || kb > biggest.kb) biggest = { pid, kb };
  }
  let cpu: number | null = null;
  if (stats.samples.length >= 2) cpu = cpuPercent(pids, stats.samples[0], stats.samples[1], stats.clkTck, INLINE_INTERVAL_SEC);
  else if (opts.prev && opts.intervalSec) cpu = cpuPercent(pids, opts.prev, stats.samples[0], stats.clkTck, opts.intervalSec);
  if (pids.size === 0) cpu = 0;
  const holder = listeners.find((l) => l.pids.some((p) => pids.has(p)))?.pids.find((p) => pids.has(p));
  const runtimePid = holder ?? biggest?.pid;
  const args = runtimePid !== undefined ? stats.args.get(runtimePid) : undefined;
  return { memory, cpu, procs: pids.size, runtime: args ? shortCommand(args) : null, metrics_source: 'tree' };
}

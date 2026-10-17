import type { Host } from './manifest.js';
import { MARK, MEM_SNIPPET } from '../shell/snippets.js';
import { ensureOk } from '../transport/index.js';
import type { Transport } from '../transport/types.js';

/** What the host has and what it can still give, in MiB, from /proc/meminfo. */
export interface HostMemory {
  total_mib: number;
  available_mib: number;
}

const KB = 1024;

/** The MemTotal and MemAvailable lines of /proc/meminfo (kB) as MiB; null when either is missing. */
export function parseMeminfo(text: string): HostMemory | null {
  let total: number | null = null;
  let available: number | null = null;
  for (const raw of text.split('\n')) {
    const m = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB/.exec(raw.trim());
    if (!m) continue;
    const mib = Math.floor(Number(m[2]) / KB);
    if (m[1] === 'MemTotal') total = mib;
    else available = mib;
  }
  return total !== null && available !== null
    ? { total_mib: total, available_mib: available }
    : null;
}

const UNIT_MIB: Record<string, number> = {
  B: 1 / (KB * KB),
  KB: 1 / KB,
  KIB: 1 / KB,
  MB: 1,
  MIB: 1,
  GB: KB,
  GIB: KB,
  TB: KB * KB,
  TIB: KB * KB,
};

/** `docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'` lines ("name\t27.06MiB / 31.09GiB") as MiB per container, rounded up. */
export function parseDockerStats(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of text.split('\n')) {
    const [name, usage] = raw.split('\t');
    const m = /^\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(usage ?? '');
    if (!name || !m) continue;
    const factor = UNIT_MIB[m[2].toUpperCase()];
    if (factor === undefined) continue;
    out.set(name.trim(), Math.ceil(Number(m[1]) * factor));
  }
  return out;
}

/** One small round trip for the host's memory alone, for the watcher between probes; null where there is no /proc/meminfo. */
export async function readHostMemory(
  transport: Transport,
  host: Host
): Promise<HostMemory | null> {
  const res = ensureOk(await transport.exec(MEM_SNIPPET), host, 'meminfo');
  const i = res.stdout.indexOf(MARK.MEM);
  return i < 0 ? null : parseMeminfo(res.stdout.slice(i + MARK.MEM.length));
}

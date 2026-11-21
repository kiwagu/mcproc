import type { Host } from './manifest.js';
import { MARK, MEM_READ_SNIPPET, MEM_STATUS } from '../shell/snippets.js';
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

/**
 * What the memory read printed: the reading; null where the host has no /proc/meminfo; an error saying why where it has
 * one that could not be read, or where the read did not run at all.
 */
export function memoryFrom(stdout: string): HostMemory | null {
  const i = stdout.indexOf(MARK.MEM);
  if (i < 0) throw new Error('the memory read printed nothing of its own');
  const text = stdout.slice(i + MARK.MEM.length);
  if (text.includes(MEM_STATUS.NONE)) return null;
  if (text.includes(MEM_STATUS.FAIL))
    throw new Error('/proc/meminfo could not be read');
  const memory = parseMeminfo(text);
  if (!memory)
    throw new Error('/proc/meminfo has no MemTotal and MemAvailable lines');
  return memory;
}

/** The host's memory for `leases`: null only where the host has no /proc/meminfo; a read that failed throws why. */
export async function readHostMemoryOrWhy(
  transport: Transport,
  host: Host
): Promise<HostMemory | null> {
  const res = ensureOk(await transport.read(MEM_READ_SNIPPET), host, 'meminfo');
  return memoryFrom(res.stdout);
}

/**
 * One small round trip for the host's memory alone, for the gate and the watcher between probes: null where there is
 * no reading, whatever the reason (no /proc/meminfo, or one that could not be read); only a failed transport throws.
 */
export async function readHostMemory(
  transport: Transport,
  host: Host
): Promise<HostMemory | null> {
  const res = ensureOk(await transport.read(MEM_READ_SNIPPET), host, 'meminfo');
  try {
    return memoryFrom(res.stdout);
  } catch {
    return null;
  }
}

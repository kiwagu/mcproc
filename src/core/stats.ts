export interface StatSample { ticks: Map<number, number>; ppid: Map<number, number> }
export interface ProcStats { clkTck: number; samples: StatSample[]; rssKb: Map<number, number>; args: Map<number, string>; dockerPorts: Map<number, string> }

export const EMPTY_STATS: ProcStats = { clkTck: 100, samples: [], rssKb: new Map(), args: new Map(), dockerPorts: new Map() };

/** "CLK <n>" then "pid ppid ticks" lines (awk over /proc/[0-9]*\/stat); anything else is ignored. */
export function parseStat(text: string): { clkTck: number; sample: StatSample } {
  let clkTck = 100;
  const ticks = new Map<number, number>();
  const ppid = new Map<number, number>();
  for (const raw of text.split('\n')) {
    const t = raw.trim().split(/\s+/);
    if (t[0] === 'CLK' && /^\d+$/.test(t[1] ?? '')) { clkTck = Number(t[1]); continue; }
    if (t.length === 3 && t.every((x) => /^\d+$/.test(x))) { ticks.set(Number(t[0]), Number(t[2])); ppid.set(Number(t[0]), Number(t[1])); }
  }
  return { clkTck, sample: { ticks, ppid } };
}

export function parseRss(text: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const raw of text.split('\n')) {
    const [pid, kb] = raw.trim().split(/\s+/);
    if (/^\d+$/.test(pid ?? '') && /^\d+$/.test(kb ?? '')) m.set(Number(pid), Number(kb));
  }
  return m;
}

/** `ps -eo pid=,args=` (GNU, no header) or busybox `ps -o pid,args` (with a header line). */
export function parseArgs(text: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const raw of text.split('\n')) {
    const r = /^\s*(\d+)\s+(.*)$/.exec(raw);
    if (r) m.set(Number(r[1]), r[2].trim());
  }
  return m;
}

/** `docker ps --format '{{.Names}}\t{{.Ports}}'`: every "host:port->" pair maps the host port to the container. */
export function parseDockerPorts(text: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const raw of text.split('\n')) {
    const [name, ports] = raw.split('\t');
    if (!name || !ports) continue;
    for (const hit of ports.matchAll(/:(\d+)->/g)) m.set(Number(hit[1]), name.trim());
  }
  return m;
}

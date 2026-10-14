import type { App } from './manifest.js';
import { findProcess, type Pm2Process } from './pm2.js';
import { MARK } from '../shell/snippets.js';
import { isZone } from './logsince.js';
import {
  EMPTY_STATS,
  parseArgs,
  parseDockerPorts,
  parseRss,
  parseStat,
  type ProcStats,
} from './stats.js';

export interface Listener {
  proto: 'tcp' | 'udp';
  addr: string;
  port: number;
  pid: number | null;
  pids: number[];
  command: string | null;
  container: string | null;
}
export interface ProbeData {
  jlistRaw: string;
  jlistRc: number;
  tree: Map<number, number>;
  listeners: Listener[];
  stats: ProcStats;
  urls: Map<string, number | null>;
  /** the host's UTC offset as `date +%z` prints it ('+0200', '-0330'); null when the section is absent or garbled */
  zone: string | null;
}
export interface PortCheck {
  port: number;
  status: 'listening' | 'declared-not-listening';
  held_by?: {
    pid: number | null;
    command: string | null;
    app?: string;
    container?: string;
  };
}
export interface AppPorts {
  actual: Listener[];
  declared: number[];
  checks: PortCheck[];
  undeclared: number[];
}

export function splitAddr(s: string): { addr: string; port: number } {
  const i = s.lastIndexOf(':');
  return {
    addr: s.slice(0, i).replace(/^\[|\]$/g, ''),
    port: Number(s.slice(i + 1)),
  };
}

export function parsePs(text: string): Map<number, number> {
  const tree = new Map<number, number>();
  for (const raw of text.split('\n')) {
    const [pid, ppid] = raw.trim().split(/\s+/);
    if (/^\d+$/.test(pid ?? '') && /^\d+$/.test(ppid ?? ''))
      tree.set(Number(pid), Number(ppid));
  }
  return tree;
}

export function parseSs(text: string, proto: 'tcp' | 'udp'): Listener[] {
  const out: Listener[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    if (tok.length < 5) continue;
    const { addr, port } = splitAddr(tok[3]);
    if (!Number.isInteger(port) || port <= 0) continue;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((h) => Number(h[1]));
    const cmd = /users:\(\("([^"]*)"/.exec(line);
    out.push({
      proto,
      addr,
      port,
      pid: pids[0] ?? null,
      pids,
      command: cmd ? cmd[1] : null,
      container: null,
    });
  }
  return out;
}

export function hexToIp(hex: string): string {
  if (hex.length === 8) {
    return [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
  }
  if (hex.length === 32) {
    const groups: string[] = [];
    for (let w = 0; w < 4; w++) {
      const word = hex.slice(w * 8, w * 8 + 8);
      const bytes = [6, 4, 2, 0].map((i) => word.slice(i, i + 2));
      groups.push(
        (bytes[0] + bytes[1]).toLowerCase(),
        (bytes[2] + bytes[3]).toLowerCase()
      );
    }
    if (groups.every((g) => g === '0000')) return '::';
    return groups.map((g) => g.replace(/^0+(?=\w)/, '')).join(':');
  }
  return hex;
}

export function parseProcNet(
  text: string,
  proto: 'tcp' | 'udp'
): { addr: string; port: number; inode: number }[] {
  const want = proto === 'tcp' ? '0A' : '07';
  const out: { addr: string; port: number; inode: number }[] = [];
  for (const raw of text.split('\n')) {
    const tok = raw.trim().split(/\s+/);
    if (tok.length < 10 || !/^\d+:$/.test(tok[0]) || tok[3] !== want) continue;
    const [a, p] = tok[1].split(':');
    out.push({
      addr: hexToIp(a),
      port: parseInt(p, 16),
      inode: Number(tok[9]),
    });
  }
  return out;
}

export function parseFdMap(text: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const raw of text.split('\n')) {
    const [pid, inode] = raw.trim().split(/\s+/);
    if (/^\d+$/.test(pid ?? '') && /^\d+$/.test(inode ?? ''))
      m.set(Number(inode), Number(pid));
  }
  return m;
}

/** "<url>\t<code>" lines of the probe's URL section: the HTTP status, 0 when nothing answered, null when the host has neither curl nor wget. */
export function parseUrlChecks(text: string): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const raw of text.split('\n')) {
    const [url, code] = raw.split('\t');
    if (!url || code === undefined) continue;
    m.set(url, /^\d{3}$/.test(code.trim()) ? Number(code) : null);
  }
  return m;
}

function sections(stdout: string, marks: string[]): Record<string, string> {
  const lines = stdout.split('\n');
  const idx = marks.map((m) => lines.findIndex((l) => l.trim() === m));
  const out: Record<string, string> = {};
  marks.forEach((m, k) => {
    const start = idx[k];
    if (start < 0) {
      out[m] = '';
      return;
    }
    const next = idx.slice(k + 1).find((i) => i > start) ?? lines.length;
    out[m] = lines.slice(start + 1, next).join('\n');
  });
  return out;
}

/** The clock section's `date +%z`; null when it is absent or not a real offset, as logs since reads a zone. */
const zoneOf = (section: string | undefined): string | null => {
  const z = (section ?? '').trim();
  return isZone(z) ? z : null;
};

export function parseProbe(stdout: string): ProbeData {
  const sec = sections(stdout, [
    MARK.JLIST,
    MARK.CLOCK,
    MARK.PS,
    MARK.TCP,
    MARK.UDP,
    MARK.FD,
    MARK.STAT,
    MARK.STAT2,
    MARK.RSS,
    MARK.ARGS,
    MARK.DOCKER,
    MARK.URL,
  ]);
  const rc = new RegExp(`${MARK.JLIST_RC} (\\d+)`).exec(sec[MARK.JLIST]);
  const jlistRaw = sec[MARK.JLIST].replace(
    new RegExp(`${MARK.JLIST_RC} \\d+\\s*$`),
    ''
  );
  const tree = parsePs(sec[MARK.PS]);
  const fd = parseFdMap(sec[MARK.FD]);
  const listeners: Listener[] = [];
  for (const [proto, text] of [
    ['tcp', sec[MARK.TCP]],
    ['udp', sec[MARK.UDP]],
  ] as const) {
    if (text.trim().startsWith(MARK.PROC)) {
      for (const e of parseProcNet(text.replace(MARK.PROC, ''), proto))
        listeners.push({
          proto,
          addr: e.addr,
          port: e.port,
          pid: fd.get(e.inode) ?? null,
          pids: fd.has(e.inode) ? [fd.get(e.inode)!] : [],
          command: null,
          container: null,
        });
    } else {
      listeners.push(...parseSs(text, proto));
    }
  }
  const s1 = parseStat(sec[MARK.STAT]);
  const samples = [s1.sample];
  if (sec[MARK.STAT2].trim()) samples.push(parseStat(sec[MARK.STAT2]).sample);
  // docker-published ports do not depend on /proc: a host without stat samples (no tree metrics) still attributes them
  const dockerPorts = parseDockerPorts(sec[MARK.DOCKER]);
  const stats: ProcStats =
    s1.sample.ticks.size === 0
      ? { ...EMPTY_STATS, dockerPorts }
      : {
          clkTck: s1.clkTck,
          samples,
          rssKb: parseRss(sec[MARK.RSS]),
          args: parseArgs(sec[MARK.ARGS]),
          dockerPorts,
        };
  for (const l of listeners)
    if (l.pid === null) l.container = stats.dockerPorts.get(l.port) ?? null;
  return {
    jlistRaw,
    jlistRc: rc ? Number(rc[1]) : -1,
    tree,
    listeners,
    stats,
    urls: parseUrlChecks(sec[MARK.URL]),
    zone: zoneOf(sec[MARK.CLOCK]),
  };
}

export function descendants(
  tree: Map<number, number>,
  root: number
): Set<number> {
  const out = new Set<number>();
  if (root <= 0) return out;
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of tree) {
    const arr = children.get(ppid) ?? [];
    arr.push(pid);
    children.set(ppid, arr);
  }
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const c of children.get(p) ?? [])
      if (!out.has(c)) {
        out.add(c);
        queue.push(c);
      }
  }
  return out;
}

export function holderOf(
  listeners: Listener[],
  port: number,
  pidToApp: Map<number, string>
): PortCheck['held_by'] | undefined {
  const l =
    listeners.find((x) => x.port === port && x.proto === 'tcp') ??
    listeners.find((x) => x.port === port);
  if (!l) return undefined;
  const app = l.pids.map((p) => pidToApp.get(p)).find(Boolean);
  const base = {
    pid: l.pid,
    command: l.command,
    ...(l.container ? { container: l.container } : {}),
  };
  return app ? { ...base, app } : base;
}

/** pm2 root pid plus every descendant, per manifest app; an app without a running process gets an empty set. */
export function appPids(
  apps: Record<string, App>,
  procs: Pm2Process[],
  tree: Map<number, number>,
  project: string
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const app of Object.values(apps)) {
    const p = findProcess(procs, project, app.name);
    const set = p && p.pid > 0 ? descendants(tree, p.pid) : new Set<number>();
    if (p && p.pid > 0) set.add(p.pid);
    out.set(app.name, set);
  }
  return out;
}

export function joinPorts(
  apps: Record<string, App>,
  procs: Pm2Process[],
  data: ProbeData,
  project: string
): Record<string, AppPorts> {
  const pidsOf = appPids(apps, procs, data.tree, project);
  const pidToApp = new Map<number, string>();
  for (const [name, set] of pidsOf)
    for (const pid of set) pidToApp.set(pid, name);
  const result: Record<string, AppPorts> = {};
  for (const app of Object.values(apps)) {
    const pids = pidsOf.get(app.name)!;
    const actual = data.listeners.filter((l) =>
      l.pids.some((p) => pids.has(p))
    );
    const actualPorts = new Set(actual.map((l) => l.port));
    const checks: PortCheck[] = app.ports.map((port) => {
      if (actualPorts.has(port)) return { port, status: 'listening' };
      const held_by = holderOf(data.listeners, port, pidToApp);
      return held_by
        ? { port, status: 'declared-not-listening', held_by }
        : { port, status: 'declared-not-listening' };
    });
    const undeclared = [...actualPorts]
      .filter((p) => !app.ports.includes(p))
      .sort((a, b) => a - b);
    result[app.name] = { actual, declared: app.ports, checks, undeclared };
  }
  return result;
}

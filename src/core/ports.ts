import type { App } from './manifest.js';
import { findProcess, type Pm2Process } from './pm2.js';
import { MARK } from '../shell/snippets.js';

export interface Listener { proto: 'tcp' | 'udp'; addr: string; port: number; pid: number | null; command: string | null }
export interface ProbeData { jlistRaw: string; jlistRc: number; tree: Map<number, number>; listeners: Listener[] }
export interface PortCheck { port: number; status: 'listening' | 'declared-not-listening'; held_by?: { pid: number | null; command: string | null; app?: string } }
export interface AppPorts { actual: Listener[]; declared: number[]; checks: PortCheck[]; undeclared: number[] }

export function splitAddr(s: string): { addr: string; port: number } {
  const i = s.lastIndexOf(':');
  return { addr: s.slice(0, i).replace(/^\[|\]$/g, ''), port: Number(s.slice(i + 1)) };
}

export function parsePs(text: string): Map<number, number> {
  const tree = new Map<number, number>();
  for (const raw of text.split('\n')) {
    const [pid, ppid] = raw.trim().split(/\s+/);
    if (/^\d+$/.test(pid ?? '') && /^\d+$/.test(ppid ?? '')) tree.set(Number(pid), Number(ppid));
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
    const pid = /pid=(\d+)/.exec(line);
    const cmd = /users:\(\("([^"]*)"/.exec(line);
    out.push({ proto, addr, port, pid: pid ? Number(pid[1]) : null, command: cmd ? cmd[1] : null });
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
      groups.push((bytes[0] + bytes[1]).toLowerCase(), (bytes[2] + bytes[3]).toLowerCase());
    }
    if (groups.every((g) => g === '0000')) return '::';
    return groups.map((g) => g.replace(/^0+(?=\w)/, '')).join(':');
  }
  return hex;
}

export function parseProcNet(text: string, proto: 'tcp' | 'udp'): { addr: string; port: number; inode: number }[] {
  const want = proto === 'tcp' ? '0A' : '07';
  const out: { addr: string; port: number; inode: number }[] = [];
  for (const raw of text.split('\n')) {
    const tok = raw.trim().split(/\s+/);
    if (tok.length < 10 || !/^\d+:$/.test(tok[0]) || tok[3] !== want) continue;
    const [a, p] = tok[1].split(':');
    out.push({ addr: hexToIp(a), port: parseInt(p, 16), inode: Number(tok[9]) });
  }
  return out;
}

export function parseFdMap(text: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const raw of text.split('\n')) {
    const [pid, inode] = raw.trim().split(/\s+/);
    if (/^\d+$/.test(pid ?? '') && /^\d+$/.test(inode ?? '')) m.set(Number(inode), Number(pid));
  }
  return m;
}

function sections(stdout: string, marks: string[]): Record<string, string> {
  const lines = stdout.split('\n');
  const idx = marks.map((m) => lines.findIndex((l) => l.trim() === m));
  const out: Record<string, string> = {};
  marks.forEach((m, k) => {
    const start = idx[k];
    if (start < 0) { out[m] = ''; return; }
    const next = idx.slice(k + 1).find((i) => i > start) ?? lines.length;
    out[m] = lines.slice(start + 1, next).join('\n');
  });
  return out;
}

export function parseProbe(stdout: string): ProbeData {
  const sec = sections(stdout, [MARK.JLIST, MARK.PS, MARK.TCP, MARK.UDP, MARK.FD]);
  const rc = new RegExp(`${MARK.JLIST_RC} (\\d+)`).exec(sec[MARK.JLIST]);
  const jlistRaw = sec[MARK.JLIST].replace(new RegExp(`${MARK.JLIST_RC} \\d+\\s*$`), '');
  const tree = parsePs(sec[MARK.PS]);
  const fd = parseFdMap(sec[MARK.FD]);
  const listeners: Listener[] = [];
  for (const [proto, text] of [['tcp', sec[MARK.TCP]], ['udp', sec[MARK.UDP]]] as const) {
    if (text.trim().startsWith(MARK.PROC)) {
      for (const e of parseProcNet(text.replace(MARK.PROC, ''), proto)) listeners.push({ proto, addr: e.addr, port: e.port, pid: fd.get(e.inode) ?? null, command: null });
    } else {
      listeners.push(...parseSs(text, proto));
    }
  }
  return { jlistRaw, jlistRc: rc ? Number(rc[1]) : -1, tree, listeners };
}

export function descendants(tree: Map<number, number>, root: number): Set<number> {
  const out = new Set<number>();
  if (root <= 0) return out;
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of tree) { const arr = children.get(ppid) ?? []; arr.push(pid); children.set(ppid, arr); }
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const c of children.get(p) ?? []) if (!out.has(c)) { out.add(c); queue.push(c); }
  }
  return out;
}

export function holderOf(listeners: Listener[], port: number, pidToApp: Map<number, string>): PortCheck['held_by'] | undefined {
  const l = listeners.find((x) => x.port === port && x.proto === 'tcp') ?? listeners.find((x) => x.port === port);
  if (!l) return undefined;
  const app = l.pid !== null ? pidToApp.get(l.pid) : undefined;
  return app ? { pid: l.pid, command: l.command, app } : { pid: l.pid, command: l.command };
}

export function joinPorts(apps: Record<string, App>, procs: Pm2Process[], data: ProbeData, project: string): Record<string, AppPorts> {
  const pidsOf = new Map<string, Set<number>>();
  for (const app of Object.values(apps)) {
    const p = findProcess(procs, project, app.name);
    const set = p && p.pid > 0 ? descendants(data.tree, p.pid) : new Set<number>();
    if (p && p.pid > 0) set.add(p.pid);
    pidsOf.set(app.name, set);
  }
  const pidToApp = new Map<number, string>();
  for (const [name, set] of pidsOf) for (const pid of set) pidToApp.set(pid, name);
  const result: Record<string, AppPorts> = {};
  for (const app of Object.values(apps)) {
    const pids = pidsOf.get(app.name)!;
    const actual = data.listeners.filter((l) => l.pid !== null && pids.has(l.pid));
    const actualPorts = new Set(actual.map((l) => l.port));
    const checks: PortCheck[] = app.ports.map((port) => {
      if (actualPorts.has(port)) return { port, status: 'listening' };
      const held_by = holderOf(data.listeners, port, pidToApp);
      return held_by ? { port, status: 'declared-not-listening', held_by } : { port, status: 'declared-not-listening' };
    });
    const undeclared = [...actualPorts].filter((p) => !app.ports.includes(p)).sort((a, b) => a - b);
    result[app.name] = { actual, declared: app.ports, checks, undeclared };
  }
  return result;
}

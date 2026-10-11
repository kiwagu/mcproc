import type { LsRow, HostInfo } from '../core/list.js';
import type { DoctorReport } from '../core/doctor.js';
import type { AppPorts, Listener } from '../core/ports.js';
import type { LogsResult } from '../core/logs.js';

export function fmtUptime(ms: number | null): string {
  if (ms === null) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}
export function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)}K`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)}M`;
  return `${(b / 1024 ** 3).toFixed(2)}G`;
}
export function fmtPorts(p: AppPorts): string {
  const parts: string[] = [];
  for (const c of p.checks) {
    if (c.status === 'listening') parts.push(`:${c.port} ✓`);
    else if (c.held_by) {
      const who = c.held_by.app ? `app ${c.held_by.app}` : c.held_by.container ? `container ${c.held_by.container}` : c.held_by.pid !== null ? `pid ${c.held_by.pid}${c.held_by.command ? ` (${c.held_by.command})` : ''}` : "another user's process";
      parts.push(`:${c.port} ✗ held by ${who}`);
    } else parts.push(`:${c.port} ✗ nothing listens`);
  }
  for (const u of p.undeclared) parts.push(`:${u} (undeclared)`);
  return parts.length ? parts.join(', ') : '-';
}
export function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (c ?? '').padEnd(w[i])).join('  ').trimEnd()).join('\n');
}
export function fmtCpu(c: number | null): string { return c === null ? '-' : `${c.toFixed(1)}%`; }
export function cut(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
/** The declared url with its HTTP answer when one was requested; the bare url when not (monit's live screen never asks). */
export function fmtUrl(r: LsRow): string {
  if (!r.url) return '-';
  if (r.url_status === 'ok') return `${r.url} ✓ ${r.url_code}`;
  if (r.url_status === 'error') return `${r.url} ✗ ${r.url_code}`;
  if (r.url_status === 'down') return `${r.url} ✗ down`;
  return r.url;
}
export function renderLs(rows: LsRow[], host: string): string {
  return `host: ${host}\n` + table([
    ['APP', 'KIND', 'STATUS', 'PID', 'UPTIME', 'RESTARTS', 'MEM', 'CPU', 'PORTS', 'URL', 'RUNTIME', 'DESCRIPTION'],
    ...rows.map((r) => [r.app, r.kind, r.status, r.pid === null ? '-' : String(r.pid), fmtUptime(r.uptime_ms), String(r.restarts),
      r.memory ? fmtBytes(r.memory) : '-', r.status === 'online' ? fmtCpu(r.cpu) : '-', fmtPorts(r.ports), fmtUrl(r), r.runtime ? cut(r.runtime, 32) : '-', cut(r.description.split('\n')[0], 40)]),
  ]);
}
/** A port sampled right after start may simply not be bound yet; say so instead of letting "✗" read as a failure. */
export function startNote(rows: LsRow[]): string {
  const booting = rows.filter((r) => r.status === 'online' && r.ports.checks.some((c) => c.status === 'declared-not-listening' && !c.held_by));
  return booting.length ? `note: ${booting.map((r) => r.app).join(', ')} not listening yet; ports are sampled right after start, call ls again if the app is still booting` : '';
}

export function renderPorts(rep: { port: number | null; listeners: Array<Listener & { app: string | null }> }, host: string): string {
  if (rep.listeners.length === 0) return `host: ${host}\n${rep.port ? `nothing listens on port ${rep.port}` : 'no listening sockets visible'}`;
  return `host: ${host}\n` + table([['PROTO', 'ADDR', 'PORT', 'PID', 'COMMAND', 'APP', 'CONTAINER'], ...rep.listeners.map((l) => [l.proto, l.addr, String(l.port), l.pid === null ? '?' : String(l.pid), l.command ?? '?', l.app ?? '-', l.container ?? '-'])]);
}
export function renderHosts(info: HostInfo[]): string {
  return table([['HOST', 'TRANSPORT', 'CWD', 'READONLY', 'PM2_HOME'], ...info.map((h) => [h.name, h.transport, h.cwd, h.readonly ? 'yes' : 'no', h.pm2_home ?? '-'])]);
}
export function renderDoctor(reps: DoctorReport[]): string {
  return reps.map((r) => {
    const L = [`${r.host} (${r.transport}): ${r.reachable ? 'reachable' : `UNREACHABLE: ${r.error}`}`];
    if (r.reachable) {
      L.push(`  node: ${r.node ?? 'missing'}  tools: ps=${r.tools.ps} ss=${r.tools.ss} tar=${r.tools.tar}`);
      L.push(`  pm2: ${r.pm2 ? `${r.pm2.source} (${r.pm2.reason})${r.pm2.version ? ` ${r.pm2.version}` : ''}` : 'none'}  daemon: ${r.daemon}, ${r.processes} processes, ${r.in_namespace} in this project`);
      L.push(`  PM2_HOME: ${r.pm2_home ?? 'default (~/.pm2)'}  runtime: ${r.runtime_present ? r.runtime_dir : 'not unpacked'}`);
    }
    for (const rec of r.recommendations) L.push(`  → ${rec}`);
    return L.join('\n');
  }).join('\n');
}
export function renderLogs(l: LogsResult): string {
  const parts: string[] = [];
  if (l.out !== undefined) parts.push(`--- ${l.app} out (${l.paths.out}) ---\n${l.out}`);
  if (l.err !== undefined) parts.push(`--- ${l.app} err (${l.paths.err}) ---\n${l.err}`);
  return parts.join('\n');
}
export function renderProject(d: { project: string; root: string; apps: { name: string; kind: string; description: string; ports: number[]; url: string | null; depends_on: string[] }[]; profiles: Record<string, string[]>; hosts: HostInfo[]; readme: string | null }): string {
  const L = [`project: ${d.project} (${d.root})`, 'apps:'];
  for (const a of d.apps) L.push(`  ${a.name} [${a.kind}]${a.ports.length ? ` :${a.ports.join(',:')}` : ''}${a.url ? ` → ${a.url}` : ''}${a.depends_on.length ? ` after ${a.depends_on.join(',')}` : ''}: ${a.description}`);
  L.push('profiles:');
  for (const [p, apps] of Object.entries(d.profiles)) L.push(`  ${p}: ${apps.join(', ')}`);
  L.push('hosts:', renderHosts(d.hosts).split('\n').map((x) => '  ' + x).join('\n'));
  if (d.readme) L.push('', 'README:', d.readme.trim());
  return L.join('\n');
}

import type { LsRow } from '../core/list.js';
import { cut, fmtBytes, fmtCpu, fmtPorts, fmtUptime, fmtUrl, table } from '../mcp/render.js';
import { selectedRow, visibleLogs, type MonitState } from './state.js';

export interface Frame { header: string; table: string[]; logs: string[]; details: string[]; footer: string }

function portDetails(r: LsRow): string {
  if (r.ports.checks.length === 0 && r.ports.actual.length === 0) return 'none';
  const parts = r.ports.checks.map((c) => {
    if (c.status === 'listening') {
      const l = r.ports.actual.find((x) => x.port === c.port);
      return `:${c.port} ✓${l ? ` pid ${l.pid ?? '?'} ${l.command ?? ''}`.trimEnd() : ''}`;
    }
    const who = c.held_by ? (c.held_by.app ? `app ${c.held_by.app}` : c.held_by.container ? `container ${c.held_by.container}` : c.held_by.pid !== null ? `pid ${c.held_by.pid} ${c.held_by.command ?? ''}`.trimEnd() : "another user's process") : 'nothing listens';
    return `:${c.port} ✗ ${c.held_by ? 'held by ' : ''}${who}`;
  });
  for (const u of r.ports.undeclared) parts.push(`:${u} (undeclared)`);
  return parts.join(', ');
}

export function renderFrame(s: MonitState, size: { width: number; height: number }): Frame {
  const w = Math.max(40, size.width);
  const clock = s.updatedAt ? s.updatedAt.toTimeString().slice(0, 8) : '--:--:--';
  const header = cut(`mcproc · ${s.project} · ${s.host}${s.hosts.length > 1 ? ` (h: ${s.hosts.join('/')})` : ''}  ${clock}`, w);
  const tableLines = table([
    ['', 'APP', 'STATUS', 'UP', 'MEM', 'CPU', 'PORTS', 'URL', 'RUNTIME'],
    ...s.rows.map((r, i) => [i === s.selected ? '▶' : ' ', r.app, r.status, fmtUptime(r.uptime_ms), r.memory ? fmtBytes(r.memory) : '-', r.status === 'online' ? fmtCpu(r.cpu) : '-', cut(fmtPorts(r.ports), 22), cut(fmtUrl(r), 36), r.runtime ? cut(r.runtime, 40) : '-']),
  ]).split('\n').map((l) => cut(l.replace(/^(.)\s\s/, '$1'), w));
  const detailsH = 6;
  const logH = Math.max(3, size.height - 1 - tableLines.length - detailsH - 1 - 6);
  const logs = visibleLogs(s).slice(-logH).map((l) => cut(`${l.stream === 'err' ? '! ' : '  '}${l.text}`, w));
  const r = selectedRow(s);
  const a = r ? s.apps[r.app] : null;
  const details = r && a ? [
    cut(`${r.app} [${r.kind}] ${a.description.split('\n')[0]}`, w),
    cut(`run: ${a.run}   cwd: ${a.cwd}`, w),
    cut(`pm2: ${a.pm2Name}  pid ${r.pid ?? '-'}  restarts ${r.restarts}  procs ${r.procs ?? '?'}  mem ${r.memory ? fmtBytes(r.memory) : '-'} (RSS sum of the tree; pm2 root: ${fmtBytes(r.pm2_memory)})`, w),
    cut(`ports: ${portDetails(r)}`, w),
    cut(`url: ${fmtUrl(r)}`, w),
    cut(`logs: ${s.logPaths ? `${s.logPaths.out} | ${s.logPaths.err}` : '-'}`, w),
  ] : ['no app selected'];
  const keys = '↑↓ app  r restart  s start  x stop  o/e/b logs  h host  q quit';
  const right = s.error ? `ERROR: ${s.error}` : s.busy ? 'working…' : s.notice ?? '';
  const footer = cut(right ? `${right}  │ ${keys}` : keys, w); // the error or notice first: on a narrow terminal the key legend is what gets cut
  return { header, table: tableLines, logs, details, footer };
}

export function frameToText(f: Frame): string {
  return [f.header, '', ...f.table, '', 'logs:', ...f.logs, '', ...f.details, '', f.footer].join('\n');
}

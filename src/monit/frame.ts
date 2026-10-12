import type { LsRow } from '../core/list.js';
import { fmtBytes, fmtCpu, fmtPorts, fmtUptime, fmtUrl, table } from '../mcp/render.js';
import { selectedRow, visibleFlat, visibleLogs, type MonitState } from './state.js';
import { cutWidth as cut, displayWidth, screenText } from './screentext.js';

export interface Frame {
  header: string; table: string[]; logs: string[]; details: string[]; footer: string;
  /** entries hidden below the log pane as rendered, and the most that can be hidden with the pane still full */
  scroll: number; maxScroll: number;
}

/**
 * The log pane: the last `logH` rows of the entries not hidden below the view. Scrolling stops where the pane is still
 * full: `maxScroll` = entries beyond the leading ones that fill the pane, so the window never shrinks near the top.
 */
function pane<T>(entries: T[], scroll: number, logH: number, w: number, fmt: (e: T) => string, indent: number): { rows: string[]; scroll: number; maxScroll: number } {
  let rows = 0; let k = 0;
  while (k < entries.length && rows < logH) { rows += wrapText(fmt(entries[k]), w, indent).length; k++; }
  const maxScroll = Math.max(0, entries.length - k);
  const eff = Math.min(Math.max(0, scroll), maxScroll);
  const shown = entries.slice(0, entries.length - eff);
  return { rows: shown.slice(-logH).flatMap((e) => wrapText(fmt(e), w, indent)).slice(-logH), scroll: eff, maxScroll };
}

const PM2_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}: /;
/** A log line as screen text; pm2's time stamp stays even when carriage returns overwrote the text after it. */
function logText(text: string): string {
  const stamp = PM2_STAMP.exec(text)?.[0] ?? '';
  return stamp + screenText(text.slice(stamp.length));
}

/**
 * Hard-wraps one line of screen text at the width in terminal columns (a wide character is never split); continuation
 * rows are indented so the text stays under the text, not under the marker.
 */
export function wrapText(text: string, width: number, indent: number): string[] {
  if (width <= 0 || displayWidth(text) <= width) return [text];
  const pad = ' '.repeat(Math.min(indent, width - 1));
  const rows: string[] = [];
  let row = '';
  let w = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > width && row.length > pad.length) { rows.push(row); row = pad; w = pad.length; }
    row += ch;
    w += cw;
  }
  rows.push(row);
  return rows;
}

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
  // everything that comes from outside (logs, descriptions, commands, errors) is shown as screen text: see screentext.ts
  const right = screenText(s.error ? `ERROR: ${s.error}` : s.busy ? 'working…' : s.notice ?? '');
  if (s.view === 'flat') {
    // compose style: every app, label padded to the longest name, `|` stdout / `!` stderr, continuations under the text
    const label = Math.max(1, ...Object.keys(s.apps).map((a) => a.length));
    const logH = Math.max(3, size.height - 3); // header, the pane title, footer
    const p = pane(visibleFlat(s), s.logScroll, logH, w, (l) => `${l.app.padEnd(label)} ${l.stream === 'err' ? '!' : '|'} ${logText(l.text)}`, label + 3);
    const keys = '↑↓ scroll  f dashboard  o/e/b logs  h host  q quit';
    return { header, table: [], logs: p.rows, details: [], footer: cut(right ? `${right}  │ ${keys}` : keys, w), scroll: p.scroll, maxScroll: p.maxScroll };
  }
  const multi = new Set(s.rows.map((r) => r.host)).size > 1; // apps of several hosts on one screen: say where each runs
  const tableLines = table([
    ['', 'APP', ...(multi ? ['HOST'] : []), 'STATUS', 'UP', 'MEM', 'CPU', 'PORTS', 'URL', 'RUNTIME'],
    ...s.rows.map((r, i) => [i === s.selected ? '▶' : ' ', r.app, ...(multi ? [r.host] : []), r.status, fmtUptime(r.uptime_ms), r.memory ? fmtBytes(r.memory) : '-', r.status === 'online' ? fmtCpu(r.cpu) : '-', cut(screenText(fmtPorts(r.ports)), 22), cut(screenText(fmtUrl(r)), 36), r.runtime ? cut(screenText(r.runtime), 40) : '-']),
  ]).split('\n').map((l) => cut(l.replace(/^(.)\s\s/, '$1'), w));
  const detailsH = 6;
  const logH = Math.max(3, size.height - 1 - tableLines.length - 3 - detailsH - 1); // 3: one title rule per pane, no frames
  const p = pane(visibleLogs(s), s.logScroll, logH, w, (l) => `${l.stream === 'err' ? '! ' : '  '}${logText(l.text)}`, 2);
  const logs = p.rows;
  const r = selectedRow(s);
  const a = r ? s.apps[r.app] : null;
  const details = r && a ? [
    cut(screenText(`${r.app} [${r.kind}] ${a.description.split('\n')[0]}`), w),
    cut(screenText(`run: ${a.run}   cwd: ${a.cwd}`), w),
    cut(`pm2: ${a.pm2Name} on ${r.host}  pid ${r.pid ?? '-'}  restarts ${r.restarts}  procs ${r.procs ?? '?'}  mem ${r.memory ? fmtBytes(r.memory) : '-'} (RSS sum of the tree; pm2 root: ${fmtBytes(r.pm2_memory)})`, w),
    cut(screenText(`ports: ${portDetails(r)}`), w), // process names from ss/ps are outside text too
    cut(screenText(`url: ${fmtUrl(r)}`), w),
    cut(screenText(`logs: ${s.logPaths ? `${s.logPaths.out} | ${s.logPaths.err}` : '-'}`), w),
  ] : ['no app selected'];
  const keys = 'j/k app  ↑↓ scroll  r restart  s start  x stop  o/e/b logs  f flat  h host  q quit';
  const footer = cut(right ? `${right}  │ ${keys}` : keys, w); // the error or notice first: on a narrow terminal the key legend is what gets cut
  return { header, table: tableLines, logs, details, footer, scroll: p.scroll, maxScroll: p.maxScroll };
}

/** A pane's one-line title rule: `── label ─────…` cut to the width. Panes have no frames, so a terminal selection copies text only. */
export function paneTitle(label: string, width: number): string {
  const head = `── ${label} `;
  return cut(head + '─'.repeat(Math.max(0, width - head.length)), width);
}

export function frameToText(f: Frame): string {
  return [f.header, '', ...f.table, '', 'logs:', ...f.logs, '', ...f.details, '', f.footer].join('\n');
}

import type { LsRow } from '../core/list.js';
import { isRunning } from '../core/pm2.js';
import {
  fmtBytes,
  fmtCpu,
  fmtPorts,
  fmtUptime,
  fmtUrl,
  incidentLines,
  table,
} from '../mcp/render.js';
import type { Incident } from '../core/incidents/detect.js';
import { DEFAULT_SINCE_MIN } from '../core/incidents/poll.js';
import { isTaken } from '../core/incidents/taken.js';
import {
  selectedRow,
  visibleFlat,
  visibleLogs,
  type FlatLine,
  type MonitState,
  type ReloadInfo,
  visibleIncidents,
  type ShownIncident,
} from './state.js';
import type { LogLine } from '../core/logfollow.js';
import { cutWidth as cut, displayWidth, screenText } from './screentext.js';
import { stripAnsi } from '../core/logs.js';
import { markKey } from '../core/incidents/cursor.js';
import { localStamp } from '../core/incidents/store.js';

export interface Frame {
  header: string;
  table: string[];
  logs: string[];
  details: string[];
  footer: string;
  /** entries hidden below the log pane as rendered, and the most that can be hidden with the pane still full */
  scroll: number;
  maxScroll: number;
}

/**
 * The log pane: `logH` rows ending at the view's lowest row — `scroll` entries hidden below it, and `shift` rows of the
 * lowest visible entry, so an entry taller than the pane is reachable row by row. Past the top the pane shows the first
 * `logH` rows: the window never shrinks. `maxScroll` = entries beyond the leading ones that fill the pane (the ceiling
 * of a scroll by whole entries, and what the title counts).
 */
function pane<T>(
  entries: T[],
  scroll: number,
  shift: number,
  logH: number,
  rowsOf: (e: T) => string[]
): { rows: string[]; scroll: number; maxScroll: number } {
  let filled = 0;
  let k = 0;
  while (k < entries.length && filled < logH) {
    filled += rowsOf(entries[k]).length;
    k++;
  }
  const maxScroll = Math.max(0, entries.length - k);
  if (entries.length === 0) return { rows: [], scroll: 0, maxScroll: 0 };
  const eff = Math.min(Math.max(0, scroll), entries.length - 1);
  const bottom = rowsOf(entries[entries.length - 1 - eff]);
  let rows = bottom.slice(
    0,
    bottom.length - Math.min(Math.max(0, shift), bottom.length - 1)
  );
  let i = entries.length - 1 - eff;
  while (rows.length < logH && i > 0) {
    i--;
    rows = [...rowsOf(entries[i]), ...rows];
  }
  if (rows.length < logH) {
    // past the top: the first rows of the buffer, a full pane
    rows = [];
    for (let j = 0; j < entries.length && rows.length < logH; j++)
      rows.push(...rowsOf(entries[j]));
    return { rows: rows.slice(0, logH), scroll: maxScroll, maxScroll };
  }
  return {
    rows: rows.slice(-logH),
    scroll: Math.min(eff, maxScroll),
    maxScroll,
  };
}

/** What the log pane shows for a state and a screen size: its entries, its height, and the rows of one entry. */
function paneSpec(
  s: MonitState,
  size: { width: number; height: number }
): { entries: object[]; logH: number; rowsOf: (e: object) => string[] } {
  const w = Math.max(40, size.width);
  if (s.view === 'incidents')
    return {
      entries: visibleIncidents(s),
      // header, the pane title, footer, and one line per thing the last read could not do
      logH: Math.max(3, size.height - 3 - s.incidentsErrors.length),
      rowsOf: (e) =>
        incidentRows(
          e as ShownIncident,
          w,
          isTaken(
            e as ShownIncident,
            s.incidentsTaken,
            (e as ShownIncident).end
          )
        ),
    };
  if (s.view === 'flat') {
    const label = Math.max(1, ...Object.keys(s.apps).map((a) => a.length));
    return {
      entries: visibleFlat(s),
      logH: Math.max(3, size.height - 3), // header, the pane title, footer
      rowsOf: (e) => {
        const l = e as FlatLine;
        return cachedRows(flatRows, l, `${w}|${label}`, () =>
          wrapText(
            `${l.app.padEnd(label)} ${l.stream === 'err' ? '!' : '|'} ${logText(l.text)}`,
            w,
            label + 3
          )
        );
      },
    };
  }
  const tableH = s.rows.length + 1; // the table's header line and one line per app
  return {
    entries: visibleLogs(s),
    logH: Math.max(3, size.height - 1 - tableH - 3 - 6 - 1), // 3: one title rule per pane, no frames; 6 details lines
    rowsOf: (e) => {
      const l = e as LogLine;
      return cachedRows(dashboardRows, l, `${w}`, () =>
        wrapText(`${l.stream === 'err' ? '! ' : '  '}${logText(l.text)}`, w, 2)
      );
    },
  };
}

/**
 * Where the log view is after moving `delta` rows (+ = older; ±Infinity = the top / the tail), measured in the rows the
 * pane draws: it stops when the oldest row is in view, and at the tail. Each step looks at one pane's worth of rows.
 */
export function scrollTo(
  s: MonitState,
  size: { width: number; height: number },
  delta: number
): { entries: number; rows: number } {
  const { entries, logH, rowsOf } = paneSpec(s, size);
  const n = entries.length;
  if (n === 0 || delta === -Infinity) return { entries: 0, rows: 0 };
  const rowsAt = (e: number) => rowsOf(entries[n - 1 - e]).length;
  if (delta === Infinity) {
    // the top: the view ends where the first pane of rows ends, counted from the oldest entry
    let rows = 0;
    for (let j = 0; j < n; j++) {
      const len = rowsOf(entries[j]).length;
      if (rows + len >= logH)
        return { entries: n - 1 - j, rows: rows + len - logH };
      rows += len;
    }
    return { entries: 0, rows: 0 }; // fewer rows than the pane: nothing to scroll, the view stays on the tail
  }
  let e = Math.min(Math.max(0, s.logScroll), n - 1);
  let r = Math.min(Math.max(0, s.logRowShift), rowsAt(e) - 1);
  /** the rows from the view's lowest row up to the oldest one, counted only up to `limit` */
  const upTo = (limit: number) => {
    let c = rowsAt(e) - r;
    for (let i = n - 1 - e; c < limit && i > 0; )
      c += rowsOf(entries[--i]).length;
    return c;
  };
  for (let k = 0; k < Math.abs(delta); k++) {
    if (delta > 0) {
      if (upTo(logH + 1) <= logH) break; // the oldest row is already in view
      if (r + 1 < rowsAt(e)) r++;
      else {
        e++;
        r = 0;
      }
    } else {
      if (e === 0 && r === 0) break;
      if (r > 0) r--;
      else {
        e--;
        r = rowsAt(e) - 1;
      }
    }
  }
  return { entries: e, rows: r };
}

/**
 * The rows of one log entry, per pane and width. A line is cleaned and wrapped once and kept on its own object, so a
 * render (and every scroll step is one) touches only lines it has not drawn before: the work stays the size of the pane.
 */
type RowCache = WeakMap<object, { key: string; rows: string[] }>;
const dashboardRows: RowCache = new WeakMap();
const flatRows: RowCache = new WeakMap();
function cachedRows(
  cache: RowCache,
  entry: object,
  key: string,
  make: () => string[]
): string[] {
  const hit = cache.get(entry);
  if (hit && hit.key === key) return hit.rows;
  const rows = make();
  cache.set(entry, { key, rows });
  return rows;
}

const incidentCache: RowCache = new WeakMap();
/** The muted colors of what the agent has taken: grey text, and a soft red for the incident's own line. */
const TAKEN_TEXT = '\x1b[90m';
const TAKEN_LINE = '\x1b[38;5;131m';
/**
 * An incident's rows as the incidents tool writes it, wrapped to the width; its own line red, each row closing its
 * color. One the agent has taken is muted throughout and says so on its first line.
 */
function incidentRows(i: Incident, w: number, taken = false): string[] {
  return cachedRows(incidentCache, i, `${w}:${taken}`, () =>
    incidentLines(i).flatMap((line, k) => {
      const text = taken && k === 0 ? `${line} · taken` : line;
      const rows = wrapText(screenText(text), w, 4);
      const color = line.startsWith('  ▶ ')
        ? taken
          ? TAKEN_LINE
          : '\x1b[31m'
        : taken
          ? TAKEN_TEXT
          : '';
      return color ? rows.map((r) => `${color}${r}${RESET}`) : rows;
    })
  );
}

const PM2_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?: /; // seconds, or milliseconds
/** A log line as screen text; pm2's time stamp stays even when carriage returns overwrote the text after it. */
function logText(text: string): string {
  const stamp = PM2_STAMP.exec(text)?.[0] ?? '';
  return stamp + screenText(text.slice(stamp.length), { colors: true }); // the app's own colors, as on its terminal
}

const RESET = '\x1b[0m';
const SGR_TOKEN = /(\x1b\[[0-9;:]*m)/;
/** The color state after an SGR code: a reset (`ESC[m`, `ESC[0m`, `ESC[0;…m`) starts over, anything else adds to it. */
function nextActive(active: string, code: string): string {
  const params = code.slice(2, -1);
  if (params === '' || params === '0') return '';
  return params.split(/[;:]/)[0] === '0' ? code : active + code;
}

/**
 * Hard-wraps one line of screen text at the width (a wide character is never split, color codes take no room);
 * continuation rows are indented so the text stays under the text, not under the marker. Every row that carries a
 * color closes it, and a continuation row reopens the color active at its start: each row stands alone, as the pane
 * may show any of them without the rows above.
 */
export function wrapText(
  text: string,
  width: number,
  indent: number
): string[] {
  const close = (r: string) => (r.includes('\x1b[') ? r + RESET : r);
  if (width <= 0 || displayWidth(text) <= width) return [close(text)];
  const pad = ' '.repeat(Math.min(indent, width - 1));
  const rows: string[] = [];
  let row = '';
  let w = 0;
  let filled = false;
  let active = '';
  for (const token of text.split(SGR_TOKEN)) {
    if (token.startsWith('\x1b[')) {
      row += token;
      active = nextActive(active, token);
      continue;
    }
    for (const ch of token) {
      const cw = displayWidth(ch);
      if (w + cw > width && filled) {
        rows.push(close(row));
        row = pad + active;
        w = pad.length;
        filled = false;
      }
      row += ch;
      w += cw;
      filled = true;
    }
  }
  rows.push(close(row));
  return rows;
}

function portDetails(r: LsRow): string {
  if (r.ports.checks.length === 0 && r.ports.actual.length === 0) return 'none';
  const parts = r.ports.checks.map((c) => {
    if (c.status === 'listening') {
      const l = r.ports.actual.find((x) => x.port === c.port);
      return `:${c.port} ✓${l ? ` pid ${l.pid ?? '?'} ${l.command ?? ''}`.trimEnd() : ''}`;
    }
    const who = c.held_by
      ? c.held_by.app
        ? `app ${c.held_by.app}`
        : c.held_by.container
          ? `container ${c.held_by.container}`
          : c.held_by.pid !== null
            ? `pid ${c.held_by.pid} ${c.held_by.command ?? ''}`.trimEnd()
            : "another user's process"
      : 'nothing listens';
    return `:${c.port} ✗ ${c.held_by ? 'held by ' : ''}${who}`;
  });
  for (const u of r.ports.undeclared) parts.push(`:${u} (undeclared)`);
  return parts.join(', ');
}

/**
 * What follows the restarts: ` (+7 reloads, last 12:01:05)`, `+≥7` when partial; nothing without a count, nor for an
 * app that is not running (pm2 keeps a stopped process's last start, but its run is over), as ls --reloads counts.
 */
function reloadsNote(r: LsRow, info: ReloadInfo | undefined): string {
  if (!info || info.count === 0 || !isRunning(r.status)) return '';
  const last = info.last ? `, last ${info.last.slice(11, 19)}` : '';
  return ` (+${info.partial ? '≥' : ''}${info.count} reload${info.count === 1 ? '' : 's'}${last})`;
}

export function renderFrame(
  s: MonitState,
  size: { width: number; height: number }
): Frame {
  const w = Math.max(40, size.width);
  const clock = s.updatedAt
    ? s.updatedAt.toTimeString().slice(0, 8)
    : '--:--:--';
  const header = cut(
    `mcproc · ${s.project} · ${s.host}${s.hosts.length > 1 ? ` (h: ${s.hosts.join('/')})` : ''}  ${clock}`,
    w
  );
  // everything that comes from outside (logs, descriptions, commands, errors) is shown as screen text: see screentext.ts.
  // While busy: what the step under way says it is doing (busy drops the notice before it), or working… when it says nothing
  const right = screenText(
    s.error ? `ERROR: ${s.error}` : (s.notice ?? (s.busy ? 'working…' : ''))
  );
  if (s.view === 'incidents') {
    // the incidents of the apps in view, oldest first, the newest at the bottom; what a read could not do under them
    const spec = paneSpec(s, size);
    const p = pane(
      spec.entries,
      s.logScroll,
      s.logRowShift,
      spec.logH,
      spec.rowsOf
    );
    const empty = !s.incidentsPolled
      ? 'reading incidents…'
      : s.incidents.length
        ? 'every incident here is taken (t shows them)'
        : `no incidents in the last ${DEFAULT_SINCE_MIN} min`;
    const keys = `↑↓ scroll  i back  f flat  t ${s.hideTaken ? 'show' : 'hide'} taken  c clear  R reload all  h host  q quit`;
    return {
      header,
      table: [],
      logs: [
        ...(p.rows.length ? p.rows : [empty]),
        ...s.incidentsErrors.map((e) => cut(screenText(e), w)),
      ],
      details: [],
      footer: cut(right ? `${right}  │ ${keys}` : keys, w),
      scroll: p.scroll,
      maxScroll: p.maxScroll,
    };
  }
  if (s.view === 'flat') {
    // compose style: every app, label padded to the longest name, `|` stdout / `!` stderr, continuations under the text
    const spec = paneSpec(s, size);
    const p = pane(
      spec.entries,
      s.logScroll,
      s.logRowShift,
      spec.logH,
      spec.rowsOf
    );
    const keys =
      '↑↓ scroll  c clear  R reload all  f dashboard  o/e/b logs  i incidents  h host  q quit';
    return {
      header,
      table: [],
      logs: p.rows,
      details: [],
      footer: cut(right ? `${right}  │ ${keys}` : keys, w),
      scroll: p.scroll,
      maxScroll: p.maxScroll,
    };
  }
  const multi = new Set(s.rows.map((r) => r.host)).size > 1; // apps of several hosts on one screen: say where each runs
  const o = multi ? 1 : 0;
  const tableLines = table(
    [
      [
        '',
        'APP',
        ...(multi ? ['HOST'] : []),
        'STATUS',
        'UP',
        'MEM',
        'CPU',
        'PORTS',
        'URL',
        'RUNTIME',
      ],
      ...s.rows.map((r, i) => [
        i === s.selected ? '▶' : ' ',
        r.app,
        ...(multi ? [r.host] : []),
        r.status,
        fmtUptime(r.uptime_ms),
        r.memory ? fmtBytes(r.memory) : '-',
        r.status === 'online' ? fmtCpu(r.cpu) : '-',
        screenText(fmtPorts(r.ports)),
        screenText(fmtUrl(r)),
        r.runtime ? screenText(r.runtime) : '-',
      ]),
    ],
    // +2: the marker column's gutter is dropped below, so the table may use those two columns
    { width: w + 2, flex: [6 + o, 7 + o, 8 + o], mode: 'fit' }
  )
    .split('\n')
    .map((l) => cut(l.replace(/^(.)\s\s/, '$1'), w));
  const spec = paneSpec(s, size); // its height counts the table as s.rows.length + 1 lines, as drawn here
  const p = pane(
    spec.entries,
    s.logScroll,
    s.logRowShift,
    spec.logH,
    spec.rowsOf
  );
  const logs = p.rows;
  const r = selectedRow(s);
  const a = r ? s.apps[r.app] : null;
  const details =
    r && a
      ? [
          cut(
            screenText(`${r.app} [${r.kind}] ${a.description.split('\n')[0]}`),
            w
          ),
          cut(screenText(`run: ${a.run}   cwd: ${a.cwd}`), w),
          cut(
            `pm2: ${a.pm2Name} on ${r.host}  pid ${r.pid ?? '-'}  restarts ${r.restarts}${reloadsNote(r, s.reloads[r.app])}  procs ${r.procs ?? '?'}  mem ${r.memory ? fmtBytes(r.memory) : '-'} (RSS sum of the tree; pm2 root: ${fmtBytes(r.pm2_memory)})`,
            w
          ),
          cut(screenText(`ports: ${portDetails(r)}`), w), // process names from ss/ps are outside text too
          cut(screenText(`url: ${fmtUrl(r)}`), w),
          cut(
            screenText(
              `logs: ${s.logPaths ? `${s.logPaths.out} | ${s.logPaths.err}` : '-'}`
            ),
            w
          ),
        ]
      : ['no app selected'];
  const keys =
    'j/k app  ↑↓ scroll  r restart  R reload all  s start  x stop  c clear  o/e/b logs  f flat  i incidents  h host  q quit';
  const footer = cut(right ? `${right}  │ ${keys}` : keys, w); // the error or notice first: on a narrow terminal the key legend is what gets cut
  return {
    header,
    table: tableLines,
    logs,
    details,
    footer,
    scroll: p.scroll,
    maxScroll: p.maxScroll,
  };
}

/** A clear's time for a title: the time when it was today, the date too otherwise. */
function clearedAt(at: string, now: Date): string {
  return at.slice(0, 10) === localStamp(now).slice(0, 10)
    ? at.slice(11, 16)
    : `${at.slice(0, 10)} ${at.slice(11, 16)}`;
}

/**
 * The pane's title: whose logs, which stream, the last clear of the apps shown, how far it is scrolled; in the incidents
 * view the window it reads, the last clear and how many incidents it shows.
 */
export function logsTitle(
  s: MonitState,
  scroll: number,
  now = new Date()
): string {
  const up = scroll ? ` · ↑${scroll} (End: tail)` : '';
  if (s.view === 'incidents') {
    const since = s.incidentsCleared
      ? ` · since the clear ${clearedAt(s.incidentsCleared, now)}`
      : '';
    const taken = s.incidents.filter((i) =>
      isTaken(i, s.incidentsTaken, i.end)
    ).length;
    const marked = taken
      ? ` · ${taken} taken${s.hideTaken ? ' hidden' : ''}`
      : '';
    return `incidents · last ${DEFAULT_SINCE_MIN} min${since} · ${visibleIncidents(s).length} shown${marked}${up}`;
  }
  const shown =
    s.view === 'flat'
      ? s.rows
      : [selectedRow(s)].filter((r): r is LsRow => r !== null);
  const at = shown
    .map((r) => s.cleared[markKey(r.host, r.app)] ?? '')
    .filter(Boolean)
    .sort()
    .at(-1);
  const when = at ? ` · cleared ${clearedAt(at, now)}` : '';
  const who = s.view === 'flat' ? 'all apps' : (selectedRow(s)?.app ?? '-');
  return `logs · ${who} · ${s.stream}${when}${up}`;
}

/** A pane's one-line title rule: `── label ─────…` cut to the width. Panes have no frames, so a terminal selection copies text only. */
export function paneTitle(label: string, width: number): string {
  const head = `── ${label} `;
  return cut(head + '─'.repeat(Math.max(0, width - head.length)), width);
}

export function frameToText(f: Frame): string {
  return [
    f.header,
    '',
    ...f.table,
    '',
    'logs:',
    ...f.logs.map(stripAnsi),
    '',
    ...f.details,
    '',
    f.footer,
  ].join('\n'); // text for agents: no escapes
}

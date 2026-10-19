import {
  fmtBytes,
  fmtCpu,
  fmtPorts,
  fmtUptime,
  orphanCells,
  STACK_HEADER,
  stackApps,
  stackLabel,
  stackPorts,
  stacksHostLine,
  table,
  tildePath,
} from '../mcp/render.js';
import type { StackView } from '../core/stacks/types.js';
import { paneTitle } from './frame.js';
import { cutWidth as cut, screenText } from './screentext.js';
import {
  overviewRows,
  selectedOverviewRow,
  type OverviewState,
} from './stacks-state.js';

export interface OverviewFrame {
  header: string;
  title: string;
  table: string[];
  appsTitle: string;
  apps: string[];
  footer: string;
}

const KEYS = (all: boolean) =>
  `j/k stack  enter open  x stop stack  a ${all ? 'running only' : 'all known'}  q quit`;
/** The lines around the panes: the header, the two pane titles and the footer. */
const CHROME = 4;
/** The apps pane keeps at least this many lines however many stacks there are. */
const MIN_APPS = 4;

/** The selected stack's lines for the lower pane: its apps, or why its manifest did not load; then its notes and host errors. */
function stackLines(st: StackView, width: number): string[] {
  const e = st.manifest_error;
  const lines = e
    ? [`${e.code}: ${e.message}`, ...(e.hint ? [e.hint] : [])]
    : table(
        [
          ['APP', 'HOST', 'STATUS', 'UP', 'MEM', 'CPU', 'PORTS'],
          ...st.rows.map((r) => [
            r.app,
            r.host,
            r.status,
            fmtUptime(r.uptime_ms),
            r.memory ? fmtBytes(r.memory) : '-',
            r.status === 'online' ? fmtCpu(r.cpu) : '-',
            fmtPorts(r.ports),
          ]),
        ].map((r) => r.map((c) => screenText(c))),
        { width, flex: [6], mode: 'fit' }
      ).split('\n');
  for (const n of st.notes) lines.push(n);
  for (const h of st.hosts) if (h.error) lines.push(`${h.name}: ${h.error}`);
  return lines;
}

/**
 * The stacks screen: the host line, the stacks pane (a ▶ on the selected row, ROOT cut at its start), the selected
 * stack's apps under it, and the keys with the latest notice. Everything from outside is shown as screen text.
 */
export function renderOverview(
  s: OverviewState,
  size: { width: number; height: number }
): OverviewFrame {
  const w = size.width;
  const a = s.view?.answer;
  const at = s.updatedAt ? ` · ${s.updatedAt.toTimeString().slice(0, 8)}` : '';
  const header = cut(
    screenText(
      a
        ? `mcproc · ${stacksHostLine(a.host)}${at}${a.host.notes.map((n) => ` · ${n}`).join('')}`
        : 'mcproc · reading the stacks…'
    ),
    w
  );
  const rows = overviewRows(s);
  // a worktree is indented under its base when that base is listed too (orderStacks put it right there)
  const listed = new Set(s.view?.stacks.map((st) => st.project));
  const cells = rows.map((r, i) => {
    const mark = i === s.index ? '▶' : ' ';
    if (r.kind === 'orphan') return [mark, ...orphanCells(r.orphan)];
    const st = r.stack;
    const nested =
      st.base_project !== st.project && listed.has(st.base_project);
    return [
      mark,
      stackLabel(st, nested),
      tildePath(st.root),
      st.hosts.map((h) => (h.reachable ? h.name : `${h.name}✗`)).join(','),
      st.manifest_error ? 'manifest error' : stackApps(st),
      String(st.apps.errored),
      st.memory ? fmtBytes(st.memory) : '-',
      st.cpu === null ? '-' : `${Math.round(st.cpu)}%`,
      stackPorts(st),
    ];
  });
  // the marker column (one wide, even with no rows) sits flush against STACK: the table is laid out 2 wider, then each
  // line drops that gutter
  const lines = table(
    [[' ', ...STACK_HEADER], ...cells].map((r) => r.map((c) => screenText(c))),
    { width: w + 2, flex: [2, 8], cutStart: [2], mode: 'fit' }
  )
    .split('\n')
    .map((l) => cut(l.replace(/^(.)\s\s/, '$1'), w));
  // the stacks pane takes what it needs, up to the height less the chrome and the apps pane's minimum; scrolled so the
  // selected row stays in it
  const budget = Math.max(2, size.height - CHROME - MIN_APPS);
  const shown = budget - 1;
  const start = Math.max(0, Math.min(s.index + 1 - shown, rows.length - shown));
  const tableShown = [lines[0], ...lines.slice(1 + start, 1 + start + shown)];
  const sel = selectedOverviewRow(s);
  let appsTitle = 'apps';
  let apps: string[] = [];
  if (sel?.kind === 'stack') {
    appsTitle = `apps · ${sel.stack.project}`;
    apps = stackLines(sel.stack, w);
  } else if (sel?.kind === 'orphan') {
    const o = sel.orphan;
    appsTitle = `processes · pm2 · ${o.namespace}`;
    apps = table(
      [
        ['NAME', 'STATUS', 'MEM'],
        ...o.processes.map((p) => [
          p.name,
          p.status,
          p.memory ? fmtBytes(p.memory) : '-',
        ]),
      ].map((r) => r.map((c) => screenText(c))),
      { width: w, flex: [0], mode: 'fit' }
    ).split('\n');
    if (o.note) apps.push(o.note);
  } else if (a) {
    // nothing to list: say why first (a daemon that did not answer, an unreadable registry), then how to see more
    apps = [
      ...a.host.notes,
      `no stacks running on this host · a: ${s.all ? 'running only' : 'all known'}`,
    ];
  }
  const appsH = Math.max(1, size.height - CHROME - tableShown.length);
  const right = screenText(
    s.error ? `ERROR: ${s.error}` : (s.notice ?? (s.busy ? 'working…' : ''))
  );
  const footer = cut(right ? `${right}  │ ${KEYS(s.all)}` : KEYS(s.all), w);
  return {
    header,
    title: paneTitle('stacks', w),
    table: tableShown,
    appsTitle: paneTitle(screenText(appsTitle), w),
    apps: apps.slice(0, appsH).map((l) => cut(screenText(l), w)),
    footer,
  };
}

/** The frame as plain text, the panes apart by a blank line: what an agent reads (no escapes). */
export function overviewToText(f: OverviewFrame): string {
  return [f.header, '', ...f.table, '', ...f.apps, '', f.footer].join('\n');
}

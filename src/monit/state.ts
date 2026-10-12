import type { Manifest } from '../core/manifest.js';
import type { LsRow } from '../core/list.js';
import { pm2Name } from '../core/pm2.js';
import { sortByStamp, type LogLine } from '../core/logfollow.js';

export type Stream = 'out' | 'err' | 'both';
/** dashboard: table + the selected app's logs + details; flat: every app's logs merged into one labeled stream, compose style */
export type View = 'dashboard' | 'flat';
export interface FlatLine { app: string; stream: 'out' | 'err'; text: string }
export interface AppInfo { description: string; run: string; cwd: string; pm2Name: string }
export interface MonitState {
  project: string; host: string; hosts: string[]; apps: Record<string, AppInfo>;
  rows: LsRow[]; selected: number; stream: Stream; view: View;
  /** entries hidden below the log pane (0 = following the tail); the view stays put while new lines arrive */
  logScroll: number;
  /** one buffer per app, filled by every poll whichever view is active: the dashboard shows the selected app's, the flat view merges all */
  logs: Record<string, LogLine[]>;
  maxLogs: number; logPaths: { out: string; err: string } | null;
  error: string | null; notice: string | null; busy: boolean; updatedAt: Date | null;
}
export type MonitAction =
  | { type: 'rows'; rows: LsRow[]; at: Date }
  | { type: 'logs'; app: string; lines: LogLine[]; reset?: boolean; paths?: { out: string; err: string } | null }
  | { type: 'view'; view: View }
  | { type: 'scroll'; delta: number; max?: number } // + = older; ±Infinity = oldest / tail; max = the pane's ceiling (renderFrame().maxScroll)
  | { type: 'select'; delta: number }
  | { type: 'stream'; stream: Stream }
  | { type: 'error'; message: string | null }
  | { type: 'notice'; message: string | null }
  | { type: 'busy'; busy: boolean }
  | { type: 'host'; host: string };

export function appInfos(m: Manifest): Record<string, AppInfo> {
  return Object.fromEntries(Object.values(m.apps).map((a) => [a.name, { description: a.description, run: a.run, cwd: a.cwd, pm2Name: pm2Name(m.project, a.name) }]));
}
export function hostNames(m: Manifest): string[] {
  return ['local', ...Object.keys(m.hosts).filter((h) => h !== 'local')];
}

export function initialState(p: { project: string; host: string; hosts: string[]; apps: Record<string, AppInfo>; maxLogs?: number }): MonitState {
  return { project: p.project, host: p.host, hosts: p.hosts, apps: p.apps, rows: [], selected: 0, stream: 'both', view: 'dashboard', logScroll: 0, logs: {}, maxLogs: p.maxLogs ?? 2000, logPaths: null, error: null, notice: null, busy: false, updatedAt: null };
}

const clamp = (i: number, n: number) => (n === 0 ? 0 : Math.min(Math.max(i, 0), n - 1));
const selectedApp = (s: MonitState): string | undefined => s.rows[s.selected]?.app;

export function reduce(s: MonitState, a: MonitAction): MonitState {
  switch (a.type) {
    case 'rows': {
      const name = s.rows[s.selected]?.app;
      const idx = name ? a.rows.findIndex((r) => r.app === name) : -1;
      return { ...s, rows: a.rows, selected: clamp(idx >= 0 ? idx : s.selected, a.rows.length), updatedAt: a.at, error: null };
    }
    case 'logs': {
      const buffer = (a.reset ? a.lines : [...(s.logs[a.app] ?? []), ...a.lines]).slice(-s.maxLogs);
      const inView = s.view === 'flat' || a.app === selectedApp(s);
      // a scrolled view stays on the same lines while new ones arrive below it; a reset (rotation, flush) jumps to the tail
      const logScroll = !inView ? s.logScroll : a.reset ? 0 : s.logScroll > 0 ? s.logScroll + a.lines.length : 0;
      const logPaths = a.paths !== undefined && a.app === selectedApp(s) ? a.paths : s.logPaths;
      return { ...s, logs: { ...s.logs, [a.app]: buffer }, logScroll, logPaths };
    }
    case 'select': {
      const selected = clamp(s.selected + a.delta, s.rows.length);
      return selected === s.selected ? s : { ...s, selected, logPaths: null, logScroll: 0 }; // buffers are kept: the next selection shows its history at once
    }
    case 'view': return { ...s, view: a.view, logScroll: 0 };
    case 'scroll': {
      const n = s.view === 'flat' ? Object.values(s.logs).reduce((t, l) => t + l.length, 0) : (s.logs[selectedApp(s) ?? ''] ?? []).length;
      const max = a.max ?? Math.max(0, n - 1); // without the pane's ceiling, at least never beyond the oldest entry
      return { ...s, logScroll: Math.min(Math.max(0, s.logScroll + a.delta), Math.max(0, max)) };
    }
    case 'stream': return { ...s, stream: a.stream };
    case 'error': return { ...s, error: a.message };
    case 'notice': return { ...s, notice: a.message };
    case 'busy': return { ...s, busy: a.busy };
    case 'host': return { ...s, host: a.host, rows: [], logs: {}, logScroll: 0, logPaths: null, selected: 0, error: null, notice: `host: ${a.host}` };
  }
}

export type KeyIntent = { kind: 'action'; action: MonitAction } | { kind: 'command'; cmd: 'start' | 'restart' | 'stop'; app: string } | { kind: 'host-next' } | { kind: 'quit' } | null;

export function keyIntent(key: string, s: MonitState): KeyIntent {
  const app = s.rows[s.selected]?.app;
  const canCommand = app && !s.busy && s.view === 'dashboard'; // commands act on the selected app, which only the dashboard shows
  switch (key) {
    // mouse tracking stays off so terminal drag-selection works; the wheel then arrives as ↑/↓, so those scroll the logs
    case 'up': return { kind: 'action', action: { type: 'scroll', delta: 1 } };
    case 'down': return { kind: 'action', action: { type: 'scroll', delta: -1 } };
    case 'pageup': return { kind: 'action', action: { type: 'scroll', delta: 10 } };
    case 'pagedown': return { kind: 'action', action: { type: 'scroll', delta: -10 } };
    case 'home': case 'g': return { kind: 'action', action: { type: 'scroll', delta: Infinity } };
    case 'end': case 'G': return { kind: 'action', action: { type: 'scroll', delta: -Infinity } };
    case 'k': case 'S-tab': return { kind: 'action', action: { type: 'select', delta: -1 } };
    case 'j': case 'tab': return { kind: 'action', action: { type: 'select', delta: 1 } };
    case 'o': return { kind: 'action', action: { type: 'stream', stream: 'out' } };
    case 'e': return { kind: 'action', action: { type: 'stream', stream: 'err' } };
    case 'b': return { kind: 'action', action: { type: 'stream', stream: 'both' } };
    case 'f': return { kind: 'action', action: { type: 'view', view: s.view === 'flat' ? 'dashboard' : 'flat' } };
    case 'r': return canCommand ? { kind: 'command', cmd: 'restart', app } : null;
    case 's': return canCommand ? { kind: 'command', cmd: 'start', app } : null;
    case 'x': return canCommand ? { kind: 'command', cmd: 'stop', app } : null;
    case 'h': return s.hosts.length > 1 ? { kind: 'host-next' } : null;
    case 'q': case 'C-c': case 'escape': return { kind: 'quit' };
    default: return null;
  }
}

export function selectedRow(s: MonitState): LsRow | null { return s.rows[s.selected] ?? null; }

export function visibleLogs(s: MonitState): LogLine[] {
  const all = s.logs[selectedApp(s) ?? ''] ?? [];
  const lines = s.stream === 'both' ? all : all.filter((l) => l.stream === s.stream);
  return s.stream === 'both' ? sortByStamp(lines) : lines;
}

/** The flat stream: every app's buffer merged, ordered by pm2's stamp across apps (one host, one clock). */
export function visibleFlat(s: MonitState): FlatLine[] {
  const all = Object.entries(s.logs).flatMap(([app, lines]) => lines.map((l) => ({ app, stream: l.stream, text: l.text })));
  return sortByStamp(s.stream === 'both' ? all : all.filter((l) => l.stream === s.stream));
}

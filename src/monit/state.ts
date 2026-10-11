import type { Manifest } from '../core/manifest.js';
import type { LsRow } from '../core/list.js';
import { pm2Name } from '../core/pm2.js';
import { sortByStamp, type LogLine } from '../core/logfollow.js';

export type Stream = 'out' | 'err' | 'both';
export interface AppInfo { description: string; run: string; cwd: string; pm2Name: string }
export interface MonitState {
  project: string; host: string; hosts: string[]; apps: Record<string, AppInfo>;
  rows: LsRow[]; selected: number; stream: Stream;
  logs: LogLine[]; maxLogs: number; logPaths: { out: string; err: string } | null;
  error: string | null; notice: string | null; busy: boolean; updatedAt: Date | null;
}
export type MonitAction =
  | { type: 'rows'; rows: LsRow[]; at: Date }
  | { type: 'logs'; lines: LogLine[]; reset?: boolean; paths?: { out: string; err: string } | null }
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
  return { project: p.project, host: p.host, hosts: p.hosts, apps: p.apps, rows: [], selected: 0, stream: 'both', logs: [], maxLogs: p.maxLogs ?? 2000, logPaths: null, error: null, notice: null, busy: false, updatedAt: null };
}

const clamp = (i: number, n: number) => (n === 0 ? 0 : Math.min(Math.max(i, 0), n - 1));

export function reduce(s: MonitState, a: MonitAction): MonitState {
  switch (a.type) {
    case 'rows': {
      const name = s.rows[s.selected]?.app;
      const idx = name ? a.rows.findIndex((r) => r.app === name) : -1;
      return { ...s, rows: a.rows, selected: clamp(idx >= 0 ? idx : s.selected, a.rows.length), updatedAt: a.at, error: null };
    }
    case 'logs': {
      const logs = (a.reset ? a.lines : [...s.logs, ...a.lines]).slice(-s.maxLogs);
      return { ...s, logs, logPaths: a.paths === undefined ? s.logPaths : a.paths };
    }
    case 'select': {
      const selected = clamp(s.selected + a.delta, s.rows.length);
      return selected === s.selected ? s : { ...s, selected, logs: [], logPaths: null };
    }
    case 'stream': return { ...s, stream: a.stream };
    case 'error': return { ...s, error: a.message };
    case 'notice': return { ...s, notice: a.message };
    case 'busy': return { ...s, busy: a.busy };
    case 'host': return { ...s, host: a.host, rows: [], logs: [], logPaths: null, selected: 0, error: null, notice: `host: ${a.host}` };
  }
}

export type KeyIntent = { kind: 'action'; action: MonitAction } | { kind: 'command'; cmd: 'start' | 'restart' | 'stop'; app: string } | { kind: 'host-next' } | { kind: 'quit' } | null;

export function keyIntent(key: string, s: MonitState): KeyIntent {
  const app = s.rows[s.selected]?.app;
  switch (key) {
    case 'up': case 'k': return { kind: 'action', action: { type: 'select', delta: -1 } };
    case 'down': case 'j': return { kind: 'action', action: { type: 'select', delta: 1 } };
    case 'o': return { kind: 'action', action: { type: 'stream', stream: 'out' } };
    case 'e': return { kind: 'action', action: { type: 'stream', stream: 'err' } };
    case 'b': return { kind: 'action', action: { type: 'stream', stream: 'both' } };
    case 'r': return app && !s.busy ? { kind: 'command', cmd: 'restart', app } : null;
    case 's': return app && !s.busy ? { kind: 'command', cmd: 'start', app } : null;
    case 'x': return app && !s.busy ? { kind: 'command', cmd: 'stop', app } : null;
    case 'h': return s.hosts.length > 1 ? { kind: 'host-next' } : null;
    case 'q': case 'C-c': case 'escape': return { kind: 'quit' };
    default: return null;
  }
}

export function selectedRow(s: MonitState): LsRow | null { return s.rows[s.selected] ?? null; }

export function visibleLogs(s: MonitState): LogLine[] {
  const lines = s.stream === 'both' ? s.logs : s.logs.filter((l) => l.stream === s.stream);
  return s.stream === 'both' ? sortByStamp(lines) : lines;
}

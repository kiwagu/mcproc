import type { Manifest } from '../core/manifest.js';
import type { LsRow } from '../core/list.js';
import { pm2Name } from '../core/pm2.js';
import { sortByStamp, type LogLine } from '../core/logfollow.js';

export type Stream = 'out' | 'err' | 'both';
/** dashboard: table + the selected app's logs + details; flat: every app's logs merged into one labeled stream, compose style */
export type View = 'dashboard' | 'flat';
export interface FlatLine {
  app: string;
  stream: 'out' | 'err';
  text: string;
  seq: number;
}
export interface AppInfo {
  description: string;
  run: string;
  cwd: string;
  pm2Name: string;
}
/**
 * An app's in-process reloads since pm2 started it, as ls --reloads reports them: how many, the last one's stamp as its
 * log wrote it, and partial when the lines seen do not reach back to the start (the count is then a lower bound).
 */
export type ReloadInfo = NonNullable<LsRow['reloads']>;
/** A buffered log line with its arrival number: hosts have their own clocks (and time zones), so across hosts arrival is the order. */
export interface BufferedLine extends LogLine {
  seq: number;
}
export interface MonitState {
  project: string;
  host: string;
  hosts: string[];
  apps: Record<string, AppInfo>;
  rows: LsRow[];
  selected: number;
  stream: Stream;
  view: View;
  /** the user moved the selection in this view; until then it is the first row, whichever host answered first */
  chosen: boolean;
  /** entries hidden below the log pane (0 = following the tail); the view stays put while new lines arrive */
  logScroll: number;
  /** rows of the lowest visible entry hidden below the pane: an entry taller than the pane is scrolled through row by row */
  logRowShift: number;
  /** one buffer per app, filled by every poll whichever view is active: the dashboard shows the selected app's, the flat view merges all */
  logs: Record<string, BufferedLine[]>;
  /** the arrival number the next buffered line gets */
  seq: number;
  maxLogs: number;
  logPaths: { out: string; err: string } | null;
  error: string | null;
  notice: string | null;
  busy: boolean;
  updatedAt: Date | null;
  /** when c or R was pressed once: the same key again within CONFIRM_MS does it */
  armedAt: number | null;
  /** what the first press asked for; only its own key confirms it, the other one arms itself instead */
  armed: Armed | null;
  /** the recorded clears, keyed host/app, as the project's store has them */
  cleared: Record<string, string>;
  /** per app whose logs this screen follows with reloads on and a known start: its reloads since that start */
  reloads: Record<string, ReloadInfo>;
}
/** a key that asks twice: c clears the logs of the running apps in view, R reloads every app in view */
export type Armed = 'clear' | 'reload';
export type MonitAction =
  | { type: 'rows'; rows: LsRow[]; at?: Date } // no `at`: nothing new was heard (a host failed), so the clock stays
  | {
      type: 'logs';
      app: string;
      lines: LogLine[];
      reset?: boolean;
      paths?: { out: string; err: string } | null;
    }
  | { type: 'view'; view: View }
  | {
      type: 'scroll';
      delta: number;
      max?: number;
      to?: { entries: number; rows: number };
    } // + = older; ±Infinity = oldest / tail; max = the pane's ceiling (renderFrame().maxScroll); to = the place the screen measured in rows (frame scrollTo)
  | { type: 'select'; delta: number }
  | { type: 'stream'; stream: Stream }
  | { type: 'error'; message: string | null }
  | { type: 'notice'; message: string | null }
  | { type: 'busy'; busy: boolean }
  | { type: 'host'; host: string }
  | { type: 'arm'; at: null }
  | { type: 'arm'; at: number; what: Armed; apps: string[] }
  | { type: 'cleared'; cleared: Record<string, string> }
  | { type: 'reloads'; app: string; info: ReloadInfo | null }; // null: the app is no longer counted

export function appInfos(m: Manifest): Record<string, AppInfo> {
  return Object.fromEntries(
    Object.values(m.apps).map((a) => [
      a.name,
      {
        description: a.description,
        run: a.run,
        cwd: a.cwd,
        pm2Name: pm2Name(m.project, a.name),
      },
    ])
  );
}
export function hostNames(m: Manifest): string[] {
  return ['local', ...Object.keys(m.hosts).filter((h) => h !== 'local')];
}
/**
 * The screen's views in `h` order, each the --host a command would take: with host-bound apps first "all" (undefined:
 * every app at its own host), then each host; without any, just the hosts, as there is nothing else to tell apart.
 */
export function monitViews(m: Manifest): (string | undefined)[] {
  return Object.values(m.apps).some((a) => a.host !== null)
    ? [undefined, ...hostNames(m)]
    : hostNames(m);
}
export const viewLabel = (requested: string | undefined): string =>
  requested ?? 'all';

export function initialState(p: {
  project: string;
  host: string;
  hosts: string[];
  apps: Record<string, AppInfo>;
  maxLogs?: number;
}): MonitState {
  return {
    project: p.project,
    host: p.host,
    hosts: p.hosts,
    apps: p.apps,
    rows: [],
    selected: 0,
    chosen: false,
    stream: 'both',
    view: 'dashboard',
    logScroll: 0,
    logRowShift: 0,
    logs: {},
    seq: 0,
    maxLogs: p.maxLogs ?? 2000,
    logPaths: null,
    error: null,
    notice: null,
    busy: false,
    updatedAt: null,
    armedAt: null,
    armed: null,
    cleared: {},
    reloads: {},
  };
}

/** Which view a reload covers, for its prompt: every host, the host `h` narrowed to, or nothing when there is one view only. */
function reloadScope(s: MonitState): string {
  if (s.hosts.length <= 1) return '';
  return ` (${s.host === viewLabel(undefined) ? 'all hosts' : s.host})`;
}

const clamp = (i: number, n: number) =>
  n === 0 ? 0 : Math.min(Math.max(i, 0), n - 1);
const selectedApp = (s: MonitState): string | undefined =>
  s.rows[s.selected]?.app;

export function reduce(s: MonitState, a: MonitAction): MonitState {
  switch (a.type) {
    case 'rows': {
      const name = s.rows[s.selected]?.app;
      const idx =
        s.chosen && name ? a.rows.findIndex((r) => r.app === name) : 0;
      const selected = clamp(idx >= 0 ? idx : s.selected, a.rows.length);
      const moved = a.rows[selected]?.app !== name; // another app is selected now: its log paths are not known yet
      return {
        ...s,
        rows: a.rows,
        selected,
        ...(moved ? { logPaths: null, logScroll: 0, logRowShift: 0 } : {}),
        updatedAt: a.at ?? s.updatedAt,
        error: null,
      };
    }
    case 'logs': {
      // one poll's stdout and stderr merge by pm2's stamp (one app, one clock); then the batch is numbered in arrival order
      const batch = sortByStamp(a.lines).map((l, i) => ({
        ...l,
        seq: s.seq + i,
      }));
      const buffer = (
        a.reset ? batch : [...(s.logs[a.app] ?? []), ...batch]
      ).slice(-s.maxLogs);
      const inView = s.view === 'flat' || a.app === selectedApp(s);
      // a scrolled view stays on the same lines while new ones arrive below it; a reset (rotation, flush) jumps to the tail
      const scrolled = s.logScroll > 0 || s.logRowShift > 0;
      const logScroll = !inView
        ? s.logScroll
        : a.reset
          ? 0
          : scrolled
            ? s.logScroll + a.lines.length
            : 0;
      const logRowShift = !inView
        ? s.logRowShift
        : a.reset || !scrolled
          ? 0
          : s.logRowShift;
      const logPaths =
        a.paths !== undefined && a.app === selectedApp(s)
          ? a.paths
          : s.logPaths;
      return {
        ...s,
        logs: { ...s.logs, [a.app]: buffer },
        seq: s.seq + batch.length,
        logScroll,
        logRowShift,
        logPaths,
      };
    }
    case 'select': {
      const selected = clamp(s.selected + a.delta, s.rows.length);
      return selected === s.selected
        ? { ...s, chosen: true }
        : {
            ...s,
            selected,
            chosen: true,
            logPaths: null,
            logScroll: 0,
            logRowShift: 0,
          }; // buffers are kept: the next selection shows its history at once
    }
    case 'view':
      return { ...s, view: a.view, logScroll: 0, logRowShift: 0 };
    case 'scroll': {
      if (a.to)
        return { ...s, logScroll: a.to.entries, logRowShift: a.to.rows };
      const n =
        s.view === 'flat'
          ? Object.values(s.logs).reduce((t, l) => t + l.length, 0)
          : (s.logs[selectedApp(s) ?? ''] ?? []).length;
      const max = a.max ?? Math.max(0, n - 1); // without the pane's ceiling, at least never beyond the oldest entry
      return {
        ...s,
        logScroll: Math.min(
          Math.max(0, s.logScroll + a.delta),
          Math.max(0, max)
        ),
        logRowShift: 0,
      };
    }
    case 'stream':
      return { ...s, stream: a.stream };
    case 'error':
      return { ...s, error: a.message };
    case 'notice':
      return { ...s, notice: a.message };
    case 'busy':
      // a step that starts drops the last notice: the footer then shows what this one says it is doing, or working…
      return a.busy
        ? { ...s, busy: true, notice: null }
        : { ...s, busy: false };
    case 'arm':
      return a.at === null
        ? {
            ...s,
            armedAt: null,
            armed: null,
            notice: s.armedAt !== null ? null : s.notice,
          }
        : {
            ...s,
            armedAt: a.at,
            armed: a.what,
            notice:
              a.what === 'clear'
                ? `press c again to clear the logs of ${a.apps.join(', ')} (incidents start over there)`
                : `press R again to reload ${a.apps.length} app${a.apps.length === 1 ? '' : 's'}${reloadScope(s)}`,
          };
    case 'cleared':
      return { ...s, cleared: a.cleared };
    case 'reloads': {
      const { [a.app]: _, ...rest } = s.reloads;
      return { ...s, reloads: a.info ? { ...rest, [a.app]: a.info } : rest };
    }
    case 'host':
      return {
        ...s,
        host: a.host,
        rows: [],
        logs: {},
        reloads: {},
        logScroll: 0,
        logRowShift: 0,
        logPaths: null,
        selected: 0,
        chosen: false,
        error: null,
        notice: `host: ${a.host}`,
      };
  }
}

export type KeyIntent =
  | { kind: 'action'; action: MonitAction }
  | { kind: 'command'; cmd: 'start' | 'restart' | 'stop'; app: string }
  | { kind: 'clear'; apps: string[] }
  | { kind: 'reload-all' }
  | { kind: 'host-next' }
  | { kind: 'quit' }
  | null;

/** How long a first c or R waits for the second one. */
export const CONFIRM_MS = 3000;

export function keyIntent(
  key: string,
  s: MonitState,
  now = Date.now()
): KeyIntent {
  const app = s.rows[s.selected]?.app;
  const canCommand = app && !s.busy && s.view === 'dashboard'; // commands act on the selected app, which only the dashboard shows
  /** the second press of the key that armed `what`, in time */
  const confirms = (what: Armed) =>
    s.armed === what && s.armedAt !== null && now - s.armedAt <= CONFIRM_MS;
  switch (key) {
    // mouse tracking stays off so terminal drag-selection works; the wheel then arrives as ↑/↓, so those scroll the logs
    case 'up':
      return { kind: 'action', action: { type: 'scroll', delta: 1 } };
    case 'down':
      return { kind: 'action', action: { type: 'scroll', delta: -1 } };
    case 'pageup':
      return { kind: 'action', action: { type: 'scroll', delta: 10 } };
    case 'pagedown':
      return { kind: 'action', action: { type: 'scroll', delta: -10 } };
    case 'home':
    case 'g':
      return { kind: 'action', action: { type: 'scroll', delta: Infinity } };
    case 'end':
    case 'G':
      return { kind: 'action', action: { type: 'scroll', delta: -Infinity } };
    case 'k':
    case 'S-tab':
      return { kind: 'action', action: { type: 'select', delta: -1 } };
    case 'j':
    case 'tab':
      return { kind: 'action', action: { type: 'select', delta: 1 } };
    case 'o':
      return { kind: 'action', action: { type: 'stream', stream: 'out' } };
    case 'e':
      return { kind: 'action', action: { type: 'stream', stream: 'err' } };
    case 'b':
      return { kind: 'action', action: { type: 'stream', stream: 'both' } };
    case 'f':
      return {
        kind: 'action',
        action: {
          type: 'view',
          view: s.view === 'flat' ? 'dashboard' : 'flat',
        },
      };
    case 'r':
      return canCommand ? { kind: 'command', cmd: 'restart', app } : null;
    case 's':
      return canCommand ? { kind: 'command', cmd: 'start', app } : null;
    case 'x':
      return canCommand ? { kind: 'command', cmd: 'stop', app } : null;
    case 'h':
      return s.hosts.length > 1 && !s.busy ? { kind: 'host-next' } : null; // one switch at a time
    case 'c': {
      // c clears every running app of the view, so it asks twice: a second c within CONFIRM_MS does it, any other key cancels
      const apps = s.rows
        .filter((r) => r.status === 'online')
        .map((r) => r.app);
      if (s.busy || apps.length === 0) return null;
      return confirms('clear')
        ? { kind: 'clear', apps }
        : {
            kind: 'action',
            action: { type: 'arm', at: now, what: 'clear', apps },
          };
    }
    case 'S-r': {
      // R (blessed: S-r) is `start all --reload` over the view: every app in dependency order with its waits, tasks re-run
      // included, in either view, so it asks twice like c
      const apps = s.rows.map((r) => r.app);
      if (s.busy || apps.length === 0) return null;
      return confirms('reload')
        ? { kind: 'reload-all' }
        : {
            kind: 'action',
            action: { type: 'arm', at: now, what: 'reload', apps },
          };
    }
    case 'q':
    case 'C-c':
    case 'escape':
      return { kind: 'quit' };
    default:
      return null;
  }
}

export function selectedRow(s: MonitState): LsRow | null {
  return s.rows[s.selected] ?? null;
}

export function visibleLogs(s: MonitState): LogLine[] {
  const all = s.logs[selectedApp(s) ?? ''] ?? [];
  const lines =
    s.stream === 'both' ? all : all.filter((l) => l.stream === s.stream);
  return s.stream === 'both' ? sortByStamp(lines) : lines;
}

/**
 * The flat stream: every app's buffer merged. Apps of one host are ordered by pm2's stamp (one clock); once the apps with
 * lines run on more than one host, by arrival — another host's stamps may be in another time zone, or just drift.
 */
export function visibleFlat(s: MonitState): FlatLine[] {
  const hostOf = new Map(s.rows.map((r) => [r.app, r.host]));
  const entries = Object.entries(s.logs).filter(
    ([, lines]) => lines.length > 0
  );
  const hosts = [...new Set(entries.map(([app]) => hostOf.get(app)))];
  // scrolling and selection leave the buffers alone: the merge of the last render is still the answer
  const key = `${s.stream}|${hosts.join(',')}`;
  if (flatMemo && flatMemo.logs === s.logs && flatMemo.key === key)
    return flatMemo.out;
  const all = entries.flatMap(([app, lines]) =>
    lines.map((l) => flatLineOf(app, l))
  );
  const shown =
    s.stream === 'both' ? all : all.filter((l) => l.stream === s.stream);
  // one host: by stamp, and within a stamp by arrival (lines arrive as they are written); several hosts: by arrival
  const byArrival = shown.sort((a, b) => a.seq - b.seq);
  const out = hosts.length <= 1 ? sortByStamp(byArrival) : byArrival;
  flatMemo = { logs: s.logs, key, out };
  return out;
}
/** One merged line per buffered line, for good: the screen keeps each line's rows cached on this object. */
const flatLines = new WeakMap<BufferedLine, FlatLine>();
function flatLineOf(app: string, l: BufferedLine): FlatLine {
  let f = flatLines.get(l);
  if (!f) {
    f = { app, stream: l.stream, text: l.text, seq: l.seq };
    flatLines.set(l, f);
  }
  return f;
}
let flatMemo: {
  logs: MonitState['logs'];
  key: string;
  out: FlatLine[];
} | null = null;

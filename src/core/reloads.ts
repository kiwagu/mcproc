import { McprocError } from './errors.js';
import {
  bodyOf,
  cut,
  MATCH_BUDGET_MS,
  MAX_LINE,
  runOwnPatterns,
  stampOf,
} from './incidents/detect.js';
import { msStamp } from './logsince.js';
import { stripAnsi } from './logs.js';
import type { ReloadSettings } from './manifest.js';

/**
 * Marker lines closer together than this are one reload: a rebuild prints one line per changed file (a library rebuild
 * under Vite printed 43 `page reload` lines within milliseconds), and a restart is followed by the server's new
 * `listening` line within a second.
 */
export const RELOAD_GAP_MS = 2000;
export type ReloadKind = 'restart' | 'rebuild' | 'relisten';
export interface ReloadMarker {
  id: string;
  re: RegExp;
  kind: ReloadKind;
}
/** How dev tools report a reload inside their own process, which pm2 never sees (matched against the line without pm2's stamp and without ANSI). */
export const BUILTIN_RELOAD_MARKERS: ReloadMarker[] = [
  { id: 'tsx', re: /\[tsx\] .*\bRestarting\.\.\./, kind: 'restart' },
  {
    id: 'nodemon',
    re: /\[nodemon\] restarting due to changes/,
    kind: 'restart',
  },
  { id: 'node-watch', re: /^\s*Restarting '[^']+'\s*$/, kind: 'restart' },
  {
    id: 'vite',
    re: /\[vite\] (?:\(client\) )?(?:page reload|hmr update)\b/,
    kind: 'rebuild',
  },
  // `✓ Compiled /page in` (with a route) is a first compile of that page, not a reload
  { id: 'next', re: /✓ Compiled in \d|\bReload env: /, kind: 'rebuild' },
  {
    id: 'tsc',
    re: /File change detected\. Starting incremental compilation/,
    kind: 'rebuild',
  },
  // an app's own startup line: the first burst after the start is the boot, every later one a reload (bun --watch prints nothing else)
  { id: 'listening', re: /\blistening (?:on|at)\b/i, kind: 'relisten' },
];

/** The built-in markers in force, and the app's own patterns as written (they run under a time budget, see runOwnPatterns). */
export interface ReloadRules {
  markers: ReloadMarker[];
  match: string[];
  ignore: string[];
  budgetMs: number;
}
export function compileReloadRules(
  s: ReloadSettings,
  budgetMs = MATCH_BUDGET_MS
): ReloadRules {
  return {
    markers: s.defaults ? BUILTIN_RELOAD_MARKERS : [],
    match: s.match,
    ignore: s.ignore,
    budgetMs,
  };
}

/** One reload: a burst of marker lines; `line` is its first one (stamp kept), `marker` the id that line matched. */
export interface Reload {
  time: string | null;
  last_time: string | null;
  lines: number;
  line: string;
  marker: string;
}
/** A line as pm2 wrote it (stamp included); each stream's lines come in file order. */
export interface ReloadInput {
  stream: 'out' | 'err';
  text: string;
}
/**
 * `start`: when the process started (pm2's stamp format); lines before it belong to an earlier run in the same file.
 * `coversStart`: the lines read begin at or before that start, so their first burst may be the boot.
 */
export interface DetectOptions {
  app: string;
  start: string | null;
  coversStart: boolean;
}

type Kind = Pick<ReloadMarker, 'id' | 'kind'>;
const CUSTOM: Kind = { id: 'custom', kind: 'rebuild' };
type Stream = ReloadInput['stream'];
/** Each stream's last stamp as pm2 wrote it (whole seconds or milliseconds), which its unstamped lines inherit. */
type LastStamp = Record<Stream, string | null>;
interface Hit {
  time: string | null;
  ms: number | null;
  plain: string;
  marker: Kind;
}
interface Burst {
  first: Hit;
  lastTime: string | null;
  lastMs: number | null;
  lines: number;
  relistenOnly: boolean;
}
interface Timed {
  time: string | null;
  ms: number | null;
  plain: string;
  stream: Stream;
  i: number;
}

/**
 * Whether a stamp is before the start. A stamp in whole seconds (a log written before millisecond stamps were set up)
 * is compared with the start's second: read as `.000`, the boot line logged in the start's own second would fall
 * before a start such as `…:05.700` and the next re-listen would be taken for the boot.
 */
export const beforeStart = (stamp: string, start: string): boolean =>
  stamp < (stamp.length > 19 ? start : start.slice(0, 19));

/**
 * A log read from its first byte began with this run when its first stamped line comes this soon after the start (a
 * slow boot included); a log cleared during the run (flush, monit's c) also begins at byte 0, with lines from long after.
 */
export const FRESH_LOG_MS = 60_000;

/**
 * How far one stream's lines reach back toward the start. `start`: they hold a line of an earlier run (stamped before
 * the start), or the read began at the file's first byte (or where it began is not known: a follower's history) and
 * its first stamped line comes soon after the start. `nothing`: no line at all, so this run left nothing there to
 * count. `after`: the read is the last part of a longer log, the log was cleared during the run, or its lines carry no
 * stamp and cannot be placed.
 */
export type Reach = 'start' | 'nothing' | 'after';

const wallMs = (stamp: string): number => Date.parse(`${msStamp(stamp)}Z`);

/** `fromFirstByte`: whether the read began at the file's first byte; undefined when the reader cannot tell. */
export function reach(
  lines: string[],
  started: string,
  fromFirstByte?: boolean
): Reach {
  const stamps = lines.map(stampOf).filter((t): t is string => t !== null);
  if (stamps.some((t) => beforeStart(t, started))) return 'start';
  if (fromFirstByte === false) return 'after';
  if (lines.length === 0) return 'nothing';
  if (stamps.length === 0) return 'after';
  return wallMs(stamps[0]) - wallMs(started) <= FRESH_LOG_MS
    ? 'start'
    : 'after';
}

/** When a reload happened, as its first marker line's stamp was written (seconds or milliseconds), else the burst's time. */
export const reloadStamp = (r: Reload): string | null =>
  stampOf(r.line) ?? r.time;

/**
 * Each line's time: its stamp in milliseconds, or the previous stamp of its own stream (`last` carries it across
 * calls). With a start, lines before it and lines that cannot be placed are dropped. The rest are ordered by time,
 * out before err on equal time, file order within a stream; untimed lines go first. Times are host-local wall clock,
 * parsed as UTC only to subtract them.
 */
function timed(
  input: ReloadInput[],
  start: string | null,
  last: LastStamp
): Timed[] {
  const lines: Timed[] = [];
  input.forEach((l, i) => {
    const plain = stripAnsi(l.text);
    const own = stampOf(plain);
    if (own !== null) last[l.stream] = own;
    const stamp = own ?? last[l.stream];
    if (start !== null && (stamp === null || beforeStart(stamp, start))) return;
    const time = stamp === null ? null : msStamp(stamp);
    const ms = time === null ? null : Date.parse(`${time}Z`);
    lines.push({ time, ms, plain, stream: l.stream, i });
  });
  const rank = (s: Stream) => (s === 'out' ? 0 : 1);
  return lines.sort((a, b) =>
    a.ms !== b.ms
      ? a.ms === null
        ? -1
        : b.ms === null
          ? 1
          : a.ms - b.ms
      : rank(a.stream) - rank(b.stream) || a.i - b.i
  );
}

/** Per body: the app's own ignore drops it, its own match makes it a reload, else the first built-in marker that tests true. */
function classify(
  bodies: string[],
  rules: ReloadRules,
  app: string
): (Kind | null)[] {
  const own = runOwnPatterns(
    bodies,
    rules.match,
    rules.ignore,
    rules.budgetMs,
    () =>
      new McprocError(
        'TIMEOUT',
        `the reloads patterns of ${app} ran over ${rules.budgetMs} ms on its log: one of them backtracks without end on these lines`,
        {
          hint: `Simplify apps.${app}.reloads.match/ignore (a repeat inside a repeat, or alternatives that match the same text).`,
        }
      )
  );
  return bodies.map((b, k) =>
    own?.[k] === 2
      ? null
      : own?.[k] === 1
        ? CUSTOM
        : (rules.markers.find((m) => m.re.test(b)) ?? null)
  );
}

/** The marker lines among the input, in time order. Bodies are matched as far as an incident line shows them, so a huge line stays cheap. */
function hits(
  input: ReloadInput[],
  rules: ReloadRules,
  opts: DetectOptions,
  last: LastStamp
): Hit[] {
  const lines = timed(input, opts.start, last);
  const kinds = classify(
    lines.map((l) => bodyOf(l.plain).slice(0, MAX_LINE)),
    rules,
    opts.app
  );
  const out: Hit[] = [];
  lines.forEach((l, k) => {
    const marker = kinds[k];
    if (marker) out.push({ time: l.time, ms: l.ms, plain: l.plain, marker });
  });
  return out;
}

/**
 * A marker joins the open burst when it comes less than RELOAD_GAP_MS after the burst's last one and less than that
 * before its first one: a line flushed late from inside the burst's span still joins, while a marker pushed later
 * with a much older stamp starts a burst of its own. An untimed marker always joins; a timed one never joins an
 * untimed burst, whose age is unknown.
 */
const joins = (b: Burst, h: Hit): boolean =>
  h.ms === null ||
  (b.lastMs !== null &&
    h.ms - b.lastMs < RELOAD_GAP_MS &&
    (b.first.ms === null || b.first.ms - h.ms < RELOAD_GAP_MS));
const opened = (h: Hit): Burst => ({
  first: h,
  lastTime: h.time,
  lastMs: h.ms,
  lines: 1,
  relistenOnly: h.marker.kind === 'relisten',
});
/** A marker older than the burst's first line (pushed in a later call) becomes its first, as it would in one call. */
function add(b: Burst, h: Hit): void {
  b.lines++;
  b.relistenOnly &&= h.marker.kind === 'relisten';
  if (h.ms !== null && b.first.ms !== null && h.ms < b.first.ms) b.first = h;
  if (h.ms !== null && (b.lastMs === null || h.ms >= b.lastMs)) {
    b.lastMs = h.ms;
    b.lastTime = h.time;
  }
}
const reloadOf = (b: Burst): Reload => ({
  time: b.first.time,
  last_time: b.lastTime,
  lines: b.lines,
  line: cut(b.first.plain),
  marker: b.first.marker.id,
});

/**
 * Reloads as lines arrive (a follower's pushes). A burst is reported once it is closed: by a marker RELOAD_GAP_MS or
 * more after its last line, by one RELOAD_GAP_MS or more older than its first line, or by `idle` once no marker has
 * ARRIVED for that long. Arrival is wall time, not the stamps: a quiet log has no later stamp to compare with.
 */
export class ReloadTracker {
  private last: LastStamp = { out: null, err: null };
  private open: Burst | null = null;
  private openWall = 0; // when the open burst's last marker arrived
  private bootPending: boolean; // the first burst to close may still be the boot

  constructor(
    private readonly rules: ReloadRules,
    private readonly opts: DetectOptions
  ) {
    this.bootPending = opts.coversStart;
  }

  /**
   * The reloads these lines completed. One call carries every stream's new lines, as the log follower delivers them:
   * lines are put in time order within a call only, so a stream held back for a later call would bring older stamps,
   * and a marker RELOAD_GAP_MS or more older than the open burst's first line closes it rather than joining it. A call
   * that throws (TIMEOUT on the app's own patterns) leaves the tracker as it was.
   */
  push(input: ReloadInput[], nowMs: number): Reload[] {
    // the streams' stamps advance on a copy, kept only once classification succeeded
    const last = { ...this.last };
    const found = hits(input, this.rules, this.opts, last);
    this.last = last;
    const done: Reload[] = [];
    for (const h of found) {
      if (this.open && joins(this.open, h)) add(this.open, h);
      else {
        this.close(done);
        this.open = opened(h);
      }
      this.openWall = nowMs;
    }
    return done;
  }

  /** Closes the open burst when no marker arrived for RELOAD_GAP_MS of wall time. */
  idle(nowMs: number): Reload[] {
    const done: Reload[] = [];
    if (this.open && nowMs - this.openWall >= RELOAD_GAP_MS) this.close(done);
    return done;
  }

  /** When `idle` will close the open burst if no marker arrives before then (wall ms); null with no burst open. */
  idleAt(): number | null {
    return this.open ? this.openWall + RELOAD_GAP_MS : null;
  }

  /** Whether the next burst to close is still taken for the boot when it is only `listening` lines: none has closed yet. */
  get awaitingBoot(): boolean {
    return this.bootPending;
  }

  /** Closes the open burst unconditionally. */
  flush(): Reload[] {
    const done: Reload[] = [];
    this.close(done);
    return done;
  }

  /** The first burst after the start, when it is only `listening` lines, is the app booting, not a reload. */
  private close(done: Reload[]): void {
    const b = this.open;
    if (!b) return;
    this.open = null;
    const boot = this.bootPending && b.relistenOnly;
    this.bootPending = false;
    if (!boot) done.push(reloadOf(b));
  }
}

/** The reloads in lines already read: the tracker's rules applied to them at once, the last burst closed at the end. */
export function detectReloads(
  input: ReloadInput[],
  rules: ReloadRules,
  opts: DetectOptions
): Reload[] {
  const t = new ReloadTracker(rules, opts);
  return [...t.push(input, 0), ...t.flush()];
}

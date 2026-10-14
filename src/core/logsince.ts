import { McprocError, describeError } from './errors.js';
import { stampOf } from './incidents/detect.js';
import {
  readSnippet,
  parseRead,
  type FileMark,
  type Anchor,
  type FileRead,
} from './incidents/cursor.js';
import { findProcess } from './pm2.js';
import type { Fleet, HostError } from './fleet.js';
import { keepSgr, stripAnsi } from './logs.js';
import { ensureOk } from '../transport/index.js';

export type SinceSpec =
  | { kind: 'relative'; ms: number }
  | { kind: 'local'; stamp: string }
  | { kind: 'instant'; epochMs: number }
  | { kind: 'last' }
  | { kind: 'tail'; n: number };
export const MAX_RELATIVE_MS = 24 * 3600_000;
/** `since: last` with no mark yet reads this many last lines of each file: a plain recent tail, not a guessed window. */
export const FIRST_LAST_LINES = 100;

const RELATIVE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const ABSOLUTE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/;
const UNIT: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};
const HINT =
  "since is a span like 90s, 5m or 2h (at most 24h), a time like 2026-10-14T07:30[:00[.000]] in the host's local time (add Z or +02:00 for an absolute instant), or last (MCP only: since your previous logs call).";
const bad = (s: string) =>
  new McprocError('BAD_ARGUMENT', `unknown since "${s}"`, { hint: HINT });

export function parseSince(s: string): SinceSpec {
  if (s === 'last') return { kind: 'last' };
  const rel = RELATIVE.exec(s);
  if (rel) {
    const ms = Math.round(Number(rel[1]) * UNIT[rel[2]]);
    if (!(ms > 0) || ms > MAX_RELATIVE_MS) throw bad(s);
    return { kind: 'relative', ms };
  }
  const abs = ABSOLUTE.exec(s);
  if (!abs) throw bad(s);
  const [, date, hh, mm, ss = '00', frac = '0', zone] = abs;
  const stamp = `${date}T${hh}:${mm}:${ss}.${frac.padEnd(3, '0')}`;
  const wall = wallMs(stamp);
  if (Number.isNaN(wall)) throw bad(s);
  if (!zone) return { kind: 'local', stamp };
  const offsetMin =
    zone === 'Z'
      ? 0
      : (zone[0] === '-' ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return { kind: 'instant', epochMs: wall - offsetMin * 60_000 };
}

/** A host's wall clock as its `date` prints it: `now` in pm2's stamp shape (seconds), `zone` as `+hhmm`. */
export interface HostClock {
  now: string;
  zone: string;
}

/** Asks the host for its wall clock and UTC offset in one line; `hostClock` reads it back from the script's output. */
export const CLOCK_SNIPPET = `echo "__MCPROC_LS_CLOCK__ $(date '+%Y-%m-%dT%H:%M:%S %z' 2>/dev/null)"`;
/** null when the marker is missing or garbled (a host whose `date` printed nothing or another shape). */
export const hostClock = (stdout: string): HostClock | null => {
  const m =
    /__MCPROC_LS_CLOCK__ (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d) ([+-]\d{4})/.exec(
      stdout
    );
  return m ? { now: m[1], zone: m[2] } : null;
};

/** A wall-clock instant held as if it were UTC, in pm2's millisecond stamp shape. */
const wallStamp = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 23);
/**
 * A wall-clock stamp read as if it were UTC; NaN when it names no real time. Date.parse rolls `02-30` or `24:00`
 * over to the next day, so the stamp must come back unchanged.
 */
function wallMs(stamp: string): number {
  const ms = Date.parse(`${stamp}Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(stamp)
    ? ms
    : Number.NaN;
}
const HOST_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
/** The host's `date +%z` (`+0200`) as milliseconds east of UTC; null when it is not one. */
const zoneMs = (zone: string): number | null => {
  const m = /^([+-])([01]\d|2[0-3])([0-5]\d)$/.exec(zone);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};
/** An instant (epoch ms) as the host's wall time in pm2's millisecond stamp shape; null for a zone that does not parse. */
export function hostStamp(epochMs: number, zone: string): string | null {
  const z = zoneMs(zone);
  return z === null ? null : wallStamp(epochMs + z);
}
const noClock = () =>
  new McprocError(
    'TRANSPORT_FAILED',
    'the host did not report a readable clock and zone, so a relative time or a time with a zone cannot be placed there',
    {
      hint: "Pass a time without a zone (2026-10-14T07:30), read as the host's local time, or check that `date` works on that host.",
    }
  );

/** The pm2 stamp (host-local, with milliseconds) a line must reach; null when the spec selects by position, not time. */
export function cutoffFor(
  spec: SinceSpec,
  clock: HostClock | null
): string | null {
  switch (spec.kind) {
    case 'last':
    case 'tail':
      return null;
    case 'local':
      return spec.stamp;
    case 'relative': {
      // the host's wall time read as if UTC: pure arithmetic on wall clocks, so only the clock is needed
      const now =
        clock && HOST_NOW.test(clock.now) ? wallMs(clock.now) : Number.NaN;
      if (Number.isNaN(now)) throw noClock();
      return wallStamp(now - spec.ms);
    }
    case 'instant': {
      // an instant becomes the host's wall time through its zone alone
      const zone = clock ? zoneMs(clock.zone) : null;
      if (zone === null) throw noClock();
      return wallStamp(spec.epochMs + zone);
    }
  }
}

/** pm2's stamp of a line, normalised to milliseconds (`…:ss` reads as `…:ss.000`); null for an unstamped line. */
export function stampMs(line: string): string | null {
  const t = stampOf(line);
  return t === null || t.length > 19 ? t : `${t}.000`;
}

export interface Stamped {
  time: string | null;
  text: string;
}
/**
 * The lines at or after the cutoff. An unstamped line (a stack frame, a continuation) belongs to the stamped line
 * before it and inherits its time; lines before the first stamp cannot be placed and are dropped (kept with a null
 * cutoff). `beforeCutoff` counts stamped lines older than the cutoff: 0 means the window may have been cut short.
 */
export function selectSince(
  lines: string[],
  cutoff: string | null
): { kept: Stamped[]; beforeCutoff: number } {
  const kept: Stamped[] = [];
  let current: string | null = null;
  let beforeCutoff = 0;
  for (const text of lines) {
    const t = stampMs(text);
    if (t !== null) current = t;
    if (cutoff !== null) {
      if (current === null) continue;
      if (current < cutoff) {
        if (t !== null) beforeCutoff++;
        continue;
      }
    }
    kept.push({ time: current, text });
  }
  return { kept, beforeCutoff };
}

export interface SinceLine {
  app: string;
  host: string;
  stream: 'out' | 'err';
  time: string | null;
  text: string;
}
/**
 * Stable order by the moment each line was written (an unstamped line already carries its inherited time), then the
 * LAST `cap` lines are kept. pm2 stamps in its host's local time, so a stamp read as UTC minus its host's offset
 * (`offsets`, ms east of UTC; a host without one counts as UTC) places hosts in different zones on one timeline. A
 * line without a time sorts as the oldest.
 */
export function mergeLines(
  lines: SinceLine[],
  cap: number,
  offsets: Record<string, number> = {}
): { lines: SinceLine[]; truncated: number } {
  const moment = (l: SinceLine): number => {
    const ms = l.time === null ? Number.NaN : Date.parse(`${l.time}Z`);
    return Number.isNaN(ms)
      ? Number.NEGATIVE_INFINITY
      : ms - (offsets[l.host] ?? 0);
  };
  const sorted = lines
    .map((l, i) => ({ l, i, k: moment(l) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((x) => x.l);
  const truncated = Math.max(0, sorted.length - cap);
  return { lines: sorted.slice(truncated), truncated };
}

/** Where the merged reads of one MCP session stopped, per file; never shared with other sessions or callers. */
export class LogMarks {
  private readonly m = new Map<string, { out?: FileMark; err?: FileMark }>();
  static key(manifestPath: string, host: string, app: string): string {
    return `${manifestPath}|${host}/${app}`;
  }
  get(key: string): { out?: FileMark; err?: FileMark } | undefined {
    return this.m.get(key);
  }
  set(key: string, stream: 'out' | 'err', mark: FileMark): void {
    const e = this.m.get(key) ?? {};
    e[stream] = mark;
    this.m.set(key, e);
  }
}
/**
 * Where the next read of a file goes on after this one: the end of its last complete line, with the anchor of the
 * bytes before it (taken at that offset, so a follower that continues there can tell a replaced file from a grown one).
 */
export const sinceMark = (path: string, r: FileRead): FileMark => ({
  path,
  offset: r.nextOffset,
  ...(r.nextAnchor ? { at: r.nextAnchor.at, anchor: r.nextAnchor.hex } : {}),
});
export const MAX_MERGED_LINES = 2000;
export interface SinceOptions {
  since: SinceSpec;
  lines?: number;
  stream?: 'out' | 'err' | 'both';
  marks?: LogMarks;
  keepColors?: boolean;
}
export interface SinceAnswer {
  mode: SinceSpec['kind'];
  since: Record<string, string | null>;
  lines: SinceLine[];
  truncated: number;
  skipped: {
    app: string;
    host: string;
    stream: 'out' | 'err';
    bytes: number;
  }[];
  not_started: string[];
  /** hosts whose UTC offset could not be read: their lines are placed by their raw stamps among the other hosts' */
  unzoned: string[];
  errors: HostError[];
  apps: number;
  hosts: number;
}
const STREAMS = ['out', 'err'] as const;

interface HostRead {
  host: string;
  cutoff: string | null;
  /** the host's UTC offset in ms; null when its clock line or zone could not be read */
  offset: number | null;
  lines: SinceLine[];
  skipped: SinceAnswer['skipped'];
  notStarted: string[];
}
interface HostFailure {
  host: string;
  error: HostError;
  cause: unknown;
}

/**
 * The lines of the named apps since the cutoff (or since the session's marks, or the last n per file), each app read
 * on its own host, hosts in parallel: one jlist and one read script per host, the host's clock in the same script.
 * A host that fails is a note for its apps unless none answers.
 */
export async function readSince(
  fleet: Fleet,
  names: string[],
  opts: SinceOptions
): Promise<SinceAnswer> {
  const spec = opts.since;
  const clampLines = (n: number) =>
    Math.min(Math.max(1, Math.trunc(n)), MAX_MERGED_LINES);
  const tailN = spec.kind === 'tail' ? clampLines(spec.n) : 0;
  const cap = clampLines(
    opts.lines ?? (spec.kind === 'tail' ? tailN : MAX_MERGED_LINES)
  );
  const stream = opts.stream ?? 'both';
  // only the requested streams are read, so the other stream's mark stays where its last read left it
  const streams = STREAMS.filter((s) => stream === 'both' || s === stream);
  const clean = opts.keepColors ? keepSgr : stripAnsi;
  const groups = fleet.groups(names);
  const perHost = await Promise.all(
    groups.map(async (g): Promise<HostRead | HostFailure> => {
      try {
        const ctx = await fleet.ctx(g.host);
        const procs = await ctx.pm2.jlist();
        const targets = g.apps.flatMap((app) => {
          const p = findProcess(procs, fleet.manifest.project, app);
          return p ? [{ app, p }] : [];
        });
        const notStarted = g.apps.filter(
          (a) => !targets.some((t) => t.app === a)
        );
        const files = targets.flatMap((t) =>
          streams.map((stream) => {
            const path = stream === 'out' ? t.p.out_log : t.p.err_log;
            const key = LogMarks.key(fleet.manifest.path, g.host, t.app);
            const mark =
              spec.kind === 'last' ? opts.marks?.get(key)?.[stream] : undefined;
            const same = mark !== undefined && mark.path === path;
            const anchor: Anchor | null =
              same && mark.at !== undefined && mark.anchor !== undefined
                ? { at: mark.at, hex: mark.anchor }
                : null;
            return {
              app: t.app,
              stream,
              path,
              key,
              offset: same ? mark.offset : null,
              anchor,
              hadMark: same,
            };
          })
        );
        // the clock always, so the header can say the cutoff even when nothing runs here
        const script = [
          CLOCK_SNIPPET,
          ...files.map((f, i) => readSnippet(i, f.path, f.offset, f.anchor)),
        ].join('; ');
        const res = ensureOk(
          await ctx.transport.exec(script),
          ctx.host,
          'read logs since'
        );
        const clock = hostClock(res.stdout);
        const cutoff = cutoffFor(spec, clock);
        const offset = clock ? zoneMs(clock.zone) : null;
        const lines: SinceLine[] = [];
        const skipped: SinceAnswer['skipped'] = [];
        files.forEach((f, i) => {
          const r = parseRead(res.stdout, i, f.offset, { clean });
          // a read cut short (the file changed meanwhile) is not used: no lines, the old mark kept, read again next time
          if (!r || r.short) return;
          // stamps are taken over every line read, so a slice that begins on a continuation line still knows its time
          const sel = selectSince(r.lines, cutoff);
          // a cutoff selects by time; without one (last, tail) every line is kept, in step with r.lines, and position
          // selects: past a mark only the part after it, else the last n of the file
          let kept = sel.kept;
          if (f.hadMark) kept = kept.slice(r.contextOnly);
          else if (spec.kind === 'tail') kept = kept.slice(-tailN);
          else if (spec.kind === 'last') kept = kept.slice(-FIRST_LAST_LINES);
          // the 1 MB cap bit (the read began past byte 0) and nothing older than the cutoff was seen: lines between
          // the cutoff and the window start may be missing
          if (
            cutoff !== null &&
            r.start > 0 &&
            sel.beforeCutoff === 0 &&
            sel.kept.length > 0
          )
            skipped.push({
              app: f.app,
              host: g.host,
              stream: f.stream,
              bytes: r.start,
            });
          if (spec.kind === 'last' && r.skipped > 0)
            skipped.push({
              app: f.app,
              host: g.host,
              stream: f.stream,
              bytes: r.skipped,
            });
          for (const k of kept)
            lines.push({
              app: f.app,
              host: g.host,
              stream: f.stream,
              time: k.time,
              text: k.text,
            });
          if (opts.marks) opts.marks.set(f.key, f.stream, sinceMark(f.path, r));
        });
        return { host: g.host, cutoff, offset, lines, skipped, notStarted };
      } catch (e) {
        return {
          host: g.host,
          error: { host: g.host, apps: g.apps, message: describeError(e) },
          cause: e,
        };
      }
    })
  );
  const failed = perHost.filter((h): h is HostFailure => 'error' in h);
  if (failed.length === perHost.length && failed.length > 0)
    throw failed[0].cause;
  const ok = perHost.filter((h): h is HostRead => !('error' in h));
  // the reads come back grouped by host: equal moments follow the order of the names, then out before err, then file order
  const rank = new Map(names.map((n, i) => [n, i]));
  const byName = (a: string, b: string) =>
    (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  // each host's stamps are its local time: its offset puts them on one timeline (a host without a zone stays as stamped)
  const merged = mergeLines(
    ok.flatMap((h) => h.lines).sort((a, b) => byName(a.app, b.app)),
    cap,
    Object.fromEntries(ok.map((h) => [h.host, h.offset ?? 0]))
  );
  // a host without a zone can only be misplaced against another host's lines
  const withLines = ok.filter((h) => h.lines.length > 0);
  const unzoned =
    withLines.length > 1
      ? withLines.filter((h) => h.offset === null).map((h) => h.host)
      : [];
  return {
    mode: spec.kind,
    since: Object.fromEntries(ok.map((h) => [h.host, h.cutoff])),
    lines: merged.lines,
    truncated: merged.truncated,
    skipped: ok.flatMap((h) => h.skipped),
    not_started: ok.flatMap((h) => h.notStarted).sort(byName),
    unzoned,
    errors: failed.map((f) => f.error),
    apps: names.length,
    hosts: groups.length,
  };
}

import { McprocError } from './errors.js';
import { stampOf } from './incidents/detect.js';

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
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;
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
  const wall = Date.parse(`${stamp}Z`);
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

/** A wall-clock instant held as if it were UTC, in pm2's millisecond stamp shape. */
const wallStamp = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 23);
const zoneMs = (zone: string): number => {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(zone);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};
const noClock = () =>
  new McprocError(
    'TRANSPORT_FAILED',
    'the host did not report its clock, so a relative since cannot be placed',
    {
      hint: 'Pass an absolute time (2026-10-14T07:30) instead, or check that `date` works on that host.',
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
    case 'relative':
      if (!clock) throw noClock();
      // the host's wall time read as if UTC: pure arithmetic on wall clocks, no zone involved
      return wallStamp(Date.parse(`${clock.now}Z`) - spec.ms);
    case 'instant':
      if (!clock) throw noClock();
      return wallStamp(spec.epochMs + zoneMs(clock.zone));
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
/** Stable order by time (an unstamped line already carries its inherited time); the LAST `cap` lines are kept. */
export function mergeLines(
  lines: SinceLine[],
  cap: number
): { lines: SinceLine[]; truncated: number } {
  const sorted = lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => {
      const ta = a.l.time ?? '';
      const tb = b.l.time ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
    })
    .map((x) => x.l);
  const truncated = Math.max(0, sorted.length - cap);
  return { lines: sorted.slice(truncated), truncated };
}

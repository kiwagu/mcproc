import { msStamp } from '../logsince.js';
import { markKey, type CursorState } from './cursor.js';
import type { Incident, Stream } from './detect.js';

/** How far the takes have read one file: the latest pm2 stamp read (ms), and the file and offset the last take reached. */
export interface TakenPoint {
  stamp: string;
  path: string;
  offset: number;
}
/**
 * Per `host/app` and stream, how far the takes have read: an incident stamped before the point has been taken. A take
 * records it with the file's position; a peek leaves it as it was, and a clear carries the stamp into the fresh file.
 */
export type TakenPoints = Record<string, Partial<Record<Stream, TakenPoint>>>;
/** Where the read that found an incident ended in its file: what a reader with its own position (monit) knows of it. */
export interface ReadEnd {
  path: string;
  offset: number;
}

/** The taken points of a stored pick-up point; a malformed entry gives none. */
export function takenPoints(s: CursorState): TakenPoints {
  const out: TakenPoints = {};
  for (const [key, m] of Object.entries(s.apps ?? {})) {
    const p: Partial<Record<Stream, TakenPoint>> = {};
    for (const stream of ['out', 'err'] as const) {
      const f = (m as unknown as Record<string, unknown> | null)?.[stream] as
        | { stamp?: unknown; path?: unknown; offset?: unknown }
        | undefined;
      if (
        typeof f?.stamp === 'string' &&
        typeof f.path === 'string' &&
        typeof f.offset === 'number'
      )
        p[stream] = { stamp: f.stamp, path: f.path, offset: f.offset };
    }
    if (p.out || p.err) out[key] = p;
  }
  return out;
}

/**
 * Whether a take has passed the incident. Stamped before the last line a take read in its file: taken (a line written
 * after the take is stamped no earlier). Stamped the same: a line written right after the take can carry that stamp
 * too, so only a read that ended where the take had read up to, in the same file, proves it (`end`). An unstamped
 * incident or a reload never counts as taken.
 */
export function isTaken(
  i: Incident,
  points: TakenPoints,
  end?: ReadEnd
): boolean {
  if (i.kind === 'reloaded' || !i.time) return false;
  const p = points[markKey(i.host, i.app)]?.[i.stream];
  if (!p) return false;
  const t = msStamp(i.time);
  const s = msStamp(p.stamp);
  if (t !== s) return t < s;
  return !!end && end.path === p.path && end.offset <= p.offset;
}

/** The later of two stamps, normalised to milliseconds; undefined when neither is there. */
export function laterStamp(
  a: string | null | undefined,
  b: string | null | undefined
): string | undefined {
  const x = a ? msStamp(a) : undefined;
  const y = b ? msStamp(b) : undefined;
  if (!x) return y;
  if (!y) return x;
  return x >= y ? x : y;
}

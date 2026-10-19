import { msStamp } from '../logsince.js';
import { markKey, type CursorState } from './cursor.js';
import type { Incident, Stream } from './detect.js';

/**
 * Per `host/app` and stream, the latest pm2 time stamp the takes have read in that file: an incident stamped at or
 * before it has been taken. A take records it with the file's position; a peek and a clear leave it as it was.
 */
export type TakenPoints = Record<string, Partial<Record<Stream, string>>>;

/** The taken points of a stored pick-up point; a malformed entry gives none. */
export function takenPoints(s: CursorState): TakenPoints {
  const out: TakenPoints = {};
  for (const [key, m] of Object.entries(s.apps ?? {})) {
    const p: Partial<Record<Stream, string>> = {};
    for (const stream of ['out', 'err'] as const) {
      const stamp = (m as unknown as Record<string, unknown> | null)?.[
        stream
      ] as { stamp?: unknown } | undefined;
      if (typeof stamp?.stamp === 'string') p[stream] = stamp.stamp;
    }
    if (p.out || p.err) out[key] = p;
  }
  return out;
}

/** Whether a take has passed the incident: its stamp is at or before the point of its own file. An unstamped incident never is. */
export function isTaken(i: Incident, points: TakenPoints): boolean {
  if (i.kind === 'reloaded' || !i.time) return false;
  const at = points[markKey(i.host, i.app)]?.[i.stream];
  return at !== undefined && msStamp(i.time) <= msStamp(at);
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

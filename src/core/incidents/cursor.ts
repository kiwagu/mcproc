import { stripAnsi } from '../logs.js';
import { shq } from '../../transport/quote.js';
import { stampOf } from './detect.js';

/** At most this many new bytes are read per file per poll; when more is new, the most recent part is read. */
export const READ_CAP = 1048576;
/** Bytes before the new part read as context, so an error at the start of the new part still gets lines before it. */
export const CONTEXT_BYTES = 4096;

export interface FileMark { path: string; offset: number }
export interface AppMark { out?: FileMark; err?: FileMark; restarts: number; status: string }
/** Where the previous poll stopped: per `host/app` the read offset of each log file, pm2's restart count and status. */
export interface CursorState { v: 1; apps: Record<string, AppMark> }

export const markKey = (host: string, app: string): string => `${host}/${app}`;

/** A poll covers some apps; the entries of the others stay as they were. */
export function mergeCursor(base: CursorState | undefined, next: CursorState): CursorState {
  return { v: 1, apps: { ...(base?.apps ?? {}), ...next.apps } };
}

/**
 * Shell for one file: its size, where the new part starts (the offset; 0 for a first call or a file that shrank; never
 * more than READ_CAP before the end), where the read starts (CONTEXT_BYTES earlier), then those bytes.
 */
export function readSnippet(id: number, file: string, offset: number | null): string {
  const f = shq(file);
  return [
    `echo __MCPROC_INC_${id}__`,
    `sz=$(wc -c < ${f} 2>/dev/null || echo 0); sz=$((sz+0)); off=${offset ?? -1}`,
    'if [ "$off" -ge 0 ] && [ "$sz" -ge "$off" ]; then st=$off; else st=0; fi',
    `if [ $((sz-st)) -gt ${READ_CAP} ]; then st=$((sz-${READ_CAP})); fi`,
    `cs=$((st-${CONTEXT_BYTES})); if [ "$cs" -lt 0 ]; then cs=0; fi`,
    'echo "$sz $st $cs"',
    `if [ "$sz" -gt "$cs" ]; then tail -c +$((cs+1)) ${f} 2>/dev/null | head -c $((sz-cs)); fi`,
  ].join('; ');
}

export interface FileRead { size: number; start: number; skipped: number; lines: string[]; contextOnly: number; nextOffset: number }

/** One file's section of the read script's output: its lines (escapes removed), how many are context, where to go on. */
export function parseRead(stdout: string, id: number, offset: number | null): FileRead | null {
  const mark = `__MCPROC_INC_${id}__\n`;
  const at = stdout.indexOf(mark);
  if (at < 0) return null;
  const next = stdout.indexOf(`__MCPROC_INC_${id + 1}__\n`, at);
  let sec = stdout.slice(at + mark.length, next < 0 ? undefined : next);
  const nl = sec.indexOf('\n');
  const [size, start, ctxStart] = sec.slice(0, nl).trim().split(/\s+/).map((n) => Number(n) || 0);
  sec = nl < 0 ? '' : sec.slice(nl + 1);
  const buf = Buffer.from(sec, 'utf8');
  const ctxBytes = Math.max(0, start - ctxStart);
  const complete = buf.lastIndexOf(0x0a) + 1; // bytes up to and including the last newline
  const partial = buf.length - complete;
  let pos = 0;
  const lines: string[] = [];
  let contextOnly = 0;
  for (const raw of buf.subarray(0, complete).toString('utf8').split('\n').slice(0, -1)) {
    const lineStart = pos;
    pos += Buffer.byteLength(raw, 'utf8') + 1;
    if (lineStart === 0 && ctxStart > 0) continue; // the read began mid-line: that head is only a fragment
    if (lineStart < ctxBytes) contextOnly++;
    lines.push(stripAnsi(raw));
  }
  const skipped = offset !== null && offset >= 0 && size >= offset ? Math.max(0, start - offset) : 0;
  return { size, start, skipped, lines, contextOnly, nextOffset: Math.max(start, size - partial) };
}

/**
 * For a first call: the stamp `sinceMin` minutes before `now`, the host's current time in pm2's stamp shape (that host's
 * own clock and zone, never the agent's). Without it (a host whose `date` printed nothing), before the newest stamp here.
 * Lines without any stamp (an app with pm2's `time: false`) cannot be placed in time: no window, every line counts.
 */
export function windowStart(lines: string[], sinceMin: number, now: string | null = null): string | null {
  if (!lines.some((l) => stampOf(l) !== null)) return null;
  let ref = now;
  for (let i = lines.length - 1; i >= 0 && !ref; i--) ref = stampOf(lines[i]);
  return ref ? new Date(Date.parse(`${ref}Z`) - sinceMin * 60_000).toISOString().slice(0, 19) : null;
}

/** Asks the host for its current time in pm2's stamp shape; `hostNow` reads it back from the script's output. */
export const NOW_SNIPPET = `echo "__MCPROC_NOW__ $(date '+%Y-%m-%dT%H:%M:%S' 2>/dev/null)"`;
export const hostNow = (stdout: string): string | null => /__MCPROC_NOW__ (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(stdout)?.[1] ?? null;

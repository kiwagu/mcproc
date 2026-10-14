import { stripAnsi } from '../logs.js';
import { shq } from '../../transport/quote.js';
import { hex16 } from '../../shell/snippets.js';
import { stampOf } from './detect.js';

/** At most this many new bytes are read per file per poll; when more is new, the most recent part is read. */
export const READ_CAP = 1048576;
/** Bytes before the new part read as context, so an error at the start of the new part still gets lines before it. */
export const CONTEXT_BYTES = 4096;

/** `at`/`anchor`: the hex of the 16 bytes before byte `at` when the mark was taken; if they changed, the file was replaced. */
export interface FileMark {
  path: string;
  offset: number;
  at?: number;
  anchor?: string;
}
export interface Anchor {
  at: number;
  hex: string;
}
const HEX = /^[0-9a-f]{0,64}$/;
/** U+FFFD as UTF-8: what the decoding of the read's output put in place of bytes that were not valid UTF-8. */
const REPLACEMENT = Buffer.from('\ufffd');

export interface AppMark {
  out?: FileMark;
  err?: FileMark;
  restarts: number;
  status: string;
}
/** Where the previous poll stopped: per `host/app` the read offset of each log file, pm2's restart count and status. */
export interface CursorState {
  v: 1;
  apps: Record<string, AppMark>;
}

export const markKey = (host: string, app: string): string => `${host}/${app}`;

/** A poll covers some apps; the entries of the others stay as they were. */
export function mergeCursor(
  base: CursorState | undefined,
  next: CursorState
): CursorState {
  return { v: 1, apps: { ...(base?.apps ?? {}), ...next.apps } };
}

/**
 * Shell for one file: its size, where the new part starts (the offset; 0 for a first call or a file that shrank; never
 * more than READ_CAP before the end), where the read starts (CONTEXT_BYTES earlier), then those bytes.
 */
export function readSnippet(
  id: number,
  file: string,
  offset: number | null,
  anchor: Anchor | null = null
): string {
  const f = shq(file);
  const a =
    anchor &&
    HEX.test(anchor.hex) &&
    Number.isInteger(anchor.at) &&
    anchor.at >= 0
      ? anchor
      : null; // the store is a file a person can edit
  return [
    `echo __MCPROC_INC_${id}__`,
    `sz=$(wc -c < ${f} 2>/dev/null || echo 0); sz=$((sz+0)); off=${offset ?? -1}; at=${a ? a.at : -1}; ah='${a ? a.hex : ''}'`,
    `same=1; if [ "$at" -ge 0 ]; then if [ "$sz" -lt "$at" ] || [ "${hex16(f, '$at')}" != "$ah" ]; then same=0; fi; fi`,
    'if [ "$off" -ge 0 ] && [ "$sz" -ge "$off" ] && [ "$same" = 1 ]; then st=$off; else st=0; fi',
    `if [ $((sz-st)) -gt ${READ_CAP} ]; then st=$((sz-${READ_CAP})); fi`,
    `cs=$((st-${CONTEXT_BYTES})); if [ "$cs" -lt 0 ]; then cs=0; fi`,
    `echo "$sz $st $cs ${hex16(f, '$sz')}"`,
    `if [ "$sz" -gt "$cs" ]; then tail -c +$((cs+1)) ${f} 2>/dev/null | head -c $((sz-cs)); fi`,
  ].join('; ');
}

/**
 * `short`: fewer bytes arrived than the read announced (the file changed between measuring and reading): do not analyse
 * or move on. `anchor` is taken at the measured size; `nextAnchor` at `nextOffset`, the end of the last complete line,
 * which is where a reader that goes on from this read starts.
 */
export interface FileRead {
  size: number;
  start: number;
  skipped: number;
  lines: string[];
  contextOnly: number;
  nextOffset: number;
  short: boolean;
  anchor: Anchor | null;
  nextAnchor: Anchor | null;
}

/**
 * One file's section of the read script's output: its lines, how many are context, where to go on. `clean` turns a raw
 * line into the text kept: by default every escape is removed (incidents match plain text); a terminal reader passes
 * keepSgr to keep the colors.
 */
export function parseRead(
  stdout: string,
  id: number,
  offset: number | null,
  opts: { clean?: (line: string) => string } = {}
): FileRead | null {
  const clean = opts.clean ?? stripAnsi;
  const mark = `__MCPROC_INC_${id}__\n`;
  const at = stdout.indexOf(mark);
  if (at < 0) return null;
  const next = stdout.indexOf(`__MCPROC_INC_${id + 1}__\n`, at);
  let sec = stdout.slice(at + mark.length, next < 0 ? undefined : next);
  const nl = sec.indexOf('\n');
  const head = sec.slice(0, nl).trim().split(/\s+/);
  const [size, start, ctxStart] = head.slice(0, 3).map((n) => Number(n) || 0);
  const hex = head[3] ?? '';
  sec = nl < 0 ? '' : sec.slice(nl + 1);
  const buf = Buffer.from(sec, 'utf8');
  const ctxBytes = Math.max(0, start - ctxStart);
  const complete = buf.lastIndexOf(0x0a) + 1; // bytes up to and including the last newline
  const partial = buf.length - complete;
  let pos = 0;
  const lines: string[] = [];
  let contextOnly = 0;
  for (const raw of buf
    .subarray(0, complete)
    .toString('utf8')
    .split('\n')
    .slice(0, -1)) {
    const lineStart = pos;
    pos += Buffer.byteLength(raw, 'utf8') + 1;
    if (lineStart === 0 && ctxStart > 0) continue; // the read began mid-line: that head is only a fragment
    if (lineStart < ctxBytes) contextOnly++;
    lines.push(clean(raw));
  }
  const skipped =
    offset !== null && offset >= 0 && size >= offset
      ? Math.max(0, start - offset)
      : 0;
  const nextOffset = Math.max(start, size - partial);
  const short = buf.length < size - ctxStart;
  const anchor = hex && HEX.test(hex) ? { at: size, hex } : null;
  return {
    size,
    start,
    skipped,
    lines,
    contextOnly,
    nextOffset,
    short,
    anchor,
    nextAnchor: anchorAt(buf, nextOffset, { size, ctxStart, short, anchor }),
  };
}

/**
 * The anchor at `at` (the end of the last complete line, at or before the size) from the bytes a read holds: the hex of
 * the up to 16 bytes before it, as hex16 gives it. Positions are counted back from the end of the read, which is the
 * measured size; null unless every byte from there to the end is in the read and came through the UTF-8 decoding of
 * the output unchanged (a replaced byte changes the length, so its position is no longer known), and the read's last
 * bytes are the ones the anchor at the size was taken from.
 */
function anchorAt(
  buf: Buffer,
  at: number,
  read: {
    size: number;
    ctxStart: number;
    short: boolean;
    anchor: Anchor | null;
  }
): Anchor | null {
  const { size, ctxStart, short, anchor } = read;
  if (at === size) return anchor;
  const n = Math.min(16, at);
  const end = buf.length - (size - at);
  if (!anchor || short || n <= 0 || at - n < ctxStart || end - n < 0)
    return null;
  const tail = buf.subarray(end - n);
  if (tail.includes(REPLACEMENT)) return null;
  if (buf.subarray(-Math.min(16, size)).toString('hex') !== anchor.hex)
    return null;
  return { at, hex: buf.subarray(end - n, end).toString('hex') };
}

/**
 * For a first call: the stamp `sinceMin` minutes before `now`, the host's current time in pm2's stamp shape (that host's
 * own clock and zone, never the agent's). Without it (a host whose `date` printed nothing), before the newest stamp here.
 * Lines without any stamp (an app with pm2's `time: false`) cannot be placed in time: no window, every line counts.
 */
export function windowStart(
  lines: string[],
  sinceMin: number,
  now: string | null = null
): string | null {
  if (!lines.some((l) => stampOf(l) !== null)) return null;
  let ref = now;
  for (let i = lines.length - 1; i >= 0 && !ref; i--) ref = stampOf(lines[i]);
  return ref
    ? new Date(Date.parse(`${ref}Z`) - sinceMin * 60_000)
        .toISOString()
        .slice(0, 19)
    : null;
}

/** Asks the host for its current time in pm2's stamp shape; `hostNow` reads it back from the script's output. */
export const NOW_SNIPPET = `echo "__MCPROC_NOW__ $(date '+%Y-%m-%dT%H:%M:%S' 2>/dev/null)"`;
export const hostNow = (stdout: string): string | null =>
  /__MCPROC_NOW__ (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)/.exec(stdout)?.[1] ?? null;

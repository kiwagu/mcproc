import { keepSgr, SGR_RE } from './logs.js';
import type { Context } from './resolve.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';
import { hex16 } from '../shell/snippets.js';
import type { FileMark } from './incidents/cursor.js';
import { selectSince } from './logsince.js';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { dirWatchers } from './logwatch.js';
import { hostStreamFor, type HostStream } from './hoststream.js';
import {
  type ChunkRequest,
  HEX,
  HISTORY_BYTES,
  type LogChunk,
  READ_CAP,
} from './logchunk.js';

export interface LogLine {
  stream: 'out' | 'err';
  text: string;
}

/** An unfinished line longer than this is shown cut. */
const MAX_PENDING = 65536;
/** Lines a host stream delivered that nobody polled yet are kept up to this many (the newest). */
const MAX_READY = 10_000;

export type { ChunkRequest, LogChunk } from './logchunk.js';
type ChunkReader = (reqs: ChunkRequest[]) => Promise<LogChunk[]>;

/**
 * Where a follower starts after a one-shot read: each stream with a mark continues right after it; a stream without one
 * (its app was not running, or its read was cut short) shows from its history the lines at or after `cutoff`, a pm2
 * stamp in the host's local time, instead of the last initialLines.
 */
export interface StartAt {
  out?: FileMark;
  err?: FileMark;
  cutoff?: string;
}

/**
 * Every read is bounded to the size just measured: bytes appended between `wc -c` and `tail` belong to the next poll,
 * never to both. The host sends the header and the raw bytes; lines are picked by the follower.
 */
function chunkScript(reqs: ChunkRequest[]): string {
  return reqs
    .map(({ path, off, anchor }, i) => {
      const f = shq(path);
      const tail = `st=$((sz>${HISTORY_BYTES}?sz-${HISTORY_BYTES}:0))`; // history: the last lines of what was measured
      const replaced =
        off !== null && anchor
          ? ` || [ "${hex16(f, String(off))}" != '${anchor}' ]`
          : '';
      const pick =
        off === null
          ? `k=H; ${tail}`
          : `if [ "$sz" -lt ${off} ]${replaced}; then k=R; ${tail}; elif [ $((sz-${off})) -gt ${READ_CAP} ]; then k=S; st=$((sz-${READ_CAP})); else k=N; st=${off}; fi`;
      return `echo ${CHUNK_MARK[i]}; sz=$(wc -c < ${f} 2>/dev/null || echo 0); sz=$((sz+0)); ${pick}; echo "$sz $st $k ${hex16(f, '$sz')}"; if [ "$sz" -gt "$st" ]; then tail -c +$((st+1)) ${f} 2>/dev/null | head -c $((sz-st)); fi`;
    })
    .join('; ');
}
const CHUNK_MARK = ['__MCPROC_LF_out__', '__MCPROC_LF_err__'];

/** Reads through the host's shell: one command for both files. */
function shellReader(ctx: Context): ChunkReader {
  return async (reqs) => {
    const res = ensureOk(
      await ctx.transport.exec(chunkScript(reqs)),
      ctx.host,
      'follow logs'
    );
    return reqs.map((_, i) => {
      const mark = `${CHUNK_MARK[i]}\n`;
      const at = res.stdout.indexOf(mark);
      const from = reqs[i].off;
      if (at < 0)
        return {
          from,
          size: 0,
          start: 0,
          kind: 'N',
          anchor: '',
          body: '',
          got: 0,
        };
      const next =
        i + 1 < reqs.length
          ? res.stdout.indexOf(`${CHUNK_MARK[i + 1]}\n`, at)
          : -1;
      const text = res.stdout.slice(
        at + mark.length,
        next < 0 ? undefined : next
      );
      const nl = text.indexOf('\n');
      const [sizeText, stText, kind = 'N', anchor = ''] = text
        .slice(0, nl)
        .trim()
        .split(/\s+/);
      const body = text.slice(nl + 1);
      return {
        from,
        size: Number(sizeText) || 0,
        start: Number(stText) || 0,
        kind: (/^[HRSN]$/.test(kind) ? kind : 'N') as LogChunk['kind'],
        anchor,
        body,
        got: Buffer.byteLength(body, 'utf8'),
      };
    });
  };
}

/** The hex of the up to 16 bytes before `end`. */
async function hexBefore(fh: FileHandle, end: number): Promise<string> {
  const n = Math.min(16, end);
  if (n <= 0) return '';
  const { buffer, bytesRead } = await fh.read(Buffer.alloc(n), 0, n, end - n);
  return buffer.subarray(0, bytesRead).toString('hex');
}

/**
 * Reads one file of this machine in-process, with the shell read's rules: same kinds, caps and counting. The anchor
 * comes from the bytes delivered (one read that starts up to 16 bytes before them), never from a later read: a file
 * rewritten in between must not lend its anchor to bytes of the old one.
 */
export async function readChunk(
  req: ChunkRequest,
  openFile: (path: string, flags: string) => Promise<FileHandle> = open
): Promise<LogChunk> {
  let fh: FileHandle;
  try {
    fh = await openFile(req.path, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const kind = req.off === null ? 'H' : req.off > 0 ? 'R' : 'N';
    const from = req.off;
    return { from, size: 0, start: 0, kind, anchor: '', body: '', got: 0 };
  }
  try {
    const size = (await fh.stat()).size;
    const tail = Math.max(0, size - HISTORY_BYTES);
    const { off } = req;
    let kind: LogChunk['kind'];
    let start: number;
    if (off === null) [kind, start] = ['H', tail];
    else if (
      size < off ||
      (req.anchor && (await hexBefore(fh, off)) !== req.anchor)
    )
      [kind, start] = ['R', tail];
    else if (size - off > READ_CAP) [kind, start] = ['S', size - READ_CAP];
    else [kind, start] = ['N', off];
    const lo = Math.min(start, Math.max(0, size - 16));
    const buf = Buffer.alloc(size - lo);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, lo + n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    const pre = start - lo;
    return {
      from: req.off,
      size,
      start,
      kind,
      anchor:
        n >= buf.length
          ? buf.subarray(Math.max(0, n - 16), n).toString('hex')
          : '',
      body: buf.subarray(Math.min(pre, n), n).toString('utf8'),
      got: Math.max(0, n - pre),
    };
  } finally {
    await fh.close();
  }
}

/** Follows an app's pm2 log files by byte offset: history first, then only new bytes. */
export class LogFollower {
  readonly offsets: { out: number | null; err: number | null } = {
    out: null,
    err: null,
  };
  /** the hex of the 16 bytes before each offset: if they changed, the file was replaced or truncated and grew back */
  private anchors: { out: string | null; err: string | null } = {
    out: null,
    err: null,
  };
  private pending: { out: string; err: string } = { out: '', err: '' };
  /** the stamp a stream's first history is cut at, when it was started without a mark */
  private cutoffs: { out: string | null; err: string | null } = {
    out: null,
    err: null,
  };
  private read: ChunkReader;
  private unwatch: (() => void)[] = [];
  private stream: HostStream | null = null;
  private wake: (() => void) | null = null;
  /** what the host stream delivered since the last poll */
  private ready: LogLine[] = [];
  private readyReset = false;
  constructor(
    private readonly ctx: Context,
    private readonly paths: { out: string; err: string },
    private readonly initialLines = 200,
    /** in-process reads (this machine's files); a file this process may not read sends it back to the shell */
    private readonly local = false
  ) {
    this.read = local ? this.readHere : shellReader(ctx);
  }

  /**
   * Calls `wake` when one of the followed files changes, so the caller polls right away instead of on its clock. This
   * machine's files: their directories are watched, so a rotated file is seen under its name again. A remote host's:
   * its host stream reads them as they grow, and a poll takes what it delivered without running a command.
   */
  watch(wake: () => void): void {
    this.close();
    this.wake = wake;
    if (!this.local) {
      this.stream = hostStreamFor(this.ctx.transport);
      this.stream?.add(this);
      return;
    }
    const byDir = new Map<string, Set<string>>();
    for (const p of [this.paths.out, this.paths.err]) {
      const dir = path.dirname(p);
      byDir.set(dir, (byDir.get(dir) ?? new Set()).add(path.basename(p)));
    }
    for (const [dir, names] of byDir)
      this.unwatch.push(
        dirWatchers.watch(dir, (file) => {
          if (file === null || names.has(file)) wake();
        })
      );
  }

  /** Stops the wakes; the follower can still be polled. */
  close(): void {
    for (const off of this.unwatch.splice(0)) off();
    this.stream?.remove(this);
    this.stream = null;
    this.wake = null;
  }

  /**
   * Continue after marks a one-shot read returned (the end of what it read, with the anchor of the bytes before it): the
   * next poll reads only what came after them, and a file replaced since is detected through the anchor and read from
   * its start. A mark of another path is ignored; an anchor taken elsewhere than at the offset is dropped. A stream left
   * without a mark that has not been read yet takes the cutoff for its first history, so what its app wrote between
   * that read and this follower's first poll is still shown.
   */
  seek(at: StartAt): void {
    for (const s of ['out', 'err'] as const) {
      const m = at[s];
      if (!m || m.path !== this.paths[s]) {
        if (at.cutoff !== undefined && this.offsets[s] === null)
          this.cutoffs[s] = at.cutoff;
        continue;
      }
      this.offsets[s] = m.offset;
      this.anchors[s] =
        m.anchor !== undefined && m.at === m.offset && HEX.test(m.anchor)
          ? m.anchor
          : null;
      this.pending[s] = '';
      this.cutoffs[s] = null;
    }
  }

  /** where each file is followed from, for the host stream */
  requests(): ChunkRequest[] {
    return (['out', 'err'] as const).map((s) => ({
      path: this.paths[s],
      off: this.offsets[s],
      anchor: this.anchors[s],
    }));
  }

  /** a read the host stream made of file `k` (0 out, 1 err); false when it does not continue where this one stands */
  offer(k: number, c: LogChunk): boolean {
    const s = k === 0 ? 'out' : 'err';
    if (!this.fits(s, c)) return false;
    if (this.apply(s, c, this.ready)) this.readyReset = true;
    if (this.ready.length > MAX_READY)
      this.ready.splice(0, this.ready.length - MAX_READY);
    this.wake?.();
    return true;
  }

  private fits(s: 'out' | 'err', c: LogChunk): boolean {
    return (c.from ?? -1) === (this.offsets[s] ?? -1);
  }

  private readHere: ChunkReader = async (reqs) => {
    try {
      return await Promise.all(reqs.map((r) => readChunk(r)));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EACCES' && code !== 'EPERM') throw e;
      this.read = shellReader(this.ctx);
      return this.read(reqs);
    }
  };

  async poll(): Promise<{ lines: LogLine[]; reset: boolean }> {
    if (!this.stream?.covers(this)) {
      const chunks = await this.read(this.requests());
      const out: LogLine[] = [];
      let reset = false;
      (['out', 'err'] as const).forEach((s, i) => {
        // a read the stream overtook meanwhile is not applied twice
        if (this.fits(s, chunks[i]) && this.apply(s, chunks[i], out))
          reset = true;
      });
      this.ready.push(...out);
      this.readyReset ||= reset;
    }
    const r = { lines: this.ready, reset: this.readyReset };
    this.ready = [];
    this.readyReset = false;
    return r;
  }

  /** Picks the lines of one read and moves the stream on by what arrived; true when the file was replaced. */
  private apply(s: 'out' | 'err', c: LogChunk, out: LogLine[]): boolean {
    const { size, start: st, kind, body } = c;
    const off = this.offsets[s];
    const fresh = kind !== 'N'; // history, a replaced file or a skipped burst: what came before is not continued
    if (fresh) this.pending[s] = '';
    if (kind === 'S')
      out.push({
        stream: s,
        text: `… ${Math.max(0, st - (off ?? 0))} bytes of new log skipped`,
      });
    // a window that begins inside a line starts with a fragment of it
    const text =
      fresh && st > 0
        ? body.slice(body.indexOf('\n') + 1 || body.length)
        : this.pending[s] + body;
    const complete = text.endsWith('\n')
      ? text
      : text.slice(0, text.lastIndexOf('\n') + 1);
    this.pending[s] = text.slice(complete.length);
    // a line that never ends is shown cut once it is long enough, instead of waiting in memory without limit
    const longLine =
      this.pending[s].length > MAX_PENDING
        ? `${keepSgr(this.pending[s].slice(0, MAX_PENDING))}…`
        : null;
    if (longLine) this.pending[s] = '';
    // escapes are cleaned per complete line: a color code cut by a read boundary waits in `pending` with its line
    const lines = complete.split('\n').slice(0, -1);
    // history is cut to the last initialLines (none for 0), or by time when a cutoff was given: the lines at or after
    // it, an unstamped line going with the stamped one before it. A replaced file is cut to the last initialLines too,
    // except that with 0 the follower asked for no history, and everything a file replaced under it holds was written
    // after it began
    const cutoff = this.cutoffs[s];
    this.cutoffs[s] = null; // only the first read, the one that starts the stream, is a history
    const shown =
      kind === 'H'
        ? cutoff !== null
          ? selectSince(lines, cutoff).kept.map((k) => k.text)
          : this.initialLines > 0
            ? lines.slice(-this.initialLines)
            : []
        : kind === 'R' && this.initialLines > 0
          ? lines.slice(-this.initialLines)
          : lines;
    for (const line of shown) {
      const t = keepSgr(line);
      if (t.replace(SGR_RE, '').length) out.push({ stream: s, text: t });
    }
    if (longLine) out.push({ stream: s, text: longLine });
    // what arrived, counted exactly: a read cut short (the file changed or failed meanwhile) goes on from there next poll
    const whole = c.got >= size - st;
    this.offsets[s] = whole ? size : st + c.got;
    this.anchors[s] = whole && HEX.test(c.anchor) ? c.anchor : null; // known only for the measured size
    return kind === 'R';
  }
}

/** The follower a host gets: this machine's files are read in-process, a remote host's through its shell. */
export function createFollower(
  ctx: Context,
  paths: { out: string; err: string },
  initialLines = 200
): LogFollower {
  return new LogFollower(ctx, paths, initialLines, ctx.host.local);
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/; // seconds, or milliseconds
/** Stamped lines are ordered by pm2's timestamp prefix (stable); lines without a stamp keep their positions. */
export function sortByStamp<T extends { text: string }>(lines: T[]): T[] {
  const keyed = lines.map((l, i) => ({
    l,
    i,
    k: STAMP.exec(l.text)?.[1] ?? null,
  }));
  const stamped = keyed
    .filter((x) => x.k !== null)
    .sort((a, b) => (a.k! < b.k! ? -1 : a.k! > b.k! ? 1 : a.i - b.i));
  let j = 0;
  return keyed.map((x) => (x.k === null ? x.l : stamped[j++].l));
}

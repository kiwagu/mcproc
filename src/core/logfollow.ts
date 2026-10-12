import { keepSgr, SGR_RE } from './logs.js';
import type { Context } from './resolve.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';
import { hex16 } from '../shell/snippets.js';

export interface LogLine {
  stream: 'out' | 'err';
  text: string;
}

/** At most this many new bytes are read per file per poll; a bigger burst is read from its newest part. */
const READ_CAP = 1048576;
/** History (the first read, or a replaced file) comes from this many last bytes: the last lines are picked from them. */
const HISTORY_BYTES = 262144;
/** An unfinished line longer than this is shown cut. */
const MAX_PENDING = 65536;
const HEX = /^[0-9a-f]{1,64}$/;

/** Follows an app's pm2 log files by byte offset through the transport: history first, then only new bytes. */
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
  constructor(
    private readonly ctx: Context,
    private readonly paths: { out: string; err: string },
    private readonly initialLines = 200
  ) {}

  /**
   * Every read is bounded to the size just measured: bytes appended between `wc -c` and `tail` belong to the next poll,
   * never to both. The host says where the read began and why (H history, R the file was replaced or shrank, S a burst
   * over READ_CAP, N new bytes) and sends the raw bytes; lines are picked here, so what arrived is counted exactly.
   */
  private script(): string {
    return (['out', 'err'] as const)
      .map((s) => {
        const f = shq(this.paths[s]);
        const off = this.offsets[s];
        const tail = `st=$((sz>${HISTORY_BYTES}?sz-${HISTORY_BYTES}:0))`; // history: the last lines of what was measured
        const anc = this.anchors[s];
        const replaced =
          off !== null && anc
            ? ` || [ "${hex16(f, String(off))}" != '${anc}' ]`
            : '';
        const pick =
          off === null
            ? `k=H; ${tail}`
            : `if [ "$sz" -lt ${off} ]${replaced}; then k=R; ${tail}; elif [ $((sz-${off})) -gt ${READ_CAP} ]; then k=S; st=$((sz-${READ_CAP})); else k=N; st=${off}; fi`;
        return `echo __MCPROC_LF_${s}__; sz=$(wc -c < ${f} 2>/dev/null || echo 0); sz=$((sz+0)); ${pick}; echo "$sz $st $k ${hex16(f, '$sz')}"; if [ "$sz" -gt "$st" ]; then tail -c +$((st+1)) ${f} 2>/dev/null | head -c $((sz-st)); fi`;
      })
      .join('; ');
  }

  async poll(): Promise<{ lines: LogLine[]; reset: boolean }> {
    const res = ensureOk(
      await this.ctx.transport.exec(this.script()),
      this.ctx.host,
      'follow logs'
    );
    const out: LogLine[] = [];
    let reset = false;
    for (const s of ['out', 'err'] as const) {
      const start = res.stdout.indexOf(`__MCPROC_LF_${s}__\n`);
      if (start < 0) continue;
      const endMark =
        s === 'out' ? res.stdout.indexOf('__MCPROC_LF_err__\n', start) : -1;
      let body = res.stdout.slice(
        start + `__MCPROC_LF_${s}__\n`.length,
        endMark < 0 ? undefined : endMark
      );
      const nl = body.indexOf('\n');
      const [sizeText, stText, kind = 'N', hex = ''] = body
        .slice(0, nl)
        .trim()
        .split(/\s+/);
      const size = Number(sizeText) || 0;
      const st = Number(stText) || 0;
      body = body.slice(nl + 1);
      const off = this.offsets[s];
      const fresh = kind !== 'N'; // history, a replaced file or a skipped burst: what came before is not continued
      if (kind === 'R') reset = true;
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
      for (const line of kind === 'H' || kind === 'R'
        ? lines.slice(-this.initialLines)
        : lines) {
        const t = keepSgr(line);
        if (t.replace(SGR_RE, '').length) out.push({ stream: s, text: t });
      }
      if (longLine) out.push({ stream: s, text: longLine });
      // what arrived, counted exactly: a read cut short (the file changed or failed meanwhile) goes on from there next poll
      const whole = Buffer.byteLength(body, 'utf8') >= size - st;
      this.offsets[s] = whole ? size : st + Buffer.byteLength(body, 'utf8');
      this.anchors[s] = whole && HEX.test(hex) ? hex : null; // known only for the measured size
    }
    return { lines: out, reset };
  }
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;
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

import { stripAnsi } from './logs.js';
import type { Context } from './resolve.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';

export interface LogLine { stream: 'out' | 'err'; text: string }
const RESET = '__MCPROC_LF_RESET__';

/** Follows an app's pm2 log files by byte offset through the transport: history first, then only new bytes. */
export class LogFollower {
  readonly offsets: { out: number | null; err: number | null } = { out: null, err: null };
  private pending: { out: string; err: string } = { out: '', err: '' };
  constructor(private readonly ctx: Context, private readonly paths: { out: string; err: string }, private readonly initialLines = 200) {}

  /** Every read is bounded to the size just measured: bytes appended between `wc -c` and `tail` belong to the next poll, never to both. */
  private script(): string {
    return (['out', 'err'] as const).map((s) => {
      const f = shq(this.paths[s]);
      const off = this.offsets[s];
      const history = `head -c "$sz" ${f} 2>/dev/null | tail -n ${this.initialLines}`;
      const read = off === null
        ? history
        : `if [ "$sz" -lt ${off} ]; then echo ${RESET}; ${history}; elif [ "$sz" -gt ${off} ]; then tail -c +${off + 1} ${f} 2>/dev/null | head -c $((sz-${off})); fi`;
      return `echo __MCPROC_LF_${s}__; sz=$(wc -c < ${f} 2>/dev/null || echo 0); echo "$sz"; ${read}`;
    }).join('; ');
  }

  async poll(): Promise<{ lines: LogLine[]; reset: boolean }> {
    const res = ensureOk(await this.ctx.transport.exec(this.script()), this.ctx.host, 'follow logs');
    const out: LogLine[] = [];
    let reset = false;
    for (const s of ['out', 'err'] as const) {
      const start = res.stdout.indexOf(`__MCPROC_LF_${s}__\n`);
      if (start < 0) continue;
      const endMark = s === 'out' ? res.stdout.indexOf('__MCPROC_LF_err__\n', start) : -1;
      let body = res.stdout.slice(start + `__MCPROC_LF_${s}__\n`.length, endMark < 0 ? undefined : endMark);
      const nl = body.indexOf('\n');
      const size = Number(body.slice(0, nl).trim()) || 0;
      body = body.slice(nl + 1);
      if (body.startsWith(`${RESET}\n`)) { body = body.slice(RESET.length + 1); reset = true; this.pending[s] = ''; }
      const chunk = this.pending[s] + stripAnsi(body);
      const complete = chunk.endsWith('\n') ? chunk : chunk.slice(0, chunk.lastIndexOf('\n') + 1);
      this.pending[s] = chunk.slice(complete.length);
      for (const line of complete.split('\n')) if (line.length) out.push({ stream: s, text: line });
      this.offsets[s] = size;
    }
    return { lines: out, reset };
  }
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;
/** Stamped lines are ordered by pm2's timestamp prefix (stable); lines without a stamp keep their positions. */
export function sortByStamp(lines: LogLine[]): LogLine[] {
  const keyed = lines.map((l, i) => ({ l, i, k: STAMP.exec(l.text)?.[1] ?? null }));
  const stamped = keyed.filter((x) => x.k !== null).sort((a, b) => (a.k! < b.k! ? -1 : a.k! > b.k! ? 1 : a.i - b.i));
  let j = 0;
  return keyed.map((x) => (x.k === null ? x.l : stamped[j++].l));
}

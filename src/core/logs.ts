import { McprocError } from './errors.js';
import { findProcess } from './pm2.js';
import type { Context } from './resolve.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
/** SGR sequences, the color and style codes an app writes (`ESC [ … m`, the colon form of true color included). */
// eslint-disable-next-line no-control-regex
export const SGR_RE = /\x1b\[[0-9;:]*m/g;
/** Every other escape: OSC up to BEL, ST or the line end (titles, links; one an app never terminated must not eat what follows), other CSI (cursor, erase), two-byte escapes (charsets, keypad), a stray ESC. */
// eslint-disable-next-line no-control-regex
const NON_SGR_RE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?|\x1b\[[0-9;:?<=>]*[ -\/]*[@-ln-~]|\x1b(?!\[[0-9;:]*m)[ -\/]*[0-~]?/g;
/** An app's colors stay, everything else a terminal would act on (cursor moves, titles) goes: what a log view can show. */
export function keepSgr(s: string): string { return s.replace(NON_SGR_RE, ''); }
/** Plain text: no escapes at all. */
export function stripAnsi(s: string): string { return keepSgr(s).replace(SGR_RE, ''); }

export type LogStream = 'out' | 'err' | 'both';
export const MAX_LINES = 2000;
export interface LogsResult { app: string; lines: number; paths: { out: string; err: string }; out?: string; err?: string }

const OUT = '__MCPROC_OUT__';
const ERR = '__MCPROC_ERR__';

function section(text: string, from: string, to?: string): string | undefined {
  const i = text.indexOf(from);
  if (i < 0) return undefined;
  const start = i + from.length + 1;
  const j = to ? text.indexOf(to, start) : -1;
  return text.slice(start, j >= 0 ? j : undefined).replace(/\n$/, '');
}

export async function readLogs(ctx: Context, app: string, opts: { lines?: number; stream?: LogStream } = {}): Promise<LogsResult> {
  const lines = Math.min(Math.max(Math.trunc(opts.lines ?? 100), 1), MAX_LINES);
  const stream = opts.stream ?? 'both';
  const p = findProcess(await ctx.pm2.jlist(), ctx.manifest.project, app);
  if (!p) {
    throw new McprocError('NOT_STARTED', `"${app}" has no pm2 process on ${ctx.transport.describe()} (never started, or deleted)`, { hint: `Run start ${app} first; ls shows the current state.` });
  }
  const parts: string[] = [];
  if (stream !== 'err') parts.push(`echo ${OUT}; tail -n ${lines} ${shq(p.out_log)} 2>/dev/null`);
  if (stream !== 'out') parts.push(`echo ${ERR}; tail -n ${lines} ${shq(p.err_log)} 2>/dev/null`);
  const res = ensureOk(await ctx.transport.exec(parts.join('; ')), ctx.host, 'tail logs');
  const text = stripAnsi(res.stdout);
  const result: LogsResult = { app, lines, paths: { out: p.out_log, err: p.err_log } };
  if (stream !== 'err') result.out = section(text, OUT, ERR) ?? '';
  if (stream !== 'out') result.err = section(text, ERR) ?? '';
  return result;
}

/** Truncate the log files of one app, of the listed apps, or of every app of the context's host. */
export async function flushLogs(ctx: Context, app?: string | string[]): Promise<{ app: string; out_bytes: number; err_bytes: number }[]> {
  const procs = await ctx.pm2.jlist();
  const names = app === undefined ? Object.keys(ctx.manifest.apps) : typeof app === 'string' ? [app] : app;
  const targets = names.flatMap((n) => { const p = findProcess(procs, ctx.manifest.project, n); return p ? [{ n, p }] : []; });
  if (targets.length === 0) return [];
  const cmd = targets
    .flatMap(({ p }) => [p.out_log, p.err_log])
    .map((f) => `{ wc -c < ${shq(f)} 2>/dev/null || echo 0; }; : > ${shq(f)} 2>/dev/null`)
    .join('; ');
  const res = ensureOk(await ctx.transport.exec(cmd), ctx.host, 'flush logs');
  const nums = res.stdout.trim().split('\n').map((s) => Number(s.trim()) || 0);
  return targets.map(({ n }, i) => ({ app: n, out_bytes: nums[i * 2] ?? 0, err_bytes: nums[i * 2 + 1] ?? 0 }));
}

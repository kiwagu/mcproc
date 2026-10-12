import type { Context } from './resolve.js';
import { snapshot as probeSnapshot, type Snapshot } from './list.js';
import { findProcess } from './pm2.js';
import { LogFollower, sortByStamp, type LogLine } from './logfollow.js';

export interface StreamLine { app: string; stream: 'out' | 'err'; text: string }
export interface Follower { poll(): Promise<{ lines: LogLine[]; reset: boolean }> }
export interface StreamDeps {
  snapshot(ctx: Context): Promise<Snapshot>;
  follower(ctx: Context, paths: { out: string; err: string }, lines: number): Follower;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
}
export interface StreamOptions {
  lines: number; follow: boolean; intervalMs: number; color: boolean; json: boolean; stream: 'out' | 'err' | 'both';
  /** while following, re-probe every N ticks for apps that were not started yet */
  resolveEvery?: number; signal?: AbortSignal;
}

const PALETTE = [36, 32, 33, 35, 34, 31]; // cyan, green, yellow, magenta, blue, red — one per app, like compose
export const colorFor = (index: number): number => PALETTE[index % PALETTE.length];

/** `app    | text` for stdout, `app    ! text` for stderr; only the label is colored, so the text stays greppable. */
export function formatLine(l: StreamLine, width: number, color: number | null): string {
  const label = l.app.padEnd(width);
  return `${color === null ? label : `\x1b[${color}m${label}\x1b[0m`} ${l.stream === 'err' ? '!' : '|'} ${l.text}`;
}

export function defaultStreamDeps(): StreamDeps {
  return {
    snapshot: (ctx) => probeSnapshot(ctx, { cpu: 'none', urls: 'none' }),
    follower: (ctx, paths, lines) => new LogFollower(ctx, paths, lines),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (s) => { process.stdout.write(s + '\n'); },
  };
}

/** Merged logs of several apps, compose style: history first (app order), then one poll per app per interval while following. */
export async function streamLogs(ctx: Context, apps: string[], opts: StreamOptions, deps: StreamDeps): Promise<void> {
  const width = Math.max(...apps.map((a) => a.length));
  const colors = new Map(apps.map((a, i) => [a, opts.color ? colorFor(i) : null]));
  let closed = false; // the reader went away (`| head`): stop quietly, no stack trace
  const emit = (l: StreamLine) => {
    if (closed || (opts.stream !== 'both' && l.stream !== opts.stream)) return;
    try { deps.out(opts.json ? JSON.stringify(l) : formatLine(l, width, colors.get(l.app) ?? null)); }
    catch (e) { if ((e as { code?: string }).code === 'EPIPE') closed = true; else throw e; }
  };
  const followers = new Map<string, Follower>();
  const attach = async () => {
    const snap = await deps.snapshot(ctx);
    for (const app of apps) {
      if (followers.has(app)) continue;
      const p = findProcess(snap.procs, ctx.manifest.project, app);
      if (p) followers.set(app, deps.follower(ctx, { out: p.out_log, err: p.err_log }, opts.lines));
    }
  };
  const pollAll = async (first: boolean) => {
    for (const app of apps) {
      if (closed) return;
      const f = followers.get(app);
      if (!f) { if (first) emit({ app, stream: 'out', text: '(not started)' }); continue; }
      const got = (await f.poll()).lines;
      // pm2 stamps every line (`time: true`); merge an app's out and err by that stamp instead of printing two blocks
      for (const l of opts.stream === 'both' ? sortByStamp(got) : got) emit({ app, stream: l.stream, text: l.text });
    }
  };
  await attach();
  await pollAll(true);
  if (!opts.follow || closed) return;
  const every = opts.resolveEvery ?? 10;
  for (let tick = 1; !opts.signal?.aborted && !closed; tick++) {
    await deps.sleep(opts.intervalMs);
    if (opts.signal?.aborted) break;
    if (followers.size < apps.length && tick % every === 0) await attach();
    await pollAll(false);
  }
}

import type { Context } from './resolve.js';
import { snapshot as probeSnapshot, type Snapshot } from './list.js';
import { findProcess } from './pm2.js';
import { LogFollower, sortByStamp, type LogLine } from './logfollow.js';
import { describeError } from './errors.js';

export interface StreamLine { app: string; stream: 'out' | 'err'; text: string }
/**
 * The apps of one host: with the host's context, or with the error that kept it from connecting; `connect` lets a
 * follow stream reach the host again later.
 */
export interface LogSource { host: string; apps: string[]; ctx?: Context; error?: unknown; connect?: () => Promise<Context> }
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

/**
 * Merged logs of several apps, possibly on several hosts, compose style: history first (app order), then, while
 * following, one loop per host polling its apps every interval — a slow or silent host never holds the others back.
 * A host that does not answer gets one note line per app per outage and is tried again: its followers resume at the
 * byte offset they had, a host that was down at the start is connected on the re-probe ticks. If no host answers at
 * the start, the first error is thrown instead.
 */
export async function streamLogs(sources: LogSource[], opts: StreamOptions, deps: StreamDeps): Promise<void> {
  const apps = sources.flatMap((s) => s.apps);
  const width = Math.max(...apps.map((a) => a.length));
  const colors = new Map(apps.map((a, i) => [a, opts.color ? colorFor(i) : null]));
  let closed = false; // the reader went away (`| head`): stop quietly, no stack trace
  const emit = (l: StreamLine) => {
    if (closed || (opts.stream !== 'both' && l.stream !== opts.stream)) return;
    try { deps.out(opts.json ? JSON.stringify(l) : formatLine(l, width, colors.get(l.app) ?? null)); }
    catch (e) { if ((e as { code?: string }).code === 'EPIPE') closed = true; else throw e; }
  };
  const followers = new Map<string, Follower>();
  const down = new Map<LogSource, string>(); // hosts in an outage that was already announced
  const announce = (s: LogSource, e: unknown) => {
    if (down.has(s)) return;
    down.set(s, describeError(e));
    for (const app of s.apps) emit({ app, stream: 'out', text: `(host ${s.host} unreachable: ${describeError(e)})` });
  };
  /** connect when needed, probe once, and follow every app of the source that runs */
  const attach = async (s: LogSource, reconnect: boolean) => {
    if (!s.ctx) {
      if (!reconnect || !s.connect) throw s.error ?? new Error(`host ${s.host} is not connected`);
      s.ctx = await s.connect();
    }
    if (s.apps.every((a) => followers.has(a))) return;
    const snap: Snapshot = await deps.snapshot(s.ctx);
    for (const app of s.apps) {
      const p = followers.has(app) ? undefined : findProcess(snap.procs, s.ctx.manifest.project, app);
      if (p) followers.set(app, deps.follower(s.ctx, { out: p.out_log, err: p.err_log }, opts.lines));
    }
  };
  /** one poll of the source's apps in app order; on the first pass an app that does not run says so */
  const poll = async (s: LogSource, first: boolean) => {
    for (const app of s.apps) {
      if (closed) return;
      const f = followers.get(app);
      if (!f) { if (first) emit({ app, stream: 'out', text: '(not started)' }); continue; }
      const got = (await f.poll()).lines;
      // pm2 stamps every line (`time: true`); merge an app's out and err by that stamp instead of printing two blocks
      for (const l of opts.stream === 'both' ? sortByStamp(got) : got) emit({ app, stream: l.stream, text: l.text });
    }
  };

  // history: every host probed at once, then printed in app order
  const failures = await Promise.all(sources.map((s) => attach(s, false).then(() => null, (e: unknown) => ({ e }))));
  if (sources.length > 0 && failures.every((f) => f !== null)) throw failures[0]!.e;
  for (const [i, s] of sources.entries()) {
    const failed = failures[i];
    if (failed) { announce(s, failed.e); continue; }
    try { await poll(s, true); } catch (e) { announce(s, e); }
    if (closed) return;
  }
  if (!opts.follow || closed) return;
  const every = opts.resolveEvery ?? 10;
  await Promise.all(sources.map(async (s) => {
    for (let tick = 1; !opts.signal?.aborted && !closed; tick++) {
      await deps.sleep(opts.intervalMs);
      if (opts.signal?.aborted || closed) break;
      try {
        // apps that were not running (or a host that was not reached) are looked for again every `every` ticks
        if ((!s.ctx || s.apps.some((a) => !followers.has(a))) && tick % every === 0) await attach(s, true);
        await poll(s, false);
        down.delete(s);
      } catch (e) {
        announce(s, e);
      }
    }
  }));
}

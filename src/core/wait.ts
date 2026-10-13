import { McprocError } from './errors.js';
import { findProcess, type Pm2Process } from './pm2.js';
import type { Context } from './resolve.js';
import {
  snapshot as probeSnapshot,
  statusWord,
  type Snapshot,
  type SnapshotOptions,
} from './list.js';
import { createFollower, type LogFollower } from './logfollow.js';
import { fmtPorts } from '../mcp/render.js';

export type Until =
  | { kind: 'listening' }
  | { kind: 'url-ok' }
  | { kind: 'exited' }
  | { kind: 'log'; re: RegExp; source: string }
  | { kind: 'idle'; seconds: number };
export type WaitReason =
  | 'timeout'
  | 'exited'
  | 'crashed'
  | 'failed'
  | 'aborted';
/** What a wait ended with: ok and the condition met, or not and why; the status word and exit code as of the end. */
export interface WaitResult {
  ok: boolean;
  until: string;
  waited_ms: number;
  reason?: WaitReason;
  status: string;
  exit_code?: number | null;
  matched_line?: string;
  observed?: string;
}
export interface WaitDeps {
  jlist(ctx: Context): Promise<Pm2Process[]>;
  snapshot(ctx: Context, opts: SnapshotOptions): Promise<Snapshot>;
  follower(
    ctx: Context,
    paths: { out: string; err: string }
  ): Pick<LogFollower, 'poll' | 'watch' | 'close' | 'offsets'>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}
export const WAIT_TIMEOUT_DEFAULT_MS = 60_000;
export const WAIT_TIMEOUT_MAX_MS = 600_000;
/** How often the host is asked: a light probe or jlist, a login shell each time, so not faster than this. */
const POLL_LOCAL_MS = 500;
const POLL_REMOTE_MS = 1000;
/** pm2 statuses of a process that is running, or about to be. */
const LIVE = new Set(['online', 'launching']);

const bad = (msg: string) =>
  new McprocError('BAD_ARGUMENT', msg, {
    hint: 'until is one of: listening, url-ok, exited, log:<regex>, idle:<seconds>',
  });

export function parseUntil(s: string): Until {
  if (s === 'listening' || s === 'url-ok' || s === 'exited') return { kind: s };
  if (s.startsWith('log:')) {
    const source = s.slice(4);
    if (!source) throw bad('log: needs a regular expression after the colon');
    try {
      return { kind: 'log', re: new RegExp(source), source };
    } catch (e) {
      throw bad(
        `log: invalid regular expression "${source}": ${(e as Error).message}`
      );
    }
  }
  if (s.startsWith('idle:')) {
    const seconds = Number(s.slice(5));
    if (!Number.isFinite(seconds) || !(seconds > 0))
      throw bad(`idle: needs a number of seconds above 0, got "${s.slice(5)}"`);
    return { kind: 'idle', seconds };
  }
  throw bad(`unknown until "${s}"`);
}

export function untilLabel(u: Until): string {
  return u.kind === 'log'
    ? `log:${u.source}`
    : u.kind === 'idle'
      ? `idle:${u.seconds}`
      : u.kind;
}

export function defaultWaitDeps(): WaitDeps {
  return {
    jlist: (ctx) => ctx.pm2.jlist(),
    snapshot: (ctx, opts) => probeSnapshot(ctx, opts),
    // no history: a wait looks only at what is written after it began
    follower: (ctx, paths) => createFollower(ctx, paths, 0),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        // an abort that came before the sleep began fires no event: answer at once
        if (signal?.aborted) return resolve();
        const done = () => {
          signal?.removeEventListener('abort', done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
      }),
    now: () => Date.now(),
  };
}

const notStarted = (ctx: Context, app: string) =>
  new McprocError(
    'NOT_STARTED',
    `"${app}" has no pm2 process on ${ctx.transport.describe()} (never started, or deleted)`,
    { hint: `Run start ${app} first; ls shows the current state.` }
  );

/** The log:/idle: waits sit on the follower; they arrive with the next task. */
async function waitOnLogs(): Promise<WaitResult> {
  throw new Error('log waits arrive in the next task');
}

/**
 * Waits until `until` holds for one app, the timeout passes, the process leaves `online` while the condition is
 * still unmet, or the signal aborts. Every end is a result; only a bad request or an app that was never started
 * throws. The deadline is checked after each sample and the last sleep is cut to what remains, so a wait never
 * overshoots its timeout by a whole interval.
 */
export async function waitFor(
  ctx: Context,
  app: string,
  until: Until,
  opts: { timeoutMs?: number; signal?: AbortSignal; deps?: WaitDeps } = {}
): Promise<WaitResult> {
  const deps = opts.deps ?? defaultWaitDeps();
  const a = ctx.manifest.apps[app];
  if (!a)
    throw new McprocError(
      'UNKNOWN_APP',
      `Unknown app "${app}" in ${ctx.manifest.path}`
    );
  if (until.kind === 'listening' && a.ports.length === 0)
    throw bad(`"${app}" declares no port, so listening cannot be observed`);
  if (until.kind === 'url-ok' && !a.url)
    throw bad(`"${app}" declares no url, so url-ok cannot be observed`);
  if (until.kind === 'log' || until.kind === 'idle') return waitOnLogs();

  const timeoutMs = Math.min(
    opts.timeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS,
    WAIT_TIMEOUT_MAX_MS
  );
  const start = deps.now();
  const deadline = start + timeoutMs;
  const interval = ctx.host.local ? POLL_LOCAL_MS : POLL_REMOTE_MS;
  const label = untilLabel(until);
  const answer = (
    part: Partial<WaitResult> & { ok: boolean; status: string }
  ): WaitResult => ({ until: label, waited_ms: deps.now() - start, ...part });
  /** the process left online (or is gone) with the condition still unmet */
  const gone = (p: Pm2Process | undefined, observed?: string): WaitResult =>
    answer({
      ok: false,
      reason: p?.status === 'errored' ? 'crashed' : 'exited',
      status: statusWord(p, a),
      exit_code: p?.exit_code ?? null,
      observed,
    });
  /** sleeps until the next poll or the deadline, whichever is first; false when the wait was aborted */
  const pause = async (): Promise<boolean> => {
    await deps.sleep(
      Math.max(0, Math.min(interval, deadline - deps.now())),
      opts.signal
    );
    return !opts.signal?.aborted;
  };

  for (let first = true; ; first = false) {
    let p: Pm2Process | undefined;
    let observed: string | undefined;
    if (until.kind === 'exited') {
      p = findProcess(await deps.jlist(ctx), ctx.manifest.project, app);
      if (!p) {
        // gone at the first look is a request for an app that never started; gone later is a result
        if (first) throw notStarted(ctx, app);
        return gone(undefined);
      }
      if (!LIVE.has(p.status) && p.status !== 'stopping')
        return answer({
          ok: true,
          status: statusWord(p, a),
          exit_code: p.exit_code,
        });
      observed = `status ${p.status}`;
    } else {
      const snap = await deps.snapshot(ctx, {
        cpu: 'none',
        metrics: 'none',
        // the option names apps, not urls: the probe checks this app's url
        urls: until.kind === 'url-ok' ? [app] : 'none',
      });
      p = findProcess(snap.procs, ctx.manifest.project, app);
      if (first && !p) throw notStarted(ctx, app);
      let met: boolean;
      if (until.kind === 'listening') {
        const ports = snap.ports[app];
        met =
          ports.checks.length > 0 &&
          ports.checks.every((c) => c.status === 'listening');
        observed = met
          ? fmtPorts(ports)
          : `status ${p?.status ?? 'not-started'}, ${fmtPorts(ports)}`;
      } else {
        // 0: nothing answered; null: the host has neither curl nor wget, or the url was not asked for
        const code = snap.urls.get(a.url!) ?? null;
        met = code !== null && code > 0 && code < 400;
        observed = `${a.url} ${code === null ? 'unchecked' : code === 0 ? 'down' : code}`;
      }
      if (met) return answer({ ok: true, status: statusWord(p, a), observed });
      if (!p || !LIVE.has(p.status)) return gone(p, observed);
    }
    if (deps.now() >= deadline)
      return answer({
        ok: false,
        reason: 'timeout',
        status: statusWord(p, a),
        observed,
      });
    if (!(await pause()))
      return answer({
        ok: false,
        reason: 'aborted',
        status: statusWord(p, a),
        observed,
      });
  }
}

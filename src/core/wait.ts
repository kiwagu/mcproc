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
import { stripAnsi } from './logs.js';
import type { App, Dep } from './manifest.js';
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
/** The log: and idle: waits look at the follower at least this often (a file wake makes it sooner). */
const LOG_TICK_MS = 1000;
/** ...and ask pm2 about the process this often: each check is a login shell, so not every tick. */
const STATUS_EVERY_MS = 5000;

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

type Answer = (
  part: Partial<WaitResult> & { ok: boolean; status: string }
) => WaitResult;
/** What waitFor hands the log waits: its clock bounds and the ways to end a result. */
interface LogRun {
  deps: WaitDeps;
  deadline: number;
  signal?: AbortSignal;
  answer: Answer;
  gone: (p: Pm2Process | undefined, observed?: string) => WaitResult;
  giveUp: (
    reason: 'timeout' | 'aborted',
    p: Pm2Process | undefined,
    observed?: string
  ) => WaitResult;
}

/**
 * log:/idle: sit on the log follower, which takes its position at the end of both files: nothing written before
 * that is searched, and a quiet period counts from that moment (or from the last byte since). Lines read in a poll
 * are judged before the process is looked at, so a last line still counts. The process is asked about every few
 * seconds, and once more when the quiet period of idle: ends.
 */
async function waitOnLogs(
  ctx: Context,
  app: string,
  a: App,
  until: Extract<Until, { kind: 'log' | 'idle' }>,
  run: LogRun
): Promise<WaitResult> {
  const { deps, signal } = run;
  let p = findProcess(await deps.jlist(ctx), ctx.manifest.project, app);
  if (!p) throw notStarted(ctx, app);
  const f = deps.follower(ctx, { out: p.out_log, err: p.err_log });
  // a file wake, or the signal, ends the sleep of the tick; a wake during a poll skips the next sleep
  let tick: AbortController | null = null;
  let woken = false;
  const wake = () => {
    woken = true;
    tick?.abort();
  };
  const onAbort = () => tick?.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await f.poll(); // takes the position at the end; no history is searched
    f.watch(wake);
    const quietMs = until.kind === 'idle' ? Math.ceil(until.seconds * 1000) : 0;
    let lastCheck = deps.now();
    let lastChange = lastCheck;
    let lastLine: string | undefined;
    let seen = { out: f.offsets.out, err: f.offsets.err };
    for (;;) {
      const { lines } = await f.poll();
      let now = deps.now();
      // any byte counts as activity, a line still unfinished too
      if (f.offsets.out !== seen.out || f.offsets.err !== seen.err) {
        lastChange = now;
        seen = { out: f.offsets.out, err: f.offsets.err };
      }
      for (const l of lines) {
        const text = stripAnsi(l.text);
        lastLine = text;
        if (until.kind === 'log' && until.re.test(text))
          return run.answer({
            ok: true,
            status: statusWord(p, a),
            matched_line: text,
          });
      }
      const observed =
        lastLine === undefined ? 'no new output' : `last line: ${lastLine}`;
      if (until.kind === 'idle' && now - lastChange >= quietMs) {
        p = findProcess(await deps.jlist(ctx), ctx.manifest.project, app);
        return p && LIVE.has(p.status)
          ? run.answer({ ok: true, status: statusWord(p, a), observed })
          : run.gone(p, observed);
      }
      if (now - lastCheck >= STATUS_EVERY_MS) {
        lastCheck = now;
        p = findProcess(await deps.jlist(ctx), ctx.manifest.project, app);
        if (!p || !LIVE.has(p.status)) return run.gone(p, observed);
        now = deps.now(); // the check took a login shell, more over ssh: do not sleep from the time before it
      }
      if (now >= run.deadline) return run.giveUp('timeout', p, observed);
      // the next tick, cut to the deadline, the next status check and the end of the quiet period
      const sleeps = [
        LOG_TICK_MS,
        run.deadline - now,
        lastCheck + STATUS_EVERY_MS - now,
      ];
      if (until.kind === 'idle') sleeps.push(lastChange + quietMs - now);
      if (!woken && !signal?.aborted) {
        tick = new AbortController();
        await deps.sleep(Math.max(0, Math.min(...sleeps)), tick.signal);
        tick = null;
      }
      woken = false;
      if (signal?.aborted) return run.giveUp('aborted', p, observed);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    f.close();
  }
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

  const timeoutMs = Math.min(
    opts.timeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS,
    WAIT_TIMEOUT_MAX_MS
  );
  const start = deps.now();
  const deadline = start + timeoutMs;
  const interval = ctx.host.local ? POLL_LOCAL_MS : POLL_REMOTE_MS;
  const label = untilLabel(until);
  const answer: Answer = (part) => ({
    until: label,
    waited_ms: deps.now() - start,
    ...part,
  });
  /** the process left online (or is gone) with the condition still unmet */
  const gone = (p: Pm2Process | undefined, observed?: string): WaitResult =>
    answer({
      ok: false,
      reason: p?.status === 'errored' ? 'crashed' : 'exited',
      status: statusWord(p, a),
      exit_code: p?.exit_code ?? null,
      observed,
    });
  /** the wait ends with the condition unmet: the timeout passed or the signal aborted */
  const giveUp = (
    reason: 'timeout' | 'aborted',
    p: Pm2Process | undefined,
    observed?: string
  ): WaitResult =>
    answer({ ok: false, reason, status: statusWord(p, a), observed });
  /** sleeps until the next poll or the deadline, whichever is first; false when the wait was aborted */
  const pause = async (): Promise<boolean> => {
    await deps.sleep(
      Math.max(0, Math.min(interval, deadline - deps.now())),
      opts.signal
    );
    return !opts.signal?.aborted;
  };
  if (until.kind === 'log' || until.kind === 'idle')
    return waitOnLogs(ctx, app, a, until, {
      deps,
      deadline,
      signal: opts.signal,
      answer,
      gone,
      giveUp,
    });

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
    if (deps.now() >= deadline) return giveUp('timeout', p, observed);
    if (!(await pause())) return giveUp('aborted', p, observed);
  }
}

/** What a dependency must show before its dependents start: ready is the declared ports (else the url), completed the exit. */
export function untilFor(dep: Dep, depApp: App): Until {
  if (dep.condition === 'completed') return { kind: 'exited' };
  return depApp.ports.length > 0 ? { kind: 'listening' } : { kind: 'url-ok' };
}

/** A dependency's condition observed on its own context; `completed` also requires exit code 0. */
export async function waitDependency(
  ctx: Context,
  dep: Dep,
  opts: { signal?: AbortSignal; deps?: WaitDeps } = {}
): Promise<WaitResult> {
  const depApp = ctx.manifest.apps[dep.app];
  const r = await waitFor(ctx, dep.app, untilFor(dep, depApp), {
    timeoutMs: dep.timeoutMs,
    ...opts,
  });
  if (dep.condition === 'completed' && r.ok && r.exit_code !== 0)
    return { ...r, ok: false, reason: 'failed' };
  return r;
}

/** Why a dependent was not started, as its row says it. */
export function depFailure(dep: Dep, r: WaitResult): string {
  const want = dep.condition === 'completed' ? 'completed' : 'ready';
  switch (r.reason) {
    case 'failed':
      return `${dep.app} ${r.status}`;
    case 'timeout': {
      // the declared timeout; a wait that ended earlier says how long it did wait (a probe may overshoot by a tick)
      const secs = Math.min(dep.timeoutMs, r.waited_ms) / 1000;
      return `${dep.app} not ${want} in ${secs} s (${r.observed ?? `status ${r.status}`})`;
    }
    case 'crashed':
      return `${dep.app} crashed`;
    case 'aborted':
      return `${dep.app}: wait aborted`;
    default:
      return `${dep.app} exited (${r.status})`;
  }
}

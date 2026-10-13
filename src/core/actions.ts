import path from 'node:path';
import { describeError, McprocError } from './errors.js';
import type { Dep, DepCondition, Manifest } from './manifest.js';
import {
  appCwd,
  buildEcosystem,
  ecosystemPath,
  generatedDir,
} from './ecosystem.js';
import { findProcess, pm2Name, type Pm2Process } from './pm2.js';
import { rowsFor, snapshot, unreachableRow, type LsRow } from './list.js';
import { depFailure, waitDependency, type WaitResult } from './wait.js';
import type { Context } from './resolve.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';

export function resolveTargets(m: Manifest, target: string): string[] {
  if (target === 'all') return Object.keys(m.apps);
  if (Object.hasOwn(m.profiles, target)) return [...m.profiles[target]];
  if (Object.hasOwn(m.apps, target)) return [target];
  throw new McprocError(
    'UNKNOWN_APP',
    `"${target}" is neither an app nor a profile in ${m.path}`,
    {
      hint: `Apps: ${Object.keys(m.apps).join(', ')}. Profiles: ${[...Object.keys(m.profiles), 'all'].join(', ')}.`,
    }
  );
}

export function orderWithDeps(m: Manifest, names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of m.apps[n].depends_on) visit(d.app);
    out.push(n);
  };
  for (const n of names) visit(n);
  return out;
}

/**
 * Refuse before touching pm2 when one of the names already belongs to someone else: pm2 would restart that
 * process with this project's config instead of starting a new one. "Someone else" is another namespace, or the
 * same namespace running from another directory (a second checkout declaring the same `project`).
 */
export function assertNoCollision(
  ctx: Context,
  procs: Pm2Process[],
  names: string[]
): void {
  for (const n of names) {
    const name = pm2Name(ctx.manifest.project, n);
    const expectedCwd = appCwd(ctx.host, ctx.manifest.apps[n]);
    const other = procs.find(
      (p) =>
        p.name === name &&
        (p.namespace !== ctx.manifest.project ||
          (p.cwd !== '' && path.posix.resolve(p.cwd) !== expectedCwd))
    );
    if (other && other.namespace !== ctx.manifest.project) {
      throw new McprocError(
        'NAME_COLLISION',
        `pm2 process "${name}" on ${ctx.transport.describe()} belongs to namespace "${other.namespace}" (running from ${other.cwd || 'an unknown cwd'}), not to this project`,
        {
          hint: 'pm2 would restart that process with this config. Give this checkout a distinct `project:` in .mcproc/mcproc.yaml, or delete the other process if it is stale.',
        }
      );
    }
    if (other) {
      throw new McprocError(
        'NAME_COLLISION',
        `"${n}" (pm2 process "${name}") on ${ctx.transport.describe()} is running from ${other.cwd}, not from ${expectedCwd}`,
        {
          hint: `pm2 keeps a process's cwd on restart. If the app moved in the manifest, run delete ${n} then start ${n}; if this is another checkout of the same project, give it its own \`project:\`.`,
        }
      );
    }
  }
}

/** A target string resolves within the context's host (an app, a profile or "all"); a list is taken as already resolved and ordered. */
export type Targets = string | string[];
const namesOf = (ctx: Context, t: Targets) =>
  typeof t === 'string' ? resolveTargets(ctx.manifest, t) : t;

export async function shipEcosystem(ctx: Context): Promise<string> {
  const eco = buildEcosystem(ctx.manifest, ctx.host);
  const file = ecosystemPath(ctx.host);
  const dir = generatedDir(ctx.host);
  const gi = path.posix.join(path.posix.dirname(dir), '.gitignore');
  const cmd = `mkdir -p ${shq(dir)} && { [ -e ${shq(gi)} ] || printf '*\\n' > ${shq(gi)}; } && cat > ${shq(file)}`;
  const res = ensureOk(
    await ctx.transport.exec(cmd, { stdin: JSON.stringify(eco, null, 2) }),
    ctx.host,
    'write ecosystem'
  );
  if (res.code !== 0)
    throw new McprocError(
      'TRANSPORT_FAILED',
      `Could not write ${file} on ${ctx.transport.describe()}: ${res.stderr.trim()}`
    );
  return file;
}

/** One wait made on behalf of an app before it started: how long, and how it ended. */
export interface WaitRecord {
  app: string;
  dep: string;
  condition: DepCondition;
  ms: number;
  ok: boolean;
  reason?: string;
}
export interface StartOptions {
  reload?: boolean;
  /** waits for one dependency (default: on this context); actOn passes one that finds the dependency's host */
  waitDep?: (dep: Dep, forApp: string) => Promise<WaitResult>;
  /** the dependencies of an app to wait for; default the context's (host-scoped) manifest entry, the fleet passes the full manifest's */
  depsOf?: (app: string) => Dep[];
  /** every wait made, appended */
  waits?: WaitRecord[];
  /** apps that failed or were skipped so far (app -> why), shared across host runs by actOn */
  failed?: Map<string, string>;
  /** ends the default dependency wait as `aborted` (a client that cancelled the call); a waitDep of the caller's own is not given it */
  signal?: AbortSignal;
}

/**
 * Starts the apps in dependency order. Before launching an app it waits, in the order declared, for each of its
 * ready/completed dependencies; one that times out, fails or dies leaves the app (and everything that depends on
 * it) unstarted: its row is `skipped` with the reason, while unrelated apps still start.
 */
export async function startApps(
  ctx: Context,
  target: Targets,
  opts: StartOptions = {}
): Promise<LsRow[]> {
  const names =
    typeof target === 'string'
      ? orderWithDeps(ctx.manifest, namesOf(ctx, target))
      : target;
  const waitDep =
    opts.waitDep ??
    ((d: Dep) => waitDependency(ctx, d, { signal: opts.signal }));
  const depsOf =
    opts.depsOf ?? ((n: string) => ctx.manifest.apps[n].depends_on);
  const failed = opts.failed ?? new Map<string, string>();
  const skipped = new Map<string, string>();
  /** an app that is not started, and the apps that need it must not be either */
  const skip = (n: string, why: string) => {
    skipped.set(n, why);
    failed.set(n, why);
  };
  /** One dependency wait, recorded. Why it is unmet, or undefined when met; a wait that throws (a host that cannot be reached, say) is an unmet one, not a crash of the whole start. */
  const unmetAfterWait = async (d: Dep, n: string) => {
    const t0 = Date.now();
    const record = (ok: boolean, reason?: string) =>
      opts.waits?.push({
        app: n,
        dep: d.app,
        condition: d.condition,
        ms: Date.now() - t0,
        ok,
        ...(reason ? { reason } : {}),
      });
    try {
      const r = await waitDep(d, n);
      record(r.ok, r.reason);
      return r.ok ? undefined : depFailure(d, r);
    } catch (e) {
      record(false, 'error');
      return `${d.app}: ${describeError(e)}`;
    }
  };
  const file = await shipEcosystem(ctx);
  const before = await ctx.pm2.jlist(); // pm2's own list: the URL checks of a full probe could time out the start before it began
  assertNoCollision(ctx, before, names);
  for (const n of names) {
    // running already: left alone, whatever happened to what it needs (it is neither waited for nor skipped)
    const p = findProcess(before, ctx.manifest.project, n);
    if (p && p.status === 'online' && !opts.reload) continue;
    if (failed.has(n)) {
      // decided before this run (a dependency on another host failed, timed out or was not started)
      skip(n, failed.get(n)!);
      continue;
    }
    // a dependency that did not start (on this host or another): the dependent cannot either
    const blocked = depsOf(n).find((d) => failed.has(d.app));
    if (blocked) {
      skip(
        n,
        `skipped: ${blocked.app} was not started (${failed.get(blocked.app)})`
      );
      continue;
    }
    let unmet: string | undefined;
    for (const d of depsOf(n)) {
      if (d.condition === 'started') continue;
      unmet = await unmetAfterWait(d, n);
      if (unmet !== undefined) break;
    }
    if (unmet !== undefined) {
      skip(n, unmet);
      continue;
    }
    await ctx.pm2.startOrRestart(file, pm2Name(ctx.manifest.project, n));
  }
  const live = names.filter((n) => !skipped.has(n));
  const rows = live.length
    ? rowsFor(ctx, await snapshot(ctx, { urls: live }), live)
    : [];
  const byApp = new Map(rows.map((r) => [r.app, r]));
  return names.map(
    (n) =>
      byApp.get(n) ??
      unreachableRow(
        ctx.manifest.apps[n],
        ctx.host.name,
        skipped.get(n)!,
        'skipped'
      )
  );
}

export async function restartApps(
  ctx: Context,
  target: Targets
): Promise<LsRow[]> {
  const names = namesOf(ctx, target);
  const file = await shipEcosystem(ctx);
  assertNoCollision(ctx, await ctx.pm2.jlist(), names);
  for (const n of names)
    await ctx.pm2.startOrRestart(file, pm2Name(ctx.manifest.project, n));
  return rowsFor(ctx, await snapshot(ctx, { urls: names }), names);
}

/** Stop or delete acts from pm2's own list and answers without URL checks: no stalled URL can hold back taking an app down. */
async function forEachProcess(
  ctx: Context,
  target: Targets,
  act: (id: number, status: string) => Promise<unknown>
): Promise<LsRow[]> {
  const names = namesOf(ctx, target);
  const procs = await ctx.pm2.jlist();
  for (const n of names) {
    const p = findProcess(procs, ctx.manifest.project, n);
    if (p) await act(p.pm_id, p.status);
  }
  return rowsFor(ctx, await snapshot(ctx, { urls: 'none' }), names);
}

export function stopApps(ctx: Context, target: Targets): Promise<LsRow[]> {
  return forEachProcess(ctx, target, (id, status) =>
    status === 'stopped' ? Promise.resolve() : ctx.pm2.stop(id)
  );
}

export function deleteApps(ctx: Context, target: Targets): Promise<LsRow[]> {
  return forEachProcess(ctx, target, (id) => ctx.pm2.delete(id));
}

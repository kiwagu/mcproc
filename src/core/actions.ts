import path from 'node:path';
import { McprocError } from './errors.js';
import type { Manifest } from './manifest.js';
import { appCwd, buildEcosystem, ecosystemPath, generatedDir } from './ecosystem.js';
import { findProcess, pm2Name, type Pm2Process } from './pm2.js';
import { rowsFor, snapshot, type LsRow } from './list.js';
import type { Context } from './resolve.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';

export function resolveTargets(m: Manifest, target: string): string[] {
  if (target === 'all') return Object.keys(m.apps);
  if (m.profiles[target]) return [...m.profiles[target]];
  if (m.apps[target]) return [target];
  throw new McprocError('UNKNOWN_APP', `"${target}" is neither an app nor a profile in ${m.path}`, {
    hint: `Apps: ${Object.keys(m.apps).join(', ')}. Profiles: ${[...Object.keys(m.profiles), 'all'].join(', ')}.`,
  });
}

export function orderWithDeps(m: Manifest, names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of m.apps[n].depends_on) visit(d);
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
export function assertNoCollision(ctx: Context, procs: Pm2Process[], names: string[]): void {
  for (const n of names) {
    const name = pm2Name(ctx.manifest.project, n);
    const expectedCwd = appCwd(ctx.host, ctx.manifest.apps[n]);
    const other = procs.find((p) => p.name === name && (p.namespace !== ctx.manifest.project || (p.cwd !== '' && path.posix.resolve(p.cwd) !== expectedCwd)));
    if (other && other.namespace !== ctx.manifest.project) {
      throw new McprocError('NAME_COLLISION', `pm2 process "${name}" on ${ctx.transport.describe()} belongs to namespace "${other.namespace}" (running from ${other.cwd || 'an unknown cwd'}), not to this project`, {
        hint: 'pm2 would restart that process with this config. Give this checkout a distinct `project:` in .mcproc/mcproc.yaml, or delete the other process if it is stale.',
      });
    }
    if (other) {
      throw new McprocError('NAME_COLLISION', `"${n}" (pm2 process "${name}") on ${ctx.transport.describe()} is running from ${other.cwd}, not from ${expectedCwd}`, {
        hint: `pm2 keeps a process's cwd on restart. If the app moved in the manifest, run delete ${n} then start ${n}; if this is another checkout of the same project, give it its own \`project:\`.`,
      });
    }
  }
}

/** A target string resolves within the context's host (an app, a profile or "all"); a list is taken as already resolved and ordered. */
export type Targets = string | string[];
const namesOf = (ctx: Context, t: Targets) => (typeof t === 'string' ? resolveTargets(ctx.manifest, t) : t);

export async function shipEcosystem(ctx: Context): Promise<string> {
  const eco = buildEcosystem(ctx.manifest, ctx.host);
  const file = ecosystemPath(ctx.host);
  const dir = generatedDir(ctx.host);
  const gi = path.posix.join(path.posix.dirname(dir), '.gitignore');
  const cmd = `mkdir -p ${shq(dir)} && { [ -e ${shq(gi)} ] || printf '*\\n' > ${shq(gi)}; } && cat > ${shq(file)}`;
  const res = ensureOk(await ctx.transport.exec(cmd, { stdin: JSON.stringify(eco, null, 2) }), ctx.host, 'write ecosystem');
  if (res.code !== 0) throw new McprocError('TRANSPORT_FAILED', `Could not write ${file} on ${ctx.transport.describe()}: ${res.stderr.trim()}`);
  return file;
}

export async function startApps(ctx: Context, target: Targets, opts: { reload?: boolean } = {}): Promise<LsRow[]> {
  const names = typeof target === 'string' ? orderWithDeps(ctx.manifest, namesOf(ctx, target)) : target;
  const file = await shipEcosystem(ctx);
  const before = await snapshot(ctx);
  assertNoCollision(ctx, before.procs, names);
  for (const n of names) {
    const p = findProcess(before.procs, ctx.manifest.project, n);
    if (p && p.status === 'online' && !opts.reload) continue;
    await ctx.pm2.startOrRestart(file, pm2Name(ctx.manifest.project, n));
  }
  return rowsFor(ctx, await snapshot(ctx), names);
}

export async function restartApps(ctx: Context, target: Targets): Promise<LsRow[]> {
  const names = namesOf(ctx, target);
  const file = await shipEcosystem(ctx);
  assertNoCollision(ctx, await ctx.pm2.jlist(), names);
  for (const n of names) await ctx.pm2.startOrRestart(file, pm2Name(ctx.manifest.project, n));
  return rowsFor(ctx, await snapshot(ctx), names);
}

async function forEachProcess(ctx: Context, target: Targets, act: (id: number, status: string) => Promise<unknown>): Promise<LsRow[]> {
  const names = namesOf(ctx, target);
  const snap = await snapshot(ctx);
  for (const n of names) {
    const p = findProcess(snap.procs, ctx.manifest.project, n);
    if (p) await act(p.pm_id, p.status);
  }
  return rowsFor(ctx, await snapshot(ctx), names);
}

export function stopApps(ctx: Context, target: Targets): Promise<LsRow[]> {
  return forEachProcess(ctx, target, (id, status) => (status === 'stopped' ? Promise.resolve() : ctx.pm2.stop(id)));
}

export function deleteApps(ctx: Context, target: Targets): Promise<LsRow[]> {
  return forEachProcess(ctx, target, (id) => ctx.pm2.delete(id));
}

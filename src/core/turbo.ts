import fs from 'node:fs';
import path from 'node:path';

// biome-ignore lint/suspicious/noExplicitAny: package.json, turbo.json and the like are untyped data, probed field by field
export function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** turbo.json: turbo 2 writes `tasks`, turbo 1 `pipeline`; a persistent task is one that keeps running (a dev server). */
export interface TurboConfig {
  version: 1 | 2;
  tasks: string[];
  persistent: string[];
}
export function readTurbo(root: string): TurboConfig | null {
  const raw = readJson(path.join(root, 'turbo.json'));
  const tasks = raw?.tasks ?? raw?.pipeline;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return null;
  const names = Object.keys(tasks);
  return {
    version: raw.tasks ? 2 : 1,
    tasks: names,
    persistent: names.filter((t) => tasks[t]?.persistent === true),
  };
}

/** A workspace package as init sees it: its scripts, the workspace packages it depends on, whether it is consumed from dist/. */
export interface WsPackage {
  name: string;
  dir: string;
  scripts: Record<string, string>;
  deps: string[];
  distLib: boolean;
}

const DIST = /^\.?\/?dist\//;
const strings = (v: unknown): string[] =>
  typeof v === 'string'
    ? [v]
    : v && typeof v === 'object'
      ? Object.values(v as Record<string, unknown>).flatMap(strings)
      : [];
/** A library built into dist/: it has a build script and an entry point (main, module, types or any exports target) under dist/. */
export function isDistLib(pkg: {
  scripts?: Record<string, string>;
  main?: unknown;
  module?: unknown;
  types?: unknown;
  exports?: unknown;
}): boolean {
  if (!pkg.scripts?.build) return false;
  return [pkg.main, pkg.module, pkg.types, ...strings(pkg.exports)].some(
    (s) => typeof s === 'string' && DIST.test(s)
  );
}

export function loadWorkspace(root: string, dirs: string[]): WsPackage[] {
  const out: WsPackage[] = [];
  for (const dir of dirs) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (!pkg) continue;
    const deps = new Set<string>();
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies'])
      for (const d of Object.keys(pkg[k] ?? {})) deps.add(d);
    out.push({
      name: String(pkg.name ?? path.basename(dir)),
      dir: path.relative(root, dir) || '.',
      scripts: { ...(pkg.scripts ?? {}) },
      deps: [...deps],
      distLib: isDistLib(pkg),
    });
  }
  return out;
}

/** The dist libraries a package reaches through workspace dependencies, itself excluded; cycles are walked once. */
export function dependsOnDistLib(
  pkg: WsPackage,
  all: WsPackage[],
  libs: Set<string>
): string[] {
  const byName = new Map(all.map((p) => [p.name, p]));
  const seen = new Set<string>([pkg.name]);
  const found: string[] = [];
  const queue = [...pkg.deps];
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    const p = byName.get(n);
    if (!p) continue;
    if (libs.has(n)) found.push(n);
    queue.push(...p.deps);
  }
  return found;
}

/** How turbo is invoked for the package manager `pmFor` detected. */
export function turboBin(pm: string): string {
  if (pm === 'yarn') return 'yarn turbo';
  if (pm === 'pnpm') return 'pnpm exec turbo';
  if (pm === 'bun run') return 'bunx turbo';
  return 'npx turbo';
}

/**
 * One folder filter per globbed workspace folder whose packages with a build script are all folded libraries. A
 * library elsewhere, or in a folder that also holds another package with a build script (an app, a library live
 * through its own dev task, a package not built into dist/), is filtered by name: the folder filter would build and
 * watch that package too, a build nobody asked for, or a second writer beside its own dev task (`next build` under
 * `next dev`, which share `.next/`). `all` is every workspace package, the folded ones included.
 */
export function libsFilters(
  libs: WsPackage[],
  globParents: string[],
  all: WsPackage[] = []
): string[] {
  const folded = new Set(libs.map((l) => l.name));
  const shared = new Set(
    all
      .filter((p) => p.scripts.build && !folded.has(p.name))
      .map((p) => path.dirname(p.dir))
  );
  const out: string[] = [];
  for (const l of libs) {
    const parent = path.dirname(l.dir);
    const f =
      globParents.includes(parent) && !shared.has(parent)
        ? `--filter='./${parent}/*'`
        : `--filter=${l.name}`;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

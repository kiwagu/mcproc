import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { McprocError } from './errors.js';
import { defaultProject, MANIFEST_REL, type AppKind } from './manifest.js';
import {
  dependsOnDistLib,
  libsFilters,
  loadWorkspace,
  readJson,
  readTurbo,
  turboBin,
  type WsPackage,
} from './turbo.js';

export interface Candidate {
  name: string;
  source: string;
  run: string;
  cwd: string;
  kind: AppKind | 'unknown';
  port?: number;
  /** Written uncommented: part of the dev stack the draft starts with. */
  live?: boolean;
  /** Live apps: the placeholder; libs/libs-watch: their own text. */
  description?: string;
  depends_on?: { app: string; condition: 'completed' }[];
  /** One comment line written under the candidate. */
  note?: string;
}
/** A profile of the draft; a live one is written uncommented. */
export interface DraftProfile {
  name: string;
  apps: string[];
  live: boolean;
}
export interface Discovery {
  candidates: Candidate[];
  notes: string[];
  profiles: DraftProfile[];
  /** The package names folded into the libs builders ([] when none). */
  libs: string[];
}
/** A live app needs a description to load; this one tells the human to write the real one. */
export const LIVE_DESCRIPTION = 'TODO: what this app does';
export interface InitResult {
  path: string;
  created: string[];
  candidates: number;
  by_source: Record<string, number>;
  next: string;
}

const SCRIPT_RE =
  /dev|start|serve|watch|build|worker|queue|cron|preview|migrate|seed|once/i;
/** A command that keeps running and rebuilds on change. */
const WATCH_RE = /(--watch|\bwatch\b|\s-w\b|tsc -b -w)/i;
const SERVERISH_RE = /\b(dev|serve|start|preview)\b/i;
/** Script names of one-shot jobs: a build, a migration, a seed. */
const ONCE_RE = /\b(build|migrate|seed|once)\b/i;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'target',
  'vendor',
]);

export function sanitizeName(s: string): string {
  const n = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return n || 'app';
}

function pmFor(root: string): string {
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (
    fs.existsSync(path.join(root, 'bun.lock')) ||
    fs.existsSync(path.join(root, 'bun.lockb'))
  )
    return 'bun run';
  return 'npm run';
}

export function walk(dir: string, maxDepth: number, depth = 0): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      if (depth < maxDepth) out.push(...walk(p, maxDepth, depth + 1));
    } else out.push(p);
  }
  return out;
}

export function guessKind(name: string, cmd: string): AppKind | 'unknown' {
  const s = `${name} ${cmd}`;
  if (/worker|queue|cron|consumer/i.test(s)) return 'worker';
  const serverish = SERVERISH_RE.test(name);
  if (WATCH_RE.test(s) && !serverish) return 'build';
  if (ONCE_RE.test(name) && !serverish) return 'task';
  if (SERVERISH_RE.test(s)) return 'server';
  return 'unknown';
}

/** `next dev` / `next start` listen on 3000 unless a flag says otherwise. */
const NEXT_RE = /\bnext\s+(dev|start)\b/;
/**
 * `vite` and its subcommand; the lookahead keeps `vitest`, `vite-node` and a
 * `vite.config.ts` argument out. Global: a script may chain
 * `vite build && vite preview`, where the server is the second call.
 */
const VITE_RE = /(?:^|[\s&;])vite(?![\w.-])(?:\s+(\w+))?/g;
const VITE_CONFIGS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map(
  (e) => `vite.config.${e}`
);
/**
 * A `port:` value: a literal, or the fallback of an env read
 * (`?? N`, `|| 'N'`, `Number(process.env.X) || N`).
 */
const PORT_VALUE =
  /\bport\s*:\s*(?:Number\(\s*)?(?:process\.env\.[A-Za-z_0-9]+\s*\)?\s*(?:\?\?|\|\|)\s*)?["']?(\d{2,5})\b/;

/**
 * Vite's port from its config: the `server` or `preview` block's `port`, a
 * literal or the fallback of an env read. Every `<section>: {` is tried in
 * order, since a block of that name without a port can come first (vitest's
 * `test: { server: { deps } }`).
 */
function vitePort(
  dir: string,
  section: 'server' | 'preview'
): number | undefined {
  for (const f of VITE_CONFIGS) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const h of text.matchAll(
      new RegExp(`\\b${section}\\s*:\\s*\\{`, 'g')
    )) {
      const at = h.index;
      // the block's text up to its closing brace, nested braces (proxy maps) counted
      let depth = 0;
      let end = at + h[0].length - 1;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      // a `port:` of the block itself, not of a nested map such as `hmr: { port }`:
      // one pass drops every brace pair with no brace inside (the block's own pair
      // is never one: its closing brace is not in the slice); what deeper maps
      // such as proxy entries leave behind holds no `port:` key in practice
      const flat = text.slice(at, end).replace(/\{[^{}]*\}/g, '');
      const m = PORT_VALUE.exec(flat);
      if (m) return Number(m[1]);
    }
    return undefined;
  }
  return undefined;
}

export function guessPort(cmd: string, dir: string): number | undefined {
  const m = /(?:\bPORT=|--port[= ]|\s-p\s)(\d{2,5})\b/.exec(cmd);
  if (m) return Number(m[1]);
  for (const f of ['.env', '.env.local', '.env.development']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const e = /^\s*PORT=["']?(\d{2,5})/m.exec(fs.readFileSync(p, 'utf8'));
    if (e) return Number(e[1]);
  }
  if (NEXT_RE.test(cmd)) return 3000;
  const vite = [...cmd.matchAll(VITE_RE)].find((v) => v[1] !== 'build');
  if (vite) {
    const section = vite[1] === 'preview' ? 'preview' : 'server';
    return vitePort(dir, section) ?? (section === 'server' ? 5173 : 4173);
  }
  const src = path.join(dir, 'src');
  if (fs.existsSync(src)) {
    for (const f of walk(src, 3)
      .filter((x) => /\.(ts|js|mjs|cjs|tsx|jsx)$/.test(x))
      .slice(0, 200)) {
      const text = fs.readFileSync(f, 'utf8');
      // `PORT\b` keeps names such as PORTAL out
      const l =
        /\.listen\(\s*(\d{2,5})\b/.exec(text) ??
        /\b(?:DEFAULT_)?PORT\b\s*(?::\s*number)?\s*=\s*(\d{2,5})\b/.exec(
          text
        ) ??
        /\bPORT\s*\)?\s*(?:\?\?|\|\|)\s*["']?(\d{2,5})\b/.exec(text);
      if (l) return Number(l[1]);
    }
  }
  return undefined;
}

/** A one-shot job (build, task) declares no port, so none is guessed for it. */
function portFor(
  kind: AppKind | 'unknown',
  cmd: string,
  dir: string
): number | undefined {
  return kind === 'build' || kind === 'task' ? undefined : guessPort(cmd, dir);
}

/** The app name of a package: its name without the npm scope. */
const pkgAppName = (name: string): string =>
  sanitizeName(name.split('/').pop()!);

/** How a workspace package takes part in turbo's live dev task. */
interface PkgTurbo {
  liveTask: string;
  /** A dist library live through its own dev task: a build app, no port. */
  isLib: boolean;
  /** Depends on a library folded into libs: waits for its first build. */
  waitsForLibs: boolean;
  /** Live dist libraries it depends on: their first build is not awaited. */
  liveLibDeps: string[];
  /** Its build script is folded into libs. */
  dropBuild: boolean;
  libsName: string;
}

const notAwaited = (lib: string): string => {
  const app = pkgAppName(lib);
  return `${app}'s first build is not awaited; uncomment ${app}-build and add depends_on: [{ app: ${app}-build, condition: completed }] to wait for it`;
};

function packageCandidates(
  root: string,
  pkgDir: string,
  pm: string,
  turbo?: PkgTurbo
): Candidate[] {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  if (!pkg?.scripts) return [];
  const rel = path.relative(root, pkgDir) || '.';
  const appName = pkgAppName(String(pkg.name ?? path.basename(pkgDir)));
  const prefix = rel === '.' ? '' : `${appName}-`;
  const file = `${rel === '.' ? '' : `${rel}/`}package.json`;
  const out: Candidate[] = [];
  for (const [n, cmd] of Object.entries(
    pkg.scripts as Record<string, string>
  )) {
    if (!SCRIPT_RE.test(n)) continue;
    const kind = guessKind(n, cmd);
    if (turbo?.dropBuild && n === 'build') continue;
    if (turbo && n === turbo.liveTask) {
      out.push({
        name: appName,
        source: `${file}:${n}`,
        run: `${pm} ${n}`,
        cwd: rel,
        kind: turbo.isLib ? 'build' : kind,
        port: turbo.isLib ? undefined : portFor(kind, cmd, pkgDir),
        live: true,
        description: LIVE_DESCRIPTION,
        ...(turbo.waitsForLibs
          ? { depends_on: [{ app: turbo.libsName, condition: 'completed' }] }
          : {}),
        ...(turbo.liveLibDeps.length
          ? { note: turbo.liveLibDeps.map(notAwaited).join('; ') }
          : {}),
      });
      continue;
    }
    out.push({
      name: sanitizeName(prefix + n),
      source: `${file}:${n}`,
      run: `${pm} ${n}`,
      cwd: rel,
      kind,
      port: portFor(kind, cmd, pkgDir),
    });
  }
  return out;
}

/** Supports "dir/*", "dir/**" and exact-directory workspace patterns; anything else is reported, not guessed. */
function expandWorkspaces(
  root: string,
  patterns: string[]
): { dirs: string[]; unsupported: string[]; globParents: string[] } {
  const dirs = new Set<string>();
  const unsupported: string[] = [];
  const globParents: string[] = [];
  for (const pat of patterns) {
    const glob = /^(.*?)\/\*\*?$/.exec(pat);
    if (glob) {
      const base = path.join(root, glob[1]);
      // relative to the root, so `./packages/*` and `packages/*` name one folder
      globParents.push(path.relative(root, base));
      let names: string[] = [];
      try {
        names = fs.readdirSync(base);
      } catch {
        /* no such dir */
      }
      names.sort();
      for (const d of names)
        if (fs.existsSync(path.join(base, d, 'package.json')))
          dirs.add(path.join(base, d));
    } else if (pat.includes('*')) {
      unsupported.push(pat);
    } else if (fs.existsSync(path.join(root, pat, 'package.json'))) {
      dirs.add(path.join(root, pat));
    }
  }
  return { dirs: [...dirs], unsupported, globParents };
}

/**
 * The builders that stand for every dist library without a dev script of its
 * own: a one-shot build the live apps wait for, then a watch that keeps dist/
 * fresh. `turbo watch` came with turbo 2, so turbo 1 gets the build alone.
 */
function libsBuilders(
  folded: WsPackage[],
  liveLibs: WsPackage[],
  globParents: string[],
  pm: string,
  version: 1 | 2
): Candidate[] {
  const bin = turboBin(pm);
  // turbo 2's interactive UI would hold the terminal; turbo 1 has no --ui flag
  const ui = version === 2 ? ' --ui=stream' : '';
  const filters = libsFilters(folded, globParents, liveLibs).join(' ');
  const parents = [...new Set(folded.map((p) => path.dirname(p.dir)))].join(
    ', '
  );
  const libs: Candidate = {
    name: 'libs',
    source: 'turbo.json:build',
    run: `${bin} run build ${filters}${ui}`,
    cwd: '.',
    kind: 'task',
    live: true,
    description: `one-shot build of the libraries consumed from dist/ (${parents}); the apps import these builds`,
  };
  if (version === 1) return [libs];
  return [
    libs,
    {
      name: 'libs-watch',
      source: 'turbo.json:build',
      run: `${bin} watch build ${filters}${ui}`,
      cwd: '.',
      kind: 'build',
      live: true,
      description:
        "rebuilds a changed library's dist/ (and its dependents) while you work",
      depends_on: [{ app: 'libs', condition: 'completed' }],
    },
  ];
}

/**
 * The live profile of the dev task's apps, and a commented one per other
 * persistent task. A profile may not share an app's name, so the live one
 * steps aside when a live app is called `dev`.
 */
function draftProfiles(
  candidates: Candidate[],
  persistent: string[]
): DraftProfile[] {
  const live = candidates.filter((c) => c.live).map((c) => c.name);
  const out: DraftProfile[] = [
    { name: live.includes('dev') ? 'dev-apps' : 'dev', apps: live, live: true },
  ];
  for (const t of persistent.filter((t) => t !== 'dev')) {
    // a package's own script: the root one runs the task over every package
    const apps = candidates
      .filter(
        (c) =>
          !c.live &&
          /\/package\.json:/.test(c.source) &&
          c.source.endsWith(`:${t}`)
      )
      .map((c) => c.name);
    if (apps.length) out.push({ name: t, apps, live: false });
  }
  return out;
}

export function discover(root: string): Discovery {
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  const pm = pmFor(root);

  const pkg = readJson(path.join(root, 'package.json'));
  const ws: string[] = Array.isArray(pkg?.workspaces)
    ? [...pkg.workspaces]
    : Array.isArray(pkg?.workspaces?.packages)
      ? [...pkg.workspaces.packages]
      : [];
  const pnpmWs = path.join(root, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmWs)) {
    try {
      const y = parseYaml(fs.readFileSync(pnpmWs, 'utf8'));
      if (Array.isArray(y?.packages)) ws.push(...y.packages);
    } catch {
      notes.push('pnpm-workspace.yaml could not be parsed');
    }
  }
  const expanded = expandWorkspaces(root, ws);

  const turbo = readTurbo(root);
  const turboFile = path.join(root, 'turbo.json');
  if (!turbo && fs.existsSync(turboFile) && readJson(turboFile) === null)
    notes.push(
      "turbo.json could not be parsed (comments are not read); drafted without turbo's tasks"
    );
  // only the bare task: a package-scoped key (`web#dev`) configures one package, not the stack
  const pkgs = turbo?.persistent.includes('dev')
    ? loadWorkspace(root, expanded.dirs)
    : [];
  // the live stack is the packages implementing the task; with none there is nothing to start
  const liveTask = pkgs.some((p) => p.scripts.dev) ? 'dev' : null;
  // a dist library with a dev script of its own is live through it; the rest are built by libs
  const folded = liveTask
    ? pkgs.filter((p) => p.distLib && !p.scripts[liveTask])
    : [];
  const foldedNames = new Set(folded.map((p) => p.name));
  const liveLibs = liveTask
    ? pkgs.filter((p) => p.distLib && p.scripts[liveTask])
    : [];
  const liveLibNames = new Set(liveLibs.map((p) => p.name));
  if (turbo && folded.length) {
    candidates.push(
      ...libsBuilders(folded, liveLibs, expanded.globParents, pm, turbo.version)
    );
    const one = folded.length === 1;
    const apps = turbo.version === 1 ? 'libs' : 'libs and libs-watch';
    notes.push(
      `${folded.length} librar${one ? 'y' : 'ies'} built into dist/ ${one ? 'is' : 'are'} drafted as ${apps}: ${folded.map((p) => p.name).join(', ')}`
    );
    if (turbo.version === 1)
      notes.push(
        'turbo 1 has no turbo watch: libs-watch is not drafted; run libs again after changing a library, or move to turbo 2'
      );
  }

  candidates.push(...packageCandidates(root, root, pm));
  if (liveTask)
    for (const c of candidates)
      if (c.source === 'package.json:dev')
        c.note =
          'the dev profile replaces this: turbo would start every package as one process';
  for (const dir of expanded.dirs) {
    const p = liveTask
      ? pkgs.find((x) => x.dir === path.relative(root, dir))
      : undefined;
    candidates.push(
      ...packageCandidates(
        root,
        dir,
        pm,
        liveTask && p
          ? {
              liveTask,
              isLib: p.distLib,
              waitsForLibs: dependsOnDistLib(p, pkgs, foldedNames).length > 0,
              liveLibDeps: dependsOnDistLib(p, pkgs, liveLibNames),
              dropBuild: foldedNames.has(p.name),
              libsName: 'libs',
            }
          : undefined
      )
    );
  }
  for (const pat of expanded.unsupported)
    notes.push(
      `workspace pattern "${pat}" is not expanded by init; add its packages' scripts by hand`
    );

  for (const f of walk(root, 4).filter(
    (p) => path.basename(p) === 'project.json'
  )) {
    const pj = readJson(f);
    if (!pj?.targets) continue;
    const name = String(pj.name ?? path.basename(path.dirname(f)));
    for (const t of ['serve', 'dev', 'build'] as const) {
      if (!pj.targets[t]) continue;
      candidates.push({
        name: sanitizeName(`${name}-${t}`),
        source: `${path.relative(root, f)}:${t}`,
        run: `npx nx run ${name}:${t}${t === 'build' ? ' --watch' : ''}`,
        cwd: '.',
        kind: t === 'build' ? 'build' : 'server',
        port: t === 'build' ? undefined : guessPort('', path.dirname(f)),
      });
    }
  }

  for (const t of turbo?.tasks ?? []) {
    if (
      !SCRIPT_RE.test(t) ||
      candidates.some((c) => c.source.endsWith(`package.json:${t}`))
    )
      continue;
    candidates.push({
      name: sanitizeName(`turbo-${t}`),
      source: `turbo.json:${t}`,
      run: `npx turbo run ${t}`,
      cwd: '.',
      kind: guessKind(t, ''),
    });
  }

  const eco = readJson(path.join(root, 'ecosystem.json'));
  if (Array.isArray(eco?.apps)) {
    for (const a of eco.apps) {
      if (!a?.name) continue;
      const args = Array.isArray(a.args)
        ? a.args.join(' ')
        : String(a.args ?? '');
      const interp =
        a.interpreter && a.interpreter !== 'node' && a.interpreter !== 'none'
          ? `${a.interpreter} `
          : /\.(c|m)?js$/.test(String(a.script ?? ''))
            ? 'node '
            : '';
      candidates.push({
        name: sanitizeName(String(a.name)),
        source: `ecosystem.json:${a.name}`,
        run: `${interp}${a.script ?? ''} ${args}`.trim(),
        cwd: String(a.cwd ?? '.'),
        kind: 'server',
        port: Number(a.env?.PORT) || undefined,
      });
    }
  }
  for (const f of [
    'ecosystem.config.js',
    'ecosystem.config.cjs',
    'ecosystem.config.mjs',
  ]) {
    if (fs.existsSync(path.join(root, f)))
      notes.push(
        `${f} found: JavaScript ecosystem files are not executed by init; port its apps by hand`
      );
  }

  const procfile = path.join(root, 'Procfile');
  if (fs.existsSync(procfile)) {
    for (const line of fs.readFileSync(procfile, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);
      if (m) {
        const kind = guessKind(m[1], m[2]);
        candidates.push({
          name: sanitizeName(m[1]),
          source: `Procfile:${m[1]}`,
          run: m[2].trim(),
          cwd: '.',
          kind,
          port: portFor(kind, m[2], root),
        });
      }
    }
  }

  const seen = new Map<string, number>();
  for (const c of candidates) {
    const n = seen.get(c.name) ?? 0;
    seen.set(c.name, n + 1);
    if (n) c.name = `${c.name}-${n + 1}`;
  }
  // libs comes first, so the dedupe above never renames it and depends_on: libs holds
  return {
    candidates,
    notes,
    profiles:
      turbo && liveTask ? draftProfiles(candidates, turbo.persistent) : [],
    libs: folded.map((p) => p.name),
  };
}

function yamlStr(s: string): string {
  return /[:#'"{}[\],&*?|<>=!%@`]/.test(s) || /^\s|\s$/.test(s)
    ? JSON.stringify(s)
    : s;
}

export function renderDraft(
  root: string,
  project: string,
  d: Discovery
): string {
  const L: string[] = [
    `# mcproc manifest draft, generated on ${new Date().toISOString().slice(0, 10)} from ${root}`,
    '#',
    '# Candidates below are commented out. Uncomment the ones your dev stack needs,',
    '# write a description for each app, then run start + ls to confirm the ports; fix; repeat.',
    '# Fields: kind build|server|worker|task (task = runs once, e.g. a build or a migration; ls shows done/failed); run = shell command; cwd relative to the project root;',
    '# port/ports = declared listening ports; watch = pm2 watch paths (restart a server when its',
    '# build output changes); depends_on = start order; profiles = named groups of apps;',
    '# url = the address to open in a browser; ls/describe show it with the HTTP answer, monit shows it;',
    '# hosts = where this project also runs (ssh alias from ~/.ssh/config and/or docker container);',
    '# host = the one host an app always runs on (e.g. a dev container); without it the app runs where --host points.',
  ];
  for (const n of d.notes) L.push(`# note: ${n}`);
  L.push('version: 1', `project: ${project}`, 'apps:');
  if (d.candidates.length === 0)
    L.push(
      '  # no launch candidates found; add apps by hand, e.g.',
      '  # api:',
      '  #   description: HTTP API',
      '  #   run: npm run dev',
      '  #   port: 3000'
    );
  for (const c of d.candidates) {
    L.push(
      `  # ${c.name}:    # source: ${c.source}; kind? ${c.kind}${c.port ? `; port? ${c.port}` : ''}`
    );
    L.push('  #   description: ""');
    if (c.kind !== 'unknown') L.push(`  #   kind: ${c.kind}`);
    L.push(`  #   run: ${yamlStr(c.run)}`);
    if (c.cwd !== '.') L.push(`  #   cwd: ${c.cwd}`);
    if (c.port) L.push(`  #   port: ${c.port}`);
    if (c.port && c.kind !== 'worker')
      L.push(`  #   url: http://localhost:${c.port}`);
  }
  L.push(
    'profiles:',
    '  # base: [api-build, api]',
    'hosts:',
    '  # stand: { ssh: my-alias, cwd: /srv/project }',
    '  # prod: { ssh: prod-alias, cwd: /srv/project, readonly: true }',
    ''
  );
  return L.join('\n');
}

export const README_TEMPLATE = `# .mcproc notes

Free-form notes about running this project: what the apps are, how they fit together,
which services are external (databases, queues), what to check after a start.
mcproc returns this file from describe (called without an app).
`;

/** Whether a manifest's text marks the local host readonly — read from the YAML itself, so a manifest that does not validate still counts. */
function localReadonly(text: string): boolean {
  try {
    const raw = parseYaml(text) as {
      hosts?: { local?: { readonly?: unknown } };
    } | null;
    return raw?.hosts?.local?.readonly === true;
  } catch {
    return false;
  }
}

export function initProject(
  rootIn: string,
  opts: { force?: boolean } = {}
): InitResult {
  const root = path.resolve(rootIn);
  if (!fs.existsSync(root))
    throw new McprocError(
      'MANIFEST_NOT_FOUND',
      `Project directory does not exist: ${root}`
    );
  const dir = path.join(root, '.mcproc');
  const file = path.join(root, MANIFEST_REL);
  if (fs.existsSync(file) && !opts.force) {
    throw new McprocError('ALREADY_EXISTS', `${file} already exists`, {
      hint: 'Pass force: true to overwrite the manifest draft (README and .gitignore are kept).',
    });
  }
  if (fs.existsSync(file) && localReadonly(fs.readFileSync(file, 'utf8'))) {
    throw new McprocError(
      'READONLY_HOST',
      `${file} declares the local host readonly; init does not replace it, not even with force`,
      {
        hint: 'Edit the manifest by hand, or remove hosts.local.readonly first if replacing it is really meant.',
      }
    );
  }
  fs.mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi) || fs.readFileSync(gi, 'utf8').trim() !== '*') {
    fs.writeFileSync(gi, '*\n');
    created.push(gi);
  }
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, README_TEMPLATE);
    created.push(readme);
  }
  const d = discover(root);
  fs.writeFileSync(file, renderDraft(root, defaultProject(root), d));
  created.push(file);
  const by_source: Record<string, number> = {};
  for (const c of d.candidates) {
    const k = c.source.split(':')[0].replace(/^.*\//, '');
    by_source[k] = (by_source[k] ?? 0) + 1;
  }
  return {
    path: file,
    created,
    candidates: d.candidates.length,
    by_source,
    next: `Edit ${file}: uncomment the apps your dev stack needs, write a description for each, then run start <app|profile> and ls to confirm the ports.`,
  };
}

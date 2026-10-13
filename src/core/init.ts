import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { McprocError } from './errors.js';
import { defaultProject, MANIFEST_REL, type AppKind } from './manifest.js';

export interface Candidate {
  name: string;
  source: string;
  run: string;
  cwd: string;
  kind: AppKind | 'unknown';
  port?: number;
}
export interface Discovery {
  candidates: Candidate[];
  notes: string[];
}
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

// biome-ignore lint/suspicious/noExplicitAny: package.json, turbo.json and the like are untyped data, probed field by field
function readJson(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
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

export function guessPort(cmd: string, dir: string): number | undefined {
  const m = /(?:\bPORT=|--port[= ]|\s-p\s)(\d{2,5})\b/.exec(cmd);
  if (m) return Number(m[1]);
  for (const f of ['.env', '.env.local', '.env.development']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const e = /^\s*PORT=["']?(\d{2,5})/m.exec(fs.readFileSync(p, 'utf8'));
    if (e) return Number(e[1]);
  }
  const src = path.join(dir, 'src');
  if (fs.existsSync(src)) {
    for (const f of walk(src, 3)
      .filter((x) => /\.(ts|js|mjs|cjs|tsx|jsx)$/.test(x))
      .slice(0, 200)) {
      const l = /\.listen\(\s*(\d{2,5})\b/.exec(fs.readFileSync(f, 'utf8'));
      if (l) return Number(l[1]);
    }
  }
  return undefined;
}

function packageCandidates(
  root: string,
  pkgDir: string,
  pm: string
): Candidate[] {
  const pkg = readJson(path.join(pkgDir, 'package.json'));
  if (!pkg?.scripts) return [];
  const rel = path.relative(root, pkgDir) || '.';
  const prefix =
    rel === '.'
      ? ''
      : `${sanitizeName(
          String(pkg.name ?? path.basename(pkgDir))
            .split('/')
            .pop()!
        )}-`;
  const out: Candidate[] = [];
  for (const [n, cmd] of Object.entries(
    pkg.scripts as Record<string, string>
  )) {
    if (!SCRIPT_RE.test(n)) continue;
    const kind = guessKind(n, cmd);
    out.push({
      name: sanitizeName(prefix + n),
      source: `${rel === '.' ? '' : `${rel}/`}package.json:${n}`,
      run: `${pm} ${n}`,
      cwd: rel,
      kind,
      port:
        kind === 'build' || kind === 'task'
          ? undefined
          : guessPort(cmd, pkgDir),
    });
  }
  return out;
}

/** Supports "dir/*", "dir/**" and exact-directory workspace patterns; anything else is reported, not guessed. */
function expandWorkspaces(
  root: string,
  patterns: string[]
): { dirs: string[]; unsupported: string[] } {
  const dirs = new Set<string>();
  const unsupported: string[] = [];
  for (const pat of patterns) {
    const glob = /^(.*?)\/\*\*?$/.exec(pat);
    if (glob) {
      const base = path.join(root, glob[1]);
      let names: string[] = [];
      try {
        names = fs.readdirSync(base);
      } catch {
        /* no such dir */
      }
      for (const d of names)
        if (fs.existsSync(path.join(base, d, 'package.json')))
          dirs.add(path.join(base, d));
    } else if (pat.includes('*')) {
      unsupported.push(pat);
    } else if (fs.existsSync(path.join(root, pat, 'package.json'))) {
      dirs.add(path.join(root, pat));
    }
  }
  return { dirs: [...dirs], unsupported };
}

export function discover(root: string): Discovery {
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  const pm = pmFor(root);
  candidates.push(...packageCandidates(root, root, pm));

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
  for (const dir of expanded.dirs)
    candidates.push(...packageCandidates(root, dir, pm));
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

  const turbo = readJson(path.join(root, 'turbo.json'));
  const tasks = turbo?.tasks ?? turbo?.pipeline;
  if (tasks && typeof tasks === 'object') {
    for (const t of Object.keys(tasks)) {
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
      if (m)
        candidates.push({
          name: sanitizeName(m[1]),
          source: `Procfile:${m[1]}`,
          run: m[2].trim(),
          cwd: '.',
          kind: guessKind(m[1], m[2]),
          port: guessPort(m[2], root),
        });
    }
  }

  const seen = new Map<string, number>();
  for (const c of candidates) {
    const n = seen.get(c.name) ?? 0;
    seen.set(c.name, n + 1);
    if (n) c.name = `${c.name}-${n + 1}`;
  }
  return { candidates, notes };
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

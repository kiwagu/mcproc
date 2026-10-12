import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { McprocError } from './errors.js';
import { repeatsARepeat } from './incidents/detect.js';

export const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const MANIFEST_REL = path.join('.mcproc', 'mcproc.yaml');
export const PROTECTED_PM2_KEYS = ['name', 'namespace', 'cwd', 'script', 'args', 'interpreter'] as const;
export const DEFAULT_SHELL = '/bin/bash -lc';

const name = z.string().regex(NAME_RE, 'must match ^[a-z0-9][a-z0-9._-]*$');
const envValue = z.union([z.string(), z.number(), z.boolean()]);
const portNo = z.number().int().min(1).max(65535);

const errorsSchema = z.union([z.literal(false), z.object({
  match: z.array(z.string().min(1)).default([]),
  ignore: z.array(z.string().min(1)).default([]),
  context: z.tuple([z.number().int().min(0).max(50), z.number().int().min(0).max(50)]).default([3, 5]),
  stderr: z.boolean().default(false),
  defaults: z.boolean().default(true),
}).strict()]);

const appSchema = z.object({
  description: z.string().min(1),
  kind: z.enum(['build', 'server', 'worker']).default('server'),
  run: z.string().min(1),
  cwd: z.string().min(1).default('.'),
  env: z.record(envValue).default({}),
  port: portNo.optional(),
  ports: z.array(portNo).optional(),
  url: z.string().regex(/^https?:\/\/\S+$/, 'url must start with http:// or https:// (it is opened in a browser and checked with one HTTP request)').optional(),
  watch: z.union([z.boolean(), z.array(z.string())]).optional(),
  watch_delay: z.number().int().min(0).optional(),
  ignore_watch: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).default([]),
  autorestart: z.boolean().default(true),
  pm2: z.record(z.unknown()).default({}),
  host: name.optional(),
  errors: errorsSchema.optional(),
}).strict();

const hostSchema = z.object({
  ssh: z.string().min(1).optional(),
  ssh_args: z.array(z.string()).default([]),
  docker: z.object({ container: z.string().min(1), user: z.string().min(1).optional() }).strict().optional(),
  cwd: z.string().min(1).optional(),
  readonly: z.boolean().default(false),
  shell: z.string().min(1).default(DEFAULT_SHELL),
  pm2: z.string().min(1).optional(),
  pm2_home: z.string().min(1).optional(),
  runtime: z.string().min(1).optional(),
  env: z.record(envValue).default({}),
}).strict();

/** A key left empty in YAML (`apps:` with only comments below it) parses as null: treat it as an empty map. */
const orEmpty = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === null || v === undefined ? {} : v), schema);

export const manifestSchema = z.object({
  version: z.literal(1),
  project: name.optional(),
  apps: orEmpty(z.record(name, appSchema)),
  profiles: orEmpty(z.record(name, z.array(z.string()))),
  hosts: orEmpty(z.record(name, hostSchema)),
}).strict();

export type AppKind = 'build' | 'server' | 'worker';
/** What counts as an error in an app's logs (the `incidents` tool); null when the app turned detection off. */
export interface ErrorSettings { match: string[]; ignore: string[]; context: [number, number]; stderr: boolean; defaults: boolean }
export interface App {
  name: string; description: string; kind: AppKind; run: string; cwd: string;
  env: Record<string, string>; ports: number[]; url: string | null;
  watch?: boolean | string[]; watch_delay?: number; ignore_watch?: string[];
  depends_on: string[]; autorestart: boolean; pm2: Record<string, unknown>;
  /** the host this app always runs on; null = wherever the command points (--host, default local) */
  host: string | null;
  errors: ErrorSettings | null;
}
export interface Host {
  name: string; local: boolean; ssh?: string; ssh_args: string[];
  docker?: { container: string; user?: string };
  cwd: string; readonly: boolean; shell: { bin: string; flags: string[] };
  pm2?: string; pm2_home?: string; runtime?: string; env: Record<string, string>;
}
export interface Manifest {
  root: string; path: string; project: string;
  apps: Record<string, App>; profiles: Record<string, string[]>; hosts: Record<string, Host>;
}

export function findManifestPath(startDir: string): { root: string; path: string } | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const p = path.join(dir, MANIFEST_REL);
    if (fs.existsSync(p)) return { root: dir, path: p };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function defaultProject(root: string): string {
  const s = path.basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '');
  return s || 'project';
}

function stringifyEnv(env: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));
}

export function parseShell(s: string): { bin: string; flags: string[] } {
  const parts = s.trim().split(/\s+/);
  return { bin: parts[0], flags: parts.slice(1) };
}

function findCycle(apps: Record<string, App>): string[] | null {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    const st = state.get(n) ?? 0;
    if (st === 1) return [...stack.slice(stack.indexOf(n)), n];
    if (st === 2) return null;
    state.set(n, 1); stack.push(n);
    for (const d of apps[n]?.depends_on ?? []) { const c = visit(d); if (c) return c; }
    stack.pop(); state.set(n, 2);
    return null;
  };
  for (const n of Object.keys(apps)) { const c = visit(n); if (c) return c; }
  return null;
}

export function parseManifest(text: string, root: string, manifestPath: string): Manifest {
  let raw: unknown;
  try { raw = parseYaml(text); } catch (e) {
    throw new McprocError('MANIFEST_INVALID', `YAML parse error in ${manifestPath}: ${(e as Error).message}`);
  }
  const res = manifestSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new McprocError('MANIFEST_INVALID', `Invalid manifest ${manifestPath}:\n  ${issues.join('\n  ')}`, { details: issues });
  }
  const m = res.data;
  const problems: string[] = [];
  if (Object.keys(m.apps).length === 0) problems.push('apps: at least one app is required');

  const apps: Record<string, App> = {};
  for (const [n, a] of Object.entries(m.apps)) {
    if (a.port !== undefined && a.ports !== undefined) problems.push(`apps.${n}: use either port or ports, not both`);
    for (const d of a.depends_on) if (!m.apps[d]) problems.push(`apps.${n}.depends_on: unknown app "${d}"`);
    for (const k of PROTECTED_PM2_KEYS) if (k in a.pm2) problems.push(`apps.${n}.pm2.${k}: managed by mcproc, cannot be overridden`);
    const errors: ErrorSettings | null = a.errors === false ? null : {
      match: a.errors?.match ?? [], ignore: a.errors?.ignore ?? [], context: a.errors?.context ?? [3, 5],
      stderr: a.errors?.stderr ?? false, defaults: a.errors?.defaults ?? true,
    };
    for (const k of ['match', 'ignore'] as const) {
      for (const p of errors?.[k] ?? []) {
        try { new RegExp(p); } catch (e) { problems.push(`apps.${n}.errors.${k}: invalid pattern "${p}": ${(e as Error).message}`); continue; }
        if (repeatsARepeat(p)) problems.push(`apps.${n}.errors.${k}: pattern "${p}" repeats a group that ends in a repeat (like (a+)+), which can run for minutes on a log line that almost matches; rewrite it without the nested repeat`);
      }
    }
    apps[n] = {
      name: n, description: a.description, kind: a.kind, run: a.run, cwd: a.cwd,
      env: stringifyEnv(a.env), ports: a.ports ?? (a.port !== undefined ? [a.port] : []), url: a.url ?? null,
      watch: a.watch, watch_delay: a.watch_delay ?? (a.watch ? 1000 : undefined), ignore_watch: a.ignore_watch,
      depends_on: a.depends_on, autorestart: a.autorestart, pm2: a.pm2, host: a.host ?? null, errors,
    };
  }
  const cycle = findCycle(apps);
  if (cycle) problems.push(`apps: depends_on cycle: ${cycle.join(' -> ')}`);

  if ('all' in m.profiles) problems.push('profiles.all: reserved, the built-in profile of every app');
  for (const [p, list] of Object.entries(m.profiles)) for (const a of list) if (!m.apps[a]) problems.push(`profiles.${p}: unknown app "${a}"`);

  const hosts: Record<string, Host> = {};
  for (const [h, hv] of Object.entries(m.hosts)) {
    const local = h === 'local';
    if (local && (hv.ssh || hv.docker || hv.cwd)) problems.push('hosts.local: ssh, docker and cwd are not allowed on the local host');
    if (!local && !hv.ssh && !hv.docker) problems.push(`hosts.${h}: needs ssh or docker (or both)`);
    if (!local && !hv.cwd) problems.push(`hosts.${h}: cwd (the project root on that host) is required`);
    if (hv.ssh?.startsWith('-')) problems.push(`hosts.${h}.ssh: must not start with "-"`);
    for (const a of hv.ssh_args) if (/[\n\r]/.test(a)) problems.push(`hosts.${h}.ssh_args: newlines are not allowed`);
    for (const k of ['cwd', 'runtime', 'pm2_home'] as const) {
      const v = hv[k];
      if (v !== undefined && !v.startsWith('/')) problems.push(`hosts.${h}.${k}: must be an absolute path on that host ("~" and relative paths are not expanded)`);
    }
    hosts[h] = {
      name: h, local, ssh: hv.ssh, ssh_args: hv.ssh_args, docker: hv.docker,
      cwd: local ? root : (hv.cwd ?? root), readonly: hv.readonly, shell: parseShell(hv.shell),
      pm2: hv.pm2, pm2_home: hv.pm2_home, runtime: hv.runtime, env: stringifyEnv(hv.env),
    };
  }
  if (!hosts.local) hosts.local = { name: 'local', local: true, ssh_args: [], cwd: root, readonly: false, shell: parseShell(DEFAULT_SHELL), env: {} };
  for (const a of Object.values(apps)) {
    if (a.host !== null && !hosts[a.host]) problems.push(`apps.${a.name}.host: unknown host "${a.host}" (declared: ${Object.keys(hosts).join(', ')})`);
  }

  if (problems.length) throw new McprocError('MANIFEST_INVALID', `Invalid manifest ${manifestPath}:\n  ${problems.join('\n  ')}`, { details: problems });
  return { root, path: manifestPath, project: m.project ?? defaultProject(root), apps, profiles: m.profiles, hosts };
}

/**
 * The part of the manifest that runs on one host: apps bound to it, plus the unbound apps when it is the fallback host
 * (the host the command names, local when it names none). Dependencies and profile members that run elsewhere are
 * dropped, so everything that works on one manifest (ecosystem, ports, targets) works on this view unchanged.
 */
export function scopeManifest(m: Manifest, host: string, fallback: string): Manifest {
  const apps = Object.fromEntries(Object.values(m.apps)
    .filter((a) => (a.host ?? fallback) === host)
    .map((a) => [a.name, a]));
  for (const [n, a] of Object.entries(apps)) {
    const deps = a.depends_on.filter((d) => d in apps);
    if (deps.length !== a.depends_on.length) apps[n] = { ...a, depends_on: deps };
  }
  const profiles = Object.fromEntries(Object.entries(m.profiles).map(([p, list]) => [p, list.filter((a) => a in apps)]));
  return { ...m, apps, profiles };
}

export function loadManifest(startDir: string): Manifest {
  const found = findManifestPath(startDir);
  if (!found) {
    throw new McprocError('MANIFEST_NOT_FOUND', `No ${MANIFEST_REL} found in ${path.resolve(startDir)} or its parents`, {
      hint: 'Run init (MCP tool or `mcproc init`) to create a draft from the project\'s scripts, fill in a description per app, then verify with ls.',
    });
  }
  return parseManifest(fs.readFileSync(found.path, 'utf8'), found.root, found.path);
}

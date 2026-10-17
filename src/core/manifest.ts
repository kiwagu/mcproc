import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { McprocError } from './errors.js';
import { repeatsARepeat } from './incidents/detect.js';
import { NAME_RE } from './names.js';
import { loadOverride, type Override } from './override.js';
import { parsePercent, parseSizeMib } from './sizes.js';
import {
  renderTemplate,
  resolveVars,
  TemplateError,
  type VarValue,
} from './template.js';

export { NAME_RE };
export const MANIFEST_REL = path.join('.mcproc', 'mcproc.yaml');
export const PROTECTED_PM2_KEYS = [
  'name',
  'namespace',
  'cwd',
  'script',
  'args',
  'interpreter',
  'time',
  'log_date_format',
] as const;
export const DEFAULT_SHELL = '/bin/bash -lc';

const name = z.string().regex(NAME_RE, 'must match ^[a-z0-9][a-z0-9._-]*$');
const envValue = z.union([z.string(), z.number(), z.boolean()]);
const portNo = z.number().int().min(1).max(65535);
const VAR_NAME_RE = /^[a-z][a-z0-9_]*$/;
const varName = z.string().regex(VAR_NAME_RE, 'must match ^[a-z][a-z0-9_]*$');
const varValue = z.union([z.string(), z.number(), z.boolean()]);
const sizeString = z.string().min(1);

export type AppKind = 'build' | 'server' | 'worker' | 'task';
export type DepCondition = 'started' | 'ready' | 'completed';
/** One dependency: which app, what state of it the dependent waits for, and how long. */
export interface Dep {
  app: string;
  condition: DepCondition;
  timeoutMs: number;
}
export const DEP_TIMEOUT_DEFAULT_S = 60;
export const DEP_TIMEOUT_MAX_S = 600;

/** A bare name means `started`; the object form names the condition and how long to wait for it. */
const depSchema = z.union([
  z.string().min(1),
  z
    .object({
      app: z.string().min(1),
      condition: z.enum(['started', 'ready', 'completed']).default('started'),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(DEP_TIMEOUT_MAX_S)
        .default(DEP_TIMEOUT_DEFAULT_S),
    })
    .strict(),
]);

const errorsSchema = z.union([
  z.literal(false),
  z
    .object({
      match: z.array(z.string().min(1)).default([]),
      ignore: z.array(z.string().min(1)).default([]),
      context: z
        .tuple([
          z.number().int().min(0).max(50),
          z.number().int().min(0).max(50),
        ])
        .default([3, 5]),
      stderr: z.boolean().default(false),
      defaults: z.boolean().default(true),
    })
    .strict(),
]);

const reloadsSchema = z.union([
  z.literal(false),
  z
    .object({
      match: z.array(z.string().min(1)).default([]),
      ignore: z.array(z.string().min(1)).default([]),
      defaults: z.boolean().default(true),
    })
    .strict(),
]);

const appSchema = z
  .object({
    description: z.string().min(1),
    kind: z.enum(['build', 'server', 'worker', 'task']).default('server'),
    run: z.string().min(1),
    cwd: z.string().min(1).default('.'),
    env: z.record(envValue).default({}),
    memory: sizeString.optional(),
    containers: z.array(z.string().min(1)).default([]),
    port: portNo.optional(),
    ports: z.array(portNo).optional(),
    url: z
      .string()
      .regex(
        /^https?:\/\/\S+$/,
        'url must start with http:// or https:// (it is opened in a browser and checked with one HTTP request)'
      )
      .optional(),
    url_check: z.enum(['auto', 'host', 'here']).optional(),
    watch: z.union([z.boolean(), z.array(z.string())]).optional(),
    watch_delay: z.number().int().min(0).optional(),
    ignore_watch: z.array(z.string()).optional(),
    depends_on: z.array(depSchema).default([]),
    autorestart: z.boolean().optional(),
    pm2: z.record(z.unknown()).default({}),
    host: name.optional(),
    errors: errorsSchema.optional(),
    reloads: reloadsSchema.optional(),
  })
  .strict();

const hostSchema = z
  .object({
    ssh: z.string().min(1).optional(),
    ssh_args: z.array(z.string()).default([]),
    docker: z
      .object({
        container: z.string().min(1),
        user: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    cwd: z.string().min(1).optional(),
    readonly: z.boolean().default(false),
    shell: z.string().min(1).default(DEFAULT_SHELL),
    pm2: z.string().min(1).optional(),
    pm2_home: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    env: z.record(envValue).default({}),
  })
  .strict();

const resourcesSchema = z
  .object({
    reserve: z.string().min(1).optional(),
    margin: z.string().min(1).optional(),
    settle: z.number().int().min(0).max(600).optional(),
  })
  .strict();
const worktreeSchema = z
  .object({
    dir: z.string().min(1).nullable().optional(),
    copy: z.array(z.string().min(1)).default([]),
    link: z.array(z.string().min(1)).default([]),
    install: z
      .union([z.string().min(1), z.literal(false)])
      .nullable()
      .optional(),
    slots: z.number().int().min(1).max(99).default(9),
  })
  .strict();
const execSchema = z.object({ env: z.record(varValue).default({}) }).strict();

/** A key left empty in YAML (`apps:` with only comments below it) parses as null: treat it as an empty map. */
const orEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null || v === undefined ? {} : v), schema);

export const manifestSchema = z
  .object({
    version: z.literal(1),
    project: name.optional(),
    vars: orEmpty(z.record(varName, varValue)),
    resources: orEmpty(resourcesSchema),
    worktree: orEmpty(worktreeSchema),
    exec: orEmpty(execSchema),
    apps: orEmpty(z.record(name, appSchema)),
    profiles: orEmpty(z.record(name, z.array(z.string()))),
    hosts: orEmpty(z.record(name, hostSchema)),
  })
  .strict();

/** What counts as an error in an app's logs (the `incidents` tool); null when the app turned detection off. */
export interface ErrorSettings {
  match: string[];
  ignore: string[];
  context: [number, number];
  stderr: boolean;
  defaults: boolean;
}
/** What counts as an in-process reload in an app's logs (a watcher's restart or rebuild that pm2 does not see). */
export interface ReloadSettings {
  match: string[];
  ignore: string[];
  defaults: boolean;
}
/** Where an app's url is requested from: its host, then this machine when the host gets no answer (auto); only one side otherwise. */
export type UrlCheckMode = 'auto' | 'host' | 'here';
/** One resolved var and where its value came from, as describe shows it. */
export interface VarInfo {
  name: string;
  value: VarValue;
  source: 'built-in' | 'manifest' | 'override';
}
/** What a stand must leave to the rest of the host, the safety margin on an estimate, and the watcher's settle time. */
export interface Resources {
  reserve: { kind: 'mib'; mib: number } | { kind: 'percent'; ratio: number };
  margin: number;
  settle: number;
}
/** What a worktree of this repository gets beyond the git tree. */
export interface WorktreeSettings {
  /** where worktrees go; null = `<main checkout>.worktrees` next to the repository */
  dir: string | null;
  copy: string[];
  link: string[];
  /** the install command; null = detected from the lockfile; false = none */
  install: string | false | null;
  slots: number;
}
export interface ExecSettings {
  env: Record<string, string>;
}
export const RESERVE_DEFAULT_MIB = 2048;
export const MARGIN_DEFAULT = 0.1;
export const SETTLE_DEFAULT_S = 20;

export interface App {
  name: string;
  description: string;
  kind: AppKind;
  run: string;
  cwd: string;
  env: Record<string, string>;
  /** the memory the app is expected to use, in MiB; null when undeclared */
  memory_mib: number | null;
  /** docker containers the app owns, removed with it */
  containers: string[];
  ports: number[];
  url: string | null;
  /** where the url is requested from: auto (its host, then this machine when the host gets no answer), host, or here */
  url_check: UrlCheckMode;
  watch?: boolean | string[];
  watch_delay?: number;
  ignore_watch?: string[];
  depends_on: Dep[];
  autorestart: boolean;
  pm2: Record<string, unknown>;
  /** the host this app always runs on; null = wherever the command points (--host, default local) */
  host: string | null;
  errors: ErrorSettings | null;
  /** null when the app turned reload detection off */
  reloads: ReloadSettings | null;
}
export interface Host {
  name: string;
  local: boolean;
  ssh?: string;
  ssh_args: string[];
  docker?: { container: string; user?: string };
  cwd: string;
  readonly: boolean;
  shell: { bin: string; flags: string[] };
  pm2?: string;
  pm2_home?: string;
  runtime?: string;
  env: Record<string, string>;
}
export interface Manifest {
  root: string;
  path: string;
  project: string;
  /** the manifest's own slug (declared or from the directory name), before any override: the registry of worktree slots is keyed by it */
  base_project: string;
  vars: VarInfo[];
  /** the override file that set project or vars; null when the checkout has none */
  override: string | null;
  /** the main checkout of this repository: the override's `repo` for a worktree, else this root */
  repo: string;
  /** the value of a numeric `slot` var; null when the manifest declares none */
  slot: number | null;
  resources: Resources;
  worktree: WorktreeSettings;
  exec: ExecSettings;
  apps: Record<string, App>;
  profiles: Record<string, string[]>;
  hosts: Record<string, Host>;
}

export function findManifestPath(
  startDir: string
): { root: string; path: string } | null {
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
  const s = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  return s || 'project';
}

function stringifyEnv(
  env: Record<string, string | number | boolean>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, String(v)])
  );
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
    state.set(n, 1);
    stack.push(n);
    for (const d of apps[n]?.depends_on ?? []) {
      const c = visit(d.app);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of Object.keys(apps)) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/**
 * A union entry that fails gives zod one `invalid_union` issue on the entry whose real reasons sit in its branches:
 * flatten them so the message names the field (`apps.w.depends_on.0.timeout`), not just the entry.
 */
function flattenIssues(issues: z.ZodIssue[]): z.ZodIssue[] {
  return issues.flatMap((i) =>
    i.code === 'invalid_union'
      ? flattenIssues(i.unionErrors.flatMap((e) => e.issues))
      : [i]
  );
}

/** A name the manifest itself declares (never one every JavaScript object has, like `constructor`). */
const own = (o: object, k: string): boolean => Object.hasOwn(o, k);

/**
 * An app's own log patterns (`errors` and `reloads` lists): each must compile, and none may repeat a group that ends in
 * a repeat, which backtracks for minutes on a line that almost matches. `field` names the list in the message.
 */
function checkPatterns(
  problems: string[],
  field: string,
  patterns: string[]
): void {
  for (const p of patterns) {
    try {
      new RegExp(p);
    } catch (e) {
      problems.push(
        `${field}: invalid pattern "${p}": ${(e as Error).message}`
      );
      continue;
    }
    if (repeatsARepeat(p))
      problems.push(
        `${field}: pattern "${p}" repeats a group that ends in a repeat (like (a+)+), which can run for minutes on a log line that almost matches; rewrite it without the nested repeat`
      );
  }
}

/** The error a template raised, as the manifest reports it: the field path first, the code by the kind of failure. */
function templateError(field: string, e: unknown): McprocError {
  const t = e instanceof TemplateError ? e : null;
  const code =
    t?.kind === 'unknown'
      ? 'UNKNOWN_VAR'
      : t?.kind === 'cycle'
        ? 'VAR_CYCLE'
        : 'BAD_TEMPLATE';
  // a failure inside one var's template is reported under that var: vars.<name>
  const where = t?.varName ? `${field}.${t.varName}` : field;
  const msg = t?.varName
    ? t.message.slice(t.varName.length + 2)
    : (e as Error).message;
  return new McprocError(code, `${where}: ${msg}`, {
    hint:
      code === 'UNKNOWN_VAR'
        ? 'Declare the var under vars: in the manifest; the override may only set declared vars.'
        : code === 'VAR_CYCLE'
          ? 'Break the cycle between the named vars: one of them must not depend on the others.'
          : "Templates are {{ expr }} over var names with integer + - * / % and parentheses; write \\{{ for a literal {{ (a docker --format '{{.Names}}' in a run line needs it).",
  });
}

/** Keys whose string values are never templates: structure, not configuration. */
const NO_TEMPLATE_KEYS = new Set(['version', 'project', 'profiles', 'vars']);

/**
 * Every string leaf of the raw manifest rendered with the resolved vars, except the structural keys; `port`/`ports`
 * that rendered to digits become numbers so the schema can check them. Errors name the field path.
 */
function interpolateRaw(raw: unknown, vars: Record<string, VarValue>): unknown {
  const walk = (v: unknown, p: string[]): unknown => {
    if (typeof v === 'string') {
      try {
        const r = renderTemplate(v, vars);
        const portLike =
          p[0] === 'apps' &&
          ((p.length === 3 && p[2] === 'port') ||
            (p.length === 4 && p[2] === 'ports'));
        if (portLike) {
          // a port: a number as rendered, or a string of digits; anything else cannot be a port
          if (typeof r === 'number') return r;
          if (typeof r === 'string' && /^\d+$/.test(r)) return Number(r);
          throw new TemplateError(
            `must render to an integer, got ${JSON.stringify(r)}`,
            'type'
          );
        }
        // every other field is a string in the schema: a whole-template number or boolean is written out
        return typeof r === 'string' ? r : String(r);
      } catch (e) {
        throw templateError(p.join('.') || '(root)', e);
      }
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...p, String(i)]));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        out[k] =
          p.length === 0 && NO_TEMPLATE_KEYS.has(k) ? x : walk(x, [...p, k]);
      return out;
    }
    return v;
  };
  return walk(raw, []);
}

/** Parses manifest text: renders its `{{ }}` templates with the vars (the override's values win), then checks the result against the schema. */
export function parseManifest(
  text: string,
  root: string,
  manifestPath: string,
  override: Override | null = null
): Manifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new McprocError(
      'MANIFEST_INVALID',
      `YAML parse error in ${manifestPath}: ${(e as Error).message}`
    );
  }
  // project and vars come first: everything else is rendered with them
  const top = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  if (typeof top.project === 'string' && /\{\{/.test(top.project))
    throw new McprocError('BAD_TEMPLATE', 'project: must not be a template', {
      hint: 'Set the project slug in the override file instead.',
    });
  const base_project =
    typeof top.project === 'string' ? top.project : defaultProject(root);
  const project = override?.project ?? base_project;
  const declaredRes = z.record(varName, varValue).safeParse(top.vars ?? {});
  if (!declaredRes.success)
    throw new McprocError(
      'MANIFEST_INVALID',
      `Invalid manifest ${manifestPath}:\n  vars: ${declaredRes.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`
    );
  let resolved: Record<string, VarValue>;
  try {
    resolved = resolveVars(
      declaredRes.data,
      override?.vars ?? {},
      {
        project,
        root,
      },
      override?.path
    );
  } catch (e) {
    throw templateError('vars', e);
  }
  const vars: VarInfo[] = Object.entries(resolved).map(([name, value]) => ({
    name,
    value,
    source:
      name === 'project' || name === 'root'
        ? 'built-in'
        : override && Object.hasOwn(override.vars, name)
          ? 'override'
          : 'manifest',
  }));
  const res = manifestSchema.safeParse(interpolateRaw(raw, resolved));
  if (!res.success) {
    const issues = flattenIssues(res.error.issues).map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`
    );
    throw new McprocError(
      'MANIFEST_INVALID',
      `Invalid manifest ${manifestPath}:\n  ${issues.join('\n  ')}`,
      { details: issues }
    );
  }
  const m = res.data;
  const problems: string[] = [];
  if (Object.keys(m.apps).length === 0)
    problems.push('apps: at least one app is required');

  const apps: Record<string, App> = {};
  for (const [n, a] of Object.entries(m.apps)) {
    if (a.port !== undefined && a.ports !== undefined)
      problems.push(`apps.${n}: use either port or ports, not both`);
    const deps: Dep[] = a.depends_on.map((d) =>
      typeof d === 'string'
        ? {
            app: d,
            condition: 'started',
            timeoutMs: DEP_TIMEOUT_DEFAULT_S * 1000,
          }
        : { app: d.app, condition: d.condition, timeoutMs: d.timeout * 1000 }
    );
    for (const d of deps) {
      if (!own(m.apps, d.app)) {
        problems.push(`apps.${n}.depends_on: unknown app "${d.app}"`);
        continue;
      }
      const dep = m.apps[d.app];
      if (d.condition === 'completed' && dep.kind !== 'task')
        problems.push(
          `apps.${n}.depends_on: "${d.app}" must be kind: task for condition completed (it is ${dep.kind})`
        );
      if (
        d.condition === 'ready' &&
        dep.port === undefined &&
        (dep.ports ?? []).length === 0 &&
        dep.url === undefined
      )
        problems.push(
          `apps.${n}.depends_on: "${d.app}" declares no port or url, so ready cannot be observed`
        );
    }
    if (a.url_check !== undefined && a.url === undefined)
      problems.push(
        `apps.${n}.url_check: there is no url to check; declare url or drop url_check`
      );
    if (a.kind === 'task' && a.autorestart === true)
      problems.push(
        `apps.${n}.autorestart: a task runs once; drop autorestart or use kind: worker`
      );
    // stop, delete, logs and ports act on one pm2 process per app: settings that start several would leave the rest running
    const instances = (a.pm2 as Record<string, unknown>).instances;
    if (instances !== undefined && instances !== 1)
      problems.push(
        `apps.${n}.pm2.instances: mcproc runs one process per app (stop and delete act on one); remove it or set 1`
      );
    const mode = (a.pm2 as Record<string, unknown>).exec_mode;
    if (mode !== undefined && mode !== 'fork' && mode !== 'fork_mode')
      problems.push(
        `apps.${n}.pm2.exec_mode: only fork mode (one process per app); cluster mode is not supported`
      );
    for (const k of PROTECTED_PM2_KEYS)
      if (k in a.pm2)
        problems.push(
          `apps.${n}.pm2.${k}: managed by mcproc, cannot be overridden`
        );
    const errors: ErrorSettings | null =
      a.errors === false
        ? null
        : {
            match: a.errors?.match ?? [],
            ignore: a.errors?.ignore ?? [],
            context: a.errors?.context ?? [3, 5],
            stderr: a.errors?.stderr ?? false,
            defaults: a.errors?.defaults ?? true,
          };
    const reloads: ReloadSettings | null =
      a.reloads === false
        ? null
        : {
            match: a.reloads?.match ?? [],
            ignore: a.reloads?.ignore ?? [],
            defaults: a.reloads?.defaults ?? true,
          };
    for (const [field, s] of [
      ['errors', errors],
      ['reloads', reloads],
    ] as const)
      for (const k of ['match', 'ignore'] as const)
        checkPatterns(problems, `apps.${n}.${field}.${k}`, s?.[k] ?? []);
    let memory_mib: number | null = null;
    if (a.memory !== undefined)
      try {
        memory_mib = parseSizeMib(a.memory);
      } catch (e) {
        problems.push(`apps.${n}.memory: ${(e as Error).message}`);
      }
    apps[n] = {
      name: n,
      description: a.description,
      kind: a.kind,
      run: a.run,
      cwd: a.cwd,
      env: stringifyEnv(a.env),
      memory_mib,
      containers: a.containers,
      ports: a.ports ?? (a.port !== undefined ? [a.port] : []),
      url: a.url ?? null,
      url_check: a.url_check ?? 'auto',
      watch: a.watch,
      watch_delay: a.watch_delay ?? (a.watch ? 1000 : undefined),
      ignore_watch: a.ignore_watch,
      depends_on: deps,
      autorestart: a.autorestart ?? a.kind !== 'task',
      pm2: a.pm2,
      host: a.host ?? null,
      errors,
      reloads,
    };
  }
  const cycle = findCycle(apps);
  if (cycle) problems.push(`apps: depends_on cycle: ${cycle.join(' -> ')}`);

  if (own(m.apps, 'all'))
    problems.push('apps.all: reserved, the built-in profile of every app');
  if (own(m.profiles, 'all'))
    problems.push('profiles.all: reserved, the built-in profile of every app');
  for (const p of Object.keys(m.profiles))
    if (own(m.apps, p))
      problems.push(
        `profiles.${p}: an app has this name, so a target "${p}" would mean both; rename one`
      );
  for (const [p, list] of Object.entries(m.profiles))
    for (const a of list)
      if (!own(m.apps, a)) problems.push(`profiles.${p}: unknown app "${a}"`);

  const hosts: Record<string, Host> = {};
  for (const [h, hv] of Object.entries(m.hosts)) {
    const local = h === 'local';
    if (local && (hv.ssh || hv.docker || hv.cwd))
      problems.push(
        'hosts.local: ssh, docker and cwd are not allowed on the local host'
      );
    if (!local && !hv.ssh && !hv.docker)
      problems.push(`hosts.${h}: needs ssh or docker (or both)`);
    if (!local && !hv.cwd)
      problems.push(
        `hosts.${h}: cwd (the project root on that host) is required`
      );
    if (hv.ssh?.startsWith('-'))
      problems.push(`hosts.${h}.ssh: must not start with "-"`);
    for (const a of hv.ssh_args)
      if (/[\n\r]/.test(a))
        problems.push(`hosts.${h}.ssh_args: newlines are not allowed`);
    for (const k of ['cwd', 'runtime', 'pm2_home'] as const) {
      const v = hv[k];
      if (v !== undefined && !v.startsWith('/'))
        problems.push(
          `hosts.${h}.${k}: must be an absolute path on that host ("~" and relative paths are not expanded)`
        );
    }
    hosts[h] = {
      name: h,
      local,
      ssh: hv.ssh,
      ssh_args: hv.ssh_args,
      docker: hv.docker,
      cwd: local ? root : (hv.cwd ?? root),
      readonly: hv.readonly,
      shell: parseShell(hv.shell),
      pm2: hv.pm2,
      pm2_home: hv.pm2_home,
      runtime: hv.runtime,
      env: stringifyEnv(hv.env),
    };
  }
  if (!hosts.local)
    hosts.local = {
      name: 'local',
      local: true,
      ssh_args: [],
      cwd: root,
      readonly: false,
      shell: parseShell(DEFAULT_SHELL),
      env: {},
    };
  for (const a of Object.values(apps)) {
    if (a.host !== null && !own(hosts, a.host))
      problems.push(
        `apps.${a.name}.host: unknown host "${a.host}" (declared: ${Object.keys(hosts).join(', ')})`
      );
  }

  let reserve: Resources['reserve'] = {
    kind: 'mib',
    mib: RESERVE_DEFAULT_MIB,
  };
  let margin = MARGIN_DEFAULT;
  if (m.resources.reserve !== undefined)
    try {
      reserve = m.resources.reserve.trim().endsWith('%')
        ? { kind: 'percent', ratio: parsePercent(m.resources.reserve) }
        : { kind: 'mib', mib: parseSizeMib(m.resources.reserve) };
    } catch (e) {
      problems.push(`resources.reserve: ${(e as Error).message}`);
    }
  if (m.resources.margin !== undefined)
    try {
      margin = parsePercent(m.resources.margin);
    } catch (e) {
      problems.push(`resources.margin: ${(e as Error).message}`);
    }
  const resources: Resources = {
    reserve,
    margin,
    settle: m.resources.settle ?? SETTLE_DEFAULT_S,
  };
  const worktree: WorktreeSettings = {
    dir: m.worktree.dir ?? null,
    copy: m.worktree.copy,
    link: m.worktree.link,
    install: m.worktree.install ?? null,
    slots: m.worktree.slots,
  };
  const exec: ExecSettings = { env: stringifyEnv(m.exec.env) };
  const slotVar = resolved.slot;
  const slot = typeof slotVar === 'number' ? slotVar : null;

  if (problems.length)
    throw new McprocError(
      'MANIFEST_INVALID',
      `Invalid manifest ${manifestPath}:\n  ${problems.join('\n  ')}`,
      { details: problems }
    );
  return {
    root,
    path: manifestPath,
    project,
    base_project,
    vars,
    override: override?.path ?? null,
    repo: override?.repo ?? root,
    slot,
    apps,
    profiles: m.profiles,
    hosts,
    resources,
    worktree,
    exec,
  };
}

/**
 * The part of the manifest that runs on one host: apps bound to it, plus the unbound apps when it is the fallback host
 * (the host the command names, local when it names none). Dependencies and profile members that run elsewhere are
 * dropped, so everything that works on one manifest (ecosystem, ports, targets) works on this view unchanged.
 */
export function scopeManifest(
  m: Manifest,
  host: string,
  fallback: string
): Manifest {
  const apps = Object.fromEntries(
    Object.values(m.apps)
      .filter((a) => (a.host ?? fallback) === host)
      .map((a) => [a.name, a])
  );
  for (const [n, a] of Object.entries(apps)) {
    const deps = a.depends_on.filter((d) => d.app in apps);
    if (deps.length !== a.depends_on.length)
      apps[n] = { ...a, depends_on: deps };
  }
  const profiles = Object.fromEntries(
    Object.entries(m.profiles).map(([p, list]) => [
      p,
      list.filter((a) => a in apps),
    ])
  );
  return { ...m, apps, profiles };
}

export function loadManifest(startDir: string): Manifest {
  const found = findManifestPath(startDir);
  if (!found) {
    throw new McprocError(
      'MANIFEST_NOT_FOUND',
      `No ${MANIFEST_REL} found in ${path.resolve(startDir)} or its parents`,
      {
        hint: "Run init (MCP tool or `mcproc init`) to create a draft from the project's scripts, fill in a description per app, then verify with ls.",
      }
    );
  }
  return parseManifest(
    fs.readFileSync(found.path, 'utf8'),
    found.root,
    found.path,
    loadOverride(found.root)
  );
}

import fs from 'node:fs';
import path from 'node:path';
import { McprocError } from './errors.js';
import type { App, AppKind, Manifest } from './manifest.js';
import {
  findProcess,
  parseJlist,
  pm2Name,
  runtimeDir,
  PM2_NOT_FOUND_HINT,
  type Pm2Process,
} from './pm2.js';
import { treeMetrics, type TreeMetrics } from './metrics.js';
import {
  appPids,
  joinPorts,
  parseProbe,
  type AppPorts,
  type Listener,
} from './ports.js';
import type { ProcStats, StatSample } from './stats.js';
import { buildEcosystem, type Pm2AppConfig } from './ecosystem.js';
import type { Context } from './resolve.js';
import { MARK, probeScript } from '../shell/snippets.js';
import { describeHost, ensureOk } from '../transport/index.js';

export interface LsRow {
  app: string;
  host: string;
  kind: AppKind;
  description: string;
  status: string;
  pm_id: number | null;
  pid: number | null;
  uptime_ms: number | null;
  restarts: number;
  /** pm2's last recorded exit code for the process, any app; null when none is recorded (see statusWord) */
  exit_code: number | null;
  cpu: number | null;
  memory: number;
  procs: number | null;
  runtime: string | null;
  pm2_cpu: number;
  pm2_memory: number;
  metrics_source: 'tree' | 'pm2-root';
  url: string | null;
  url_status: 'ok' | 'error' | 'down' | 'unchecked';
  url_code: number | null;
  ports: AppPorts;
  /** set when the app's host could not be reached; status is then "unreachable" */
  error?: string;
}
export interface Snapshot {
  procs: Pm2Process[];
  ports: Record<string, AppPorts>;
  listeners: Listener[];
  tree: Map<number, number>;
  stats: ProcStats;
  metrics: Record<string, TreeMetrics | null>;
  sampledAt: number;
  urls: Map<string, number | null>;
}
/** `urls`: check every app's URL, none, or only those of the named apps (a mutation answers about what it touched). */
export interface SnapshotOptions {
  cpu?: 'inline' | 'none';
  prev?: { sample: StatSample; at: number };
  urls?: 'check' | 'none' | string[];
}
export interface HostInfo {
  name: string;
  transport: string;
  readonly: boolean;
  cwd: string;
  runtime: string;
  pm2: string | null;
  pm2_home:
    | string
    | null /** apps bound to this host (`host:` in the manifest) */;
  apps: string[];
}

/** 2xx/3xx = ok, 4xx/5xx = error (up but refusing), 000 = down; unchecked when not asked or when the host has neither curl nor wget. */
function urlFields(
  url: string | null,
  urls: Map<string, number | null>
): Pick<LsRow, 'url_status' | 'url_code'> {
  const code = url ? urls.get(url) : undefined;
  if (code === undefined || code === null)
    return { url_status: 'unchecked', url_code: null };
  if (code === 0) return { url_status: 'down', url_code: null };
  return { url_status: code < 400 ? 'ok' : 'error', url_code: code };
}

export async function snapshot(
  ctx: Context,
  opts: SnapshotOptions = {}
): Promise<Snapshot> {
  const cpuSample = (opts.cpu ?? 'inline') === 'inline';
  const which = opts.urls ?? 'check';
  const urls =
    which === 'none'
      ? []
      : Object.values(ctx.manifest.apps)
          .filter((a) => which === 'check' || which.includes(a.name))
          .map((a) => a.url)
          .filter((u): u is string => u !== null);
  const res = ensureOk(
    await ctx.transport.exec(probeScript(ctx.pm2.bin, { cpuSample, urls }), {
      env: ctx.pm2.env(),
    }),
    ctx.host,
    'probe'
  );
  const sampledAt = Date.now();
  if (!res.stdout.includes(MARK.JLIST)) {
    const tail = (res.stderr || res.stdout)
      .trim()
      .split('\n')
      .slice(-5)
      .join('\n');
    throw new McprocError(
      'TRANSPORT_FAILED',
      `the shell on ${ctx.transport.describe()} did not run the probe (exit ${res.code}): ${tail}`,
      {
        hint: `Check hosts.${ctx.host.name}.shell (default /bin/bash -lc) exists on that host.`,
      }
    );
  }
  const data = parseProbe(res.stdout);
  if (data.jlistRc === 127)
    throw new McprocError(
      'PM2_NOT_FOUND',
      `pm2 not found on ${ctx.transport.describe()}`,
      { hint: PM2_NOT_FOUND_HINT }
    );
  if (data.jlistRc !== 0)
    throw new McprocError(
      'PM2_FAILED',
      `pm2 jlist exited ${data.jlistRc} on ${ctx.transport.describe()}`,
      { details: res.stderr.slice(-500) }
    );
  const procs = parseJlist(data.jlistRaw);
  const pids = appPids(
    ctx.manifest.apps,
    procs,
    data.tree,
    ctx.manifest.project
  );
  const metricOpts = opts.prev
    ? { prev: opts.prev.sample, intervalSec: (sampledAt - opts.prev.at) / 1000 }
    : {};
  const metrics: Record<string, TreeMetrics | null> = {};
  for (const [name, set] of pids)
    metrics[name] = treeMetrics(set, data.stats, data.listeners, metricOpts);
  return {
    procs,
    ports: joinPorts(ctx.manifest.apps, procs, data, ctx.manifest.project),
    listeners: data.listeners,
    tree: data.tree,
    stats: data.stats,
    metrics,
    sampledAt,
    urls: data.urls,
  };
}

/** Exit codes bash reports for SIGINT and SIGTERM: the process was stopped, it did not fail. */
const SIGNAL_EXITS = new Set([130, 143]);

/**
 * The word a process is shown with: pm2's status, except that a one-shot app (autorestart off, every kind: task) that
 * exited reads done / failed (exit N) / stopped by its exit code — pm2 itself says only "stopped" and cannot tell a
 * manual stop from a natural exit. A manual stop reaches 130 / 143 through the trap the ecosystem puts in front of the
 * command of every autorestart-off app; null and those codes read as stopped.
 */
export function statusWord(p: Pm2Process | undefined, app: App): string {
  if (!p) return 'not-started';
  if (p.status !== 'stopped' || app.autorestart) return p.status;
  const c = p.exit_code;
  if (c === 0) return 'done';
  if (c === null || SIGNAL_EXITS.has(c)) return 'stopped';
  return `failed (exit ${c})`;
}

export function rowsFor(
  ctx: Context,
  snap: Snapshot,
  names: string[]
): LsRow[] {
  return names.map((name) => {
    const app = ctx.manifest.apps[name];
    const p = findProcess(snap.procs, ctx.manifest.project, name);
    const m = snap.metrics[name];
    return {
      app: name,
      host: ctx.host.name,
      kind: app.kind,
      description: app.description,
      status: statusWord(p, app),
      pm_id: p?.pm_id ?? null,
      pid: p && p.pid > 0 ? p.pid : null,
      uptime_ms: p?.uptime_ms ?? null,
      restarts: p?.restarts ?? 0,
      exit_code: p?.exit_code ?? null,
      cpu: m ? m.cpu : (p?.cpu ?? 0),
      memory: m ? m.memory : (p?.memory ?? 0),
      procs: m ? m.procs : null,
      runtime: m ? m.runtime : null,
      pm2_cpu: p?.cpu ?? 0,
      pm2_memory: p?.memory ?? 0,
      metrics_source: m ? 'tree' : 'pm2-root',
      url: app.url,
      ...urlFields(app.url, snap.urls),
      ports: snap.ports[name],
    };
  });
}

/** The row of an app whose host did not answer (or whose change failed or was skipped): what the manifest declares, no runtime facts, and why. */
export function unreachableRow(
  app: App,
  host: string,
  error: string,
  status = 'unreachable'
): LsRow {
  return {
    app: app.name,
    host,
    kind: app.kind,
    description: app.description,
    status,
    pm_id: null,
    pid: null,
    uptime_ms: null,
    restarts: 0,
    exit_code: null,
    cpu: null,
    memory: 0,
    procs: null,
    runtime: null,
    pm2_cpu: 0,
    pm2_memory: 0,
    metrics_source: 'pm2-root',
    url: app.url,
    url_status: 'unchecked',
    url_code: null,
    ports: { actual: [], declared: app.ports, checks: [], undeclared: [] },
    error,
  };
}

export async function listApps(ctx: Context, app?: string): Promise<LsRow[]> {
  const names = app ? [app] : Object.keys(ctx.manifest.apps);
  return rowsFor(ctx, await snapshot(ctx), names);
}

export async function portsReport(
  ctx: Context,
  port?: number
): Promise<{
  port: number | null;
  listeners: Array<Listener & { app: string | null }>;
}> {
  const snap = await snapshot(ctx);
  const pidToApp = new Map<number, string>();
  for (const [name, ap] of Object.entries(snap.ports))
    for (const l of ap.actual)
      for (const pid of l.pids) pidToApp.set(pid, name);
  const listeners = snap.listeners
    .filter((l) => port === undefined || l.port === port)
    .map((l) => ({
      ...l,
      app: l.pids.map((p) => pidToApp.get(p)).find(Boolean) ?? null,
    }))
    .sort((a, b) => a.port - b.port);
  return { port: port ?? null, listeners };
}

export function hostsInfo(m: Manifest): HostInfo[] {
  const names = ['local', ...Object.keys(m.hosts).filter((n) => n !== 'local')];
  return names.map((n) => {
    const h = m.hosts[n];
    return {
      name: n,
      transport: describeHost(h),
      readonly: h.readonly,
      cwd: h.cwd,
      runtime: runtimeDir(h),
      pm2: h.pm2 ?? null,
      pm2_home: h.pm2_home ?? null,
      apps: Object.values(m.apps)
        .filter((a) => a.host === n)
        .map((a) => a.name),
    };
  });
}

export async function describeApp(
  ctx: Context,
  name: string
): Promise<{
  app: App;
  row: LsRow;
  logs: { out: string; err: string } | null;
  pm2: Pm2AppConfig;
}> {
  const app = ctx.manifest.apps[name];
  const snap = await snapshot(ctx);
  const [row] = rowsFor(ctx, snap, [name]);
  const p = findProcess(snap.procs, ctx.manifest.project, name);
  const pm2 = buildEcosystem(ctx.manifest, ctx.host).apps.find(
    (a) => a.name === pm2Name(ctx.manifest.project, name)
  )!;
  return { app, row, logs: p ? { out: p.out_log, err: p.err_log } : null, pm2 };
}

export function describeProject(m: Manifest) {
  const readmePath = path.join(m.root, '.mcproc', 'README.md');
  const readme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, 'utf8')
    : null;
  return {
    project: m.project,
    root: m.root,
    manifest_path: m.path,
    apps: Object.values(m.apps).map((a) => ({
      name: a.name,
      kind: a.kind,
      description: a.description,
      ports: a.ports,
      url: a.url,
      depends_on: a.depends_on.map((d) => ({
        app: d.app,
        condition: d.condition,
        timeout_s: d.timeoutMs / 1000,
      })),
      host: a.host,
    })),
    profiles: { ...m.profiles, all: Object.keys(m.apps) },
    hosts: hostsInfo(m),
    readme,
  };
}

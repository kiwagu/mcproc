import fs from 'node:fs';
import path from 'node:path';
import { McprocError } from './errors.js';
import type { App, AppKind, Dep, Manifest } from './manifest.js';
import {
  findProcess,
  parseJlist,
  pm2Name,
  runtimeDir,
  PM2_NOT_FOUND_HINT,
  type Pm2Process,
} from './pm2.js';
import { treeMetrics, type TreeMetrics } from './metrics.js';
import type { HostMemory } from './memory.js';
import { hostStamp } from './logsince.js';
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
import type { ReloadCount } from './reloads.js';
import { settleUrls, type UrlApp, type UrlResult } from './urlcheck.js';
import { leasesCovering, type LeaseView } from './leases/view.js';
import { stateDir } from './state.js';
import { MARK, probeScript, probeTimeoutMs } from '../shell/snippets.js';
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
  /** when pm2 last started the process, as the host's local time with milliseconds (pm2's log stamp shape, YYYY-MM-DDTHH:mm:ss.SSS); null without a process, a start time or the host's zone */
  started: string | null;
  restarts: number;
  /** pm2's last recorded exit code for the process, any app; null when none is recorded (see statusWord) */
  exit_code: number | null;
  cpu: number | null;
  memory: number;
  /** the memory of the app's declared docker containers, inside memory */
  containers_memory: number;
  procs: number | null;
  runtime: string | null;
  pm2_cpu: number;
  pm2_memory: number;
  metrics_source: 'tree' | 'pm2-root';
  url: string | null;
  url_status: 'ok' | 'error' | 'down' | 'unchecked';
  url_code: number | null;
  /** where the url's answer came from: its host's probe, or this machine (url_check); null when unchecked */
  url_from: 'host' | 'here' | null;
  /** why the url is down, or why it was taken from this machine ("on box: refused; here: refused"); null otherwise */
  url_reason: string | null;
  ports: AppPorts;
  /**
   * only when asked (ls --reloads) and the app runs with reloads on and a known start: its in-process reloads since pm2
   * started it, the last one's stamp as its log wrote it, and partial when the logs read did not reach back to the start
   * (the count is then a lower bound)
   */
  reloads?: ReloadCount;
  /** the lease that covers an app with no process yet: queued (its position) or starting */
  lease?: {
    id: string;
    state: 'pending' | 'starting';
    position: number;
    waiting_for: string | null;
  };
  /** set when the app's host could not be reached; status is then "unreachable" */
  error?: string;
  /** something the change did not finish beside the app itself, such as the leases a stop could not update */
  note?: string;
}
/** One look at a host for this project: pm2's processes, the ports, the metrics, the url checks, the memory and the leases. */
export interface Snapshot {
  procs: Pm2Process[];
  ports: Record<string, AppPorts>;
  listeners: Listener[];
  tree: Map<number, number>;
  stats: ProcStats;
  metrics: Record<string, TreeMetrics | null>;
  sampledAt: number;
  /** each asked app's url as decided (its host's answer, the check from here, url_check), by app name */
  urlChecks: Record<string, UrlResult>;
  /** the host's UTC offset ('+0200'); null when the probe could not read it */
  zone: string | null;
  /** the host's /proc/meminfo numbers; null where it has none */
  memory: HostMemory | null;
  /** this checkout's pending and starting leases on this machine (none on another host, or when not asked) */
  leases: LeaseView[];
}
/** `urls`: check every app's URL, none, or only those of the named apps (a mutation answers about what it touched). */
export interface SnapshotOptions {
  cpu?: 'inline' | 'none';
  /** 'none': the light probe (no /proc stat, RSS, args or docker); tree metrics stay null */
  metrics?: 'tree' | 'none';
  prev?: { sample: StatSample; at: number };
  urls?: 'check' | 'none' | string[];
  /** 'probe': ask docker for the declared containers' memory (about 2 s); default 'none', so a polling loop never pays it */
  containers?: 'probe' | 'none';
  /** 'read' (the default): read this checkout's leases from the state directory, on the local host only; 'none': skip it */
  leases?: 'read' | 'none';
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

/** An app's decided url check; undefined when its url was not asked for (own keys only: an app may be named constructor). */
export const urlCheckOf = (
  snap: Snapshot,
  app: string
): UrlResult | undefined =>
  Object.hasOwn(snap.urlChecks, app) ? snap.urlChecks[app] : undefined;

/** The row's url fields from the decided check; unchecked when the url was not asked for. */
function urlFields(
  u: UrlResult | undefined
): Pick<LsRow, 'url_status' | 'url_code' | 'url_from' | 'url_reason'> {
  return u
    ? {
        url_status: u.status,
        url_code: u.code,
        url_from: u.from,
        url_reason: u.reason,
      }
    : {
        url_status: 'unchecked',
        url_code: null,
        url_from: null,
        url_reason: null,
      };
}

/** Probes the context's host once (see SnapshotOptions for what it asks), and on this machine reads the checkout's leases. */
export async function snapshot(
  ctx: Context,
  opts: SnapshotOptions = {}
): Promise<Snapshot> {
  const withMetrics = opts.metrics !== 'none';
  const cpuSample = (opts.cpu ?? 'inline') === 'inline' && withMetrics;
  const which = opts.urls ?? 'check';
  const asked: UrlApp[] =
    which === 'none'
      ? []
      : Object.values(ctx.manifest.apps).flatMap((a) =>
          a.url !== null && (which === 'check' || which.includes(a.name))
            ? [{ name: a.name, url: a.url, url_check: a.url_check }]
            : []
        );
  // the host requests each asked url once, except those checked only from here (url_check: here, on a host that is not this machine)
  const urls = [
    ...new Set(
      asked
        .filter((a) => ctx.host.local || a.url_check !== 'here')
        .map((a) => a.url)
    ),
  ];
  const containers =
    withMetrics && opts.containers === 'probe'
      ? [
          ...new Set(
            Object.values(ctx.manifest.apps).flatMap((a) => a.containers)
          ),
        ]
      : [];
  const res = ensureOk(
    await ctx.transport.exec(
      probeScript(ctx.pm2.bin, {
        cpuSample,
        urls,
        metrics: withMetrics,
        containers,
      }),
      {
        env: ctx.pm2.env(),
        // each url adds its bounded lookup and request: many on a host whose resolver drops packets outlast the default
        timeoutMs: probeTimeoutMs(urls.length),
      }
    ),
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
  for (const app of Object.values(ctx.manifest.apps)) {
    const m = metrics[app.name];
    if (!m || app.containers.length === 0) continue;
    const mib = app.containers.reduce(
      (sum, c) => sum + (data.containers.get(c) ?? 0),
      0
    );
    const bytes = mib * 1024 * 1024;
    metrics[app.name] = {
      ...m,
      memory: m.memory + bytes,
      containers_memory: bytes,
    };
  }
  // the checks from here that url_check asks for, after the probe: a url the host answered costs nothing more
  const urlChecks = await settleUrls(
    asked,
    { host: ctx.host.name, local: ctx.host.local },
    data,
    ctx.hereCheck
  );
  return {
    procs,
    ports: joinPorts(ctx.manifest.apps, procs, data, ctx.manifest.project),
    listeners: data.listeners,
    tree: data.tree,
    stats: data.stats,
    metrics,
    sampledAt,
    urlChecks,
    zone: data.zone,
    memory: data.memory,
    leases:
      ctx.host.local && opts.leases !== 'none'
        ? leasesCovering(stateDir(), ctx.manifest)
        : [],
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

/** One row per named app, in that order: what pm2 and the probe show, or for an app with no process that a lease covers, its place in the queue. */
export function rowsFor(
  ctx: Context,
  snap: Snapshot,
  names: string[]
): LsRow[] {
  return names.map((name) => {
    const app = ctx.manifest.apps[name];
    const p = findProcess(snap.procs, ctx.manifest.project, name);
    // a lease speaks only for an app that has no process yet: one that has a process is shown as it is
    const cover = p
      ? undefined
      : snap.leases.find((l) => l.apps.includes(name));
    if (cover) return queuedRow(app, ctx.host.name, cover, cover.position);
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
      started:
        p?.started_at != null && snap.zone
          ? hostStamp(p.started_at, snap.zone)
          : null,
      restarts: p?.restarts ?? 0,
      exit_code: p?.exit_code ?? null,
      cpu: m ? m.cpu : (p?.cpu ?? 0),
      memory: m ? m.memory : (p?.memory ?? 0),
      containers_memory: m?.containers_memory ?? 0,
      procs: m ? m.procs : null,
      runtime: m ? m.runtime : null,
      pm2_cpu: p?.cpu ?? 0,
      pm2_memory: p?.memory ?? 0,
      metrics_source: m ? 'tree' : 'pm2-root',
      url: app.url,
      ...urlFields(urlCheckOf(snap, name)),
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
    started: null,
    restarts: 0,
    exit_code: null,
    cpu: null,
    memory: 0,
    containers_memory: 0,
    procs: null,
    runtime: null,
    pm2_cpu: 0,
    pm2_memory: 0,
    metrics_source: 'pm2-root',
    url: app.url,
    url_status: 'unchecked',
    url_code: null,
    url_from: null,
    url_reason: null,
    ports: { actual: [], declared: app.ports, checks: [], undeclared: [] },
    error,
  };
}

/** The row of an app whose start is queued: no runtime facts, the lease's position and reason instead. */
export function queuedRow(
  app: App,
  host: string,
  lease: {
    id: string;
    state: 'pending' | 'starting';
    waiting_for: string | null;
  },
  position: number
): LsRow {
  const base = unreachableRow(
    app,
    host,
    '',
    lease.state === 'starting' ? 'starting' : `queued #${position}`
  );
  const { error: _dropped, ...row } = base;
  return {
    ...row,
    lease: {
      id: lease.id,
      state: lease.state,
      position,
      waiting_for: lease.waiting_for,
    },
  };
}

export async function listApps(ctx: Context, app?: string): Promise<LsRow[]> {
  const names = app ? [app] : Object.keys(ctx.manifest.apps);
  // one app's read asks only its own url
  return rowsFor(
    ctx,
    await snapshot(ctx, {
      urls: app ? [app] : 'check',
      containers: 'probe',
    }),
    names
  );
}

export async function portsReport(
  ctx: Context,
  port?: number
): Promise<{
  port: number | null;
  listeners: Array<Listener & { app: string | null }>;
}> {
  // no url is shown, so none is asked; the full probe stays for the docker-published ports
  const snap = await snapshot(ctx, { urls: 'none' });
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
  const snap = await snapshot(ctx, { urls: [name], containers: 'probe' });
  const [row] = rowsFor(ctx, snap, [name]);
  const p = findProcess(snap.procs, ctx.manifest.project, name);
  const pm2 = buildEcosystem(ctx.manifest, ctx.host).apps.find(
    (a) => a.name === pm2Name(ctx.manifest.project, name)
  )!;
  return { app, row, logs: p ? { out: p.out_log, err: p.err_log } : null, pm2 };
}

/** A dependency as the describe answers show it (the manifest keeps the timeout in ms): one shape for the project and for one app. */
export const depView = (d: Dep) => ({
  app: d.app,
  condition: d.condition,
  timeout_s: d.timeoutMs / 1000,
});

export function describeProject(m: Manifest) {
  const readmePath = path.join(m.root, '.mcproc', 'README.md');
  const readme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, 'utf8')
    : null;
  return {
    project: m.project,
    root: m.root,
    manifest_path: m.path,
    base_project: m.base_project,
    vars: m.vars,
    override: m.override,
    slot: m.slot,
    resources: m.resources,
    worktree: m.worktree,
    exec: m.exec,
    apps: Object.values(m.apps).map((a) => ({
      name: a.name,
      kind: a.kind,
      description: a.description,
      ports: a.ports,
      url: a.url,
      memory_mib: a.memory_mib,
      containers: a.containers,
      depends_on: a.depends_on.map(depView),
      host: a.host,
    })),
    profiles: { ...m.profiles, all: Object.keys(m.apps) },
    hosts: hostsInfo(m),
    readme,
  };
}

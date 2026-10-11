import fs from 'node:fs';
import path from 'node:path';
import { McprocError } from './errors.js';
import type { App, AppKind, Manifest } from './manifest.js';
import { findProcess, parseJlist, pm2Name, runtimeDir, PM2_NOT_FOUND_HINT, type Pm2Process } from './pm2.js';
import { joinPorts, parseProbe, type AppPorts, type Listener } from './ports.js';
import { buildEcosystem, type Pm2AppConfig } from './ecosystem.js';
import type { Context } from './resolve.js';
import { MARK, probeScript } from '../shell/snippets.js';
import { describeHost, ensureOk } from '../transport/index.js';

export interface LsRow {
  app: string; kind: AppKind; description: string; status: string; pm_id: number | null; pid: number | null;
  uptime_ms: number | null; restarts: number; cpu: number; memory: number; ports: AppPorts;
}
export interface Snapshot { procs: Pm2Process[]; ports: Record<string, AppPorts>; listeners: Listener[]; tree: Map<number, number> }
export interface HostInfo { name: string; transport: string; readonly: boolean; cwd: string; runtime: string; pm2: string | null; pm2_home: string | null }

export async function snapshot(ctx: Context): Promise<Snapshot> {
  const res = ensureOk(await ctx.transport.exec(probeScript(ctx.pm2.bin), { env: ctx.pm2.env() }), ctx.host, 'probe');
  if (!res.stdout.includes(MARK.JLIST)) {
    const tail = (res.stderr || res.stdout).trim().split('\n').slice(-5).join('\n');
    throw new McprocError('TRANSPORT_FAILED', `the shell on ${ctx.transport.describe()} did not run the probe (exit ${res.code}): ${tail}`, { hint: `Check hosts.${ctx.host.name}.shell (default /bin/bash -lc) exists on that host.` });
  }
  const data = parseProbe(res.stdout);
  if (data.jlistRc === 127) throw new McprocError('PM2_NOT_FOUND', `pm2 not found on ${ctx.transport.describe()}`, { hint: PM2_NOT_FOUND_HINT });
  if (data.jlistRc !== 0) throw new McprocError('PM2_FAILED', `pm2 jlist exited ${data.jlistRc} on ${ctx.transport.describe()}`, { details: res.stderr.slice(-500) });
  const procs = parseJlist(data.jlistRaw);
  return { procs, ports: joinPorts(ctx.manifest.apps, procs, data, ctx.manifest.project), listeners: data.listeners, tree: data.tree };
}

export function rowsFor(ctx: Context, snap: Snapshot, names: string[]): LsRow[] {
  return names.map((name) => {
    const app = ctx.manifest.apps[name];
    const p = findProcess(snap.procs, ctx.manifest.project, name);
    return {
      app: name, kind: app.kind, description: app.description,
      status: p?.status ?? 'not-started', pm_id: p?.pm_id ?? null, pid: p && p.pid > 0 ? p.pid : null,
      uptime_ms: p?.uptime_ms ?? null, restarts: p?.restarts ?? 0, cpu: p?.cpu ?? 0, memory: p?.memory ?? 0,
      ports: snap.ports[name],
    };
  });
}

export async function listApps(ctx: Context, app?: string): Promise<LsRow[]> {
  const names = app ? [app] : Object.keys(ctx.manifest.apps);
  return rowsFor(ctx, await snapshot(ctx), names);
}

export async function portsReport(ctx: Context, port?: number): Promise<{ port: number | null; listeners: Array<Listener & { app: string | null }> }> {
  const snap = await snapshot(ctx);
  const pidToApp = new Map<number, string>();
  for (const [name, ap] of Object.entries(snap.ports)) for (const l of ap.actual) if (l.pid !== null) pidToApp.set(l.pid, name);
  const listeners = snap.listeners
    .filter((l) => port === undefined || l.port === port)
    .map((l) => ({ ...l, app: l.pid !== null ? pidToApp.get(l.pid) ?? null : null }))
    .sort((a, b) => a.port - b.port);
  return { port: port ?? null, listeners };
}

export function hostsInfo(m: Manifest): HostInfo[] {
  const names = ['local', ...Object.keys(m.hosts).filter((n) => n !== 'local')];
  return names.map((n) => {
    const h = m.hosts[n];
    return { name: n, transport: describeHost(h), readonly: h.readonly, cwd: h.cwd, runtime: runtimeDir(h), pm2: h.pm2 ?? null, pm2_home: h.pm2_home ?? null };
  });
}

export async function describeApp(ctx: Context, name: string): Promise<{ app: App; row: LsRow; logs: { out: string; err: string } | null; pm2: Pm2AppConfig }> {
  const app = ctx.manifest.apps[name];
  const snap = await snapshot(ctx);
  const [row] = rowsFor(ctx, snap, [name]);
  const p = findProcess(snap.procs, ctx.manifest.project, name);
  const pm2 = buildEcosystem(ctx.manifest, ctx.host).apps.find((a) => a.name === pm2Name(ctx.manifest.project, name))!;
  return { app, row, logs: p ? { out: p.out_log, err: p.err_log } : null, pm2 };
}

export function describeProject(m: Manifest) {
  const readmePath = path.join(m.root, '.mcproc', 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : null;
  return {
    project: m.project, root: m.root, manifest_path: m.path,
    apps: Object.values(m.apps).map((a) => ({ name: a.name, kind: a.kind, description: a.description, ports: a.ports, depends_on: a.depends_on })),
    profiles: { ...m.profiles, all: Object.keys(m.apps) },
    hosts: hostsInfo(m), readme,
  };
}

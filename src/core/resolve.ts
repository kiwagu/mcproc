import os from 'node:os';
import path from 'node:path';
import { McprocError } from './errors.js';
import {
  DEFAULT_SHELL,
  loadManifest,
  parseShell,
  scopeManifest,
  type Host,
  type Manifest,
} from './manifest.js';
import {
  Pm2Client,
  resolvePm2Bin,
  type DaemonLister,
  type Pm2Resolution,
} from './pm2.js';
import { listDaemon } from './pm2socket.js';
import { recordProject } from './registry.js';
import type { ProcReader } from './procfs.js';
import { createTransport } from '../transport/index.js';
import type { ExecResult, Spawner, Transport } from '../transport/types.js';
import { checkHere, type HereCheck } from './urlcheck.js';

export const MAX_PM2_HOME = 90;

export function resolveProjectDir(
  explicit?: string,
  roots: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): string {
  const pick =
    explicit ||
    env.MCPROC_PROJECT ||
    env.CLAUDE_PROJECT_DIR ||
    roots[0] ||
    process.cwd();
  return path.resolve(pick);
}

export interface Prepared {
  manifest: Manifest;
  host: Host;
}
export interface Context extends Prepared {
  transport: Transport;
  pm2: Pm2Client;
  resolution: Pm2Resolution;
  /** checks a url from this machine when url_check asks for it; tests pass a fake */
  hereCheck: HereCheck;
  /** this machine's processes read in-process from /proc; absent or null: the probe script reads them */
  proc?: ProcReader | null;
}

/** What a probe of a host needs: how to reach it, its pm2, and on this machine its /proc reader; no manifest. */
export type HostLink = Pick<Context, 'host' | 'transport' | 'pm2' | 'proc'>;

/** The shell on the host did not run a read-only script: the last lines it printed, and where to look. */
export function scriptNotRun(
  link: HostLink,
  res: ExecResult,
  what: string
): McprocError {
  const tail = (res.stderr || res.stdout)
    .trim()
    .split('\n')
    .slice(-5)
    .join('\n');
  return new McprocError(
    'TRANSPORT_FAILED',
    `the shell on ${link.transport.describe()} did not run ${what} (exit ${res.code}): ${tail}`,
    {
      hint: `Check hosts.${link.host.name}.shell (default /bin/bash -lc) exists on that host.`,
    }
  );
}

/** The local host as a manifest without `hosts.local` declares it: the login shell, pm2's default home. */
export function bareLocalHost(): Host {
  return {
    name: 'local',
    local: true,
    ssh_args: [],
    cwd: os.homedir(),
    readonly: false,
    shell: parseShell(DEFAULT_SHELL),
    env: {},
  };
}

export function pickHost(m: Manifest, name = 'local'): Host {
  const h = Object.hasOwn(m.hosts, name) ? m.hosts[name] : undefined;
  if (!h)
    throw new McprocError(
      'UNKNOWN_HOST',
      `Unknown host "${name}" in ${m.path}`,
      { hint: `Known hosts: ${Object.keys(m.hosts).join(', ')}` }
    );
  if (h.pm2_home && h.pm2_home.length > MAX_PM2_HOME) {
    throw new McprocError(
      'PM2_HOME_TOO_LONG',
      `hosts.${name}.pm2_home is ${h.pm2_home.length} characters; unix socket paths are capped at 108 bytes and pm2 puts its sockets inside PM2_HOME`,
      { hint: `Use a path of at most ${MAX_PM2_HOME} characters.` }
    );
  }
  return h;
}

export function assertWritable(host: Host): void {
  if (host.readonly)
    throw new McprocError(
      'READONLY_HOST',
      `Host "${host.name}" is readonly: no start/stop/restart/delete/flush/init there`,
      {
        hint: 'Read-only tools (ls, describe, logs, ports, doctor) still work.',
      }
    );
}

export function assertApp(m: Manifest, name: string): void {
  if (!Object.hasOwn(m.apps, name))
    throw new McprocError('UNKNOWN_APP', `Unknown app "${name}" in ${m.path}`, {
      hint: `Known apps: ${Object.keys(m.apps).join(', ')}`,
    });
}

export function prepare(opts: {
  project?: string;
  host?: string;
  roots?: string[];
}): Prepared {
  const manifest = loadManifest(resolveProjectDir(opts.project, opts.roots));
  recordProject(manifest); // the host's memory of its stacks: every command that reads a manifest keeps it current
  return { manifest, host: pickHost(manifest, opts.host) };
}

/**
 * How a host's pm2 list is read: over the daemon's socket on this machine, unless a hosts.local.pm2 wrapper stands in
 * for pm2 (mcproc cannot know what it wraps) or a test injected a spawner (its fake world has no daemon of ours).
 */
export function daemonFor(
  host: Host,
  resolution: Pm2Resolution,
  spawner?: Spawner
): DaemonLister | null {
  return host.local && resolution.source !== 'explicit' && !spawner
    ? listDaemon
    : null;
}

const cache = new Map<string, Pm2Resolution>();
export function clearResolutionCache(): void {
  cache.clear();
}

/**
 * A context for one host. Its manifest is the host's view (scopeManifest): the apps bound to it plus the unbound ones
 * when it is the fallback — by default the host itself, i.e. what `--host <it>` means; a whole-project command reaching
 * a host it does not name passes `fallback` (local), so that host sees only its bound apps. `hereCheck` is the check of
 * a url from this machine; every context gets the real one unless a caller (a test) passes another.
 */
export async function connect(
  prep: Prepared,
  opts: {
    spawner?: Spawner;
    fresh?: boolean;
    fallback?: string;
    hereCheck?: HereCheck;
    /** how the pm2 list is read, in place of daemonFor's choice (tests) */
    daemon?: DaemonLister | null;
  } = {}
): Promise<Context> {
  const transport = createTransport(prep.host, opts.spawner);
  const key = `${prep.manifest.path}|${prep.host.name}`;
  let resolution = opts.fresh ? undefined : cache.get(key);
  if (!resolution) {
    resolution = await resolvePm2Bin(prep.host, transport);
    cache.set(key, resolution);
  }
  const pm2 = new Pm2Client(
    transport,
    prep.host,
    resolution.bin,
    prep.host.pm2_home,
    opts.daemon !== undefined
      ? opts.daemon
      : daemonFor(prep.host, resolution, opts.spawner)
  );
  return {
    manifest: scopeManifest(
      prep.manifest,
      prep.host.name,
      opts.fallback ?? prep.host.name
    ),
    host: prep.host,
    transport,
    pm2,
    resolution,
    hereCheck: opts.hereCheck ?? checkHere,
  };
}

/** A link to one host's pm2 for reading a whole daemon: the pm2 it would use, found the way connect finds it. */
export async function connectHost(
  host: Host,
  opts: { spawner?: Spawner; daemon?: DaemonLister | null } = {}
): Promise<HostLink> {
  const transport = createTransport(host, opts.spawner);
  const resolution = await resolvePm2Bin(host, transport);
  return {
    host,
    transport,
    pm2: new Pm2Client(
      transport,
      host,
      resolution.bin,
      host.pm2_home,
      opts.daemon !== undefined
        ? opts.daemon
        : daemonFor(host, resolution, opts.spawner)
    ),
  };
}

export function createContext(opts: {
  project?: string;
  host?: string;
  roots?: string[];
  spawner?: Spawner;
  fresh?: boolean;
}): Promise<Context> {
  return connect(prepare(opts), { spawner: opts.spawner, fresh: opts.fresh });
}

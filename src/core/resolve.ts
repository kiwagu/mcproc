import path from 'node:path';
import { McprocError } from './errors.js';
import {
  loadManifest,
  scopeManifest,
  type Host,
  type Manifest,
} from './manifest.js';
import { Pm2Client, resolvePm2Bin, type Pm2Resolution } from './pm2.js';
import { recordProject } from './registry.js';
import { createTransport } from '../transport/index.js';
import type { Spawner, Transport } from '../transport/types.js';
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
    prep.host.pm2_home
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

export function createContext(opts: {
  project?: string;
  host?: string;
  roots?: string[];
  spawner?: Spawner;
  fresh?: boolean;
}): Promise<Context> {
  return connect(prepare(opts), { spawner: opts.spawner, fresh: opts.fresh });
}

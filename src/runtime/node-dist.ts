import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McprocError, isMcprocError } from '../core/errors.js';
import {
  NODE_DIST_BASE,
  compareVersions,
  nodeDistFile,
  nodeDistUrl,
  normalizeVersion,
  parseShasums,
  type NodePlatform,
} from './platform.js';

export type Fetcher = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
/** Every request is bounded: a stalled connection must fail as DOWNLOAD_FAILED, not hang the tool call. */
export const defaultFetcher: Fetcher = (url) =>
  fetch(url, {
    signal: AbortSignal.timeout(url.endsWith('.tar.gz') ? 600_000 : 30_000),
  });

export interface NodeTarball {
  version: string;
  platform: NodePlatform;
  file: string;
  path: string;
  sha256: string;
  bytes: number;
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'mcproc',
    'node'
  );
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const HINT =
  'The machine running mcproc must reach nodejs.org once per Node version; afterwards the verified tarball is served from its cache.';

async function getText(fetcher: Fetcher, url: string): Promise<string> {
  try {
    const r = await fetcher(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    throw new McprocError(
      'DOWNLOAD_FAILED',
      `cannot download ${url}: ${(e as Error).message}`,
      { hint: HINT }
    );
  }
}

async function getBytes(fetcher: Fetcher, url: string): Promise<Buffer> {
  try {
    const r = await fetcher(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    throw new McprocError(
      'DOWNLOAD_FAILED',
      `cannot download ${url}: ${(e as Error).message}`,
      { hint: HINT }
    );
  }
}

/** Versions cached for a platform whose checksum sidecar exists (i.e. were verified when downloaded), newest first. */
function cachedVersions(cacheDir: string, platform: NodePlatform): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(cacheDir);
  } catch {
    return [];
  }
  const re = new RegExp(`^node-(v\\d+\\.\\d+\\.\\d+)-${platform}\\.tar\\.gz$`);
  return names
    .map((n) => re.exec(n)?.[1])
    .filter(
      (v): v is string =>
        !!v && names.includes(`node-${v}-${platform}.tar.gz.sha256`)
    )
    .sort(compareVersions)
    .reverse();
}

export async function resolveNodeVersion(
  requested: string | undefined,
  platform: NodePlatform,
  opts: { fetcher?: Fetcher; cacheDir?: string } = {}
): Promise<string> {
  if (requested) return normalizeVersion(requested);
  const fetcher = opts.fetcher ?? defaultFetcher;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  try {
    const index = JSON.parse(
      await getText(fetcher, `${NODE_DIST_BASE}/index.json`)
    ) as { version: string; lts: string | false }[];
    const lts = index.find((v) => v.lts); // index.json lists the newest release first
    if (!lts)
      throw new McprocError(
        'DOWNLOAD_FAILED',
        'nodejs.org index.json lists no LTS release',
        { hint: HINT }
      );
    return lts.version;
  } catch (e) {
    const cached = cachedVersions(cacheDir, platform);
    if (cached.length) return cached[0];
    throw isMcprocError(e)
      ? e
      : new McprocError('DOWNLOAD_FAILED', (e as Error).message, {
          hint: HINT,
        });
  }
}

export async function fetchNodeTarball(
  version: string,
  platform: NodePlatform,
  opts: { fetcher?: Fetcher; cacheDir?: string } = {}
): Promise<NodeTarball> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const file = nodeDistFile(version, platform);
  const target = path.join(cacheDir, file);
  const sidecar = `${target}.sha256`;
  if (fs.existsSync(target) && fs.existsSync(sidecar)) {
    const want = fs.readFileSync(sidecar, 'utf8').trim();
    const data = fs.readFileSync(target);
    if (sha256(data) === want)
      return {
        version,
        platform,
        file,
        path: target,
        sha256: want,
        bytes: data.length,
      };
  }
  const want = parseShasums(
    await getText(fetcher, nodeDistUrl(version, 'SHASUMS256.txt'))
  ).get(file);
  if (!want)
    throw new McprocError(
      'DOWNLOAD_FAILED',
      `nodejs.org has no ${file} for ${version}`,
      {
        hint: 'Pick another node_version, or with_node: never when the host already has Node >= 18.',
      }
    );
  const data = await getBytes(fetcher, nodeDistUrl(version, file));
  const got = sha256(data);
  if (got !== want)
    throw new McprocError(
      'DOWNLOAD_FAILED',
      `checksum mismatch for ${file}: SHASUMS256 says ${want}, downloaded ${got}`,
      { hint: HINT }
    );
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(`${target}.part`, data);
  fs.renameSync(`${target}.part`, target);
  fs.writeFileSync(sidecar, `${want}\n`);
  return {
    version,
    platform,
    file,
    path: target,
    sha256: want,
    bytes: data.length,
  };
}

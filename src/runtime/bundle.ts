import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McprocError } from '../core/errors.js';

export interface Pm2Bundle {
  version: string;
  sha256: string;
  data: Buffer;
  path: string;
}
export type Runner = (cmd: string, args: string[], cwd: string) => void;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const readJson = (p: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: package.json files are untyped data, probed field by field
  JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, any>;

/** Walks up to the directory whose package.json is mcproc's (works from src/ under tsx and from dist/ when installed). */
export function findPackageRoot(
  from: string = path.dirname(fileURLToPath(import.meta.url))
): string {
  let dir = path.resolve(from);
  for (;;) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) {
      try {
        if (readJson(p).name === 'mcproc') return dir;
      } catch {
        /* not ours */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new McprocError(
        'BUNDLE_INVALID',
        `cannot locate the mcproc package root above ${from}`
      );
    dir = parent;
  }
}

export function lockfileHash(root: string): string {
  return sha256(
    fs.readFileSync(path.join(root, 'runtime', 'package-lock.json'))
  );
}

export function defaultPm2CacheDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(
    env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'mcproc',
    'pm2'
  );
}

const defaultRunner: Runner = (cmd, args, cwd) => {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
};

function tarFlags(): string[] {
  try {
    return /GNU tar/.test(execFileSync('tar', ['--version']).toString())
      ? [
          '--sort=name',
          '--mtime=@0',
          '--owner=0',
          '--group=0',
          '--numeric-owner',
          '--mode=u+rwX,go+rX,go-w',
        ]
      : [];
  } catch {
    return [];
  }
}

/**
 * The pm2 tree `unpack` ships to hosts, assembled on THIS machine with npm ci from the lockfile mcproc ships
 * (never embedded in the package: pm2 is AGPL-3.0, mcproc is MIT) and cached once per pm2 version + lockfile.
 */
export async function ensurePm2Bundle(
  opts: { root?: string; cacheDir?: string; run?: Runner; force?: boolean } = {}
): Promise<Pm2Bundle> {
  const root = opts.root ?? findPackageRoot();
  const cacheDir = opts.cacheDir ?? defaultPm2CacheDir();
  const run = opts.run ?? defaultRunner;
  const pin: string =
    readJson(path.join(root, 'package.json')).dependencies?.pm2 ?? '';
  if (!/^\d+\.\d+\.\d+$/.test(pin))
    throw new McprocError(
      'BUNDLE_INVALID',
      `pm2 must be pinned to an exact version in mcproc's package.json, got "${pin}"`
    );
  const runtimePin: string =
    readJson(path.join(root, 'runtime', 'package.json')).dependencies?.pm2 ??
    '';
  if (runtimePin !== pin)
    throw new McprocError(
      'BUNDLE_INVALID',
      `runtime/package.json pins pm2 ${runtimePin}, package.json pins ${pin}`
    );
  const lockSha = lockfileHash(root);
  const target = path.join(cacheDir, `pm2-${pin}-${lockSha.slice(0, 12)}.tgz`);
  const sidecar = `${target}.json`;
  if (!opts.force && fs.existsSync(target) && fs.existsSync(sidecar)) {
    const meta = readJson(sidecar);
    const data = fs.readFileSync(target);
    if (
      meta.pm2 === pin &&
      meta.lock_sha256 === lockSha &&
      sha256(data) === meta.sha256
    )
      return { version: pin, sha256: meta.sha256, data, path: target };
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-pm2-'));
  try {
    for (const f of ['package.json', 'package-lock.json'])
      fs.copyFileSync(path.join(root, 'runtime', f), path.join(stage, f));
    try {
      run(
        'npm',
        ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        stage
      );
    } catch (e) {
      throw new McprocError(
        'DOWNLOAD_FAILED',
        `npm ci for pm2 ${pin} failed on this machine: ${(e as Error).message}`,
        {
          hint: 'unpack assembles pm2 here once with npm (network to the npm registry needed the first time); afterwards the cached archive is used.',
        }
      );
    }
    const got = readJson(
      path.join(stage, 'node_modules', 'pm2', 'package.json')
    ).version;
    if (got !== pin)
      throw new McprocError(
        'BUNDLE_INVALID',
        `npm installed pm2 ${got}, expected ${pin}`
      );
    fs.rmSync(path.join(stage, 'node_modules', '.package-lock.json'), {
      force: true,
    });
    const tgz = execFileSync(
      'tar',
      [...tarFlags(), '-czf', '-', 'node_modules'],
      { cwd: stage, maxBuffer: 1 << 30 }
    );
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(`${target}.part`, tgz);
    fs.renameSync(`${target}.part`, target);
    const meta = {
      pm2: pin,
      sha256: sha256(tgz),
      bytes: tgz.length,
      lock_sha256: lockSha,
      built_at: new Date().toISOString(),
    };
    fs.writeFileSync(sidecar, `${JSON.stringify(meta, null, 2)}\n`);
    return { version: pin, sha256: meta.sha256, data: tgz, path: target };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

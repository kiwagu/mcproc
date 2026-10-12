import { McprocError } from '../core/errors.js';
import { shq } from '../transport/quote.js';
import type { NodePlatform } from './platform.js';

export const COPY_HEADER = '# copied by mcproc unpack';

export interface RuntimeLock {
  mcproc: string;
  pm2: string;
  pm2_sha256: string;
  node: string | null;
  node_sha256: string | null;
  platform: NodePlatform | null;
  written_at: string;
  by: string;
}

function assertVersion(v: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(v))
    throw new McprocError(
      'BUNDLE_INVALID',
      `bad pm2 version in the runtime bundle: "${v}"`
    );
}

/** POSIX sh wrapper: bundled node when present, else the node on PATH; arguments and PM2_HOME pass through. */
export function renderWrapper(runtimeDir: string, pm2Version: string): string {
  assertVersion(pm2Version);
  return [
    '#!/bin/sh',
    `${WRAPPER_MARK}: runs the unpacked pm2 with the bundled node when present, else the node on PATH`,
    `RT=${shq(runtimeDir)}`,
    'if [ -x "$RT/bin/node" ]; then NODE="$RT/bin/node"; else NODE=node; fi',
    `exec "$NODE" "$RT/pm2/${pm2Version}/node_modules/pm2/bin/pm2" "$@"`,
    '',
  ].join('\n');
}

/** The marker line of the wrapper: a bin/pm2 carrying it is mcproc's even before its lock is written. */
export const WRAPPER_MARK = '# written by mcproc unpack';

/**
 * The new runtime before anything in use is switched to it: its pm2 tree (`pm2Tree`, a staged copy, else the version's
 * place) answers with the Node it will run under — a new build (`nodeBin`), else the one in use, else the host's. Like
 * verifyScript, it never starts a daemon.
 */
export function stagedVerifyScript(
  runtimeDir: string,
  pm2Version: string,
  staged: { pm2Tree?: string; nodeBin?: string | null } = {}
): string {
  assertVersion(pm2Version);
  const pkg = staged.pm2Tree
    ? `${shq(staged.pm2Tree)}/node_modules/pm2/package.json`
    : `"$RT/pm2/${pm2Version}/node_modules/pm2/package.json"`;
  return [
    `RT=${shq(runtimeDir)}`,
    staged.nodeBin
      ? `NODE=${shq(staged.nodeBin)}`
      : 'if [ -x "$RT/bin/node" ]; then NODE="$RT/bin/node"; else NODE=node; fi',
    `"$NODE" -p 'require(process.argv[1]).version' ${pkg}`,
  ].join('; ');
}

/** Prints the unpacked pm2 version with the node the wrapper would use. Unlike `pm2 -v`, it never starts a daemon. */
export function verifyScript(runtimeDir: string, pm2Version: string): string {
  assertVersion(pm2Version);
  return [
    `RT=${shq(runtimeDir)}`,
    '[ -x "$RT/bin/pm2" ] || { echo "missing $RT/bin/pm2" >&2; exit 1; }',
    'if [ -x "$RT/bin/node" ]; then NODE="$RT/bin/node"; else NODE=node; fi',
    `"$NODE" -p 'require(process.argv[1]).version' "$RT/pm2/${pm2Version}/node_modules/pm2/package.json"`,
  ].join('; ');
}

export function renderLock(lock: RuntimeLock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

export function manifestCopy(original: string, from: string, at: Date): string {
  return `${COPY_HEADER} from ${from} on ${at.toISOString()}; edit the original there, the next unpack replaces this copy\n${original}`;
}

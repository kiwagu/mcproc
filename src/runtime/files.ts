import { McprocError } from '../core/errors.js';
import { shq } from '../transport/quote.js';
import type { NodePlatform } from './platform.js';

export const COPY_HEADER = '# copied by mcproc unpack';

export interface RuntimeLock {
  mcproc: string; pm2: string; pm2_sha256: string;
  node: string | null; node_sha256: string | null; platform: NodePlatform | null;
  written_at: string; by: string;
}

function assertVersion(v: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new McprocError('BUNDLE_INVALID', `bad pm2 version in the runtime bundle: "${v}"`);
}

/** POSIX sh wrapper: bundled node when present, else the node on PATH; arguments and PM2_HOME pass through. */
export function renderWrapper(runtimeDir: string, pm2Version: string): string {
  assertVersion(pm2Version);
  return [
    '#!/bin/sh',
    '# written by mcproc unpack: runs the unpacked pm2 with the bundled node when present, else the node on PATH',
    `RT=${shq(runtimeDir)}`,
    'if [ -x "$RT/bin/node" ]; then NODE="$RT/bin/node"; else NODE=node; fi',
    `exec "$NODE" "$RT/pm2/${pm2Version}/node_modules/pm2/bin/pm2" "$@"`,
    '',
  ].join('\n');
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
  return JSON.stringify(lock, null, 2) + '\n';
}

export function manifestCopy(original: string, from: string, at: Date): string {
  return `${COPY_HEADER} from ${from} on ${at.toISOString()}; edit the original there, the next unpack replaces this copy\n${original}`;
}

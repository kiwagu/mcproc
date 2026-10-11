import { McprocError } from '../core/errors.js';

export type NodePlatform = 'linux-x64' | 'linux-arm64' | 'linux-x64-musl' | 'darwin-x64' | 'darwin-arm64';
export const NODE_DIST_BASE = 'https://nodejs.org/dist';

/** `uname -sm` plus the musl probe → a platform nodejs.org publishes a tarball for, or null. */
export function parsePlatform(unameSm: string, musl: boolean): NodePlatform | null {
  const [sys, machine] = unameSm.trim().split(/\s+/);
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : null;
  if (!arch) return null;
  if (sys === 'Linux') {
    if (musl) return arch === 'x64' ? 'linux-x64-musl' : null; // nodejs.org publishes musl builds for x64 only
    return arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  }
  if (sys === 'Darwin') return arch === 'x64' ? 'darwin-x64' : 'darwin-arm64';
  return null;
}

export function nodeDistFile(version: string, platform: NodePlatform): string {
  return `node-${version}-${platform}.tar.gz`;
}

export function nodeDistUrl(version: string, file: string): string {
  return `${NODE_DIST_BASE}/${version}/${file}`;
}

export function parseShasums(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const r = /^([0-9a-f]+)\s+\*?(\S+)$/i.exec(line.trim());
    if (r) m.set(r[2], r[1].toLowerCase());
  }
  return m;
}

export function normalizeVersion(v: string): string {
  const s = v.trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(s)) throw new McprocError('BAD_ARGUMENT', `not a Node version: "${v}"`, { hint: 'Use an exact version such as 24.21.0.' });
  return s.startsWith('v') ? s : `v${s}`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

import { McprocError } from '../core/errors.js';
import { nodeMajor } from '../core/pm2.js';
import { parsePlatform, type NodePlatform } from './platform.js';
import type { HostFacts } from './probe.js';

export type WithNode = 'auto' | 'always' | 'never';
export interface UnpackOptions { dir?: string; withNode?: WithNode; nodeVersion?: string; force?: boolean }

export function needsNode(f: HostFacts, o: UnpackOptions): { need: boolean; platform: NodePlatform | null } {
  const mode = o.withNode ?? 'auto';
  const hostOk = nodeMajor(f.node) >= 18;
  if (mode === 'never' || (mode === 'auto' && hostOk)) {
    if (!hostOk) {
      throw new McprocError('NODE_NOT_FOUND', `the host has ${f.node ? `Node ${f.node}` : 'no Node'} in its login shell and with_node is never; pm2 needs Node 18 or newer`, { hint: 'Use with_node: auto (or always) to bring an official Node build along.' });
    }
    return { need: false, platform: null };
  }
  const platform = parsePlatform(f.unameSm, f.musl);
  if (!platform) {
    throw new McprocError('NODE_NOT_FOUND', `nodejs.org publishes no Node build for "${f.unameSm}"${f.musl ? ' with musl' : ''}`, { hint: 'Install Node 18 or newer on that host and run unpack with with_node: never.' });
  }
  // the official Linux builds are dynamically linked against libstdc++ and libgcc; without them the binary cannot even start (darwin builds use the system libc++)
  if (platform.startsWith('linux-') && !f.cxx) {
    throw new McprocError('NODE_NOT_FOUND', `the host has no libstdc++, which the official Node build for ${platform} is linked against`, { hint: f.musl ? 'On the host: apk add libstdc++ (then run unpack again), or install Node >= 18 there and use with_node: never.' : 'On the host: install libstdc++6 (apt) / libstdc++ (dnf, apk), or install Node >= 18 there and use with_node: never.' });
  }
  return { need: true, platform };
}

export function plannedWrites(f: HostFacts, o: UnpackOptions, pm2Version: string, nodeVersion: string | null): { writePm2: boolean; writeNode: boolean } {
  const force = o.force === true;
  return {
    writePm2: force || f.lock?.pm2 !== pm2Version,
    writeNode: nodeVersion !== null && (force || f.lock?.node !== nodeVersion),
  };
}

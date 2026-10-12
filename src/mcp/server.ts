import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VERSION } from '../version.js';
import type { Spawner } from '../transport/types.js';
import type { UnpackDeps } from '../runtime/unpack.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

export const INSTRUCTIONS = [
  'mcproc drives pm2 for the current project from its .mcproc/mcproc.yaml manifest (apps with descriptions, declared ports, profiles, hosts).',
  'Loop: (1) no manifest → call init, then fill in a description per app in .mcproc/mcproc.yaml and verify with start + ls (ports) + logs.',
  '(2) manifest present → call describe first, then act by app or profile name: start, restart, stop, logs. ls answers "is it up and on which port"; ports answers "who holds port N".',
  'On long work with running apps, call incidents now and then (your client\'s loop or cron if it has one): it returns only new errors with context, each once, and is nearly free when nothing happened.',
  'Apps with `host:` in the manifest always run on that host; without a host argument every app is reached where it runs (others on local), with one only the apps that run there. Readonly hosts refuse changes. doctor explains why a host cannot be driven; unpack brings pm2 (and Node when missing) to a host that has none.',
  'Never compose pm2 or shell commands by hand for apps the manifest knows.',
].join(' ');

export function createServer(deps: { spawner?: Spawner; unpack?: UnpackDeps } = {}): McpServer {
  const server = new McpServer({ name: 'mcproc', version: VERSION }, { instructions: INSTRUCTIONS });
  const roots = async (): Promise<string[]> => {
    try {
      if (!server.server.getClientCapabilities()?.roots) return [];
      const r = await server.server.listRoots();
      return r.roots.map((x) => (x.uri.startsWith('file://') ? fileURLToPath(x.uri) : x.uri));
    } catch { return []; }
  };
  registerReadTools(server, { roots, spawner: deps.spawner, unpack: deps.unpack });
  registerWriteTools(server, { roots, spawner: deps.spawner, unpack: deps.unpack });
  return server;
}

export async function serveStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

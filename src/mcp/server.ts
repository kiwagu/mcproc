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
  'Loop: (1) no manifest → call init, then fill in a description per app in .mcproc/mcproc.yaml and verify with start + ls (ports) + logs; a port ls reports as undeclared is adopted into the manifest with init adopt_ports.',
  '(2) manifest present → call describe first, then act by app or profile name: start, restart, stop, logs. ls answers "is it up and on which port"; ports answers "who holds port N".',
  "On long work with running apps, call incidents now and then (your client's loop or cron if it has one): it returns only new errors with context, each once, and is nearly free when nothing happened.",
  'After start, call wait (until listening, url-ok, exited, log:<regex> or idle:<seconds>) instead of sleeping or polling ls; a start whose manifest declares depends_on conditions waits by itself.',
  'After a change, read logs with since over the profile (since: "2m", or "last" for everything since your previous logs call) instead of tailing each app.',
  'Apps with `host:` in the manifest always run on that host; without a host argument every app is reached where it runs (others on local), with one only the apps that run there. Readonly hosts refuse changes. doctor explains why a host cannot be driven; unpack brings pm2 (and Node when missing) to a host that has none.',
  'Never compose pm2 or shell commands by hand for apps the manifest knows.',
].join(' ');

export function createServer(
  deps: { spawner?: Spawner; unpack?: UnpackDeps; project?: string } = {}
): McpServer {
  const server = new McpServer(
    { name: 'mcproc', version: VERSION },
    { instructions: INSTRUCTIONS }
  );
  const roots = async (): Promise<string[]> => {
    try {
      if (!server.server.getClientCapabilities()?.roots) return [];
      const r = await server.server.listRoots();
      return r.roots.map((x) =>
        x.uri.startsWith('file://') ? fileURLToPath(x.uri) : x.uri
      );
    } catch {
      return [];
    }
  };
  registerReadTools(server, {
    roots,
    spawner: deps.spawner,
    unpack: deps.unpack,
    project: deps.project,
  });
  registerWriteTools(server, {
    roots,
    spawner: deps.spawner,
    unpack: deps.unpack,
    project: deps.project,
  });
  return server;
}

/** `project`: what `mcp --project` named; tool calls without a project of their own use it. */
export async function serveStdio(project?: string): Promise<void> {
  const server = createServer({ project });
  await server.connect(new StdioServerTransport());
}

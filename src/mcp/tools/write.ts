import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, MUT, runTool, type ToolDeps } from '../common.js';
import { prepare, assertWritable, resolveProjectDir } from '../../core/resolve.js';
import { Fleet, defaultConnector, actOn, assertWritableRuns, type Act } from '../../core/fleet.js';
import { flushLogs } from '../../core/logs.js';
import { initProject } from '../../core/init.js';
import type { LsRow } from '../../core/list.js';
import { createTransport } from '../../transport/index.js';
import { unpack, defaultUnpackDeps } from '../../runtime/unpack.js';
import { renderLs, renderUnpack, startNote, hostsOf } from '../render.js';

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  // apps run at their own host (`host:` in the manifest); host narrows a call to the apps that run there. Targets and
  // readonly hosts are checked before any host is contacted.
  const fleetOf = async (args: { project?: string; host?: string }) => new Fleet(prepare({ project: args.project, roots: await deps.roots() }).manifest, args.host, defaultConnector(deps.spawner));
  const targetInput = { ...commonInput, target: z.string().describe('App name, profile name, or "all"') };
  const act = async (args: { project?: string; host?: string; target: string; reload?: boolean }, what: Act) => {
    const fleet = await fleetOf(args);
    const rows: LsRow[] = await actOn(fleet, args.target, what, { reload: args.reload });
    const n = what === 'start' || what === 'restart' ? startNote(rows) : '';
    return { text: renderLs(rows, fleet.fallback) + (n ? `\n${n}` : ''), data: { ...hostsOf(rows, fleet.fallback), rows } as Record<string, unknown> };
  };

  server.registerTool('init', {
    title: 'Init manifest draft', description: 'Create .mcproc/ (gitignored) with a manifest DRAFT discovered from package.json scripts, workspaces, nx project.json, turbo.json, ecosystem.json and Procfile. Candidates are commented out: uncomment, write descriptions, then verify with start + ls. Refuses to overwrite an existing manifest without force.',
    inputSchema: { project: commonInput.project, force: z.boolean().optional() }, annotations: MUT(false, true),
  }, (args) => runTool(async () => {
    const root = resolveProjectDir(args.project, await deps.roots());
    const r = initProject(root, { force: args.force });
    const src = Object.entries(r.by_source).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
    return { text: `Created ${r.path} with ${r.candidates} candidate(s) (${src}).\n${r.next}`, data: r as unknown as Record<string, unknown> };
  }));

  server.registerTool('start', {
    title: 'Start', description: 'Start an app or profile via pm2 from the generated ecosystem, each app on the host it runs on, dependencies first. Apps already online are left alone unless reload is true.',
    inputSchema: { ...targetInput, reload: z.boolean().optional() }, annotations: MUT(false, true),
  }, (args) => runTool(async () => {
    return act(args, 'start');
  }));

  server.registerTool('restart', {
    title: 'Restart', description: 'Restart the named app(s) with the current manifest config (command, env, watch).',
    inputSchema: targetInput, annotations: MUT(false, false),
  }, (args) => runTool(async () => {
    return act(args, 'restart');
  }));

  server.registerTool('stop', {
    title: 'Stop', description: 'Stop the named app(s); pm2 keeps them listed as stopped.',
    inputSchema: targetInput, annotations: MUT(true, true),
  }, (args) => runTool(async () => {
    return act(args, 'stop');
  }));

  server.registerTool('delete', {
    title: 'Delete', description: 'Remove the named app(s) from pm2 (stops them first).',
    inputSchema: targetInput, annotations: MUT(true, true),
  }, (args) => runTool(async () => {
    return act(args, 'delete');
  }));

  server.registerTool('flush', {
    title: 'Flush logs', description: 'Truncate the pm2 log files of one app, or of every app of the project (each on the host it runs on; with host, the apps that run there).',
    inputSchema: { ...commonInput, app: z.string().optional() }, annotations: MUT(true, true),
  }, (args) => runTool(async () => {
    const fleet = await fleetOf(args);
    const groups = fleet.groups(fleet.select(args.app ? [args.app] : ['all']));
    assertWritableRuns(fleet, groups);
    const r = [];
    for (const g of groups) r.push(...(await flushLogs(await fleet.ctx(g.host), g.apps)).map((x) => ({ ...x, host: g.host })));
    const multi = groups.length > 1;
    return { text: r.length ? r.map((x) => `${x.app}${multi ? ` (${x.host})` : ''}: freed ${x.out_bytes + x.err_bytes} bytes`).join('\n') : 'nothing to flush (no pm2 processes for this project there)', data: { hosts: groups.map((g) => g.host), flushed: r } };
  }));

  server.registerTool('unpack', {
    title: 'Unpack runtime',
    description: 'Make a host self-sufficient: copy a pm2 tree (assembled once on this machine with npm from the lockfile mcproc ships; needs npm, tar and registry access the first time) and an official Node build when the host has no Node >= 18 (downloaded once from nodejs.org, checked against SHASUMS256), into <cwd>/.mcproc/runtime on that host or into dir, plus a copy of the manifest. Idempotent: same versions change nothing. Refused on readonly hosts and on a dir whose bin/ it did not write.',
    inputSchema: {
      ...commonInput,
      dir: z.string().optional().describe('Absolute runtime directory on the host; default <host cwd>/.mcproc/runtime'),
      with_node: z.enum(['auto', 'always', 'never']).optional().describe('auto (default): bring Node only when the host has none >= 18'),
      node_version: z.string().optional().describe('Exact Node version; default: the newest LTS'),
      force: z.boolean().optional().describe('Rewrite even when versions match, and overwrite a hand-written manifest on the host'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => runTool(async () => {
    const p = prepare({ project: args.project, host: args.host, roots: await deps.roots() });
    assertWritable(p.host);
    const r = await unpack(
      { manifest: p.manifest, host: p.host, transport: createTransport(p.host, deps.spawner) },
      { dir: args.dir, withNode: args.with_node, nodeVersion: args.node_version, force: args.force },
      deps.unpack ?? defaultUnpackDeps(),
    );
    return { text: renderUnpack(r), data: r as unknown as Record<string, unknown> };
  }));
}

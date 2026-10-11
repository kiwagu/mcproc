import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, MUT, runTool, type ToolDeps } from '../common.js';
import { prepare, connect, assertWritable, assertApp, resolveProjectDir, type Context } from '../../core/resolve.js';
import { resolveTargets, startApps, restartApps, stopApps, deleteApps } from '../../core/actions.js';
import { flushLogs } from '../../core/logs.js';
import { initProject } from '../../core/init.js';
import type { LsRow } from '../../core/list.js';
import { createTransport } from '../../transport/index.js';
import { unpack, defaultUnpackDeps } from '../../runtime/unpack.js';
import { renderLs, renderUnpack, startNote } from '../render.js';

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  const guarded = async (args: { project?: string; host?: string }, check: (p: ReturnType<typeof prepare>) => void): Promise<Context> => {
    const p = prepare({ project: args.project, host: args.host, roots: await deps.roots() });
    check(p);
    assertWritable(p.host);
    return connect(p, { spawner: deps.spawner });
  };
  const targetInput = { ...commonInput, target: z.string().describe('App name, profile name, or "all"') };
  const done = (ctx: Context, rows: LsRow[], note = false) => {
    const n = note ? startNote(rows) : '';
    return { text: renderLs(rows, ctx.host.name) + (n ? `\n${n}` : ''), data: { host: ctx.host.name, rows } as Record<string, unknown> };
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
    title: 'Start', description: 'Start an app or profile via pm2 from the generated ecosystem, dependencies first. Apps already online are left alone unless reload is true.',
    inputSchema: { ...targetInput, reload: z.boolean().optional() }, annotations: MUT(false, true),
  }, (args) => runTool(async () => {
    const ctx = await guarded(args, (p) => resolveTargets(p.manifest, args.target));
    return done(ctx, await startApps(ctx, args.target, { reload: args.reload }), true);
  }));

  server.registerTool('restart', {
    title: 'Restart', description: 'Restart the named app(s) with the current manifest config (command, env, watch).',
    inputSchema: targetInput, annotations: MUT(false, false),
  }, (args) => runTool(async () => {
    const ctx = await guarded(args, (p) => resolveTargets(p.manifest, args.target));
    return done(ctx, await restartApps(ctx, args.target), true);
  }));

  server.registerTool('stop', {
    title: 'Stop', description: 'Stop the named app(s); pm2 keeps them listed as stopped.',
    inputSchema: targetInput, annotations: MUT(true, true),
  }, (args) => runTool(async () => {
    const ctx = await guarded(args, (p) => resolveTargets(p.manifest, args.target));
    return done(ctx, await stopApps(ctx, args.target));
  }));

  server.registerTool('delete', {
    title: 'Delete', description: 'Remove the named app(s) from pm2 (stops them first).',
    inputSchema: targetInput, annotations: MUT(true, true),
  }, (args) => runTool(async () => {
    const ctx = await guarded(args, (p) => resolveTargets(p.manifest, args.target));
    return done(ctx, await deleteApps(ctx, args.target));
  }));

  server.registerTool('flush', {
    title: 'Flush logs', description: 'Truncate the pm2 log files of one app, or of every app of the project on that host.',
    inputSchema: { ...commonInput, app: z.string().optional() }, annotations: MUT(true, true),
  }, (args) => runTool(async () => {
    const ctx = await guarded(args, (p) => { if (args.app) assertApp(p.manifest, args.app); });
    const r = await flushLogs(ctx, args.app);
    return { text: r.length ? r.map((x) => `${x.app}: freed ${x.out_bytes + x.err_bytes} bytes`).join('\n') : 'nothing to flush (no pm2 processes for this project here)', data: { host: ctx.host.name, flushed: r } };
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

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, MUT, runTool, type ToolDeps } from '../common.js';
import { prepare, connect, assertWritable, assertApp, resolveProjectDir, type Context } from '../../core/resolve.js';
import { resolveTargets, startApps, restartApps, stopApps, deleteApps } from '../../core/actions.js';
import { flushLogs } from '../../core/logs.js';
import { initProject } from '../../core/init.js';
import type { LsRow } from '../../core/list.js';
import { renderLs, startNote } from '../render.js';

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
}

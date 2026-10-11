import { Command } from 'commander';
import { VERSION } from '../version.js';
import { isMcprocError } from '../core/errors.js';
import { prepare, connect, assertApp, assertWritable, resolveProjectDir, type Context } from '../core/resolve.js';
import { listApps, portsReport, hostsInfo, describeApp, describeProject } from '../core/list.js';
import { readLogs, flushLogs } from '../core/logs.js';
import { doctor } from '../core/doctor.js';
import { initProject } from '../core/init.js';
import { resolveTargets, startApps, restartApps, stopApps, deleteApps } from '../core/actions.js';
import { renderLs, renderPorts, renderHosts, renderDoctor, renderLogs, renderProject, startNote } from '../mcp/render.js';
import { serveStdio } from '../mcp/server.js';
import { monitOnce } from '../monit/once.js';
import { runMonit } from '../monit/tui.js';

export interface Io { out: (s: string) => void; err: (s: string) => void }
type Globals = { project?: string; host?: string; json?: boolean };
type Opts = Record<string, string | boolean | undefined>;

const defaultIo: Io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };

export function buildProgram(io: Io = defaultIo): Command {
  const program = new Command()
    .name('mcproc')
    .description('pm2 process control for agents: one manifest per project, local and remote hosts, per-app ports')
    .version(VERSION)
    .option('--project <dir>', 'project root (default: MCPROC_PROJECT, CLAUDE_PROJECT_DIR, cwd)')
    .option('--host <name>', 'host from the manifest (default: local)')
    .option('--json', 'print JSON instead of text');

  const emit = (g: Globals, text: string, data: unknown) => io.out(g.json ? JSON.stringify(data, null, 2) : text);
  const wrap = (fn: (g: Globals, opts: Opts, args: string[]) => Promise<void>) =>
    async (...all: unknown[]) => {
      const cmd = all[all.length - 1] as Command;
      const opts = (all[all.length - 2] ?? {}) as Opts;
      const args = all.slice(0, -2) as string[];
      const g = cmd.optsWithGlobals() as Globals;
      try { await fn(g, opts, args); } catch (e) {
        if (!isMcprocError(e)) throw e;
        io.err(g.json ? JSON.stringify(e.toJSON()) : `${e.code}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}`);
        process.exitCode = 1;
      }
    };
  const ctxOf = (g: Globals) => connect(prepare({ project: g.project, host: g.host }));
  const mutate = async (g: Globals, target: string, act: (ctx: Context) => Promise<Parameters<typeof renderLs>[0]>, note = false) => {
    const p = prepare({ project: g.project, host: g.host });
    resolveTargets(p.manifest, target);
    assertWritable(p.host);
    const ctx = await connect(p);
    const rows = await act(ctx);
    const n = note ? startNote(rows) : '';
    emit(g, renderLs(rows, ctx.host.name) + (n ? `\n${n}` : ''), { host: ctx.host.name, rows });
  };

  program.command('init').description('create .mcproc/ with a manifest draft discovered from the project').option('--force', 'overwrite an existing manifest')
    .action(wrap(async (g, o) => { const r = initProject(resolveProjectDir(g.project), { force: Boolean(o.force) }); emit(g, `Created ${r.path} (${r.candidates} candidates)\n${r.next}`, r); }));
  program.command('hosts').description('hosts declared in the manifest')
    .action(wrap(async (g) => { const { manifest } = prepare({ project: g.project }); const h = hostsInfo(manifest); emit(g, renderHosts(h), h); }));
  program.command('doctor').description('check hosts: reachability, node, pm2, tools, daemon')
    .action(wrap(async (g) => { const { manifest } = prepare({ project: g.project }); const r = await doctor(manifest, g.host); emit(g, renderDoctor(r), r); }));
  program.command('ls [app]').description('apps with status, pid and real vs declared ports')
    .action(wrap(async (g, _o, [app]) => { const p = prepare({ project: g.project, host: g.host }); if (app) assertApp(p.manifest, app); const ctx = await connect(p); const rows = await listApps(ctx, app); emit(g, renderLs(rows, ctx.host.name), rows); }));
  program.command('describe [app]').description('project summary, or one app in detail')
    .action(wrap(async (g, _o, [app]) => {
      const p = prepare({ project: g.project, host: g.host });
      if (!app) { const d = describeProject(p.manifest); emit(g, renderProject(d), d); return; }
      assertApp(p.manifest, app);
      const ctx = await connect(p);
      const d = await describeApp(ctx, app);
      emit(g, `${d.app.name} [${d.app.kind}]: ${d.app.description}\nrun: ${d.app.run}\ncwd: ${d.app.cwd}\n${renderLs([d.row], ctx.host.name)}\nlogs: ${d.logs ? `${d.logs.out} | ${d.logs.err}` : 'not started yet'}`, d);
    }));
  program.command('logs <app>').description('tail pm2 logs of an app').option('-n, --lines <n>', 'lines (default 100, max 2000)').option('--out', 'stdout only').option('--err', 'stderr only')
    .action(wrap(async (g, o, [app]) => {
      const p = prepare({ project: g.project, host: g.host }); assertApp(p.manifest, app);
      const ctx = await connect(p);
      const r = await readLogs(ctx, app, { lines: o.lines ? Number(o.lines) : undefined, stream: o.out ? 'out' : o.err ? 'err' : 'both' });
      emit(g, renderLogs(r), r);
    }));
  program.command('ports [port]').description('who listens on which port on the host')
    .action(wrap(async (g, _o, [port]) => { const ctx = await ctxOf(g); const r = await portsReport(ctx, port ? Number(port) : undefined); emit(g, renderPorts(r, ctx.host.name), r); }));
  program.command('start <target>').description('start an app or profile (dependencies first)').option('--reload', 'restart apps that are already online')
    .action(wrap((g, o, [t]) => mutate(g, t, (ctx) => startApps(ctx, t, { reload: Boolean(o.reload) }), true)));
  program.command('restart <target>').description('restart app(s) with the current manifest config')
    .action(wrap((g, _o, [t]) => mutate(g, t, (ctx) => restartApps(ctx, t), true)));
  program.command('stop <target>').description('stop app(s)')
    .action(wrap((g, _o, [t]) => mutate(g, t, (ctx) => stopApps(ctx, t))));
  program.command('delete <target>').description('remove app(s) from pm2')
    .action(wrap((g, _o, [t]) => mutate(g, t, (ctx) => deleteApps(ctx, t))));
  program.command('flush [app]').description('truncate pm2 log files')
    .action(wrap(async (g, _o, [app]) => {
      const p = prepare({ project: g.project, host: g.host }); if (app) assertApp(p.manifest, app); assertWritable(p.host);
      const ctx = await connect(p); const r = await flushLogs(ctx, app);
      emit(g, r.length ? r.map((x) => `${x.app}: freed ${x.out_bytes + x.err_bytes} bytes`).join('\n') : 'nothing to flush', r);
    }));
  program.command('monit').description('terminal dashboard: apps with real memory/cpu/ports, log tail, details (--once prints one frame)')
    .option('--once', 'print one frame as text and exit')
    .option('--interval <ms>', 'refresh interval', '2000')
    .option('--lines <n>', 'log lines of history', '200')
    .action(wrap(async (g, o) => {
      if (o.once) { io.out(await monitOnce({ project: g.project, host: g.host, lines: Number(o.lines) || 200 })); return; }
      await runMonit({ project: g.project, host: g.host, intervalMs: Math.max(500, Number(o.interval) || 2000), lines: Number(o.lines) || 200 });
    }));
  program.command('mcp').description('run the MCP server on stdio (register this command in your agent client)')
    .action(wrap(async () => { await serveStdio(); }));
  return program;
}

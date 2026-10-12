import { Command } from 'commander';
import { VERSION } from '../version.js';
import { McprocError, isMcprocError } from '../core/errors.js';
import { createTransport } from '../transport/index.js';
import { unpack, defaultUnpackDeps } from '../runtime/unpack.js';
import type { WithNode } from '../runtime/decide.js';
import { prepare, connect, assertApp, assertWritable, resolveProjectDir, type Context } from '../core/resolve.js';
import { listApps, portsReport, hostsInfo, describeApp, describeProject } from '../core/list.js';
import { flushLogs } from '../core/logs.js';
import { streamLogs, defaultStreamDeps } from '../core/logstream.js';
import { doctor } from '../core/doctor.js';
import { initProject } from '../core/init.js';
import { resolveTargets, startApps, restartApps, stopApps, deleteApps } from '../core/actions.js';
import { renderLs, renderPorts, renderHosts, renderDoctor, renderProject, renderUnpack, startNote } from '../mcp/render.js';
import { serveStdio } from '../mcp/server.js';
import { monitOnce } from '../monit/once.js';
import { installShortcut } from './install.js';
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
  program.command('logs [targets...]').description('logs of apps or profiles (default: all apps), one labeled line per entry like docker compose; -f keeps streaming')
    .option('-f, --follow', 'keep streaming until Ctrl-C')
    .option('-n, --lines <n>', 'history lines per app (default 100, max 2000)')
    .option('--out', 'stdout only').option('--err', 'stderr only')
    .option('--interval <ms>', 'poll interval while following', '1000')
    .option('--no-color', 'plain labels (also when NO_COLOR is set or stdout is not a terminal)')
    .action(wrap(async (g, o, args) => {
      const targets = ((args[0] as unknown as string[] | undefined) ?? []);
      const p = prepare({ project: g.project, host: g.host });
      const apps = [...new Set((targets.length ? targets : ['all']).flatMap((t) => resolveTargets(p.manifest, t)))];
      const ctx = await connect(p);
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once('SIGINT', stop);
      // a reader that closes early (`| head`) raises EPIPE asynchronously on stdout, possibly after the stream already returned:
      // the listener stays for the rest of the process, ends the stream and swallows the error instead of a crash
      process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') ac.abort(); else throw e; });
      try {
        await streamLogs(ctx, apps, {
          lines: Math.min(Math.max(1, Number(o.lines) || 100), 2000), follow: Boolean(o.follow), intervalMs: Math.max(200, Number(o.interval) || 1000),
          color: o.color !== false && !process.env.NO_COLOR && Boolean(process.stdout.isTTY), json: Boolean(g.json),
          stream: o.out ? 'out' : o.err ? 'err' : 'both', signal: ac.signal,
        }, defaultStreamDeps());
      } finally { process.off('SIGINT', stop); }
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
  program.command('unpack').description('bring pm2 (assembled with npm from the lockfile mcproc ships) and Node when missing to the host, into <cwd>/.mcproc/runtime or --dir')
    .option('--dir <path>', 'absolute runtime directory on the host')
    .option('--with-node <mode>', 'auto | always | never', 'auto')
    .option('--node-version <version>', 'exact Node version (default: newest LTS)')
    .option('--force', 'rewrite even when versions match; overwrite a hand-written manifest on the host')
    .action(wrap(async (g, o) => {
      const p = prepare({ project: g.project, host: g.host });
      assertWritable(p.host);
      const mode = String(o.withNode ?? 'auto');
      if (!['auto', 'always', 'never'].includes(mode)) throw new McprocError('BAD_ARGUMENT', `--with-node must be auto, always or never, got "${mode}"`);
      const r = await unpack(
        { manifest: p.manifest, host: p.host, transport: createTransport(p.host) },
        { dir: o.dir as string | undefined, withNode: mode as WithNode, nodeVersion: o.nodeVersion as string | undefined, force: Boolean(o.force) },
        defaultUnpackDeps(),
      );
      emit(g, renderUnpack(r), r);
    }));
  program.command('install').description('put a `mcproc` shortcut on your shell PATH for this checkout (a launcher in ~/.local/bin), or remove it')
    .option('--bin-dir <dir>', 'where the launcher goes (default ~/.local/bin)')
    .option('--uninstall', 'remove the launcher written by a previous install')
    .action(wrap(async (g, o) => {
      const r = installShortcut({ binDir: o.binDir as string | undefined, uninstall: Boolean(o.uninstall) });
      const lines = r.removed ? [`removed ${r.launcher}`]
        : r.written ? [`wrote ${r.launcher} → node ${r.cli}`, r.rcUpdated ? `added a PATH line for ${r.binDir} to ${r.rcFile}` : r.onPath ? `${r.binDir} is already on PATH` : `${r.rcFile} already has the PATH line`]
        : [];
      emit(g, [...lines, ...r.next.map((n) => `→ ${n}`)].join('\n'), r);
    }));
  program.command('mcp').description('run the MCP server on stdio (register this command in your agent client)')
    .action(wrap(async () => { await serveStdio(); }));
  return program;
}

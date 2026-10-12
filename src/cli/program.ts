import { Command } from 'commander';
import { VERSION } from '../version.js';
import { McprocError, isMcprocError } from '../core/errors.js';
import { createTransport } from '../transport/index.js';
import { unpack, defaultUnpackDeps } from '../runtime/unpack.js';
import type { WithNode } from '../runtime/decide.js';
import { prepare, connect, assertWritable, resolveProjectDir } from '../core/resolve.js';
import { portsReport, hostsInfo, describeProject } from '../core/list.js';
import { takeIncidents, clearLogs } from '../core/incidents/store.js';
import type { CursorState } from '../core/incidents/cursor.js';
import { streamLogs, defaultStreamDeps, resolveColor, type LogSource } from '../core/logstream.js';
import { doctor } from '../core/doctor.js';
import { initProject } from '../core/init.js';
import { Fleet, actOn, listFleet, describeFleetApp, type Act } from '../core/fleet.js';
import { renderLs, renderPorts, renderHosts, renderDoctor, renderProject, renderUnpack, renderIncidents, renderFlushed, startNote, hostsOf } from '../mcp/render.js';
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
  // apps run at their own host (`host:` in the manifest); --host narrows a command to the apps that run there
  const fleetOf = (g: Globals) => new Fleet(prepare({ project: g.project }).manifest, g.host);
  const mutate = async (g: Globals, target: string, act: Act, opts: { reload?: boolean } = {}) => {
    const fleet = fleetOf(g);
    const rows = await actOn(fleet, target, act, opts);
    const n = act === 'start' || act === 'restart' ? startNote(rows) : '';
    emit(g, renderLs(rows, fleet.fallback) + (n ? `\n${n}` : ''), { ...hostsOf(rows, fleet.fallback), rows });
    if (rows.some((r) => r.error)) process.exitCode = 1; // a host failed or was skipped: its rows say so, the exit code too
  };

  program.command('init').description('create .mcproc/ with a manifest draft discovered from the project').option('--force', 'overwrite an existing manifest')
    .action(wrap(async (g, o) => { const r = initProject(resolveProjectDir(g.project), { force: Boolean(o.force) }); emit(g, `Created ${r.path} (${r.candidates} candidates)\n${r.next}`, r); }));
  program.command('hosts').description('hosts declared in the manifest')
    .action(wrap(async (g) => { const { manifest } = prepare({ project: g.project }); const h = hostsInfo(manifest); emit(g, renderHosts(h), h); }));
  program.command('doctor').description('check hosts: reachability, node, pm2, tools, daemon')
    .action(wrap(async (g) => { const { manifest } = prepare({ project: g.project }); const r = await doctor(manifest, g.host); emit(g, renderDoctor(r), r); }));
  program.command('ls [app]').description('apps with status, pid and real vs declared ports, each from the host it runs on')
    .action(wrap(async (g, _o, [app]) => {
      const fleet = fleetOf(g);
      const { rows, errors } = await listFleet(fleet, fleet.select(app ? [app] : ['all']));
      emit(g, renderLs(rows, fleet.fallback), rows);
      if (errors.length) process.exitCode = 1; // the rows of the hosts that answered are printed; the exit code still says one did not
    }));
  program.command('describe [app]').description('project summary, or one app in detail')
    .action(wrap(async (g, _o, [app]) => {
      const fleet = fleetOf(g);
      if (!app) { const d = describeProject(fleet.manifest); emit(g, renderProject(d), d); return; }
      const d = await describeFleetApp(fleet, app);
      emit(g, `${d.app.name} [${d.app.kind}]: ${d.app.description}\nrun: ${d.app.run}\ncwd: ${d.app.cwd}\n${renderLs([d.row], d.host)}\nlogs: ${d.logs ? `${d.logs.out} | ${d.logs.err}` : 'not started yet'}`, d);
    }));
  program.command('logs [targets...]').description('logs of apps or profiles (default: all apps), one labeled line per entry like docker compose; -f keeps streaming')
    .option('-f, --follow', 'keep streaming until Ctrl-C')
    .option('-n, --lines <n>', 'history lines per app (default 100, max 2000)')
    .option('--out', 'stdout only').option('--err', 'stderr only')
    .option('--interval <ms>', 'poll interval while following', '1000')
    .option('--color', "colors (labels and the apps' own) even when stdout is not a terminal; also FORCE_COLOR")
    .option('--no-color', 'plain text (also when NO_COLOR is set or stdout is not a terminal)')
    .action(wrap(async (g, o, args) => {
      const targets = ((args[0] as unknown as string[] | undefined) ?? []);
      const fleet = fleetOf(g);
      const apps = fleet.select(targets.length ? targets : ['all']);
      // every host at once; one that cannot be reached becomes a note per app instead of ending the stream, and is
      // connected again later while following (fleet.ctx keeps no failed connection)
      const sources = await Promise.all(fleet.groups(apps).map(async (gr): Promise<LogSource> => {
        const connect = () => fleet.ctx(gr.host);
        try { return { ...gr, connect, ctx: await connect() }; } catch (e) { return { ...gr, connect, error: e }; }
      }));
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once('SIGINT', stop);
      // a reader that closes early (`| head`) raises EPIPE asynchronously on stdout, possibly after the stream already returned:
      // the listener stays for the rest of the process, ends the stream and swallows the error instead of a crash
      process.stdout.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EPIPE') ac.abort(); else throw e; });
      try {
        await streamLogs(sources, {
          lines: Math.min(Math.max(1, Number(o.lines) || 100), 2000), follow: Boolean(o.follow), intervalMs: Math.max(200, Number(o.interval) || 1000),
          color: resolveColor(o.color as boolean | undefined, process.env, Boolean(process.stdout.isTTY)), json: Boolean(g.json),
          stream: o.out ? 'out' : o.err ? 'err' : 'both', signal: ac.signal,
        }, defaultStreamDeps());
      } finally { process.off('SIGINT', stop); }
    }));
  program.command('incidents [targets...]').description('new errors with context since they were last taken, plus crashes and restarts; -f keeps watching')
    .option('--peek', 'look without taking: the pick-up point stays')
    .option('--since <min>', 'first poll: minutes to look back in each log', '15')
    .option('--max <n>', 'most incidents per poll, newest first', '20')
    .option('--context <before,after>', 'lines of context (default per app, 3,5)')
    .option('-f, --follow', 'keep polling and print each new incident')
    .option('--interval <s>', 'seconds between polls while following', '10')
    .option('--color', 'colors even when stdout is not a terminal').option('--no-color', 'plain text')
    .action(wrap(async (g, o, args) => {
      const targets = ((args[0] as unknown as string[] | undefined) ?? []);
      let context: [number, number] | undefined;
      if (o.context !== undefined) {
        const m = /^(\d{1,2}),(\d{1,2})$/.exec(String(o.context));
        if (!m) throw new McprocError('BAD_ARGUMENT', `--context must be before,after (e.g. 3,5), got "${o.context}"`);
        context = [Number(m[1]), Number(m[2])];
      }
      const fleet = fleetOf(g);
      const names = fleet.select(targets.length ? targets : ['all']);
      const color = resolveColor(o.color as boolean | undefined, process.env, Boolean(process.stdout.isTTY));
      const peek = Boolean(o.peek);
      let cursor: CursorState | undefined; // a peeking follower's own position; taking always goes on from the stored point
      const poll = async () => {
        const r = await takeIncidents(fleet, names, { peek, cursor, sinceMin: Number(o.since) || 15, max: Number(o.max) || 20, context });
        if (peek) cursor = r.next;
        return r.answer;
      };
      const first = await poll();
      emit(g, renderIncidents(first, { color }), first);
      if (!o.follow) return;
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once('SIGINT', stop);
      try {
        while (!ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, Math.max(1, Number(o.interval) || 10) * 1000));
          if (ac.signal.aborted) break;
          const a = await poll();
          if (a.incidents.length || a.errors.length) emit(g, renderIncidents(a, { color }), a);
        }
      } finally { process.off('SIGINT', stop); }
    }));
  program.command('ports [port]').description('who listens on which port on the host')
    .action(wrap(async (g, _o, [port]) => { const ctx = await ctxOf(g); const r = await portsReport(ctx, port ? Number(port) : undefined); emit(g, renderPorts(r, ctx.host.name), r); }));
  program.command('start <target>').description('start an app or profile (dependencies first)').option('--reload', 'restart apps that are already online')
    .action(wrap((g, o, [t]) => mutate(g, t, 'start', { reload: Boolean(o.reload) })));
  program.command('restart <target>').description('restart app(s) with the current manifest config')
    .action(wrap((g, _o, [t]) => mutate(g, t, 'restart')));
  program.command('stop <target>').description('stop app(s)')
    .action(wrap((g, _o, [t]) => mutate(g, t, 'stop')));
  program.command('delete <target>').description('remove app(s) from pm2')
    .action(wrap((g, _o, [t]) => mutate(g, t, 'delete')));
  program.command('flush [app]').description('truncate pm2 log files; incidents start over from there')
    .action(wrap(async (g, _o, [app]) => {
      const fleet = fleetOf(g);
      const names = fleet.select(app ? [app] : ['all']);
      const multi = fleet.groups(names).length > 1;
      const r = await clearLogs(fleet, names);
      emit(g, renderFlushed(r, multi), r);
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

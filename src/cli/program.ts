import fs from 'node:fs';
import { Command, Option } from 'commander';
import { VERSION } from '../version.js';
import { McprocError, isMcprocError } from '../core/errors.js';
import { createTransport } from '../transport/index.js';
import { unpack, defaultUnpackDeps } from '../runtime/unpack.js';
import type { WithNode } from '../runtime/decide.js';
import {
  prepare,
  connect,
  assertWritable,
  resolveProjectDir,
  type Context,
} from '../core/resolve.js';
import { cancelLease, leasesView } from '../core/leases/view.js';
import { watcherEntry } from '../core/leases/ensure.js';
import { defaultWatcherDeps, watchLeases } from '../core/leases/watcher.js';
import { stateDir } from '../core/state.js';
import type { WaitRecord } from '../core/actions.js';
import { portsReport, hostsInfo, describeProject } from '../core/list.js';
import { takeIncidents, clearLogs } from '../core/incidents/store.js';
import type { CursorState } from '../core/incidents/cursor.js';
import {
  streamLogs,
  defaultStreamDeps,
  resolveColor,
  formatLine,
  colorFor,
  type LogSource,
  type StreamOptions,
} from '../core/logstream.js';
import {
  parseSince,
  readSince,
  LogMarks,
  type SinceSpec,
} from '../core/logsince.js';
import { doctor } from '../core/doctor.js';
import { parseUntil, waitFor, WAIT_TIMEOUT_DEFAULT_MS } from '../core/wait.js';
import { initProject } from '../core/init.js';
import { adoptPorts } from '../core/adopt.js';
import { Fleet, actOn, describeFleetApp, type Act } from '../core/fleet.js';
import { listWithReloads } from '../core/reloadcount.js';
import {
  renderLs,
  renderPorts,
  renderHosts,
  renderDoctor,
  renderProject,
  renderUnpack,
  renderIncidents,
  renderFlushed,
  renderMutation,
  renderWait,
  renderAdopted,
  renderLeases,
  hostsOf,
  sinceNotes,
  urlNote,
} from '../mcp/render.js';
import { serveStdio } from '../mcp/server.js';
import { monitOnce } from '../monit/once.js';
import { installShortcut } from './install.js';
import { runMonit } from '../monit/tui.js';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}
type Globals = { project?: string; host?: string; json?: boolean };
type Opts = Record<string, string | boolean | undefined>;

const defaultIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

/**
 * The one-shot read of `logs --since`: the merged lines since the cutoff on stdout, labeled and colored as the follow
 * labels them (the longest name, each app's index in host-group order), the notes on stderr, exit code 1 when a host
 * was not read. Returns where each app's follow starts, or null when the reader of stdout went away.
 */
export async function printSince(
  fleet: Fleet,
  apps: string[],
  since: SinceSpec,
  how: { stream: 'out' | 'err' | 'both'; color: boolean; json: boolean },
  io: Io,
  signal?: AbortSignal
): Promise<StreamOptions['startAt'] | null> {
  const marks = new LogMarks();
  const a = await readSince(fleet, apps, {
    since,
    stream: how.stream,
    marks,
    keepColors: how.color && !how.json,
  });
  const order = fleet.groups(apps).flatMap((gr) => gr.apps);
  const width = Math.max(...apps.map((x) => x.length));
  let closed = false; // `| head` read enough: stop printing, no stack trace
  for (const l of a.lines) {
    if (closed || signal?.aborted) break;
    try {
      io.out(
        how.json
          ? JSON.stringify(l)
          : formatLine(
              { app: l.app, stream: l.stream, text: l.text },
              width,
              how.color ? colorFor(order.indexOf(l.app)) : null
            )
      );
    } catch (e) {
      if ((e as { code?: string }).code !== 'EPIPE') throw e;
      closed = true;
    }
  }
  for (const n of sinceNotes(a)) io.err(n);
  if (a.errors.length) process.exitCode = 1; // a host was not read: the lines of the others are printed, the exit code says so
  if (closed || signal?.aborted) return null;
  // a stream the read left without a mark (its app not started yet, or its read cut short) starts at its host's cutoff,
  // so what the app writes before its follower's first poll is still printed; an app on a host that was not read has
  // no cutoff and is followed from the file's end
  return Object.fromEntries(
    apps.map((x) => {
      const host = fleet.hostOf(x);
      const cutoff = a.since[host];
      return [
        x,
        {
          ...marks.get(LogMarks.key(fleet.manifest.path, host, x)),
          ...(typeof cutoff === 'string' ? { cutoff } : {}),
        },
      ];
    })
  );
}

/**
 * `ls`: the rows of the named apps, each from its own host, as a table or JSON; with reloads, each running app's
 * in-process reloads since its pm2 start, which reads the logs of each host once more. Exit code 1 when a host was not
 * probed or its logs were not read.
 */
export async function printLs(
  fleet: Fleet,
  names: string[],
  how: { reloads: boolean; json: boolean },
  io: Io
): Promise<void> {
  const { rows, errors, unread } = await listWithReloads(
    fleet,
    names,
    how.reloads
  );
  io.out(
    how.json
      ? JSON.stringify(rows, null, 2)
      : renderLs(rows, fleet.fallback, unread)
  );
  if (errors.length) process.exitCode = 1; // the rows of the hosts that answered are printed; the exit code still says one did not
}

export function buildProgram(io: Io = defaultIo): Command {
  const program = new Command()
    .name('mcproc')
    .description(
      'pm2 process control for agents: one manifest per project, local and remote hosts, per-app ports'
    )
    .version(VERSION)
    .option(
      '--project <dir>',
      'project root (default: MCPROC_PROJECT, CLAUDE_PROJECT_DIR, cwd)'
    )
    .option('--host <name>', 'host from the manifest (default: local)')
    .option('--json', 'print JSON instead of text');

  const emit = (g: Globals, text: string, data: unknown) =>
    io.out(g.json ? JSON.stringify(data, null, 2) : text);
  const wrap =
    (fn: (g: Globals, opts: Opts, args: string[]) => Promise<void>) =>
    async (...all: unknown[]) => {
      const cmd = all[all.length - 1] as Command;
      const opts = (all[all.length - 2] ?? {}) as Opts;
      const args = all.slice(0, -2) as string[];
      const g = cmd.optsWithGlobals() as Globals;
      try {
        await fn(g, opts, args);
      } catch (e) {
        if (!isMcprocError(e)) throw e;
        io.err(
          g.json
            ? JSON.stringify(e.toJSON())
            : `${e.code}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}`
        );
        process.exitCode = 1;
      }
    };
  const ctxOf = (g: Globals) =>
    connect(prepare({ project: g.project, host: g.host }));
  // apps run at their own host (`host:` in the manifest); --host narrows a command to the apps that run there
  const fleetOf = (g: Globals) =>
    new Fleet(prepare({ project: g.project }).manifest, g.host);
  const mutate = async (
    g: Globals,
    target: string,
    act: Act,
    opts: { reload?: boolean; note?: string; lease?: string } = {}
  ) => {
    const fleet = fleetOf(g);
    const waits: WaitRecord[] = [];
    const rows = await actOn(fleet, target, act, { ...opts, waits });
    const { text, failed } = renderMutation(rows, fleet.fallback, act, waits);
    emit(g, text, { ...hostsOf(rows, fleet.fallback), rows, waits });
    if (failed) process.exitCode = 1; // a host failed or was skipped: the first line says so, the exit code too
  };

  program
    .command('init')
    .description(
      'create .mcproc/ with a manifest draft discovered from the project'
    )
    .option('--force', 'overwrite an existing manifest')
    .option(
      '--adopt-ports',
      'write the ports ls reports as undeclared for the running apps into the existing manifest (comments kept) and print the diff; needs that manifest, drafts nothing and ignores --force'
    )
    .action(
      wrap(async (g, o) => {
        if (o.adoptPorts) {
          const r = await adoptPorts(fleetOf(g));
          const { text, failed } = renderAdopted(r);
          emit(g, text, r);
          if (failed) process.exitCode = 1; // a host was not read: the line names it, the exit code says so
          return;
        }
        const r = initProject(resolveProjectDir(g.project), {
          force: Boolean(o.force),
        });
        emit(g, `Created ${r.path} (${r.candidates} candidates)\n${r.next}`, r);
      })
    );
  program
    .command('hosts')
    .description('hosts declared in the manifest')
    .action(
      wrap(async (g) => {
        const { manifest } = prepare({ project: g.project });
        const h = hostsInfo(manifest);
        emit(g, renderHosts(h), h);
      })
    );
  program
    .command('doctor')
    .description(
      'check hosts: reachability, node, pm2, tools, daemon, environment, where each url answers'
    )
    .action(
      wrap(async (g) => {
        const { manifest } = prepare({ project: g.project });
        const r = await doctor(manifest, g.host);
        emit(g, renderDoctor(r), r);
      })
    );
  program
    .command('ls [app]')
    .description(
      'apps with status, pid and real vs declared ports, each from the host it runs on'
    )
    .option(
      '--reloads',
      "also count each running app's in-process reloads since its pm2 start, shown as RESTARTS 0 (+3); reads each host's logs once more"
    )
    .action(
      wrap(async (g, o, [app]) => {
        const fleet = fleetOf(g);
        await printLs(
          fleet,
          fleet.select(app ? [app] : ['all']),
          { reloads: Boolean(o.reloads), json: Boolean(g.json) },
          io
        );
      })
    );
  program
    .command('describe [app]')
    .description('project summary, or one app in detail')
    .action(
      wrap(async (g, _o, [app]) => {
        const fleet = fleetOf(g);
        if (!app) {
          const d = describeProject(fleet.manifest);
          emit(g, renderProject(d), d);
          return;
        }
        const d = await describeFleetApp(fleet, app);
        emit(
          g,
          [
            `${d.app.name} [${d.app.kind}]: ${d.app.description}`,
            `run: ${d.app.run}`,
            `cwd: ${d.app.cwd}`,
            renderLs([d.row], d.host),
            urlNote(d.row),
            `logs: ${d.logs ? `${d.logs.out} | ${d.logs.err}` : 'not started yet'}`,
          ]
            .filter(Boolean)
            .join('\n'),
          d
        );
      })
    );
  program
    .command('logs [targets...]')
    .description(
      'logs of apps or profiles (default: all apps), one labeled line per entry like docker compose; -f keeps streaming'
    )
    .option('-f, --follow', 'keep streaming until Ctrl-C')
    .option('-n, --lines <n>', 'history lines per app (default 100, max 2000)')
    .option('--out', 'stdout only')
    .option('--err', 'stderr only')
    .option('--interval <ms>', 'poll interval while following', '1000')
    .option(
      '--color',
      "colors (labels and the apps' own) even when stdout is not a terminal; also FORCE_COLOR"
    )
    .option(
      '--no-color',
      'plain text (also when NO_COLOR is set or stdout is not a terminal)'
    )
    .option(
      '--since <time>',
      'lines since a span (2m, 90s) or a host-local time (2026-10-14T07:30; add Z or +02:00 for an instant), merged across the targets; prints and exits, with -f then follows'
    )
    .action(
      wrap(async (g, o, args) => {
        const targets = (args[0] as unknown as string[] | undefined) ?? [];
        const fleet = fleetOf(g);
        const apps = fleet.select(targets.length ? targets : ['all']);
        const color = resolveColor(
          o.color as boolean | undefined,
          process.env,
          Boolean(process.stdout.isTTY)
        );
        const stream = o.out ? 'out' : o.err ? 'err' : 'both';
        let since: SinceSpec | undefined;
        if (o.since !== undefined) {
          if (o.lines !== undefined)
            throw new McprocError(
              'BAD_ARGUMENT',
              '-n and --since do not combine: --since decides what is printed first',
              {
                hint: 'Drop -n; with -f the follow continues from where the since read ended.',
              }
            );
          since = parseSince(String(o.since));
          if (since.kind === 'last')
            throw new McprocError(
              'BAD_ARGUMENT',
              'since last needs an MCP session, which keeps the marks',
              {
                hint: 'Use a time such as --since 2m, or --since 2026-10-14T07:30.',
              }
            );
        }
        const ac = new AbortController();
        // a reader that closes early (`| head`) raises EPIPE asynchronously on stdout, possibly after the stream already returned:
        // the listener stays for the rest of the process, ends the stream and swallows the error instead of a crash
        process.stdout.on('error', (e: NodeJS.ErrnoException) => {
          if (e.code === 'EPIPE') ac.abort();
          else throw e;
        });
        let startAt: StreamOptions['startAt'];
        if (since) {
          const at = await printSince(
            fleet,
            apps,
            since,
            { stream, color, json: Boolean(g.json) },
            io,
            ac.signal
          );
          if (!o.follow || at === null) return;
          startAt = at;
        }
        // every host at once; one that cannot be reached becomes a note per app instead of ending the stream, and is
        // connected again later while following (fleet.ctx keeps no failed connection)
        const sources = await Promise.all(
          fleet.groups(apps).map(async (gr): Promise<LogSource> => {
            const connect = () => fleet.ctx(gr.host);
            try {
              return { ...gr, connect, ctx: await connect() };
            } catch (e) {
              return { ...gr, connect, error: e };
            }
          })
        );
        if (ac.signal.aborted) return; // the reader of the since lines went away meanwhile: nothing to follow for
        const stop = () => ac.abort();
        process.once('SIGINT', stop);
        try {
          await streamLogs(
            sources,
            {
              lines: since
                ? 0
                : Math.min(Math.max(1, Number(o.lines) || 100), 2000),
              follow: Boolean(o.follow),
              intervalMs: Math.max(200, Number(o.interval) || 1000),
              color,
              json: Boolean(g.json),
              stream,
              signal: ac.signal,
              startAt,
            },
            defaultStreamDeps()
          );
        } finally {
          process.off('SIGINT', stop);
        }
      })
    );
  program
    .command('incidents [targets...]')
    .description(
      'new errors with context since they were last taken, plus crashes and restarts; -f keeps watching'
    )
    .option('--peek', 'look without taking: the pick-up point stays')
    .option(
      '--since <min>',
      'first poll: minutes to look back in each log',
      '15'
    )
    .option('--max <n>', 'most incidents per poll, newest first', '20')
    .option(
      '--context <before,after>',
      'lines of context (default per app, 3,5)'
    )
    .option(
      '--reloads',
      "also each app's in-process reloads since the last poll (tsx/nodemon restarts, Vite/Next rebuilds, a repeated listening line), one line per app"
    )
    .option('-f, --follow', 'keep polling and print each new incident')
    .option('--interval <s>', 'seconds between polls while following', '10')
    .option('--color', 'colors even when stdout is not a terminal')
    .option('--no-color', 'plain text')
    .action(
      wrap(async (g, o, args) => {
        const targets = (args[0] as unknown as string[] | undefined) ?? [];
        let context: [number, number] | undefined;
        if (o.context !== undefined) {
          const m = /^(\d{1,2}),(\d{1,2})$/.exec(String(o.context));
          if (!m)
            throw new McprocError(
              'BAD_ARGUMENT',
              `--context must be before,after (e.g. 3,5), got "${o.context}"`
            );
          context = [Number(m[1]), Number(m[2])];
        }
        const fleet = fleetOf(g);
        const names = fleet.select(targets.length ? targets : ['all']);
        const color = resolveColor(
          o.color as boolean | undefined,
          process.env,
          Boolean(process.stdout.isTTY)
        );
        const peek = Boolean(o.peek);
        let cursor: CursorState | undefined; // a peeking follower's own position; taking always goes on from the stored point
        const poll = async () => {
          const r = await takeIncidents(fleet, names, {
            peek,
            cursor,
            sinceMin: Number(o.since) || 15,
            max: Number(o.max) || 20,
            context,
            includeReloads: Boolean(o.reloads),
          });
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
            await new Promise((r) =>
              setTimeout(r, Math.max(1, Number(o.interval) || 10) * 1000)
            );
            if (ac.signal.aborted) break;
            const a = await poll();
            if (a.incidents.length || a.errors.length)
              emit(g, renderIncidents(a, { color }), a);
          }
        } finally {
          process.off('SIGINT', stop);
        }
      })
    );
  program
    .command('wait <app>')
    .description(
      'block until the app is listening, answers its url, exited, printed a matching line, went idle or reloaded; exit 1 when it was not reached'
    )
    .requiredOption(
      '--until <cond>',
      'listening | url-ok | exited | log:<regex> | idle:<seconds> | reloaded (the next in-process reload after the call: a tsx/nodemon restart, a Vite/Next rebuild, a repeated listening line; answered once its burst is quiet for 2 s; for a server whose reload restarts it, wait --until listening next)'
    )
    .option(
      '-t, --timeout <s>',
      'seconds to wait (max 600)',
      String(WAIT_TIMEOUT_DEFAULT_MS / 1000)
    )
    .action(
      wrap(async (g, o, [app]) => {
        const until = parseUntil(String(o.until)); // a bad request is refused before any host is touched
        const timeoutMs =
          Math.max(1, Number(o.timeout) || WAIT_TIMEOUT_DEFAULT_MS / 1000) *
          1000; // waitFor holds the 600 s cap
        const fleet = fleetOf(g);
        const ctx = await fleet.ctx(fleet.one(app));
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.once('SIGINT', stop);
        try {
          const r = await waitFor(ctx, app, until, {
            timeoutMs,
            signal: ac.signal,
          });
          emit(g, renderWait(app, r), { app, host: ctx.host.name, ...r });
          if (!r.ok) process.exitCode = 1; // not reached (timeout, process gone, Ctrl-C): scripts see it
        } finally {
          process.off('SIGINT', stop);
        }
      })
    );
  program
    .command('ports [port]')
    .description('who listens on which port on the host')
    .action(
      wrap(async (g, _o, [port]) => {
        const ctx = await ctxOf(g);
        const r = await portsReport(ctx, port ? Number(port) : undefined);
        emit(g, renderPorts(r, ctx.host.name), r);
      })
    );
  program
    .command('start <target>')
    .description('start an app or profile (dependencies first)')
    .option('--reload', 'restart apps that are already online')
    .option('--note <text>', 'what this start is for, kept on its lease')
    // internal: the watcher's child runs the start it admitted under this lease
    .addOption(new Option('--lease <id>').hideHelp())
    .action(
      wrap((g, o, [t]) =>
        mutate(g, t, 'start', {
          reload: Boolean(o.reload),
          note: o.note as string | undefined,
          lease: o.lease as string | undefined,
        })
      )
    );
  program
    .command('restart <target>')
    .description('restart app(s) with the current manifest config')
    .action(wrap((g, _o, [t]) => mutate(g, t, 'restart')));
  program
    .command('stop <target>')
    .description('stop app(s)')
    .action(wrap((g, _o, [t]) => mutate(g, t, 'stop')));
  program
    .command('delete <target>')
    .description('remove app(s) from pm2')
    .action(wrap((g, _o, [t]) => mutate(g, t, 'delete')));
  const leases = program
    .command('leases')
    .description(
      "the host's lease queue: who is running, who waits and why, the memory reading and the watcher"
    )
    .action(
      wrap(async (g) => {
        let ctx: Context | undefined;
        try {
          ctx = await ctxOf(g);
        } catch {
          ctx = undefined; // no manifest here: the queue is the host's and still reads
        }
        const v = await leasesView(undefined, ctx);
        emit(g, renderLeases(v), v);
      })
    );
  leases
    .command('cancel <id>')
    .description('cancel a pending lease')
    .action(
      wrap(async (g, _o, [id]) => {
        const l = await cancelLease(id);
        emit(g, `cancelled ${l.id} (${l.project} ${l.target})`, l);
      })
    );
  program
    .command('watch-leases', { hidden: true })
    .description('internal: the lease watcher the start launches under pm2')
    .action(
      wrap(async () => {
        const dir = stateDir();
        const deps = defaultWatcherDeps(dir, watcherEntry());
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        fs.mkdirSync(deps.store.dir, { recursive: true });
        deps.watch = (cb) => {
          // the lock's own files (.lock, its token and stale files, .seq) churn on every change: only a lease wakes it
          const w = fs.watch(deps.store.dir, (_e, name) => {
            if (!name?.startsWith('.')) cb();
          });
          return () => w.close();
        };
        const r = await watchLeases(deps, { signal: ac.signal });
        io.out(`watcher ${r}`);
      })
    );
  program
    .command('flush [app]')
    .description('truncate pm2 log files; incidents start over from there')
    .action(
      wrap(async (g, _o, [app]) => {
        const fleet = fleetOf(g);
        const names = fleet.select(app ? [app] : ['all']);
        const multi = fleet.groups(names).length > 1;
        const r = await clearLogs(fleet, names);
        emit(g, renderFlushed(r, multi), r);
      })
    );
  program
    .command('monit')
    .description(
      'terminal dashboard: apps with real memory/cpu/ports, log tail, details (--once prints one frame)'
    )
    .option('--once', 'print one frame as text and exit')
    .option('--interval <ms>', 'refresh interval', '2000')
    .option('--lines <n>', 'log lines of history', '200')
    .action(
      wrap(async (g, o) => {
        if (o.once) {
          io.out(
            await monitOnce({
              project: g.project,
              host: g.host,
              lines: Number(o.lines) || 200,
            })
          );
          return;
        }
        await runMonit({
          project: g.project,
          host: g.host,
          intervalMs: Math.max(500, Number(o.interval) || 2000),
          lines: Number(o.lines) || 200,
        });
      })
    );
  program
    .command('unpack')
    .description(
      'bring pm2 (assembled with npm from the lockfile mcproc ships) and Node when missing to the host, into <cwd>/.mcproc/runtime or --dir'
    )
    .option('--dir <path>', 'absolute runtime directory on the host')
    .option('--with-node <mode>', 'auto | always | never', 'auto')
    .option(
      '--node-version <version>',
      'exact Node version (default: newest LTS)'
    )
    .option(
      '--force',
      'rewrite even when versions match; overwrite a hand-written manifest on the host'
    )
    .action(
      wrap(async (g, o) => {
        const p = prepare({ project: g.project, host: g.host });
        assertWritable(p.host);
        const mode = String(o.withNode ?? 'auto');
        if (!['auto', 'always', 'never'].includes(mode))
          throw new McprocError(
            'BAD_ARGUMENT',
            `--with-node must be auto, always or never, got "${mode}"`
          );
        const r = await unpack(
          {
            manifest: p.manifest,
            host: p.host,
            transport: createTransport(p.host),
          },
          {
            dir: o.dir as string | undefined,
            withNode: mode as WithNode,
            nodeVersion: o.nodeVersion as string | undefined,
            force: Boolean(o.force),
          },
          defaultUnpackDeps()
        );
        emit(g, renderUnpack(r), r);
      })
    );
  program
    .command('install')
    .description(
      'put a `mcproc` shortcut on your shell PATH for this checkout (a launcher in ~/.local/bin), or remove it'
    )
    .option('--bin-dir <dir>', 'where the launcher goes (default ~/.local/bin)')
    .option('--uninstall', 'remove the launcher written by a previous install')
    .action(
      wrap(async (g, o) => {
        const r = installShortcut({
          binDir: o.binDir as string | undefined,
          uninstall: Boolean(o.uninstall),
        });
        const lines = r.removed
          ? [`removed ${r.launcher}`]
          : r.written
            ? [
                `wrote ${r.launcher} → node ${r.cli}`,
                r.rcUpdated
                  ? `added a PATH line for ${r.binDir} to ${r.rcFile}`
                  : r.onPath
                    ? `${r.binDir} is already on PATH`
                    : `${r.rcFile} already has the PATH line`,
              ]
            : [];
        emit(g, [...lines, ...r.next.map((n) => `→ ${n}`)].join('\n'), r);
      })
    );
  program
    .command('mcp')
    .description(
      'run the MCP server on stdio (register this command in your agent client)'
    )
    .action(
      wrap(async (g) => {
        await serveStdio(g.project);
      })
    );
  return program;
}

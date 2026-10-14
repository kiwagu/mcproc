import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, MUT, RO, runTool, type ToolDeps } from '../common.js';
import { prepare, connect } from '../../core/resolve.js';
import { portsReport, hostsInfo, describeProject } from '../../core/list.js';
import {
  Fleet,
  defaultConnector,
  listFleet,
  describeFleetApp,
} from '../../core/fleet.js';
import { readLogs } from '../../core/logs.js';
import { doctor } from '../../core/doctor.js';
import { takeIncidents } from '../../core/incidents/store.js';
import { parseUntil, waitFor } from '../../core/wait.js';
import {
  renderLs,
  renderPorts,
  renderHosts,
  renderDoctor,
  renderLogs,
  fmtDeps,
  renderProject,
  renderIncidents,
  renderWait,
  hostsOf,
} from '../render.js';

export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  const prep = async (args: { project?: string; host?: string }) =>
    prepare({
      project: args.project ?? deps.project,
      host: args.host,
      roots: await deps.roots(),
    });
  // apps run at their own host (`host:` in the manifest); host narrows a call to the apps that run there
  const fleetOf = async (args: { project?: string; host?: string }) =>
    new Fleet(
      prepare({
        project: args.project ?? deps.project,
        roots: await deps.roots(),
      }).manifest,
      args.host,
      defaultConnector(deps.spawner)
    );

  server.registerTool(
    'hosts',
    {
      title: 'Hosts',
      description:
        'Hosts declared in the project manifest: transport, project cwd there, readonly flag. No network access.',
      inputSchema: { project: commonInput.project },
      annotations: RO,
    },
    (args) =>
      runTool(async () => {
        const { manifest } = await prep(args);
        const hosts = hostsInfo(manifest);
        return {
          text: renderHosts(hosts),
          data: { project: manifest.project, hosts },
        };
      })
  );

  server.registerTool(
    'doctor',
    {
      title: 'Doctor',
      description:
        'Check hosts: reachable, Node version, which pm2 would run and why, ps/ss/tar availability, the unpacked runtime, daemon state. Recommends unpack, hosts.<host>.pm2 or pm2_home when pm2 is missing or unusable.',
      inputSchema: commonInput,
      annotations: RO,
    },
    (args) =>
      runTool(async () => {
        const { manifest } = await prep({ project: args.project });
        const reports = await doctor(manifest, args.host, deps.spawner);
        return {
          text: renderDoctor(reports),
          data: { project: manifest.project, reports },
        };
      })
  );

  server.registerTool(
    'ls',
    {
      title: 'List apps',
      description:
        'One row per manifest app, each from the host it runs on: pm2 status, pid, uptime, restarts, memory and CPU of the whole process tree, the runtime command, the ports it really listens on compared with the declared ones, and its URL with the HTTP answer (ok/error/down). Answers "is it up, on which port, which address do I open".',
      inputSchema: {
        ...commonInput,
        app: z.string().optional().describe('Only this app'),
      },
      annotations: RO,
    },
    (args) =>
      runTool(async () => {
        const fleet = await fleetOf(args);
        const { rows, errors } = await listFleet(
          fleet,
          fleet.select(args.app ? [args.app] : ['all'])
        );
        return {
          text: renderLs(rows, fleet.fallback),
          data: {
            ...hostsOf(rows, fleet.fallback),
            project: fleet.manifest.project,
            rows,
            errors,
          },
        };
      })
  );

  server.registerTool(
    'describe',
    {
      title: 'Describe',
      description:
        'Call this first in a new session. Without app: project summary (apps with descriptions, profiles, hosts) plus .mcproc/README.md. With app: its manifest entry, runtime state, log paths, URL, ports and generated pm2 config.',
      inputSchema: { ...commonInput, app: z.string().optional() },
      annotations: RO,
    },
    (args) =>
      runTool(async () => {
        const fleet = await fleetOf(args);
        if (!args.app) {
          const d = describeProject(fleet.manifest);
          return {
            text: renderProject(d),
            data: d as unknown as Record<string, unknown>,
          };
        }
        const d = await describeFleetApp(fleet, args.app);
        const text = [
          `${d.app.name} [${d.app.kind}]: ${d.app.description}`,
          `run: ${d.app.run}`,
          `cwd: ${d.app.cwd}`,
          d.app.depends_on.length
            ? `depends_on: ${fmtDeps(d.app.depends_on)}`
            : '',
          renderLs([d.row], d.host),
          `logs: ${d.logs ? `${d.logs.out} | ${d.logs.err}` : 'not started yet'}`,
          `pm2: ${JSON.stringify(d.pm2)}`,
        ]
          .filter(Boolean)
          .join('\n');
        return { text, data: d as unknown as Record<string, unknown> };
      })
  );

  server.registerTool(
    'logs',
    {
      title: 'Logs',
      description:
        "Tail an app's pm2 logs (out, err or both) on the host it runs on, ANSI stripped. Default 100 lines, max 2000.",
      inputSchema: {
        ...commonInput,
        app: z.string(),
        lines: z.number().int().min(1).max(2000).optional(),
        stream: z.enum(['out', 'err', 'both']).optional(),
      },
      annotations: RO,
    },
    (args) =>
      runTool(async () => {
        const fleet = await fleetOf(args);
        const ctx = await fleet.ctx(fleet.one(args.app));
        const r = await readLogs(ctx, args.app, {
          lines: args.lines,
          stream: args.stream,
        });
        return {
          text: renderLogs(r),
          data: { host: ctx.host.name, ...r } as unknown as Record<
            string,
            unknown
          >,
        };
      })
  );

  server.registerTool(
    'ports',
    {
      title: 'Ports',
      description:
        'Who listens on which port on the host, including processes pm2 does not manage. With port: the holder of that port.',
      inputSchema: {
        ...commonInput,
        port: z.number().int().min(1).max(65535).optional(),
      },
      annotations: RO,
    },
    (args) =>
      runTool(async () => {
        const ctx = await connect(await prep(args), { spawner: deps.spawner });
        const r = await portsReport(ctx, args.port);
        return {
          text: renderPorts(r, ctx.host.name),
          data: { host: ctx.host.name, ...r },
        };
      })
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait',
      description:
        "Block until an app is usable or finished. until: listening (every declared port is bound; the app must declare a port), url-ok (its url answers 2xx/3xx; the app must declare a url), exited (the process left online; for an app with autorestart off, kind task included, the answer carries exit_code and done / failed (exit N) / stopped, any other app shows pm2's stopped or errored), log:<regex> (a new log line matches; tested without pm2's time stamp and with ANSI stripped, the answer keeps the stamp), idle:<seconds> (no log output for that long: a watcher settled). log: and idle: see only output written after the call begins, so to know whether the app is up prefer listening or url-ok. listening or url-ok on an app without a declared port or url is refused with BAD_ARGUMENT. ok false with what was last seen on timeout (default 60 s, max 600) or when the process died meanwhile; a result, not an error. A restart in progress (a watch restart, a restart delay) is waited out. Call it after start instead of sleeping or polling ls.",
      inputSchema: {
        ...commonInput,
        app: z.string().describe('The app to wait for'),
        until: z
          .string()
          .describe(
            'listening | url-ok | exited | log:<regex> | idle:<seconds>'
          ),
        timeout_s: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe('Seconds to wait, default 60, max 600'),
      },
      annotations: RO,
    },
    (args, extra) =>
      runTool(async () => {
        const until = parseUntil(args.until); // a bad request is refused before any host is touched
        const fleet = await fleetOf(args);
        const ctx = await fleet.ctx(fleet.one(args.app));
        const r = await waitFor(ctx, args.app, until, {
          timeoutMs:
            args.timeout_s === undefined ? undefined : args.timeout_s * 1000,
          signal: extra.signal, // the client cancelled the call or went away: stop polling the host
        });
        return {
          text: renderWait(args.app, r),
          data: { app: args.app, host: ctx.host.name, ...r },
        };
      })
  );

  server.registerTool(
    'incidents',
    {
      title: 'Incidents',
      description:
        "Only the errors that are NEW since they were last taken, each with lines of context before and after (a folded stack trace included), plus crashes and restarts. A call takes what it returns: the pick-up point, kept in .mcproc/incidents.json and shared by every session, agent and CLI call, moves past them, so nobody gets them twice; peek: true looks without taking. A log clear (flush, or c in monit) starts incidents over from there. Cheap to poll: nothing new is one short line. During long work on running apps call it periodically, with your client's own loop/cron/monitor if it has one; read logs only for an incident worth a closer look.",
      inputSchema: {
        ...commonInput,
        app: z
          .string()
          .optional()
          .describe('An app or a profile; default all apps'),
        peek: z
          .boolean()
          .optional()
          .describe(
            'Look without taking: the pick-up point stays (default false)'
          ),
        since: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe(
            'First call only: minutes to look back in each log (default 15)'
          ),
        max: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Most incidents returned, newest first (default 20)'),
        context: z
          .tuple([
            z.number().int().min(0).max(50),
            z.number().int().min(0).max(50),
          ])
          .optional()
          .describe('[lines before, lines after] (default per app, 3 and 5)'),
      },
      annotations: MUT(false, false), // taking writes the local pick-up point; nothing changes on the hosts
    },
    (args) =>
      runTool(async () => {
        const fleet = await fleetOf(args);
        const names = fleet.select([args.app ?? 'all']);
        const { answer } = await takeIncidents(fleet, names, {
          peek: args.peek,
          sinceMin: args.since,
          max: args.max,
          context: args.context,
        });
        return {
          text: renderIncidents(answer),
          data: answer as unknown as Record<string, unknown>,
        };
      })
  );
}

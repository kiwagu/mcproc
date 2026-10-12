import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, RO, runTool, type ToolDeps } from '../common.js';
import { prepare, connect } from '../../core/resolve.js';
import { portsReport, hostsInfo, describeProject } from '../../core/list.js';
import { Fleet, defaultConnector, listFleet, describeFleetApp } from '../../core/fleet.js';
import { readLogs } from '../../core/logs.js';
import { doctor } from '../../core/doctor.js';
import { renderLs, renderPorts, renderHosts, renderDoctor, renderLogs, renderProject, hostsOf } from '../render.js';

export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  const prep = async (args: { project?: string; host?: string }) => prepare({ project: args.project, host: args.host, roots: await deps.roots() });
  // apps run at their own host (`host:` in the manifest); host narrows a call to the apps that run there
  const fleetOf = async (args: { project?: string; host?: string }) => new Fleet(prepare({ project: args.project, roots: await deps.roots() }).manifest, args.host, defaultConnector(deps.spawner));

  server.registerTool('hosts', {
    title: 'Hosts', description: 'Hosts declared in the project manifest: transport, project cwd there, readonly flag. No network access.',
    inputSchema: { project: commonInput.project }, annotations: RO,
  }, (args) => runTool(async () => {
    const { manifest } = await prep(args);
    const hosts = hostsInfo(manifest);
    return { text: renderHosts(hosts), data: { project: manifest.project, hosts } };
  }));

  server.registerTool('doctor', {
    title: 'Doctor', description: 'Check hosts: reachable, Node version, which pm2 would run and why, ps/ss/tar availability, the unpacked runtime, daemon state. Recommends unpack, hosts.<host>.pm2 or pm2_home when pm2 is missing or unusable.',
    inputSchema: commonInput, annotations: RO,
  }, (args) => runTool(async () => {
    const { manifest } = await prep({ project: args.project });
    const reports = await doctor(manifest, args.host, deps.spawner);
    return { text: renderDoctor(reports), data: { project: manifest.project, reports } };
  }));

  server.registerTool('ls', {
    title: 'List apps', description: 'One row per manifest app, each from the host it runs on: pm2 status, pid, uptime, restarts, memory and CPU of the whole process tree, the runtime command, the ports it really listens on compared with the declared ones, and its URL with the HTTP answer (ok/error/down). Answers "is it up, on which port, which address do I open".',
    inputSchema: { ...commonInput, app: z.string().optional().describe('Only this app') }, annotations: RO,
  }, (args) => runTool(async () => {
    const fleet = await fleetOf(args);
    const { rows, errors } = await listFleet(fleet, fleet.select(args.app ? [args.app] : ['all']));
    return { text: renderLs(rows, fleet.fallback), data: { ...hostsOf(rows, fleet.fallback), project: fleet.manifest.project, rows, errors } };
  }));

  server.registerTool('describe', {
    title: 'Describe', description: 'Call this first in a new session. Without app: project summary (apps with descriptions, profiles, hosts) plus .mcproc/README.md. With app: its manifest entry, runtime state, log paths, URL, ports and generated pm2 config.',
    inputSchema: { ...commonInput, app: z.string().optional() }, annotations: RO,
  }, (args) => runTool(async () => {
    const fleet = await fleetOf(args);
    if (!args.app) {
      const d = describeProject(fleet.manifest);
      return { text: renderProject(d), data: d as unknown as Record<string, unknown> };
    }
    const d = await describeFleetApp(fleet, args.app);
    const text = [`${d.app.name} [${d.app.kind}]: ${d.app.description}`, `run: ${d.app.run}`, `cwd: ${d.app.cwd}`, d.app.depends_on.length ? `depends_on: ${d.app.depends_on.join(', ')}` : '',
      renderLs([d.row], d.host), `logs: ${d.logs ? `${d.logs.out} | ${d.logs.err}` : 'not started yet'}`, `pm2: ${JSON.stringify(d.pm2)}`].filter(Boolean).join('\n');
    return { text, data: d as unknown as Record<string, unknown> };
  }));

  server.registerTool('logs', {
    title: 'Logs', description: 'Tail an app\'s pm2 logs (out, err or both) on the host it runs on, ANSI stripped. Default 100 lines, max 2000.',
    inputSchema: { ...commonInput, app: z.string(), lines: z.number().int().min(1).max(2000).optional(), stream: z.enum(['out', 'err', 'both']).optional() }, annotations: RO,
  }, (args) => runTool(async () => {
    const fleet = await fleetOf(args);
    const ctx = await fleet.ctx(fleet.one(args.app));
    const r = await readLogs(ctx, args.app, { lines: args.lines, stream: args.stream });
    return { text: renderLogs(r), data: { host: ctx.host.name, ...r } as unknown as Record<string, unknown> };
  }));

  server.registerTool('ports', {
    title: 'Ports', description: 'Who listens on which port on the host, including processes pm2 does not manage. With port: the holder of that port.',
    inputSchema: { ...commonInput, port: z.number().int().min(1).max(65535).optional() }, annotations: RO,
  }, (args) => runTool(async () => {
    const ctx = await connect(await prep(args), { spawner: deps.spawner });
    const r = await portsReport(ctx, args.port);
    return { text: renderPorts(r, ctx.host.name), data: { host: ctx.host.name, ...r } };
  }));
}

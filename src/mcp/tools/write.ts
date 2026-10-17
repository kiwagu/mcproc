import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, MUT, runTool, type ToolDeps } from '../common.js';
import {
  prepare,
  assertWritable,
  resolveProjectDir,
} from '../../core/resolve.js';
import { Fleet, defaultConnector, actOn, type Act } from '../../core/fleet.js';
import type { WaitRecord } from '../../core/actions.js';
import { clearLogs } from '../../core/incidents/store.js';
import { initProject } from '../../core/init.js';
import { adoptPorts } from '../../core/adopt.js';
import { cancelLease } from '../../core/leases/view.js';
import type { LsRow } from '../../core/list.js';
import { createTransport } from '../../transport/index.js';
import { unpack, defaultUnpackDeps } from '../../runtime/unpack.js';
import {
  renderUnpack,
  renderFlushed,
  renderMutation,
  renderAdopted,
  hostsOf,
} from '../render.js';

export function registerWriteTools(server: McpServer, deps: ToolDeps): void {
  // apps run at their own host (`host:` in the manifest); host narrows a call to the apps that run there. Targets and
  // readonly hosts are checked before any host is contacted.
  const fleetOf = async (args: { project?: string; host?: string }) =>
    new Fleet(
      prepare({
        project: args.project ?? deps.project,
        roots: await deps.roots(),
      }).manifest,
      args.host,
      defaultConnector(deps.spawner, deps.hereCheck)
    );
  const targetInput = {
    ...commonInput,
    target: z.string().describe('App name, profile name, or "all"'),
  };
  const act = async (
    args: {
      project?: string;
      host?: string;
      target: string;
      reload?: boolean;
      note?: string;
    },
    what: Act,
    signal?: AbortSignal // the request's: aborted when the client cancels it or goes away
  ) => {
    const fleet = await fleetOf(args);
    const waits: WaitRecord[] = [];
    const rows: LsRow[] = await actOn(fleet, args.target, what, {
      reload: args.reload,
      note: args.note,
      waits,
      signal,
    });
    const { text, failed } = renderMutation(rows, fleet.fallback, what, waits);
    return {
      text,
      data: { ...hostsOf(rows, fleet.fallback), rows, waits } as Record<
        string,
        unknown
      >,
      isError: failed,
    };
  };

  server.registerTool(
    'init',
    {
      title: 'Init manifest draft',
      description:
        'Create .mcproc/ (gitignored) with a manifest DRAFT discovered from package.json scripts, workspaces, nx project.json, turbo.json, ecosystem.json and Procfile. On a turbo repo with a persistent dev task, the packages implementing it are drafted live (TODO descriptions to replace, a dev profile, libs/libs-watch builders for libraries consumed from dist/); every other candidate is commented out: uncomment, write descriptions, then verify with start + ls. Refuses to overwrite an existing manifest without force. With adopt_ports, instead write the ports ls reports as undeclared for the running apps into the existing manifest (comments kept) and return the diff; it needs that manifest, and force is ignored then.',
      inputSchema: {
        project: commonInput.project,
        force: z.boolean().optional(),
        adopt_ports: z.boolean().optional(),
      },
      annotations: MUT(true, true), // with force it replaces the manifest
    },
    (args) =>
      runTool(async () => {
        if (args.adopt_ports) {
          const r = await adoptPorts(await fleetOf(args));
          const { text, failed } = renderAdopted(r);
          return {
            text,
            data: r as unknown as Record<string, unknown>,
            isError: failed,
          };
        }
        const root = resolveProjectDir(
          args.project ?? deps.project,
          await deps.roots()
        );
        const r = initProject(root, { force: args.force });
        const src =
          Object.entries(r.by_source)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ') || 'none';
        return {
          text: `Created ${r.path} with ${r.candidates} candidate(s) (${src}).\n${r.next}`,
          data: r as unknown as Record<string, unknown>,
        };
      })
  );

  server.registerTool(
    'start',
    {
      title: 'Start',
      description:
        'Start an app or profile via pm2 from the generated ecosystem, each app on the host it runs on, dependencies first. A dependency declared with condition ready or completed is waited for (up to its timeout) before the dependent starts, and a dependent whose dependency failed or timed out is skipped with the reason. Apps already online are left alone unless reload is true.',
      inputSchema: {
        ...targetInput,
        reload: z.boolean().optional(),
        note: z
          .string()
          .max(200)
          .optional()
          .describe('What this start is for, kept on its lease'),
      },
      annotations: MUT(false, true),
    },
    (args, extra) =>
      runTool(async () => {
        return act(args, 'start', extra.signal);
      })
  );

  server.registerTool(
    'restart',
    {
      title: 'Restart',
      description:
        'Restart the named app(s) with the current manifest config (command, env, watch).',
      inputSchema: targetInput,
      annotations: MUT(false, false),
    },
    (args) =>
      runTool(async () => {
        return act(args, 'restart');
      })
  );

  server.registerTool(
    'stop',
    {
      title: 'Stop',
      description: 'Stop the named app(s); pm2 keeps them listed as stopped.',
      inputSchema: targetInput,
      annotations: MUT(true, true),
    },
    (args) =>
      runTool(async () => {
        return act(args, 'stop');
      })
  );

  server.registerTool(
    'delete',
    {
      title: 'Delete',
      description: 'Remove the named app(s) from pm2 (stops them first).',
      inputSchema: targetInput,
      annotations: MUT(true, true),
    },
    (args) =>
      runTool(async () => {
        return act(args, 'delete');
      })
  );

  server.registerTool(
    'lease_cancel',
    {
      title: 'Cancel a pending lease',
      description:
        "Remove a pending lease from the host's queue (a start that has not been admitted yet), or a starting exec lease. A starting start or a running lease is refused: stop its target instead.",
      inputSchema: {
        id: z.string().describe('The lease id from leases or a queued start'),
      },
      annotations: MUT(false, true),
    },
    (args) =>
      runTool(async () => {
        const l = await cancelLease(args.id);
        return {
          text: `cancelled ${l.id} (${l.project} ${l.target})`,
          data: l as unknown as Record<string, unknown>,
        };
      })
  );

  server.registerTool(
    'flush',
    {
      title: 'Flush logs',
      description:
        'Truncate the pm2 log files of one app, or of every app of the project (each on the host it runs on; with host, the apps that run there). Incidents start over from the flush: nothing logged before it is reported again.',
      inputSchema: { ...commonInput, app: z.string().optional() },
      annotations: MUT(true, true),
    },
    (args) =>
      runTool(async () => {
        const fleet = await fleetOf(args);
        const names = fleet.select(args.app ? [args.app] : ['all']);
        const hosts = fleet.groups(names).map((g) => g.host);
        const r = await clearLogs(fleet, names);
        return {
          text: renderFlushed(r, hosts.length > 1),
          data: { hosts, flushed: r },
        };
      })
  );

  server.registerTool(
    'unpack',
    {
      title: 'Unpack runtime',
      description:
        'Make a host self-sufficient: copy a pm2 tree (assembled once on this machine with npm from the lockfile mcproc ships; needs npm, tar and registry access the first time) and an official Node build when the host has no Node >= 18 (downloaded once from nodejs.org, checked against SHASUMS256), into <cwd>/.mcproc/runtime on that host or into dir, plus a copy of the manifest. Idempotent: same versions change nothing. Refused on readonly hosts and on a dir whose bin/ it did not write.',
      inputSchema: {
        ...commonInput,
        dir: z
          .string()
          .optional()
          .describe(
            'Absolute runtime directory on the host; default <host cwd>/.mcproc/runtime'
          ),
        with_node: z
          .enum(['auto', 'always', 'never'])
          .optional()
          .describe(
            'auto (default): bring Node only when the host has none >= 18'
          ),
        node_version: z
          .string()
          .optional()
          .describe('Exact Node version; default: the newest LTS'),
        force: z
          .boolean()
          .optional()
          .describe(
            'Rewrite even when versions match, and overwrite a hand-written manifest on the host'
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) =>
      runTool(async () => {
        const p = prepare({
          project: args.project ?? deps.project,
          host: args.host,
          roots: await deps.roots(),
        });
        assertWritable(p.host);
        const r = await unpack(
          {
            manifest: p.manifest,
            host: p.host,
            transport: createTransport(p.host, deps.spawner),
          },
          {
            dir: args.dir,
            withNode: args.with_node,
            nodeVersion: args.node_version,
            force: args.force,
          },
          deps.unpack ?? defaultUnpackDeps()
        );
        return {
          text: renderUnpack(r),
          data: r as unknown as Record<string, unknown>,
        };
      })
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, MUT, runTool, type ToolDeps } from '../common.js';
import { connect, prepare } from '../../core/resolve.js';
import { assertExecHost, defaultExecDeps, runExec } from '../../core/exec.js';
import { parseSizeMib } from '../../core/sizes.js';
import { McprocError } from '../../core/errors.js';
import { renderExec } from '../render.js';

/** The tools of the stands a checkout runs: `exec`, one-off work in a stand's environment under a memory lease when asked. */
export function registerStandTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'exec',
    {
      title: 'Exec',
      description:
        'Run a one-off command (a test run, a build, a seed) from the project root on THIS machine with the manifest\'s exec.env (the stand\'s addresses, interpolated) and MCPROC_PROJECT set. With memory (e.g. "4G") it is a lease like a start: it runs at once when the host has room and the queue is empty, else waits its turn behind the pending leases (timeout_s, default 600, max 3600) and is freed when the command exits. Local host only; refused when the local host is readonly. Returns the exit code and the last 200 lines of output; isError when the code is not 0.',
      inputSchema: {
        project: commonInput.project,
        host: z
          .string()
          .optional()
          .describe(
            'Host name from the manifest; exec runs on this machine only, so a host other than a local one is refused.'
          ),
        command: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'The command as argv, no shell: ["bun", "run", "test:e2e"]'
          ),
        memory: z
          .string()
          .optional()
          .describe('What it needs, as a size: 512M, 4G'),
        note: z.string().max(200).optional(),
        timeout_s: z.number().int().min(1).max(3600).optional(),
      },
      annotations: MUT(false, false),
    },
    (args, extra) =>
      runTool(async () => {
        // a bad request is refused before any host is touched
        let memoryMib: number | undefined;
        if (args.memory !== undefined)
          try {
            memoryMib = parseSizeMib(args.memory);
          } catch (e) {
            throw new McprocError('BAD_ARGUMENT', (e as Error).message);
          }
        const prep = prepare({
          project: args.project ?? deps.project,
          host: args.host,
          roots: await deps.roots(),
        });
        assertExecHost(prep.host);
        const ctx = await connect(prep, {
          spawner: deps.spawner,
          hereCheck: deps.hereCheck,
        });
        const r = await runExec(
          ctx,
          {
            command: args.command,
            memoryMib,
            note: args.note,
            timeoutMs: args.timeout_s ? args.timeout_s * 1000 : undefined,
            capture: true,
            signal: extra.signal,
          },
          defaultExecDeps()
        );
        return {
          text: renderExec(args.command, r),
          data: { ...r },
          isError: r.code !== 0,
        };
      })
  );
}

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { commonInput, MUT, RO, runTool, type ToolDeps } from '../common.js';
import { connect, prepare } from '../../core/resolve.js';
import { assertExecHost, defaultExecDeps, runExec } from '../../core/exec.js';
import { parseSizeMib } from '../../core/sizes.js';
import { McprocError } from '../../core/errors.js';
import {
  defaultWorktreeDeps,
  worktreeAdd,
  worktreeLs,
  worktreeRemove,
  type WorktreeDeps,
} from '../../core/worktree.js';
import {
  renderExec,
  renderWorktreeAdded,
  renderWorktreeRemoved,
  renderWorktrees,
} from '../render.js';

/**
 * The tools of the stands a checkout runs: `exec`, one-off work in a stand's environment under a memory lease when
 * asked, and the worktrees that give one repository several stands side by side.
 */
export function registerStandTools(server: McpServer, deps: ToolDeps): void {
  /** The checkout's manifest on the local host (git runs here) and the worktree deps, whose notes end up in `notes`. */
  const worktreeCtx = async (project: string | undefined, notes: string[]) => {
    const ctx = await connect(
      prepare({
        project: project ?? deps.project,
        roots: await deps.roots(),
      }),
      { spawner: deps.spawner, hereCheck: deps.hereCheck }
    );
    const wdeps: WorktreeDeps = await defaultWorktreeDeps(
      ctx,
      { out: (line) => notes.push(line) },
      { capture: true }
    );
    return { manifest: ctx.manifest, wdeps };
  };
  const withNotes = (text: string, notes: string[]) =>
    notes.length ? `${text}\n${notes.join('\n')}` : text;
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
      // any local argv, `rm` included: not an additive update, so clients ask before they run it
      annotations: MUT(true, false),
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

  server.registerTool(
    'worktree_add',
    {
      title: 'Worktree add',
      description:
        "Make an isolated checkout of this repository on a branch, in the sibling folder <repo>.worktrees/<branch>, with the files its own manifest's worktree: section (plus the main checkout's override) copies or links, its own slot (ports shifted by that manifest's vars), its slug (the project slug this checkout runs under, default <project>-w<slot>) and the install. Then drive its stand with project: <its path> on every call.",
      inputSchema: {
        project: commonInput.project,
        branch: z
          .string()
          .min(1)
          .describe(
            'The branch to check out; made from `from` when it does not exist yet'
          ),
        from: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Where a new branch starts (default: the main checkout's HEAD)"
          ),
        slot: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('A specific slot (default: the lowest free one)'),
        slug: z
          .string()
          .optional()
          .describe(
            'The project slug this checkout runs under (default: <project>-w<slot>); project stays the project root'
          ),
        install: z
          .boolean()
          .optional()
          .describe(
            "Run the install command in the new checkout (default true): the manifest's worktree.install, else by the lockfile"
          ),
      },
      annotations: MUT(false, false),
    },
    (args) =>
      runTool(async () => {
        const notes: string[] = [];
        const { manifest, wdeps } = await worktreeCtx(args.project, notes);
        const r = await worktreeAdd(
          manifest,
          {
            branch: args.branch,
            from: args.from,
            slot: args.slot,
            project: args.slug,
            install: args.install ?? true,
          },
          wdeps
        );
        return {
          text: withNotes(renderWorktreeAdded(r), notes),
          data: { ...r, notes },
        };
      })
  );

  server.registerTool(
    'worktree_ls',
    {
      title: 'Worktree ls',
      description:
        'Every checkout of this repository on this host: its slot (0 is the main checkout), project slug, branch, how many of its apps are online, its lease state and its path. A read only: a slot whose folder is gone shows (gone) as its branch until worktree_add or worktree_remove frees it.',
      inputSchema: { project: commonInput.project },
      annotations: RO,
    },
    (args) =>
      runTool(async () => {
        const notes: string[] = [];
        const { manifest, wdeps } = await worktreeCtx(args.project, notes);
        const rows = await worktreeLs(manifest, wdeps);
        return {
          text: withNotes(renderWorktrees(rows), notes),
          data: { rows, notes },
        };
      })
  );

  server.registerTool(
    'worktree_remove',
    {
      title: 'Worktree remove',
      description:
        'Stop and delete the apps of a worktree (freeing its leases), remove the checkout and free its slot; the branch stays. ref is its slot number, path or branch. A checkout with uncommitted or untracked changes is refused unless force, which discards them. The main checkout (slot 0) is never removed.',
      inputSchema: {
        project: commonInput.project,
        ref: z
          .string()
          .min(1)
          .describe('The worktree: its slot number, path or branch'),
        force: z
          .boolean()
          .optional()
          .describe(
            'Remove it even with uncommitted or untracked changes, discarding them (default false)'
          ),
      },
      annotations: MUT(true, false),
    },
    (args) =>
      runTool(async () => {
        const notes: string[] = [];
        const { manifest, wdeps } = await worktreeCtx(args.project, notes);
        const r = await worktreeRemove(
          manifest,
          args.ref,
          { force: args.force ?? false },
          wdeps
        );
        return {
          text: withNotes(renderWorktreeRemoved(r), notes),
          data: { ...r, notes },
        };
      })
  );
}

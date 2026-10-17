import fs from 'node:fs';
import path from 'node:path';
import { LOG_STAMP } from '../ecosystem.js';
import { McprocError } from '../errors.js';
import type { Context } from '../resolve.js';
import { stateDir } from '../state.js';

/** The pm2 process name of the host's lease watcher. */
export const WATCHER_NAME = 'mcproc-watcher';
/** The pm2 namespace the lease watcher runs in, apart from every project's. */
export const WATCHER_NS = 'mcproc';

/** The CLI file the watcher's node runs: MCPROC_CLI_ENTRY, else the running CLI's own entry when it is the built bundle. */
export function watcherEntry(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): string {
  if (env.MCPROC_CLI_ENTRY) return path.resolve(env.MCPROC_CLI_ENTRY);
  const own = argv[1] ?? '';
  if (own.endsWith('cli.js')) return path.resolve(own);
  throw new McprocError(
    'NOT_STARTED',
    `cannot launch the lease watcher: this mcproc runs from ${own || 'an unknown entry'}, not from a built cli.js`,
    {
      hint: 'Set MCPROC_CLI_ENTRY to the dist/cli.js the watcher should run (a dev checkout: build it to the side).',
    }
  );
}

/** The watcher as one pm2 process per daemon: online already, or started from an ecosystem file in the state directory. */
export async function ensureWatcher(
  ctx: Context,
  dir = stateDir()
): Promise<'online' | 'started'> {
  const procs = await ctx.pm2.jlist();
  const w = procs.find(
    (p) => p.name === WATCHER_NAME && p.namespace === WATCHER_NS
  );
  if (w && w.status === 'online') return 'online';
  const entry = watcherEntry();
  const file = path.join(dir, 'watcher.ecosystem.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        apps: [
          {
            name: WATCHER_NAME,
            namespace: WATCHER_NS,
            cwd: dir,
            script: process.execPath,
            args: [entry, 'watch-leases'],
            interpreter: 'none',
            // the watcher reads this state directory and drives this daemon, whatever the shell pm2 inherits
            env: { MCPROC_STATE_DIR: dir, ...(ctx.pm2.env() ?? {}) },
            autorestart: false,
            treekill: true,
            log_date_format: LOG_STAMP,
          },
        ],
      },
      null,
      2
    )
  );
  await ctx.pm2.startOrRestart(file, WATCHER_NAME);
  return 'started';
}

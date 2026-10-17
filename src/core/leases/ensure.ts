import fs from 'node:fs';
import path from 'node:path';
import { LOG_STAMP } from '../ecosystem.js';
import { McprocError } from '../errors.js';
import type { Context } from '../resolve.js';
import { stateDir } from '../state.js';
import { LeaseStore } from './store.js';

/** The pm2 process name of the host's lease watcher. */
export const WATCHER_NAME = 'mcproc-watcher';
/** The pm2 namespace the lease watcher runs in, apart from every project's. */
export const WATCHER_NS = 'mcproc';
/** The note an idle watcher leaves in the state directory as it exits: `{ "exiting_at": "<ISO>" }`. */
export const WATCHER_NOTE = 'watcher.json';
/** An exit note younger than this means the online watcher is on its way out. */
const EXIT_FRESH_MS = 5000;
/** How long a start waits for a leaving watcher to be gone before it trusts it after all. */
const EXIT_WAIT_MS = 3000;
const EXIT_POLL_MS = 250;

/** When the watcher last noted its idle exit in `dir`, in epoch ms; null without a readable note. */
function exitingAt(dir: string): number | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(dir, WATCHER_NOTE), 'utf8')
    ) as { exiting_at?: unknown };
    const at =
      typeof v.exiting_at === 'string' ? Date.parse(v.exiting_at) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

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

/**
 * The watcher as one pm2 process per daemon: online already, or started from an ecosystem file in the state directory.
 * An online watcher without a fresh exit note is trusted at once; one whose note is fresh is leaving after an idle exit
 * and is waited for (up to EXIT_WAIT_MS) before the lease lock is taken, so the lock is never held through that wait.
 * Then, under the lock, pm2 is asked again: an online watcher is trusted unless it is the leaving one (its note still in
 * place), else a fresh one is started, so two starts that queue at once launch one watcher (a second launch would
 * restart the first, and its tree).
 */
export async function ensureWatcher(
  ctx: Context,
  dir = stateDir()
): Promise<'online' | 'started'> {
  let leaving: number | null = null;
  if (await watcherOnline(ctx)) {
    // no fresh note: it stays, since it cannot leave while a lease is pending (see the watcher's leaveIdle)
    const at = exitingAt(dir);
    if (at === null || Date.now() - at >= EXIT_FRESH_MS) return 'online';
    leaving = at;
    const until = Date.now() + EXIT_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, EXIT_POLL_MS));
      if (!(await watcherOnline(ctx))) break;
    }
  }
  return new LeaseStore(dir).withLock(() => lookAndLaunch(ctx, dir, leaving));
}

/** Whether the watcher's pm2 process is online on the context's daemon. */
async function watcherOnline(ctx: Context): Promise<boolean> {
  return (await ctx.pm2.jlist()).some(
    (p) =>
      p.name === WATCHER_NAME &&
      p.namespace === WATCHER_NS &&
      p.status === 'online'
  );
}

/**
 * ensureWatcher's look and launch, under the lease lock: an online watcher is left alone, else a fresh one is started.
 * `leaving` is the exit note a start waited on: while that note is still in place (no launch took it meanwhile), the
 * online watcher is the one on its way out and a fresh one is started over it, which is safe since it passed leaveIdle
 * and so runs no start.
 */
async function lookAndLaunch(
  ctx: Context,
  dir: string,
  leaving: number | null
): Promise<'online' | 'started'> {
  if (
    (await watcherOnline(ctx)) &&
    (leaving === null || exitingAt(dir) !== leaving)
  )
    return 'online';
  const entry = watcherEntry();
  const file = path.join(dir, 'watcher.ecosystem.json');
  fs.mkdirSync(dir, { recursive: true });
  // a fresh watcher: the note of the one before it no longer applies
  fs.rmSync(path.join(dir, WATCHER_NOTE), { force: true });
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
            // the watcher reads this state directory, drives this daemon and spawns its children from this same
            // bundle, whatever the shell pm2 inherits
            env: {
              MCPROC_STATE_DIR: dir,
              ...(process.env.MCPROC_CLI_ENTRY
                ? { MCPROC_CLI_ENTRY: entry }
                : {}),
              ...(ctx.pm2.env() ?? {}),
            },
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

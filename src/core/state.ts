import os from 'node:os';
import path from 'node:path';

/** The host state directory: MCPROC_STATE_DIR, else $XDG_STATE_HOME/mcproc, else ~/.local/state/mcproc. Leases and the slot registry live there, per host, never per project. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MCPROC_STATE_DIR) return path.resolve(env.MCPROC_STATE_DIR);
  return path.join(
    env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
    'mcproc'
  );
}

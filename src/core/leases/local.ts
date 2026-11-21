import { DEFAULT_SHELL, type Host, parseShell } from '../manifest.js';

/**
 * This machine as the lease queue sees it: a plain local shell in `cwd`, no ssh, no docker. The queue lives in this
 * machine's state directory, so its memory and its watcher are read here, whatever checkout the caller stands in.
 */
export const localHost = (cwd: string): Host => ({
  name: 'local',
  local: true,
  ssh_args: [],
  cwd,
  readonly: false,
  shell: parseShell(DEFAULT_SHELL),
  env: {},
});

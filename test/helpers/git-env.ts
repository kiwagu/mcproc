/** The two git variables the tests set themselves: no global and no system config. */
const KEEP = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);

/**
 * Deletes from `env` every variable whose name starts with GIT_ except GIT_CONFIG_GLOBAL and GIT_CONFIG_NOSYSTEM, and
 * returns `env`. A suite run from a git hook or from a shell that exported them would otherwise steer every git a test
 * runs: to another repository or index (GIT_DIR, GIT_INDEX_FILE…), another object store (GIT_OBJECT_DIRECTORY), another
 * file for `git config` (GIT_CONFIG), or settings such as a hooks directory (GIT_CONFIG_COUNT with its pairs,
 * GIT_CONFIG_PARAMETERS). test/setup.ts applies it to the process; every helper that builds an environment for git or
 * for a CLI that runs git applies it again.
 */
export function stripGitVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const k of Object.keys(env))
    if (k.startsWith('GIT_') && !KEEP.has(k)) delete env[k];
  return env;
}

/**
 * git's variables for a repository: its git directory, work tree, index, common directory and the prefix git hands an
 * alias. A suite run from a git hook or from a shell that exported them would pass them on, and every git a test runs
 * would act on that repository instead of the temp one in its cwd. test/setup.ts drops them from the process, and every
 * helper that builds an environment for git or for a CLI that runs git drops them again.
 */
export const GIT_REPO_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
] as const;

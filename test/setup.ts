import fs from 'node:fs';
import os from 'node:os';
import { afterAll } from 'vitest';
import { GIT_REPO_VARS } from './helpers/git-env.js';
import { suiteStateDir } from './helpers/state-dir.js';

// No test reads this machine's git config or runs its hooks: a global or system config may set a hooks directory
// (git worktree add fires post-checkout in the temp repos), sign commits or rewrite URLs. Every git the tests run, in
// this process or in a child CLI, inherits this; a fixture that commits passes its identity with -c.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// Nor does any test git act on a repository named from outside: a suite run from a git hook or from a shell that
// exported git's variables for a repository would hand them to every fixture's init, add and commit, whatever its cwd.
for (const k of GIT_REPO_VARS) delete process.env[k];

// Every test file gets a state directory of its own, so no test reads or writes this machine's real leases and slot
// registry: an inherited MCPROC_STATE_DIR is kept only when it lies inside the temp directory, any other is replaced
// by a fresh name (see suiteStateDir). A test that needs a known directory still sets MCPROC_STATE_DIR itself and puts
// the previous value back. A fresh directory goes once the file is done, and the variable with it, so the next file in
// the same worker names a fresh one (a worker that is killed fires no exit event, so the cleanup cannot wait for the
// process).
const { dir, fresh } = suiteStateDir(process.env.MCPROC_STATE_DIR, os.tmpdir());
process.env.MCPROC_STATE_DIR = dir;
if (fresh)
  afterAll(() => {
    if (process.env.MCPROC_STATE_DIR === dir)
      delete process.env.MCPROC_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

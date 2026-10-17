import fs from 'node:fs';
import os from 'node:os';
import { afterAll } from 'vitest';
import { suiteStateDir } from './helpers/state-dir.js';

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

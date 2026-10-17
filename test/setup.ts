import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Every test file gets a state directory of its own, so no test reads or writes this machine's real leases and slot
// registry; a test that needs a known directory still sets MCPROC_STATE_DIR itself and puts the previous value back.
// The directory goes once the file is done, and the variable with it, so the next file in the same worker makes a
// fresh one (a worker that is killed fires no exit event, so the cleanup cannot wait for the process to end).
if (!process.env.MCPROC_STATE_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-test-state-'));
  process.env.MCPROC_STATE_DIR = dir;
  afterAll(() => {
    if (process.env.MCPROC_STATE_DIR === dir)
      delete process.env.MCPROC_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

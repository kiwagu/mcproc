import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, suiteStateDir } from '../helpers/state-dir.js';

describe('the suite state directory (test/setup.ts)', () => {
  it('this file runs with a state directory inside the temp directory', () => {
    expect(isInside(process.env.MCPROC_STATE_DIR ?? '/', os.tmpdir())).toBe(
      true
    );
  });

  it('none inherited: a fresh name inside the temp directory, not made until something writes there', () => {
    const r = suiteStateDir(undefined, os.tmpdir());
    expect(r.fresh).toBe(true);
    expect(isInside(r.dir, os.tmpdir())).toBe(true);
    expect(path.basename(r.dir)).toMatch(/^mcproc-test-state-[0-9a-f]{12}$/);
    expect(fs.existsSync(r.dir)).toBe(false);
    expect(suiteStateDir(undefined, os.tmpdir()).dir).not.toBe(r.dir);
  });

  it('one inherited inside the temp directory is kept', () => {
    const own = path.join(os.tmpdir(), 'mcproc-run-state', 'x');
    expect(suiteStateDir(own, os.tmpdir())).toEqual({
      dir: own,
      fresh: false,
    });
  });

  it('a real state directory exported in the shell is replaced, never used', () => {
    const real = path.join(os.homedir(), '.local', 'state', 'mcproc');
    const r = suiteStateDir(real, os.tmpdir());
    expect(r.fresh).toBe(true);
    expect(r.dir).not.toBe(real);
    expect(isInside(r.dir, os.tmpdir())).toBe(true);
  });

  it('the temp directory itself, or a path that only starts like it, is replaced', () => {
    const tmp = os.tmpdir();
    for (const p of [tmp, `${tmp}-other/state`, path.join(tmp, '..', 'st')]) {
      const r = suiteStateDir(p, tmp);
      expect(r.fresh).toBe(true);
      expect(r.dir).not.toBe(path.resolve(p));
    }
  });

  it('throws when the directory it would use is not inside the temp directory', () => {
    expect(() =>
      suiteStateDir(undefined, os.tmpdir(), () => '/var/lib/mcproc-state')
    ).toThrow(/not inside the temp directory/);
  });
});

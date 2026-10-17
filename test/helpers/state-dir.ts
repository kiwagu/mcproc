import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A path as the filesystem sees it: symlinks resolved when it exists, else just made absolute. */
const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Whether `p` lies strictly inside `dir` (the directory itself is not inside), both taken as the filesystem sees them. */
export function isInside(p: string, dir: string): boolean {
  const rel = path.relative(real(dir), real(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The state directory a test file runs with. An inherited MCPROC_STATE_DIR inside the temp directory is kept (a run
 * that set one up on purpose); any other one, such as this machine's real state directory exported in the shell, is
 * replaced by a fresh name inside the temp directory, so the suite never reads or writes real leases or slot
 * registries. The fresh one is only named, not made: the code under test makes it on its first write, so a file whose
 * tests are all skipped (its hooks never run, the cleanup with them) leaves nothing behind. Throws when the directory
 * it settles on is not inside the temp directory after all.
 */
export function suiteStateDir(
  inherited: string | undefined,
  tmp: string,
  name: (prefix: string) => string = (prefix) =>
    `${prefix}${crypto.randomBytes(6).toString('hex')}`
): { dir: string; fresh: boolean } {
  if (inherited && isInside(inherited, tmp))
    return { dir: path.resolve(inherited), fresh: false };
  const dir = name(path.join(tmp, 'mcproc-test-state-'));
  if (!isInside(dir, tmp))
    throw new Error(
      `the test state directory ${dir} is not inside the temp directory ${tmp}: the suite would touch real leases`
    );
  return { dir, fresh: true };
}

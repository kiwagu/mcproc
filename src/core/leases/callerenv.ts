import fs from 'node:fs';
import path from 'node:path';
import { withoutPm2Keys } from '../pm2.js';

/**
 * The environments queued starts' callers left for their runs. A start admitted at once runs in its caller's process,
 * with its caller's environment; a queued one is run later by the watcher, whose own environment is that of whoever
 * launched it. So the gate keeps the caller's environment beside the lease, in a file only its owner can read, and the
 * watcher hands it to the start's child and deletes it: a queued start runs as it would have at once. The file holds
 * whatever the caller exported, secrets too, for as long as the start waits; the store drops it once the lease ends, and
 * its prune sweeps what a crash left.
 */
export const CALLER_ENV_DIR = 'caller-env';

const dirOf = (stateDir: string): string => path.join(stateDir, CALLER_ENV_DIR);
const fileOf = (stateDir: string, id: string): string =>
  path.join(dirOf(stateDir), `${id}.json`);

/**
 * Keeps `env` for lease `id`, without what pm2 wrote into it (see withoutPm2Keys): written to a fresh file only its
 * owner can read, in a directory created for its owner alone, and renamed into place. Throws when it cannot be kept.
 */
export function keepCallerEnv(
  stateDir: string,
  id: string,
  env: Record<string, string | undefined>
): void {
  const d = dirOf(stateDir);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const f = fileOf(stateDir, id);
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(withoutPm2Keys(env)), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tmp, f);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The environment kept for lease `id`, deleted as it is taken; null when none is kept. One that cannot be read, or read
 * as an environment, is deleted too, and taken as none. Throws when it cannot be deleted.
 */
export function takeCallerEnv(
  stateDir: string,
  id: string
): Record<string, string> | null {
  const f = fileOf(stateDir, id);
  let text: string | null = null;
  try {
    text = fs.readFileSync(f, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // what cannot be read is no environment to run with, and must not stay on disk either
  }
  fs.rmSync(f, { force: true });
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed))
    if (typeof v === 'string') env[k] = v;
  return env;
}

/** Deletes the environment kept for lease `id`, if any. */
export function dropCallerEnv(stateDir: string, id: string): void {
  fs.rmSync(fileOf(stateDir, id), { force: true });
}

/**
 * Deletes every kept environment but those of the leases in `keep`, and whatever a writer that died mid-write left;
 * returns how many entries it removed. Run under the store's lock: a gate keeps an environment under it.
 */
export function sweepCallerEnvs(
  stateDir: string,
  keep: ReadonlySet<string>
): number {
  let names: string[];
  try {
    names = fs.readdirSync(dirOf(stateDir));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (name.endsWith('.json') && keep.has(name.slice(0, -'.json'.length)))
      continue;
    fs.rmSync(path.join(dirOf(stateDir), name), {
      recursive: true,
      force: true,
    });
    n++;
  }
  return n;
}

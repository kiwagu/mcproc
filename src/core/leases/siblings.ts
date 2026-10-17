import fs from 'node:fs';
import type { Spawner } from '../../transport/types.js';
import type { LsRow } from '../list.js';
import { rowsFor, snapshot } from '../list.js';
import type { Manifest } from '../manifest.js';
import { isRunning } from '../pm2.js';
import { connect, prepare } from '../resolve.js';
import {
  type Registry,
  readRegistry,
  registryPath,
  siblingsOf,
} from '../slots.js';
import { stateDir } from '../state.js';
import type { AppMeasure } from './admission.js';

const MIB = 1024 * 1024;

/** The main checkout the registry is keyed by: what the override recorded for a worktree, else this root itself. */
export const repoOf = (m: Manifest): string => m.repo;

/** The slot registry of a manifest's repository, or null when `worktree add` never ran for it. */
export function registryOf(m: Manifest, dir = stateDir()): Registry | null {
  return readRegistry(registryPath(dir, m.base_project, repoOf(m)));
}

/** One checkout's rows, read locally with the full probe (containers included) and no url checks. */
export async function listCheckout(
  root: string,
  spawner?: Spawner
): Promise<LsRow[]> {
  const prep = prepare({ project: root });
  const ctx = await connect(prep, { spawner });
  // the full probe with the containers' memory: this is the measurement the estimate rests on
  const snap = await snapshot(ctx, {
    urls: 'none',
    cpu: 'none',
    containers: 'probe',
  });
  return rowsFor(ctx, snap, Object.keys(ctx.manifest.apps));
}

/**
 * What the other checkouts of the repository show for each app that is online there, the largest value per app
 * (the conservative estimate), from the registry's slots whose path still exists; a checkout that does not answer
 * contributes nothing.
 */
export async function measureSiblings(
  m: Manifest,
  deps: {
    registry: Registry | null;
    list: (root: string) => Promise<LsRow[]>;
    exists?: (p: string) => boolean;
  }
): Promise<Map<string, AppMeasure>> {
  const out = new Map<string, AppMeasure>();
  if (!deps.registry) return out;
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  for (const { slot, entry } of siblingsOf(deps.registry, m.root)) {
    if (!exists(entry.path)) continue;
    let rows: LsRow[];
    try {
      rows = await deps.list(entry.path);
    } catch {
      continue;
    }
    for (const r of rows) {
      if (!isRunning(r.status) || r.memory <= 0) continue;
      const mib = Math.ceil(r.memory / MIB);
      const prev = out.get(r.app);
      if (!prev || mib > prev.mib) out.set(r.app, { mib, slot });
    }
  }
  return out;
}

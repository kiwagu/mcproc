import fs from 'node:fs';
import type { Spawner } from '../../transport/types.js';
import type { LsRow } from '../list.js';
import { rowsFor, snapshot } from '../list.js';
import { findManifestPath, type Manifest } from '../manifest.js';
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

/**
 * Whether `root` is a checkout with a manifest of its own. The manifest search walks up, so a path without one (gone,
 * or nested in another checkout) would otherwise stand for the project that encloses it.
 */
export function ownsManifest(root: string): boolean {
  const found = findManifestPath(root);
  if (!found) return false;
  try {
    return fs.realpathSync(found.root) === fs.realpathSync(root);
  } catch {
    return false; // gone meanwhile
  }
}

/** One checkout's rows, read locally with the full probe (containers included) and no url checks; none when `root` has no manifest of its own. */
export async function listCheckout(
  root: string,
  spawner?: Spawner
): Promise<LsRow[]> {
  if (!ownsManifest(root)) return [];
  const ctx = await connect(prepare({ project: root }), { spawner });
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
 * contributes nothing. The checkouts are read at the same time and folded in slot order, so a tie goes to the lowest slot.
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
  const read = await Promise.all(
    siblingsOf(deps.registry, m.root)
      .filter(({ entry }) => exists(entry.path))
      .map(async ({ slot, entry }) => {
        try {
          return { slot, rows: await deps.list(entry.path) };
        } catch {
          return { slot, rows: [] as LsRow[] }; // a checkout that does not answer
        }
      })
  );
  for (const { slot, rows } of read) {
    for (const r of rows) {
      if (!isRunning(r.status) || r.memory <= 0) continue;
      const mib = Math.ceil(r.memory / MIB);
      const prev = out.get(r.app);
      if (!prev || mib > prev.mib) out.set(r.app, { mib, slot });
    }
  }
  return out;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McprocError } from './errors.js';

/** One checkout of a repository: where it is, which branch, and the project slug it runs under. */
export interface SlotEntry {
  path: string;
  branch: string | null;
  project: string;
}
/** The slots of one repository on this host: 0 is the main checkout, 1..N its worktrees. */
export interface Registry {
  repo: string;
  slots: Record<string, SlotEntry>;
}

/** `<base project>-<8 hex of sha256(main path)>`: two unrelated repositories named alike never share slots. */
export function registryKey(baseProject: string, repo: string): string {
  return `${baseProject}-${crypto.createHash('sha256').update(repo).digest('hex').slice(0, 8)}`;
}
/** The file that holds a repository's registry under the host state directory. */
export function registryPath(
  stateDir: string,
  baseProject: string,
  repo: string
): string {
  return path.join(stateDir, 'slots', `${registryKey(baseProject, repo)}.json`);
}
/** A registry for a repository with no slots claimed yet. */
export function emptyRegistry(repo: string): Registry {
  return { repo, slots: {} };
}
/** Reads a registry file, or null when it does not exist. */
export function readRegistry(file: string): Registry | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Registry;
}
/** Writes a registry file atomically, creating its directory when needed. */
export function writeRegistry(file: string, r: Registry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, file);
}
/** The registry with slot 0 set to the main checkout. */
export function withMain(r: Registry, entry: SlotEntry): Registry {
  return { ...r, slots: { ...r.slots, '0': entry } };
}
/** The lowest free slot in 1..max, or `want` when it is free; slot 0 is never claimed. */
export function claimSlot(
  r: Registry,
  opts: { max: number; want?: number; entry: SlotEntry }
): { registry: Registry; slot: number } {
  if (opts.want !== undefined) {
    if (opts.want < 1 || opts.want > opts.max)
      throw new McprocError(
        'BAD_ARGUMENT',
        `slot ${opts.want} is outside 1..${opts.max} (slot 0 is the main checkout)`
      );
    if (Object.hasOwn(r.slots, String(opts.want)))
      throw new McprocError(
        'SLOT_TAKEN',
        `slot ${opts.want} is taken by ${r.slots[String(opts.want)].path}`,
        { hint: 'Pick another slot, or remove that worktree first.' }
      );
    return {
      registry: { ...r, slots: { ...r.slots, [opts.want]: opts.entry } },
      slot: opts.want,
    };
  }
  for (let s = 1; s <= opts.max; s++)
    if (!Object.hasOwn(r.slots, String(s)))
      return {
        registry: { ...r, slots: { ...r.slots, [s]: opts.entry } },
        slot: s,
      };
  throw new McprocError(
    'NO_FREE_SLOT',
    `all ${opts.max} worktree slots of ${r.repo} are taken`,
    {
      hint: 'Remove a worktree (worktree remove), or raise worktree.slots in the manifest.',
    }
  );
}
/** The registry without the given slot. */
export function releaseSlot(r: Registry, slot: number): Registry {
  const slots = { ...r.slots };
  delete slots[String(slot)];
  return { ...r, slots };
}
/** A path as the filesystem sees it: symlinks resolved when it exists, else just made absolute. */
function realOf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
/** Drops the slots (never 0) whose checkout path no longer exists; returns them. */
export function reclaimGone(
  r: Registry,
  exists: (p: string) => boolean
): { registry: Registry; freed: number[] } {
  const freed: number[] = [];
  let out = r;
  for (const [k, e] of Object.entries(r.slots)) {
    if (k === '0' || exists(realOf(e.path))) continue;
    out = releaseSlot(out, Number(k));
    freed.push(Number(k));
  }
  return { registry: out, freed: freed.sort((a, b) => a - b) };
}
/** Every other checkout of the repository, lowest slot first. */
export function siblingsOf(
  r: Registry,
  root: string
): { slot: number; entry: SlotEntry }[] {
  return Object.entries(r.slots)
    .filter(([, e]) => realOf(e.path) !== realOf(root))
    .map(([k, entry]) => ({ slot: Number(k), entry }))
    .sort((a, b) => a.slot - b.slot);
}

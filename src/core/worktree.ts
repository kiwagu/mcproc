import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describeError, McprocError } from './errors.js';
import { spawnRun } from './exec.js';
import { actOn, Fleet, type Connector } from './fleet.js';
import { ownsManifest } from './leases/siblings.js';
import { LeaseStore } from './leases/store.js';
import {
  loadManifest,
  MANIFEST_REL,
  type Manifest,
  type VarInfo,
} from './manifest.js';
import { NAME_RE } from './names.js';
import { writeOverride } from './override.js';
import { isRunning, type Pm2Process } from './pm2.js';
import type { Context } from './resolve.js';
import {
  claimSlot,
  emptyRegistry,
  readRegistry,
  realOf,
  reclaimGone,
  registryPath,
  releaseSlot,
  withMain,
  writeRegistry,
  type Registry,
} from './slots.js';
import { stateDir } from './state.js';
import { shq } from '../transport/quote.js';

/** Runs git with these arguments in `cwd` and answers its exit code and output; it never throws. */
export type GitRunner = (
  args: string[],
  cwd: string
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** git as a child process, never through a shell. */
export const gitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          // execFile puts the exit status in err.code; a git that cannot be spawned has a string code there
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr) || (err ? err.message : ''),
        })
    );
  });

const gitOk = async (
  git: GitRunner,
  args: string[],
  cwd: string
): Promise<string> => {
  const r = await git(args, cwd);
  if (r.code !== 0)
    throw new McprocError(
      'TRANSPORT_FAILED',
      `git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`
    );
  return r.stdout;
};

/** Whether anything is at `p`, a dangling symlink included. */
const present = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The main checkout of the repository `root` belongs to: the parent of git's common dir, real path. */
export async function mainCheckout(
  root: string,
  git: GitRunner
): Promise<string> {
  const common = (
    await gitOk(git, ['rev-parse', '--git-common-dir'], root)
  ).trim();
  return fs.realpathSync(path.dirname(path.resolve(root, common)));
}

/** Where worktrees go: the manifest's `worktree.dir` resolved from the main checkout, else `<main>.worktrees`. */
export function worktreeDir(m: Manifest, main: string): string {
  return m.worktree.dir
    ? path.resolve(main, m.worktree.dir)
    : `${main}.worktrees`;
}

/** The install command of a fresh worktree: as declared, none when `false`, else by the lockfile; null when there is none to detect. */
export function installCommand(m: Manifest, root: string): string | null {
  if (m.worktree.install === false) return null;
  if (typeof m.worktree.install === 'string') return m.worktree.install;
  const has = (f: string) => fs.existsSync(path.join(root, f));
  if (has('bun.lock') || has('bun.lockb')) return 'bun install';
  if (has('yarn.lock')) return 'yarn install';
  if (has('pnpm-lock.yaml')) return 'pnpm install';
  if (has('package-lock.json')) return 'npm install';
  return null;
}

/** What `copy` and `link` mean for one target: each entry a path or a glob relative to the main checkout. */
export function planCopies(
  main: string,
  target: string,
  copy: string[],
  link: string[],
  fsDeps: {
    exists?: (p: string) => boolean;
    glob?: (pattern: string, cwd: string) => string[];
  } = {}
): {
  copies: { from: string; to: string }[];
  links: { from: string; to: string }[];
  missing: string[];
} {
  const exists = fsDeps.exists ?? ((p) => fs.existsSync(p));
  const glob = fsDeps.glob ?? ((pattern, cwd) => fs.globSync(pattern, { cwd }));
  const copies: { from: string; to: string }[] = [];
  const missing: string[] = [];
  for (const entry of copy) {
    const hits = /[*?[]/.test(entry)
      ? glob(entry, main).sort()
      : exists(path.join(main, entry))
        ? [entry]
        : [];
    if (hits.length === 0) {
      missing.push(entry);
      continue;
    }
    for (const h of hits)
      copies.push({ from: path.join(main, h), to: path.join(target, h) });
  }
  const links = link.map((l) => ({
    from: path.join(main, l),
    to: path.join(target, l),
  }));
  return { copies, links, missing };
}

/** What the worktree commands reach outside their arguments: git, the state directory, the install, pm2; tests pass fakes. */
export interface WorktreeDeps {
  git: GitRunner;
  stateDir: string;
  /** runs the install command in the worktree; its exit code */
  run(cmd: string, cwd: string): Promise<number>;
  log(line: string): void;
  jlist(): Promise<Pm2Process[]>;
  /** stops and deletes every app of a checkout; the names it stopped; with `force` a manifest that does not load is noted, not refused */
  stopAll(root: string, opts: { force: boolean }): Promise<string[]>;
  exists?(p: string): boolean;
  glob?(pattern: string, cwd: string): string[];
}
/** What `worktree add` made: the checkout, its branch, slot and project slug, what it copied, linked and installed, its vars and how to go on. */
export interface WorktreeAdded {
  path: string;
  branch: string;
  created_branch: boolean;
  slot: number;
  project: string;
  repo: string;
  copied: string[];
  linked: string[];
  missing: string[];
  installed: string | null;
  vars: VarInfo[];
  next: string;
}

/**
 * The registry of the repository as it stands: slot 0 set to the main checkout, the slots whose checkout is gone
 * dropped (each one logged). Called under the host's lease lock whenever the result is written back.
 */
function registryFor(
  m: Manifest,
  main: string,
  mainBranch: string | null,
  deps: WorktreeDeps
): { file: string; registry: Registry } {
  const file = registryPath(deps.stateDir, m.base_project, main);
  const read = withMain(readRegistry(file) ?? emptyRegistry(main), {
    path: main,
    branch: mainBranch,
    project: m.base_project,
  });
  const { registry, freed } = reclaimGone(
    read,
    deps.exists ?? ((p) => fs.existsSync(p))
  );
  for (const s of freed) deps.log(`slot ${s} reclaimed: its checkout is gone`);
  return { file, registry };
}

/** The registry as it stands, written back under the host's lease lock: slot 0 and the reclaimed slots persist. */
function settleRegistry(
  m: Manifest,
  main: string,
  mainBranch: string | null,
  deps: WorktreeDeps
): Promise<Registry> {
  return new LeaseStore(deps.stateDir).withLock(() => {
    const { file, registry } = registryFor(m, main, mainBranch, deps);
    writeRegistry(file, registry);
    return registry;
  });
}

/** The branch checked out at `root`, or null when its HEAD is detached. */
async function currentBranch(
  root: string,
  git: GitRunner
): Promise<string | null> {
  const r = await git(['branch', '--show-current'], root);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** `git worktree list --porcelain` as real path → branch (null when detached). */
async function worktreeList(
  main: string,
  git: GitRunner
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  let cur: string | null = null;
  for (const line of (
    await gitOk(git, ['worktree', 'list', '--porcelain'], main)
  ).split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = realOf(line.slice(9));
      out.set(cur, null);
    } else if (line.startsWith('branch ') && cur)
      out.set(cur, line.slice(7).replace(/^refs\/heads\//, ''));
  }
  return out;
}

/** The real path of `p` as far as it exists, the rest joined as given: a folder about to be made gets its real path. */
function realAhead(p: string): string {
  const rest: string[] = [];
  let d = path.resolve(p);
  while (!present(d) && path.dirname(d) !== d) {
    rest.unshift(path.basename(d));
    d = path.dirname(d);
  }
  return path.join(realOf(d), ...rest);
}

/** A path as a shell word: bare when it needs no quoting. */
const shPath = (p: string): string => (/^[\w./@%+:-]+$/.test(p) ? p : shq(p));

/**
 * A worktree of this repository on `branch` (made from `from`, default the main checkout's HEAD, when the branch is
 * new) in the sibling folder, with the declared copies and links, the override that gives it its slot and project
 * slug, the install, and its slot in the registry. The slot is claimed and the folder made under the host's lease
 * lock, so parallel runs never share a slot; when git then fails, the slot is given back.
 */
export async function worktreeAdd(
  m: Manifest,
  opts: {
    branch: string;
    from?: string;
    slot?: number;
    project?: string;
    install: boolean;
  },
  deps: WorktreeDeps
): Promise<WorktreeAdded> {
  if (opts.slot !== undefined && !Number.isInteger(opts.slot))
    throw new McprocError(
      'BAD_ARGUMENT',
      `slot must be a whole number, not ${opts.slot}`
    );
  if (opts.project !== undefined && !NAME_RE.test(opts.project))
    throw new McprocError(
      'BAD_ARGUMENT',
      `project slug "${opts.project}" must match ${NAME_RE.source}`
    );
  // the branch names the folder: a name git refuses never reaches the filesystem. No `--` here: check-ref-format
  // refuses one, and `--branch` takes the next argument as the name whatever it looks like (`-x` is refused as a name)
  if (
    (await deps.git(['check-ref-format', '--branch', opts.branch], m.root))
      .code !== 0
  )
    throw new McprocError(
      'BAD_ARGUMENT',
      `"${opts.branch}" is not a valid branch name`
    );
  const main = await mainCheckout(m.root, deps.git);
  const prefix = (
    await gitOk(deps.git, ['rev-parse', '--show-prefix'], m.root)
  ).trim();
  if (prefix)
    throw new McprocError(
      'BAD_ARGUMENT',
      `worktree add needs the manifest at the top of its checkout; ${m.root} is ${prefix} inside it`
    );
  for (const [p, b] of await worktreeList(main, deps.git))
    if (b === opts.branch)
      throw new McprocError(
        'WORKTREE_EXISTS',
        `branch ${opts.branch} is already checked out at ${p}`,
        {
          hint: present(p)
            ? 'Use that checkout, or remove it with worktree remove.'
            : 'That folder is gone: `git worktree prune` makes git forget it.',
        }
      );
  const target = realAhead(
    path.join(worktreeDir(m, main), ...opts.branch.split('/'))
  );
  const taken = () =>
    new McprocError('WORKTREE_EXISTS', `${target} exists already`, {
      hint: 'Remove it, or pick another branch name.',
    });
  if (present(target)) throw taken();
  const mainBranch = await currentBranch(main, deps.git);
  const store = new LeaseStore(deps.stateDir);
  const { file, slot, project } = await store.withLock(() => {
    const { file, registry } = registryFor(m, main, mainBranch, deps);
    const claimed = claimSlot(registry, {
      max: m.worktree.slots,
      want: opts.slot,
      entry: { path: target, branch: opts.branch, project: '' },
    });
    const project = opts.project ?? `${m.base_project}-w${claimed.slot}`;
    for (const [k, e] of Object.entries(registry.slots))
      if (e.project === project)
        throw new McprocError(
          'BAD_ARGUMENT',
          `project slug ${project} is the slug of slot ${k} (${e.path})`,
          { hint: 'Pass another project slug.' }
        );
    // the folder is made here: a parallel add sees it, and a reclaim never takes a slot whose folder is still empty
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.mkdirSync(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw taken();
      throw e;
    }
    writeRegistry(file, {
      ...claimed.registry,
      slots: {
        ...claimed.registry.slots,
        [claimed.slot]: { path: target, branch: opts.branch, project },
      },
    });
    return { file, slot: claimed.slot, project };
  });
  const exists =
    (
      await deps.git(
        ['show-ref', '--verify', '--quiet', '--', `refs/heads/${opts.branch}`],
        main
      )
    ).code === 0;
  try {
    await gitOk(
      deps.git,
      // `--` before the positionals: a `from` such as `--no-checkout` is a ref git refuses, never an option
      exists
        ? ['worktree', 'add', '--', target, opts.branch]
        : [
            'worktree',
            'add',
            '-b',
            opts.branch,
            '--',
            target,
            opts.from ?? 'HEAD',
          ],
      main
    );
  } catch (e) {
    try {
      fs.rmdirSync(target); // only while empty: whatever git left stays for a look
    } catch {}
    await store.withLock(() => {
      const r = readRegistry(file);
      if (r?.slots[String(slot)]?.path === target)
        writeRegistry(file, releaseSlot(r, slot));
    });
    throw e;
  }
  // the override first: whatever fails after it, the registered checkout never runs under the main's slug and vars
  writeOverride(target, {
    project,
    repo: main,
    vars: m.slot !== null ? { slot } : undefined,
  });
  // a .mcproc/.gitignore of the branch (a whitelist) already hides the override; else one that hides everything here
  const gi = path.join(target, '.mcproc', '.gitignore');
  if (!present(gi)) fs.writeFileSync(gi, '*\n');
  const plan = planCopies(main, target, m.worktree.copy, m.worktree.link, deps);
  let step = '';
  try {
    for (const c of plan.copies) {
      step = `copying ${c.from}`;
      fs.mkdirSync(path.dirname(c.to), { recursive: true });
      fs.cpSync(c.from, c.to, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
    for (const l of plan.links) {
      step = `linking ${l.from}`;
      fs.mkdirSync(path.dirname(l.to), { recursive: true });
      if (!present(l.to)) fs.symlinkSync(l.from, l.to);
    }
  } catch (e) {
    throw new McprocError(
      'BAD_ARGUMENT',
      `worktree ${target} is made (slot ${slot}, project ${project}, its override in place), but ${step} failed: ${(e as Error).message}`,
      {
        hint: "Clear what is in the way or fix the manifest's worktree: section, then copy it by hand or remove the worktree.",
      }
    );
  }
  for (const miss of plan.missing)
    deps.log(`copy: ${miss} is not in ${main}, skipped`);
  const install = opts.install ? installCommand(m, target) : null;
  if (install) {
    const code = await deps.run(install, target);
    if (code !== 0)
      deps.log(`${install} exited ${code} in ${target}; run it by hand`);
  }
  let vars: VarInfo[] = [];
  let next = `cd ${shPath(target)}`;
  // the manifest search walks up: without a manifest of its own the checkout would read an enclosing one (the main's)
  if (!ownsManifest(target))
    deps.log(
      `${target} has no manifest of its own (${MANIFEST_REL}): no vars, nothing to start`
    );
  else
    try {
      const wm = loadManifest(target);
      vars = wm.vars;
      const first = Object.keys(wm.profiles)[0] ?? Object.keys(wm.apps)[0];
      if (first) next += ` && mcproc start ${first}`;
    } catch (e) {
      deps.log(`the manifest of ${target} does not load: ${describeError(e)}`);
    }
  return {
    path: target,
    branch: opts.branch,
    created_branch: !exists,
    slot,
    project,
    repo: main,
    copied: plan.copies.map((c) => path.relative(main, c.from)),
    linked: plan.links.map((l) => path.relative(main, l.from)),
    missing: plan.missing,
    installed: install,
    vars,
    next,
  };
}

/** One checkout in the `worktree ls` table: its slot, project slug, path, branch, apps online and lease state. */
export interface WorktreeRow {
  slot: number;
  project: string;
  path: string;
  branch: string | null;
  online: number;
  lease: string | null;
  main: boolean;
}

/**
 * The registry as a table: every checkout with its branch, how many of its apps are online, and its lease state. A read
 * only: a slot whose folder is gone shows `(gone)` as its branch and stays until add or remove reclaims it, and slot 0
 * is shown from the main checkout without being recorded.
 */
export async function worktreeLs(
  m: Manifest,
  deps: WorktreeDeps
): Promise<WorktreeRow[]> {
  const main = await mainCheckout(m.root, deps.git);
  const file = registryPath(deps.stateDir, m.base_project, main);
  // a write is a rename: the file reads whole without the lock
  const registry = withMain(readRegistry(file) ?? emptyRegistry(main), {
    path: main,
    branch: await currentBranch(main, deps.git),
    project: m.base_project,
  });
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const branches = await worktreeList(main, deps.git);
  const procs = await deps.jlist();
  const leases = new LeaseStore(deps.stateDir).list();
  return Object.entries(registry.slots)
    .map(([k, e]) => ({
      slot: Number(k),
      project: e.project,
      path: e.path,
      branch:
        k !== '0' && !exists(realOf(e.path))
          ? '(gone)'
          : (branches.get(realOf(e.path)) ?? e.branch),
      online: procs.filter(
        (p) => p.namespace === e.project && isRunning(p.status)
      ).length,
      lease:
        leases.find(
          (l) =>
            realOf(l.root) === realOf(e.path) &&
            (l.state === 'pending' ||
              l.state === 'starting' ||
              l.state === 'running')
        )?.state ?? null,
      main: k === '0',
    }))
    .sort((a, b) => a.slot - b.slot);
}

/** What `worktree remove` did: the checkout it removed, the slot it freed, its branch (kept) and the apps it stopped. */
export interface WorktreeRemoved {
  path: string;
  slot: number;
  branch: string | null;
  stopped: string[];
}

/**
 * Stops the checkout's apps (freeing its leases), removes the worktree and frees its slot; the branch stays. `ref` is
 * a slot number, a path or a branch. Without `force` a checkout with uncommitted or untracked changes is refused.
 */
export async function worktreeRemove(
  m: Manifest,
  ref: string,
  opts: { force: boolean },
  deps: WorktreeDeps
): Promise<WorktreeRemoved> {
  const main = await mainCheckout(m.root, deps.git);
  const registry = await settleRegistry(
    m,
    main,
    await currentBranch(main, deps.git),
    deps
  );
  const hit = Object.entries(registry.slots).find(
    ([k, e]) => k === ref || realOf(e.path) === realOf(ref) || e.branch === ref
  );
  if (!hit)
    throw new McprocError(
      'NOT_A_WORKTREE',
      `${ref} is no slot, path or branch of ${main}`,
      { hint: 'worktree ls lists them.' }
    );
  const [k, e] = hit;
  if (k === '0')
    throw new McprocError(
      'BAD_ARGUMENT',
      'slot 0 is the main checkout; it cannot be removed'
    );
  const file = registryPath(deps.stateDir, m.base_project, main);
  /** frees the slot under the lock, read afresh: only while it still names this checkout */
  const free = () =>
    new LeaseStore(deps.stateDir).withLock(() => {
      const now = readRegistry(file);
      if (now?.slots[k]?.path === e.path)
        writeRegistry(file, releaseSlot(now, Number(k)));
    });
  if (!(await worktreeList(main, deps.git)).has(realOf(e.path))) {
    // an add that ended between its claim and git leaves an empty folder: nothing in it to stop or keep
    let empty = false;
    try {
      empty = fs.readdirSync(e.path).length === 0;
    } catch {}
    if (!empty)
      throw new McprocError(
        'NOT_A_WORKTREE',
        `${e.path} (slot ${k}) is no git worktree of ${main}`,
        { hint: 'Look at what is in it, remove it by hand, then worktree ls.' }
      );
    fs.rmdirSync(e.path);
    deps.log(`${e.path} was an empty folder git never filled: removed`);
    await free();
    return { path: e.path, slot: Number(k), branch: e.branch, stopped: [] };
  }
  if (!opts.force) {
    const st = await gitOk(deps.git, ['status', '--porcelain'], e.path);
    if (st.trim())
      throw new McprocError(
        'WORKTREE_DIRTY',
        `${e.path} has uncommitted or untracked changes`,
        { hint: 'Commit or stash them, or pass --force to discard them.' }
      );
  }
  const stopped = await deps.stopAll(e.path, { force: opts.force });
  await gitOk(
    deps.git,
    ['worktree', 'remove', ...(opts.force ? ['--force'] : []), '--', e.path],
    main
  );
  // the folders a branch with slashes made (`feat/` of feat/x) go when they are left empty
  const top = realOf(worktreeDir(m, main));
  for (
    let d = path.dirname(e.path);
    d.startsWith(`${top}${path.sep}`);
    d = path.dirname(d)
  ) {
    try {
      fs.rmdirSync(d);
    } catch {
      break; // not empty
    }
  }
  await free();
  return { path: e.path, slot: Number(k), branch: e.branch, stopped };
}

/**
 * Stops and deletes the apps of the checkout at `root` that run on writable hosts, and answers their names. A path
 * without a manifest of its own has none: the manifest search walks up, so it would stand for an enclosing project, the
 * main checkout among them. A manifest that does not load is refused, or noted with `force`; an app bound to a readonly
 * host is left alone with a note.
 */
export async function stopCheckout(
  root: string,
  opts: { force: boolean; log: (line: string) => void; connector?: Connector }
): Promise<string[]> {
  if (!ownsManifest(root)) {
    opts.log(`${root} has no manifest of its own: no apps to stop`);
    return [];
  }
  let m: Manifest;
  try {
    m = loadManifest(root);
  } catch (e) {
    if (!opts.force) throw e;
    opts.log(
      `the manifest of ${root} does not load (${describeError(e)}): its apps are not stopped`
    );
    return [];
  }
  const fleet = new Fleet(m, undefined, opts.connector);
  const stopped: string[] = [];
  for (const app of fleet.select(['all'])) {
    const host = fleet.hostOf(app);
    if (m.hosts[host]?.readonly) {
      opts.log(`${app} runs on readonly host ${host}: left alone`);
      continue;
    }
    for (const r of await actOn(fleet, app, 'delete')) stopped.push(r.app);
  }
  return stopped;
}

/**
 * The deps of the CLI and MCP: real git, the host state directory, the install run through the host's shell, pm2 of
 * this checkout, stop-and-delete of a checkout through stopCheckout. `capture` keeps the install off the terminal (MCP,
 * whose stdin and stdout carry the protocol) and logs its last lines when it fails; without it the install writes to
 * the terminal's stderr (CLI), so stdout carries only mcproc's own answer.
 */
export async function defaultWorktreeDeps(
  ctx: Context,
  io: { out: (s: string) => void },
  opts: { capture?: boolean } = {}
): Promise<WorktreeDeps> {
  return {
    git: gitRunner,
    stateDir: stateDir(),
    run: async (cmd, cwd) => {
      try {
        const r = await spawnRun(
          [ctx.host.shell.bin, ...ctx.host.shell.flags, cmd],
          {
            cwd,
            env: {},
            capture: opts.capture ?? false,
            stdoutToStderr: true,
          }
        );
        if (r.code !== 0 && r.output)
          for (const line of r.output.split('\n').slice(-20)) io.out(line);
        return r.code;
      } catch (e) {
        io.out(describeError(e));
        return 127;
      }
    },
    log: (line) => io.out(line),
    jlist: () => ctx.pm2.jlist(),
    stopAll: (root, o) =>
      stopCheckout(root, { force: o.force, log: (line) => io.out(line) }),
  };
}

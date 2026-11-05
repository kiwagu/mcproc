import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { McprocError } from './errors.js';
import { builtCliEntry } from './leases/ensure.js';
import { realOf } from './slots.js';
import { mainCheckout, realAhead, type GitRunner } from './worktree.js';
import { shq } from '../transport/quote.js';

/** The second line of the post-checkout hook mcproc writes: what tells mcproc's own hook from any other. */
export const HOOK_MARK = '# mcproc worktree hook';

/**
 * What is at the repository's post-checkout hook: mcproc's (`installed`), nothing (`absent`), lefthook's or another
 * tool's hook, or another tool's while mcproc's own lies beside it as `post-checkout.old` (`moved-aside`: lefthook
 * renames a hook it replaces).
 */
export type HookState =
  | 'installed'
  | 'absent'
  | 'lefthook'
  | 'other'
  | 'moved-aside';

/** The hook of a repository as it stands. */
export interface HookInfo {
  /** git's post-checkout hook of the repository (in its common git dir, shared by every worktree) */
  path: string;
  state: HookState;
  /** the node and the CLI mcproc's hook runs (the moved-aside one's), null without one */
  node: string | null;
  cli: string | null;
  /** whether the hook still finds them: node an executable, the CLI a file */
  node_exists: boolean;
  cli_exists: boolean;
  /** what to add by hand to a hook another tool keeps there: lefthook's job when the hook is lefthook's, else the line */
  snippet: string;
}

/** The line another tool's post-checkout hook runs in place of mcproc's: git passes the previous ref as $1. */
const HOOK_LINE = 'mcproc worktree sync --hook "$1"';
/** The same as a lefthook job: lefthook hands a hook's arguments to its jobs as {1}, {2}, ... */
const LEFTHOOK_JOB =
  'post-checkout:\n  jobs:\n    - run: mcproc worktree sync --hook {1}';

/**
 * The post-checkout hook: an ordinary checkout or switch (a previous ref that is not all zeros) and mcproc's own
 * worktree add end in the shell, so they start no node; a new worktree runs `worktree sync --hook` through the node and
 * CLI given, else through a mcproc in PATH, else fails loudly (git keeps the worktree). The paths are absolute, since
 * hook runners may strip PATH, and quoted; the third line keeps them as JSON for hookStatus.
 */
export function hookScript(node: string, cli: string): string {
  return [
    '#!/bin/sh',
    `${HOOK_MARK}: copies the manifest's worktree files into a new worktree (\`mcproc worktree hook remove\` deletes it)`,
    `# ${JSON.stringify({ node, cli })}`,
    '[ -n "$1" ] || exit 0',
    'case "$1" in *[!0]*) exit 0 ;; esac   # an ordinary checkout or switch: nothing to do, no node start',
    '[ -z "$MCPROC_WORKTREE_ADD" ] || exit 0  # mcproc worktree add copies itself',
    `node=${shq(node)}; cli=${shq(cli)}`,
    'if [ -x "$node" ] && [ -f "$cli" ]; then exec "$node" "$cli" worktree sync --hook "$1"; fi',
    'if command -v mcproc >/dev/null 2>&1; then exec mcproc worktree sync --hook "$1"; fi',
    'echo "mcproc worktree hook: no mcproc at $cli or in PATH; this worktree did not get its files. Run \\`mcproc worktree hook install\\` again, then \\`mcproc worktree sync\\` here." >&2',
    'exit 1',
    '',
  ].join('\n');
}

/** A git rev-parse path asked in `cwd`, resolved from there. */
async function gitPath(
  git: GitRunner,
  args: string[],
  cwd: string
): Promise<string> {
  const r = await git(['rev-parse', ...args], cwd);
  if (r.code !== 0)
    throw new McprocError(
      'TRANSPORT_FAILED',
      `git rev-parse failed: ${r.stderr.trim() || r.stdout.trim()}`
    );
  return path.resolve(cwd, r.stdout.trim());
}

/**
 * The repository's post-checkout hook as git runs it (`git rev-parse --git-path hooks/post-checkout` in the main
 * checkout, so a hooks directory the config names counts), its folder as a real path. Refused when that folder is not
 * inside the repository's common git dir: a hooks directory elsewhere may be tracked or shared by other repositories,
 * and mcproc's hook carries this machine's absolute paths.
 */
export async function hookPath(root: string, git: GitRunner): Promise<string> {
  const main = await mainCheckout(root, git);
  const named = await gitPath(git, ['--git-path', 'hooks/post-checkout'], main);
  const common = realOf(await gitPath(git, ['--git-common-dir'], main));
  const dir = realAhead(path.dirname(named));
  if (!dir.startsWith(`${common}${path.sep}`))
    throw new McprocError(
      'BAD_ARGUMENT',
      `the hooks directory of ${main} is ${dir}, outside its git directory ${common}: a hook there may be tracked or shared, and this one carries absolute paths of this machine`,
      {
        hint: `Add this line to the post-checkout hook you keep there: ${HOOK_LINE}`,
      }
    );
  return path.join(dir, path.basename(named));
}

/** The text of the file at `p`, null when there is none. */
function readMaybe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Whether a hook's text is mcproc's: its second line is the marker, as hookScript writes it. */
const marked = (text: string | null): text is string =>
  text !== null && (text.split('\n')[1] ?? '').startsWith(HOOK_MARK);

const isLefthook = (text: string): boolean => /lefthook/i.test(text);

/** The node and CLI of mcproc's hook, from its third line; null where it names none. */
function pathsOf(text: string): { node: string | null; cli: string | null } {
  const line = text.split('\n')[2] ?? '';
  try {
    const v = line.startsWith('# ')
      ? (JSON.parse(line.slice(2)) as { node?: unknown; cli?: unknown })
      : {};
    return {
      node: typeof v.node === 'string' ? v.node : null,
      cli: typeof v.cli === 'string' ? v.cli : null,
    };
  } catch {
    return { node: null, cli: null };
  }
}

/** Whether `p` passes the hook's own checks: `[ -x ]` for the node, `[ -f ]` for the CLI. */
const executable = (p: string): boolean => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The hook at `file` as it stands. */
function infoAt(file: string): HookInfo {
  const text = readMaybe(file);
  const old = marked(text) ? null : readMaybe(`${file}.old`);
  const state: HookState = marked(text)
    ? 'installed'
    : marked(old)
      ? 'moved-aside'
      : text === null
        ? 'absent'
        : isLefthook(text)
          ? 'lefthook'
          : 'other';
  const ours =
    state === 'installed' ? text : state === 'moved-aside' ? old : null;
  const { node, cli } = ours ? pathsOf(ours) : { node: null, cli: null };
  return {
    path: file,
    state,
    node,
    cli,
    node_exists: node !== null && executable(node),
    cli_exists: cli !== null && isFile(cli),
    snippet:
      text !== null && !marked(text) && isLefthook(text)
        ? LEFTHOOK_JOB
        : HOOK_LINE,
  };
}

/** The refusal to touch a hook that is not mcproc's, naming its owner and what to do instead. */
function taken(file: string, text: string, act: 'install' | 'remove') {
  const lefthook = isLefthook(text);
  const hint =
    act === 'remove'
      ? marked(readMaybe(`${file}.old`))
        ? `mcproc's own hook is ${file}.old, where ${lefthook ? 'lefthook' : 'another tool'} moved it aside: delete that file to remove it.`
        : 'It is not the hook mcproc installs; if it runs mcproc worktree sync, take that line out of it by hand.'
      : lefthook
        ? "Add to lefthook.yml: post-checkout: jobs: - run: mcproc worktree sync --hook {1} (lefthook looks for its binary in the worktree's node_modules, which a fresh worktree lacks; a plain hook is more reliable)"
        : `Add this line to it: ${HOOK_LINE}`;
  return new McprocError(
    'HOOK_TAKEN',
    `${file} is ${lefthook ? "lefthook's" : "another hook's"} post-checkout: mcproc does not ${act === 'install' ? 'overwrite' : 'remove'} it`,
    { hint }
  );
}

/**
 * Puts `text` at `file` (mode 755) whole: written to a temporary sibling first, then renamed over mcproc's own hook, or,
 * when there was none, linked into place, which fails when a file appeared there meanwhile: answers false then.
 */
function place(file: string, text: string, create: boolean): boolean {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.mcproc-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  try {
    fs.writeFileSync(tmp, text, { mode: 0o755, flag: 'wx' });
    fs.chmodSync(tmp, 0o755); // the umask may have taken bits off
    if (!create) {
      fs.renameSync(tmp, file);
      return true;
    }
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** The repository's post-checkout hook as it stands (see hookPath for where it is). A read only. */
export async function hookStatus(
  root: string,
  git: GitRunner
): Promise<HookInfo> {
  return infoAt(await hookPath(root, git));
}

/**
 * Writes mcproc's hook running `entry` into the repository's post-checkout: where there is none, or over mcproc's own
 * when its text or mode differs (a newer node or CLI), else changes nothing. Any other file there is refused with
 * HOOK_TAKEN and left as it is, with what to add to it instead.
 */
export async function hookInstall(
  root: string,
  entry: { node: string; cli: string },
  git: GitRunner
): Promise<HookInfo & { changed: 'written' | 'updated' | 'unchanged' }> {
  const file = await hookPath(root, git);
  const text = hookScript(entry.node, entry.cli);
  for (;;) {
    const had = readMaybe(file);
    if (had !== null && !marked(had)) throw taken(file, had, 'install');
    if (had === text && (fs.statSync(file).mode & 0o777) === 0o755)
      return { ...infoAt(file), changed: 'unchanged' };
    // a file that appeared since it was read is looked at again: it may be another tool's
    if (place(file, text, had === null))
      return { ...infoAt(file), changed: had === null ? 'written' : 'updated' };
  }
}

/** Deletes mcproc's post-checkout hook of the repository; none there is a no-op, another tool's is refused (HOOK_TAKEN). */
export async function hookRemove(
  root: string,
  git: GitRunner
): Promise<HookInfo & { changed: 'removed' | 'absent' }> {
  const file = await hookPath(root, git);
  const had = readMaybe(file);
  if (had === null) return { ...infoAt(file), changed: 'absent' };
  if (!marked(had)) throw taken(file, had, 'remove');
  fs.rmSync(file, { force: true });
  return { ...infoAt(file), changed: 'removed' };
}

export const HOOK_ACTIONS = ['install', 'remove', 'status'] as const;
export type HookAction = (typeof HOOK_ACTIONS)[number];
/** What `worktree hook` answers: the hook as it stands, and with install or remove what changed. */
export type HookResult = HookInfo & {
  changed?: 'written' | 'updated' | 'unchanged' | 'removed' | 'absent';
};

/** The node and the built CLI the hook runs: this node, and builtCliEntry's file, refused for a run from the sources. */
export function hookEntry(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): { node: string; cli: string } {
  const cli = builtCliEntry(env, argv);
  if (cli === null)
    throw new McprocError(
      'BAD_ARGUMENT',
      `worktree hook install needs a built mcproc: this one runs from ${argv[1] || 'an unknown entry'}`,
      { hint: 'Set MCPROC_CLI_ENTRY to the dist/cli.js the hook should run.' }
    );
  return { node: process.execPath, cli };
}

/**
 * `worktree hook <action>` for the repository of `root`, the CLI's and the MCP tool's: status reads; install and
 * remove write, so a readonly local host refuses them.
 */
export async function worktreeHook(
  action: HookAction,
  root: string,
  host: { readonly: boolean },
  git: GitRunner
): Promise<HookResult> {
  if (action === 'status') return hookStatus(root, git);
  if (host.readonly)
    throw new McprocError(
      'READONLY_HOST',
      `the local host is marked readonly: worktree hook ${action} is refused`,
      { hint: 'worktree hook status still reads it.' }
    );
  return action === 'install'
    ? hookInstall(root, hookEntry(), git)
    : hookRemove(root, git);
}

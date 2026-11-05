import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOOK_MARK,
  hookInstall,
  hookPath,
  hookRemove,
  hookScript,
  hookStatus,
} from '../../src/core/worktree-hook.js';
import type { GitRunner } from '../../src/core/worktree.js';
import { shq } from '../../src/transport/quote.js';

/**
 * The git every fixture runs: none of this machine's git config (test/setup.ts), and nothing a git hook or mcproc's own
 * worktree add that runs this suite would pass on (its step-aside variable, git's variables for its repository).
 */
const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const k of [
    'MCPROC_WORKTREE_ADD',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
  ])
    delete env[k];
  return env;
};
const id = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync('git', [...id, ...args], {
    cwd,
    stdio: 'pipe',
    env: { ...gitEnv(), ...env },
  }).toString();
const isolatedGit: GitRunner = (args, cwd, env) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...id, ...args],
      { cwd, env: { ...gitEnv(), ...env }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr) || (err ? err.message : ''),
        })
    );
  });
const fresh = '0'.repeat(40);

describe('worktree hook', () => {
  let base: string;
  let main: string;
  let real: string;
  let marker: string;
  let node: string;
  let cli: string;
  /** a stand-in for node: records the folder it runs in and its arguments in the marker file */
  const stubNode = (dir: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'node');
    fs.writeFileSync(p, `#!/bin/sh\necho "$PWD $*" >> ${shq(marker)}\n`, {
      mode: 0o755,
    });
    return p;
  };
  const marks = (): string[] =>
    fs.existsSync(marker)
      ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean)
      : [];
  const hookFile = () => path.join(real, '.git', 'hooks', 'post-checkout');
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-hook-'));
    main = path.join(base, 'repo');
    fs.mkdirSync(main);
    git(['init', '-q', '-b', 'main'], main);
    fs.writeFileSync(path.join(main, 'a.txt'), 'a');
    git(['add', '-A'], main);
    git(['commit', '-qm', 'init'], main);
    real = fs.realpathSync(main);
    marker = path.join(base, 'marker');
    node = stubNode(path.join(base, 'bin'));
    cli = path.join(base, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(cli));
    fs.writeFileSync(cli, '');
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('hookScript: the shebang, the marker line, the paths as JSON, then the script with the paths quoted', () => {
    const s = hookScript('/usr/bin/node', '/opt/mcproc/dist/cli.js');
    const lines = s.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1].startsWith(HOOK_MARK)).toBe(true);
    expect(HOOK_MARK).toBe('# mcproc worktree hook');
    expect(lines[2]).toBe(
      `# ${JSON.stringify({ node: '/usr/bin/node', cli: '/opt/mcproc/dist/cli.js' })}`
    );
    expect(s).toBe(
      [
        '#!/bin/sh',
        "# mcproc worktree hook: copies the manifest's worktree files into a new worktree (`mcproc worktree hook remove` deletes it)",
        '# {"node":"/usr/bin/node","cli":"/opt/mcproc/dist/cli.js"}',
        '[ -n "$1" ] || exit 0',
        'case "$1" in *[!0]*) exit 0 ;; esac   # an ordinary checkout or switch: nothing to do, no node start',
        '[ -z "$MCPROC_WORKTREE_ADD" ] || exit 0  # mcproc worktree add copies itself',
        "node='/usr/bin/node'; cli='/opt/mcproc/dist/cli.js'",
        'if [ -x "$node" ] && [ -f "$cli" ]; then exec "$node" "$cli" worktree sync --hook "$1"; fi',
        'if command -v mcproc >/dev/null 2>&1; then exec mcproc worktree sync --hook "$1"; fi',
        'echo "mcproc worktree hook: no mcproc at $cli or in PATH; this worktree did not get its files. Run \\`mcproc worktree hook install\\` again, then \\`mcproc worktree sync\\` here." >&2',
        'exit 1',
        '',
      ].join('\n')
    );
  });

  it('hookScript quotes awkward paths: a node and a cli under a folder with a space and a quote run through real git', async () => {
    const odd = path.join(base, "it's a dir");
    const oddNode = stubNode(odd);
    const oddCli = path.join(odd, 'cli.js');
    fs.writeFileSync(oddCli, '');
    await hookInstall(main, { node: oddNode, cli: oddCli }, isolatedGit);
    const wt = path.join(base, 'wt');
    git(['worktree', 'add', '-q', '../wt', '-b', 'b'], main);
    expect(marks()).toEqual([
      `${fs.realpathSync(wt)} ${oddCli} worktree sync --hook ${fresh}`,
    ]);
  });

  it('install writes the hook into a fresh repository (mode 755), then leaves it as it is, and refreshes it for another cli', async () => {
    const r = await hookInstall(main, { node, cli }, isolatedGit);
    expect(r).toMatchObject({
      path: hookFile(),
      state: 'installed',
      changed: 'written',
      node,
      cli,
      node_exists: true,
      cli_exists: true,
    });
    expect(fs.statSync(hookFile()).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(hookFile(), 'utf8')).toBe(hookScript(node, cli));
    const again = await hookInstall(main, { node, cli }, isolatedGit);
    expect(again.changed).toBe('unchanged');
    const other = path.join(base, 'other', 'cli.js');
    fs.mkdirSync(path.dirname(other));
    fs.writeFileSync(other, '');
    const moved = await hookInstall(main, { node, cli: other }, isolatedGit);
    expect(moved).toMatchObject({ changed: 'updated', cli: other });
    expect(fs.readFileSync(hookFile(), 'utf8')).toBe(hookScript(node, other));
    expect(fs.statSync(hookFile()).mode & 0o777).toBe(0o755);
  });

  it('the hook path is the repository one from a linked worktree too', async () => {
    const wt = path.join(base, 'wt');
    git(['worktree', 'add', '-q', '../wt', '-b', 'b'], main);
    expect(await hookPath(wt, isolatedGit)).toBe(hookFile());
    expect(await hookPath(main, isolatedGit)).toBe(hookFile());
  });

  it('through real git: a switch starts no node, git worktree add runs sync in the new worktree, mcproc worktree add is left alone', async () => {
    await hookInstall(main, { node, cli }, isolatedGit);
    git(['switch', '-q', '-c', 'other'], main);
    expect(fs.existsSync(marker)).toBe(false);
    git(['switch', '-q', 'main'], main);
    expect(fs.existsSync(marker)).toBe(false);
    const wt = path.join(base, 'wt');
    git(['worktree', 'add', '-q', '../wt', '-b', 'b'], main);
    expect(marks()).toEqual([
      `${fs.realpathSync(wt)} ${cli} worktree sync --hook ${fresh}`,
    ]);
    git(['worktree', 'add', '-q', '../wt2', '-b', 'c'], main, {
      MCPROC_WORKTREE_ADD: '1',
    });
    expect(fs.existsSync(path.join(base, 'wt2'))).toBe(true);
    expect(marks()).toHaveLength(1);
  });

  it('the hook runs in the new worktree when made from a linked one', async () => {
    await hookInstall(main, { node, cli }, isolatedGit);
    const wt = path.join(base, 'wt');
    git(['worktree', 'add', '-q', '../wt', '-b', 'b'], main);
    git(['worktree', 'add', '-q', '../wt2', '-b', 'c'], wt);
    expect(marks()).toEqual([
      `${fs.realpathSync(wt)} ${cli} worktree sync --hook ${fresh}`,
      `${fs.realpathSync(path.join(base, 'wt2'))} ${cli} worktree sync --hook ${fresh}`,
    ]);
  });

  it('without its node and no mcproc in PATH the hook fails git worktree add loudly, and git keeps the worktree', async () => {
    await hookInstall(main, { node, cli }, isolatedGit);
    fs.rmSync(node);
    const r = spawnSync(
      'git',
      [...id, 'worktree', 'add', '-q', '../wt', '-b', 'b'],
      {
        cwd: main,
        env: { ...gitEnv(), PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
      }
    );
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('no mcproc at');
    expect(fs.existsSync(path.join(base, 'wt', 'a.txt'))).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("install and remove never touch another tool's post-checkout: a plain one, and lefthook's with its own hint", async () => {
    const plain = '#!/bin/sh\necho checked out\n';
    fs.writeFileSync(hookFile(), plain, { mode: 0o755 });
    for (const act of [
      () => hookInstall(main, { node, cli }, isolatedGit),
      () => hookRemove(main, isolatedGit),
    ]) {
      const e = await act().then(
        () => null,
        (x: unknown) => x
      );
      expect(e).toMatchObject({
        code: 'HOOK_TAKEN',
        message: expect.stringContaining('another hook'),
      });
      expect(fs.readFileSync(hookFile(), 'utf8')).toBe(plain);
    }
    await expect(
      hookInstall(main, { node, cli }, isolatedGit)
    ).rejects.toMatchObject({
      message: `${hookFile()} is another hook's post-checkout: mcproc does not overwrite it`,
      hint: 'Add this line to it: mcproc worktree sync --hook "$1"',
    });
    const lefthook =
      '#!/bin/sh\n# managed by lefthook\ncall_lefthook run "post-checkout" "$@"\n';
    fs.writeFileSync(hookFile(), lefthook, { mode: 0o755 });
    await expect(
      hookInstall(main, { node, cli }, isolatedGit)
    ).rejects.toMatchObject({
      code: 'HOOK_TAKEN',
      message: `${hookFile()} is lefthook's post-checkout: mcproc does not overwrite it`,
      hint: expect.stringContaining('mcproc worktree sync --hook {1}'),
    });
    await expect(hookRemove(main, isolatedGit)).rejects.toMatchObject({
      code: 'HOOK_TAKEN',
      message: expect.stringContaining("lefthook's post-checkout"),
    });
    expect(fs.readFileSync(hookFile(), 'utf8')).toBe(lefthook);
  });

  it('install refuses a hooks directory outside the git directory: it may be tracked or shared', async () => {
    const out = path.join(main, 'hooks-out');
    fs.mkdirSync(out);
    git(['config', ['core', 'hooksPath'].join('.'), out], main);
    await expect(
      hookInstall(main, { node, cli }, isolatedGit)
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      message: expect.stringContaining('outside its git directory'),
      hint: 'Add this line to the post-checkout hook you keep there: mcproc worktree sync --hook "$1"',
    });
    expect(fs.readdirSync(out)).toEqual([]);
    expect(fs.existsSync(hookFile())).toBe(false);
  });

  it('remove deletes the installed hook; with none it is a no-op', async () => {
    await hookInstall(main, { node, cli }, isolatedGit);
    const r = await hookRemove(main, isolatedGit);
    expect(r).toMatchObject({
      path: hookFile(),
      state: 'absent',
      changed: 'removed',
    });
    expect(fs.existsSync(hookFile())).toBe(false);
    expect(await hookRemove(main, isolatedGit)).toMatchObject({
      state: 'absent',
      changed: 'absent',
    });
  });

  it('status: absent, moved aside by lefthook, installed with a cli that is gone', async () => {
    expect(await hookStatus(main, isolatedGit)).toMatchObject({
      path: hookFile(),
      state: 'absent',
      node: null,
      cli: null,
      node_exists: false,
      cli_exists: false,
      snippet: 'mcproc worktree sync --hook "$1"',
    });
    await hookInstall(main, { node, cli }, isolatedGit);
    fs.rmSync(cli);
    expect(await hookStatus(main, isolatedGit)).toMatchObject({
      state: 'installed',
      node,
      cli,
      node_exists: true,
      cli_exists: false,
    });
    // lefthook renames a hook it replaces to post-checkout.old
    fs.renameSync(hookFile(), `${hookFile()}.old`);
    fs.writeFileSync(
      hookFile(),
      '#!/bin/sh\n# managed by lefthook\ncall_lefthook run "post-checkout" "$@"\n',
      { mode: 0o755 }
    );
    const moved = await hookStatus(main, isolatedGit);
    expect(moved).toMatchObject({ state: 'moved-aside' });
    expect(moved.snippet).toContain('mcproc worktree sync --hook {1}');
    fs.rmSync(`${hookFile()}.old`);
    expect((await hookStatus(main, isolatedGit)).state).toBe('lefthook');
    fs.writeFileSync(hookFile(), '#!/bin/sh\nexit 0\n');
    expect((await hookStatus(main, isolatedGit)).state).toBe('other');
  });
});

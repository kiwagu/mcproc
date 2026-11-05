import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const sources = (f: string) =>
    fileURLToPath(new URL(`../../src/core/${f}`, import.meta.url));
  /**
   * hookInstall of the main checkout in a child process killed after 10 s, so a hook path it would loop on fails the
   * test instead of hanging the suite (the loop is synchronous: no timer in this process would ever fire); answers
   * what it returned or the error it threw.
   */
  const installInChild = (): Record<string, string | undefined> => {
    const script = path.join(base, 'install.mts');
    fs.writeFileSync(
      script,
      [
        `import { hookInstall } from ${JSON.stringify(sources('worktree-hook.ts'))};`,
        `import { gitRunner } from ${JSON.stringify(sources('worktree.ts'))};`,
        'try {',
        `  const r = await hookInstall(${JSON.stringify(main)}, ${JSON.stringify({ node, cli })}, gitRunner);`,
        '  console.log(JSON.stringify({ changed: r.changed }));',
        '} catch (e) {',
        '  console.log(JSON.stringify({ code: e.code, message: e.message, hint: e.hint }));',
        '}',
      ].join('\n')
    );
    const r = spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(),
      env: gitEnv(),
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.signal, 'hookInstall did not return within 10 s').toBeNull();
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}');
  };
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

  it("a link at post-checkout that leads to no file is another tool's: install refuses it at once, remove and status leave it", async () => {
    const gone = path.join(base, 'gone', 'post-checkout');
    fs.symlinkSync(gone, hookFile());
    expect(installInChild()).toEqual({
      code: 'HOOK_TAKEN',
      message: `${hookFile()} is another hook's post-checkout (a link to ${gone}, which leads to no hook file): mcproc does not overwrite it`,
      hint: 'Delete it and run mcproc worktree hook install again, or point it at the hook it should run and add this line there: mcproc worktree sync --hook "$1"',
    });
    expect(fs.readlinkSync(hookFile())).toBe(gone);
    await expect(hookRemove(main, isolatedGit)).rejects.toMatchObject({
      code: 'HOOK_TAKEN',
      message: expect.stringContaining('leads to no hook file'),
    });
    expect(fs.readlinkSync(hookFile())).toBe(gone);
    expect(await hookStatus(main, isolatedGit)).toMatchObject({
      state: 'other',
      node: null,
      cli: null,
    });
    expect(fs.existsSync(path.dirname(gone))).toBe(false);
    // a link to itself, and a folder: entries too, refused the same way
    fs.rmSync(hookFile());
    fs.symlinkSync('post-checkout', hookFile());
    expect(installInChild()).toMatchObject({
      code: 'HOOK_TAKEN',
      message: expect.stringContaining('(a link to post-checkout, which'),
    });
    expect(fs.readlinkSync(hookFile())).toBe('post-checkout');
    fs.rmSync(hookFile());
    fs.mkdirSync(hookFile());
    expect(installInChild()).toMatchObject({
      code: 'HOOK_TAKEN',
      message: expect.stringContaining('(a folder)'),
    });
    await expect(hookRemove(main, isolatedGit)).rejects.toMatchObject({
      code: 'HOOK_TAKEN',
    });
    expect(fs.statSync(hookFile()).isDirectory()).toBe(true);
  }, 60_000);

  it("a link to mcproc's own hook counts as mcproc's: an update puts the hook in its place, remove deletes the link only", async () => {
    const kept = path.join(base, 'kept', 'post-checkout');
    fs.mkdirSync(path.dirname(kept));
    fs.writeFileSync(kept, hookScript(node, cli), { mode: 0o755 });
    fs.symlinkSync(kept, hookFile());
    expect(await hookStatus(main, isolatedGit)).toMatchObject({
      state: 'installed',
      node,
      cli,
    });
    expect((await hookInstall(main, { node, cli }, isolatedGit)).changed).toBe(
      'unchanged'
    );
    expect((await hookRemove(main, isolatedGit)).changed).toBe('removed');
    expect(fs.existsSync(hookFile())).toBe(false);
    expect(fs.readFileSync(kept, 'utf8')).toBe(hookScript(node, cli));
    fs.symlinkSync(kept, hookFile());
    const other = path.join(base, 'other.js');
    fs.writeFileSync(other, '');
    expect(
      (await hookInstall(main, { node, cli: other }, isolatedGit)).changed
    ).toBe('updated');
    expect(fs.lstatSync(hookFile()).isFile()).toBe(true);
    expect(fs.readFileSync(hookFile(), 'utf8')).toBe(hookScript(node, other));
    expect(fs.readFileSync(kept, 'utf8')).toBe(hookScript(node, cli));
  });

  it('a hook path that keeps changing under install ends in a refusal after a few looks, never a loop', async () => {
    let calls = 0;
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      // past 10 a loop without end: stop it here so it fails the test instead of hanging it
      if (++calls > 10) throw new Error('install is still looping');
      throw Object.assign(new Error('EEXIST: file already exists'), {
        code: 'EEXIST',
      });
    });
    try {
      await expect(
        hookInstall(main, { node, cli }, isolatedGit)
      ).rejects.toMatchObject({
        code: 'HOOK_TAKEN',
        message: `${hookFile()} kept changing while mcproc installed its hook (3 looks): another tool is writing it`,
      });
      expect(calls).toBe(3);
    } finally {
      link.mockRestore();
    }
    expect(fs.existsSync(hookFile())).toBe(false);
    expect(
      fs
        .readdirSync(path.dirname(hookFile()))
        .filter((f) => f.includes('.mcproc-'))
    ).toEqual([]);
  });

  it('an update reads the hook again right before it replaces it: one another tool put there meanwhile is refused and kept', async () => {
    await hookInstall(main, { node, cli }, isolatedGit);
    const foreign = '#!/bin/sh\necho mine\n';
    const theirs = path.join(base, 'theirs');
    fs.writeFileSync(theirs, foreign, { mode: 0o755 });
    const chmod = fs.chmodSync;
    // the staged copy's chmod comes after install read the hook: another tool replaces it then
    const spy = vi
      .spyOn(fs, 'chmodSync')
      .mockImplementationOnce((p: fs.PathLike, m: fs.Mode) => {
        fs.renameSync(theirs, hookFile());
        chmod(p, m);
      });
    const other = path.join(base, 'other.js');
    fs.writeFileSync(other, '');
    try {
      await expect(
        hookInstall(main, { node, cli: other }, isolatedGit)
      ).rejects.toMatchObject({
        code: 'HOOK_TAKEN',
        message: `${hookFile()} is another hook's post-checkout: mcproc does not overwrite it`,
      });
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(hookFile(), 'utf8')).toBe(foreign);
    expect(
      fs
        .readdirSync(path.dirname(hookFile()))
        .filter((f) => f.includes('.mcproc-'))
    ).toEqual([]);
  });

  it('install restores mode 755 to its own hook that lost it (git skips a hook it cannot execute)', async () => {
    await hookInstall(main, { node, cli }, isolatedGit);
    fs.chmodSync(hookFile(), 0o644);
    const r = await hookInstall(main, { node, cli }, isolatedGit);
    expect(r).toMatchObject({ changed: 'updated', state: 'installed' });
    expect(fs.statSync(hookFile()).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(hookFile(), 'utf8')).toBe(hookScript(node, cli));
  });

  it('a repository reached through a symlinked path gets the hook of its real git directory', async () => {
    const link = path.join(base, 'link');
    fs.symlinkSync(main, link);
    expect(await hookPath(link, isolatedGit)).toBe(hookFile());
    expect(await hookInstall(link, { node, cli }, isolatedGit)).toMatchObject({
      path: hookFile(),
      changed: 'written',
    });
    expect((await hookStatus(link, isolatedGit)).state).toBe('installed');
    git(['worktree', 'add', '-q', '../wt', '-b', 'b'], link);
    expect(marks()).toEqual([
      `${fs.realpathSync(path.join(base, 'wt'))} ${cli} worktree sync --hook ${fresh}`,
    ]);
  });

  it('install makes the hooks directory when the repository has none yet', async () => {
    const hooks = path.dirname(hookFile());
    fs.rmSync(hooks, { recursive: true, force: true });
    const r = await hookInstall(main, { node, cli }, isolatedGit);
    expect(r).toMatchObject({ path: hookFile(), changed: 'written' });
    expect(fs.statSync(hookFile()).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(hooks)).toEqual(['post-checkout']);
  });

  it('install refuses a hooks directory that is a link out of the git directory, and writes nothing there', async () => {
    const hooks = path.dirname(hookFile());
    const out = path.join(base, 'shared-hooks');
    fs.mkdirSync(out);
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.symlinkSync(out, hooks);
    await expect(
      hookInstall(main, { node, cli }, isolatedGit)
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      message: expect.stringContaining(
        `is ${fs.realpathSync(out)}, outside its git directory`
      ),
    });
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('without its node the hook runs a mcproc in PATH: git worktree add runs it in the new worktree', async () => {
    await hookInstall(main, { node, cli }, isolatedGit);
    fs.rmSync(node);
    const bin = path.join(base, 'path-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'mcproc'),
      `#!/bin/sh\necho "$PWD $*" >> ${shq(marker)}\n`,
      { mode: 0o755 }
    );
    const r = spawnSync(
      'git',
      [...id, 'worktree', 'add', '-q', '../wt', '-b', 'b'],
      {
        cwd: main,
        env: { ...gitEnv(), PATH: `${bin}:/usr/bin:/bin` },
        encoding: 'utf8',
      }
    );
    expect(r.status, r.stderr).toBe(0);
    expect(marks()).toEqual([
      `${fs.realpathSync(path.join(base, 'wt'))} worktree sync --hook ${fresh}`,
    ]);
  });
});

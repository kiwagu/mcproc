import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry, registryPath } from '../../src/core/slots.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
/** The bundle under test: dist/cli.js, or another build of this tree (a branch built elsewhere, so dist keeps serving the installed mcproc). */
const cli = process.env.MCPROC_CLI ?? path.join(root, 'dist', 'cli.js');
const MASK = '*-local.{yml,yaml}';

/**
 * The environment of every git and mcproc this file runs: no git config of this machine, no project named from outside
 * (MCPROC_PROJECT or CLAUDE_PROJECT_DIR would steer mcproc away from the temp repository), the test's own state dir.
 */
function envOf(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const k of [
    'MCPROC_PROJECT',
    'CLAUDE_PROJECT_DIR',
    'MCPROC_CLI_ENTRY',
    'MCPROC_WORKTREE_ADD',
  ])
    delete env[k];
  return { ...env, ...extra };
}

let base: string;
let main: string;

const git = (args: string[], cwd: string) =>
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    env: envOf(),
    encoding: 'utf8',
  });
const gitOut = (args: string[], cwd: string): string => {
  const r = git(args, cwd);
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
};
/** The built mcproc on the temp repository, answering JSON: the parsed answer from stdout, or the error from stderr. */
function mcproc(args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(
    process.execPath,
    [cli, ...args, '--project', main, '--json'],
    { cwd: main, env: envOf(extra), encoding: 'utf8' }
  );
  // the answer is all of stdout, an error the last line of stderr (notes go before it); one that is no JSON
  // (commander's own errors) is kept as text, so the assertion shows it
  const json = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return { text: s };
    }
  };
  return {
    status: r.status,
    stderr: r.stderr,
    out: r.status === 0 ? json(r.stdout) : null,
    err: r.status === 0 ? null : json(r.stderr.trim().split('\n').at(-1) ?? ''),
  };
}

beforeAll(() => {
  base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wthi-'))
  );
  main = path.join(base, 'demo');
  fs.mkdirSync(path.join(main, '.mcproc'), { recursive: true });
  // nothing here needs pm2: a stand-in that fails makes sure none is ever run, the user's or another
  const noPm2 = path.join(base, 'no-pm2');
  fs.writeFileSync(
    noPm2,
    '#!/bin/sh\necho "this test runs no pm2" >&2\nexit 1\n',
    {
      mode: 0o755,
    }
  );
  fs.writeFileSync(
    path.join(main, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      'project: demo',
      'worktree:',
      '  copy: [cache]',
      `  required: ['${MASK}']`,
      '  link: [notes]',
      '  install: false',
      'apps:',
      '  web:',
      '    description: web',
      '    run: node web.js',
      'hosts:',
      '  local:',
      `    pm2: ${noPm2}`,
      `    pm2_home: ${path.join(base, 'pm2')}`,
      '',
    ].join('\n')
  );
  fs.mkdirSync(path.join(main, 'cache'));
  fs.writeFileSync(path.join(main, 'cache', 'c.bin'), 'cache');
  fs.writeFileSync(path.join(main, 'tool-local.yml'), 'local: true\n');
  fs.mkdirSync(path.join(main, 'notes'));
  fs.writeFileSync(path.join(main, 'notes', 'n.md'), 'note');
  // the manifest stays untracked, so a worktree git makes has none and the main checkout's decides
  fs.writeFileSync(
    path.join(main, '.gitignore'),
    '.mcproc/\ncache/\n*-local.yml\nnotes/\n'
  );
  fs.writeFileSync(path.join(main, 'web.js'), '');
  gitOut(['init', '-q', '-b', 'main'], main);
  gitOut(['add', '-A'], main);
  gitOut(['commit', '-qm', 'init'], main);
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.env.MCPROC_IT !== '1')(
  'the worktree hook and required files through the built CLI and real git',
  () => {
    it('a plain git worktree add gets the files or fails loudly; mcproc worktree add copies once and rolls back on a miss', () => {
      const local = path.join(main, 'tool-local.yml');

      const installed = mcproc(['worktree', 'hook', 'install'], {
        MCPROC_CLI_ENTRY: cli,
      });
      expect(installed.stderr).toBe('');
      expect(installed.out).toMatchObject({
        state: 'installed',
        changed: 'written',
        node: process.execPath,
        cli: path.resolve(cli),
        node_exists: true,
        cli_exists: true,
      });
      expect(mcproc(['worktree', 'hook', 'status']).out).toMatchObject({
        path: path.join(main, '.git', 'hooks', 'post-checkout'),
        state: 'installed',
      });

      // a worktree another tool makes through git: the hook brings it the copies and the link
      const wt = path.join(base, 'wt');
      const add = git(['worktree', 'add', '-q', '../wt', '-b', 'b'], main);
      expect(add.status, add.stderr).toBe(0);
      expect(fs.readFileSync(path.join(wt, 'cache', 'c.bin'), 'utf8')).toBe(
        'cache'
      );
      expect(fs.readFileSync(path.join(wt, 'tool-local.yml'), 'utf8')).toBe(
        'local: true\n'
      );
      expect(fs.lstatSync(path.join(wt, 'notes')).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(wt, 'notes'))).toBe(
        path.join(main, 'notes')
      );
      // the link is in git's exclude file, the copies are ignored by the repository: nothing shows as untracked
      expect(gitOut(['status', '--porcelain'], wt)).toBe('');

      // the required file is gone from the main checkout: git keeps the worktree, but its add fails and says why
      fs.rmSync(local);
      const wt2 = path.join(base, 'wt2');
      const miss = git(['worktree', 'add', '-q', '../wt2', '-b', 'c'], main);
      expect(miss.status).not.toBe(0);
      expect(miss.stderr).toContain(MASK);
      expect(miss.stderr).toContain('exists without them');
      expect(miss.stderr).toContain('mcproc worktree sync');
      expect(fs.existsSync(wt2)).toBe(true);
      expect(fs.existsSync(path.join(wt2, 'cache'))).toBe(false);

      // mcproc's own add with the hook installed: the hook steps aside, the add copies each file once
      fs.writeFileSync(local, 'local: true\n');
      const z = mcproc(['worktree', 'add', 'feat/z']);
      expect(z.status, z.stderr).toBe(0);
      const wz = path.join(`${main}.worktrees`, 'feat', 'z');
      expect(z.out).toMatchObject({
        path: wz,
        branch: 'feat/z',
        created_branch: true,
        slot: 1,
        manifest: 'main',
        copied: ['cache', 'tool-local.yml'],
        linked: ['notes'],
        missing: [],
        missing_required: [],
      });
      expect(z.out).not.toHaveProperty('kept');
      expect(fs.readFileSync(path.join(wz, 'tool-local.yml'), 'utf8')).toBe(
        'local: true\n'
      );

      // a miss refuses mcproc's add and takes back the worktree, its new branch and its slot. Had the hook not
      // stepped aside, git worktree add itself would have failed and left the worktree, never REQUIRED_MISSING
      fs.rmSync(local);
      const w = mcproc(['worktree', 'add', 'feat/w']);
      expect(w.status).toBe(1);
      expect(w.err).toMatchObject({ code: 'REQUIRED_MISSING' });
      expect(w.err.message).toContain(MASK);
      expect(w.err.message).toContain('nothing was kept');
      expect(fs.existsSync(path.join(`${main}.worktrees`, 'feat', 'w'))).toBe(
        false
      );
      expect(gitOut(['worktree', 'list', '--porcelain'], main)).not.toMatch(
        /feat\/w/
      );
      expect(gitOut(['branch', '--list', 'feat/w'], main)).toBe('');
      const reg = readRegistry(
        registryPath(String(process.env.MCPROC_STATE_DIR), 'demo', main)
      );
      expect(Object.keys(reg?.slots ?? {})).toEqual(['0', '1']);
      expect(reg?.slots['1']).toMatchObject({ path: wz, branch: 'feat/z' });

      // remove takes only mcproc's own hook away
      expect(mcproc(['worktree', 'hook', 'remove']).out).toMatchObject({
        changed: 'removed',
        state: 'absent',
      });
      expect(
        fs.existsSync(path.join(main, '.git', 'hooks', 'post-checkout'))
      ).toBe(false);
    }, 60_000);
  }
);

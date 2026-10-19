import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts'
);

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
const commit = (version: string, subject: string) => {
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'x', version })
  );
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', subject);
};
const run = (script: string, ...args: string[]) =>
  spawnSync('sh', [path.join(scripts, script), ...args], {
    cwd: repo,
    encoding: 'utf8',
  });

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-release-'));
  git('init', '-q', '-b', 'main');
  commit('0.1.0', 'feat: first');
  git('tag', '-a', 'v0.1.0', '-m', 'mcproc 0.1.0');
  commit('0.1.0', 'docs: a fix to the readme');
  commit('0.2.0', 'feat: second');
  git('tag', '-a', 'v0.2.0', '-m', 'mcproc 0.2.0');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('release-check', () => {
  it('passes a tag that names the version on main', () => {
    const r = run('release-check.sh', 'v0.2.0', 'main');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^release v0\.2\.0: [0-9a-f]+ on main/);
  });
  it('refuses a tag whose version differs from package.json at its commit', () => {
    git('tag', '-a', 'v0.3.0', '-m', 'wrong');
    const r = run('release-check.sh', 'v0.3.0', 'main');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'tag v0.3.0 does not match the version in package.json at that commit (0.2.0)'
    );
  });
  it('refuses a tag on a commit that is not on main', () => {
    git('switch', '-qc', 'side');
    commit('0.3.0', 'feat: on a side branch');
    git('tag', '-a', 'v0.3.0', '-m', 'mcproc 0.3.0');
    git('switch', '-q', 'main');
    const r = run('release-check.sh', 'v0.3.0', 'main');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /tag v0\.3\.0 points at [0-9a-f]+, which is not on main/
    );
  });
  it('refuses a name that is not a release tag, or no tag at all', () => {
    expect(run('release-check.sh', 'latest', 'main').stderr).toContain(
      'not a release tag: latest (expected vX.Y.Z)'
    );
    expect(run('release-check.sh', 'v9.9.9', 'main').stderr).toContain(
      'no such tag: v9.9.9'
    );
  });
});

describe('release-notes', () => {
  it('lists the commits on main since the previous release tag, newest first', () => {
    const r = run('release-notes.sh', 'v0.2.0');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('- feat: second\n- docs: a fix to the readme\n');
  });
  it('the first release is its own commit', () => {
    expect(run('release-notes.sh', 'v0.1.0').stdout).toBe('- feat: first\n');
  });
  it('a lightweight or non-release tag in between does not cut the notes short', () => {
    commit('0.2.0', 'chore: tidy');
    git('tag', 'scratch');
    commit('0.3.0', 'feat: third');
    git('tag', '-a', 'v0.3.0', '-m', 'mcproc 0.3.0');
    expect(run('release-notes.sh', 'v0.3.0').stdout).toBe(
      '- feat: third\n- chore: tidy\n'
    );
  });
});

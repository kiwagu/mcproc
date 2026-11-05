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
  it('refuses a name that is not a plain vX.Y.Z, and a lightweight tag', () => {
    for (const name of ['v1.2.3-rc.1', 'v01.2.3', 'v1.2', 'v2-scratch']) {
      const r = run('release-check.sh', name, 'main');
      expect(r.status, name).toBe(1);
      expect(r.stderr).toContain(`not a release tag: ${name}`);
    }
    commit('0.2.1', 'fix: small');
    git('tag', 'v0.2.1'); // lightweight
    expect(run('release-check.sh', 'v0.2.1', 'main').stderr).toContain(
      'no annotated tag v0.2.1'
    );
  });
  it('refuses a name that is not a release tag, or no tag at all', () => {
    expect(run('release-check.sh', 'latest', 'main').stderr).toContain(
      'not a release tag: latest (expected vX.Y.Z)'
    );
    expect(run('release-check.sh', 'v9.9.9', 'main').stderr).toContain(
      'no annotated tag v9.9.9'
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
  it('a lightweight version-shaped tag or an annotated non-release tag in between does not cut the notes short', () => {
    commit('0.2.0', 'chore: tidy');
    git('tag', 'v0.2.5'); // lightweight: not a release
    commit('0.2.0', 'docs: words');
    git('tag', '-a', 'v2-scratch', '-m', 'not a release');
    commit('0.3.0', 'feat: third');
    git('tag', '-a', 'v0.3.0', '-m', 'mcproc 0.3.0');
    expect(run('release-notes.sh', 'v0.3.0').stdout).toBe(
      '- feat: third\n- docs: words\n- chore: tidy\n'
    );
  });
});

/** A stand-in for npm or gh: answers from environment variables and logs each call to $FAKE_LOG. */
function fake(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(repo, 'fake-')); // removed with the repo
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "$FAKE_LOG"\n${body}\n`, {
    mode: 0o755,
  });
  return bin;
}
const runWith = (script: string, env: Record<string, string>, tag: string) =>
  spawnSync('sh', [path.join(scripts, script), tag], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

describe('release-publish', () => {
  const npm = () =>
    fake(
      'npm',
      [
        'case "$1 $3" in',
        '  "view version") [ -n "$FAKE_VERSION" ] && echo "$FAKE_VERSION"; exit "$FAKE_VIEW_EXIT" ;;',
        '  "view gitHead") echo "$FAKE_HEAD" ;;',
        'esac',
        '[ "$1 $2" = "stage publish" ] && exit "$FAKE_PUBLISH_EXIT"',
      ].join('\n')
    );
  const calls = (log: string) =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  let log: string;
  beforeEach(() => {
    log = path.join(repo, 'calls.log');
  });
  const env = (extra: Record<string, string>) => ({
    NPM: npm(),
    FAKE_LOG: log,
    FAKE_VERSION: '',
    FAKE_HEAD: '',
    FAKE_VIEW_EXIT: '0',
    FAKE_PUBLISH_EXIT: '0',
    ...extra,
  });
  it('stages a version npm does not have, for the owner to approve', () => {
    const r = runWith('release-publish.sh', env({}), 'v0.2.0');
    expect(r.status).toBe(0);
    expect(calls(log)).toEqual([
      'view x@0.2.0 version',
      'stage publish --access public',
    ]);
  });
  it('skips a version npm has from the same commit: approved earlier, or published by hand', () => {
    const head = git('rev-parse', 'v0.2.0^{commit}');
    const r = runWith(
      'release-publish.sh',
      env({ FAKE_VERSION: '0.2.0', FAKE_HEAD: head }),
      'v0.2.0'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`x@0.2.0 is already on npm from ${head}`);
    expect(calls(log)).not.toContain('stage publish --access public');
  });
  it('refuses a version npm has from another commit', () => {
    const r = runWith(
      'release-publish.sh',
      env({ FAKE_VERSION: '0.2.0', FAKE_HEAD: 'abc123' }),
      'v0.2.0'
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'x@0.2.0 is already on npm from abc123, not from'
    );
  });
  it('a failing stage fails the step', () => {
    const r = runWith(
      'release-publish.sh',
      env({ FAKE_PUBLISH_EXIT: '1' }),
      'v0.2.0'
    );
    expect(r.status).toBe(1);
    expect(calls(log)).toContain('stage publish --access public');
    expect(r.stdout).not.toContain('is staged');
    expect(r.stderr).toContain('pending stage');
  });
  it('refuses a version npm has whose commit it cannot tell', () => {
    const r = runWith(
      'release-publish.sh',
      env({ FAKE_VERSION: '0.2.0', FAKE_HEAD: '' }),
      'v0.2.0'
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'x@0.2.0 is already on npm from an unknown commit, not from'
    );
    expect(calls(log)).not.toContain('stage publish --access public');
  });
});

describe('release-tag', () => {
  let clone: string;
  const g = (...args: string[]) =>
    execFileSync('git', args, { cwd: clone, encoding: 'utf8' }).trim();
  const inClone = (script: string, ...args: string[]) =>
    spawnSync('sh', [path.join(scripts, script), ...args], {
      cwd: clone,
      encoding: 'utf8',
    });
  beforeEach(() => {
    clone = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-release-clone-'));
    execFileSync('git', ['clone', '-q', repo, clone]);
  });
  afterEach(() => fs.rmSync(clone, { recursive: true, force: true }));
  it('restores the annotated tag that checkout replaced with a lightweight one', () => {
    const commit = g('rev-parse', 'v0.2.0^{commit}');
    g('fetch', '-q', '--no-tags', 'origin', `+${commit}:refs/tags/v0.2.0`);
    expect(g('cat-file', '-t', 'refs/tags/v0.2.0')).toBe('commit');
    expect(inClone('release-check.sh', 'v0.2.0', 'origin/main').status).toBe(1);
    expect(inClone('release-tag.sh', 'v0.2.0').status).toBe(0);
    expect(g('cat-file', '-t', 'refs/tags/v0.2.0')).toBe('tag');
    expect(inClone('release-check.sh', 'v0.2.0', 'origin/main').status).toBe(0);
  });
  it('fails on a tag origin does not have', () => {
    expect(inClone('release-tag.sh', 'v9.9.9').status).not.toBe(0);
  });
});

describe('release-github', () => {
  const gh = () =>
    fake(
      'gh',
      [
        '[ "$1 $2" = "release view" ] && exit "$FAKE_EXISTS_EXIT"',
        'if [ "$1 $2" = "release create" ]; then',
        '  while [ $# -gt 0 ]; do [ "$1" = --notes-file ] && cat "$2" > "$FAKE_NOTES"; shift; done',
        'fi',
      ].join('\n')
    );
  it('creates the release of a tag with its notes', () => {
    const log = path.join(repo, 'gh.log');
    const notes = path.join(repo, 'notes.md');
    const r = runWith(
      'release-github.sh',
      { GH: gh(), FAKE_LOG: log, FAKE_NOTES: notes, FAKE_EXISTS_EXIT: '1' },
      'v0.2.0'
    );
    expect(r.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toMatch(
      /release create v0\.2\.0 --verify-tag --title v0\.2\.0 --notes-file /
    );
    expect(fs.readFileSync(notes, 'utf8')).toBe(
      '- feat: second\n- docs: a fix to the readme\n'
    );
  });
  it('leaves a release that exists already', () => {
    const log = path.join(repo, 'gh.log');
    const r = runWith(
      'release-github.sh',
      {
        GH: gh(),
        FAKE_LOG: log,
        FAKE_EXISTS_EXIT: '0',
        FAKE_NOTES: '/dev/null',
      },
      'v0.2.0'
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('the GitHub Release v0.2.0 exists already');
    expect(fs.readFileSync(log, 'utf8').trim()).toBe('release view v0.2.0');
  });
});

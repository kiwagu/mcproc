import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepare,
  connect,
  clearResolutionCache,
  type Context,
} from '../../src/core/resolve.js';
import { actOn, Fleet } from '../../src/core/fleet.js';
import { listApps } from '../../src/core/list.js';
import { loadManifest } from '../../src/core/manifest.js';
import { findProcess } from '../../src/core/pm2.js';
import { readRegistry, registryPath } from '../../src/core/slots.js';
import { waitFor } from '../../src/core/wait.js';
import {
  defaultWorktreeDeps,
  worktreeAdd,
  worktreeLs,
  worktreeRemove,
  type WorktreeDeps,
} from '../../src/core/worktree.js';

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const PORT = 38331; // slot 0; slot 1 is 100 above
// the fixtures' own git calls run without the user's global or system config (commit signing, a hooks directory)
const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).toString();

let base: string;
let main: string;
let ctx: Context;
let deps: WorktreeDeps;
let prevState: string | undefined;
const logged: string[] = [];

beforeAll(async () => {
  prevState = process.env.MCPROC_STATE_DIR;
  base = fs.mkdtempSync('/tmp/mcproc-wti-'); // short on purpose: unix socket paths are capped at 108 bytes
  process.env.MCPROC_STATE_DIR = path.join(base, 'state');
  // the main checkout as git and the registry see it: the real path
  fs.mkdirSync(path.join(base, 'demo', '.mcproc'), { recursive: true });
  main = fs.realpathSync(path.join(base, 'demo'));
  fs.writeFileSync(
    path.join(main, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      'project: demo',
      `vars: { slot: 0, port: "{{ ${PORT} + slot * 100 }}" }`,
      'worktree:',
      '  copy: [certs, "snaps/**/*-snapshots"]',
      '  link: [notes]',
      '  install: false',
      'apps:',
      '  db:',
      '    description: db',
      '    run: node db.js',
      '    env: { PORT: "{{ port }}" }',
      '    port: "{{ port }}"',
      'hosts:',
      '  local:',
      `    pm2_home: ${path.join(base, 'home')}`,
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(main, '.mcproc', '.gitignore'),
    '*\n!.gitignore\n!mcproc.yaml\n'
  );
  fs.writeFileSync(path.join(main, 'db.js'), SERVER);
  fs.mkdirSync(path.join(main, 'certs'));
  fs.writeFileSync(path.join(main, 'certs', 'k.pem'), 'key');
  fs.mkdirSync(path.join(main, 'snaps', 'a.spec.ts-snapshots'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(main, 'snaps', 'a.spec.ts-snapshots', 'x.png'),
    'png'
  );
  fs.mkdirSync(path.join(main, 'notes'));
  fs.writeFileSync(path.join(main, 'notes', 'n.md'), 'note');
  fs.writeFileSync(path.join(main, '.gitignore'), 'certs/\nsnaps/\nnotes/\n');
  git(['init', '-q', '-b', 'main'], main);
  git(['add', '-A'], main);
  git(['commit', '-qm', 'init'], main);
  clearResolutionCache();
  ctx = await connect(prepare({ project: main }));
  deps = await defaultWorktreeDeps(ctx, { out: (s) => logged.push(s) });
});
afterAll(async () => {
  try {
    await ctx.pm2.run(['kill']);
  } catch {
    /* daemon already gone */
  }
  if (prevState === undefined) delete process.env.MCPROC_STATE_DIR;
  else process.env.MCPROC_STATE_DIR = prevState;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('worktree add/remove against real pm2', () => {
  it('add makes the checkout, its stand comes up on its own slot, ls counts it, remove takes it all down', async () => {
    const m = loadManifest(main);
    expect(deps.stateDir).toBe(path.join(base, 'state'));
    const added = await worktreeAdd(
      m,
      { branch: 'feat/x', install: true },
      deps
    );
    const wt = path.join(`${main}.worktrees`, 'feat', 'x');
    expect(added).toMatchObject({
      path: wt,
      branch: 'feat/x',
      created_branch: true,
      slot: 1,
      project: 'demo-w1',
      repo: main,
      copied: ['certs', path.join('snaps', 'a.spec.ts-snapshots')],
      linked: ['notes'],
      missing: [],
      installed: null, // worktree.install: false
      next: `cd ${wt} && mcproc start db`,
    });
    expect(git(['branch', '--show-current'], wt).trim()).toBe('feat/x');
    // the override gives it its slot and slug; the copies and the link are in place
    expect(loadManifest(wt)).toMatchObject({
      project: 'demo-w1',
      base_project: 'demo',
      repo: main,
      slot: 1,
      override: path.join(wt, '.mcproc', 'mcproc.local.yaml'),
    });
    expect(fs.readFileSync(path.join(wt, 'certs', 'k.pem'), 'utf8')).toBe(
      'key'
    );
    expect(
      fs.existsSync(path.join(wt, 'snaps', 'a.spec.ts-snapshots', 'x.png'))
    ).toBe(true);
    expect(fs.lstatSync(path.join(wt, 'notes')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(wt, 'notes'))).toBe(
      path.join(main, 'notes')
    );

    // `mcproc start db` in the worktree
    await actOn(new Fleet(loadManifest(wt), undefined), 'db', 'start');
    const ctxW = await connect(prepare({ project: wt }));
    expect(
      await waitFor(ctxW, 'db', { kind: 'listening' }, { timeoutMs: 15_000 })
    ).toMatchObject({ ok: true, observed: `:${PORT + 100} ✓` });
    expect(findProcess(await ctx.pm2.jlist(), 'demo-w1', 'db')).toMatchObject({
      name: 'demo-w1-db',
      namespace: 'demo-w1',
      status: 'online',
    });
    expect((await listApps(ctxW, 'db'))[0].ports.checks).toEqual([
      { port: PORT + 100, status: 'listening' },
    ]);

    expect(
      (await worktreeLs(m, deps)).map((r) => [r.slot, r.project, r.online])
    ).toEqual([
      [0, 'demo', 0],
      [1, 'demo-w1', 1],
    ]);
    expect((await worktreeLs(m, deps))[1]).toMatchObject({
      path: wt,
      branch: 'feat/x',
      main: false,
    });

    const removed = await worktreeRemove(m, 'feat/x', { force: true }, deps);
    expect(removed).toEqual({
      path: wt,
      slot: 1,
      branch: 'feat/x',
      stopped: ['db'],
    });
    expect((await ctx.pm2.jlist()).some((p) => p.name === 'demo-w1-db')).toBe(
      false
    );
    expect(fs.existsSync(wt)).toBe(false);
    expect(fs.existsSync(path.join(`${main}.worktrees`, 'feat'))).toBe(false);
    const reg = readRegistry(registryPath(deps.stateDir, 'demo', main));
    expect(Object.keys(reg?.slots ?? {})).toEqual(['0']);
    expect((await worktreeLs(m, deps)).map((r) => r.slot)).toEqual([0]);
    // the branch stays
    expect(git(['branch', '--list', 'feat/x'], main)).toMatch(/feat\/x/);
  }, 60_000);
});

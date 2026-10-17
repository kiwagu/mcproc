import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest } from '../../src/core/manifest.js';
import { readRegistry, registryPath } from '../../src/core/slots.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import { registryOf } from '../../src/core/leases/siblings.js';
import {
  gitRunner,
  installCommand,
  mainCheckout,
  planCopies,
  worktreeAdd,
  worktreeDir,
  worktreeLs,
  worktreeRemove,
  type WorktreeDeps,
} from '../../src/core/worktree.js';

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

describe('worktree', () => {
  let base: string;
  let main: string;
  /** the main checkout as git and the registry see it: the real path (the temp dir may sit behind a symlink) */
  let real: string;
  let state: string;
  let ran: { cmd: string; cwd: string }[];
  let stopped: string[];
  let online: { name: string; namespace: string }[];
  const deps = (): WorktreeDeps => ({
    git: gitRunner,
    stateDir: state,
    run: async (cmd, cwd) => {
      ran.push({ cmd, cwd });
      return 0;
    },
    log: () => undefined,
    jlist: async () =>
      online.map((p) => ({
        name: p.name,
        namespace: p.namespace,
        status: 'online',
        pid: 1,
        pm_id: 0,
        cwd: '',
        out_log: '',
        err_log: '',
        restarts: 0,
        unstable_restarts: 0,
        exit_code: null,
        uptime_ms: 1,
        started_at: 1,
        cpu: 0,
        memory: 0,
        watch: false,
      })),
    stopAll: async (root) => {
      stopped.push(root);
      return ['db'];
    },
  });
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wt-'));
    main = path.join(base, 'demo');
    state = path.join(base, 'state');
    ran = [];
    stopped = [];
    online = [];
    fs.mkdirSync(path.join(main, '.mcproc'), { recursive: true });
    real = fs.realpathSync(main);
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: demo',
        'vars: { slot: 0, port: "{{ 3000 + slot * 100 }}" }',
        'worktree:',
        '  copy: [certs, "snaps/**/*-snapshots"]',
        '  link: [notes]',
        'apps:',
        '  db:',
        '    description: db',
        '    run: node db.js',
        '    port: "{{ port }}"',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(main, '.mcproc', '.gitignore'),
      '*\n!.gitignore\n!mcproc.yaml\n'
    );
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
    fs.writeFileSync(path.join(main, 'bun.lock'), '');
    fs.writeFileSync(path.join(main, '.gitignore'), 'certs/\nsnaps/\nnotes/\n');
    git(['init', '-q', '-b', 'main'], main);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], main);
    git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
      main
    );
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('helpers: main checkout, worktree dir, install command, copy plan', async () => {
    expect(await mainCheckout(main, gitRunner)).toBe(real);
    const m = loadManifest(main);
    expect(worktreeDir(m, main)).toBe(`${main}.worktrees`);
    expect(installCommand(m, main)).toBe('bun install');
    const plan = planCopies(
      main,
      '/t',
      ['certs', 'snaps/**/*-snapshots', 'missing.txt'],
      ['notes']
    );
    expect(plan.copies).toEqual([
      { from: path.join(main, 'certs'), to: '/t/certs' },
      {
        from: path.join(main, 'snaps', 'a.spec.ts-snapshots'),
        to: '/t/snaps/a.spec.ts-snapshots',
      },
    ]);
    expect(plan.links).toEqual([
      { from: path.join(main, 'notes'), to: '/t/notes' },
    ]);
    expect(plan.missing).toEqual(['missing.txt']);
  });

  it('add: creates the worktree on a new branch, copies, links, writes the override, claims slot 1, installs', async () => {
    const m = loadManifest(main);
    const r = await worktreeAdd(m, { branch: 'feat/x', install: true }, deps());
    const wt = path.join(`${real}.worktrees`, 'feat', 'x');
    expect(r).toMatchObject({
      path: wt,
      branch: 'feat/x',
      created_branch: true,
      slot: 1,
      project: 'demo-w1',
      repo: real,
      copied: ['certs', 'snaps/a.spec.ts-snapshots'],
      linked: ['notes'],
      missing: [],
      installed: 'bun install',
    });
    expect(r.vars.find((v) => v.name === 'port')?.value).toBe(3100);
    expect(r.next).toBe(`cd ${wt} && mcproc start db`);
    expect(fs.readFileSync(path.join(wt, 'certs', 'k.pem'), 'utf8')).toBe(
      'key'
    );
    expect(fs.lstatSync(path.join(wt, 'notes')).isSymbolicLink()).toBe(true);
    const override = fs.readFileSync(
      path.join(wt, '.mcproc', 'mcproc.local.yaml'),
      'utf8'
    );
    expect(override).toContain('project: demo-w1');
    expect(override).toContain(`repo: ${real}`);
    expect(override).toContain('slot: 1');
    // the committed .mcproc/.gitignore already hides the override: it is kept as it is
    expect(
      fs.readFileSync(path.join(wt, '.mcproc', '.gitignore'), 'utf8')
    ).toBe('*\n!.gitignore\n!mcproc.yaml\n');
    expect(git(['branch', '--show-current'], wt).trim()).toBe('feat/x');
    expect(ran).toEqual([{ cmd: 'bun install', cwd: wt }]);
    const reg = readRegistry(registryPath(state, 'demo', real))!;
    expect(reg.slots['0'].path).toBe(real);
    expect(reg.slots['1']).toMatchObject({
      path: wt,
      branch: 'feat/x',
      project: 'demo-w1',
    });
    expect(loadManifest(wt).project).toBe('demo-w1');
  });

  it('add: an existing branch is checked out as it is; without a .mcproc/.gitignore one that hides everything is written', async () => {
    fs.rmSync(path.join(main, '.mcproc', '.gitignore'));
    fs.writeFileSync(path.join(main, '.gitignore'), 'certs/\nsnaps/\nnotes\n');
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], main);
    git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'two'],
      main
    );
    git(['branch', 'old'], main);
    const r = await worktreeAdd(
      loadManifest(main),
      { branch: 'old', install: false },
      deps()
    );
    expect(r).toMatchObject({ branch: 'old', created_branch: false });
    expect(ran).toEqual([]);
    expect(
      fs.readFileSync(path.join(r.path, '.mcproc', '.gitignore'), 'utf8')
    ).toBe('*\n');
    expect(git(['status', '--porcelain'], r.path).trim()).toBe('');
  });

  it('add: refuses a branch checked out elsewhere, an existing directory and a taken slot', async () => {
    const m = loadManifest(main);
    await expect(
      worktreeAdd(m, { branch: 'main', install: false }, deps())
    ).rejects.toMatchObject({ code: 'WORKTREE_EXISTS' });
    await worktreeAdd(m, { branch: 'a', install: false }, deps());
    await expect(
      worktreeAdd(m, { branch: 'a', install: false }, deps())
    ).rejects.toMatchObject({ code: 'WORKTREE_EXISTS' });
    await expect(
      worktreeAdd(m, { branch: 'b', slot: 1, install: false }, deps())
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
  });

  it('add: refuses a bad branch name, slot or project slug before anything is made, and gives the slot back when git fails', async () => {
    const m = loadManifest(main);
    const wts = `${real}.worktrees`;
    for (const opts of [
      { branch: '../escape' },
      { branch: 'b', slot: 1.5 },
      { branch: 'b', project: 'Not A Slug' },
    ])
      await expect(
        worktreeAdd(m, { ...opts, install: false }, deps())
      ).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    expect(fs.existsSync(wts)).toBe(false);
    await expect(
      worktreeAdd(
        m,
        { branch: 'c', from: 'no-such-ref', install: false },
        deps()
      )
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(fs.existsSync(path.join(wts, 'c'))).toBe(false);
    expect(
      readRegistry(registryPath(state, 'demo', real))!.slots['1']
    ).toBeUndefined();
    const r = await worktreeAdd(m, { branch: 'c', install: false }, deps());
    expect(r.slot).toBe(1);
  });

  it('add: the claim waits for the host lock, and parallel runs claim different slots', async () => {
    const m = loadManifest(main);
    const store = new LeaseStore(state);
    let release!: () => void;
    let holding!: () => void;
    const took = new Promise<void>((r) => {
      holding = r;
    });
    const held = store.withLock(
      () =>
        new Promise<void>((r) => {
          release = r;
          holding();
        })
    );
    await took;
    const waiting = worktreeAdd(m, { branch: 'h', install: false }, deps());
    // a run that waits for the lock keeps its token file next to it
    const queued = () =>
      fs.readdirSync(store.dir).some((f) => /^\.lock\..+\.tmp$/.test(f));
    for (let i = 0; i < 300 && !queued(); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(queued()).toBe(true);
    expect(readRegistry(registryPath(state, 'demo', real))).toBeNull();
    expect(fs.existsSync(path.join(`${real}.worktrees`, 'h'))).toBe(false);
    release();
    await held;
    expect((await waiting).slot).toBe(1);
    const rs = await Promise.all(
      ['p', 'q'].map((branch) =>
        worktreeAdd(m, { branch, install: false }, deps())
      )
    );
    expect(rs.map((r) => r.slot).sort()).toEqual([2, 3]);
    for (const r of rs) expect(r.project).toBe(`demo-w${r.slot}`);
    const reg = readRegistry(registryPath(state, 'demo', real))!;
    expect(Object.keys(reg.slots).sort()).toEqual(['0', '1', '2', '3']);
    for (const r of rs) expect(reg.slots[String(r.slot)].branch).toBe(r.branch);
  });

  it('add through a symlink to the main checkout stores real paths, and the registry is found from either path', async () => {
    const link = path.join(base, 'link');
    fs.symlinkSync(main, link);
    const m = loadManifest(link);
    expect(m.repo).toBe(link);
    const r = await worktreeAdd(m, { branch: 's', install: false }, deps());
    expect(r.repo).toBe(real);
    expect(r.path).toBe(path.join(`${real}.worktrees`, 's'));
    expect(
      fs.readFileSync(path.join(r.path, '.mcproc', 'mcproc.local.yaml'), 'utf8')
    ).toContain(`repo: ${real}`);
    const viaLink = registryOf(m, state);
    expect(viaLink?.slots['0'].path).toBe(real);
    expect(viaLink?.slots['1'].path).toBe(r.path);
    expect(registryOf(loadManifest(main), state)).toEqual(viaLink);
    expect(registryOf(loadManifest(r.path), state)).toEqual(viaLink);
  });

  it('add: a worktree.dir behind a symlink lands at its real path; remove clears the folders a branch with slashes made', async () => {
    const wtreal = path.join(base, 'wtreal');
    fs.mkdirSync(wtreal);
    fs.symlinkSync(wtreal, path.join(base, 'wtlink'));
    const file = path.join(main, '.mcproc', 'mcproc.yaml');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace('worktree:\n', 'worktree:\n  dir: ../wtlink\n')
    );
    const m = loadManifest(main);
    expect(m.worktree.dir).toBe('../wtlink');
    const r = await worktreeAdd(
      m,
      { branch: 'feat/z', install: false },
      deps()
    );
    expect(r.path).toBe(path.join(fs.realpathSync(wtreal), 'feat', 'z'));
    expect(
      readRegistry(registryPath(state, 'demo', real))!.slots['1'].path
    ).toBe(r.path);
    await worktreeRemove(m, 'feat/z', { force: true }, deps());
    expect(fs.readdirSync(wtreal)).toEqual([]);
  });

  it('ls and remove: the registry with branches, online apps and leases; remove stops, removes and frees', async () => {
    const m = loadManifest(main);
    const a = await worktreeAdd(m, { branch: 'a', install: false }, deps());
    online = [{ name: 'demo-w1-db', namespace: 'demo-w1' }];
    const store = new LeaseStore(state);
    await store.create(
      {
        kind: 'start',
        project: 'demo-w1',
        root: a.path,
        slot: 1,
        repo: real,
        target: 'db',
        apps: ['db'],
        reload: false,
        estimate_mib: 1,
        need_mib: 1,
        margin: 0,
        reserve_mib: 0,
        sources: {},
        note: null,
        requester_pid: 1,
      },
      'running'
    );
    const rows = await worktreeLs(m, deps());
    expect(rows).toEqual([
      {
        slot: 0,
        project: 'demo',
        path: real,
        branch: 'main',
        online: 0,
        lease: null,
        main: true,
      },
      {
        slot: 1,
        project: 'demo-w1',
        path: a.path,
        branch: 'a',
        online: 1,
        lease: 'running',
        main: false,
      },
    ]);
    // the same table from inside the worktree
    expect(await worktreeLs(loadManifest(a.path), deps())).toEqual(rows);
    fs.writeFileSync(path.join(a.path, 'dirty.txt'), 'x');
    await expect(
      worktreeRemove(m, 'a', { force: false }, deps())
    ).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(stopped).toEqual([]);
    const r = await worktreeRemove(m, '1', { force: true }, deps());
    expect(r).toEqual({ path: a.path, slot: 1, branch: 'a', stopped: ['db'] });
    expect(stopped).toEqual([a.path]);
    expect(fs.existsSync(a.path)).toBe(false);
    // the linked folder of the main checkout survives the removal of its link
    expect(fs.readFileSync(path.join(main, 'notes', 'n.md'), 'utf8')).toBe(
      'note'
    );
    expect(
      readRegistry(registryPath(state, 'demo', real))!.slots['1']
    ).toBeUndefined();
    expect(git(['branch', '--list', 'a'], main)).toContain('a');
    await expect(
      worktreeRemove(m, '0', { force: true }, deps())
    ).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    await expect(
      worktreeRemove(m, 'nope', { force: true }, deps())
    ).rejects.toMatchObject({ code: 'NOT_A_WORKTREE' });
  });

  it('remove by path, and ls reclaims a slot whose checkout is gone', async () => {
    const m = loadManifest(main);
    const a = await worktreeAdd(m, { branch: 'a', install: false }, deps());
    const b = await worktreeAdd(m, { branch: 'b', install: false }, deps());
    const r = await worktreeRemove(m, a.path, { force: true }, deps());
    expect(r).toMatchObject({ slot: 1, branch: 'a' });
    fs.rmSync(b.path, { recursive: true, force: true });
    await expect(
      worktreeAdd(m, { branch: 'b', install: false }, deps())
    ).rejects.toMatchObject({
      code: 'WORKTREE_EXISTS',
      hint: expect.stringContaining('git worktree prune'),
    });
    const logged: string[] = [];
    const rows = await worktreeLs(m, { ...deps(), log: (l) => logged.push(l) });
    expect(rows.map((x) => x.slot)).toEqual([0]);
    expect(logged).toEqual(['slot 2 reclaimed: its checkout is gone']);
    expect(
      Object.keys(readRegistry(registryPath(state, 'demo', real))!.slots)
    ).toEqual(['0']);
  });
});

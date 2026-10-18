import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest } from '../../src/core/manifest.js';
import {
  readRegistry,
  registryPath,
  writeRegistry,
} from '../../src/core/slots.js';
import type { Connector } from '../../src/core/fleet.js';
import { MARK } from '../../src/shell/snippets.js';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import { registryOf } from '../../src/core/leases/siblings.js';
import {
  excludePattern,
  gitRunner,
  installCommand,
  mainCheckout,
  planCopies,
  stopCheckout,
  worktreeAdd,
  worktreeDir,
  worktreeLs,
  worktreeRemove,
  type WorktreeDeps,
} from '../../src/core/worktree.js';

// the fixtures' own git calls run without the user's global or system config (commit signing, a hooks directory)
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitEnv }).toString();

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

  it('excludePattern: root-anchored, normalized and escaped; null outside the root', () => {
    expect(excludePattern('notes')).toBe('/notes');
    expect(excludePattern('./notes')).toBe('/notes');
    expect(excludePattern('a//b/')).toBe('/a/b');
    expect(excludePattern('odd[1]*?\\')).toBe('/odd\\[1\\]\\*\\?\\\\');
    expect(excludePattern('a b ')).toBe('/a b\\ ');
    expect(excludePattern('../x')).toBeNull();
    expect(excludePattern('.')).toBeNull();
  });
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

  it("add: the new worktree's manifest decides the slot var, the copies and the install; the main checkout's only when the worktree has none", async () => {
    // main: no vars, no copies, no install hint; the branch: a slot var and a copy list, as a branch that introduces slots has
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: demo',
        'worktree: { install: false }',
        'apps:',
        '  db:',
        '    description: db',
        '    run: node db.js',
        '',
      ].join('\n')
    );
    const c = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    git([...c, 'commit', '-qam', 'main without slots'], main);
    git(['switch', '-qc', 'feat/slots'], main);
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: demo',
        'vars: { slot: 0, port: "{{ 3000 + slot * 100 }}" }',
        'worktree:',
        '  copy: [certs]',
        // templates in the worktree section see this checkout's slug and slot, not the main's
        '  install: "echo {{ project }} {{ slot }}"',
        'apps:',
        '  db:',
        '    description: db',
        '    run: node db.js',
        '    port: "{{ port }}"',
        '',
      ].join('\n')
    );
    git([...c, 'commit', '-qam', 'slots on the branch'], main);
    git(['switch', '-q', 'main'], main);
    const m = loadManifest(main);
    expect(m.slot).toBeNull();
    const r = await worktreeAdd(
      m,
      { branch: 'feat/slots', install: true },
      deps()
    );
    const wt = path.join(`${real}.worktrees`, 'feat', 'slots');
    expect(r).toMatchObject({
      slot: 1,
      manifest: 'worktree',
      copied: ['certs'],
      linked: [],
      installed: 'echo demo-w1 1',
    });
    expect(
      fs.readFileSync(path.join(wt, '.mcproc', 'mcproc.local.yaml'), 'utf8')
    ).toContain('slot: 1');
    expect(r.vars.find((v) => v.name === 'port')?.value).toBe(3100);
    expect(fs.existsSync(path.join(wt, 'certs', 'k.pem'))).toBe(true);
    expect(ran).toEqual([{ cmd: 'echo demo-w1 1', cwd: wt }]);
    // the other way round: main declares a slot, the branch does not: the override gets no slot var
    git(['switch', '-qc', 'feat/plain', 'main'], main);
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.yaml'),
      'version: 1\nproject: demo\napps:\n  db:\n    description: db\n    run: node db.js\n'
    );
    git([...c, 'commit', '-qam', 'plain'], main);
    git(['switch', '-q', 'main'], main);
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: demo',
        'vars: { slot: 0 }',
        'worktree: { copy: [certs], install: false }',
        'apps:',
        '  db:',
        '    description: db',
        '    run: node db.js',
        '',
      ].join('\n')
    );
    const r2 = await worktreeAdd(
      loadManifest(main),
      { branch: 'feat/plain', install: true },
      deps()
    );
    // the plain manifest declares no install: the lockfile decides, as for any checkout
    expect(r2).toMatchObject({
      slot: 2,
      manifest: 'worktree',
      copied: [],
      installed: 'bun install',
    });
    expect(
      fs.readFileSync(
        path.join(r2.path, '.mcproc', 'mcproc.local.yaml'),
        'utf8'
      )
    ).not.toContain('slot:');
  });

  it("add: copy and link extras from the main checkout's override, and every link is ignored through git's exclude file", async () => {
    fs.mkdirSync(path.join(main, 'private'));
    fs.writeFileSync(path.join(main, 'private', 'p.md'), 'private');
    fs.mkdirSync(path.join(main, 'odd[1]'));
    fs.writeFileSync(path.join(main, 'odd[1]', 'o.md'), 'odd');
    fs.mkdirSync(path.join(main, 'extra', 'a'), { recursive: true });
    fs.writeFileSync(path.join(main, 'extra', 'a', 'one.txt'), 'one');
    fs.writeFileSync(path.join(main, 'local.env'), 'X=1');
    // `./private` is the same link as `private`; `odd[1]` is a literal name git would read as a wildcard; a glob copy
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.local.yaml'),
      'worktree:\n  copy: [local.env, "extra/**/*.txt"]\n  link: [./private, "odd[1]"]\n'
    );
    const r = await worktreeAdd(
      loadManifest(main),
      { branch: 'feat/x', install: false },
      deps()
    );
    expect(r).toMatchObject({
      copied: [
        'certs',
        'snaps/a.spec.ts-snapshots',
        'local.env',
        'extra/a/one.txt',
      ],
      linked: ['notes', 'private', 'odd[1]'],
      from_override: ['local.env', 'extra/a/one.txt', 'private', 'odd[1]'],
      excluded: ['/notes', '/private', '/odd\\[1\\]'],
    });
    expect(fs.readFileSync(path.join(r.path, 'local.env'), 'utf8')).toBe('X=1');
    expect(
      fs.readFileSync(path.join(r.path, 'extra', 'a', 'one.txt'), 'utf8')
    ).toBe('one');
    expect(fs.lstatSync(path.join(r.path, 'private')).isSymbolicLink()).toBe(
      true
    );
    expect(fs.lstatSync(path.join(r.path, 'odd[1]')).isSymbolicLink()).toBe(
      true
    );
    // the exclude file is the repository's own (shared by its worktrees), never a tracked file
    const exclude = fs.readFileSync(
      path.join(real, '.git', 'info', 'exclude'),
      'utf8'
    );
    expect(exclude).toContain('/notes\n');
    expect(exclude).toContain('/private\n');
    expect(exclude).toContain('/odd\\[1\\]\n');
    // the links are ignored; the copies show as the untracked files they are
    expect(
      git(['status', '--porcelain'], r.path)
        .trim()
        .split('\n')
        .filter(Boolean)
        .sort()
    ).toEqual(['?? extra/', '?? local.env']);
    // a second worktree writes no duplicate lines
    await worktreeAdd(
      loadManifest(main),
      { branch: 'feat/y', install: false },
      deps()
    );
    expect(
      fs
        .readFileSync(path.join(real, '.git', 'info', 'exclude'), 'utf8')
        .match(/\/private\n/g)?.length
    ).toBe(1);
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
        host: null,
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

  it('remove by path; ls shows a slot whose checkout is gone as (gone) and leaves it to add, which reclaims it', async () => {
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
    const file = registryPath(state, 'demo', real);
    const before = fs.readFileSync(file, 'utf8');
    const logged: string[] = [];
    const rows = await worktreeLs(m, { ...deps(), log: (l) => logged.push(l) });
    expect(rows.map((x) => [x.slot, x.branch])).toEqual([
      [0, 'main'],
      [2, '(gone)'],
    ]);
    expect(logged).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const c = await worktreeAdd(
      m,
      { branch: 'c', install: false },
      { ...deps(), log: (l) => logged.push(l) }
    );
    expect(c.slot).toBe(1);
    expect(logged).toContain('slot 2 reclaimed: its checkout is gone');
    expect(Object.keys(readRegistry(file)!.slots)).toEqual(['0', '1']);
  });

  it('ls writes nothing: without a registry it shows the main checkout and records no slot 0', async () => {
    const rows = await worktreeLs(loadManifest(main), deps());
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
    ]);
    expect(fs.existsSync(registryPath(state, 'demo', real))).toBe(false);
    expect(fs.existsSync(path.join(state, 'leases'))).toBe(false);
  });

  it('git gets `--` before its positionals: a `from` that looks like an option is a ref git refuses', async () => {
    const m = loadManifest(main);
    const calls: string[][] = [];
    const recording: WorktreeDeps = {
      ...deps(),
      git: (args, cwd) => {
        calls.push(args);
        return gitRunner(args, cwd);
      },
    };
    await expect(
      worktreeAdd(
        m,
        { branch: 'n', from: '--no-checkout', install: false },
        recording
      )
    ).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
      message: expect.stringContaining('--no-checkout'),
    });
    expect(fs.existsSync(path.join(`${real}.worktrees`, 'n'))).toBe(false);
    expect(git(['branch', '--list', 'n'], main).trim()).toBe('');
    const a = await worktreeAdd(m, { branch: 'a', install: false }, recording);
    await worktreeRemove(m, 'a', { force: true }, recording);
    const positional = calls.filter((c) =>
      ['show-ref', 'worktree add', 'worktree remove'].some((p) =>
        c.join(' ').startsWith(p)
      )
    );
    expect(positional.length).toBeGreaterThanOrEqual(4);
    for (const c of positional) expect(c, c.join(' ')).toContain('--');
    expect(calls).toContainEqual([
      'worktree',
      'remove',
      '--force',
      '--',
      a.path,
    ]);
  });

  it('a copy that fails leaves the worktree registered with its override in place, and says so', async () => {
    // a branch whose tree has a file where the manifest copies a folder
    const tmp = path.join(base, 'tmp-clash');
    git(['worktree', 'add', '-q', '-b', 'clash', tmp], main);
    fs.writeFileSync(path.join(tmp, 'certs'), 'a file');
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'certs'], tmp);
    git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'clash'],
      tmp
    );
    git(['worktree', 'remove', tmp], main);
    const m = loadManifest(main);
    const wt = path.join(`${real}.worktrees`, 'clash');
    await expect(
      worktreeAdd(m, { branch: 'clash', install: false }, deps())
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      message: expect.stringContaining(
        `worktree ${wt} is made (slot 1, project demo-w1, its override in place), but copying ${path.join(real, 'certs')} failed`
      ),
    });
    const wm = loadManifest(wt);
    expect(wm.project).toBe('demo-w1');
    expect(wm.slot).toBe(1);
    expect(
      readRegistry(registryPath(state, 'demo', real))!.slots['1']
    ).toMatchObject({ path: wt, project: 'demo-w1' });
  });

  it('remove takes back the slot of an add that ended between its claim and git: an empty folder', async () => {
    const m = loadManifest(main);
    await worktreeAdd(m, { branch: 'a', install: false }, deps());
    const file = registryPath(state, 'demo', real);
    const crashed = path.join(`${real}.worktrees`, 'crashed');
    fs.mkdirSync(crashed);
    const reg = readRegistry(file)!;
    writeRegistry(file, {
      ...reg,
      slots: {
        ...reg.slots,
        '2': { path: crashed, branch: 'crashed', project: 'demo-w2' },
      },
    });
    const r = await worktreeRemove(m, 'crashed', { force: false }, deps());
    expect(r).toEqual({
      path: crashed,
      slot: 2,
      branch: 'crashed',
      stopped: [],
    });
    expect(fs.existsSync(crashed)).toBe(false);
    expect(Object.keys(readRegistry(file)!.slots)).toEqual(['0', '1']);
    expect(stopped).toEqual([]);
  });

  describe('a branch without a manifest, and the real stop of a checkout', () => {
    const never: Connector = async (_m, host) => {
      throw new Error(`must not connect to ${host}`);
    };
    const realStop = (logged: string[]): WorktreeDeps => ({
      ...deps(),
      log: (l) => logged.push(l),
      stopAll: (root, o) =>
        stopCheckout(root, {
          force: o.force,
          log: (l) => logged.push(l),
          connector: never,
        }),
    });
    /** a branch `bare` whose tree has no .mcproc/mcproc.yaml */
    const bareBranch = () => {
      const tmp = path.join(base, 'tmp-bare');
      git(['worktree', 'add', '-q', '-b', 'bare', tmp], main);
      git(['rm', '-q', '.mcproc/mcproc.yaml'], tmp);
      git(
        ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'bare'],
        tmp
      );
      git(['worktree', 'remove', tmp], main);
    };

    it('add reads no manifest for it, and remove --force removes it without stopping anything', async () => {
      bareBranch();
      const m = loadManifest(main);
      const logged: string[] = [];
      const r = await worktreeAdd(
        m,
        { branch: 'bare', install: false },
        realStop(logged)
      );
      expect(r).toMatchObject({ vars: [], next: `cd ${r.path}` });
      expect(logged).toContain(
        `${r.path} has no manifest of its own (${path.join('.mcproc', 'mcproc.yaml')}): no vars, nothing to start`
      );
      const rm = await worktreeRemove(
        m,
        'bare',
        { force: true },
        realStop(logged)
      );
      expect(rm).toMatchObject({ slot: 1, stopped: [] });
      expect(logged).toContain(
        `${r.path} has no manifest of its own: no apps to stop`
      );
      expect(fs.existsSync(r.path)).toBe(false);
    });

    it('with worktree.dir inside the main checkout, neither add nor remove ever reads the main manifest', async () => {
      bareBranch();
      const file = path.join(main, '.mcproc', 'mcproc.yaml');
      fs.writeFileSync(
        file,
        fs
          .readFileSync(file, 'utf8')
          .replace('worktree:\n', 'worktree:\n  dir: .wt\n')
      );
      const m = loadManifest(main);
      const logged: string[] = [];
      const r = await worktreeAdd(
        m,
        { branch: 'bare', install: false },
        realStop(logged)
      );
      expect(r.path).toBe(path.join(real, '.wt', 'bare'));
      // the main's vars would say port 3000 and next would start the main's db
      expect(r).toMatchObject({ vars: [], next: `cd ${r.path}` });
      const rm = await worktreeRemove(
        m,
        'bare',
        { force: true },
        realStop(logged)
      );
      expect(rm.stopped).toEqual([]);
      expect(fs.existsSync(r.path)).toBe(false);
    });

    it('stopCheckout deletes the apps on writable hosts and leaves a readonly-bound one alone', async () => {
      const dir = path.join(base, 'ro-demo');
      fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: ro-demo',
          'apps:',
          '  db: { description: db, run: node db.js }',
          '  audit: { description: audit, run: node audit.js, host: ro }',
          'hosts:',
          '  ro: { ssh: ro, cwd: /srv/ro, readonly: true }',
          '',
        ].join('\n')
      );
      const list = JSON.stringify([
        {
          pid: 7,
          name: 'ro-demo-db',
          pm_id: 4,
          pm2_env: {
            status: 'online',
            namespace: 'ro-demo',
            pm_cwd: dir,
            pm_out_log_path: '/l/db-out',
            pm_err_log_path: '/l/db-err',
          },
        },
      ]);
      const connected: string[] = [];
      const deleted: string[] = [];
      const connector: Connector = async (_m, host, fallback) => {
        connected.push(host);
        return fakeCtx(
          dir,
          host,
          [
            {
              match: MARK.JLIST,
              result: { stdout: probeOut({ jlist: list }) },
            },
            { match: /pm2 'jlist'/, result: { stdout: list } },
            {
              match: /'delete'/,
              result: (cmd) => {
                deleted.push(cmd);
                return { stdout: '' };
              },
            },
          ],
          fallback
        );
      };
      const logged: string[] = [];
      const names = await stopCheckout(dir, {
        force: false,
        log: (l) => logged.push(l),
        connector,
      });
      expect(names).toEqual(['db']);
      expect(deleted).toEqual(["pm2 'delete' '4'"]);
      expect(connected).toEqual(['local']);
      expect(logged).toEqual(['audit runs on readonly host ro: left alone']);
      // a manifest that does not load: refused, or noted with force
      fs.writeFileSync(
        path.join(dir, '.mcproc', 'mcproc.yaml'),
        'version: 2\n'
      );
      await expect(
        stopCheckout(dir, { force: false, log: () => undefined, connector })
      ).rejects.toMatchObject({ code: 'MANIFEST_INVALID' });
      const noted: string[] = [];
      expect(
        await stopCheckout(dir, {
          force: true,
          log: (l) => noted.push(l),
          connector,
        })
      ).toEqual([]);
      expect(noted[0]).toMatch(
        /does not load \(MANIFEST_INVALID: [\s\S]*\): its apps are not stopped$/
      );
    });
  });
});

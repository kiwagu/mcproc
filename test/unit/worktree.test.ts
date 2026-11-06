import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
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
import { stripGitVars } from '../helpers/git-env.js';
import { probeOut } from '../helpers/probe.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import { projectFile, recordProject } from '../../src/core/registry.js';
import { registryOf } from '../../src/core/leases/siblings.js';
import { hookPath } from '../../src/core/worktree-hook.js';
import {
  excludePattern,
  installCommand,
  isFreshCheckout,
  isGlob,
  mainCheckout,
  planCopies,
  pruneEmptyParents,
  stopCheckout,
  worktreeAdd,
  worktreeDir,
  worktreeLs,
  worktreeRemove,
  worktreeSync,
  type GitRunner,
  type WorktreeDeps,
} from '../../src/core/worktree.js';

// the fixtures' own git calls run without the user's global or system config (commit signing, a hooks directory) and
// without any git variable from outside (another repository, object store or config file)
const gitEnv = stripGitVars({
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
});
const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitEnv }).toString();
// the code under test gets the same isolation: a hook or identity in this machine's git config never reaches the git
// it runs (`git worktree add` fires a post-checkout hook); the answer has the production runner's shape, never a throw,
// and the env the code passes reaches git (and its hooks) over that isolation, as the production runner merges it
const isolatedGit: GitRunner = (args, cwd, env) =>
  new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { cwd, env: { ...gitEnv, ...env }, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr) || (err ? err.message : ''),
        })
    );
  });

/** whether the suite runs as root, whom chmod denies nothing */
const asRoot = process.getuid?.() === 0;

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
    git: isolatedGit,
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
    // tool-local.yml stands for a machine-local file a worktree requires: never in git
    fs.writeFileSync(
      path.join(main, '.gitignore'),
      'certs/\nsnaps/\nnotes/\ntool-local.yml\n'
    );
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
  it('pruneEmptyParents: empty folders go up to the top, a gone one is passed over, a full one ends it', () => {
    const top = path.join(base, 'wts');
    fs.mkdirSync(path.join(top, 'a', 'b'), { recursive: true });
    // `c` is gone already: `b` and `a` are empty and go, `top` stays
    expect(pruneEmptyParents(path.join(top, 'a', 'b', 'c'), top)).toEqual([]);
    expect(fs.existsSync(path.join(top, 'a'))).toBe(false);
    expect(fs.existsSync(top)).toBe(true);
    fs.mkdirSync(path.join(top, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(top, 'a', 'keep'), '');
    expect(pruneEmptyParents(path.join(top, 'a', 'b'), top)).toEqual([]);
    expect(fs.existsSync(path.join(top, 'a', 'b'))).toBe(false);
    expect(fs.existsSync(path.join(top, 'a', 'keep'))).toBe(true);
  });
  // a read-only folder denies nobody when the suite runs as root: no EACCES to answer
  it.skipIf(asRoot)(
    'pruneEmptyParents: a folder it cannot remove is answered with its error',
    () => {
      const top = path.join(base, 'wts');
      fs.mkdirSync(path.join(top, 'a'), { recursive: true });
      fs.chmodSync(top, 0o555);
      let failed: { dir: string; error: string }[];
      try {
        failed = pruneEmptyParents(path.join(top, 'a'), top);
      } finally {
        fs.chmodSync(top, 0o755);
      }
      expect(failed).toEqual([
        { dir: path.join(top, 'a'), error: expect.stringContaining('EACCES') },
      ]);
      expect(fs.existsSync(path.join(top, 'a'))).toBe(true);
    }
  );
  it('helpers: main checkout, worktree dir, install command, copy plan', async () => {
    expect(await mainCheckout(main, isolatedGit)).toBe(real);
    const m = loadManifest(main);
    expect(worktreeDir(m, main)).toBe(`${main}.worktrees`);
    expect(installCommand(m, main)).toBe('bun install');
    const plan = planCopies(main, '/t', {
      copy: ['certs', 'snaps/**/*-snapshots', 'missing.txt'],
      required: [],
      link: ['notes'],
    });
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

  it("add: the override's required entries are copied like copy entries; a miss is reported once, and allowed it makes the worktree", async () => {
    fs.writeFileSync(path.join(main, 'local.env'), 'X=1');
    // `certs` is the manifest's copy entry too: gone here, it is one miss, not two
    fs.rmSync(path.join(main, 'certs'), { recursive: true });
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.local.yaml'),
      'worktree:\n  required: [local.env, tool-local.yml, certs]\n'
    );
    const logged: string[] = [];
    const r = await worktreeAdd(
      loadManifest(main),
      { branch: 'feat/x', install: false, allowMissing: true },
      { ...deps(), log: (l) => logged.push(l) }
    );
    expect(r).toMatchObject({
      copied: ['snaps/a.spec.ts-snapshots', 'local.env'],
      from_override: ['local.env'],
      missing: ['certs', 'tool-local.yml'],
      missing_required: ['tool-local.yml', 'certs'],
    });
    expect(fs.readFileSync(path.join(r.path, 'local.env'), 'utf8')).toBe('X=1');
    expect(logged).toContain(
      `copy: tool-local.yml is not in ${real}, skipped (required, allowed)`
    );
  });

  describe('required entries', () => {
    const c = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    const manifestFile = () => path.join(main, '.mcproc', 'mcproc.yaml');
    /** main's working manifest with `required: <list>` in its worktree section (committed only when the test commits it) */
    const requireInMain = (list: string) =>
      fs.writeFileSync(
        manifestFile(),
        fs
          .readFileSync(manifestFile(), 'utf8')
          .replace('worktree:\n', `worktree:\n  required: ${list}\n`)
      );
    /** the manifest leaves git and stays in main as an ignored file: a new worktree has none, so the main checkout's decides */
    const manifestOnlyInMain = () => {
      fs.writeFileSync(path.join(main, '.mcproc', '.gitignore'), '*\n');
      git(['rm', '-q', '--cached', '.mcproc/mcproc.yaml'], main);
      git([...c, 'commit', '-qam', 'manifest only in main'], main);
    };
    const refusal = (
      branch: string,
      extra: Partial<Parameters<typeof worktreeAdd>[1]> = {},
      d: WorktreeDeps = deps()
    ) =>
      worktreeAdd(
        loadManifest(main),
        { branch, install: true, ...extra },
        d
      ).then(
        () => {
          throw new Error('worktreeAdd made the worktree');
        },
        (e) => e
      );
    const worktrees = () =>
      git(['worktree', 'list', '--porcelain'], main)
        .split('\n')
        .filter((l) => l.startsWith('worktree '));
    /**
     * The tests' git with a step of its own before `git worktree remove` (the rollback's first): `before` gets the
     * target. `seen` holds what the target held then, its top level and its `.mcproc`: what the add wrote before the
     * refusal.
     */
    const atRemove = (before: (target: string) => void = () => undefined) => {
      const seen: { top: string[]; mcproc: string[] }[] = [];
      const d: WorktreeDeps = {
        ...deps(),
        git: (args, cwd, env) => {
          if (args[0] === 'worktree' && args[1] === 'remove') {
            const t = args.at(-1)!;
            const mc = path.join(t, '.mcproc');
            seen.push({
              top: fs.readdirSync(t).sort(),
              mcproc: fs.existsSync(mc) ? fs.readdirSync(mc).sort() : [],
            });
            before(t);
          }
          return isolatedGit(args, cwd, env);
        },
      };
      return { d, seen };
    };
    /** git's exclude file of the repository, shared by its worktrees (null while there is none) */
    const exclude = () => {
      const f = path.join(real, '.git', 'info', 'exclude');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    };

    it('missing on a new branch: refused, and nothing of the worktree is kept: no worktree, branch, slot, folder, copy or install', async () => {
      manifestOnlyInMain();
      requireInMain('[tool-local.yml]');
      const excluded = exclude();
      const { d, seen } = atRemove();
      const e = await refusal('feat/x', {}, d);
      // when the rollback began the worktree held only what git checked out: nothing copied, linked or written yet
      expect(seen).toEqual([
        {
          top: ['.git', '.gitignore', '.mcproc', 'bun.lock'],
          mcproc: ['.gitignore'],
        },
      ]);
      // and the link was never written to git's exclude file (git init made it)
      expect(excluded).not.toBeNull();
      expect(exclude()).toBe(excluded);
      expect(e).toMatchObject({
        code: 'REQUIRED_MISSING',
        details: {
          missing: [
            { entry: 'tool-local.yml', source: "the main checkout's manifest" },
          ],
        },
      });
      expect(e.message).toContain(
        "tool-local.yml (the main checkout's manifest)"
      );
      expect(e.message).toContain(real);
      expect(e.message).toMatch(
        /nothing was kept: the worktree, its new branch feat\/x and slot 1$/
      );
      expect(e.hint).toBe(
        `Put them into ${real} (machine-local files, not in git) and run it again, or pass --allow-missing (MCP: allow_missing) to make the worktree without them.`
      );
      expect(worktrees()).toEqual([`worktree ${real}`]);
      expect(git(['branch', '--list', 'feat/x'], main).trim()).toBe('');
      expect(
        Object.keys(readRegistry(registryPath(state, 'demo', real))!.slots)
      ).toEqual(['0']);
      expect(fs.existsSync(path.join(`${real}.worktrees`, 'feat'))).toBe(false);
      expect(ran).toEqual([]);
      // the slot is free again: the next add with the file in place takes it
      fs.writeFileSync(path.join(main, 'tool-local.yml'), 'k: v\n');
      const r = await worktreeAdd(
        loadManifest(main),
        { branch: 'feat/x', install: false },
        deps()
      );
      expect(r).toMatchObject({ slot: 1, created_branch: true });
    });

    it('missing on an existing branch: refused, and the branch stays', async () => {
      manifestOnlyInMain();
      requireInMain('[tool-local.yml]');
      git(['branch', 'feat/y'], main);
      const e = await refusal('feat/y');
      expect(e.code).toBe('REQUIRED_MISSING');
      expect(e.message).toMatch(/nothing was kept: the worktree and slot 1$/);
      expect(git(['branch', '--list', 'feat/y'], main)).toContain('feat/y');
      expect(worktrees()).toEqual([`worktree ${real}`]);
      expect(fs.existsSync(path.join(`${real}.worktrees`, 'feat'))).toBe(false);
    });

    it('a mask that matches nothing is named as written, never a file', async () => {
      manifestOnlyInMain();
      requireInMain('["*-local.{yml,yaml}"]');
      fs.writeFileSync(path.join(main, 'other.yml'), 'x');
      const e = await refusal('feat/x');
      expect(e.code).toBe('REQUIRED_MISSING');
      expect(e.message).toContain(
        "*-local.{yml,yaml} (the main checkout's manifest)"
      );
      expect(e.message).not.toContain('other.yml');
    });

    it("the worktree's own manifest decides: its required entry refuses, the main's working manifest's does not", async () => {
      git(['switch', '-qc', 'feat/req'], main);
      requireInMain('[tool-local.yml]');
      git([...c, 'commit', '-qam', 'require'], main);
      git(['switch', '-q', 'main'], main);
      const e = await refusal('feat/req');
      expect(e).toMatchObject({
        code: 'REQUIRED_MISSING',
        details: {
          missing: [
            { entry: 'tool-local.yml', source: "the worktree's own manifest" },
          ],
        },
      });
      expect(e.message).toContain(
        "tool-local.yml (the worktree's own manifest)"
      );
      expect(git(['branch', '--list', 'feat/req'], main)).toContain('feat/req');
      // the reverse: main's working manifest requires it, the committed one a new branch gets does not
      requireInMain('[tool-local.yml]');
      const r = await worktreeAdd(
        loadManifest(main),
        { branch: 'feat/x', install: false },
        deps()
      );
      expect(r).toMatchObject({
        manifest: 'worktree',
        missing: [],
        missing_required: [],
      });
    });

    it("the main checkout's override requires one: refused, named as the override's", async () => {
      fs.writeFileSync(
        path.join(main, '.mcproc', 'mcproc.local.yaml'),
        'worktree: { required: [secret.env] }\n'
      );
      const e = await refusal('feat/x');
      expect(e).toMatchObject({
        code: 'REQUIRED_MISSING',
        details: {
          missing: [
            { entry: 'secret.env', source: "the main checkout's override" },
          ],
        },
      });
      expect(e.message).toContain("secret.env (the main checkout's override)");
      expect(worktrees()).toEqual([`worktree ${real}`]);
    });

    it('allowMissing makes the worktree without it, and says which required ones it lacks', async () => {
      requireInMain('[tool-local.yml]');
      git([...c, 'commit', '-qam', 'require'], main);
      const r = await worktreeAdd(
        loadManifest(main),
        { branch: 'feat/x', install: true, allowMissing: true },
        deps()
      );
      expect(r).toMatchObject({
        missing: ['tool-local.yml'],
        missing_required: ['tool-local.yml'],
        copied: ['certs', 'snaps/a.spec.ts-snapshots'],
      });
      expect(fs.existsSync(r.path)).toBe(true);
      expect(ran).toEqual([{ cmd: 'bun install', cwd: r.path }]);
    });

    it('present: copied, nothing missing, and the copy stays out of git', async () => {
      requireInMain('[tool-local.yml]');
      git([...c, 'commit', '-qam', 'require'], main);
      fs.writeFileSync(path.join(main, 'tool-local.yml'), 'k: v\n');
      const r = await worktreeAdd(
        loadManifest(main),
        { branch: 'feat/x', install: false },
        deps()
      );
      expect(r).toMatchObject({ missing: [], missing_required: [] });
      expect(r.copied).toContain('tool-local.yml');
      expect(fs.readFileSync(path.join(r.path, 'tool-local.yml'), 'utf8')).toBe(
        'k: v\n'
      );
      expect(git(['status', '--porcelain'], r.path).trim()).toBe('');
    });

    it('a rollback step that fails is named, with the command that clears what is left', async () => {
      manifestOnlyInMain();
      requireInMain('[tool-local.yml]');
      const stuck: WorktreeDeps = {
        ...deps(),
        git: (args, cwd, env) =>
          args[0] === 'worktree' && args[1] === 'remove'
            ? Promise.resolve({
                code: 128,
                stdout: '',
                stderr: 'fatal: stuck\n',
              })
            : isolatedGit(args, cwd, env),
      };
      const wt = path.join(`${real}.worktrees`, 'feat', 'x');
      const e = await refusal('feat/x', {}, stuck);
      expect(e.code).toBe('REQUIRED_MISSING');
      expect(e.message).not.toContain('nothing was kept');
      expect(e.message).toContain('fatal: stuck');
      expect(e.message).toContain(
        `the worktree ${wt}, its new branch feat/x and slot 1`
      );
      expect(e.message).toContain(
        `git worktree remove --force ${wt} && git branch -D feat/x`
      );
      // the worktree stays as git made it (the check came before anything was written into it), and with it the branch
      // it has checked out and its slot, which the next add takes back once the folder is gone
      expect(fs.existsSync(wt)).toBe(true);
      expect(fs.existsSync(path.join(wt, '.mcproc', 'mcproc.local.yaml'))).toBe(
        false
      );
      expect(git(['branch', '--list', 'feat/x'], main)).toContain('feat/x');
      expect(
        readRegistry(registryPath(state, 'demo', real))!.slots['1']
      ).toMatchObject({ path: wt });
    });

    it('a branch the rollback cannot delete is named with its command; the worktree, its folder and the slot still go', async () => {
      manifestOnlyInMain();
      requireInMain('[tool-local.yml]');
      const held: WorktreeDeps = {
        ...deps(),
        git: (args, cwd, env) =>
          args[0] === 'branch' && args[1] === '-D'
            ? Promise.resolve({
                code: 1,
                stdout: '',
                stderr: 'error: branch held\n',
              })
            : isolatedGit(args, cwd, env),
      };
      const e = await refusal('feat/x', {}, held);
      expect(e.code).toBe('REQUIRED_MISSING');
      expect(e.message).toMatch(
        /; the worktree is removed, but the rollback kept its new branch feat\/x \(git branch: error: branch held\): clear it with git branch -D feat\/x$/
      );
      expect(worktrees()).toEqual([`worktree ${real}`]);
      expect(git(['branch', '--list', 'feat/x'], main)).toContain('feat/x');
      expect(fs.existsSync(path.join(`${real}.worktrees`, 'feat'))).toBe(false);
      expect(
        Object.keys(readRegistry(registryPath(state, 'demo', real))!.slots)
      ).toEqual(['0']);
    });

    // a read-only lease folder denies nobody when the suite runs as root: the release cannot fail
    it.skipIf(asRoot)(
      'a slot the rollback cannot release is named: the worktree and its branch still go, and the next add takes the slot back',
      async () => {
        manifestOnlyInMain();
        requireInMain('[tool-local.yml]');
        const wt = path.join(`${real}.worktrees`, 'feat', 'x');
        const leases = path.join(state, 'leases');
        // the host's lease lock cannot be taken once the branch is deleted: the release under it fails
        const locked: WorktreeDeps = {
          ...deps(),
          git: (args, cwd, env) => {
            if (args[0] === 'branch' && args[1] === '-D')
              fs.chmodSync(leases, 0o555);
            return isolatedGit(args, cwd, env);
          },
        };
        let e: { code: string; message: string };
        try {
          e = await refusal('feat/x', {}, locked);
        } finally {
          fs.chmodSync(leases, 0o755);
        }
        expect(e.code).toBe('REQUIRED_MISSING');
        expect(e.message).toContain(
          '; the worktree is removed, but the rollback kept slot 1 in the registry (EACCES'
        );
        expect(e.message).toMatch(
          /the next worktree add takes it back, its folder being gone\)$/
        );
        expect(worktrees()).toEqual([`worktree ${real}`]);
        expect(git(['branch', '--list', 'feat/x'], main).trim()).toBe('');
        expect(fs.existsSync(wt)).toBe(false);
        expect(
          readRegistry(registryPath(state, 'demo', real))!.slots['1']
        ).toMatchObject({ path: wt });
        fs.writeFileSync(path.join(main, 'tool-local.yml'), 'k: v\n');
        const r = await worktreeAdd(
          loadManifest(main),
          { branch: 'feat/z', install: false },
          deps()
        );
        expect(r.slot).toBe(1);
      }
    );

    // a read-only folder denies nobody when the suite runs as root: the prune cannot fail
    it.skipIf(asRoot)(
      'a folder the rollback cannot prune is named with its command, and the slot is released all the same',
      async () => {
        manifestOnlyInMain();
        requireInMain('[tool-local.yml]');
        const top = `${real}.worktrees`;
        const feat = path.join(top, 'feat');
        // `feat/` of feat/x cannot be removed from a folder that is read-only
        const { d } = atRemove(() => fs.chmodSync(top, 0o555));
        let e: { code: string; message: string };
        try {
          e = await refusal('feat/x', {}, d);
        } finally {
          fs.chmodSync(top, 0o755);
        }
        expect(e.code).toBe('REQUIRED_MISSING');
        expect(e.message).not.toContain('nothing was kept');
        expect(e.message).toContain(
          `; the worktree is removed, but the rollback kept the folder ${feat} (EACCES`
        );
        const tail = `: clear it with rmdir ${feat}`;
        expect(e.message.slice(-tail.length)).toBe(tail);
        expect(fs.existsSync(feat)).toBe(true);
        expect(fs.existsSync(path.join(feat, 'x'))).toBe(false);
        expect(worktrees()).toEqual([`worktree ${real}`]);
        expect(git(['branch', '--list', 'feat/x'], main).trim()).toBe('');
        expect(
          Object.keys(readRegistry(registryPath(state, 'demo', real))!.slots)
        ).toEqual(['0']);
      }
    );

    it("a templated required entry is the new worktree's: its slug and slot decide, and a refusal wrote nothing into it", async () => {
      // the branch has no .mcproc/.gitignore of its own: an accepted add writes one, a refused one must not have
      git(['rm', '-q', '.mcproc/.gitignore'], main);
      requireInMain('["{{ project }}.env", "slot-{{ slot }}.env"]');
      git([...c, 'commit', '-qam', 'templated require'], main);
      // what the main checkout's own slug and slot render to is there: it is not what the new worktree needs
      fs.writeFileSync(path.join(main, 'demo.env'), 'main');
      fs.writeFileSync(path.join(main, 'slot-0.env'), 'main');
      const excluded = exclude();
      const { d, seen } = atRemove();
      const e = await refusal('feat/x', {}, d);
      expect(e).toMatchObject({
        code: 'REQUIRED_MISSING',
        details: {
          missing: [
            { entry: 'demo-w1.env', source: "the worktree's own manifest" },
            { entry: 'slot-1.env', source: "the worktree's own manifest" },
          ],
        },
      });
      expect(e.message).toContain(
        'entries missing in ' +
          `${real}: demo-w1.env (the worktree's own manifest), slot-1.env (the worktree's own manifest); nothing was kept`
      );
      // no override, no .mcproc/.gitignore, no copy, no link: only what git checked out
      expect(seen).toEqual([
        {
          top: ['.git', '.gitignore', '.mcproc', 'bun.lock'],
          mcproc: ['mcproc.yaml'],
        },
      ]);
      expect(exclude()).toBe(excluded);
      // present under the new worktree's names: copied, and only then the override and the .gitignore are written
      fs.writeFileSync(path.join(main, 'demo-w1.env'), 'w1');
      fs.writeFileSync(path.join(main, 'slot-1.env'), 'one');
      const r = await worktreeAdd(
        loadManifest(main),
        { branch: 'feat/x', install: false },
        deps()
      );
      expect(r).toMatchObject({
        slot: 1,
        project: 'demo-w1',
        manifest: 'worktree',
        missing: [],
        missing_required: [],
      });
      expect(r.copied).toEqual(
        expect.arrayContaining(['demo-w1.env', 'slot-1.env'])
      );
      expect(r.copied).not.toContain('demo.env');
      expect(fs.readFileSync(path.join(r.path, 'demo-w1.env'), 'utf8')).toBe(
        'w1'
      );
      expect(fs.readFileSync(path.join(r.path, 'slot-1.env'), 'utf8')).toBe(
        'one'
      );
      expect(
        fs.readFileSync(
          path.join(r.path, '.mcproc', 'mcproc.local.yaml'),
          'utf8'
        )
      ).toContain('slot: 1');
      expect(
        fs.readFileSync(path.join(r.path, '.mcproc', '.gitignore'), 'utf8')
      ).toBe('*\n');
    });

    it('a post-checkout hook steps aside for mcproc: its git worktree add carries MCPROC_WORKTREE_ADD=1', async () => {
      const marker = path.join(base, 'hook-ran');
      const hook = path.join(real, '.git', 'hooks', 'post-checkout');
      fs.mkdirSync(path.dirname(hook), { recursive: true });
      fs.writeFileSync(
        hook,
        `#!/bin/sh\n[ -n "$MCPROC_WORKTREE_ADD" ] || echo "$PWD" >> '${marker}'\n`,
        { mode: 0o755 }
      );
      const envs: [string, Record<string, string> | undefined][] = [];
      const recording: WorktreeDeps = {
        ...deps(),
        git: (args, cwd, env) => {
          envs.push([args.slice(0, 2).join(' '), env]);
          return isolatedGit(args, cwd, env);
        },
      };
      await worktreeAdd(
        loadManifest(main),
        { branch: 'feat/x', install: false },
        recording
      );
      expect(fs.existsSync(marker)).toBe(false);
      expect(envs.filter(([, env]) => env)).toEqual([
        ['worktree add', { MCPROC_WORKTREE_ADD: '1' }],
      ]);
      // the hook does run for a worktree git makes without mcproc: the step aside is what kept the marker away
      git(
        ['worktree', 'add', '-q', '-b', 'plain', path.join(base, 'plain')],
        main
      );
      expect(fs.existsSync(marker)).toBe(true);
    });
  });

  describe('sync', () => {
    const c = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
    let wt: string;
    let wtReal: string;
    let logged: string[];
    const sync = (
      dir: string,
      o: { allowMissing?: boolean; fromHook?: boolean } = {},
      beforePublish?: (to: string) => void
    ) =>
      worktreeSync(
        { dir, allowMissing: false, fromHook: false, ...o },
        { git: isolatedGit, log: (l) => logged.push(l), beforePublish }
      );
    /** the entries of the worktree's top level a copy staged under a temporary name */
    const staged = () =>
      fs.readdirSync(wt).filter((n) => n.includes('mcproc-'));
    const refusal = (dir: string, o: { fromHook?: boolean } = {}) =>
      sync(dir, o).then(
        () => {
          throw new Error('worktreeSync synced');
        },
        (e) => e
      );
    const exclude = () =>
      fs.readFileSync(path.join(real, '.git', 'info', 'exclude'), 'utf8');
    const ownManifest = (dir: string, text: string) => {
      fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.mcproc', 'mcproc.yaml'), text);
    };
    beforeEach(() => {
      logged = [];
      // .mcproc/ leaves git and stays in main: a worktree git makes has no manifest, the main checkout's decides
      fs.writeFileSync(
        path.join(main, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: demo',
          'worktree:',
          '  copy: [cache]',
          '  required: [tool-local.yml]',
          '  link: [notes]',
          'apps:',
          '  db: { description: db, run: node db.js }',
          '',
        ].join('\n')
      );
      fs.appendFileSync(path.join(main, '.gitignore'), '.mcproc/\ncache/\n');
      git(['rm', '-rq', '--cached', '.mcproc'], main);
      git([...c, 'commit', '-qam', '.mcproc/ untracked'], main);
      fs.mkdirSync(path.join(main, 'cache'));
      fs.writeFileSync(path.join(main, 'cache', 'c.bin'), 'cache');
      fs.writeFileSync(path.join(main, 'tool-local.yml'), 'k: v\n');
      wt = path.join(base, 'side');
      git(['worktree', 'add', '-q', '-b', 'side', wt], main);
      wtReal = fs.realpathSync(wt);
    });

    it("a sibling worktree git made gets the main checkout's copies and links, and the links are ignored in git", async () => {
      expect(fs.existsSync(path.join(wt, '.mcproc'))).toBe(false);
      const r = await sync(wt);
      expect(r).toEqual({
        path: wtReal,
        repo: real,
        manifest: 'main',
        copied: ['cache', 'tool-local.yml'],
        kept: [],
        linked: ['notes'],
        from_override: [],
        excluded: ['/notes'],
        missing: [],
        missing_required: [],
      });
      expect(fs.readFileSync(path.join(wt, 'cache', 'c.bin'), 'utf8')).toBe(
        'cache'
      );
      expect(fs.readFileSync(path.join(wt, 'tool-local.yml'), 'utf8')).toBe(
        'k: v\n'
      );
      expect(fs.readlinkSync(path.join(wt, 'notes'))).toBe(
        path.join(real, 'notes')
      );
      expect(exclude().split('\n')).toContain('/notes');
      expect(git(['status', '--porcelain'], wt).trim()).toBe('');
      expect(logged).toEqual([]);
    });

    it('a worktree nested in the main checkout is synced, not the main checkout its manifest search finds', async () => {
      const nested = path.join(main, '.claude', 'worktrees', 'x');
      git(['worktree', 'add', '-q', '-b', 'x', nested], main);
      // from a folder inside it: the git top level is the target
      fs.mkdirSync(path.join(nested, 'deep'));
      const r = await sync(path.join(nested, 'deep'));
      const at = fs.realpathSync(nested);
      expect(r).toMatchObject({
        path: at,
        repo: real,
        manifest: 'main',
        copied: ['cache', 'tool-local.yml'],
        linked: ['notes'],
      });
      expect(fs.readFileSync(path.join(at, 'cache', 'c.bin'), 'utf8')).toBe(
        'cache'
      );
      expect(fs.lstatSync(path.join(at, 'notes')).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(at, 'deep', 'cache'))).toBe(false);
    });

    it('the main checkout is refused: sync copies from it', async () => {
      const e = await refusal(main);
      expect(e.code).toBe('BAD_ARGUMENT');
      expect(e.message).toContain(`${real} is the main checkout`);
    });

    it('a file already in the worktree is kept as it is; a second sync keeps everything', async () => {
      fs.writeFileSync(path.join(wt, 'tool-local.yml'), 'mine\n');
      const r = await sync(wt);
      expect(r).toMatchObject({
        copied: ['cache'],
        kept: ['tool-local.yml'],
        linked: ['notes'],
      });
      expect(fs.readFileSync(path.join(wt, 'tool-local.yml'), 'utf8')).toBe(
        'mine\n'
      );
      fs.writeFileSync(path.join(main, 'cache', 'c.bin'), 'newer');
      const again = await sync(wt);
      expect(again).toMatchObject({
        copied: [],
        kept: ['cache', 'tool-local.yml', 'notes'],
        linked: [],
        excluded: ['/notes'],
      });
      expect(fs.readFileSync(path.join(wt, 'cache', 'c.bin'), 'utf8')).toBe(
        'cache'
      );
      expect(
        exclude()
          .split('\n')
          .filter((l) => l === '/notes')
      ).toHaveLength(1);
    });

    // an unreadable file denies nobody when the suite runs as root: the copy would not fail
    it.skipIf(asRoot)(
      'a copy that fails halfway leaves nothing in its place, and the next sync copies it whole',
      async () => {
        const locked = path.join(main, 'cache', 'locked.bin');
        fs.writeFileSync(locked, 'locked');
        fs.chmodSync(locked, 0o000);
        let e: { code?: string; message?: string };
        try {
          e = await refusal(wt);
        } finally {
          fs.chmodSync(locked, 0o644);
        }
        expect(e.code).toBe('BAD_ARGUMENT');
        expect(e.message).toContain(
          `worktree sync into ${wtReal}: copying ${path.join(real, 'cache')} failed`
        );
        // neither the half-copied folder nor the temporary it was copied into
        expect(fs.readdirSync(wt).filter((n) => n.includes('cache'))).toEqual(
          []
        );
        const r = await sync(wt);
        expect(r).toMatchObject({
          copied: ['cache', 'tool-local.yml'],
          kept: [],
          linked: ['notes'],
          excluded: ['/notes'],
        });
        expect(fs.readFileSync(path.join(wt, 'cache', 'c.bin'), 'utf8')).toBe(
          'cache'
        );
        expect(
          fs.readFileSync(path.join(wt, 'cache', 'locked.bin'), 'utf8')
        ).toBe('locked');
        expect(fs.readdirSync(wt).filter((n) => n.includes('mcproc-'))).toEqual(
          []
        );
        expect(exclude()).not.toContain('mcproc-');
        expect(git(['status', '--porcelain'], wt).trim()).toBe('');
      }
    );

    it('with nothing in the way a staged copy is published whole, and its temporary goes', async () => {
      const seen: { to: string; there: boolean; staged: string[] }[] = [];
      const r = await sync(wt, {}, (to) =>
        seen.push({ to, there: fs.existsSync(to), staged: staged() })
      );
      expect(seen).toEqual([
        {
          to: path.join(wtReal, 'cache'),
          there: false,
          staged: [expect.stringMatching(/^\.cache\.mcproc-/)],
        },
        {
          to: path.join(wtReal, 'tool-local.yml'),
          there: false,
          staged: [expect.stringMatching(/^\.tool-local\.yml\.mcproc-/)],
        },
      ]);
      expect(r).toMatchObject({
        copied: ['cache', 'tool-local.yml'],
        kept: [],
        linked: ['notes'],
      });
      expect(fs.readFileSync(path.join(wt, 'cache', 'c.bin'), 'utf8')).toBe(
        'cache'
      );
      const file = fs.lstatSync(path.join(wt, 'tool-local.yml'));
      // a plain file of its own: the temporary it was linked from is gone
      expect([file.isFile(), file.nlink]).toEqual([true, 1]);
      expect(fs.readFileSync(path.join(wt, 'tool-local.yml'), 'utf8')).toBe(
        'k: v\n'
      );
      expect(staged()).toEqual([]);
    });

    it('a target another writer puts in place while its copy is staged is kept as it is', async () => {
      const r = await sync(wt, {}, (to) => {
        if (path.basename(to) === 'cache') {
          fs.mkdirSync(to);
          fs.writeFileSync(path.join(to, 'theirs.bin'), 'theirs');
        } else fs.writeFileSync(to, 'theirs\n');
      });
      expect(r).toMatchObject({
        copied: [],
        kept: ['cache', 'tool-local.yml'],
        linked: ['notes'],
      });
      expect(fs.readdirSync(path.join(wt, 'cache'))).toEqual(['theirs.bin']);
      expect(
        fs.readFileSync(path.join(wt, 'cache', 'theirs.bin'), 'utf8')
      ).toBe('theirs');
      expect(fs.readFileSync(path.join(wt, 'tool-local.yml'), 'utf8')).toBe(
        'theirs\n'
      );
      expect(staged()).toEqual([]);
    });

    it('a target of the other kind put in place then is kept too: a file for a folder, a folder for a file', async () => {
      const r = await sync(wt, {}, (to) => {
        if (path.basename(to) === 'cache') fs.writeFileSync(to, 'theirs');
        else {
          fs.mkdirSync(to);
          fs.writeFileSync(path.join(to, 'x'), 'x');
        }
      });
      expect(r).toMatchObject({
        copied: [],
        kept: ['cache', 'tool-local.yml'],
      });
      expect(fs.readFileSync(path.join(wt, 'cache'), 'utf8')).toBe('theirs');
      expect(fs.readdirSync(path.join(wt, 'tool-local.yml'))).toEqual(['x']);
      expect(staged()).toEqual([]);
    });

    it('a symlink entry is published as a symlink, and never over a target put in place then', async () => {
      fs.symlinkSync('tool-local.yml', path.join(main, 'shared.yml'));
      fs.writeFileSync(
        path.join(main, '.mcproc', 'mcproc.local.yaml'),
        'worktree: { copy: [shared.yml] }\n'
      );
      const r = await sync(wt, {}, (to) => {
        if (path.basename(to) === 'shared.yml')
          fs.writeFileSync(to, 'theirs\n');
      });
      expect(r).toMatchObject({
        copied: ['cache', 'tool-local.yml'],
        kept: ['shared.yml'],
      });
      expect(fs.readFileSync(path.join(wt, 'shared.yml'), 'utf8')).toBe(
        'theirs\n'
      );
      expect(staged()).toEqual([]);
      fs.rmSync(path.join(wt, 'shared.yml'));
      const again = await sync(wt);
      expect(again).toMatchObject({ copied: ['shared.yml'] });
      // the link itself, not a second name of the file it points at
      expect(fs.lstatSync(path.join(wt, 'shared.yml')).isSymbolicLink()).toBe(
        true
      );
      expect(fs.readlinkSync(path.join(wt, 'shared.yml'))).toBe(
        path.join(real, 'tool-local.yml')
      );
      expect(staged()).toEqual([]);
    });

    it('no manifest in either checkout: nothing to copy, said once', async () => {
      fs.rmSync(path.join(main, '.mcproc', 'mcproc.yaml'));
      const r = await sync(wt);
      expect(r).toEqual({
        path: wtReal,
        repo: real,
        manifest: null,
        copied: [],
        kept: [],
        linked: [],
        from_override: [],
        excluded: [],
        missing: [],
        missing_required: [],
      });
      expect(logged).toEqual([
        `no manifest in ${wtReal} or ${real}: nothing to copy`,
      ]);
      expect(fs.existsSync(path.join(wt, 'cache'))).toBe(false);
    });

    it("the worktree's own manifest decides when it loads", async () => {
      ownManifest(
        wt,
        'version: 1\nproject: demo\nworktree: { copy: [cache] }\napps:\n  db: { description: db, run: node db.js }\n'
      );
      // the main's required entry is not the worktree's: its miss refuses nothing
      fs.rmSync(path.join(main, 'tool-local.yml'));
      const r = await sync(wt);
      expect(r).toMatchObject({
        manifest: 'worktree',
        copied: ['cache'],
        linked: [],
        missing: [],
        missing_required: [],
      });
    });

    it("sync falls back to the main manifest when the worktree's does not load", async () => {
      ownManifest(wt, 'version: 2\n');
      const r = await sync(wt);
      expect(r).toMatchObject({
        manifest: 'main',
        copied: ['cache', 'tool-local.yml'],
      });
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(`the manifest of ${wtReal} does not load (`);
      expect(logged[0]).toContain('MANIFEST_INVALID');
    });

    it("the main checkout's override adds its entries, named as the override's", async () => {
      fs.writeFileSync(path.join(main, 'extra.env'), 'X=1');
      fs.writeFileSync(
        path.join(main, '.mcproc', 'mcproc.local.yaml'),
        'worktree: { copy: [extra.env] }\n'
      );
      const r = await sync(wt);
      expect(r).toMatchObject({
        copied: ['cache', 'tool-local.yml', 'extra.env'],
        from_override: ['extra.env'],
      });
    });

    it('a required miss is refused before anything is copied, linked or excluded', async () => {
      fs.rmSync(path.join(main, 'tool-local.yml'));
      const excluded = exclude();
      const e = await refusal(wt);
      expect(e).toMatchObject({
        code: 'REQUIRED_MISSING',
        details: {
          missing: [
            { entry: 'tool-local.yml', source: "the main checkout's manifest" },
          ],
        },
      });
      expect(e.message).toBe(
        `required entry missing in ${real}: tool-local.yml (the main checkout's manifest); nothing was copied into ${wtReal}`
      );
      expect(e.hint).toBe(
        `Put them into ${real} (machine-local files, not in git) and run it again, or pass --allow-missing (MCP: allow_missing) to sync without them.`
      );
      expect(fs.existsSync(path.join(wt, 'cache'))).toBe(false);
      expect(fs.existsSync(path.join(wt, 'notes'))).toBe(false);
      expect(exclude()).toBe(excluded);
      // from the hook: git keeps the worktree whatever the hook answers, so the refusal says what finishes it
      const h = await refusal(wt, { fromHook: true });
      expect(h.code).toBe('REQUIRED_MISSING');
      expect(h.message).toContain(
        `; the worktree ${wtReal} exists without them (git keeps a worktree whose post-checkout hook fails); put them into ${real}, then run mcproc worktree sync in ${wtReal}`
      );
      expect(fs.existsSync(path.join(wt, 'cache'))).toBe(false);
    });

    it('allowMissing syncs the rest and says which required ones it lacks', async () => {
      fs.rmSync(path.join(main, 'tool-local.yml'));
      const r = await sync(wt, { allowMissing: true });
      expect(r).toMatchObject({
        copied: ['cache'],
        linked: ['notes'],
        missing: ['tool-local.yml'],
        missing_required: ['tool-local.yml'],
      });
      expect(logged).toEqual([
        `copy: tool-local.yml is not in ${real}, skipped (required, allowed)`,
      ]);
    });

    /** every path in the worktree below its top level */
    const files = () =>
      fs.readdirSync(wt, { recursive: true, encoding: 'utf8' }).sort();
    const readonlyLocal = 'hosts:\n  local: { readonly: true }\n';

    it('a readonly local host refuses the sync before anything is copied, linked or excluded', async () => {
      const manifest = path.join(real, '.mcproc', 'mcproc.yaml');
      fs.appendFileSync(manifest, readonlyLocal);
      const inWt = files();
      const excluded = exclude();
      const e = await refusal(wt);
      expect(e).toMatchObject({
        code: 'READONLY_HOST',
        message: `${manifest} declares the local host readonly: worktree sync is refused; nothing was copied into ${wtReal}`,
        hint: `Remove hosts.local.readonly from ${manifest}, then run it again; or copy the files by hand.`,
      });
      // from the hook: git keeps the worktree whatever the hook answers, so the refusal says so and what finishes it
      const h = await refusal(wt, { fromHook: true });
      expect(h.code).toBe('READONLY_HOST');
      expect(h.message).toBe(
        `${manifest} declares the local host readonly: worktree sync is refused; the worktree ${wtReal} exists without its files (git keeps a worktree whose post-checkout hook fails)`
      );
      expect(h.hint).toContain(
        `Remove hosts.local.readonly from ${manifest}, then run mcproc worktree sync in ${wtReal}`
      );
      // a required miss as well: the host refuses first, so putting the file in place would not be enough
      fs.rmSync(path.join(main, 'tool-local.yml'));
      expect((await refusal(wt)).code).toBe('READONLY_HOST');
      expect(files()).toEqual(inWt);
      expect(exclude()).toBe(excluded);
      expect(logged).toEqual([]);
    });

    it("the deciding manifest's local host is the one asked: the worktree's own when it loads", async () => {
      const mainManifest = path.join(real, '.mcproc', 'mcproc.yaml');
      const own =
        'version: 1\nproject: demo\nworktree: { copy: [cache], link: [notes] }\napps:\n  db: { description: db, run: node db.js }\n';
      // the worktree's own manifest marks it readonly, the main checkout's does not
      ownManifest(wt, own + readonlyLocal);
      const inWt = files();
      const excluded = exclude();
      const e = await refusal(wt);
      expect(e.code).toBe('READONLY_HOST');
      expect(e.message).toContain(
        `${path.join(wtReal, '.mcproc', 'mcproc.yaml')} declares the local host readonly`
      );
      expect(files()).toEqual(inWt);
      expect(exclude()).toBe(excluded);
      // the main checkout's marks it readonly, the worktree's own decides and does not
      ownManifest(wt, own);
      fs.appendFileSync(mainManifest, readonlyLocal);
      expect(await sync(wt)).toMatchObject({
        manifest: 'worktree',
        copied: ['cache'],
        linked: ['notes'],
      });
      // without a manifest of its own the main checkout's decides: readonly again
      fs.rmSync(path.join(wt, '.mcproc'), { recursive: true });
      expect((await refusal(wt)).code).toBe('READONLY_HOST');
    });
  });

  it('isFreshCheckout: only a previous ref of all zeros', () => {
    expect(isFreshCheckout('0'.repeat(40))).toBe(true);
    expect(isFreshCheckout('0'.repeat(64))).toBe(true);
    expect(isFreshCheckout('')).toBe(false);
    expect(isFreshCheckout('a'.repeat(40))).toBe(false);
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
      // `snaps/a.spec.ts-snapshots` is what the manifest's glob already copies: not the override's, not copied twice
      'worktree:\n  copy: [local.env, "extra/**/*.txt", snaps/a.spec.ts-snapshots]\n  link: [./private, "odd[1]"]\n'
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

  it('add: a branch manifest a newer mcproc wrote that does not load says so in the note', async () => {
    git(['checkout', '-qb', 'future'], main);
    fs.writeFileSync(
      path.join(main, '.mcproc', 'mcproc.yaml'),
      'version: 1\nmcproc: 9.0.0\nfuture: {}\napps:\n  db: { description: db, run: node db.js }\n'
    );
    git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'future'],
      main
    );
    git(['checkout', '-q', 'main'], main);
    const logged: string[] = [];
    await worktreeAdd(
      loadManifest(main),
      { branch: 'future', install: false },
      { ...deps(), log: (l) => logged.push(l) }
    );
    const note = logged.find((l) => l.includes('does not load'));
    expect(note).toContain("Unrecognized key(s) in object: 'future'");
    expect(note).toContain('written by mcproc 9.0.0');
    expect(note).toContain('Upgrade mcproc');
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
    recordProject(loadManifest(a.path), state);
    expect(fs.existsSync(projectFile(state, 'demo-w1', a.path))).toBe(true);
    const r = await worktreeRemove(m, '1', { force: true }, deps());
    expect(r).toEqual({ path: a.path, slot: 1, branch: 'a', stopped: ['db'] });
    expect(stopped).toEqual([a.path]);
    expect(fs.existsSync(a.path)).toBe(false);
    expect(fs.existsSync(projectFile(state, 'demo-w1', a.path))).toBe(false);
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
      git: (args, cwd, env) => {
        calls.push(args);
        return isolatedGit(args, cwd, env);
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

  // an unreadable file denies nobody when the suite runs as root: the copy would not fail
  it.skipIf(asRoot)(
    'a copy that fails halfway in add leaves nothing in its place either',
    async () => {
      const locked = path.join(main, 'certs', 'locked.pem');
      fs.writeFileSync(locked, 'locked');
      fs.chmodSync(locked, 0o000);
      const m = loadManifest(main);
      const wt = path.join(`${real}.worktrees`, 'half');
      try {
        await expect(
          worktreeAdd(m, { branch: 'half', install: false }, deps())
        ).rejects.toMatchObject({
          code: 'BAD_ARGUMENT',
          message: expect.stringContaining(
            `but copying ${path.join(real, 'certs')} failed`
          ),
        });
      } finally {
        fs.chmodSync(locked, 0o644);
      }
      // neither the half-copied folder nor the temporary it was copied into
      expect(fs.readdirSync(wt).filter((n) => n.includes('certs'))).toEqual([]);
    }
  );

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
      // one a newer mcproc wrote: the note carries the upgrade hint
      fs.writeFileSync(
        path.join(dir, '.mcproc', 'mcproc.yaml'),
        'version: 1\nmcproc: 9.0.0\nfuture: {}\napps:\n  db: { description: db, run: x }\n'
      );
      const newer: string[] = [];
      await stopCheckout(dir, {
        force: true,
        log: (l) => newer.push(l),
        connector,
      });
      expect(newer[0]).toContain('written by mcproc 9.0.0');
    });
  });
});

describe('planCopies: copy and required entries', () => {
  let main: string;
  const touch = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    fs.writeFileSync(path.join(main, rel), rel);
  };
  const plan = (lists: { copy?: string[]; required?: string[] }) =>
    planCopies(main, '/t', {
      copy: lists.copy ?? [],
      required: lists.required ?? [],
      link: [],
    });
  const copied = (p: ReturnType<typeof plan>) =>
    p.copies.map((c) => path.relative(main, c.from));
  beforeEach(() => {
    main = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-plan-'));
  });
  afterEach(() => fs.rmSync(main, { recursive: true, force: true }));

  it('a required directory is copied and counts as present', () => {
    touch('certs/a.pem');
    const p = plan({ required: ['certs'] });
    expect(p.copies).toEqual([
      { from: path.join(main, 'certs'), to: '/t/certs' },
    ]);
    expect(p.missing).toEqual([]);
    expect(p.missingRequired).toEqual([]);
  });
  it('an absent required file is missing and missing as required', () => {
    const p = plan({ required: ['tool-local.yml'] });
    expect(p.copies).toEqual([]);
    expect(p.missing).toEqual(['tool-local.yml']);
    expect(p.missingRequired).toEqual(['tool-local.yml']);
  });
  it('a required mask that matches nothing is missing as required', () => {
    touch('other.yml');
    expect(plan({ required: ['*-local.{yml,yaml}'] }).missingRequired).toEqual([
      '*-local.{yml,yaml}',
    ]);
  });
  it('a required mask copies every file it matches', () => {
    touch('a-local.yml');
    touch('b-local.yaml');
    const p = plan({ required: ['*-local.{yml,yaml}'] });
    expect(copied(p)).toEqual(['a-local.yml', 'b-local.yaml']);
    expect(p.missingRequired).toEqual([]);
  });
  it('the accepted limit: a mask is present when it matches one file, however many were meant', () => {
    touch('a-local.yml');
    const p = plan({ required: ['*-local.{yml,yaml}'] });
    expect(copied(p)).toEqual(['a-local.yml']);
    expect(p.missingRequired).toEqual([]);
  });
  it('a brace-only entry is a mask', () => {
    expect(isGlob('{x,y}.env')).toBe(true);
    expect(isGlob('certs')).toBe(false);
    for (const g of ['*.pem', 'a?.yml', 'odd[1]']) expect(isGlob(g)).toBe(true);
    touch('x.env');
    const p = plan({ required: ['{x,y}.env'] });
    expect(copied(p)).toEqual(['x.env']);
    expect(p.missingRequired).toEqual([]);
  });
  it('an entry both copied and required is walked once: one miss, missing as required', () => {
    const p = plan({ copy: ['tool-local.yml'], required: ['tool-local.yml'] });
    expect(p.missing).toEqual(['tool-local.yml']);
    expect(p.missingRequired).toEqual(['tool-local.yml']);
    touch('tool-local.yml');
    expect(
      plan({ copy: ['tool-local.yml'], required: ['tool-local.yml'] }).copies
    ).toHaveLength(1);
  });
  it('an absent copy entry is missing, not missing as required', () => {
    const p = plan({ copy: ['cache'] });
    expect(p.missing).toEqual(['cache']);
    expect(p.missingRequired).toEqual([]);
  });
});

describe('the main checkout in other repository layouts', () => {
  let base: string;
  let state: string;
  const deps = (): WorktreeDeps => ({
    git: isolatedGit,
    stateDir: state,
    run: async () => 0,
    log: () => undefined,
    jlist: async () => [],
    stopAll: async () => [],
  });
  const commit = (cwd: string, msg: string) =>
    git(
      [
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        msg,
      ],
      cwd
    );
  /** a repository at `dir` (made by `init`) whose tracked manifest requires local.yml, a file only the main checkout has */
  const stand = (dir: string, init: string[] = []) => {
    fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
    git(['init', '-q', '-b', 'main', ...init], dir);
    fs.writeFileSync(
      path.join(dir, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: lay',
        'worktree: { required: [local.yml], install: false }',
        'apps:',
        '  db: { description: db, run: node db.js }',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, '.mcproc', '.gitignore'),
      '*\n!.gitignore\n!mcproc.yaml\n'
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), 'local.yml\n');
    git(['add', '-A'], dir);
    commit(dir, 'init');
  };
  const sync = (dir: string) =>
    worktreeSync({ dir, allowMissing: false, fromHook: false }, deps());
  beforeEach(() => {
    base = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wt-layout-'))
    );
    state = path.join(base, 'state');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('a plain repository: the parent of its .git, from the checkout and from a worktree', async () => {
    const repo = path.join(base, 'plain');
    stand(repo);
    const side = path.join(base, 'side');
    git(['worktree', 'add', '-q', '-b', 'side', side], repo);
    expect(await mainCheckout(repo, isolatedGit)).toBe(repo);
    expect(await mainCheckout(side, isolatedGit)).toBe(repo);
  });

  it("a submodule: its checkout, not its git dir's parent, for add, ls, sync, remove and the hook", async () => {
    const src = path.join(base, 'src');
    stand(src);
    const sup = path.join(base, 'super');
    fs.mkdirSync(sup);
    git(['init', '-q', '-b', 'main'], sup);
    commit(sup, 'init');
    git(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        src,
        'sub',
      ],
      sup
    );
    commit(sup, 'sub');
    const sub = path.join(sup, 'sub');
    fs.writeFileSync(path.join(sub, 'local.yml'), 'local');
    const side = path.join(base, 'side');
    git(['worktree', 'add', '-q', '-b', 'side', side], sub);
    expect(await mainCheckout(sub, isolatedGit)).toBe(sub);
    expect(await mainCheckout(side, isolatedGit)).toBe(sub);
    const m = loadManifest(sub);
    const added = await worktreeAdd(
      m,
      { branch: 'feat', install: false },
      deps()
    );
    expect(added).toMatchObject({
      path: path.join(`${sub}.worktrees`, 'feat'),
      repo: sub,
      slot: 1,
      copied: ['local.yml'],
    });
    expect((await worktreeLs(m, deps())).map((r) => [r.slot, r.path])).toEqual([
      [0, sub],
      [1, added.path],
    ]);
    expect(await sync(side)).toMatchObject({
      repo: sub,
      copied: ['local.yml'],
      missing_required: [],
    });
    expect(await hookPath(sub, isolatedGit)).toBe(
      path.join(sup, '.git', 'modules', 'sub', 'hooks', 'post-checkout')
    );
    await worktreeRemove(m, '1', { force: true }, deps());
    expect(fs.existsSync(added.path)).toBe(false);
  });

  it('a separate git dir: found from its checkout; from a worktree only once core.worktree names it', async () => {
    const sep = path.join(base, 'sep');
    const dotGit = path.join(base, 'sep.git');
    stand(sep, ['--separate-git-dir', dotGit]);
    fs.writeFileSync(path.join(sep, 'local.yml'), 'local');
    const side = path.join(base, 'side');
    git(['worktree', 'add', '-q', '-b', 'side', side], sep);
    expect(await mainCheckout(sep, isolatedGit)).toBe(sep);
    const added = await worktreeAdd(
      loadManifest(sep),
      { branch: 'feat', install: false },
      deps()
    );
    expect(added).toMatchObject({
      path: path.join(`${sep}.worktrees`, 'feat'),
      copied: ['local.yml'],
    });
    const unknown = {
      code: 'BAD_ARGUMENT',
      message: `the main checkout of ${side} is not known: its repository's git directory ${dotGit} is no checkout's .git and names no core.worktree (a repository made with --separate-git-dir)`,
      hint: `Run it from the main checkout, or name that checkout once: git config --file ${path.join(dotGit, 'config')} core.worktree <its path>`,
    };
    await expect(mainCheckout(side, isolatedGit)).rejects.toMatchObject(
      unknown
    );
    await expect(sync(side)).rejects.toMatchObject(unknown);
    git(
      ['config', '--file', path.join(dotGit, 'config'), 'core.worktree', sep],
      sep
    );
    // git applies it to the main checkout alone: the worktree stays its own top
    expect(git(['rev-parse', '--show-toplevel'], side).trim()).toBe(side);
    expect(await mainCheckout(side, isolatedGit)).toBe(sep);
    expect(await sync(side)).toMatchObject({
      repo: sep,
      copied: ['local.yml'],
    });
  });

  it("core.worktree in the main checkout's config.worktree counts too", async () => {
    const sep = path.join(base, 'sep');
    const dotGit = path.join(base, 'sep.git');
    stand(sep, ['--separate-git-dir', dotGit]);
    const side = path.join(base, 'side');
    git(['worktree', 'add', '-q', '-b', 'side', side], sep);
    git(['config', 'extensions.worktreeConfig', 'true'], sep);
    git(['config', '--worktree', 'core.worktree', sep], sep);
    expect(
      fs.readFileSync(path.join(dotGit, 'config.worktree'), 'utf8')
    ).toContain('worktree');
    expect(await mainCheckout(side, isolatedGit)).toBe(sep);
  });

  it('a bare repository has no main checkout: its worktrees are refused with why, before anything is made', async () => {
    const src = path.join(base, 'src');
    stand(src);
    const bare = path.join(base, 'b.git');
    git(['clone', '-q', '--bare', src, bare], base);
    const wt = path.join(base, 'wt');
    git(['worktree', 'add', '-q', wt, 'main'], bare);
    const refused = {
      code: 'BAD_ARGUMENT',
      message: `${wt} is a worktree of the bare repository ${bare}, which has no main checkout to take a worktree's files, override and slot from`,
    };
    await expect(mainCheckout(wt, isolatedGit)).rejects.toMatchObject(refused);
    const m = loadManifest(wt);
    await expect(worktreeLs(m, deps())).rejects.toMatchObject(refused);
    await expect(
      worktreeAdd(m, { branch: 'feat', install: false }, deps())
    ).rejects.toMatchObject(refused);
    expect(fs.existsSync(`${wt}.worktrees`)).toBe(false);
    expect(fs.existsSync(state)).toBe(false);
    await expect(hookPath(wt, isolatedGit)).rejects.toMatchObject(refused);
  });
});

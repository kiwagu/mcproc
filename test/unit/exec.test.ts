import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  onTestFinished,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import {
  runExec,
  defaultExecDeps,
  type ExecDeps,
} from '../../src/core/exec.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const varsProj = path.join(here, '..', 'fixtures', 'projects', 'vars');
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

describe('runExec', () => {
  let dir: string;
  let store: LeaseStore;
  let now: number;
  let runs: { command: string[]; env: Record<string, string>; cwd: string }[];
  let ensured = 0;
  const deps = (
    memory: { total_mib: number; available_mib: number } | null,
    code = 0
  ): ExecDeps => ({
    store,
    memory: async () => memory,
    ensureWatcher: async () => {
      ensured++;
    },
    run: async (command, o) => {
      runs.push({ command, env: o.env, cwd: o.cwd });
      return { code, output: 'hello\n' };
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    pid: 9,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-exec-'));
    store = new LeaseStore(dir, { now: () => now });
    now = 1_700_000_000_000;
    runs = [];
    ensured = 0;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the command from the root with exec.env and MCPROC_PROJECT, no lease without memory', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const r = await runExec(
      ctx,
      { command: ['echo', 'hi'], capture: true },
      deps(null)
    );
    expect(r).toMatchObject({
      code: 0,
      output: 'hello\n',
      lease: null,
      waited_ms: 0,
    });
    expect(runs[0]).toMatchObject({
      command: ['echo', 'hi'],
      cwd: varsProj,
      env: {
        API_URL: 'http://127.0.0.1:3510',
        DB_PORT: '5632',
        MCPROC_PROJECT: varsProj,
      },
    });
    expect(store.list()).toEqual([]);
  });

  it('takes a running lease at once when memory fits, frees it with the exit code', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const r = await runExec(
      ctx,
      {
        command: ['bun', 'test'],
        memoryMib: 1000,
        note: 'tests',
        capture: true,
      },
      deps({ total_mib: 8000, available_mib: 4000 }, 3)
    );
    expect(r.code).toBe(3);
    expect(r.lease).toMatchObject({
      kind: 'exec',
      target: 'bun test',
      apps: [],
      estimate_mib: 1000,
      need_mib: 1200,
      note: 'tests',
      requester_pid: 9,
    });
    expect(store.get(r.lease!.id)).toMatchObject({
      state: 'freed',
      exit_code: 3,
    });
  });

  it('queues when memory is short and runs once the watcher marks it starting', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const d = deps({ total_mib: 8000, available_mib: 1500 });
    let polls = 0;
    d.sleep = async (ms) => {
      now += ms;
      polls++;
      if (polls === 2) {
        const l = store.pending()[0];
        await store.transition(l.id, 'starting');
      }
    };
    const r = await runExec(
      ctx,
      { command: ['bun', 'test'], memoryMib: 1000, capture: true },
      d
    );
    expect(ensured).toBe(1);
    expect(r.code).toBe(0);
    expect(r.waited_ms).toBe(2000);
    expect(store.get(r.lease!.id)?.state).toBe('freed');
    expect(runs).toHaveLength(1);
  });

  it('gives up after the timeout and cancels its lease; a cancelled lease ends it too', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    await expect(
      runExec(
        ctx,
        { command: ['x'], memoryMib: 1000, timeoutMs: 3000, capture: true },
        deps({ total_mib: 8000, available_mib: 1500 })
      )
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(store.list()[0]).toMatchObject({ state: 'cancelled' });
    expect(runs).toEqual([]);
    const d = deps({ total_mib: 8000, available_mib: 1500 });
    d.sleep = async (ms) => {
      now += ms;
      const l = store.pending()[0];
      if (l) await store.transition(l.id, 'cancelled', { error: 'by hand' });
    };
    await expect(
      runExec(ctx, { command: ['x'], memoryMib: 1000, capture: true }, d)
    ).rejects.toThrow(/cancelled/);
  });

  it('refuses a readonly or remote host and what never fits', async () => {
    const remote = fakeCtx(
      path.join(here, '..', 'fixtures', 'projects', 'fleet'),
      'box',
      []
    );
    await expect(
      runExec(remote, { command: ['x'], capture: true }, deps(null))
    ).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    const ro = fakeCtx(basic, 'local', []);
    (ro.host as { readonly: boolean }).readonly = true;
    await expect(
      runExec(ro, { command: ['x'], capture: true }, deps(null))
    ).rejects.toMatchObject({ code: 'READONLY_HOST' });
    const ctx = fakeCtx(varsProj, 'local', []);
    await expect(
      runExec(
        ctx,
        { command: ['x'], memoryMib: 9000, capture: true },
        deps({ total_mib: 8000, available_mib: 8000 })
      )
    ).rejects.toMatchObject({ code: 'NEVER_FITS' });
  });

  it('charges a stand admitted seconds ago against the reading, so the exec waits its turn', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    // a start admitted just now: its 3000M are not in the reading yet
    await store.withLock(() =>
      store.create(
        {
          kind: 'start',
          project: 'demo-w1',
          root: '/w/a',
          slot: 1,
          repo: '/w/demo',
          target: 'dev',
          host: null,
          apps: ['db'],
          reload: false,
          estimate_mib: 2500,
          need_mib: 3000,
          margin: 0.2,
          reserve_mib: 1024,
          sources: {},
          note: null,
          requester_pid: 1,
        },
        'running'
      )
    );
    const d = deps({ total_mib: 8000, available_mib: 4000 });
    let seen: string | null = null;
    d.sleep = async (ms) => {
      now += ms;
      const l = store.pending()[0];
      seen = l?.waiting_for ?? null;
      if (l) await store.transition(l.id, 'starting');
    };
    const r = await runExec(
      ctx,
      { command: ['bun', 'test'], memoryMib: 1000, capture: true },
      d
    );
    expect(seen).toMatch(/ramping/);
    expect(r.waited_ms).toBe(1000);
    expect(store.get(r.lease!.id)?.state).toBe('freed');
  });

  it('cancels its queued lease when the watcher cannot be launched, or the caller aborts', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const d = deps({ total_mib: 8000, available_mib: 1500 });
    d.ensureWatcher = async () => {
      throw new Error('no watcher here');
    };
    await expect(
      runExec(ctx, { command: ['x'], memoryMib: 1000, capture: true }, d)
    ).rejects.toThrow(/no watcher here/);
    expect(store.list()[0]).toMatchObject({
      state: 'cancelled',
      error: 'no watcher here',
    });
    const ac = new AbortController();
    const e = deps({ total_mib: 8000, available_mib: 1500 });
    e.sleep = async (ms) => {
      now += ms;
      ac.abort();
    };
    await expect(
      runExec(
        ctx,
        { command: ['x'], memoryMib: 1000, capture: true, signal: ac.signal },
        e
      )
    ).rejects.toMatchObject({ code: 'NOT_STARTED' });
    expect(store.list()[1]).toMatchObject({ state: 'cancelled' });
    expect(runs).toEqual([]);
  });

  it('frees its lease with the error when the command cannot run', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const d = deps({ total_mib: 8000, available_mib: 4000 });
    d.run = async () => {
      throw new Error('spawn failed');
    };
    await expect(
      runExec(ctx, { command: ['x'], memoryMib: 1000, capture: true }, d)
    ).rejects.toThrow(/spawn failed/);
    expect(store.list()[0]).toMatchObject({
      state: 'freed',
      error: 'spawn failed',
      exit_code: null,
    });
  });
});

describe('defaultExecDeps().run', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-exec-run-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs argv without a shell in cwd with env, keeps the last 200 whole lines of both streams and the exit code', async () => {
    const run = defaultExecDeps(dir).run;
    const script = [
      'for (let i = 0; i < 300; i++) (i % 2 ? process.stderr : process.stdout).write("line " + i + "\\n");',
      'process.stdout.write("tail without a newline");',
      'process.exitCode = 5;',
    ].join('\n');
    const r = await run([process.execPath, '-e', script], {
      cwd: dir,
      env: { EXEC_T: 'yes' },
      capture: true,
    });
    expect(r.code).toBe(5);
    const lines = r.output.split('\n');
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)).toBe('tail without a newline');
    expect(lines.every((l) => /^line \d+$|^tail/.test(l))).toBe(true);
    const first = await run(
      [
        process.execPath,
        '-e',
        'console.log("$HOME", process.env.EXEC_T, process.cwd())',
      ],
      { cwd: dir, env: { EXEC_T: 'yes' }, capture: true }
    );
    expect(first.output).toBe(`$HOME yes ${fs.realpathSync(dir)}`);
  });

  it('refuses a command that is not there with BAD_ARGUMENT naming it', async () => {
    const run = defaultExecDeps(dir).run;
    await expect(
      run(['mcproc-no-such-binary', 'x'], { cwd: dir, env: {}, capture: true })
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      message: expect.stringContaining('mcproc-no-such-binary'),
    });
  });

  it('answers on the exit and a second of drain when a grandchild it left behind holds its pipes', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    // the child starts a detached grandchild on its own stdout, notes its pid and exits 7 at once
    // apart from `dir`, which afterEach removes before onTestFinished runs
    const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-exec-gc-'));
    const pidFile = path.join(notes, 'grandchild.pid');
    const script = [
      "const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true });",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
      'console.log(g.pid);',
      'g.unref();',
      'process.exitCode = 7;',
    ].join('\n');
    // also when the run times out: the grandchild never ends by itself
    onTestFinished(() => {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        /* never started, or gone already */
      }
      fs.rmSync(notes, { recursive: true, force: true });
    });
    const t0 = Date.now();
    const r = await runExec(
      ctx,
      { command: [process.execPath, '-e', script], capture: true },
      defaultExecDeps(dir)
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.code).toBe(7);
    expect(r.output.trim()).toBe(fs.readFileSync(pidFile, 'utf8'));
  });

  it('ends the command on the signal', async () => {
    const run = defaultExecDeps(dir).run;
    const ac = new AbortController();
    const p = run([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      cwd: dir,
      env: {},
      capture: true,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.code).not.toBe(0);
  });
});

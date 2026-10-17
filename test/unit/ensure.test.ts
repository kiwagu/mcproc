import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureWatcher,
  watcherEntry,
  WATCHER_NAME,
  WATCHER_NS,
} from '../../src/core/leases/ensure.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import { Pm2Client } from '../../src/core/pm2.js';
import { fakeCtx } from '../helpers/ctx.js';

describe('watcherEntry and ensureWatcher', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vars = path.join(here, '..', 'fixtures', 'projects', 'vars');
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-ensure-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('watcherEntry: MCPROC_CLI_ENTRY, else the running cli.js, else a refusal that says how to set it', () => {
    expect(
      watcherEntry({ MCPROC_CLI_ENTRY: 'dist/cli.js' }, ['node', '/x/y.js'])
    ).toBe(path.resolve('dist/cli.js'));
    expect(watcherEntry({}, ['node', '/opt/mcproc/dist/cli.js'])).toBe(
      '/opt/mcproc/dist/cli.js'
    );
    expect(() =>
      watcherEntry({}, ['node', '/w/mcproc/src/cli.ts'])
    ).toThrowError(
      expect.objectContaining({
        code: 'NOT_STARTED',
        hint: expect.stringContaining('MCPROC_CLI_ENTRY'),
      })
    );
  });

  const jlist = (status: string) =>
    JSON.stringify([
      {
        pid: 77,
        name: WATCHER_NAME,
        pm_id: 9,
        pm2_env: { status, namespace: WATCHER_NS },
      },
    ]);
  const note = (msAgo: number) =>
    fs.writeFileSync(
      path.join(dir, 'watcher.json'),
      JSON.stringify({
        exiting_at: new Date(Date.now() - msAgo).toISOString(),
      })
    );
  const starts = (ctx: ReturnType<typeof fakeCtx>) =>
    ctx.fake.calls.filter((c) => c.cmd.includes('startOrRestart')).length;

  it('ensureWatcher leaves an online watcher alone', async () => {
    const ctx = fakeCtx(vars, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: jlist('online') } },
    ]);
    expect(await ensureWatcher(ctx, dir)).toBe('online');
    expect(starts(ctx)).toBe(0);
  });

  it('ensureWatcher starts a stopped watcher from an ecosystem file in the state directory, with the state dir, the CLI entry and PM2_HOME', async () => {
    vi.stubEnv('MCPROC_CLI_ENTRY', '/opt/mcproc/dist/cli.js');
    const ctx = fakeCtx(vars, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: jlist('stopped') } },
      { match: /startOrRestart/, result: {} },
    ]);
    ctx.pm2 = new Pm2Client(ctx.fake, ctx.host, 'pm2', '/tmp/pm2-home-w');
    expect(await ensureWatcher(ctx, dir)).toBe('started');
    const file = path.join(dir, 'watcher.ecosystem.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      apps: [
        {
          name: 'mcproc-watcher',
          namespace: 'mcproc',
          cwd: dir,
          script: process.execPath,
          args: ['/opt/mcproc/dist/cli.js', 'watch-leases'],
          interpreter: 'none',
          env: {
            MCPROC_STATE_DIR: dir,
            MCPROC_CLI_ENTRY: '/opt/mcproc/dist/cli.js',
            PM2_HOME: '/tmp/pm2-home-w',
          },
          autorestart: false,
          treekill: true,
          log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSS',
        },
      ],
    });
    const start = ctx.fake.calls.find((c) => c.cmd.includes('startOrRestart'))!;
    expect(start.cmd).toContain(
      `'startOrRestart' '${file}' '--only' 'mcproc-watcher'`
    );
    expect(start.opts.env).toEqual({ PM2_HOME: '/tmp/pm2-home-w' });
  });

  it('ensureWatcher run from the built cli.js without MCPROC_CLI_ENTRY carries only the state dir', async () => {
    vi.stubEnv('MCPROC_CLI_ENTRY', '');
    const argv = process.argv[1];
    process.argv[1] = '/opt/mcproc/dist/cli.js';
    try {
      const ctx = fakeCtx(vars, 'local', [
        { match: /pm2 'jlist'/, result: { stdout: '[]' } },
        { match: /startOrRestart/, result: {} },
      ]);
      expect(await ensureWatcher(ctx, dir)).toBe('started');
      const eco = JSON.parse(
        fs.readFileSync(path.join(dir, 'watcher.ecosystem.json'), 'utf8')
      );
      expect(eco.apps[0].env).toEqual({ MCPROC_STATE_DIR: dir });
      expect(eco.apps[0].args).toEqual([
        '/opt/mcproc/dist/cli.js',
        'watch-leases',
      ]);
    } finally {
      process.argv[1] = argv;
    }
  });

  it('ensureWatcher waits out a watcher that is leaving after an idle exit, then launches a fresh one and drops the note', async () => {
    vi.stubEnv('MCPROC_CLI_ENTRY', '/opt/mcproc/dist/cli.js');
    note(1000);
    let lists = 0;
    const ctx = fakeCtx(vars, 'local', [
      {
        match: /pm2 'jlist'/,
        // online for the first two reads, then gone
        result: () => ({ stdout: jlist(++lists <= 2 ? 'online' : 'stopped') }),
      },
      { match: /startOrRestart/, result: {} },
    ]);
    expect(await ensureWatcher(ctx, dir)).toBe('started');
    // three looks while it leaves, then the look under the lock before the launch
    expect(lists).toBe(4);
    expect(starts(ctx)).toBe(1);
    expect(fs.existsSync(path.join(dir, 'watcher.json'))).toBe(false);
  });

  it('ensureWatcher never holds the lease lock while it waits out a leaving watcher: it looks again under the lock and launches there', async () => {
    vi.stubEnv('MCPROC_CLI_ENTRY', '/opt/mcproc/dist/cli.js');
    note(1000);
    const lock = path.join(dir, 'leases', '.lock');
    const held: boolean[] = [];
    const ctx = fakeCtx(vars, 'local', [
      {
        match: /pm2 'jlist'/,
        result: () => {
          held.push(fs.existsSync(lock));
          return { stdout: jlist(held.length <= 2 ? 'online' : 'stopped') };
        },
      },
      {
        match: /startOrRestart/,
        result: () => {
          held.push(fs.existsSync(lock));
          return {};
        },
      },
    ]);
    // another holder takes the lock while the wait runs, and gets it at once
    const other = new LeaseStore(dir);
    const during = new Promise<number>((resolve) =>
      setTimeout(() => {
        const t0 = Date.now();
        void other.withLock(() => resolve(Date.now() - t0));
      }, 100)
    );
    expect(await ensureWatcher(ctx, dir)).toBe('started');
    expect(held).toEqual([false, false, false, true, true]);
    expect(await during).toBeLessThan(100);
  });

  it('ensureWatcher serialises its launch: two starts that queue at once launch one watcher', async () => {
    vi.stubEnv('MCPROC_CLI_ENTRY', '/opt/mcproc/dist/cli.js');
    let launched = false;
    const ctx = fakeCtx(vars, 'local', [
      {
        match: /pm2 'jlist'/,
        result: () => ({ stdout: jlist(launched ? 'online' : 'stopped') }),
      },
      {
        match: /startOrRestart/,
        result: () => {
          launched = true;
          return {};
        },
      },
    ]);
    const r = await Promise.all([
      ensureWatcher(ctx, dir),
      ensureWatcher(ctx, dir),
    ]);
    expect(r.sort()).toEqual(['online', 'started']);
    expect(starts(ctx)).toBe(1);
  });

  it('ensureWatcher trusts an online watcher whose exit note is older than 5 s', async () => {
    note(6000);
    const ctx = fakeCtx(vars, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: jlist('online') } },
    ]);
    expect(await ensureWatcher(ctx, dir)).toBe('online');
    expect(ctx.fake.calls.filter((c) => c.cmd.includes('jlist'))).toHaveLength(
      1
    );
  });

  it('ensureWatcher launches anyway when a watcher with a fresh exit note is still online after 3 s: it is on its way out', async () => {
    vi.stubEnv('MCPROC_CLI_ENTRY', '/opt/mcproc/dist/cli.js');
    note(0);
    const ctx = fakeCtx(vars, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: jlist('online') } },
      { match: /startOrRestart/, result: {} },
    ]);
    const t0 = Date.now();
    expect(await ensureWatcher(ctx, dir)).toBe('started');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(starts(ctx)).toBe(1);
    expect(fs.existsSync(path.join(dir, 'watcher.json'))).toBe(false);
  });

  it('ensureWatcher trusts the online watcher after the wait when a launch took the exit note meanwhile', async () => {
    vi.stubEnv('MCPROC_CLI_ENTRY', '/opt/mcproc/dist/cli.js');
    note(0);
    const ctx = fakeCtx(vars, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: jlist('online') } },
      { match: /startOrRestart/, result: {} },
    ]);
    // another start launched a fresh watcher while this one waited: the note is gone
    setTimeout(() => fs.rmSync(path.join(dir, 'watcher.json')), 500);
    expect(await ensureWatcher(ctx, dir)).toBe('online');
    expect(starts(ctx)).toBe(0);
  });
});

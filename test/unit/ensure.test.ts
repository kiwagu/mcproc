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
    expect(lists).toBe(3);
    expect(starts(ctx)).toBe(1);
    expect(fs.existsSync(path.join(dir, 'watcher.json'))).toBe(false);
  });

  it('ensureWatcher trusts an online watcher whose exit note is older than 5 s', async () => {
    note(6000);
    const ctx = fakeCtx(vars, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: jlist('online') } },
    ]);
    expect(await ensureWatcher(ctx, dir)).toBe('online');
    expect(ctx.fake.calls).toHaveLength(1);
  });

  it('ensureWatcher answers online when a watcher with a fresh exit note is still online after 3 s', async () => {
    note(0);
    const ctx = fakeCtx(vars, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: jlist('online') } },
    ]);
    const t0 = Date.now();
    expect(await ensureWatcher(ctx, dir)).toBe('online');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
    expect(starts(ctx)).toBe(0);
  });
});

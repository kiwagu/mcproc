import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  prepare,
  connect,
  clearResolutionCache,
  type Context,
} from '../../src/core/resolve.js';
import {
  startApps,
  stopApps,
  restartApps,
  deleteApps,
  type WaitRecord,
} from '../../src/core/actions.js';
import { listApps } from '../../src/core/list.js';
import { waitFor, parseUntil } from '../../src/core/wait.js';

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
/** Online at once, but listens only after 1.5 s: a `ready` dependency that really has to be waited for. */
const LAZY = `setTimeout(() => require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT)), 1500);`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops the daemon of a PM2_HOME with the bundled pm2, for a setup that failed before a context existed. */
function killDaemon(home: string) {
  if (!fs.existsSync(path.join(home, 'pm2.pid'))) return;
  const pm2 = createRequire(import.meta.url).resolve('pm2/bin/pm2');
  execFileSync(process.execPath, [pm2, 'kill'], {
    env: { ...process.env, PM2_HOME: home },
    stdio: 'ignore',
  });
}

describe.skipIf(process.env.MCPROC_IT !== '1')('readiness on real pm2', () => {
  let base: string | undefined;
  let home: string | undefined;
  let ctx: Context | undefined;
  /** the context, once beforeAll has made it */
  const c = () => ctx!;
  beforeAll(async () => {
    base = fs.mkdtempSync('/tmp/mcproc-rd-'); // short: unix socket paths are capped at 108 bytes
    home = path.join(base, 'home');
    const dir = path.join(base, 'p');
    fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.js'), SERVER);
    fs.writeFileSync(path.join(dir, 'lazy.js'), LAZY);
    fs.writeFileSync(
      path.join(dir, 'build.js'),
      `require('fs').writeFileSync('built.txt', String(Date.now())); console.log('built');`
    );
    fs.writeFileSync(
      path.join(dir, 'bad.js'),
      `console.error('boom'); process.exit(2);`
    );
    fs.writeFileSync(path.join(dir, 'slow.js'), `setTimeout(() => {}, 30000);`);
    fs.writeFileSync(
      path.join(dir, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: rd',
        'apps:',
        '  build: { description: one-shot build, kind: task, run: node build.js }',
        '  bad: { description: a task that fails, kind: task, run: node bad.js }',
        '  slow: { description: a task that takes long, kind: task, run: node slow.js }',
        '  web:',
        '    description: http server after the build',
        '    run: node server.js',
        '    env: { PORT: 38311 }',
        '    port: 38311',
        '    depends_on: [{ app: build, condition: completed }]',
        '  client:',
        '    description: needs the server up, which it already is',
        '    run: node -e "setInterval(() => {}, 1000)"',
        '    depends_on: [{ app: web, condition: ready, timeout: 30 }]',
        '  lazy:',
        '    description: a server that listens only after a delay',
        '    run: node lazy.js',
        '    env: { PORT: 38312 }',
        '    port: 38312',
        '  client2:',
        '    description: needs the lazy server to listen',
        '    run: node -e "setInterval(() => {}, 1000)"',
        '    depends_on: [{ app: lazy, condition: ready, timeout: 30 }]',
        '  late:',
        '    description: waits for the slow task, too briefly',
        '    run: node -e "setInterval(() => {}, 1000)"',
        '    depends_on: [{ app: slow, condition: completed, timeout: 2 }]',
        'hosts:',
        '  local:',
        `    pm2_home: ${home}`,
        '',
      ].join('\n')
    );
    clearResolutionCache();
    ctx = await connect(prepare({ project: dir }));
  });
  afterAll(async () => {
    try {
      if (ctx) await ctx.pm2.run(['kill']);
      else if (home) killDaemon(home); // setup failed before a context existed: the daemon may still be there
    } catch {
      /* daemon already gone */
    }
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('a task reads done after exit 0, failed (exit 2) after a failure, stopped after a stop; start re-runs it', async () => {
    await startApps(c(), 'build');
    const r = await waitFor(c(), 'build', parseUntil('exited'), {
      timeoutMs: 20_000,
    });
    expect(r).toMatchObject({ ok: true, status: 'done', exit_code: 0 });
    expect((await listApps(c(), 'build'))[0]).toMatchObject({
      status: 'done',
      exit_code: 0,
      uptime_ms: null,
    });
    const built = path.join(base!, 'p', 'built.txt');
    const first = fs.readFileSync(built, 'utf8');
    await startApps(c(), 'build'); // a finished task is run again
    expect(
      await waitFor(c(), 'build', parseUntil('exited'), { timeoutMs: 20_000 })
    ).toMatchObject({ ok: true, status: 'done', exit_code: 0 });
    expect(fs.readFileSync(built, 'utf8')).not.toBe(first);

    await startApps(c(), 'bad');
    expect(
      await waitFor(c(), 'bad', parseUntil('exited'), { timeoutMs: 20_000 })
    ).toMatchObject({
      ok: true,
      status: 'failed (exit 2)',
      exit_code: 2,
    });

    const started = await startApps(c(), 'slow');
    expect(started.find((x) => x.app === 'slow')!.status).toBe('online');
    await sleep(500);
    const stopped = (await stopApps(c(), 'slow')).find(
      (x) => x.app === 'slow'
    )!;
    expect(stopped.status).toBe('stopped');
    expect([130, 143]).toContain(stopped.exit_code); // the trap, not a bare null
    expect((await listApps(c(), 'slow'))[0].status).toBe('stopped');
  }, 60_000);

  it('a completed dependency gates start; wait listening, log: and idle: on a server', async () => {
    const waits: WaitRecord[] = [];
    const rows = await startApps(c(), 'web', { waits });
    expect(waits).toEqual([
      expect.objectContaining({
        app: 'web',
        dep: 'build',
        condition: 'completed',
        ok: true,
      }),
    ]);
    expect(rows.find((r) => r.app === 'web')!.status).toBe('online');
    expect(
      await waitFor(c(), 'web', parseUntil('listening'), {
        timeoutMs: 20_000,
      })
    ).toMatchObject({ ok: true, observed: ':38311 ✓' });
    // a new line: restart the server and match the line it prints on boot
    const stop = new AbortController(); // a restart that throws must not leave the wait running for its whole timeout
    const p = waitFor(c(), 'web', parseUntil('log:listening 383\\d\\d'), {
      timeoutMs: 20_000,
      signal: stop.signal,
    });
    p.catch(() => {}); // judged by the await below; this only keeps an early failure from going unhandled
    try {
      await sleep(300);
      await restartApps(c(), 'web');
      expect(await p).toMatchObject({
        ok: true,
        matched_line: expect.stringContaining('listening 38311'),
      });
    } finally {
      stop.abort();
    }
    // the server is silent after its boot line: the wait has to sit out the quiet second
    const t0 = Date.now();
    const idle = await waitFor(c(), 'web', parseUntil('idle:1'), {
      timeoutMs: 20_000,
    });
    expect(idle).toMatchObject({ ok: true, observed: 'no new output' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  }, 60_000);

  it('ready passes at once for a listening dependency and waits for one that listens late; a completed dependency that times out leaves the dependent skipped', async () => {
    const waits: WaitRecord[] = [];
    const rows = await startApps(c(), 'client', { waits });
    expect(waits).toEqual([
      expect.objectContaining({
        app: 'client',
        dep: 'web',
        condition: 'ready',
        ok: true,
      }),
    ]);
    expect(rows.find((r) => r.app === 'client')!.status).toBe('online');

    // lazy is online at once but listens only after 1.5 s: client2 starts after that wait, not before
    const lazyWaits: WaitRecord[] = [];
    const lazyRows = await startApps(c(), 'client2', { waits: lazyWaits });
    expect(lazyWaits).toEqual([
      expect.objectContaining({
        app: 'client2',
        dep: 'lazy',
        condition: 'ready',
        ok: true,
      }),
    ]);
    expect(lazyWaits[0].ms).toBeGreaterThanOrEqual(1000);
    expect(lazyRows.find((r) => r.app === 'lazy')!.status).toBe('online');
    expect(lazyRows.find((r) => r.app === 'client2')!.status).toBe('online');
    expect((await listApps(c(), 'lazy'))[0].ports.checks).toEqual([
      { port: 38312, status: 'listening' },
    ]);

    const late = await startApps(c(), 'late');
    expect(late.find((r) => r.app === 'late')).toMatchObject({
      status: 'skipped',
      error: expect.stringMatching(/^slow not completed in 2 s/),
    });
    expect(late.find((r) => r.app === 'slow')!.status).toBe('online');
  }, 60_000);

  it('cleanup', async () => {
    await deleteApps(c(), 'all');
  }, 30_000);
});

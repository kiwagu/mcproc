import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.env.MCPROC_IT !== '1')('readiness on real pm2', () => {
  let base: string;
  let ctx: Context;
  beforeAll(async () => {
    base = fs.mkdtempSync('/tmp/mcproc-rd-'); // short: unix socket paths are capped at 108 bytes
    const home = path.join(base, 'home');
    const dir = path.join(base, 'p');
    fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server.js'), SERVER);
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
        '    description: needs the server up',
        '    run: node -e "setInterval(() => {}, 1000)"',
        '    depends_on: [{ app: web, condition: ready, timeout: 30 }]',
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
      await ctx.pm2.run(['kill']);
    } catch {
      /* daemon already gone */
    }
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('a task reads done after exit 0, failed (exit 2) after a failure, stopped after a stop; start re-runs it', async () => {
    await startApps(ctx, 'build');
    const r = await waitFor(ctx, 'build', parseUntil('exited'), {
      timeoutMs: 20_000,
    });
    expect(r).toMatchObject({ ok: true, status: 'done', exit_code: 0 });
    expect((await listApps(ctx, 'build'))[0]).toMatchObject({
      status: 'done',
      exit_code: 0,
      uptime_ms: null,
    });
    const first = fs.readFileSync(path.join(base, 'p', 'built.txt'), 'utf8');
    await sleep(20);
    await startApps(ctx, 'build');
    await waitFor(ctx, 'build', parseUntil('exited'), { timeoutMs: 20_000 });
    expect(fs.readFileSync(path.join(base, 'p', 'built.txt'), 'utf8')).not.toBe(
      first
    );

    await startApps(ctx, 'bad');
    expect(
      await waitFor(ctx, 'bad', parseUntil('exited'), { timeoutMs: 20_000 })
    ).toMatchObject({
      ok: true,
      status: 'failed (exit 2)',
      exit_code: 2,
    });

    await startApps(ctx, 'slow');
    await sleep(500);
    await stopApps(ctx, 'slow');
    expect((await listApps(ctx, 'slow'))[0].status).toBe('stopped');
  }, 60_000);

  it('wait listening and wait log: on a server', async () => {
    const waits: WaitRecord[] = [];
    const rows = await startApps(ctx, 'web', { waits });
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
      await waitFor(ctx, 'web', parseUntil('listening'), {
        timeoutMs: 20_000,
      })
    ).toMatchObject({ ok: true, observed: ':38311 ✓' });
    // a new line: restart the server and match the line it prints on boot
    const p = waitFor(ctx, 'web', parseUntil('log:listening 383\\d\\d'), {
      timeoutMs: 20_000,
    });
    await sleep(300);
    await restartApps(ctx, 'web');
    expect(await p).toMatchObject({
      ok: true,
      matched_line: expect.stringContaining('listening 38311'),
    });
    expect(
      await waitFor(ctx, 'web', parseUntil('idle:1'), { timeoutMs: 20_000 })
    ).toMatchObject({ ok: true });
  }, 60_000);

  it('ready waits for the port; a completed timeout leaves the dependent skipped', async () => {
    const waits: WaitRecord[] = [];
    const rows = await startApps(ctx, 'client', { waits });
    expect(waits.at(-1)).toMatchObject({
      app: 'client',
      dep: 'web',
      condition: 'ready',
      ok: true,
    });
    expect(rows.find((r) => r.app === 'client')!.status).toBe('online');
    const late = await startApps(ctx, 'late');
    expect(late.find((r) => r.app === 'late')).toMatchObject({
      status: 'skipped',
      error: expect.stringMatching(/^slow not completed in 2 s/),
    });
    expect(late.find((r) => r.app === 'slow')!.status).toBe('online');
  }, 60_000);

  it('cleanup', async () => {
    await deleteApps(ctx, 'all');
  }, 30_000);
});

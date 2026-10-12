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
} from '../../src/core/actions.js';
import { listApps, portsReport } from '../../src/core/list.js';
import { readLogs } from '../../src/core/logs.js';
import { findProcess } from '../../src/core/pm2.js';

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function project(dir: string, name: string, port: number, home: string) {
  fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), SERVER);
  fs.writeFileSync(
    path.join(dir, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      `project: ${name}`,
      'apps:',
      '  web-build:',
      '    description: fake watch build',
      '    kind: build',
      '    run: node -e "setInterval(() => {}, 1000)"',
      '  web:',
      '    description: http server',
      '    run: node server.js',
      `    env: { PORT: ${port} }`,
      `    port: ${port}`,
      `    url: http://127.0.0.1:${port}/`,
      '    depends_on: [web-build]',
      'hosts:',
      '  local:',
      `    pm2_home: ${home}`,
      '',
    ].join('\n')
  );
}

let base: string;
let ctxA: Context;
let ctxB: Context;
let ctxC: Context;
beforeAll(async () => {
  base = fs.mkdtempSync('/tmp/mcproc-it-'); // short on purpose: unix socket paths are capped at 108 bytes
  const home = path.join(base, 'home');
  project(path.join(base, 'a'), 'ita', 38211, home);
  project(path.join(base, 'b'), 'itb', 38212, home); // same daemon, different namespace
  project(path.join(base, 'c'), 'ita', 38213, home); // a second checkout declaring the same project slug as a
  clearResolutionCache();
  ctxA = await connect(prepare({ project: path.join(base, 'a') }));
  ctxB = await connect(prepare({ project: path.join(base, 'b') }));
  ctxC = await connect(prepare({ project: path.join(base, 'c') }));
});
afterAll(async () => {
  try {
    await ctxA.pm2.run(['kill']);
  } catch {
    /* daemon already gone */
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe('real pm2', () => {
  it('start → ls shows the port → logs → stop → restart → delete', async () => {
    expect(['bundled', 'path']).toContain(ctxA.resolution.source);
    let rows = await startApps(ctxA, 'web');
    expect(rows.map((r) => r.app)).toEqual(['web-build', 'web']);
    await sleep(1500);
    const web = (await listApps(ctxA, 'web'))[0];
    expect(web.status).toBe('online');
    expect(web.ports.checks).toEqual([{ port: 38211, status: 'listening' }]);
    expect(web.metrics_source).toBe('tree');
    expect(web.memory).toBeGreaterThan(web.pm2_memory);
    expect(web.runtime).toMatch(/node/);
    expect(web.procs).toBeGreaterThanOrEqual(1);
    expect(web).toMatchObject({
      url: 'http://127.0.0.1:38211/',
      url_status: 'ok',
      url_code: 200,
    });
    expect((await readLogs(ctxA, 'web', { lines: 20 })).out).toContain(
      'listening 38211'
    );
    expect((await portsReport(ctxA, 38211)).listeners[0]?.app).toBe('web');
    rows = await stopApps(ctxA, 'web');
    expect(rows.find((r) => r.app === 'web')!.ports.checks[0].status).toBe(
      'declared-not-listening'
    );
    await restartApps(ctxA, 'web');
    await sleep(1500);
    expect((await listApps(ctxA, 'web'))[0].ports.checks[0].status).toBe(
      'listening'
    );
  }, 60_000);

  it('same app name in another namespace is neither shown nor restarted (Review Focus 1)', async () => {
    await startApps(ctxB, 'web');
    await sleep(1500);
    const pidB = findProcess(await ctxB.pm2.jlist(), 'itb', 'web')!.pid;
    expect(pidB).toBeGreaterThan(0);
    await restartApps(ctxA, 'web');
    await sleep(1500);
    const pidBAfter = findProcess(await ctxB.pm2.jlist(), 'itb', 'web')!.pid;
    if (pidBAfter !== pidB) {
      throw new Error(
        'pm2 startOrRestart --only restarted a same-named app in ANOTHER namespace. STOP: this changes the naming design (short pm2 names + namespace); report to the owner before changing anything.'
      );
    }
    const rowsA = await listApps(ctxA);
    expect(rowsA.find((r) => r.app === 'web')!.ports.checks[0]).toEqual({
      port: 38211,
      status: 'listening',
    });
    const rowsB = await listApps(ctxB);
    expect(rowsB.find((r) => r.app === 'web')!.ports.checks[0]).toEqual({
      port: 38212,
      status: 'listening',
    });
  }, 60_000);

  it('a second checkout with the same project slug is refused and the first keeps running', async () => {
    const pidA = findProcess(await ctxA.pm2.jlist(), 'ita', 'web')!.pid;
    expect(pidA).toBeGreaterThan(0);
    await expect(startApps(ctxC, 'web')).rejects.toMatchObject({
      code: 'NAME_COLLISION',
    });
    await sleep(500);
    expect(findProcess(await ctxA.pm2.jlist(), 'ita', 'web')!.pid).toBe(pidA);
    expect((await listApps(ctxA, 'web'))[0].ports.checks[0]).toEqual({
      port: 38211,
      status: 'listening',
    });
  }, 30_000);

  it('monit --once prints the table, the port and the log tail', async () => {
    const { buildProgram } = await import('../../src/cli/program.js');
    const out: string[] = [];
    await buildProgram({
      out: (s) => {
        out.push(s);
      },
      err: (s) => {
        out.push(`ERR ${s}`);
      },
    }).parseAsync(['monit', '--once', '--project', path.join(base, 'a')], {
      from: 'user',
    });
    const text = out.join('\n');
    expect(text).toMatch(/▶web-build|▶web/);
    expect(text).toContain(':38211 ✓');
    expect(text).toContain('http://127.0.0.1:38211/ ✓ 200');
    expect(text).toMatch(/listening 38211|logs:/);
    expect(text).toContain('RSS sum');
  }, 30_000);

  it('delete all leaves every app not-started', async () => {
    const rows = await deleteApps(ctxA, 'all');
    expect(rows.every((r) => r.status === 'not-started')).toBe(true);
    await deleteApps(ctxB, 'all');
  }, 30_000);
});

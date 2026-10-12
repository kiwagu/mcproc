import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepare,
  connect,
  clearResolutionCache,
} from '../../src/core/resolve.js';
import { createTransport } from '../../src/transport/index.js';
import { unpack, defaultUnpackDeps } from '../../src/runtime/unpack.js';
import { ensurePm2Bundle } from '../../src/runtime/bundle.js';
import { startApps, deleteApps } from '../../src/core/actions.js';
import { listApps } from '../../src/core/list.js';

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let base: string;
let proj: string;
let rt: string;
let home: string;

beforeAll(async () => {
  await ensurePm2Bundle(); // assembles the pm2 tree once into the cache (network: npm registry)
  base = fs.mkdtempSync('/tmp/mcproc-rt-'); // short: pm2 sockets live in PM2_HOME and unix socket paths cap at 108 bytes
  rt = path.join(base, 'rt');
  home = path.join(base, 'h');
  proj = path.join(base, 'p');
  fs.mkdirSync(path.join(proj, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'server.js'), SERVER);
  fs.writeFileSync(
    path.join(proj, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      'project: itrt',
      'apps:',
      '  web:',
      '    description: http server',
      '    run: node server.js',
      '    env: { PORT: 38511 }',
      '    port: 38511',
      'hosts:',
      '  local:',
      `    runtime: ${rt}`,
      `    pm2_home: ${home}`,
      '',
    ].join('\n')
  );
});
afterAll(() => {
  try {
    execFileSync(path.join(rt, 'bin', 'pm2'), ['kill'], {
      env: { ...process.env, PM2_HOME: home },
      stdio: 'ignore',
    });
  } catch {
    /* no daemon */
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe('unpack on the local host (real tar, real pm2)', () => {
  it('unpacks without starting a daemon, is preferred by resolution, runs an app, and is a noop the second time', async () => {
    const p = prepare({ project: proj });
    const r = await unpack(
      {
        manifest: p.manifest,
        host: p.host,
        transport: createTransport(p.host),
      },
      { withNode: 'never' },
      defaultUnpackDeps()
    );
    expect(r).toMatchObject({
      noop: false,
      runtime_dir: rt,
      pm2: { version: '7.0.4', written: true },
      node: null,
      manifest_copy: 'not-needed-local',
      runtime_line: null,
    });
    expect(
      fs.existsSync(
        path.join(rt, 'pm2', '7.0.4', 'node_modules', 'pm2', 'bin', 'pm2')
      )
    ).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(rt, 'lock.json'), 'utf8'))
    ).toMatchObject({ pm2: '7.0.4' });
    expect(fs.existsSync(path.join(home, 'pm2.pid'))).toBe(false);
    clearResolutionCache();
    const ctx = await connect(prepare({ project: proj }));
    expect(ctx.resolution.source).toBe('runtime');
    await startApps(ctx, 'web');
    await sleep(1500);
    expect((await listApps(ctx, 'web'))[0].ports.checks[0]).toEqual({
      port: 38511,
      status: 'listening',
    });
    await deleteApps(ctx, 'web');
    const again = await unpack(
      {
        manifest: p.manifest,
        host: p.host,
        transport: createTransport(p.host),
      },
      { withNode: 'never' },
      defaultUnpackDeps()
    );
    expect(again.noop).toBe(true);
  }, 120_000);
});

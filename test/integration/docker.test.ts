import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, connect, clearResolutionCache } from '../../src/core/resolve.js';
import { createTransport } from '../../src/transport/index.js';
import { unpack, defaultUnpackDeps } from '../../src/runtime/unpack.js';
import { ensurePm2Bundle } from '../../src/runtime/bundle.js';
import { startApps } from '../../src/core/actions.js';
import { listApps } from '../../src/core/list.js';

const RUN = process.env.MCPROC_IT_DOCKER === '1';
const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('unpack into a bare alpine container (docker transport, network for the Node download)', () => {
  const name = `mcproc-it-alpine-${process.pid}`;
  let proj: string;
  beforeAll(async () => {
    await ensurePm2Bundle();
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, 'alpine:3', 'sleep', '900'], { stdio: 'ignore' });
    // the nodejs.org musl build is linked against libstdc++/libgcc, which a bare alpine lacks; unpack refuses without it, so the host provides it
    execFileSync('docker', ['exec', name, 'apk', 'add', '-q', '--no-progress', 'libstdc++'], { stdio: 'ignore' });
    proj = fs.mkdtempSync('/tmp/mcproc-dk-');
    fs.mkdirSync(path.join(proj, '.mcproc'));
    fs.writeFileSync(path.join(proj, '.mcproc', 'mcproc.yaml'), [
      'version: 1', 'project: itdk', 'apps:', '  web:', '    description: http server inside alpine',
      '    run: /srv/p/.mcproc/runtime/bin/node server.js', '    env: { PORT: 38611 }', '    port: 38611',
      'hosts:', '  box:', `    docker: { container: ${name} }`, '    cwd: /srv/p', '    shell: /bin/sh -c', '',
    ].join('\n'));
  }, 180_000);
  afterAll(() => {
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* already gone */ }
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('brings musl Node and pm2, then ls sees the app port through the /proc fallback', async () => {
    const p = prepare({ project: proj, host: 'box' });
    const t = createTransport(p.host);
    await t.exec('mkdir -p /srv/p && cat > /srv/p/server.js', { stdin: SERVER });
    const r = await unpack({ manifest: p.manifest, host: p.host, transport: t }, {}, defaultUnpackDeps());
    expect(r.node).toMatchObject({ platform: 'linux-x64-musl', written: true });
    expect(r.manifest_copy).toBe('written');
    clearResolutionCache();
    const ctx = await connect(prepare({ project: proj, host: 'box' }));
    expect(ctx.resolution.source).toBe('runtime');
    await startApps(ctx, 'web');
    await sleep(2500);
    const row = (await listApps(ctx, 'web'))[0];
    expect(row.status).toBe('online');
    expect(row.ports.checks[0]).toEqual({ port: 38611, status: 'listening' });
  }, 600_000);
});

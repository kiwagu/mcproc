import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { prepare, connect, clearResolutionCache } from '../../src/core/resolve.js';
import { createTransport } from '../../src/transport/index.js';
import { unpack, defaultUnpackDeps } from '../../src/runtime/unpack.js';
import { startApps, deleteApps } from '../../src/core/actions.js';
import { listApps } from '../../src/core/list.js';

const SSH = process.env.MCPROC_TEST_SSH;
const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SSH)('unpack and run over ssh', () => {
  const remote = `/tmp/mcproc-ssh-${process.pid}`;
  let proj: string;
  beforeAll(() => {
    proj = fs.mkdtempSync('/tmp/mcproc-sp-');
    fs.mkdirSync(path.join(proj, '.mcproc'));
    fs.writeFileSync(path.join(proj, '.mcproc', 'mcproc.yaml'), [
      'version: 1', 'project: itssh', 'apps:', '  web:', '    description: http server over ssh',
      `    run: ${remote}/.mcproc/runtime/bin/node server.js 2>/dev/null || node server.js`, '    env: { PORT: 38711 }', '    port: 38711',
      'hosts:', '  far:', `    ssh: ${SSH}`, `    cwd: ${remote}`, `    pm2_home: ${remote}/h`, '',
    ].join('\n'));
  });
  afterAll(async () => {
    const p = prepare({ project: proj, host: 'far' });
    const t = createTransport(p.host);
    await t.exec(`PM2_HOME=${remote}/h ${remote}/.mcproc/runtime/bin/pm2 kill >/dev/null 2>&1; rm -rf ${remote}`);
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('unpacks over ssh and drives an app with an isolated PM2_HOME', async () => {
    const p = prepare({ project: proj, host: 'far' });
    const t = createTransport(p.host);
    await t.exec(`mkdir -p ${remote} && cat > ${remote}/server.js`, { stdin: SERVER });
    const r = await unpack({ manifest: p.manifest, host: p.host, transport: t }, {}, defaultUnpackDeps());
    expect(r.pm2.written).toBe(true);
    clearResolutionCache();
    const ctx = await connect(prepare({ project: proj, host: 'far' }));
    expect(ctx.resolution.source).toBe('runtime');
    await startApps(ctx, 'web');
    await sleep(2000);
    expect((await listApps(ctx, 'web'))[0].ports.checks[0]).toEqual({ port: 38711, status: 'listening' });
    await deleteApps(ctx, 'web');
  }, 600_000);
});

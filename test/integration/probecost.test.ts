import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  clearResolutionCache,
  connect,
  prepare,
} from '../../src/core/resolve.js';
import { actOn, Fleet } from '../../src/core/fleet.js';
import { listApps } from '../../src/core/list.js';
import { waitFor } from '../../src/core/wait.js';
import { readLogs } from '../../src/core/logs.js';
import { closeDaemons, listDaemon } from '../../src/core/pm2socket.js';
import { clearLoginEnvCache } from '../../src/transport/index.js';

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const PORT = 38331;
const pm2Bin = createRequire(import.meta.url).resolve('pm2/bin/pm2');
let base: string;
let home: string;
let project: string;
const saved = process.env.PM2_HOME;
const ctxOf = () => connect(prepare({ project }));

beforeAll(() => {
  base = fs.mkdtempSync('/tmp/mcproc-pc-'); // short: unix socket paths are capped at 108 bytes
  home = path.join(base, 'h');
  process.env.PM2_HOME = home;
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(
    path.join(bin, 'hello-tool'),
    '#!/bin/sh\necho hello from the tool\n',
    { mode: 0o755 }
  );
  // a stand-in login shell: its "profile" sets the PATH, as nvm or nodenv would
  fs.writeFileSync(
    path.join(base, 'login'),
    `#!/bin/sh\nexport PATH="${bin}:/usr/bin:/bin"\nexport FROM_PROFILE=yes\n[ "$1" = -c ] && shift\nexec /bin/sh -c "$1"\n`,
    { mode: 0o755 }
  );
  project = path.join(base, 'p');
  fs.mkdirSync(path.join(project, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(project, 'server.js'), SERVER);
  fs.writeFileSync(
    path.join(project, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      'project: pc',
      'apps:',
      '  web:',
      '    description: http server',
      '    run: node server.js',
      `    env: { PORT: ${PORT} }`,
      `    port: ${PORT}`,
      '  tool:',
      '    description: needs the profile PATH',
      '    kind: task',
      '    run: hello-tool',
      'hosts:',
      '  local:',
      `    shell: ${base}/login -c`,
      '',
    ].join('\n')
  );
  clearResolutionCache();
  clearLoginEnvCache();
});

afterAll(() => {
  closeDaemons();
  try {
    execFileSync(process.execPath, [pm2Bin, 'kill'], {
      env: { ...process.env, PM2_HOME: home },
      stdio: 'ignore',
    });
  } catch {
    /* no daemon left */
  }
  if (saved === undefined) delete process.env.PM2_HOME;
  else process.env.PM2_HOME = saved;
  clearLoginEnvCache();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('probe cost, on real pm2', () => {
  it('listing a PM2_HOME with no daemon starts none', async () => {
    const rows = await listApps(await ctxOf());
    expect(rows.map((r) => r.status)).toEqual(['not-started', 'not-started']);
    expect(fs.existsSync(path.join(home, 'pm2.pid'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'rpc.sock'))).toBe(false);
  });
  it("reads run in plain sh and still see the profile's PATH", async () => {
    const ctx = await ctxOf();
    await listApps(ctx);
    expect(ctx.transport.readMode()?.shell).toBe('plain');
    expect((await ctx.transport.read('command -v hello-tool')).code).toBe(0);
  });
  it("an app whose command needs the profile's PATH still starts", async () => {
    await actOn(
      new Fleet(prepare({ project }).manifest, undefined),
      'tool',
      'start'
    );
    const ctx = await ctxOf();
    expect(
      await waitFor(ctx, 'tool', { kind: 'exited' }, { timeoutMs: 15_000 })
    ).toMatchObject({ ok: true, exit_code: 0 });
    expect(JSON.stringify(await readLogs(ctx, 'tool'))).toContain(
      'hello from the tool'
    );
  }, 30_000);
  it('wait until listening on a real server', async () => {
    await actOn(
      new Fleet(prepare({ project }).manifest, undefined),
      'web',
      'start'
    );
    expect(
      await waitFor(
        await ctxOf(),
        'web',
        { kind: 'listening' },
        { timeoutMs: 15_000 }
      )
    ).toMatchObject({ ok: true });
  }, 30_000);
  it('the socket list is what pm2 jlist prints', async () => {
    type Raw = {
      name: string;
      pid?: number;
      pm_id: number;
      pm2_env?: { status?: string };
    };
    const pick = (l: Raw[]) =>
      l
        .map((p) => [p.name, p.pid, p.pm_id, p.pm2_env?.status].join(' '))
        .sort();
    const cli = execFileSync(process.execPath, [pm2Bin, 'jlist'], {
      env: { ...process.env, PM2_HOME: home },
      encoding: 'utf8',
    });
    const last = cli.trim().split('\n').pop() as string;
    const socket = (await listDaemon(home)) as Raw[];
    expect(socket).toHaveLength(2); // tool and web: two empty lists would prove nothing
    expect(pick(socket)).toEqual(pick(JSON.parse(last)));
  });
  it.skipIf(!process.env.MCPROC_CLI)(
    'a spawned mcproc ls exits at once',
    () => {
      const t = Date.now();
      const r = spawnSync(
        process.execPath,
        [process.env.MCPROC_CLI as string, '--project', project, 'ls'],
        {
          encoding: 'utf8',
          timeout: 15_000,
        }
      );
      expect(r.status).toBe(0);
      expect(Date.now() - t).toBeLessThan(5000);
    }
  );
});

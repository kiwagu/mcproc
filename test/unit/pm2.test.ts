import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJlist, findProcess, Pm2Client, resolvePm2Bin, bundledPm2Bin } from '../../src/core/pm2.js';
import { FakeTransport } from '../helpers/fake-transport.js';
import type { Host } from '../../src/core/manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => fs.readFileSync(path.join(here, '..', 'fixtures', p), 'utf8');
const local: Host = { name: 'local', local: true, ssh_args: [], cwd: '/p', readonly: false, shell: { bin: '/bin/bash', flags: ['-lc'] }, env: {} };
const remote: Host = { ...local, name: 'stand', local: false, ssh: 'stand', cwd: '/srv/p' };

describe('parseJlist', () => {
  it('skips the coloured preamble and update notice', () => {
    const procs = parseJlist(fx('jlist/with-preamble.txt'));
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({ pm_id: 0, name: 'api', namespace: 'demo', pid: 69265, status: 'online', restarts: 2, out_log: '/h/logs/api-out.log', watch: true, memory: 51200000 });
    expect(procs[0].uptime_ms).toBeGreaterThan(0);
  });
  it('parses an empty list and defaults namespace/pid', () => {
    expect(parseJlist('[]')).toEqual([]);
    const [w] = parseJlist(fx('jlist/two-namespaces.json')).filter((p) => p.name === 'demo-worker');
    expect(w).toMatchObject({ pid: 0, status: 'stopped', uptime_ms: null, unstable_restarts: 1 });
  });
  it('throws PM2_FAILED when no JSON array is present', () => {
    expect(() => parseJlist('[PM2] something went wrong\n')).toThrowError(/no JSON array/);
  });
});

describe('findProcess', () => {
  it('selects the project-prefixed pm2 name inside the project namespace', () => {
    const procs = parseJlist(fx('jlist/two-namespaces.json'));
    expect(findProcess(procs, 'demo', 'web')?.pid).toBe(100);
    expect(findProcess(procs, 'other', 'web')?.pid).toBe(200);
    expect(findProcess(procs, 'third', 'web')).toBeUndefined();
  });
  it('ignores a short-named process and a prefixed name in another namespace', () => {
    const procs = parseJlist(JSON.stringify([
      { pid: 1, name: 'web', pm_id: 0, pm2_env: { namespace: 'demo' } },
      { pid: 2, name: 'demo-web', pm_id: 1, pm2_env: { namespace: 'other' } },
    ]));
    expect(findProcess(procs, 'demo', 'web')).toBeUndefined();
  });
});

describe('Pm2Client', () => {
  it('runs pm2 through the transport with PM2_HOME and quoted args', async () => {
    const t = new FakeTransport([{ match: /jlist/, result: { stdout: '[]' } }, { match: /startOrRestart/, result: {} }]);
    const c = new Pm2Client(t, local, 'pm2', '/tmp/h');
    expect(await c.jlist()).toEqual([]);
    await c.startOrRestart('/p/.mcproc/.generated/ecosystem.json', 'api');
    expect(t.calls[0]).toMatchObject({ cmd: `pm2 'jlist'`, opts: { env: { PM2_HOME: '/tmp/h' } } });
    expect(t.calls[1].cmd).toBe(`pm2 'startOrRestart' '/p/.mcproc/.generated/ecosystem.json' '--only' 'api' '--update-env'`);
    expect(t.calls[1].opts.timeoutMs).toBe(90_000);
  });
  it('maps exit 127 to PM2_NOT_FOUND and other failures to PM2_FAILED', async () => {
    const t = new FakeTransport([{ match: /jlist/, result: { code: 127, stderr: 'bash: pm2: command not found' } }, { match: /stop/, result: { code: 1, stderr: '[PM2][ERROR] Process 9 not found' } }]);
    const c = new Pm2Client(t, local, 'pm2');
    await expect(c.jlist()).rejects.toMatchObject({ code: 'PM2_NOT_FOUND' });
    await expect(c.stop(9)).rejects.toMatchObject({ code: 'PM2_FAILED', message: expect.stringContaining('Process 9 not found') });
  });
  it('exit 127 from a missing shell is a transport failure, not a missing pm2', async () => {
    const t = new FakeTransport([{ match: /jlist/, result: { code: 127, stderr: 'sh: 1: /bin/bash: not found' } }]);
    await expect(new Pm2Client(t, remote, 'pm2').jlist()).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
});

describe('resolvePm2Bin', () => {
  it('explicit hosts.<h>.pm2 wins without probing', async () => {
    const t = new FakeTransport([]);
    const r = await resolvePm2Bin({ ...local, pm2: '/opt/pm2/bin/pm2' }, t);
    expect(r).toMatchObject({ bin: '/opt/pm2/bin/pm2', source: 'explicit' });
    expect(t.calls).toHaveLength(0);
  });
  it('prefers the runtime bundle, then a usable PATH pm2', async () => {
    const rt = new FakeTransport([{ match: /bin\/pm2/, result: { stdout: 'RUNTIME\nPATH_OK\n6.0.8\nv18.20.0\n' } }]);
    expect((await resolvePm2Bin(remote, rt)).source).toBe('runtime');
    expect((await resolvePm2Bin(remote, rt)).bin).toBe(`'/srv/p/.mcproc/runtime/bin/pm2'`);
    const pathOk = new FakeTransport([{ match: /bin\/pm2/, result: { stdout: 'PATH_OK\n7.0.1\nv22.11.0\n' } }]);
    expect(await resolvePm2Bin(remote, pathOk)).toMatchObject({ bin: 'pm2', source: 'path', pm2Version: '7.0.1', node: 'v22.11.0' });
  });
  it('reports TRANSPORT_FAILED when the probe shell itself did not run', async () => {
    const noShell = new FakeTransport([{ match: /bin\/pm2/, result: { code: 127, stdout: '', stderr: 'sh: 1: /bin/bash: not found' } }]);
    await expect(resolvePm2Bin(remote, noShell)).rejects.toMatchObject({ code: 'TRANSPORT_FAILED', message: expect.stringContaining('/bin/bash: not found') });
    await expect(resolvePm2Bin(local, noShell)).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
  it('rejects a broken shim or old node on a remote host, falls back to bundled locally', async () => {
    const shim = new FakeTransport([{ match: /bin\/pm2/, result: { stdout: 'PATH_OK\n\nv26.8.1\n' } }]);
    await expect(resolvePm2Bin(remote, shim)).rejects.toMatchObject({ code: 'PM2_NOT_FOUND' });
    const old = new FakeTransport([{ match: /bin\/pm2/, result: { stdout: 'PATH_OK\n5.4.0\nv16.20.0\n' } }]);
    await expect(resolvePm2Bin(remote, old)).rejects.toMatchObject({ code: 'PM2_NOT_FOUND' });
    const none = new FakeTransport([{ match: /bin\/pm2/, result: { stdout: 'PATH_NONE\nNODE_NONE\n' } }]);
    const r = await resolvePm2Bin(local, none);
    expect(r.source).toBe('bundled');
    expect(r.bin).toBe(bundledPm2Bin());
    expect(bundledPm2Bin()).toMatch(/node_modules\/pm2\/bin\/pm2'$/);
  });
});

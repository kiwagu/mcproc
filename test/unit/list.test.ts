import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { MARK } from '../../src/shell/snippets.js';
import { listApps, portsReport, hostsInfo, describeApp, describeProject } from '../../src/core/list.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fx = (p: string) => fs.readFileSync(path.join(here, '..', 'fixtures', 'probe', p), 'utf8');
const jlist = JSON.stringify([
  { pid: 69265, name: 'demo-api', pm_id: 0, monit: { cpu: 1.5, memory: 1024 }, pm2_env: { status: 'online', namespace: 'demo', pm_uptime: Date.now() - 5000, restart_time: 1, pm_out_log_path: '/h/api-out.log', pm_err_log_path: '/h/api-error.log' } },
  { pid: 4242, name: 'demo-api-build', pm_id: 1, pm2_env: { status: 'online', namespace: 'demo' } },
]);
const probeRule = { match: MARK.JLIST, result: { stdout: probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt'), udp: fx('ss-udp.txt') }) } };

describe('listApps', () => {
  it('returns one row per manifest app, in manifest order, with ports and not-started apps', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    const rows = await listApps(ctx);
    expect(rows.map((r) => r.app)).toEqual(['api-build', 'api', 'worker']);
    expect(rows[1]).toMatchObject({ status: 'online', pm_id: 0, pid: 69265, restarts: 1, cpu: 1.5, memory: 1024 });
    expect(rows[1].ports.checks).toEqual([{ port: 3310, status: 'listening' }]);
    expect(rows[0].ports.actual.map((l) => l.port)).toEqual([3000]);
    expect(rows[2]).toMatchObject({ status: 'not-started', pm_id: null, pid: null, uptime_ms: null });
    expect(ctx.fake.calls).toHaveLength(1);
    expect(ctx.fake.calls[0].cmd).toContain('pm2 jlist');
  });
  it('filters by app and maps jlist exit 127 to PM2_NOT_FOUND', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    expect((await listApps(ctx, 'worker')).map((r) => r.app)).toEqual(['worker']);
    const broken = fakeCtx(basic, 'local', [{ match: MARK.JLIST, result: { stdout: probeOut({ rc: 127 }) } }]);
    await expect(listApps(broken)).rejects.toMatchObject({ code: 'PM2_NOT_FOUND' });
  });
  it('reports TRANSPORT_FAILED when the probe never ran (no marker in the output)', async () => {
    const noShell = fakeCtx(basic, 'local', [{ match: MARK.JLIST, result: { code: 127, stdout: '', stderr: 'sh: 1: /bin/bash: not found' } }]);
    await expect(listApps(noShell)).rejects.toMatchObject({ code: 'TRANSPORT_FAILED', message: expect.stringContaining('/bin/bash: not found') });
  });
});

describe('portsReport', () => {
  it('lists all listeners with app attribution, or the holder of one port', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    const all = await portsReport(ctx);
    expect(all.listeners.find((l) => l.port === 3310)?.app).toBe('api');
    expect(all.listeners.find((l) => l.port === 22)?.app).toBeNull();
    const one = await portsReport(ctx, 3000);
    expect(one.listeners).toHaveLength(1);
    expect(one.listeners[0]).toMatchObject({ port: 3000, pid: 4242, app: 'api-build' });
  });
});

describe('hostsInfo / describe', () => {
  it('hostsInfo lists local first with transport descriptions', () => {
    const ctx = fakeCtx(basic, 'local', []);
    const info = hostsInfo(ctx.manifest);
    expect(info.map((h) => h.name)).toEqual(['local', 'stand', 'prod']);
    expect(info[2]).toMatchObject({ transport: 'ssh prod → docker demo-app (node)', readonly: true, pm2_home: '/home/node/.pm2', runtime: '/home/node/demo/.mcproc/runtime' });
  });
  it('describeApp merges manifest, runtime and generated pm2 config', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    const d = await describeApp(ctx, 'api');
    expect(d.app.description).toContain('HTTP API');
    expect(d.row.status).toBe('online');
    expect(d.logs).toEqual({ out: '/h/api-out.log', err: '/h/api-error.log' });
    expect(d.pm2.args).toEqual(['-lc', 'node dist/apps/api/main.js']);
    expect((await describeApp(ctx, 'worker')).logs).toBeNull();
  });
  it('describeProject summarises apps, profiles, hosts and README', async () => {
    const ctx = fakeCtx(basic, 'local', []);
    const d = describeProject(ctx.manifest);
    expect(d.project).toBe('demo');
    expect(d.apps.map((a) => a.name)).toEqual(['api-build', 'api', 'worker']);
    expect(d.profiles).toEqual({ base: ['api-build', 'api'], all: ['api-build', 'api', 'worker'] });
    expect(d.hosts).toHaveLength(3);
    expect(d.readme).toBeNull();
    expect(ctx.fake.calls).toHaveLength(0);
  });
});

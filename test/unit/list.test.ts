import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { MARK } from '../../src/shell/snippets.js';
import { loadManifest } from '../../src/core/manifest.js';
import { listApps, portsReport, hostsInfo, describeApp, describeProject, snapshot, rowsFor } from '../../src/core/list.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fx = (p: string) => fs.readFileSync(path.join(here, '..', 'fixtures', 'probe', p), 'utf8');
const jlist = JSON.stringify([
  { pid: 69265, name: 'demo-api', pm_id: 0, monit: { cpu: 1.5, memory: 1024 }, pm2_env: { status: 'online', namespace: 'demo', pm_uptime: Date.now() - 5000, restart_time: 1, pm_out_log_path: '/h/api-out.log', pm_err_log_path: '/h/api-error.log' } },
  { pid: 4242, name: 'demo-api-build', pm_id: 1, pm2_env: { status: 'online', namespace: 'demo' } },
]);
const stat = 'CLK 100\n69253 1000 10\n69265 69253 1000\n69300 69265 200\n4242 1000 40\n4243 4242 10\n';
const stat2 = 'CLK 100\n69253 1000 10\n69265 69253 1030\n69300 69265 210\n4242 1000 40\n4243 4242 10\n';
const rss = '69253 2000\n69265 150000\n69300 8000\n4242 1024\n4243 512\n';
const args = '69253 /bin/bash -lc env -u X bun run dev\n69265 /home/u/.bun/bin/bun --watch src/index.ts\n69300 esbuild --service\n4242 /bin/bash -lc tsc -w\n4243 node /x/tsc -w\n';
const probeRule = { match: MARK.JLIST, result: { stdout: probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt'), udp: fx('ss-udp.txt'), stat, stat2, rss, args, urls: 'http://localhost:3310/health\t200\n' }) } };

describe('listApps', () => {
  it('returns one row per manifest app, in manifest order, with tree metrics, ports and not-started apps', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    const rows = await listApps(ctx);
    expect(rows.map((r) => r.app)).toEqual(['api-build', 'api', 'worker']);
    expect(rows[1]).toMatchObject({ status: 'online', pm_id: 0, pid: 69265, restarts: 1, pm2_cpu: 1.5, pm2_memory: 1024, metrics_source: 'tree', procs: 2, runtime: 'bun --watch src/index.ts', url: 'http://localhost:3310/health', url_status: 'ok', url_code: 200 });
    expect(rows[1].memory).toBe((150000 + 8000) * 1024);
    expect(rows[1].cpu).toBeCloseTo(80); // (30 + 10) ticks / 100 / 0.5 s
    expect(rows[1].ports.checks).toEqual([{ port: 3310, status: 'listening' }]);
    expect(rows[0]).toMatchObject({ runtime: 'bash -lc tsc -w', procs: 2 });
    expect(rows[0].ports.actual.map((l) => l.port)).toEqual([3000]);
    expect(rows[2]).toMatchObject({ status: 'not-started', pm_id: null, pid: null, uptime_ms: null, memory: 0, cpu: 0, procs: 0, runtime: null, url: null, url_status: 'unchecked', url_code: null });
    expect(ctx.fake.calls).toHaveLength(1);
    expect(ctx.fake.calls[0].cmd).toContain('sleep 0.5');
    expect(ctx.fake.calls[0].cmd).toContain("'http://localhost:3310/health'");
  });
  it('url_status: ok for 2xx/3xx, error for 4xx/5xx, down for no answer, unchecked without curl/wget or when not asked', async () => {
    const mk = (urls: string) => fakeCtx(basic, 'local', [{ match: MARK.JLIST, result: { stdout: probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt'), urls }) } }]);
    const api = async (urls: string) => (await listApps(mk(urls), 'api'))[0];
    expect(await api('http://localhost:3310/health\t307\n')).toMatchObject({ url_status: 'ok', url_code: 307 });
    expect(await api('http://localhost:3310/health\t401\n')).toMatchObject({ url_status: 'error', url_code: 401 });
    expect(await api('http://localhost:3310/health\t503\n')).toMatchObject({ url_status: 'error', url_code: 503 });
    expect(await api('http://localhost:3310/health\t000\n')).toMatchObject({ url_status: 'down', url_code: null });
    expect(await api('http://localhost:3310/health\t-\n')).toMatchObject({ url_status: 'unchecked', url_code: null });
    const quiet = mk('');
    const snap = await snapshot(quiet, { urls: 'none' });
    expect(quiet.fake.calls[0].cmd).not.toContain('curl');
    expect(rowsFor(quiet, snap, ['api'])[0]).toMatchObject({ url: 'http://localhost:3310/health', url_status: 'unchecked', url_code: null });
  });
  it('falls back to pm2 numbers when the host gives no /proc stats', async () => {
    const ctx = fakeCtx(basic, 'local', [{ match: MARK.JLIST, result: { stdout: probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt') }) } }]);
    const [, api] = await listApps(ctx);
    expect(api).toMatchObject({ metrics_source: 'pm2-root', memory: 1024, cpu: 1.5, procs: null, runtime: null });
  });
  it('snapshot with cpu: none and a previous sample computes cpu over the given interval', async () => {
    const ctx = fakeCtx(basic, 'local', [{ match: MARK.JLIST, result: { stdout: probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt'), stat: stat2, rss, args }) } }]);
    const { parseStat } = await import('../../src/core/stats.js');
    const prev = { sample: parseStat(stat).sample, at: Date.now() - 2000 };
    const snap = await snapshot(ctx, { cpu: 'none', prev });
    expect(ctx.fake.calls[0].cmd).not.toContain('sleep 0.5');
    expect(snap.metrics.api?.cpu).toBeCloseTo(20, 0); // 40 ticks / 100 / ~2 s
    expect(snap.stats.samples).toHaveLength(1);
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
    expect(all.listeners.find((l) => l.port === 22)).toMatchObject({ app: null, container: null });
    const one = await portsReport(ctx, 3000);
    expect(one.listeners).toHaveLength(1);
    expect(one.listeners[0]).toMatchObject({ port: 3000, pid: 4242, app: 'api-build' });
  });
});

describe('hostsInfo / describe', () => {
  it('a host lists the apps bound to it; describeProject names each app\'s host (null = wherever the command points)', () => {
    const m = loadManifest(path.join(here, '..', 'fixtures', 'projects', 'fleet'));
    expect(hostsInfo(m).map((h) => `${h.name}:${h.apps.join(',')}`)).toEqual(['local:watch', 'box:web', 'ro:audit']);
    expect(describeProject(m).apps.map((a) => `${a.name}@${a.host}`)).toEqual(['watch@local', 'web@box', 'tool@null', 'audit@ro']);
  });
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
    expect(d.apps[1]).toMatchObject({ name: 'api', url: 'http://localhost:3310/health' });
    expect(d.profiles).toEqual({ base: ['api-build', 'api'], all: ['api-build', 'api', 'worker'] });
    expect(d.hosts).toHaveLength(3);
    expect(d.readme).toBeNull();
    expect(ctx.fake.calls).toHaveLength(0);
  });
});

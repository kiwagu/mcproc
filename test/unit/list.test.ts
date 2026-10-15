import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { MARK } from '../../src/shell/snippets.js';
import { loadManifest } from '../../src/core/manifest.js';
import type { Context } from '../../src/core/resolve.js';
import type { Attempt, HereCheck } from '../../src/core/urlcheck.js';
import {
  listApps,
  portsReport,
  hostsInfo,
  describeApp,
  describeProject,
  snapshot,
  rowsFor,
  statusWord,
  unreachableRow,
} from '../../src/core/list.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fx = (p: string) =>
  fs.readFileSync(path.join(here, '..', 'fixtures', 'probe', p), 'utf8');
const jlist = JSON.stringify([
  {
    pid: 69265,
    name: 'demo-api',
    pm_id: 0,
    monit: { cpu: 1.5, memory: 1024 },
    pm2_env: {
      status: 'online',
      namespace: 'demo',
      pm_uptime: Date.now() - 5000,
      restart_time: 1,
      pm_out_log_path: '/h/api-out.log',
      pm_err_log_path: '/h/api-error.log',
    },
  },
  {
    pid: 4242,
    name: 'demo-api-build',
    pm_id: 1,
    pm2_env: { status: 'online', namespace: 'demo' },
  },
]);
const stat =
  'CLK 100\n69253 1000 10\n69265 69253 1000\n69300 69265 200\n4242 1000 40\n4243 4242 10\n';
const stat2 =
  'CLK 100\n69253 1000 10\n69265 69253 1030\n69300 69265 210\n4242 1000 40\n4243 4242 10\n';
const rss = '69253 2000\n69265 150000\n69300 8000\n4242 1024\n4243 512\n';
const args =
  '69253 /bin/bash -lc env -u X bun run dev\n69265 /home/u/.bun/bin/bun --watch src/index.ts\n69300 esbuild --service\n4242 /bin/bash -lc tsc -w\n4243 node /x/tsc -w\n';
const probeRule = {
  match: MARK.JLIST,
  result: {
    stdout: probeOut({
      jlist,
      ps: fx('ps.txt'),
      tcp: fx('ss-tcp.txt'),
      udp: fx('ss-udp.txt'),
      stat,
      stat2,
      rss,
      args,
      urls: 'http://localhost:3310/health\t200\n',
    }),
  },
};

describe('listApps', () => {
  it('returns one row per manifest app, in manifest order, with tree metrics, ports and not-started apps', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    const rows = await listApps(ctx);
    expect(rows.map((r) => r.app)).toEqual(['api-build', 'api', 'worker']);
    expect(rows[1]).toMatchObject({
      status: 'online',
      pm_id: 0,
      pid: 69265,
      restarts: 1,
      pm2_cpu: 1.5,
      pm2_memory: 1024,
      metrics_source: 'tree',
      procs: 2,
      runtime: 'bun --watch src/index.ts',
      url: 'http://localhost:3310/health',
      url_status: 'ok',
      url_code: 200,
    });
    expect(rows[1].memory).toBe((150000 + 8000) * 1024);
    expect(rows[1].cpu).toBeCloseTo(80); // (30 + 10) ticks / 100 / 0.5 s
    expect(rows[1].ports.checks).toEqual([{ port: 3310, status: 'listening' }]);
    expect(rows[0]).toMatchObject({ runtime: 'bash -lc tsc -w', procs: 2 });
    expect(rows[0].ports.actual.map((l) => l.port)).toEqual([3000]);
    expect(rows[2]).toMatchObject({
      status: 'not-started',
      pm_id: null,
      pid: null,
      uptime_ms: null,
      memory: 0,
      cpu: 0,
      procs: 0,
      runtime: null,
      url: null,
      url_status: 'unchecked',
      url_code: null,
    });
    expect(ctx.fake.calls).toHaveLength(1);
    expect(ctx.fake.calls[0].cmd).toContain('sleep 0.5');
    expect(ctx.fake.calls[0].cmd).toContain("'http://localhost:3310/health'");
  });
  it('url_status: ok for 2xx/3xx, error for 4xx/5xx, down for no answer, unchecked without curl/wget or when not asked', async () => {
    const mk = (urls: string) =>
      fakeCtx(basic, 'local', [
        {
          match: MARK.JLIST,
          result: {
            stdout: probeOut({
              jlist,
              ps: fx('ps.txt'),
              tcp: fx('ss-tcp.txt'),
              urls,
            }),
          },
        },
      ]);
    const api = async (urls: string) => (await listApps(mk(urls), 'api'))[0];
    expect(await api('http://localhost:3310/health\t307\n')).toMatchObject({
      url_status: 'ok',
      url_code: 307,
    });
    expect(await api('http://localhost:3310/health\t401\n')).toMatchObject({
      url_status: 'error',
      url_code: 401,
    });
    expect(await api('http://localhost:3310/health\t503\n')).toMatchObject({
      url_status: 'error',
      url_code: 503,
    });
    expect(await api('http://localhost:3310/health\t000\n')).toMatchObject({
      url_status: 'down',
      url_code: null,
    });
    expect(await api('http://localhost:3310/health\t-\n')).toMatchObject({
      url_status: 'unchecked',
      url_code: null,
    });
    const quiet = mk('');
    const snap = await snapshot(quiet, { urls: 'none' });
    expect(quiet.fake.calls[0].cmd).not.toContain('curl');
    expect(rowsFor(quiet, snap, ['api'])[0]).toMatchObject({
      url: 'http://localhost:3310/health',
      url_status: 'unchecked',
      url_code: null,
    });
  });
  it('falls back to pm2 numbers when the host gives no /proc stats', async () => {
    const ctx = fakeCtx(basic, 'local', [
      {
        match: MARK.JLIST,
        result: {
          stdout: probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt') }),
        },
      },
    ]);
    const [, api] = await listApps(ctx);
    expect(api).toMatchObject({
      metrics_source: 'pm2-root',
      memory: 1024,
      cpu: 1.5,
      procs: null,
      runtime: null,
    });
  });
  it('snapshot with cpu: none and a previous sample computes cpu over the given interval', async () => {
    const ctx = fakeCtx(basic, 'local', [
      {
        match: MARK.JLIST,
        result: {
          stdout: probeOut({
            jlist,
            ps: fx('ps.txt'),
            tcp: fx('ss-tcp.txt'),
            stat: stat2,
            rss,
            args,
          }),
        },
      },
    ]);
    const { parseStat } = await import('../../src/core/stats.js');
    const prev = { sample: parseStat(stat).sample, at: Date.now() - 2000 };
    const snap = await snapshot(ctx, { cpu: 'none', prev });
    expect(ctx.fake.calls[0].cmd).not.toContain('sleep 0.5');
    expect(snap.metrics.api?.cpu).toBeCloseTo(20, 0); // 40 ticks / 100 / ~2 s
    expect(snap.stats.samples).toHaveLength(1);
  });
  it('snapshot with metrics none asks for the light probe and still joins ports', async () => {
    const ctx = fakeCtx(basic, 'local', [
      {
        match: MARK.JLIST,
        result: {
          stdout: probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt') }),
        },
      },
    ]);
    const snap = await snapshot(ctx, {
      cpu: 'none',
      urls: 'none',
      metrics: 'none',
    });
    expect(ctx.fake.calls[0].cmd).not.toContain('/proc/[0-9]*/stat');
    expect(snap.ports.api.checks[0]).toEqual({
      port: 3310,
      status: 'listening',
    });
    expect(snap.metrics.api).toBeNull();
  });
  it('filters by app and maps jlist exit 127 to PM2_NOT_FOUND', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    expect((await listApps(ctx, 'worker')).map((r) => r.app)).toEqual([
      'worker',
    ]);
    const broken = fakeCtx(basic, 'local', [
      { match: MARK.JLIST, result: { stdout: probeOut({ rc: 127 }) } },
    ]);
    await expect(listApps(broken)).rejects.toMatchObject({
      code: 'PM2_NOT_FOUND',
    });
  });
  it('reports TRANSPORT_FAILED when the probe never ran (no marker in the output)', async () => {
    const noShell = fakeCtx(basic, 'local', [
      {
        match: MARK.JLIST,
        result: {
          code: 127,
          stdout: '',
          stderr: 'sh: 1: /bin/bash: not found',
        },
      },
    ]);
    await expect(listApps(noShell)).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
      message: expect.stringContaining('/bin/bash: not found'),
    });
  });
});

describe('portsReport', () => {
  it('lists all listeners with app attribution, or the holder of one port', async () => {
    const ctx = fakeCtx(basic, 'local', [probeRule]);
    const all = await portsReport(ctx);
    expect(all.listeners.find((l) => l.port === 3310)?.app).toBe('api');
    expect(all.listeners.find((l) => l.port === 22)?.app).toBeNull();
    expect(all.listeners.find((l) => l.port === 22)).toMatchObject({
      app: null,
      container: null,
    });
    const one = await portsReport(ctx, 3000);
    expect(one.listeners).toHaveLength(1);
    expect(one.listeners[0]).toMatchObject({
      port: 3000,
      pid: 4242,
      app: 'api-build',
    });
  });
});

describe('hostsInfo / describe', () => {
  it("a host lists the apps bound to it; describeProject names each app's host (null = wherever the command points)", () => {
    const m = loadManifest(
      path.join(here, '..', 'fixtures', 'projects', 'fleet')
    );
    expect(hostsInfo(m).map((h) => `${h.name}:${h.apps.join(',')}`)).toEqual([
      'local:watch',
      'box:web',
      'ro:audit',
    ]);
    expect(describeProject(m).apps.map((a) => `${a.name}@${a.host}`)).toEqual([
      'watch@local',
      'web@box',
      'tool@null',
      'audit@ro',
    ]);
  });
  it('hostsInfo lists local first with transport descriptions', () => {
    const ctx = fakeCtx(basic, 'local', []);
    const info = hostsInfo(ctx.manifest);
    expect(info.map((h) => h.name)).toEqual(['local', 'stand', 'prod']);
    expect(info[2]).toMatchObject({
      transport: 'ssh prod → docker demo-app (node)',
      readonly: true,
      pm2_home: '/home/node/.pm2',
      runtime: '/home/node/demo/.mcproc/runtime',
    });
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
    expect(d.apps[1]).toMatchObject({
      name: 'api',
      url: 'http://localhost:3310/health',
    });
    expect(d.profiles).toEqual({
      base: ['api-build', 'api'],
      all: ['api-build', 'api', 'worker'],
    });
    expect(d.hosts).toHaveLength(3);
    expect(d.readme).toBeNull();
    expect(ctx.fake.calls).toHaveLength(0);
  });
  it('describeProject reports each dependency with its condition and timeout in seconds', () => {
    const m = loadManifest(
      path.join(here, '..', 'fixtures', 'projects', 'readiness')
    );
    const web = describeProject(m).apps.find((a) => a.name === 'web')!;
    expect(web.depends_on).toEqual([
      { app: 'api', condition: 'ready', timeout_s: 90 },
      { app: 'logger', condition: 'started', timeout_s: 60 },
    ]);
  });
});

describe('started', () => {
  const at = Date.UTC(2026, 9, 14, 7, 30);
  const proc = (name: string, status: string, env: object = {}) => ({
    pid: status === 'online' ? 4000 : 0,
    name,
    pm_id: 0,
    pm2_env: { status, namespace: 'demo', ...env },
  });
  const rowsOf = async (procs: object[], clock: string) => {
    const ctx = fakeCtx(basic, 'local', [
      {
        match: MARK.JLIST,
        result: { stdout: probeOut({ jlist: JSON.stringify(procs), clock }) },
      },
    ]);
    const snap = await snapshot(ctx);
    return { snap, rows: rowsFor(ctx, snap, ['api', 'api-build', 'worker']) };
  };
  it("is pm2's start of the process in the host's own zone, whatever the zone of the machine running mcproc", async () => {
    const procs = [
      proc('demo-api', 'online', { pm_uptime: at }),
      proc('demo-api-build', 'stopped', { pm_uptime: at + 1500 }),
    ];
    const utc = await rowsOf(procs, '+0000');
    expect(utc.snap.zone).toBe('+0000');
    expect(utc.rows.map((r) => r.started)).toEqual([
      '2026-10-14T07:30:00.000',
      '2026-10-14T07:30:01.500', // a stopped process keeps its last start
      null, // no process
    ]);
    expect((await rowsOf(procs, '+0200')).rows[0].started).toBe(
      '2026-10-14T09:30:00.000'
    );
  });
  it('is null without the host zone, without a start time, and on a row whose host did not answer', async () => {
    const noZone = await rowsOf(
      [proc('demo-api', 'online', { pm_uptime: at })],
      ''
    );
    expect(noZone.snap.zone).toBeNull();
    expect(noZone.rows[0].started).toBeNull();
    const noStart = await rowsOf([proc('demo-api', 'online')], '+0000');
    expect(noStart.rows[0].started).toBeNull();
    const m = loadManifest(basic);
    expect(unreachableRow(m.apps.api, 'local', 'down').started).toBeNull();
  });
});

describe('statusWord', () => {
  const m = loadManifest(
    path.join(here, '..', 'fixtures', 'projects', 'readiness')
  );
  const proc = (status: string, exit_code: number | null) =>
    ({
      status,
      exit_code,
    }) as unknown as import('../../src/core/pm2.js').Pm2Process;
  it('a task that exited reads done / failed (exit N) / stopped by its exit code', () => {
    expect(statusWord(proc('stopped', 0), m.apps.libs)).toBe('done');
    expect(statusWord(proc('stopped', 2), m.apps.libs)).toBe('failed (exit 2)');
    expect(statusWord(proc('stopped', 1), m.apps.libs)).toBe('failed (exit 1)');
    expect(statusWord(proc('stopped', null), m.apps.libs)).toBe('stopped');
    expect(statusWord(proc('stopped', 130), m.apps.libs)).toBe('stopped');
    expect(statusWord(proc('stopped', 143), m.apps.libs)).toBe('stopped');
  });
  it('a server keeps pm2 words whatever the exit code; online and errored pass through', () => {
    expect(statusWord(proc('stopped', 0), m.apps.api)).toBe('stopped');
    expect(statusWord(proc('stopped', 2), m.apps.api)).toBe('stopped');
    expect(statusWord(proc('online', null), m.apps.libs)).toBe('online');
    expect(statusWord(proc('errored', 1), m.apps.libs)).toBe('errored');
    expect(statusWord(undefined, m.apps.libs)).toBe('not-started');
  });
  it('rowsFor shows the word and the exit code', async () => {
    const list = JSON.stringify([
      {
        pid: 0,
        name: 'ready-libs',
        pm_id: 0,
        pm2_env: { status: 'stopped', namespace: 'ready', exit_code: 0 },
      },
    ]);
    const ctx = fakeCtx(
      path.join(here, '..', 'fixtures', 'projects', 'readiness'),
      'local',
      [{ match: MARK.JLIST, result: { stdout: probeOut({ jlist: list }) } }]
    );
    const rows = await listApps(ctx, 'libs');
    expect(rows[0]).toMatchObject({
      status: 'done',
      exit_code: 0,
      uptime_ms: null,
    });
  });
});

describe('url checks: on the host first, then from this machine (url_check)', () => {
  const URL = 'http://localhost:3310/health';
  // `check` is the check from this machine; omitted, fakeCtx's default fails the test when it is called
  const on = (host: string, line: string, check?: HereCheck, env?: string) =>
    fakeCtx(
      basic,
      host,
      [
        {
          match: MARK.JLIST,
          result: {
            stdout: probeOut({
              jlist,
              ps: fx('ps.txt'),
              tcp: fx('ss-tcp.txt'),
              urls: line,
              env,
            }),
          },
        },
      ],
      host,
      check
    );
  const recorder = (answer: Attempt) => {
    const asked: string[] = [];
    const here: HereCheck = async (u) => {
      asked.push(u);
      return answer;
    };
    return { asked, here };
  };
  const api = async (ctx: Context) => (await listApps(ctx, 'api'))[0];

  it('a url the host answers costs one request there and none from here', async () => {
    const r = recorder({ answered: true, code: 200 });
    const ctx = on('stand', `${URL}\t200\t0\t::1\n`, r.here);
    expect(await api(ctx)).toMatchObject({
      url_status: 'ok',
      url_code: 200,
      url_from: 'host',
      url_reason: null,
    });
    expect(r.asked).toEqual([]);
    expect(ctx.fake.calls).toHaveLength(1);
    expect(
      ctx.fake.calls[0].cmd.split(`-w '%{http_code}' '${URL}'`)
    ).toHaveLength(2); // requested once on the host
  });
  it('no answer on the host: checked from here, and the row says why the host could not', async () => {
    const r = recorder({ answered: true, code: 200 });
    expect(
      await api(on('stand', `${URL}\t000\t7\t::1\n`, r.here))
    ).toMatchObject({
      url_status: 'ok',
      url_code: 200,
      url_from: 'here',
      url_reason: 'on stand: refused',
    });
    expect(r.asked).toEqual([URL]);
  });
  it('neither answers: down, from here, with both reasons', async () => {
    const r = recorder({ answered: false, fail: 'refused' });
    expect(
      await api(on('stand', `${URL}\t000\t7\t::1\n`, r.here))
    ).toMatchObject({
      url_status: 'down',
      url_code: null,
      url_from: 'here',
      url_reason: 'on stand: refused; here: refused',
    });
  });
  it('url_check: host never asks from here', async () => {
    const ctx = on('stand', `${URL}\t000\t7\t::1\n`); // the default check from here fails the test if called
    ctx.manifest.apps.api = { ...ctx.manifest.apps.api, url_check: 'host' };
    expect(await api(ctx)).toMatchObject({
      url_status: 'down',
      url_from: 'host',
      url_reason: 'on stand: refused',
    });
  });
  it('url_check: here: the host never requests it, and prints no environment for it', async () => {
    const r = recorder({ answered: true, code: 200 });
    const ctx = on('stand', '', r.here);
    ctx.manifest.apps.api = { ...ctx.manifest.apps.api, url_check: 'here' };
    expect(await api(ctx)).toMatchObject({
      url_status: 'ok',
      url_from: 'here',
      url_reason: 'url_check: here',
    });
    expect(ctx.fake.calls[0].cmd).not.toContain(URL);
    expect(ctx.fake.calls[0].cmd).not.toContain(MARK.ENV);
    expect(r.asked).toEqual([URL]);
  });
  it('a name that resolves to the host itself is named as such: by a loopback address, or by one the environment calls its own', async () => {
    const r = recorder({ answered: true, code: 200 });
    const env =
      'container docker\nhostname ws-01\nself 172.17.0.2 127.0.0.1 ::1';
    const site = async (addr: string) => {
      const ctx = on(
        'stand',
        `https://site.test/\t000\t7\t${addr}\n`,
        r.here,
        env
      );
      ctx.manifest.apps.api = {
        ...ctx.manifest.apps.api,
        url: 'https://site.test/',
      };
      return api(ctx);
    };
    expect(await site('127.0.1.1')).toMatchObject({
      url_status: 'ok',
      url_from: 'here',
      url_reason: 'on stand site.test resolves to 127.0.1.1, the host itself',
    });
    // only the host's environment section says 172.17.0.2 is the host's own address
    expect(await site('172.17.0.2')).toMatchObject({
      url_status: 'ok',
      url_from: 'here',
      url_reason: 'on stand site.test resolves to 172.17.0.2, the host itself',
    });
    expect(r.asked).toEqual(['https://site.test/', 'https://site.test/']);
  });
  it('on local nothing is ever checked twice, whatever url_check says', async () => {
    const ctx = on('local', `${URL}\t000\t7\t127.0.0.1\n`); // the default check from here fails the test if called
    ctx.manifest.apps.api = { ...ctx.manifest.apps.api, url_check: 'here' };
    expect(await api(ctx)).toMatchObject({
      url_status: 'down',
      url_from: 'host',
      url_reason: 'on local: refused',
    });
    expect(ctx.fake.calls[0].cmd).toContain(`'${URL}'`);
  });
  it('two apps sharing a url: one request on the host, one from here, a row each', async () => {
    const r = recorder({ answered: true, code: 204 });
    const ctx = on('stand', `${URL}\t000\t7\t::1\n`, r.here);
    ctx.manifest.apps['api-build'] = {
      ...ctx.manifest.apps['api-build'],
      url: URL,
    };
    const rows = await listApps(ctx);
    expect(rows.filter((x) => x.url_from === 'here').map((x) => x.app)).toEqual(
      ['api-build', 'api']
    );
    expect(r.asked).toEqual([URL]);
    expect(
      ctx.fake.calls[0].cmd.split(`-w '%{http_code}' '${URL}'`)
    ).toHaveLength(2);
  });
  it('urls not asked: unchecked, nothing requested anywhere; an unreachable row carries no url facts', async () => {
    const ctx = on('stand', '');
    const snap = await snapshot(ctx, { urls: 'none' });
    expect(snap.urlChecks).toEqual({});
    expect(ctx.fake.calls[0].cmd).not.toContain(URL);
    expect(rowsFor(ctx, snap, ['api'])[0]).toMatchObject({
      url_status: 'unchecked',
      url_from: null,
      url_reason: null,
    });
    expect(unreachableRow(ctx.manifest.apps.api, 'stand', 'x')).toMatchObject({
      url_status: 'unchecked',
      url_from: null,
      url_reason: null,
    });
  });
  it('ports asks no url, on the host or from here, and keeps the full probe', async () => {
    const ctx = on('stand', `${URL}\t000\t7\t::1\n`); // the default check from here fails the test if called
    await portsReport(ctx);
    expect(ctx.fake.calls).toHaveLength(1);
    expect(ctx.fake.calls[0].cmd).not.toContain(URL);
    expect(ctx.fake.calls[0].cmd).not.toContain(MARK.ENV);
    expect(ctx.fake.calls[0].cmd).toContain('docker ps'); // the CONTAINER column
  });
  it('a read of one app asks only its url; a read of all asks every url', async () => {
    const OTHER = 'http://localhost:3000/';
    const ctx = on('local', `${URL}\t200\t0\t127.0.0.1\n`);
    ctx.manifest.apps['api-build'] = {
      ...ctx.manifest.apps['api-build'],
      url: OTHER,
    };
    await listApps(ctx, 'api');
    await describeApp(ctx, 'api');
    expect(ctx.fake.calls).toHaveLength(2);
    for (const c of ctx.fake.calls) {
      expect(c.cmd).toContain(`'${URL}'`);
      expect(c.cmd).not.toContain(OTHER);
    }
    await listApps(ctx);
    expect(ctx.fake.calls[2].cmd).toContain(`'${URL}'`);
    expect(ctx.fake.calls[2].cmd).toContain(`'${OTHER}'`);
  });
  it('an app named constructor keeps its url fields when its url was not asked', async () => {
    const ctx = on('stand', '');
    const name = 'constructor';
    ctx.manifest.apps[name] = { ...ctx.manifest.apps.api, name };
    const snap = await snapshot(ctx, { urls: 'none' });
    expect(rowsFor(ctx, snap, [name])[0]).toMatchObject({
      url_status: 'unchecked',
      url_code: null,
      url_from: null,
      url_reason: null,
    });
  });
  it('a check from here that rejects reads as no answer for its url, and the snapshot still answers', async () => {
    const ctx = on('stand', `${URL}\t000\t7\t::1\n`, async () => {
      throw new Error('socket exploded');
    });
    expect(await api(ctx)).toMatchObject({
      url_status: 'down',
      url_code: null,
      url_from: 'here',
      url_reason: 'on stand: refused; here: no answer',
    });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { FakeTransport, type Rule } from '../helpers/fake-transport.js';
import { procWorld, type FakeWorld } from '../helpers/procfs.js';
import { Pm2Client } from '../../src/core/pm2.js';
import { ProcReader } from '../../src/core/procfs.js';
import {
  DOCKER_EVERY_MS,
  clearLocalScanCache,
  inProcess,
  listenLocal,
  probeLocal,
  type LocalLink,
} from '../../src/core/localscan.js';
import type { ProbeAsk } from '../../src/core/list.js';
import { MARK } from '../../src/shell/snippets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
/** demo-api runs as sh 200 → node 201, which listens on 3310; 5432 is held by another user's process */
const API = {
  pid: 200,
  name: 'demo-api',
  pm_id: 0,
  pm2_env: { status: 'online', namespace: 'demo', pm_uptime: 1000 },
};
const WORLD: FakeWorld = {
  procs: [
    { pid: 1, ppid: 0, comm: 'systemd' },
    {
      pid: 200,
      ppid: 1,
      comm: 'sh',
      rss: 500,
      cmdline: 'sh -c node main.js',
      ticks: 3,
    },
    {
      pid: 201,
      ppid: 200,
      comm: 'node-MainThread',
      rss: 25_000,
      cmdline: 'node main.js',
      ticks: 120,
      sockets: [5001],
    },
    { pid: 300, ppid: 1, comm: 'docker-proxy', foreign: true },
  ],
  tcp: [
    { port: 3310, inode: 5001 },
    { port: 5432, inode: 6001 },
  ],
};
const QUIET: ProbeAsk = {
  cpuSample: false,
  metrics: true,
  urls: [],
  containers: [],
};
const DOCKER_OUT = `${MARK.DOCKER}\ndemo-db\t0.0.0.0:5432->5432/tcp\n`;

/** A link to "this machine": the fake world's /proc, its pm2 list from a socket, its host reads from `rules`. */
function local(
  rules: Rule[] = [],
  world: FakeWorld = WORLD,
  transport?: FakeTransport
) {
  const ctx = fakeCtx(basic, 'local', rules);
  const t = transport ?? ctx.fake;
  const fs = procWorld(world);
  const link: LocalLink = {
    ...ctx,
    transport: t,
    pm2: new Pm2Client(t, ctx.host, 'pm2', '/h/.pm2', async () => [API]),
    proc: new ProcReader(fs, () => 1_000_000, { clkTck: 100, pageSize: 4096 }),
  };
  return { link, fake: t as FakeTransport, fs };
}
beforeEach(() => clearLocalScanCache());

describe('probeLocal', () => {
  it('a probe without urls or containers runs nothing on the host: the list from the socket, the rest from /proc', async () => {
    const { link, fake } = local();
    const p = (await probeLocal(link, QUIET))!;
    expect(fake.calls).toEqual([]);
    expect(p.procs.map((x) => x.name)).toEqual(['demo-api']);
    expect(p.data.tree.get(201)).toBe(200);
    expect(p.data.listeners.find((l) => l.port === 3310)).toMatchObject({
      pid: 201,
      command: 'node-MainThread',
    });
    expect(p.data.stats.rssKb.get(201)).toBe(100_000);
    expect(p.data.stats.args.get(201)).toBe('node main.js');
    expect(p.data.stats.samples).toHaveLength(1);
    expect(p.data.stats.clkTck).toBe(100);
    expect(p.data.zone).toMatch(/^[+-]\d{4}$/);
    expect(p.data.memory).toEqual({ total_mib: 7812, available_mib: 3906 });
    expect(p.sampledAt).toBe(1_000_000);
  });
  it('the light probe: no samples, so no tree metrics, and the listeners still', async () => {
    const { link } = local();
    const p = (await probeLocal(link, { ...QUIET, metrics: false }))!;
    expect(p.data.stats.samples).toEqual([]);
    expect(p.data.stats.rssKb.size).toBe(0);
    expect(p.data.listeners[0].pid).toBe(201);
  });
  it('an inline CPU reading: two sweeps of its own, half a second apart', async () => {
    const { link, fs } = local();
    const p = (await probeLocal(link, { ...QUIET, cpuSample: true }))!;
    expect(p.data.stats.samples).toHaveLength(2);
    expect(fs.asked.filter((x) => x === '/proc').length).toBe(2);
  });
  it('a sweep this refresh already took is used as it is', async () => {
    const { link, fs } = local();
    const sweep = link.proc.sweep();
    fs.asked.length = 0;
    const p = (await probeLocal(link, QUIET, sweep))!;
    expect(fs.asked).not.toContain('/proc');
    expect(p.data.tree).toBe(sweep.tree);
  });
  it('urls: the url section alone, in one plain read, and its answers', async () => {
    const { link, fake } = local([
      {
        match: MARK.URL,
        result: {
          stdout: `${MARK.URL}\nhttp://localhost:3310/health\t200\t0\t127.0.0.1\n`,
        },
      },
    ]);
    const p = (await probeLocal(link, {
      ...QUIET,
      urls: ['http://localhost:3310/health'],
    }))!;
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].read).toBe(true);
    expect(fake.calls[0].cmd).not.toContain(MARK.PS);
    expect(p.data.urls.get('http://localhost:3310/health')).toEqual({
      code: 200,
      exit: '0',
      addr: '127.0.0.1',
    });
  });
  it('a url section the shell did not run: TRANSPORT_FAILED', async () => {
    const { link } = local([
      {
        match: MARK.URL,
        result: { code: 2, stdout: '', stderr: 'sh: 1: syntax error' },
      },
    ]);
    await expect(
      probeLocal(link, { ...QUIET, urls: ['http://localhost:3310/health'] })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
  it('declared containers: their memory and the published ports, from one docker read', async () => {
    const { link, fake } = local([
      {
        match: MARK.DOCKER,
        result: {
          stdout: `${DOCKER_OUT}${MARK.DOCKERMEM}\ndemo-db\t27.06MiB / 31.09GiB\n`,
        },
      },
    ]);
    const p = (await probeLocal(link, { ...QUIET, containers: ['demo-db'] }))!;
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].cmd).toContain(MARK.DOCKERMEM);
    expect(p.data.containers.get('demo-db')).toBe(28);
    expect(p.data.listeners.find((l) => l.port === 5432)?.container).toBe(
      'demo-db'
    );
  });
  it('a declared port held without a pid asks docker for the published ports, at most every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { link, fake } = local([
        { match: MARK.DOCKER, result: { stdout: DOCKER_OUT } },
      ]);
      const ask = { ...QUIET, holders: [5432] };
      const p = (await probeLocal(link, ask))!;
      expect(p.data.listeners.find((l) => l.port === 5432)?.container).toBe(
        'demo-db'
      );
      await probeLocal(link, ask);
      expect(fake.calls).toHaveLength(1);
      vi.setSystemTime(Date.now() + DOCKER_EVERY_MS);
      await probeLocal(link, ask);
      expect(fake.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('every declared port held by the trees: docker is not asked', async () => {
    const { link, fake } = local();
    await probeLocal(link, { ...QUIET, holders: [3310] });
    expect(fake.calls).toEqual([]);
  });
  it('every port (ports): docker each time a listener has no pid', async () => {
    const { link, fake } = local([
      { match: MARK.DOCKER, result: { stdout: DOCKER_OUT } },
    ]);
    await probeLocal(link, { ...QUIET, holders: 'all' });
    await probeLocal(link, { ...QUIET, holders: 'all' });
    expect(fake.calls).toHaveLength(2);
  });
  it("the zone follows the login environment's TZ", async () => {
    class TzTransport extends FakeTransport {
      override async loginEnv() {
        return { TZ: 'Asia/Kolkata', HOME: '/h' };
      }
    }
    const { link } = local([], WORLD, new TzTransport([], 'local'));
    expect((await probeLocal(link, QUIET))!.data.zone).toBe('+0530');
  });
  it('/proc that cannot be read: null, so the caller runs the script', async () => {
    const { link } = local([], { ...WORLD, noNet: true });
    expect(await probeLocal(link, QUIET)).toBeNull();
  });
});

describe('listenLocal', () => {
  it('the ports /proc/net lists and the list from the socket: no fd read, nothing run', async () => {
    const { link, fake, fs } = local();
    const c = (await listenLocal(link))!;
    expect([...c.ports].sort((a, b) => a - b)).toEqual([3310, 5432]);
    expect(c.procs.map((p) => p.name)).toEqual(['demo-api']);
    expect(fake.calls).toEqual([]);
    expect(fs.asked.some((p) => p.includes('/fd'))).toBe(false);
  });
  it('no /proc/net: null', async () => {
    const { link } = local([], { ...WORLD, noNet: true });
    expect(await listenLocal(link)).toBeNull();
  });
});

describe('inProcess', () => {
  it('a link to this machine with a reader; never one without, never another host', () => {
    const { link } = local();
    expect(inProcess(link)).toBe(true);
    expect(inProcess({ ...link, proc: null })).toBe(false);
    expect(inProcess({ ...link, host: { ...link.host, local: false } })).toBe(
      false
    );
  });
});

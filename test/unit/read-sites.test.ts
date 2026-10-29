import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { FakeTransport } from '../helpers/fake-transport.js';
import { fakeHosts, proc, S } from '../helpers/incidents.js';
import { MARK } from '../../src/shell/snippets.js';
import { snapshot } from '../../src/core/list.js';
import { resolvePm2Bin } from '../../src/core/pm2.js';
import { prepare } from '../../src/core/resolve.js';
import { readLogs, flushLogs } from '../../src/core/logs.js';
import { LogFollower } from '../../src/core/logfollow.js';
import { readSince, parseSince } from '../../src/core/logsince.js';
import { pollIncidents } from '../../src/core/incidents/poll.js';
import { listFleet } from '../../src/core/fleet.js';
import { countReloads } from '../../src/core/reloadcount.js';
import { readHostMemory } from '../../src/core/memory.js';
import { shipEcosystem } from '../../src/core/actions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readiness = path.join(here, '..', 'fixtures', 'projects', 'readiness');
/** Of the calls whose command matches: whether each was a read. */
const reads = (calls: { cmd: string; read?: boolean }[], match: RegExp) =>
  calls.filter((c) => match.test(c.cmd)).map((c) => Boolean(c.read));
const api = {
  pid: 100,
  name: 'ready-api',
  pm_id: 1,
  pm2_env: {
    status: 'online',
    namespace: 'ready',
    pm_out_log_path: '/l/o',
    pm_err_log_path: '/l/e',
  },
};

describe('reads run through Transport.read', () => {
  it('the probe, pm2 jlist and pm2 -v', async () => {
    const ctx = fakeCtx(readiness, 'local', [
      { match: MARK.JLIST, result: { stdout: probeOut({}) } },
      { match: /pm2 'jlist'/, result: { stdout: '[]' } },
      { match: /pm2 '-v'/, result: { stdout: '7.0.4\n' } },
    ]);
    await snapshot(ctx, { urls: 'none', leases: 'none' });
    await ctx.pm2.jlist();
    await ctx.pm2.version();
    expect(reads(ctx.fake.calls, /./)).toEqual([true, true, true]);
  });
  it('the pm2 resolution probe', async () => {
    const { host } = prepare({ project: readiness });
    const fake = new FakeTransport([
      { match: 'PATH_OK', result: { stdout: 'PATH_OK\n7.0.4\n\nv22.1.0\n' } },
    ]);
    await resolvePm2Bin(host, fake);
    expect(reads(fake.calls, /PATH_OK/)).toEqual([true]);
  });
  it('the log tail', async () => {
    const ctx = fakeCtx(readiness, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: JSON.stringify([api]) } },
      { match: 'tail -n', result: { stdout: '' } },
    ]);
    await readLogs(ctx, 'api');
    expect(reads(ctx.fake.calls, /tail -n/)).toEqual([true]);
  });
  it("a remote host's follower", async () => {
    const ctx = fakeCtx(readiness, 'local', [
      {
        match: '__MCPROC_LF_out__',
        result: {
          stdout: '__MCPROC_LF_out__\n0 0 N\n__MCPROC_LF_err__\n0 0 N\n',
        },
      },
    ]);
    await new LogFollower(ctx, { out: '/l/o', err: '/l/e' }, 0).poll(); // inProcess false: the shell reader
    expect(reads(ctx.fake.calls, /__MCPROC_LF_out__/)).toEqual([true]);
  });
  it('logs since, incidents and reload counts', async () => {
    const h = fakeHosts({
      files: { '/l/watch-out': `${S(1)}a\n`, '/l/web-out': `${S(2)}b\n` },
      // web counts reloads (the fleet fixture sets `reloads` on it) once pm2 says when it started it
      procs: {
        local: [proc('watch', 0)],
        box: [
          proc('web', 3, { pm_uptime: Date.parse('2026-10-12T11:00:00Z') }),
        ],
      },
      now: '2026-10-12T11:00:59',
      zone: '+0000',
    });
    await readSince(h.fleet, ['watch', 'web'], { since: parseSince('5m') });
    await pollIncidents(h.fleet, ['watch', 'web']);
    const listed = await listFleet(h.fleet, h.fleet.select(['all']));
    await countReloads(h.fleet, listed.probes, listed.rows);
    const all = h.transports.flatMap((t) => t.calls);
    const inc = reads(all, /__MCPROC_INC_/);
    expect(inc.length).toBeGreaterThan(0);
    expect(inc.every(Boolean)).toBe(true);
    expect(reads(all, /__MCPROC_JLIST__/).every(Boolean)).toBe(true);
    expect(reads(all, /__MCPROC_RL_UNREAD_END__/)).toEqual([true]); // the reload count's own read, on box
  });
  it("the host's memory", async () => {
    const { host } = prepare({ project: readiness });
    const fake = new FakeTransport([
      {
        match: MARK.MEM,
        result: {
          stdout: `${MARK.MEM}\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n`,
        },
      },
    ]);
    await readHostMemory(fake, host);
    expect(reads(fake.calls, new RegExp(MARK.MEM))).toEqual([true]);
  });
});

describe('mutations keep the host shell', () => {
  it('start, stop, delete, the ecosystem write and flush', async () => {
    const ctx = fakeCtx(readiness, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: JSON.stringify([api]) } },
      { match: /./, result: { stdout: '0\nok\n0\nok\n' } },
    ]);
    await shipEcosystem(ctx);
    await ctx.pm2.startOrRestart('/f.json', 'ready-api');
    await ctx.pm2.stop(1);
    await ctx.pm2.delete(1);
    await flushLogs(ctx, 'api');
    const mutations = reads(
      ctx.fake.calls,
      /cat >|'startOrRestart'|'stop'|'delete'|: >/
    );
    expect(mutations).toHaveLength(5);
    expect(mutations.every((r) => r === false)).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../src/core/manifest.js';
import {
  Fleet,
  actOn,
  listFleet,
  describeFleetApp,
  type Connector,
} from '../../src/core/fleet.js';
import { stopStack } from '../../src/core/stacks/stop.js';
import { describeProject } from '../../src/core/list.js';
import { renderMutation } from '../../src/mcp/render.js';
import { listWithReloads } from '../../src/core/reloadcount.js';
import { McprocError } from '../../src/core/errors.js';
import type { WaitRecord } from '../../src/core/actions.js';
import type { Context } from '../../src/core/resolve.js';
import { MARK } from '../../src/shell/snippets.js';
import {
  LeaseStore,
  pidAlive,
  type NewLease,
} from '../../src/core/leases/store.js';
import type { GateDeps } from '../../src/core/leases/gate.js';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
const m = loadManifest(dir);
const never = async (): Promise<Context> => {
  throw new Error('must not connect');
};

describe('Fleet: where each app runs', () => {
  it('without --host every app runs at its own host; unbound apps on local', () => {
    const f = new Fleet(m, undefined, never);
    expect(['watch', 'web', 'tool', 'audit'].map((a) => f.hostOf(a))).toEqual([
      'local',
      'box',
      'local',
      'ro',
    ]);
  });
  it('with --host X unbound apps run on X; bound apps stay where they are bound', () => {
    const f = new Fleet(m, 'box', never);
    expect(['watch', 'web', 'tool'].map((a) => f.hostOf(a))).toEqual([
      'local',
      'box',
      'box',
    ]);
  });
  it('an unknown --host is refused before anything runs', () => {
    expect(() => new Fleet(m, 'nowhere', never)).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_HOST' })
    );
  });
});

describe('Fleet.select', () => {
  it('without --host: apps, profiles and all, each app once, in target order', () => {
    const f = new Fleet(m, undefined, never);
    expect(f.select(['all'])).toEqual(['watch', 'web', 'tool', 'audit']);
    expect(f.select(['dev', 'watch', 'tool'])).toEqual([
      'watch',
      'web',
      'tool',
    ]);
    expect(() => f.select(['nope'])).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_APP' })
    );
  });
  it('with --host X a profile or all narrows to the apps that run on X', () => {
    const f = new Fleet(m, 'box', never);
    expect(f.select(['all'])).toEqual(['web', 'tool']);
    expect(f.select(['dev'])).toEqual(['web']);
    expect(f.select(['tool'])).toEqual(['tool']);
  });
  it('with --host X an app bound elsewhere is refused by name, with the host it runs on', () => {
    const f = new Fleet(m, 'box', never);
    expect(() => f.select(['watch'])).toThrowError(
      expect.objectContaining({
        code: 'WRONG_HOST',
        message: expect.stringContaining(
          '"watch" runs on host local, not on box'
        ),
      })
    );
  });
  it('with --host X a profile with no app there is refused instead of doing nothing', () => {
    const f = new Fleet(m, 'box', never);
    expect(() => f.select(['builds'])).toThrowError(
      expect.objectContaining({
        code: 'WRONG_HOST',
        message: expect.stringContaining('no app of "builds" runs on host box'),
      })
    );
  });
});

describe('Fleet grouping', () => {
  const f = new Fleet(m, undefined, never);
  it('groups merge every app of a host into one group, in first-appearance order', () => {
    expect(f.groups(['watch', 'web', 'tool'])).toEqual([
      { host: 'local', apps: ['watch', 'tool'] },
      { host: 'box', apps: ['web'] },
    ]);
  });
  it('runs keep the given order: consecutive apps of one host form one run', () => {
    expect(f.runs(['watch', 'web', 'tool'])).toEqual([
      { host: 'local', apps: ['watch'] },
      { host: 'box', apps: ['web'] },
      { host: 'local', apps: ['tool'] },
    ]);
  });
  it('hosts() names the hosts a whole-project command reaches', () => {
    expect(f.hosts()).toEqual(['local', 'box', 'ro']);
    expect(new Fleet(m, 'box', never).hosts()).toEqual(['box']);
  });
});

describe('Fleet.ctx', () => {
  it('connects once per host with the fallback for unbound apps; a failed connect is retried next time', async () => {
    const seen: string[] = [];
    let fail = true;
    const f = new Fleet(m, undefined, async (_m, host, fallback) => {
      seen.push(`${host}/${fallback}`);
      if (host === 'box' && fail) {
        fail = false;
        throw new Error('down');
      }
      return { host: { name: host } } as unknown as Context;
    });
    await f.ctx('local');
    await f.ctx('local');
    await expect(f.ctx('box')).rejects.toThrow('down');
    expect((await f.ctx('box')).host.name).toBe('box');
    expect(seen).toEqual(['local/local', 'box/local', 'box/local']);
  });
});

const proc = (app: string, pm_id: number, cwd: string) => ({
  pid: 100 + pm_id,
  name: `fleet-${app}`,
  pm_id,
  pm2_env: {
    status: 'online',
    namespace: 'fleet',
    pm_cwd: cwd,
    pm_out_log_path: `/l/${app}-out`,
    pm_err_log_path: `/l/${app}-err`,
  },
});
/** A fleet whose hosts are fake transports; `log` records every command as "<host>: <cmd>", across hosts, in order. */
function fakeFleet(
  requested: string | undefined,
  procs: Record<string, object[]>,
  down: string[] = []
) {
  const log: string[] = [];
  const connected: string[] = [];
  const ctxs: Record<string, ReturnType<typeof fakeCtx>> = {};
  const connector: Connector = async (_m, host, fallback) => {
    connected.push(host);
    if (down.includes(host))
      throw new McprocError(
        'TRANSPORT_FAILED',
        `ssh ${host}: Connection refused`
      );
    const list = JSON.stringify(procs[host] ?? []);
    const rec = (stdout: string) => (cmd: string) => {
      log.push(`${host}: ${cmd}`);
      return { stdout };
    };
    ctxs[host] = fakeCtx(
      dir,
      host,
      [
        { match: MARK.JLIST, result: rec(probeOut({ jlist: list })) },
        { match: /pm2 'jlist'/, result: rec(list) },
        { match: /cat >|startOrRestart|'stop'|'delete'/, result: rec('') },
      ],
      fallback
    );
    return ctxs[host];
  };
  const fleet = new Fleet(m, requested, connector);
  const starts = () =>
    log
      .filter((l) => l.includes('startOrRestart'))
      .map((l) => `${l.split(':')[0]} ${/--only' '([^']+)'/.exec(l)![1]}`);
  return { fleet, connector, log, connected, ctxs, starts };
}

describe('actOn: changes reach each app at its host', () => {
  it('start of a profile ships each host only its own apps and starts them there', async () => {
    const h = fakeFleet(undefined, {});
    const rows = await actOn(h.fleet, 'dev', 'start');
    expect(h.starts()).toEqual(['local fleet-watch', 'box fleet-web']);
    const shipped = (host: string) =>
      JSON.parse(
        String(
          h.ctxs[host].fake.calls.find((c) => c.cmd.includes('cat >'))!.opts
            .stdin
        )
      ).apps.map((a: { name: string }) => a.name);
    expect(shipped('local')).toEqual(['fleet-watch', 'fleet-tool']);
    expect(shipped('box')).toEqual(['fleet-web']);
    expect(rows.map((r) => `${r.app}@${r.host}`)).toEqual([
      'watch@local',
      'web@box',
    ]);
  });
  it('a dependency on another host starts first, at its own host', async () => {
    const h = fakeFleet(undefined, {});
    await actOn(h.fleet, 'web', 'start');
    expect(h.starts()).toEqual(['local fleet-watch', 'box fleet-web']);
  });
  it('with --host X dependencies that run elsewhere are left alone', async () => {
    const h = fakeFleet('box', {});
    await actOn(h.fleet, 'web', 'start');
    expect(h.starts()).toEqual(['box fleet-web']);
    expect(h.connected).toEqual(['box']);
  });
  it('an app on a readonly host refuses the whole command before any host is touched, naming that app', async () => {
    const h = fakeFleet(undefined, {});
    await expect(actOn(h.fleet, 'all', 'stop')).rejects.toMatchObject({
      code: 'READONLY_HOST',
      message: expect.stringContaining('"audit"'),
    });
    expect(h.connected).toEqual([]);
  });
  it('stop and delete act on the pm2 process of each app at its host', async () => {
    const h = fakeFleet(undefined, {
      local: [proc('watch', 0, dir)],
      box: [proc('web', 3, '/home/dev/fleet')],
    });
    await actOn(h.fleet, 'dev', 'stop');
    expect(h.log.filter((l) => l.includes("'stop'"))).toEqual([
      "local: pm2 'stop' '0'",
      "box: pm2 'stop' '3'",
    ]);
  });
  it('actOn takes a list of targets: the named apps, in one change', async () => {
    const h = fakeFleet(undefined, {
      local: [proc('watch', 0, dir)],
      box: [proc('web', 3, '/home/dev/fleet')],
    });
    const rows = await actOn(h.fleet, ['watch', 'web'], 'stop');
    expect(rows.map((r) => r.app).sort()).toEqual(['watch', 'web']);
    expect(h.log.filter((l) => l.includes("'stop'"))).toEqual([
      "local: pm2 'stop' '0'",
      "box: pm2 'stop' '3'",
    ]);
  });
  it('a start of a list is refused before any host is touched: a queued start is replayed by one name', async () => {
    const h = fakeFleet(undefined, {});
    await expect(
      actOn(h.fleet, ['watch', 'web'], 'start')
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      hint: 'Start one app or profile; a list of targets is for stop, restart and delete.',
    });
    expect(h.connected).toEqual([]);
  });
});

describe('stopStack', () => {
  const procs = {
    local: [proc('watch', 0, dir), proc('tool', 1, dir)],
    box: [proc('web', 3, '/home/dev/fleet')],
  };
  it('stops every app at its own host and leaves the apps of a readonly host alone, saying so', async () => {
    const h = fakeFleet(undefined, procs);
    const out = await stopStack(m, h.connector);
    expect(out.stopped.sort()).toEqual(['tool', 'watch', 'web']);
    expect(out.readonly).toEqual([{ host: 'ro', apps: ['audit'] }]);
    expect(out.failed).toEqual([]);
    expect(h.connected).not.toContain('ro');
    expect(h.log.filter((l) => l.includes("'stop'")).sort()).toEqual([
      "box: pm2 'stop' '3'",
      "local: pm2 'stop' '0'",
      "local: pm2 'stop' '1'",
    ]);
  });
  it('a host that fails is named with each of its apps; the other hosts still stop', async () => {
    const h = fakeFleet(undefined, procs, ['box']);
    const out = await stopStack(m, h.connector);
    expect(out.stopped.sort()).toEqual(['tool', 'watch']);
    expect(out.failed).toEqual([
      { host: 'box', message: expect.stringMatching(/^web: TRANSPORT_FAILED/) },
    ]);
  });
  it('a host that cannot be built is reported as the one failure, not thrown, and nothing is stopped', async () => {
    const h = fakeFleet(undefined, procs);
    const bad = {
      ...m,
      hosts: {
        ...m.hosts,
        box: { ...m.hosts.box, pm2_home: `/${'h'.repeat(95)}` },
      },
    };
    const out = await stopStack(bad, h.connector);
    expect(out).toEqual({
      stopped: [],
      readonly: [],
      failed: [
        { host: '-', message: expect.stringContaining('PM2_HOME_TOO_LONG') },
      ],
    });
    expect(h.connected).toEqual([]);
  });
  it('when no host answers, the error is the one failure', async () => {
    const h = fakeFleet(undefined, procs, ['local', 'box']);
    const out = await stopStack(m, h.connector);
    expect(out.stopped).toEqual([]);
    expect(out.failed).toEqual([
      { host: '-', message: expect.stringContaining('TRANSPORT_FAILED') },
    ]);
  });
});

describe('listFleet', () => {
  const procs = {
    local: [proc('watch', 0, dir)],
    box: [proc('web', 3, '/home/dev/fleet')],
    ro: [],
  };
  it('one row per app in selection order, each from its own host, probed in parallel', async () => {
    const h = fakeFleet(undefined, procs);
    const { rows, errors } = await listFleet(h.fleet, h.fleet.select(['all']));
    expect(rows.map((r) => `${r.app}@${r.host}:${r.status}`)).toEqual([
      'watch@local:online',
      'web@box:online',
      'tool@local:not-started',
      'audit@ro:not-started',
    ]);
    expect(errors).toEqual([]);
    expect(
      h.log
        .filter((l) => l.includes(MARK.JLIST))
        .map((l) => l.split(':')[0])
        .sort()
    ).toEqual(['box', 'local', 'ro']);
  });
  it('an unreachable host leaves its apps as unreachable rows with the error; the other hosts still answer', async () => {
    const h = fakeFleet(undefined, procs, ['box']);
    const { rows, errors } = await listFleet(h.fleet, h.fleet.select(['all']));
    expect(rows.find((r) => r.app === 'web')).toMatchObject({
      host: 'box',
      status: 'unreachable',
      error: expect.stringContaining('TRANSPORT_FAILED'),
    });
    expect(rows.find((r) => r.app === 'watch')?.status).toBe('online');
    expect(errors).toEqual([
      {
        host: 'box',
        apps: ['web'],
        message: 'TRANSPORT_FAILED: ssh box: Connection refused',
      },
    ]);
  });
  it('when no host answers there is nothing to show: the first error is thrown as before', async () => {
    const h = fakeFleet('box', procs, ['box']);
    await expect(
      listFleet(h.fleet, h.fleet.select(['all']))
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
  it("ls of one app asks only that app's url: another url on the same host is asked neither there nor from here", async () => {
    const WEB = 'http://localhost:3000/';
    const TOOL = 'http://localhost:3001/';
    const asked: string[] = [];
    const ctxs: ReturnType<typeof fakeCtx>[] = [];
    // with --host box, tool runs on box beside web; the host answers neither url, so each one asked goes on to here
    const fleet = new Fleet(m, 'box', async (_m, host, fallback) => {
      const ctx = fakeCtx(
        dir,
        host,
        [
          {
            match: MARK.JLIST,
            result: {
              stdout: probeOut({
                urls: `${WEB}\t000\t7\t::1\n${TOOL}\t000\t7\t::1\n`,
              }),
            },
          },
        ],
        fallback,
        async (u) => {
          asked.push(u);
          return { answered: true, code: 200 };
        }
      );
      ctx.manifest.apps.tool = { ...ctx.manifest.apps.tool, url: TOOL };
      ctxs.push(ctx);
      return ctx;
    });
    const { rows } = await listWithReloads(fleet, fleet.select(['web']), false);
    expect(rows).toMatchObject([
      { app: 'web', url_status: 'ok', url_from: 'here' },
    ]);
    const cmds = ctxs.flatMap((c) => c.fake.calls.map((x) => x.cmd));
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain(`'${WEB}'`);
    expect(cmds[0]).not.toContain(TOOL);
    expect(asked).toEqual([WEB]);
  });
  it('an explicit urls option still wins over the named apps (adopt asks none)', async () => {
    const h = fakeFleet(undefined, procs);
    await listFleet(h.fleet, ['web'], { urls: 'none' });
    const probe = h.log.find((l) => l.includes(MARK.JLIST))!;
    expect(probe).not.toContain('http://localhost:3000/');
  });
});

describe('one app by name (describe, logs)', () => {
  it("one() names the app's host; a profile is not an app and is refused as UNKNOWN_APP, not a crash", () => {
    const f = new Fleet(m, undefined, never);
    expect(f.one('web')).toBe('box');
    expect(() => f.one('dev')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_APP' })
    );
    expect(() => new Fleet(m, 'local', never).one('web')).toThrowError(
      expect.objectContaining({ code: 'WRONG_HOST' })
    );
  });
  it('describeFleetApp reads the app on its host but returns its full manifest entry, dependencies on other hosts included', async () => {
    const h = fakeFleet(undefined, {
      box: [proc('web', 3, '/home/dev/fleet')],
    });
    const d = await describeFleetApp(h.fleet, 'web');
    expect(d.host).toBe('box');
    expect(d.app.depends_on).toEqual([
      { app: 'watch', condition: 'started', timeout_s: 60 },
    ]);
    // the project summary says the same thing about the same dependency
    expect(
      describeProject(h.fleet.manifest).apps.find((a) => a.name === 'web')
        ?.depends_on
    ).toEqual(d.app.depends_on);
    // the app's own reload settings, as the manifest normalises them
    expect(d.app.reloads).toEqual({
      match: [],
      ignore: ['hmr update /src/noisy'],
      defaults: true,
    });
    expect(d.row).toMatchObject({ host: 'box', status: 'online' });
    expect(d.pm2.cwd).toBe('/home/dev/fleet');
    expect(h.connected).toEqual(['box']);
  });
});

describe('actOn when a host fails or refuses', () => {
  it('a host that fails mid-command keeps the rows of what already happened, marks its own apps, and the other hosts still act', async () => {
    const h = fakeFleet(
      undefined,
      {
        local: [proc('watch', 0, dir)],
        box: [proc('web', 3, '/home/dev/fleet')],
      },
      ['box']
    );
    const rows = await actOn(h.fleet, 'dev', 'stop');
    expect(rows.map((r) => `${r.app}@${r.host}:${r.status}`)).toEqual([
      'watch@local:online',
      'web@box:unreachable',
    ]); // the fake keeps reporting online after stop
    expect(rows[1].error).toContain('TRANSPORT_FAILED');
    expect(h.log.filter((l) => l.includes("'stop'"))).toEqual([
      "local: pm2 'stop' '0'",
    ]);
  });
  it('start stops at the first failed run: later apps may need what did not start, so they are marked skipped', async () => {
    const { audit: _gone, ...apps } = m.apps;
    const mm = { ...m, apps }; // start all = watch@local, web@box, tool@local: three runs
    const ok = fakeFleet(undefined, {});
    const f = new Fleet(mm, undefined, (_m, host, _fallback) =>
      host === 'box'
        ? Promise.reject(new McprocError('TRANSPORT_FAILED', 'box is down'))
        : ok.fleet.ctx(host).then(() => ok.ctxs[host])
    );
    const rows = await actOn(f, 'all', 'start');
    expect(rows.map((r) => `${r.app}@${r.host}:${r.status}`)).toEqual([
      'watch@local:not-started',
      'web@box:unreachable',
      'tool@local:skipped',
    ]);
    expect(rows[2].error).toContain('box');
    expect(ok.starts()).toEqual(['local fleet-watch']);
    const down = new Fleet(mm, undefined, () =>
      Promise.reject(new McprocError('TRANSPORT_FAILED', 'all down'))
    );
    await expect(actOn(down, 'watch', 'start')).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    }); // nothing happened at all: the error, as before
  });
  it('a dependency on a readonly host refuses start <app> naming the dependency and the way out', async () => {
    const ro = loadManifest(dir);
    const mm = {
      ...ro,
      apps: {
        ...ro.apps,
        web: {
          ...ro.apps.web,
          depends_on: [
            { app: 'watch', condition: 'started' as const, timeoutMs: 60_000 },
            { app: 'audit', condition: 'started' as const, timeoutMs: 60_000 },
          ],
        },
      },
    };
    const f = new Fleet(mm, undefined, never);
    await expect(actOn(f, 'web', 'start')).rejects.toMatchObject({
      code: 'READONLY_HOST',
      message: expect.stringContaining('"audit" (a dependency of "web")'),
      hint: expect.stringContaining('--host box'),
    });
  });
});

describe('actOn start with conditions across hosts', () => {
  const dir = path.join(here, '..', 'fixtures', 'projects', 'fleet-ready');
  const m2 = loadManifest(dir);
  const proc = (
    name: string,
    status: string,
    extra: Record<string, unknown> = {},
    cwd = dir
  ) => ({
    pid: status === 'online' ? 100 : 0,
    name: `fr-${name}`,
    pm_id: 1,
    pm2_env: { status, namespace: 'fr', pm_cwd: cwd, ...extra },
  });
  const rules = (list: unknown[]) => [
    {
      match: MARK.JLIST,
      result: {
        stdout: probeOut({ jlist: JSON.stringify(list), ps: '1 0\n' }),
      },
    },
    { match: /pm2 'jlist'/, result: { stdout: JSON.stringify(list) } },
    { match: 'cat >', result: {} },
    { match: /startOrRestart/, result: {} },
  ];
  it('waits for a dependency on the host it runs on, then starts the dependent on its own host', async () => {
    const ctxs: Record<string, ReturnType<typeof fakeCtx>> = {
      local: fakeCtx(
        dir,
        'local',
        rules([proc('libs', 'stopped', { exit_code: 0 })]),
        'local'
      ),
      box: fakeCtx(dir, 'box', rules([]), 'local'),
    };
    const f = new Fleet(m2, undefined, async (_m, host) => ctxs[host]);
    const waits: WaitRecord[] = [];
    const rows = await actOn(f, 'web', 'start', { waits });
    expect(rows.map((r) => [r.app, r.host, r.status])).toEqual([
      ['libs', 'local', 'done'],
      ['web', 'box', 'not-started'],
    ]);
    expect(waits).toEqual([
      expect.objectContaining({
        app: 'web',
        dep: 'libs',
        condition: 'completed',
        ok: true,
      }),
    ]);
    // the wait's jlist ran on local, the dependent's start on box
    expect(ctxs.local.fake.calls.some((c) => /pm2 'jlist'/.test(c.cmd))).toBe(
      true
    );
    expect(
      ctxs.box.fake.calls.some((c) => /startOrRestart.*'fr-web'/.test(c.cmd))
    ).toBe(true);
  });
  it('a dependency that failed on its host leaves the dependent skipped on the other host', async () => {
    const ctxs = {
      local: fakeCtx(
        dir,
        'local',
        rules([proc('libs', 'stopped', { exit_code: 2 })]),
        'local'
      ),
      box: fakeCtx(dir, 'box', rules([]), 'local'),
    };
    const f = new Fleet(
      m2,
      undefined,
      async (_m, host) => ctxs[host as 'local' | 'box']
    );
    const rows = await actOn(f, 'web', 'start');
    expect(rows.find((r) => r.app === 'web')).toMatchObject({
      status: 'skipped',
      error: 'libs failed (exit 2)',
    });
    expect(ctxs.box.fake.calls.some((c) => /startOrRestart/.test(c.cmd))).toBe(
      false
    );
  });
  it('a skip decided in one host run holds in the later runs: libs (local) fails, web (box) is skipped, site (local, after web) is skipped and never launched', async () => {
    const ctxs = {
      local: fakeCtx(
        dir,
        'local',
        rules([proc('libs', 'stopped', { exit_code: 2 })]),
        'local'
      ),
      box: fakeCtx(dir, 'box', rules([]), 'local'),
    };
    const f = new Fleet(
      m2,
      undefined,
      async (_m, host) => ctxs[host as 'local' | 'box']
    );
    expect(f.runs(['libs', 'web', 'site']).map((r) => r.host)).toEqual([
      'local',
      'box',
      'local',
    ]);
    const rows = await actOn(f, 'site', 'start');
    const by = Object.fromEntries(rows.map((r) => [r.app, r]));
    expect(by.web).toMatchObject({
      status: 'skipped',
      error: 'libs failed (exit 2)',
    });
    expect(by.site).toMatchObject({
      status: 'skipped',
      error: 'skipped: web was not started (libs failed (exit 2))',
    });
    const launched = (c: (typeof ctxs)[keyof typeof ctxs]) =>
      c.fake.calls
        .filter((x) => /startOrRestart/.test(x.cmd))
        .map((x) => x.cmd);
    expect(launched(ctxs.local)).toHaveLength(1); // libs only
    expect(launched(ctxs.local)[0]).toContain("'fr-libs'");
    expect(launched(ctxs.box)).toEqual([]);
  });
  it('a signal given to actOn reaches the wait on the dependency host: aborted, and the dependent on the other host is skipped', async () => {
    const ctxs = {
      local: fakeCtx(dir, 'local', rules([proc('libs', 'online')]), 'local'),
      box: fakeCtx(dir, 'box', rules([]), 'local'),
    };
    const f = new Fleet(
      m2,
      undefined,
      async (_m, host) => ctxs[host as 'local' | 'box']
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50); // while the wait polls; the start was not cancelled before it began
    const rows = await actOn(f, 'web', 'start', { signal: ac.signal });
    expect(rows.find((r) => r.app === 'web')).toMatchObject({
      status: 'skipped',
      error: 'libs: wait aborted',
    });
    expect(ctxs.box.fake.calls.some((c) => /startOrRestart/.test(c.cmd))).toBe(
      false
    );
  });
  it('with --host a conditional dependency elsewhere is left alone', async () => {
    const box = fakeCtx(dir, 'box', rules([]), 'box');
    const f = new Fleet(m2, 'box', async () => box);
    const waits: WaitRecord[] = [];
    const rows = await actOn(f, 'web', 'start', { waits });
    expect(rows.map((r) => r.app)).toEqual(['web']);
    expect(waits).toEqual([]);
  });
});

describe('actOn start through the memory lease gate', () => {
  const varsProj = path.join(here, '..', 'fixtures', 'projects', 'vars');
  let stateDir: string;
  let store: LeaseStore;
  let ensured = 0;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-fleet-gate-'));
    store = new LeaseStore(stateDir);
    ensured = 0;
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const gateOf = (available_mib: number): GateDeps => ({
    store,
    memory: async () => ({ total_mib: 8000, available_mib }),
    siblings: async () => new Map(),
    ensureWatcher: async () => {
      ensured++;
    },
  });
  /** the vars stand (demo-w2: db 512M, api 256M) on a local fake whose pm2 runs nothing yet */
  const varsFleet = () => {
    const ctx = fakeCtx(
      varsProj,
      'local',
      [
        { match: MARK.JLIST, result: { stdout: probeOut({}) } },
        { match: /pm2 'jlist'/, result: { stdout: '[]' } },
        { match: 'cat >', result: {} },
        { match: /startOrRestart/, result: {} },
      ],
      'local',
      async () => ({ answered: false, fail: 'refused' as const })
    );
    const fleet = new Fleet(loadManifest(varsProj), undefined, async () => ctx);
    const started = () =>
      ctx.fake.calls.filter((c) => /startOrRestart/.test(c.cmd)).length;
    return { fleet, started };
  };

  it('a start that does not fit is queued: queued rows, no pm2 start, one pending lease, the watcher made sure of', async () => {
    const h = varsFleet();
    const rows = await actOn(h.fleet, 'dev', 'start', { gate: gateOf(1500) });
    expect(rows.map((r) => [r.app, r.status, r.lease?.position])).toEqual([
      ['db', 'queued #1', 1],
      ['api', 'queued #1', 1],
    ]);
    expect(rows[0].lease?.waiting_for).toBe(
      'needs 922M, host has 476M over the reserve (446M short)'
    );
    expect(h.started()).toBe(0);
    expect(store.list().map((l) => [l.state, l.target, l.apps])).toEqual([
      ['pending', 'dev', ['db', 'api']],
    ]);
    expect(ensured).toBe(1);
  });

  it("a queued start keeps the caller's --host on its lease; without one the lease names none", async () => {
    const h = varsFleet();
    await actOn(h.fleet, 'dev', 'start', { gate: gateOf(1500) });
    const ctx = await h.fleet.ctx('local');
    const local = new Fleet(loadManifest(varsProj), 'local', async () => ctx);
    await actOn(local, 'dev', 'start', { gate: gateOf(1500) });
    expect(store.list().map((l) => [l.state, l.target, l.host])).toEqual([
      ['pending', 'dev', null],
      ['pending', 'dev', 'local'],
    ]);
  });

  it('a start that fits runs at once under a running lease', async () => {
    const h = varsFleet();
    const rows = await actOn(h.fleet, 'dev', 'start', {
      gate: gateOf(9000),
      note: 'dev up',
    });
    expect(rows.map((r) => r.app)).toEqual(['db', 'api']);
    expect(rows.every((r) => r.lease === undefined)).toBe(true);
    expect(h.started()).toBe(2);
    expect(store.list().map((l) => [l.state, l.note, l.child_pid])).toEqual([
      ['running', 'dev up', null], // its start went through: no starter left to wait for
    ]);
    expect(ensured).toBe(0);
  });

  it('stop frees the running lease once none of its apps is online', async () => {
    const h = varsFleet();
    await actOn(h.fleet, 'dev', 'start', { gate: gateOf(9000) });
    await actOn(h.fleet, 'dev', 'stop', { gate: gateOf(9000) });
    expect(store.list().map((l) => l.state)).toEqual(['freed']);
  });

  it('a start that throws frees the lease it was admitted under', async () => {
    const ctx = fakeCtx(varsProj, 'local', [
      { match: /pm2 'jlist'/, result: { stdout: '[]' } },
      { match: 'cat >', result: { code: 1, stderr: 'disk full' } },
    ]);
    const fleet = new Fleet(loadManifest(varsProj), undefined, async () => ctx);
    await expect(
      actOn(fleet, 'dev', 'start', { gate: gateOf(9000) })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(store.list()).toMatchObject([
      { state: 'freed', error: expect.stringContaining('disk full') },
    ]);
  });

  it('a start that runs a budgeted app on a remote host is refused before any host is touched; a stop of it is not', async () => {
    const mm = {
      ...m,
      apps: { ...m.apps, web: { ...m.apps.web, memory_mib: 100 } },
    };
    const h = fakeFleet(undefined, {
      box: [proc('web', 3, '/home/dev/fleet')],
    });
    const connected: string[] = [];
    const f = new Fleet(mm, undefined, async (_m, host) => {
      connected.push(host);
      await h.fleet.ctx(host);
      return h.ctxs[host];
    });
    await expect(
      actOn(f, 'web', 'start', { gate: gateOf(9000) })
    ).rejects.toMatchObject({
      code: 'LEASE_UNSUPPORTED_HOST',
      message:
        'web declare memory but run on host box; the lease queue works on the local host only in this version',
      hint: 'Drop memory: from apps bound to remote hosts.',
    });
    expect(connected).toEqual([]);
    expect(store.list()).toEqual([]);
    await actOn(f, 'web', 'stop', { gate: gateOf(9000) });
    expect(h.log.filter((l) => l.includes("'stop'"))).toEqual([
      "box: pm2 'stop' '3'",
    ]);
  });

  it('a leased start ends its lease once over every local run, two local runs around a remote one', async () => {
    const { audit: _gone, ...apps } = m.apps;
    const mm = { ...m, apps }; // start all = watch@local, web@box, tool@local: three runs
    const h = fakeFleet(undefined, {});
    const f = new Fleet(mm, undefined, async (_m, host) => {
      await h.fleet.ctx(host);
      return h.ctxs[host];
    });
    const l = await store.create(
      {
        kind: 'start',
        project: 'fleet',
        root: dir,
        slot: null,
        repo: dir,
        target: 'all',
        host: null,
        apps: ['watch', 'tool'],
        reload: false,
        estimate_mib: 1,
        need_mib: 1,
        margin: 0,
        reserve_mib: 0,
        sources: {},
        note: null,
        requester_pid: 1,
      },
      'pending'
    );
    await store.transition(l.id, 'starting', { child_pid: 4242 });
    const rows = await actOn(f, 'all', 'start', {
      gate: gateOf(9000),
      lease: l.id,
    });
    expect(rows.map((r) => `${r.app}@${r.host}:${r.error ?? ''}`)).toEqual([
      'watch@local:',
      'web@box:',
      'tool@local:',
    ]);
    expect(h.starts()).toEqual([
      'local fleet-watch',
      'box fleet-web',
      'local fleet-tool',
    ]);
    expect(store.get(l.id)).toMatchObject({
      state: 'running',
      error: null,
      child_pid: null,
    });
  });

  it('a queued local run holds back its dependents on another host: skipped with the lease, never launched', async () => {
    const budget = <
      T extends { apps: Record<string, { memory_mib: number | null }> },
    >(
      x: T
    ) => {
      if (x.apps.watch) x.apps.watch = { ...x.apps.watch, memory_mib: 512 };
      return x;
    };
    const mm = budget({ ...m, apps: { ...m.apps } });
    const h = fakeFleet(undefined, {});
    const f = new Fleet(mm, undefined, async (_m, host) => {
      await h.fleet.ctx(host);
      budget(h.ctxs[host].manifest);
      return h.ctxs[host];
    });
    const rows = await actOn(f, 'web', 'start', { gate: gateOf(10) });
    const [lease] = store.list();
    expect(lease).toMatchObject({ state: 'pending', apps: ['watch'] });
    expect(rows.map((r) => [r.app, r.host, r.status])).toEqual([
      ['watch', 'local', 'queued #1'],
      ['web', 'box', 'skipped'],
    ]);
    expect(rows[1].error).toBe(
      `skipped: watch was not started (queued: lease ${lease.id})`
    );
    expect(h.starts()).toEqual([]);
    expect(ensured).toBe(1);
  });

  it('a stop cancels the overlapping queued and starting leases first (ending the starting child), then stops, then frees', async () => {
    const lease = (over: Partial<NewLease>): NewLease => ({
      kind: 'start',
      project: 'demo-w2',
      root: varsProj,
      slot: 2,
      repo: '/w/demo',
      target: 'db',
      host: null,
      apps: ['db'],
      reload: false,
      estimate_mib: 1,
      need_mib: 1,
      margin: 0,
      reserve_mib: 0,
      sources: {},
      note: null,
      requester_pid: 1,
      ...over,
    });
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);
    try {
      const running = await store.create(lease({}), 'running');
      const starting = await store.create(
        lease({ target: 'dev', apps: ['db', 'api'] }),
        'pending'
      );
      await store.transition(starting.id, 'starting', { child_pid: child.pid });
      const pending = await store.create(
        lease({ target: 'api', apps: ['api'] }),
        'pending'
      );
      let status = 'online';
      const list = () =>
        JSON.stringify([
          {
            pid: status === 'online' ? 100 : 0,
            name: 'demo-w2-db',
            pm_id: 1,
            pm2_env: { status, namespace: 'demo-w2', pm_cwd: varsProj },
          },
        ]);
      const atStop: string[] = [];
      const ctx = fakeCtx(varsProj, 'local', [
        {
          match: MARK.JLIST,
          result: () => ({ stdout: probeOut({ jlist: list() }) }),
        },
        { match: /pm2 'jlist'/, result: () => ({ stdout: list() }) },
        {
          match: /pm2 'stop'/,
          result: () => {
            atStop.push(
              store
                .list()
                .map((l) => l.state)
                .join(','),
              `child alive: ${pidAlive(child.pid!)}`
            );
            status = 'stopped';
            return {};
          },
        },
      ]);
      const fleet = new Fleet(
        loadManifest(varsProj),
        undefined,
        async () => ctx
      );
      await actOn(fleet, 'dev', 'stop', { gate: gateOf(9000) });
      expect(atStop).toEqual([
        'running,cancelled,cancelled',
        'child alive: false',
      ]);
      expect(store.get(running.id)?.state).toBe('freed');
      expect(store.get(starting.id)).toMatchObject({
        state: 'cancelled',
        error: 'stop of db, api',
      });
      expect(store.get(pending.id)?.state).toBe('cancelled');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a stop goes ahead when the lease lock fails, and its rows say the leases were not updated', async () => {
    const lease = await store.create(
      {
        kind: 'start',
        project: 'demo-w2',
        root: varsProj,
        slot: 2,
        repo: '/w/demo',
        target: 'dev',
        host: null,
        apps: ['db', 'api'],
        reload: false,
        estimate_mib: 1,
        need_mib: 1,
        margin: 0,
        reserve_mib: 0,
        sources: {},
        note: null,
        requester_pid: 1,
      },
      'pending'
    );
    const stuck = new LeaseStore(stateDir);
    stuck.withLock = async () => {
      throw new McprocError(
        'TIMEOUT',
        'the lease lock is held by pid 9 for more than 10 s'
      );
    };
    const list = JSON.stringify([
      {
        pid: 100,
        name: 'demo-w2-db',
        pm_id: 1,
        pm2_env: { status: 'online', namespace: 'demo-w2', pm_cwd: varsProj },
      },
    ]);
    const ctx = fakeCtx(varsProj, 'local', [
      { match: MARK.JLIST, result: { stdout: probeOut({ jlist: list }) } },
      { match: /pm2 'jlist'/, result: { stdout: list } },
      { match: /pm2 'stop'/, result: {} },
    ]);
    const fleet = new Fleet(loadManifest(varsProj), undefined, async () => ctx);
    const rows = await actOn(fleet, 'db', 'stop', {
      gate: { ...gateOf(9000), store: stuck },
    });
    expect(ctx.fake.calls.some((c) => /pm2 'stop'/.test(c.cmd))).toBe(true);
    expect(rows[0].note).toBe(
      'leases not updated: TIMEOUT: the lease lock is held by pid 9 for more than 10 s'
    );
    expect(rows[0].error).toBeUndefined();
    expect(store.get(lease.id)?.state).toBe('pending');
    expect(renderMutation(rows, 'local', 'stop').text).toContain(
      'db: leases not updated: TIMEOUT'
    );
  });

  it('a queued run counts only the apps the gate counted: an app online already keeps its real row and does not hold back its dependents', async () => {
    const budget = <
      T extends { apps: Record<string, { memory_mib: number | null }> },
    >(
      x: T
    ) => {
      if (x.apps.watch) x.apps.watch = { ...x.apps.watch, memory_mib: 512 };
      if (x.apps.tool) x.apps.tool = { ...x.apps.tool, memory_mib: 256 };
      return x;
    };
    const mm = budget({
      ...m,
      apps: { ...m.apps },
      profiles: { ...m.profiles, trio: ['watch', 'tool', 'web'] },
    });
    const h = fakeFleet(undefined, { local: [proc('watch', 1, dir)] });
    const f = new Fleet(mm, undefined, async (_m, host) => {
      await h.fleet.ctx(host);
      budget(h.ctxs[host].manifest);
      return h.ctxs[host];
    });
    const rows = await actOn(f, 'trio', 'start', { gate: gateOf(10) });
    const [lease] = store.list();
    expect(lease).toMatchObject({ state: 'pending', apps: ['tool'] });
    expect(rows.map((r) => [r.app, r.host, r.status, r.lease?.id])).toEqual([
      ['watch', 'local', 'online', undefined],
      ['tool', 'local', 'queued #1', lease.id],
      // launched: the fake box lists nothing afterwards, so it reads not-started rather than skipped
      ['web', 'box', 'not-started', undefined],
    ]);
    expect(rows[2].error).toBeUndefined();
    expect(h.starts()).toEqual(['box fleet-web']);
  });

  it('the start of an admitted lease skips the queue and ends it as running', async () => {
    const h = varsFleet();
    const queued = await actOn(h.fleet, 'dev', 'start', { gate: gateOf(10) });
    const id = queued[0].lease!.id;
    await store.withLock(() => store.transition(id, 'starting'));
    await actOn(h.fleet, 'dev', 'start', { gate: gateOf(10), lease: id });
    expect(h.started()).toBe(2);
    expect(store.get(id)?.state).toBe('running');
  });
});

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../src/core/manifest.js';
import {
  Fleet,
  actOn,
  listFleet,
  describeFleetApp,
} from '../../src/core/fleet.js';
import { describeProject } from '../../src/core/list.js';
import { McprocError } from '../../src/core/errors.js';
import type { WaitRecord } from '../../src/core/actions.js';
import type { Context } from '../../src/core/resolve.js';
import { MARK } from '../../src/shell/snippets.js';
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
  const fleet = new Fleet(m, requested, async (_m, host, fallback) => {
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
  });
  const starts = () =>
    log
      .filter((l) => l.includes('startOrRestart'))
      .map((l) => `${l.split(':')[0]} ${/--only' '([^']+)'/.exec(l)![1]}`);
  return { fleet, log, connected, ctxs, starts };
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
    ac.abort();
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

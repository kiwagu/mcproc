import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { MARK } from '../../src/shell/snippets.js';
import {
  resolveTargets,
  orderWithDeps,
  shipEcosystem,
  startApps,
  restartApps,
  stopApps,
  deleteApps,
  type WaitRecord,
} from '../../src/core/actions.js';
import type { WaitResult } from '../../src/core/wait.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fx = (p: string) =>
  fs.readFileSync(path.join(here, '..', 'fixtures', 'probe', p), 'utf8');
const jlist = JSON.stringify([
  {
    pid: 69265,
    name: 'demo-api',
    pm_id: 0,
    pm2_env: { status: 'online', namespace: 'demo', pm_cwd: basic },
  },
  {
    pid: 4242,
    name: 'demo-api-build',
    pm_id: 1,
    pm2_env: { status: 'stopped', namespace: 'demo', pm_cwd: basic },
  },
  {
    pid: 777,
    name: 'other-api',
    pm_id: 5,
    pm2_env: { status: 'online', namespace: 'other', pm_cwd: '/q' },
  },
]);
const rulesWith = (list: string) => [
  {
    match: MARK.JLIST,
    result: {
      stdout: probeOut({
        jlist: list,
        ps: fx('ps.txt'),
        tcp: fx('ss-tcp.txt'),
      }),
    },
  },
  { match: /pm2 'jlist'/, result: { stdout: list } },
  { match: 'cat >', result: {} },
  { match: /startOrRestart|'stop'|'delete'/, result: {} },
];
const rules = () => rulesWith(jlist);
const cmds = (ctx: ReturnType<typeof fakeCtx>) =>
  ctx.fake.calls.map((c) => c.cmd);

describe('targets and order', () => {
  const ctx = fakeCtx(basic, 'local', []);
  it('resolves app, profile, all; rejects unknown before any exec', () => {
    expect(resolveTargets(ctx.manifest, 'api')).toEqual(['api']);
    expect(resolveTargets(ctx.manifest, 'base')).toEqual(['api-build', 'api']);
    expect(resolveTargets(ctx.manifest, 'all')).toEqual([
      'api-build',
      'api',
      'worker',
    ]);
    expect(() => resolveTargets(ctx.manifest, 'nope')).toThrowError(
      /neither an app nor a profile/
    );
    expect(ctx.fake.calls).toHaveLength(0);
  });
  it('orders dependencies first, once', () => {
    expect(orderWithDeps(ctx.manifest, ['api'])).toEqual(['api-build', 'api']);
    expect(orderWithDeps(ctx.manifest, ['api', 'api-build', 'worker'])).toEqual(
      ['api-build', 'api', 'worker']
    );
  });
});

describe('shipEcosystem', () => {
  it('writes the generated json through stdin and ensures the .gitignore', async () => {
    const ctx = fakeCtx(basic, 'stand', [{ match: 'cat >', result: {} }]);
    const file = await shipEcosystem(ctx);
    expect(file).toBe('/srv/demo/.mcproc/.generated/ecosystem.json');
    const call = ctx.fake.calls[0];
    expect(call.cmd).toContain(`mkdir -p '/srv/demo/.mcproc/.generated'`);
    expect(call.cmd).toContain(
      `printf '*\\n' > '/srv/demo/.mcproc/.gitignore'`
    );
    expect(call.cmd).toContain(
      `cat > '/srv/demo/.mcproc/.generated/ecosystem.json'`
    );
    const json = JSON.parse(String(call.opts.stdin));
    expect(json.apps.map((a: { name: string }) => a.name)).toEqual([
      'demo-api-build',
      'demo-api',
      'demo-worker',
    ]);
    expect(json.apps[1].cwd).toBe('/srv/demo');
  });
});

describe('startApps', () => {
  it('ships, starts deps first, skips online apps unless reload', async () => {
    const ctx = fakeCtx(basic, 'local', rules());
    const rows = await startApps(ctx, 'api');
    const c = cmds(ctx);
    expect(c[0]).toContain('cat >');
    expect(c.filter((x) => x.includes('startOrRestart'))).toEqual([
      `pm2 'startOrRestart' '${basic}/.mcproc/.generated/ecosystem.json' '--only' 'demo-api-build' '--update-env'`,
    ]);
    expect(rows.map((r) => r.app)).toEqual(['api-build', 'api']);
    const ctx2 = fakeCtx(basic, 'local', rules());
    await startApps(ctx2, 'api', { reload: true });
    expect(
      cmds(ctx2)
        .filter((x) => x.includes('startOrRestart'))
        .map((x) => /--only' '([^']+)'/.exec(x)![1])
    ).toEqual(['demo-api-build', 'demo-api']);
  });
});

describe("mutations stay quick whatever the apps' URLs do", () => {
  it("stop and delete act from pm2's own list and answer without URL checks; start checks only the URLs of what it started", async () => {
    for (const act of [stopApps, deleteApps]) {
      const ctx = fakeCtx(basic, 'local', rules());
      await act(ctx, 'api');
      const c = cmds(ctx);
      const acted = c.findIndex((x) => /'stop'|'delete'/.test(x));
      expect(acted).toBeGreaterThanOrEqual(0);
      expect(c.slice(0, acted).some((x) => x.includes(MARK.JLIST))).toBe(false); // no full probe before acting
      expect(c.some((x) => x.includes('3310/health'))).toBe(false);
    }
    const ctx = fakeCtx(basic, 'local', rules());
    await startApps(ctx, 'api-build');
    expect(cmds(ctx).some((x) => x.includes('3310/health'))).toBe(false); // the URL of api, which this start did not touch
    const ctx2 = fakeCtx(basic, 'local', rules());
    await startApps(ctx2, 'api', { reload: true });
    expect(cmds(ctx2).some((x) => x.includes('3310/health'))).toBe(true);
  });
});

describe('name collisions (pm2 matches by name only)', () => {
  const startCalls = (ctx: ReturnType<typeof fakeCtx>) =>
    cmds(ctx).filter((x) => x.includes('startOrRestart'));
  it('start refuses when the pm2 name belongs to another namespace, before starting anything', async () => {
    const foreign = JSON.stringify([
      {
        pid: 9,
        name: 'demo-api',
        pm_id: 3,
        pm2_env: { status: 'online', namespace: 'other', pm_cwd: '/q' },
      },
    ]);
    const ctx = fakeCtx(basic, 'local', rulesWith(foreign));
    await expect(startApps(ctx, 'api')).rejects.toMatchObject({
      code: 'NAME_COLLISION',
      message: expect.stringContaining('namespace "other"'),
      hint: expect.stringContaining('project:'),
    });
    expect(startCalls(ctx)).toEqual([]);
  });
  it('restart refuses when the same name and namespace run from another checkout', async () => {
    const twin = JSON.stringify([
      {
        pid: 9,
        name: 'demo-api',
        pm_id: 3,
        pm2_env: {
          status: 'online',
          namespace: 'demo',
          pm_cwd: '/elsewhere/demo',
        },
      },
    ]);
    const ctx = fakeCtx(basic, 'local', rulesWith(twin));
    await expect(restartApps(ctx, 'api')).rejects.toMatchObject({
      code: 'NAME_COLLISION',
      message: expect.stringContaining('/elsewhere/demo'),
      hint: expect.stringContaining('delete api'),
    });
    expect(startCalls(ctx)).toEqual([]);
  });
});

describe('restart / stop / delete', () => {
  it('restart issues startOrRestart for the requested apps only', async () => {
    const ctx = fakeCtx(basic, 'local', rules());
    await restartApps(ctx, 'api');
    expect(
      cmds(ctx)
        .filter((x) => x.includes('startOrRestart'))
        .map((x) => /--only' '([^']+)'/.exec(x)![1])
    ).toEqual(['demo-api']);
  });
  it('stop and delete act by pm_id inside the namespace and ignore foreign same-name processes', async () => {
    const ctx = fakeCtx(basic, 'local', rules());
    const rows = await stopApps(ctx, 'all');
    expect(cmds(ctx).filter((x) => x.includes("'stop'"))).toEqual([
      `pm2 'stop' '0'`,
    ]);
    expect(rows).toHaveLength(3);
    const ctx2 = fakeCtx(basic, 'local', rules());
    await deleteApps(ctx2, 'base');
    expect(cmds(ctx2).filter((x) => x.includes("'delete'"))).toEqual([
      `pm2 'delete' '1'`,
      `pm2 'delete' '0'`,
    ]);
  });
});

describe('startApps with depends_on conditions', () => {
  const readiness = path.join(here, '..', 'fixtures', 'projects', 'readiness');
  const proc = (
    name: string,
    status: string,
    extra: Record<string, unknown> = {}
  ) => ({
    pid: status === 'online' ? 100 : 0,
    name: `ready-${name}`,
    pm_id: 1,
    pm2_env: { status, namespace: 'ready', pm_cwd: readiness, ...extra },
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
  const okWait = (status = 'done'): WaitResult => ({
    ok: true,
    until: 'exited',
    waited_ms: 1500,
    status,
    exit_code: 0,
  });
  const launchedOf = (ctx: ReturnType<typeof fakeCtx>) =>
    ctx.fake.calls
      .filter((c) => /startOrRestart/.test(c.cmd))
      .map((c) => /'--only' '([^']+)'/.exec(c.cmd)![1]);
  it('waits for each conditional dependency after it was launched and before the dependent starts', async () => {
    const ctx = fakeCtx(readiness, 'local', rules([]));
    const waited: string[] = [];
    const waits: WaitRecord[] = [];
    const rows = await startApps(ctx, 'web', {
      waits,
      waitDep: async (d, forApp) => {
        waited.push(`${forApp}<-${d.app}:${d.condition}`);
        return okWait();
      },
    });
    expect(launchedOf(ctx)).toEqual([
      'ready-libs',
      'ready-api',
      'ready-logger',
      'ready-web',
    ]);
    expect(waited).toEqual(['api<-libs:completed', 'web<-api:ready']); // started deps (logger) are not waited for
    expect(waits.map((w) => [w.app, w.dep, w.ok])).toEqual([
      ['api', 'libs', true],
      ['web', 'api', true],
    ]);
    expect(rows.map((r) => r.app)).toEqual(['libs', 'api', 'logger', 'web']);
  });
  it('a failed dependency skips the dependent and everything that depends on it; unrelated apps still start', async () => {
    const ctx = fakeCtx(readiness, 'local', rules([]));
    const rows = await startApps(ctx, 'stack', {
      waitDep: async (d) =>
        d.app === 'libs'
          ? {
              ok: false,
              reason: 'failed',
              until: 'exited',
              waited_ms: 300,
              status: 'failed (exit 2)',
              exit_code: 2,
            }
          : okWait(),
    });
    const by = Object.fromEntries(rows.map((r) => [r.app, r]));
    expect(by.api).toMatchObject({
      status: 'skipped',
      error: 'libs failed (exit 2)',
    });
    expect(by.web).toMatchObject({
      status: 'skipped',
      error: 'skipped: api was not started (libs failed (exit 2))',
    });
    expect(by.logger.status).not.toBe('skipped');
    expect(launchedOf(ctx)).toEqual(['ready-libs', 'ready-logger']);
  });
  it('an online task dependency is waited on, not restarted; a done one is re-run', async () => {
    const online = fakeCtx(readiness, 'local', rules([proc('libs', 'online')]));
    await startApps(online, 'api', { waitDep: async () => okWait() });
    expect(launchedOf(online)).toEqual(['ready-api']);
    const done = fakeCtx(
      readiness,
      'local',
      rules([proc('libs', 'stopped', { exit_code: 0 })])
    );
    await startApps(done, 'api', { waitDep: async () => okWait() });
    expect(launchedOf(done)).toEqual(['ready-libs', 'ready-api']);
  });
  it('an app already online is left alone without waiting (no reload)', async () => {
    const ctx = fakeCtx(
      readiness,
      'local',
      rules([
        proc('libs', 'stopped', { exit_code: 0 }),
        { ...proc('api', 'online'), pm_id: 2 },
      ])
    );
    const waited: string[] = [];
    await startApps(ctx, 'api', {
      waitDep: async (d) => {
        waited.push(d.app);
        return okWait();
      },
    });
    expect(waited).toEqual([]);
  });
  it('by default the wait runs on this context (no fleet)', async () => {
    // libs is already done: the default waiter sees exit 0 at once
    const ctx = fakeCtx(
      readiness,
      'local',
      rules([proc('libs', 'stopped', { exit_code: 0 })])
    );
    const waits: WaitRecord[] = [];
    const rows = await startApps(ctx, 'api', { waits });
    expect(waits[0]).toMatchObject({
      app: 'api',
      dep: 'libs',
      condition: 'completed',
      ok: true,
    });
    expect(rows.find((r) => r.app === 'api')!.status).not.toBe('skipped');
  });
});

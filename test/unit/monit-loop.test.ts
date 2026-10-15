import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { McprocError } from '../../src/core/errors.js';
import { loadManifest } from '../../src/core/manifest.js';
import { Fleet, type Connector } from '../../src/core/fleet.js';
import { parseJlist } from '../../src/core/pm2.js';
import type { LsRow, Snapshot } from '../../src/core/list.js';
import { EMPTY_STATS, type StatSample } from '../../src/core/stats.js';
import { LogFollower } from '../../src/core/logfollow.js';
import {
  MonitLoop,
  type Follower,
  type LoopDeps,
} from '../../src/monit/loop.js';
import {
  appInfos,
  initialState,
  keyIntent,
  monitViews,
  reduce,
  viewLabel,
  type MonitAction,
  type MonitState,
} from '../../src/monit/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fleetDir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
const row = (app: string, host = 'local'): LsRow => ({
  app,
  host,
  kind: 'server',
  description: app,
  status: 'online',
  pm_id: 0,
  pid: 1,
  uptime_ms: 0,
  started: null,
  restarts: 0,
  cpu: 0,
  memory: 0,
  procs: 1,
  runtime: null,
  pm2_cpu: 0,
  pm2_memory: 0,
  exit_code: null,
  metrics_source: 'tree',
  url: null,
  url_status: 'unchecked',
  url_code: null,
  ports: { actual: [], declared: [], checks: [], undeclared: [] },
});
const jlistOf = (project: string, apps: string[], base = 11) =>
  parseJlist(
    JSON.stringify(
      apps.map((a, i) => ({
        pid: base + i,
        name: `${project}-${a}`,
        pm_id: i,
        pm2_env: {
          status: 'online',
          namespace: project,
          pm_out_log_path: `/l/${a}-out`,
          pm_err_log_path: `/l/${a}-err`,
        },
      }))
    )
  );
const procs = jlistOf('demo', ['api', 'worker']);
const sample: StatSample = { ticks: new Map([[11, 5]]), ppid: new Map() };
const snap = (p = procs): Snapshot => ({
  procs: p,
  ports: {},
  listeners: [],
  tree: new Map(),
  stats: { ...EMPTY_STATS, samples: [sample] },
  metrics: {},
  sampledAt: Date.now(),
  urls: new Map(),
  zone: null,
});
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A loop on fake hosts. Without `requested` it opens the manifest's first view, as the screen does. */
function harness(
  requested: string | undefined,
  over: Partial<LoopDeps> = {},
  opts: {
    dir?: string;
    down?: (host: string) => boolean;
    gate?: (host: string) => Promise<void> | null;
    budgetMs?: number;
    maxLogs?: number;
  } = {}
) {
  const dir = opts.dir ?? basic;
  const m = loadManifest(dir);
  const views = monitViews(m);
  const connector: Connector = async (_m, host, fallback) => {
    if (opts.down?.(host))
      throw new McprocError(
        'TRANSPORT_FAILED',
        `ssh ${host}: Connection refused`
      );
    const g = opts.gate?.(host);
    if (g) await g; // this host takes its time to connect
    return fakeCtx(dir, host, [], fallback);
  };
  const fleetOf = (r: string | undefined) => new Fleet(m, r, connector);
  const fleet = fleetOf(requested ?? views[0]);
  let state: MonitState = initialState({
    project: m.project,
    host: viewLabel(fleet.requested),
    hosts: views.map(viewLabel),
    apps: appInfos(m),
    maxLogs: opts.maxLogs,
  });
  const actions: MonitAction[] = [];
  const commands: string[] = [];
  const deps: LoopDeps = {
    fleet: fleetOf,
    snapshot: async () => snap(),
    rows: (ctx, _snap, apps) =>
      apps.filter((a) => a !== 'api-build').map((a) => row(a, ctx.host.name)),
    follower: () => ({
      poll: async () => ({
        lines: [{ stream: 'out', text: 'line' }],
        reset: false,
      }),
    }),
    command: async (f, cmd, app) => {
      commands.push(`${cmd} ${app} via ${f.requested ?? 'all'}`);
    },
    reloadAll: async (f) => {
      commands.push(`reload all via ${f.requested ?? 'all'}`);
    },
    clear: async (_f, apps) =>
      apps.map((app) => ({ app, host: 'local', out_bytes: 0, err_bytes: 0 })),
    cleared: () => ({ at: {}, gen: {} }),
    ...over,
  };
  const loop = new MonitLoop(
    fleet,
    deps,
    { lines: 10, budgetMs: opts.budgetMs },
    () => state,
    (a) => {
      actions.push(a);
      state = reduce(state, a);
    }
  );
  return {
    loop,
    actions,
    commands,
    get state() {
      return state;
    },
  };
}

describe('MonitLoop', () => {
  it("refresh dispatches the rows, then the selected app's log lines and paths", async () => {
    const h = harness(undefined);
    await h.loop.refresh();
    expect(h.actions.map((a) => a.type)).toEqual(['rows', 'logs']);
    expect(h.state.logPaths).toEqual({ out: '/l/api-out', err: '/l/api-err' });
    expect(h.state.logs.api.map((l) => l.text)).toEqual(['line']);
  });

  it("flat view: a refresh polls every running app and dispatches labeled flat lines instead of the selected app's logs", async () => {
    const polled: string[] = [];
    const h = harness(undefined, {
      follower: (_c, paths) => ({
        poll: async () => {
          polled.push(paths.out);
          return {
            lines: [{ stream: 'out', text: `from ${paths.out}` }],
            reset: false,
          };
        },
      }),
    });
    h.loop.dispatch({ type: 'view', view: 'flat' });
    await h.loop.refresh();
    expect(polled).toEqual(['/l/api-out', '/l/worker-out']);
    expect(h.actions.map((a) => a.type)).toEqual([
      'view',
      'rows',
      'logs',
      'logs',
    ]);
    expect(h.state.logs).toMatchObject({
      api: [{ stream: 'out', text: 'from /l/api-out' }],
      worker: [{ stream: 'out', text: 'from /l/worker-out' }],
    });
  });
  it('refuses commands on a readonly host before touching it, and the failure stays in the footer', async () => {
    const h = harness('prod'); // readonly in the fixture
    await h.loop.refresh();
    await h.loop.runCommand('restart', 'api');
    expect(h.commands).toEqual([]);
    const notices = h.actions
      .filter((a) => a.type === 'notice')
      .map((a) => (a as { message: string }).message);
    expect(notices[0]).toBe('restart api…');
    expect(notices.at(-1)).toMatch(/^restart api failed: READONLY_HOST/);
    expect(h.state.busy).toBe(false);
    expect(h.state.error).toBeNull();
    await h.loop.refresh(); // the next good refresh must not wipe the failure the way it clears transport errors
    expect(h.state.notice).toMatch(/failed: READONLY_HOST/);
  });

  it('a failing command replaces its "in progress" notice instead of leaving it on screen', async () => {
    const h = harness(undefined, {
      command: async () => {
        throw new McprocError('PM2_FAILED', 'pm2 restart exited 1');
      },
    });
    await h.loop.runCommand('stop', 'api');
    expect(h.state.notice).toBe(
      'stop api failed: PM2_FAILED: pm2 restart exited 1'
    );
    expect(h.state.busy).toBe(false);
  });

  it("log lines of an app deselected during the poll land in that app's own buffer, never in the new selection", async () => {
    const d = deferred<{
      lines: { stream: 'out'; text: string }[];
      reset: boolean;
    }>();
    const h = harness(undefined, {
      follower: () => ({ poll: () => d.promise }),
    });
    const p = h.loop.refresh();
    await tick(); // rows dispatched, the poll of "api" is in flight
    expect(h.actions.map((a) => a.type)).toEqual(['rows']);
    h.loop.dispatchSelect(1); // the user presses ↓: "worker" is selected, its log view is empty
    d.resolve({ lines: [{ stream: 'out', text: 'from api' }], reset: false });
    await p;
    expect(h.state.logs.api?.map((l) => l.text)).toEqual(['from api']); // consumed from the file, so it must be kept
    expect(h.state.logs.worker).toBeUndefined();
    expect(h.state.logPaths).toBeNull();
  });

  it('a refresh started before a host switch is dropped: no stale rows, no stale cpu sample, no error', async () => {
    const d = deferred<Snapshot>();
    let calls = 0;
    const seen: unknown[] = [];
    const h = harness(undefined, {
      snapshot: (_ctx, opts) => {
        seen.push(opts.prev);
        return ++calls === 1 ? d.promise : Promise.resolve(snap());
      },
    });
    const stale = h.loop.refresh(); // old host, hangs
    await h.loop.switchView('stand'); // connects, resets, refreshes the new host at once (does not wait for the hung probe)
    expect(h.loop.fleet.requested).toBe('stand');
    expect(h.state.host).toBe('stand');
    expect(h.actions.filter((a) => a.type === 'rows')).toHaveLength(1);
    d.resolve({
      ...snap(),
      stats: {
        ...EMPTY_STATS,
        samples: [{ ticks: new Map([[11, 999]]), ppid: new Map() }],
      },
    });
    await stale;
    expect(h.actions.filter((a) => a.type === 'rows')).toHaveLength(1);
    expect(h.actions.some((a) => a.type === 'error')).toBe(false);
    await h.loop.refresh();
    expect(
      (seen.at(-1) as { sample: StatSample } | undefined)?.sample.ticks.get(11)
    ).toBe(5); // the new host's sample, not the stale 999
  });

  it('an older host switch that connects late never replaces a newer view; h waits while a switch is under way', async () => {
    const slow = deferred<void>();
    const h = harness(
      undefined,
      {},
      { gate: (host) => (host === 'stand' ? slow.promise : null) }
    );
    await h.loop.refresh();
    const first = h.loop.switchView('stand'); // still connecting
    await tick();
    expect(keyIntent('h', h.state)).toBeNull();
    await h.loop.switchView('prod'); // asked for later, done first
    expect(h.state.host).toBe('prod');
    slow.resolve();
    await first;
    expect(h.loop.fleet.requested).toBe('prod');
    expect(h.state.host).toBe('prod');
    expect(h.state.busy).toBe(false);
  });
  it('a failed host switch keeps the current view and reports in the footer', async () => {
    const h = harness(undefined, {}, { down: (host) => host === 'stand' });
    await h.loop.refresh();
    await h.loop.switchView('stand');
    expect(h.loop.fleet.requested).toBe('local');
    expect(h.state.error).toContain('TRANSPORT_FAILED');
    expect(h.state.rows).toHaveLength(2);
    expect(h.state.busy).toBe(false);
  });
  it('a command whose rows carry a failure (a dependency started, the app itself did not) says so instead of done', async () => {
    const h = harness(undefined, {
      command: async (_f, _c, app) => [
        { ...row('watch'), status: 'online' },
        {
          ...row(app, 'box'),
          status: 'failed',
          error: 'TRANSPORT_FAILED: ssh box: down',
        },
      ],
    });
    await h.loop.runCommand('start', 'api');
    expect(h.state.notice).toBe(
      'start api partly failed: api (box): TRANSPORT_FAILED: ssh box: down'
    );
  });
  it('runClear clears the running apps through the store, skips and names those on a readonly host, then shows the clear', async () => {
    const asked: string[][] = [];
    let store: Record<string, string> = {};
    const h = harness(
      undefined,
      {
        clear: async (_f, apps) => {
          asked.push(apps);
          store = { 'local/watch': '2026-10-12T15:04:05' };
          return apps.map((app) => ({
            app,
            host: 'local',
            out_bytes: 2048,
            err_bytes: 0,
          }));
        },
        cleared: () => ({ at: store, gen: {} }),
      },
      { dir: fleetDir }
    );
    await h.loop.runClear(['watch', 'audit']);
    expect(asked).toEqual([['watch']]);
    expect(h.state.notice).toBe(
      'cleared logs of watch (2K); incidents start here; skipped audit (readonly host)'
    );
    expect(h.state.cleared).toEqual({ 'local/watch': '2026-10-12T15:04:05' });
    expect(h.state.busy).toBe(false);
  });
  it('runClear: only readonly apps clear nothing; a failed clear says why', async () => {
    const h = harness(
      undefined,
      {
        clear: async () => {
          throw new McprocError('TRANSPORT_FAILED', 'ssh box: down');
        },
      },
      { dir: fleetDir }
    );
    await h.loop.runClear(['audit']);
    expect(h.state.notice).toBe(
      'nothing cleared; skipped audit (readonly host)'
    );
    await h.loop.runClear(['watch']);
    expect(h.state.notice).toBe(
      'clear failed: TRANSPORT_FAILED: ssh box: down'
    );
    const partial = harness(
      undefined,
      {
        clear: async () => [
          {
            app: 'watch',
            host: 'local',
            out_bytes: 0,
            err_bytes: 0,
            failed: ['/l/watch-err'],
          },
        ],
      },
      { dir: fleetDir }
    );
    await partial.loop.runClear(['watch']);
    expect(partial.state.notice).toBe(
      'cleared logs of watch (0B); incidents start here; could not truncate /l/watch-err (its incidents go on from before)'
    );
    expect(h.state.busy).toBe(false);
  });
  it("a clear seen in the store starts that app's logs over: the buffer empties and a new follower reads the emptied file", async () => {
    let store = {
      at: {} as Record<string, string>,
      gen: {} as Record<string, number>,
    };
    let made = 0;
    const h = harness(undefined, {
      cleared: () => store,
      follower: () => {
        const n = ++made;
        return {
          poll: async () => ({
            lines: [{ stream: 'out' as const, text: `line ${n}` }],
            reset: false,
          }),
        };
      },
    });
    await h.loop.refresh();
    expect(h.state.logs.api.map((l) => l.text)).toEqual(['line 1']);
    store = {
      at: { 'local/api': '2026-10-12T15:04:05' },
      gen: { 'local/api': 1 },
    }; // cleared by the CLI or an agent
    await h.loop.refresh();
    expect(made).toBe(2);
    expect(h.state.logs.api.map((l) => l.text)).toEqual(['line 2']);
    store = { at: store.at, gen: { 'local/api': 2 } }; // cleared again within the same second: the time shown is the same
    await h.loop.refresh();
    expect(made).toBe(3);
    expect(h.state.logs.api.map((l) => l.text)).toEqual(['line 3']);
  });
  it('lines read across a clear are dropped: they come from before it', async () => {
    let store = {
      at: {} as Record<string, string>,
      gen: {} as Record<string, number>,
    };
    const gate = deferred<Awaited<ReturnType<Follower['poll']>>>();
    let made = 0;
    const h = harness(undefined, {
      cleared: () => store,
      clear: async (_f, apps) => {
        store = {
          at: { 'local/api': '2026-10-12T15:04:05' },
          gen: { 'local/api': 1 },
        };
        return apps.map((app) => ({
          app,
          host: 'local',
          out_bytes: 0,
          err_bytes: 0,
        }));
      },
      follower: () => {
        const n = ++made;
        return {
          poll: () =>
            n === 1
              ? gate.promise
              : Promise.resolve({ lines: [], reset: false }),
        };
      },
    });
    const first = h.loop.refresh(); // api's first read waits
    await tick();
    const clearing = h.loop.runClear(['api']);
    await tick();
    gate.resolve({
      lines: [{ stream: 'out', text: 'before the clear' }],
      reset: false,
    });
    await first;
    await clearing;
    expect((h.state.logs.api ?? []).map((l) => l.text)).toEqual([]);
    expect(made).toBe(2);
  });
  it('every refresh re-reads the recorded clears, so a clear from the CLI or an agent shows too', async () => {
    let store: Record<string, string> = {};
    const h = harness(undefined, { cleared: () => ({ at: store, gen: {} }) });
    await h.loop.refresh();
    expect(h.actions.some((a) => a.type === 'cleared')).toBe(false); // unchanged: nothing dispatched
    store = { 'local/api': '2026-10-12T15:04:05' };
    await h.loop.refresh();
    expect(h.state.cleared).toEqual({ 'local/api': '2026-10-12T15:04:05' });
  });
});

describe('MonitLoop with host-bound apps', () => {
  const fleetProcs: Record<string, ReturnType<typeof jlistOf>> = {
    local: jlistOf('fleet', ['watch']),
    box: jlistOf('fleet', ['web'], 50),
    ro: jlistOf('fleet', []),
  };
  const multi = (
    over: Partial<LoopDeps> = {},
    down?: (host: string) => boolean
  ) =>
    harness(
      undefined,
      {
        snapshot: async (ctx) => snap(fleetProcs[ctx.host.name]),
        rows: (ctx, _s, apps) => apps.map((a) => row(a, ctx.host.name)),
        ...over,
      },
      { dir: fleetDir, down }
    );

  it("opens on every app at its own host: one table across hosts, the selected app's logs read on its host", async () => {
    const followed: string[] = [];
    const h = multi({
      follower: (ctx, paths) => ({
        poll: async () => {
          followed.push(`${ctx.host.name} ${paths.out}`);
          return { lines: [], reset: false };
        },
      }),
    });
    expect(h.state.host).toBe('all');
    expect(h.state.hosts).toEqual(['all', 'local', 'box', 'ro']);
    await h.loop.refresh();
    expect(h.state.rows.map((r) => `${r.app}@${r.host}`)).toEqual([
      'watch@local',
      'web@box',
      'tool@local',
      'audit@ro',
    ]);
    h.loop.dispatchSelect(1); // web, which runs in the dev container
    await h.loop.refresh();
    expect(followed).toEqual(['local /l/watch-out', 'box /l/web-out']);
  });
  it('flat view merges the logs of every host', async () => {
    const h = multi({
      follower: (ctx, paths) => ({
        poll: async () => ({
          lines: [{ stream: 'out', text: `${ctx.host.name}:${paths.out}` }],
          reset: false,
        }),
      }),
    });
    h.loop.dispatch({ type: 'view', view: 'flat' });
    await h.loop.refresh();
    expect(h.state.logs).toMatchObject({
      watch: [{ stream: 'out', text: 'local:/l/watch-out' }],
      web: [{ stream: 'out', text: 'box:/l/web-out' }],
    });
  });
  it("a host that does not answer keeps its apps' last rows (unreachable ones the first time) and names itself in the footer", async () => {
    let boxDown = true;
    const h = multi({
      snapshot: async (ctx) => {
        if (ctx.host.name === 'box' && boxDown)
          throw new McprocError('TRANSPORT_FAILED', 'ssh box: timed out');
        return snap(fleetProcs[ctx.host.name]);
      },
    });
    await h.loop.refresh();
    expect(h.state.rows.find((r) => r.app === 'web')).toMatchObject({
      host: 'box',
      status: 'unreachable',
    });
    expect(h.state.rows.find((r) => r.app === 'watch')?.status).toBe('online');
    expect(h.state.error).toBe('box: TRANSPORT_FAILED: ssh box: timed out');
    boxDown = false;
    await h.loop.refresh();
    expect(h.state.rows.find((r) => r.app === 'web')?.status).toBe('online');
    expect(h.state.error).toBeNull();
    boxDown = true;
    await h.loop.refresh();
    expect(h.state.rows.find((r) => r.app === 'web')?.status).toBe('online'); // the last known row stays; the footer says why it is not fresh
    expect(h.state.error).toContain('box:');
  });
  it('h cycles all → each host, the way --host narrows a command; then back to all', async () => {
    const h = multi();
    await h.loop.nextView();
    expect([h.loop.fleet.requested, h.state.host]).toEqual(['local', 'local']);
    expect(h.state.rows.map((r) => r.app)).toEqual(['watch', 'tool']);
    await h.loop.nextView();
    expect(h.state.rows.map((r) => r.app)).toEqual(['web', 'tool']);
    await h.loop.nextView();
    await h.loop.nextView();
    expect([h.loop.fleet.requested, h.state.host]).toEqual([undefined, 'all']);
  });
  it('a command goes through the fleet of the current view, and is refused when the app runs on a readonly host', async () => {
    const h = multi();
    await h.loop.runCommand('restart', 'web');
    await h.loop.runCommand('stop', 'audit');
    expect(h.commands).toEqual(['restart web via all']);
    expect(h.state.notice).toMatch(/^stop audit failed: READONLY_HOST/);
  });
  it('a host that hangs holds back only its own rows: the other hosts refresh on every tick, their logs and commands go on', async () => {
    const probes: Record<string, number> = {};
    const polled: string[] = [];
    const h = multi({
      snapshot: (ctx) => {
        probes[ctx.host.name] = (probes[ctx.host.name] ?? 0) + 1;
        return ctx.host.name === 'box'
          ? new Promise<Snapshot>(() => undefined)
          : Promise.resolve(snap(fleetProcs[ctx.host.name]));
      },
      follower: (_ctx, paths) => ({
        poll: async () => {
          polled.push(paths.out);
          return { lines: [], reset: false };
        },
      }),
    });
    void h.loop.refresh();
    await tick();
    await tick();
    expect(h.state.rows.map((r) => r.app)).toEqual(['watch', 'tool', 'audit']); // web's host has not answered yet
    expect(polled).toEqual(['/l/watch-out']);
    void h.loop.refresh();
    await tick();
    await tick();
    expect(probes).toEqual({ local: 2, ro: 2, box: 1 }); // the hanging probe is not started again, the others are
    await h.loop.runCommand('restart', 'watch');
    expect(h.commands).toEqual(['restart watch via all']);
    expect(h.state.busy).toBe(false);
  });
});

/** followers that record their wakes and closes; `next` holds the lines their next poll returns */
function liveFollowers() {
  type Entry = {
    wake: (() => void) | null;
    watches: number;
    closes: number;
    polls: number;
    next: string[];
    gate?: Promise<void>;
  };
  const by = new Map<string, Entry>();
  const all: Entry[] = [];
  const follower: LoopDeps['follower'] = (_c, paths) => {
    const app = /\/l\/(\w+)-out/.exec(paths.out)![1];
    const e: Entry = { wake: null, watches: 0, closes: 0, polls: 0, next: [] };
    by.set(app, e);
    all.push(e);
    return {
      poll: async () => {
        e.polls++;
        const lines = e.next.splice(0).map((text) => ({
          stream: 'out' as const,
          text,
        }));
        if (e.gate) await e.gate;
        return { lines, reset: false };
      },
      watch: (w) => {
        e.watches++;
        e.wake = w;
      },
      close: () => {
        e.closes++;
        e.wake = null;
      },
    };
  };
  return { by, all, follower };
}
const settle = async (ms = 5) => {
  for (let i = 0; i < 3; i++) await tick();
  await new Promise((r) => setTimeout(r, ms));
};

describe('MonitLoop live logs', () => {
  it("shows the selected app's new lines as soon as its follower wakes, without a process snapshot", async () => {
    const live = liveFollowers();
    let snaps = 0;
    const h = harness(undefined, {
      follower: live.follower,
      snapshot: async () => {
        snaps++;
        return snap();
      },
    });
    await h.loop.refresh();
    const api = live.by.get('api')!;
    expect(api.wake).toBeTypeOf('function');
    api.next.push('fresh');
    api.wake!();
    await settle();
    expect(h.state.logs.api.map((l) => l.text)).toContain('fresh');
    expect(snaps).toBe(1);
    h.loop.close();
  });
  it('a burst of wakes polls once; a wake right after waits a moment, then polls once more', async () => {
    const live = liveFollowers();
    const h = harness(undefined, { follower: live.follower });
    await h.loop.refresh();
    const api = live.by.get('api')!;
    const before = api.polls;
    for (let i = 0; i < 5; i++) api.wake!();
    await settle();
    expect(api.polls).toBe(before + 1);
    api.wake!();
    api.wake!();
    await settle(); // within the gap: not yet
    expect(api.polls).toBe(before + 1);
    await new Promise((r) => setTimeout(r, 80));
    expect(api.polls).toBe(before + 2);
    h.loop.close();
  });
  it('moving the selection stops the old app waking the screen and watches the new one', async () => {
    const live = liveFollowers();
    const h = harness(undefined, { follower: live.follower });
    await h.loop.refresh();
    h.loop.dispatchSelect(1); // worker
    await settle();
    expect(live.by.get('api')!.closes).toBe(1);
    expect(live.by.get('worker')!.wake).toBeTypeOf('function');
    h.loop.close();
  });
  it('the flat view watches every running app; back on the dashboard only the selected one', async () => {
    const live = liveFollowers();
    const h = harness(undefined, { follower: live.follower });
    h.loop.dispatch({ type: 'view', view: 'flat' });
    await h.loop.refresh();
    expect(live.by.get('api')!.wake).toBeTypeOf('function');
    expect(live.by.get('worker')!.wake).toBeTypeOf('function');
    live.by.get('worker')!.next.push('w1');
    live.by.get('worker')!.wake!();
    await settle();
    expect(h.state.logs.worker.map((l) => l.text)).toContain('w1');
    h.loop.dispatch({ type: 'view', view: 'dashboard' });
    await h.loop.refresh();
    expect(live.by.get('worker')!.closes).toBe(1);
    expect(live.by.get('api')!.closes).toBe(0);
    h.loop.close();
  });
  it("a clear, a view switch and quitting close the followers' wakes", async () => {
    let store = {
      at: {} as Record<string, string>,
      gen: {} as Record<string, number>,
    };
    const live = liveFollowers();
    const h = harness(undefined, {
      follower: live.follower,
      cleared: () => store,
    });
    await h.loop.refresh();
    const first = live.by.get('api')!;
    store = {
      at: { 'local/api': '2026-10-12T21:00:00' },
      gen: { 'local/api': 1 },
    };
    await h.loop.refresh(); // cleared elsewhere: a new follower reads the emptied file
    expect(first.closes).toBe(1);
    const second = live.by.get('api')!;
    expect(second).not.toBe(first);
    expect(second.wake).toBeTypeOf('function');
    await h.loop.nextView();
    expect(second.closes).toBe(1);
    const third = live.by.get('api');
    h.loop.close();
    for (const e of live.all) expect(e.wake).toBeNull();
    if (third && third !== second) expect(third.closes).toBe(1);
  });
  it("a wake's lines read across a clear are dropped: they come from before it", async () => {
    let store = {
      at: {} as Record<string, string>,
      gen: {} as Record<string, number>,
    };
    const live = liveFollowers();
    const h = harness(undefined, {
      follower: live.follower,
      cleared: () => store,
    });
    await h.loop.refresh();
    const api = live.by.get('api')!;
    const gate = deferred<void>();
    api.gate = gate.promise;
    api.next.push('before the clear');
    api.wake!();
    await settle(); // the wake's poll is in flight
    store = {
      at: { 'local/api': '2026-10-12T21:00:00' },
      gen: { 'local/api': 1 },
    };
    await h.loop.refresh();
    gate.resolve();
    await settle();
    expect((h.state.logs.api ?? []).map((l) => l.text)).not.toContain(
      'before the clear'
    );
    h.loop.close();
  });
  it("a slow poll on one host never holds another host's woken lines", async () => {
    const fleetProcs: Record<string, ReturnType<typeof jlistOf>> = {
      local: jlistOf('fleet', ['watch', 'tool']),
      box: jlistOf('fleet', ['web'], 21),
    };
    const live = liveFollowers();
    const h = harness(
      undefined,
      {
        snapshot: async (ctx) => snap(fleetProcs[ctx.host.name]),
        rows: (ctx, _s, apps) => apps.map((a) => row(a, ctx.host.name)),
        follower: live.follower,
      },
      { dir: fleetDir }
    );
    h.loop.dispatch({ type: 'view', view: 'flat' });
    await h.loop.refresh();
    const web = live.by.get('web')!;
    const watch = live.by.get('watch')!;
    const slow = deferred<void>();
    web.gate = slow.promise; // the remote read hangs (its stream dropped, the shell read waits on ssh)
    web.wake!();
    await settle();
    watch.next.push('local line');
    watch.wake!();
    await settle(80);
    expect(h.state.logs.watch.map((l) => l.text)).toContain('local line');
    slow.resolve();
    h.loop.close();
  });
});

/** followers fed by the test: `feed` queues lines for an app's next poll; `wakes` holds the wake of each watched app */
function fedFollowers() {
  const next = new Map<string, string[]>();
  const wakes = new Map<string, () => void>();
  const follower: LoopDeps['follower'] = (_c, paths) => {
    const app = /\/l\/([\w-]+)-out/.exec(paths.out)![1];
    return {
      poll: async () => ({
        lines: (next.get(app) ?? []).splice(0).map((text) => ({
          stream: 'out' as const,
          text,
        })),
        reset: false,
      }),
      watch: (w) => {
        wakes.set(app, w);
      },
      close: () => {
        wakes.delete(app);
      },
    };
  };
  const feed = (app: string, ...lines: string[]) =>
    next.set(app, [...(next.get(app) ?? []), ...lines]);
  return { follower, feed, wakes };
}
/**
 * followers over real files in a temporary directory, read in-process as on this machine: `append` and `write` change an
 * app's out log; a wake comes only from the test (`wakes`), never from the files
 */
function fileFollowers() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-ml-'));
  const files = (app: string) => ({
    out: path.join(dir, `${app}-out`),
    err: path.join(dir, `${app}-err`),
  });
  const wakes = new Map<string, () => void>();
  const follower: LoopDeps['follower'] = (ctx, paths, lines) => {
    const app = /\/l\/([\w-]+)-out/.exec(paths.out)![1];
    const f = new LogFollower(ctx, files(app), lines, true);
    return {
      poll: () => f.poll(),
      watch: (w) => {
        wakes.set(app, w);
      },
      close: () => {
        wakes.delete(app);
      },
    };
  };
  return {
    follower,
    wakes,
    append: (app: string, text: string) =>
      fs.appendFileSync(files(app).out, text),
    write: (app: string, text: string) =>
      fs.writeFileSync(files(app).out, text),
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
/** waits until `ok` holds, a few milliseconds at a time (a real file read takes its time) */
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};
/** pm2's stamp `sec` seconds after 12:00:00, with the separator pm2 writes after it */
const at = (sec: number) =>
  `${new Date(Date.UTC(2026, 9, 14, 12, 0, sec)).toISOString().slice(0, 23)}: `;
const START = '2026-10-14T12:00:00.000';

describe('MonitLoop reloads', () => {
  let now = 1_000_000;
  /** the wall clock the trackers read: a burst counts once no marker arrived for 2 s of it */
  const clock = () => vi.spyOn(Date, 'now').mockImplementation(() => now);
  afterEach(() => vi.restoreAllMocks());
  /** a loop whose rows carry each app's pm2 start and restarts from `runs` (null: no start known) */
  function counted(
    runs: Record<string, { started: string | null; restarts: number }>,
    over: Partial<LoopDeps> = {},
    opts: { budgetMs?: number; maxLogs?: number } = {}
  ) {
    clock();
    const fed = fedFollowers();
    const h = harness(
      undefined,
      {
        follower: fed.follower,
        rows: (ctx, _snap, apps) =>
          apps
            .filter((a) => a !== 'api-build')
            .map((a) => ({ ...row(a, ctx.host.name), ...runs[a] })),
        ...over,
      },
      opts
    );
    /** one refresh now, then one past the quiet gap: whatever burst the lines opened is counted */
    const settled = async () => {
      await h.loop.refresh();
      now += 2500;
      await h.loop.refresh();
    };
    return Object.assign(h, fed, { settled }); // onto h: its state getter stays live
  }

  it("counts the selected app's reloads from its history: the boot is not one, a burst counts once it went quiet; an app not followed gets no entry", async () => {
    const h = counted({
      api: { started: START, restarts: 0 },
      worker: { started: START, restarts: 0 },
    });
    h.feed(
      'api',
      `${at(1)}api listening on 3310`,
      `${at(10)}[vite] (client) page reload /src/a.ts`,
      `${at(10)}[vite] (client) page reload /src/b.ts`
    );
    await h.loop.refresh();
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: false,
    }); // the Vite burst is still open
    now += 2500;
    await h.loop.refresh();
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T12:00:10.000',
      partial: false,
    });
    expect(h.state.reloads).not.toHaveProperty('worker'); // the dashboard follows only the selected app
    h.feed('api', `${at(30)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({
      count: 2,
      last: '2026-10-14T12:00:30.000',
    });
    h.loop.close();
  });

  it('a pm2 restart (a higher restarts) starts the count over at 0, exact; the new boot is not counted, a later reload is', async () => {
    const runs = { api: { started: START, restarts: 0 } };
    const h = counted(runs);
    h.feed(
      'api',
      `${at(1)}api listening on 3310`,
      `${at(10)}[vite] (client) page reload /src/a.ts`
    );
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 1 });
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 1 };
    h.feed('api', `${at(61)}api listening on 3310`);
    await h.loop.refresh();
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: false,
    });
    now += 2500;
    await h.loop.refresh();
    expect(h.state.reloads.api).toMatchObject({ count: 0 });
    h.feed('api', `${at(90)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T12:01:30.000',
      partial: false,
    });
    h.loop.close();
  });

  it("a new run's boot that a wake delivered before the refresh saw the restart is still taken for the boot", async () => {
    const runs = { api: { started: START, restarts: 0 } };
    const h = counted(runs);
    h.feed('api', `${at(1)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 0 });
    // pm2 restarted the app: its boot reaches the screen through the follower's wake, the rows only on the next refresh
    h.feed('api', `${at(61)}api listening on 3310`);
    h.wakes.get('api')!();
    await settle();
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 1 };
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: false,
    });
    h.feed('api', `${at(90)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 1 });
    h.loop.close();
  });

  it('a history that does not reach back to the start is partial, and its first re-listen is a reload, not the boot', async () => {
    const h = counted({ api: { started: START, restarts: 0 } });
    h.feed('api', '2026-10-14T13:00:00.000: api listening on 3310');
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T13:00:00.000',
      partial: true,
    });
    h.loop.close();
  });

  it('the flat view counts every followed app; an app with reloads off or without a known start gets no entry', async () => {
    const h = counted({
      api: { started: START, restarts: 0 },
      worker: { started: START, restarts: 0 },
    });
    h.loop.fleet.manifest.apps.worker.reloads = null;
    h.loop.dispatch({ type: 'view', view: 'flat' });
    h.feed(
      'api',
      `${at(1)}api listening on 3310`,
      `${at(20)}[vite] hmr update /src/a.css`
    );
    h.feed('worker', `${at(1)}[vite] hmr update /src/a.css`);
    await h.settled();
    expect(h.state.reloads).toEqual({
      api: { count: 1, last: '2026-10-14T12:00:20.000', partial: false },
    });
    h.loop.close();
    const none = counted({ api: { started: null, restarts: 0 } });
    none.feed('api', `${at(20)}[vite] hmr update /src/a.css`);
    await none.settled();
    expect(none.state.reloads).toEqual({});
    expect(none.actions.map((a) => a.type)).not.toContain('reloads');
    none.loop.close();
  });

  it('a stop then a start (a new pm2 start, the same restarts) starts the count over; the new boot is not counted, a later reload is', async () => {
    const runs = { api: { started: START, restarts: 0 } };
    const h = counted(runs);
    h.feed(
      'api',
      `${at(1)}api listening on 3310`,
      `${at(10)}[vite] (client) page reload /src/a.ts`
    );
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 1 });
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 0 };
    h.feed('api', `${at(61)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: false,
    });
    h.feed('api', `${at(90)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T12:01:30.000',
      partial: false,
    });
    h.loop.close();
  });

  it("a restart seen on a catch-up poll longer than the screen's buffer counts from every line of that poll, the boot first", async () => {
    const runs = {
      api: { started: START, restarts: 0 },
      worker: { started: START, restarts: 0 },
    };
    const h = counted(runs, {}, { maxLogs: 5 });
    h.feed('api', `${at(1)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 0 });
    h.loop.dispatchSelect(1); // worker: api is no longer polled
    await h.loop.refresh();
    // api restarts meanwhile: its boot, more lines than the buffer holds, then a re-listen-only reload
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 1 };
    h.feed(
      'api',
      `${at(61)}api listening on 3310`,
      ...Array.from({ length: 10 }, (_, i) => `${at(62)}GET /items/${i} 200`),
      `${at(90)}api listening on 3310`
    );
    h.loop.dispatchSelect(-1); // back on api: one poll brings all of it
    await h.settled();
    expect(h.state.logs.api).toHaveLength(5);
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T12:01:30.000',
      partial: false,
    });
    h.loop.close();
  });

  /** more than one read takes (READ_CAP), stamped `sec`: the next poll skips to its last part */
  const flood = (sec: number) =>
    `${at(sec)}GET /api/items 200 ${'x'.repeat(80)}\n`.repeat(10_000);
  const reloadsIn = (h: { actions: MonitAction[] }, from: number) =>
    h.actions.slice(from).filter((a) => a.type === 'reloads');

  it('a poll whose follower skipped a burst too big for one read makes the count partial at once, with no reload in that poll; it stays so for the run, and a later restart counts exactly again', async () => {
    const ff = fileFollowers();
    const runs = { api: { started: START, restarts: 0 } };
    const h = counted(runs, { follower: ff.follower });
    ff.append(
      'api',
      `${at(1)}api listening on 3310\n${at(10)}[vite] (client) page reload /src/a.ts\n`
    );
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T12:00:10.000',
      partial: false,
    });
    // a reload, then more than one read takes: the next poll skips to the last part, the reload among what it skipped
    ff.append(
      'api',
      `${at(20)}[vite] (client) page reload /src/b.ts\n${flood(21)}`
    );
    const from = h.actions.length;
    await h.loop.refresh();
    expect(h.state.logs.api.at(-1)!.text).toMatch(/GET \/api\/items 200/);
    expect(reloadsIn(h, from)).toEqual([
      {
        type: 'reloads',
        app: 'api',
        info: { count: 1, last: '2026-10-14T12:00:10.000', partial: true },
      },
    ]);
    ff.append('api', `${at(40)}[vite] (client) page reload /src/c.ts\n`);
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 2,
      last: '2026-10-14T12:00:40.000',
      partial: true,
    });
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 1 };
    ff.append('api', `${at(61)}api listening on 3310\n`);
    await h.loop.refresh();
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: false,
    });
    ff.append('api', `${at(90)}api listening on 3310\n`);
    await h.settled();
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T12:01:30.000',
      partial: false,
    });
    h.loop.close();
    ff.done();
  });

  it('a log replaced under the follower (rotated, or truncated and written again) makes the count partial the same way, until a restart', async () => {
    const ff = fileFollowers();
    const runs = { api: { started: START, restarts: 0 } };
    const h = counted(runs, { follower: ff.follower });
    ff.append(
      'api',
      `${at(1)}api listening on 3310\n${at(10)}[vite] (client) page reload /src/a.ts\n`
    );
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 1, partial: false });
    ff.write('api', `${at(30)}GET / 200\n`); // a new file, shorter than the old position
    const from = h.actions.length;
    await h.loop.refresh();
    expect(h.state.logs.api.map((l) => l.text)).toEqual([`${at(30)}GET / 200`]);
    expect(reloadsIn(h, from)).toEqual([
      {
        type: 'reloads',
        app: 'api',
        info: { count: 1, last: '2026-10-14T12:00:10.000', partial: true },
      },
    ]);
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 1, partial: true });
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 1 };
    ff.append('api', `${at(61)}api listening on 3310\n`);
    await h.loop.refresh();
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: false,
    });
    h.loop.close();
    ff.done();
  });

  it("a restart seen right after a poll that lost lines is partial: the new run's boot may be among them", async () => {
    const ff = fileFollowers();
    const runs = { api: { started: START, restarts: 0 } };
    const h = counted(runs, { follower: ff.follower });
    ff.append('api', `${at(1)}api listening on 3310\n`);
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 0, partial: false });
    // pm2 restarted the app: its boot and more than one read takes reach a wake's poll, the rows only the next refresh
    ff.append('api', `${at(61)}api listening on 3310\n${flood(62)}`);
    ff.wakes.get('api')!();
    await until(() => h.state.reloads.api?.partial === true);
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 1 };
    ff.append('api', `${at(90)}api listening on 3310\n`);
    await h.settled();
    // the boot was skipped, so the re-listen at :90 is taken for it: the count can only be a lower bound
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: true,
    });
    h.loop.close();
    ff.done();
  });

  it('a clear of the logs makes the count partial: what it removed may hold reloads', async () => {
    let store = {
      at: {} as Record<string, string>,
      gen: {} as Record<string, number>,
    };
    const h = counted(
      { api: { started: START, restarts: 0 } },
      { cleared: () => store }
    );
    h.feed(
      'api',
      `${at(1)}api listening on 3310`,
      `${at(10)}[vite] (client) page reload /src/a.ts`
    );
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 1, partial: false });
    store = {
      at: { 'local/api': '2026-10-14T12:00:30' },
      gen: { 'local/api': 1 },
    }; // cleared by the CLI or an agent
    await h.loop.refresh();
    expect(h.state.reloads.api).toEqual({
      count: 1,
      last: '2026-10-14T12:00:10.000',
      partial: true,
    });
    h.loop.close();
  });

  it('a clear while a refresh is under way leaves its gap to the next refresh: the rows that one shows were taken before the clear', async () => {
    let store = {
      at: {} as Record<string, string>,
      gen: {} as Record<string, number>,
    };
    const runs: Record<string, { started: string | null; restarts: number }> = {
      api: { started: START, restarts: 0 },
    };
    let gate: Promise<void> | null = null;
    let probes = 0;
    const h = counted(runs, {
      cleared: () => store,
      clear: async (_f, apps) => {
        store = {
          at: { 'local/api': '2026-10-14T12:01:30' },
          gen: { 'local/api': 1 },
        };
        return apps.map((app) => ({
          app,
          host: 'local',
          out_bytes: 0,
          err_bytes: 0,
        }));
      },
      // the rows show the runs as they were when the probe was taken, however late it comes back
      snapshot: async () => {
        probes++;
        const taken = structuredClone(runs);
        await gate;
        return Object.assign(snap(), { taken });
      },
      rows: (ctx, s, apps) =>
        apps
          .filter((a) => a !== 'api-build')
          .map((a) => ({
            ...row(a, ctx.host.name),
            ...(s as Snapshot & { taken: typeof runs }).taken[a],
          })),
    });
    h.feed('api', `${at(1)}api listening on 3310`);
    await h.settled();
    expect(h.state.reloads.api).toMatchObject({ count: 0, partial: false });
    const held = deferred<void>();
    gate = held.promise;
    const refreshing = h.loop.refresh();
    await until(() => probes === 3); // its probe saw the run that is about to end
    // pm2 restarts the app, then its logs are cleared, the new boot with them
    runs.api = { started: '2026-10-14T12:01:00.000', restarts: 1 };
    const clearing = h.loop.runClear(['api']);
    await tick();
    expect(h.state.reloads.api).toMatchObject({ partial: true });
    gate = null;
    held.resolve();
    await refreshing;
    await clearing;
    h.feed('api', `${at(90)}api listening on 3310`);
    await h.settled();
    // the boot went with the clear, so the re-listen at :90 is taken for it: the count can only be a lower bound
    expect(h.state.reloads.api).toEqual({
      count: 0,
      last: null,
      partial: true,
    });
    h.loop.close();
  });

  it("an app whose own reloads patterns run away is no longer counted and the notice says why; its logs and the host's rows go on", async () => {
    const h = counted(
      { api: { started: START, restarts: 0 } },
      {},
      { budgetMs: 50 }
    );
    h.loop.fleet.manifest.apps.api.reloads = {
      match: ['^(a|aa)+$'],
      ignore: [],
      defaults: true,
    };
    h.feed('api', `${at(1)}${'a'.repeat(40)}b`);
    await h.loop.refresh();
    expect(h.state.reloads).toEqual({});
    expect(h.state.notice).toMatch(
      /reloads of api not counted: TIMEOUT.*the reloads patterns of api/
    );
    expect(h.state.error).toBeNull();
    expect(h.state.logs.api).toHaveLength(1);
    h.feed('api', `${at(30)}[vite] hmr update /src/a.css`);
    await h.settled();
    expect(h.state.reloads).toEqual({});
    expect(h.state.logs.api).toHaveLength(2);
    h.loop.close();
  });
});

describe('MonitLoop reload all', () => {
  const fleetProcs: Record<string, ReturnType<typeof jlistOf>> = {
    local: jlistOf('fleet', ['watch', 'tool']),
    box: jlistOf('fleet', ['web'], 50),
    ro: jlistOf('fleet', ['audit'], 70),
  };
  const multi = (requested: string | undefined, over: Partial<LoopDeps>) =>
    harness(
      requested,
      {
        snapshot: async (ctx) => snap(fleetProcs[ctx.host.name]),
        rows: (ctx, _s, apps) => apps.map((a) => row(a, ctx.host.name)),
        ...over,
      },
      { dir: fleetDir }
    );
  const notices = (h: { actions: MonitAction[] }) =>
    h.actions
      .filter((a) => a.type === 'notice')
      .map((a) => (a as { message: string | null }).message);

  it("reloads through the view's fleet with a signal, busy while it runs, says done, then refreshes every host of the view", async () => {
    const d = deferred<LsRow[] | undefined>();
    const seen: { requested: string | undefined; signal: AbortSignal }[] = [];
    const probes: string[] = [];
    const h = harness(undefined, {
      reloadAll: (f, signal) => {
        seen.push({ requested: f.requested, signal });
        return d.promise;
      },
      snapshot: async (ctx) => {
        probes.push(ctx.host.name);
        return snap();
      },
    });
    await h.loop.refresh();
    const run = h.loop.reloadAll();
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0].requested).toBe('local');
    expect(seen[0].signal.aborted).toBe(false);
    expect(h.state.busy).toBe(true);
    expect(h.state.notice).toBe('reload all…');
    const before = h.actions.filter((a) => a.type === 'rows').length;
    await h.loop.refresh(); // the screen keeps refreshing while the reload runs
    expect(h.actions.filter((a) => a.type === 'rows').length).toBe(before + 1);
    probes.length = 0;
    d.resolve([row('api'), row('worker')]);
    await run;
    expect(h.state.notice).toBe('reload all: done');
    expect(h.state.busy).toBe(false);
    expect(probes).toEqual(['local']);
    expect(notices(h)).toEqual(['reload all…', 'reload all: done']);
  });

  it('a reload, a command or a clear says how it ended only once the refresh after it is done, together with busy off', async () => {
    let gate: ReturnType<typeof deferred<void>> | null = null;
    const acted: string[] = [];
    const h = harness(undefined, {
      reloadAll: async () => {
        acted.push('reload');
        return [];
      },
      command: async (_f, cmd, app) => {
        acted.push(`${cmd} ${app}`);
        return [];
      },
      clear: async (_f, apps) => {
        acted.push(`clear ${apps.join(',')}`);
        return apps.map((app) => ({
          app,
          host: 'local',
          out_bytes: 0,
          err_bytes: 0,
        }));
      },
      snapshot: async () => {
        if (gate) await gate.promise; // the refresh after the change hangs, as on a slow host
        return snap();
      },
    });
    await h.loop.refresh();
    const cases: [() => Promise<void>, string, string, string][] = [
      [() => h.loop.reloadAll(), 'reload', 'reload all…', 'reload all: done'],
      [
        () => h.loop.runCommand('restart', 'api'),
        'restart api',
        'restart api…',
        'restart api: done',
      ],
      [
        () => h.loop.runClear(['api']),
        'clear api',
        'clearing logs of api…',
        'cleared logs of api (0B); incidents start here',
      ],
    ];
    for (const [run, act, during, after] of cases) {
      gate = deferred<void>();
      const p = run();
      for (let i = 0; i < 5; i++) await tick();
      expect(acted.at(-1)).toBe(act); // the change itself is over; its refresh is not
      expect(h.state.notice).toBe(during); // so keys are still refused, and the footer says why
      expect(h.state.busy).toBe(true);
      gate.resolve();
      await p;
      expect(h.state.notice).toBe(after);
      expect(h.state.busy).toBe(false);
    }
  });

  it('in the all-hosts view every app is reloaded at its own host; narrowed with h, only the apps of that host', async () => {
    const asked: (string | undefined)[] = [];
    const probes: string[] = [];
    const deps: Partial<LoopDeps> = {
      reloadAll: async (f) => {
        asked.push(f.requested);
        return [];
      },
      snapshot: async (ctx) => {
        probes.push(ctx.host.name);
        return snap(fleetProcs[ctx.host.name]);
      },
    };
    const all = multi(undefined, deps);
    all.loop.fleet.manifest.hosts.ro.readonly = false; // this test only: every host of the view writable
    await all.loop.reloadAll();
    expect(asked).toEqual([undefined]);
    expect(probes.sort()).toEqual(['box', 'local', 'ro']);
    expect(all.state.notice).toBe('reload all: done');
    const h = multi('local', deps);
    asked.length = 0;
    probes.length = 0;
    await h.loop.reloadAll();
    expect(asked).toEqual(['local']);
    expect(probes).toEqual(['local']);
    await h.loop.switchView('box');
    probes.length = 0;
    await h.loop.reloadAll();
    expect(asked).toEqual(['local', 'box']);
    expect(probes).toEqual(['box']); // tool runs where the view points (box); watch, bound to local, is not in this view
  });

  it('a view with an app on a readonly host refuses the whole reload before anything runs, and says so in the footer', async () => {
    const called: string[] = [];
    const probes: string[] = [];
    const h = multi(undefined, {
      reloadAll: async (f) => {
        called.push(f.requested ?? 'all');
        return [];
      },
      snapshot: async (ctx) => {
        probes.push(ctx.host.name);
        return snap(fleetProcs[ctx.host.name]);
      },
    });
    await h.loop.reloadAll();
    expect(called).toEqual([]);
    expect(probes).toEqual([]);
    expect(h.state.notice).toMatch(
      /^reload all failed: READONLY_HOST: Host "ro" is readonly: .*"audit" runs there; nothing was changed$/
    );
    expect(h.state.busy).toBe(false);
    await h.loop.refresh(); // a good refresh does not wipe the refusal
    expect(h.state.notice).toMatch(/^reload all failed: READONLY_HOST/);
    const prod = harness('prod', {
      reloadAll: async () => {
        called.push('prod');
        return [];
      },
    });
    await prod.loop.reloadAll();
    expect(called).toEqual([]);
    expect(prod.state.notice).toMatch(/^reload all failed: READONLY_HOST/);
  });

  it('a reload whose rows carry a failure says partly failed with the first one; one that throws says failed', async () => {
    const h = harness(undefined, {
      reloadAll: async () => [
        row('api-build'),
        {
          ...row('api'),
          status: 'skipped',
          error: 'api-build: wait timed out after 60s',
        },
        { ...row('worker'), status: 'failed', error: 'PM2_FAILED: boom' },
      ],
    });
    await h.loop.reloadAll();
    expect(h.state.notice).toBe(
      'reload all partly failed: api (local): api-build: wait timed out after 60s'
    );
    expect(h.state.busy).toBe(false);
    const t = harness(undefined, {
      reloadAll: async () => {
        throw new McprocError('TRANSPORT_FAILED', 'ssh stand: down');
      },
    });
    await t.loop.reloadAll();
    expect(t.state.notice).toBe(
      'reload all failed: TRANSPORT_FAILED: ssh stand: down'
    );
    expect(t.state.busy).toBe(false);
  });

  it('quitting the screen aborts the dependency waits of a running reload; nothing is refreshed after it', async () => {
    let signal: AbortSignal | undefined;
    const probes: string[] = [];
    const h = harness(undefined, {
      reloadAll: (_f, s) => {
        signal = s;
        return new Promise((resolve) =>
          s.addEventListener('abort', () => resolve([]), { once: true })
        );
      },
      snapshot: async (ctx) => {
        probes.push(ctx.host.name);
        return snap();
      },
    });
    const run = h.loop.reloadAll();
    await tick();
    expect(signal?.aborted).toBe(false);
    h.loop.close();
    expect(signal?.aborted).toBe(true);
    await run;
    expect(probes).toEqual([]);
    expect(h.state.notice).toBe('reload all…');
  });
});

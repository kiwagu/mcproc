import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { McprocError } from '../../src/core/errors.js';
import { loadManifest } from '../../src/core/manifest.js';
import { Fleet, type Connector } from '../../src/core/fleet.js';
import { parseJlist } from '../../src/core/pm2.js';
import type { LsRow, Snapshot } from '../../src/core/list.js';
import { EMPTY_STATS, type StatSample } from '../../src/core/stats.js';
import { MonitLoop, type LoopDeps } from '../../src/monit/loop.js';
import { appInfos, initialState, monitViews, reduce, viewLabel, type MonitAction, type MonitState } from '../../src/monit/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fleetDir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
const row = (app: string, host = 'local'): LsRow => ({ app, host, kind: 'server', description: app, status: 'online', pm_id: 0, pid: 1, uptime_ms: 0, restarts: 0, cpu: 0, memory: 0, procs: 1, runtime: null, pm2_cpu: 0, pm2_memory: 0, metrics_source: 'tree', url: null, url_status: 'unchecked', url_code: null, ports: { actual: [], declared: [], checks: [], undeclared: [] } });
const jlistOf = (project: string, apps: string[], base = 11) => parseJlist(JSON.stringify(apps.map((a, i) => ({ pid: base + i, name: `${project}-${a}`, pm_id: i, pm2_env: { status: 'online', namespace: project, pm_out_log_path: `/l/${a}-out`, pm_err_log_path: `/l/${a}-err` } }))));
const procs = jlistOf('demo', ['api', 'worker']);
const sample: StatSample = { ticks: new Map([[11, 5]]), ppid: new Map() };
const snap = (p = procs): Snapshot => ({ procs: p, ports: {}, listeners: [], tree: new Map(), stats: { ...EMPTY_STATS, samples: [sample] }, metrics: {}, sampledAt: Date.now(), urls: new Map() });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A loop on fake hosts. Without `requested` it opens the manifest's first view, as the screen does. */
function harness(requested: string | undefined, over: Partial<LoopDeps> = {}, opts: { dir?: string; down?: (host: string) => boolean } = {}) {
  const dir = opts.dir ?? basic;
  const m = loadManifest(dir);
  const views = monitViews(m);
  const connector: Connector = async (_m, host, fallback) => {
    if (opts.down?.(host)) throw new McprocError('TRANSPORT_FAILED', `ssh ${host}: Connection refused`);
    return fakeCtx(dir, host, [], fallback);
  };
  const fleetOf = (r: string | undefined) => new Fleet(m, r, connector);
  const fleet = fleetOf(requested ?? views[0]);
  let state: MonitState = initialState({ project: m.project, host: viewLabel(fleet.requested), hosts: views.map(viewLabel), apps: appInfos(m) });
  const actions: MonitAction[] = [];
  const commands: string[] = [];
  const deps: LoopDeps = {
    fleet: fleetOf,
    snapshot: async () => snap(),
    rows: (ctx, _snap, apps) => apps.filter((a) => a !== 'api-build').map((a) => row(a, ctx.host.name)),
    follower: () => ({ poll: async () => ({ lines: [{ stream: 'out', text: 'line' }], reset: false }) }),
    command: async (f, cmd, app) => { commands.push(`${cmd} ${app} via ${f.requested ?? 'all'}`); },
    ...over,
  };
  const loop = new MonitLoop(fleet, deps, { lines: 10 }, () => state, (a) => { actions.push(a); state = reduce(state, a); });
  return { loop, actions, commands, get state() { return state; } };
}

describe('MonitLoop', () => {
  it('refresh dispatches the rows, then the selected app\'s log lines and paths', async () => {
    const h = harness(undefined);
    await h.loop.refresh();
    expect(h.actions.map((a) => a.type)).toEqual(['rows', 'logs']);
    expect(h.state.logPaths).toEqual({ out: '/l/api-out', err: '/l/api-err' });
    expect(h.state.logs.api.map((l) => l.text)).toEqual(['line']);
  });

  it('flat view: a refresh polls every running app and dispatches labeled flat lines instead of the selected app\'s logs', async () => {
    const polled: string[] = [];
    const h = harness(undefined, { follower: (_c, paths) => ({ poll: async () => { polled.push(paths.out); return { lines: [{ stream: 'out', text: `from ${paths.out}` }], reset: false }; } }) });
    h.loop.dispatch({ type: 'view', view: 'flat' });
    await h.loop.refresh();
    expect(polled).toEqual(['/l/api-out', '/l/worker-out']);
    expect(h.actions.map((a) => a.type)).toEqual(['view', 'rows', 'logs', 'logs']);
    expect(h.state.logs).toMatchObject({ api: [{ stream: 'out', text: 'from /l/api-out' }], worker: [{ stream: 'out', text: 'from /l/worker-out' }] });
  });
  it('refuses commands on a readonly host before touching it, and the failure stays in the footer', async () => {
    const h = harness('prod'); // readonly in the fixture
    await h.loop.refresh();
    await h.loop.runCommand('restart', 'api');
    expect(h.commands).toEqual([]);
    const notices = h.actions.filter((a) => a.type === 'notice').map((a) => (a as { message: string }).message);
    expect(notices[0]).toBe('restart api…');
    expect(notices.at(-1)).toMatch(/^restart api failed: READONLY_HOST/);
    expect(h.state.busy).toBe(false);
    expect(h.state.error).toBeNull();
    await h.loop.refresh(); // the next good refresh must not wipe the failure the way it clears transport errors
    expect(h.state.notice).toMatch(/failed: READONLY_HOST/);
  });

  it('a failing command replaces its "in progress" notice instead of leaving it on screen', async () => {
    const h = harness(undefined, { command: async () => { throw new McprocError('PM2_FAILED', 'pm2 restart exited 1'); } });
    await h.loop.runCommand('stop', 'api');
    expect(h.state.notice).toBe('stop api failed: PM2_FAILED: pm2 restart exited 1');
    expect(h.state.busy).toBe(false);
  });

  it('log lines of an app deselected during the poll land in that app\'s own buffer, never in the new selection', async () => {
    const d = deferred<{ lines: { stream: 'out'; text: string }[]; reset: boolean }>();
    const h = harness(undefined, { follower: () => ({ poll: () => d.promise }) });
    const p = h.loop.refresh();
    await tick();                                   // rows dispatched, the poll of "api" is in flight
    expect(h.actions.map((a) => a.type)).toEqual(['rows']);
    h.loop.dispatchSelect(1);                       // the user presses ↓: "worker" is selected, its log view is empty
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
    const h = harness(undefined, { snapshot: (_ctx, opts) => { seen.push(opts.prev); return ++calls === 1 ? d.promise : Promise.resolve(snap()); } });
    const stale = h.loop.refresh();                 // old host, hangs
    await h.loop.switchView('stand');               // connects, resets, refreshes the new host at once (does not wait for the hung probe)
    expect(h.loop.fleet.requested).toBe('stand');
    expect(h.state.host).toBe('stand');
    expect(h.actions.filter((a) => a.type === 'rows')).toHaveLength(1);
    d.resolve({ ...snap(), stats: { ...EMPTY_STATS, samples: [{ ticks: new Map([[11, 999]]), ppid: new Map() }] } });
    await stale;
    expect(h.actions.filter((a) => a.type === 'rows')).toHaveLength(1);
    expect(h.actions.some((a) => a.type === 'error')).toBe(false);
    await h.loop.refresh();
    expect((seen.at(-1) as { sample: StatSample } | undefined)?.sample.ticks.get(11)).toBe(5); // the new host's sample, not the stale 999
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
});

describe('MonitLoop with host-bound apps', () => {
  const fleetProcs: Record<string, ReturnType<typeof jlistOf>> = { local: jlistOf('fleet', ['watch']), box: jlistOf('fleet', ['web'], 50), ro: jlistOf('fleet', []) };
  const multi = (over: Partial<LoopDeps> = {}, down?: (host: string) => boolean) => harness(undefined, {
    snapshot: async (ctx) => snap(fleetProcs[ctx.host.name]),
    rows: (ctx, _s, apps) => apps.map((a) => row(a, ctx.host.name)),
    ...over,
  }, { dir: fleetDir, down });

  it('opens on every app at its own host: one table across hosts, the selected app\'s logs read on its host', async () => {
    const followed: string[] = [];
    const h = multi({ follower: (ctx, paths) => ({ poll: async () => { followed.push(`${ctx.host.name} ${paths.out}`); return { lines: [], reset: false }; } }) });
    expect(h.state.host).toBe('all');
    expect(h.state.hosts).toEqual(['all', 'local', 'box', 'ro']);
    await h.loop.refresh();
    expect(h.state.rows.map((r) => `${r.app}@${r.host}`)).toEqual(['watch@local', 'web@box', 'tool@local', 'audit@ro']);
    h.loop.dispatchSelect(1);                       // web, which runs in the dev container
    await h.loop.refresh();
    expect(followed).toEqual(['local /l/watch-out', 'box /l/web-out']);
  });
  it('flat view merges the logs of every host', async () => {
    const h = multi({ follower: (ctx, paths) => ({ poll: async () => ({ lines: [{ stream: 'out', text: `${ctx.host.name}:${paths.out}` }], reset: false }) }) });
    h.loop.dispatch({ type: 'view', view: 'flat' });
    await h.loop.refresh();
    expect(h.state.logs).toMatchObject({ watch: [{ stream: 'out', text: 'local:/l/watch-out' }], web: [{ stream: 'out', text: 'box:/l/web-out' }] });
  });
  it('a host that does not answer keeps its apps\' last rows (unreachable ones the first time) and names itself in the footer', async () => {
    let boxDown = true;
    const h = multi({ snapshot: async (ctx) => { if (ctx.host.name === 'box' && boxDown) throw new McprocError('TRANSPORT_FAILED', 'ssh box: timed out'); return snap(fleetProcs[ctx.host.name]); } });
    await h.loop.refresh();
    expect(h.state.rows.find((r) => r.app === 'web')).toMatchObject({ host: 'box', status: 'unreachable' });
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
    await h.loop.nextView(); await h.loop.nextView();
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
      snapshot: (ctx) => { probes[ctx.host.name] = (probes[ctx.host.name] ?? 0) + 1; return ctx.host.name === 'box' ? new Promise<Snapshot>(() => undefined) : Promise.resolve(snap(fleetProcs[ctx.host.name])); },
      follower: (_ctx, paths) => ({ poll: async () => { polled.push(paths.out); return { lines: [], reset: false }; } }),
    });
    void h.loop.refresh();
    await tick(); await tick();
    expect(h.state.rows.map((r) => r.app)).toEqual(['watch', 'tool', 'audit']); // web's host has not answered yet
    expect(polled).toEqual(['/l/watch-out']);
    void h.loop.refresh();
    await tick(); await tick();
    expect(probes).toEqual({ local: 2, ro: 2, box: 1 }); // the hanging probe is not started again, the others are
    await h.loop.runCommand('restart', 'watch');
    expect(h.commands).toEqual(['restart watch via all']);
    expect(h.state.busy).toBe(false);
  });
});

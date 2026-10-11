import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { McprocError } from '../../src/core/errors.js';
import { parseJlist } from '../../src/core/pm2.js';
import type { LsRow, Snapshot } from '../../src/core/list.js';
import { EMPTY_STATS, type StatSample } from '../../src/core/stats.js';
import { MonitLoop, type LoopDeps } from '../../src/monit/loop.js';
import { appInfos, hostNames, initialState, reduce, type MonitAction, type MonitState } from '../../src/monit/state.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const row = (app: string): LsRow => ({ app, kind: 'server', description: app, status: 'online', pm_id: 0, pid: 1, uptime_ms: 0, restarts: 0, cpu: 0, memory: 0, procs: 1, runtime: null, pm2_cpu: 0, pm2_memory: 0, metrics_source: 'tree', url: null, url_status: 'unchecked', url_code: null, ports: { actual: [], declared: [], checks: [], undeclared: [] } });
const procs = parseJlist(JSON.stringify([
  { pid: 11, name: 'demo-api', pm_id: 0, pm2_env: { status: 'online', namespace: 'demo', pm_out_log_path: '/l/api-out', pm_err_log_path: '/l/api-err' } },
  { pid: 12, name: 'demo-worker', pm_id: 1, pm2_env: { status: 'online', namespace: 'demo', pm_out_log_path: '/l/w-out', pm_err_log_path: '/l/w-err' } },
]));
const sample: StatSample = { ticks: new Map([[11, 5]]), ppid: new Map() };
const snap = (): Snapshot => ({ procs, ports: {}, listeners: [], tree: new Map(), stats: { ...EMPTY_STATS, samples: [sample] }, metrics: {}, sampledAt: Date.now(), urls: new Map() });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(host: string, over: Partial<LoopDeps> = {}) {
  const ctx = fakeCtx(basic, host, []);
  let state: MonitState = initialState({ project: 'demo', host, hosts: hostNames(ctx.manifest), apps: appInfos(ctx.manifest) });
  const actions: MonitAction[] = [];
  const commands: string[] = [];
  const deps: LoopDeps = {
    connect: async (h) => fakeCtx(basic, h, []),
    snapshot: async () => snap(),
    rows: () => [row('api'), row('worker')],
    follower: () => ({ poll: async () => ({ lines: [{ stream: 'out', text: 'line' }], reset: false }) }),
    command: async (_c, cmd, app) => { commands.push(`${cmd} ${app}`); },
    ...over,
  };
  const loop = new MonitLoop(ctx, deps, { lines: 10 }, () => state, (a) => { actions.push(a); state = reduce(state, a); });
  return { loop, actions, commands, get state() { return state; } };
}

describe('MonitLoop', () => {
  it('refresh dispatches the rows, then the selected app\'s log lines and paths', async () => {
    const h = harness('local');
    await h.loop.refresh();
    expect(h.actions.map((a) => a.type)).toEqual(['rows', 'logs']);
    expect(h.state.logPaths).toEqual({ out: '/l/api-out', err: '/l/api-err' });
    expect(h.state.logs.map((l) => l.text)).toEqual(['line']);
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
    const h = harness('local', { command: async () => { throw new McprocError('PM2_FAILED', 'pm2 restart exited 1'); } });
    await h.loop.runCommand('stop', 'api');
    expect(h.state.notice).toBe('stop api failed: PM2_FAILED: pm2 restart exited 1');
    expect(h.state.busy).toBe(false);
  });

  it('log lines of an app deselected during the poll never land in the new selection', async () => {
    const d = deferred<{ lines: { stream: 'out'; text: string }[]; reset: boolean }>();
    const h = harness('local', { follower: () => ({ poll: () => d.promise }) });
    const p = h.loop.refresh();
    await tick();                                   // rows dispatched, the poll of "api" is in flight
    expect(h.actions.map((a) => a.type)).toEqual(['rows']);
    h.loop.dispatchSelect(1);                       // the user presses ↓: "worker" is selected, its log view is empty
    d.resolve({ lines: [{ stream: 'out', text: 'from api' }], reset: false });
    await p;
    expect(h.state.logs).toEqual([]);
    expect(h.state.logPaths).toBeNull();
  });

  it('a refresh started before a host switch is dropped: no stale rows, no stale cpu sample, no error', async () => {
    const d = deferred<Snapshot>();
    let calls = 0;
    const seen: unknown[] = [];
    const h = harness('local', { snapshot: (_ctx, opts) => { seen.push(opts.prev); return ++calls === 1 ? d.promise : Promise.resolve(snap()); } });
    const stale = h.loop.refresh();                 // old host, hangs
    await h.loop.switchHost('stand');               // connects, resets, refreshes the new host at once (does not wait for the hung probe)
    expect(h.loop.ctx.host.name).toBe('stand');
    expect(h.actions.filter((a) => a.type === 'rows')).toHaveLength(1);
    d.resolve({ ...snap(), stats: { ...EMPTY_STATS, samples: [{ ticks: new Map([[11, 999]]), ppid: new Map() }] } });
    await stale;
    expect(h.actions.filter((a) => a.type === 'rows')).toHaveLength(1);
    expect(h.actions.some((a) => a.type === 'error')).toBe(false);
    await h.loop.refresh();
    expect((seen.at(-1) as { sample: StatSample } | undefined)?.sample.ticks.get(11)).toBe(5); // the new host's sample, not the stale 999
  });

  it('a failed host switch keeps the current host and reports in the footer', async () => {
    const h = harness('local', { connect: async () => { throw new McprocError('TRANSPORT_FAILED', 'ssh stand: Connection refused'); } });
    await h.loop.refresh();
    await h.loop.switchHost('stand');
    expect(h.loop.ctx.host.name).toBe('local');
    expect(h.state.error).toContain('TRANSPORT_FAILED');
    expect(h.state.rows).toHaveLength(2);
    expect(h.state.busy).toBe(false);
  });
});

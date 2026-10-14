import { describe, it, expect } from 'vitest';
import {
  CONFIRM_MS,
  initialState,
  reduce,
  keyIntent,
  selectedRow,
  visibleLogs,
  visibleFlat,
  monitViews,
  viewLabel,
  type MonitState,
} from '../../src/monit/state.js';
import type { LsRow } from '../../src/core/list.js';

const row = (app: string, status = 'online'): LsRow => ({
  app,
  host: 'local',
  kind: 'server',
  description: `${app} desc`,
  status,
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
const apps = {
  api: { description: 'd', run: 'r', cwd: '.', pm2Name: 'demo-api' },
  web: { description: 'd', run: 'r', cwd: '.', pm2Name: 'demo-web' },
};
const s0 = (): MonitState =>
  reduce(
    initialState({
      project: 'demo',
      host: 'local',
      hosts: ['local', 'stand'],
      apps,
      maxLogs: 5,
    }),
    { type: 'rows', rows: [row('api'), row('web')], at: new Date(0) }
  );

describe('reduce', () => {
  it('rows keep the selection by app name and clear a previous error', () => {
    let s = reduce(s0(), { type: 'select', delta: 1 });
    s = reduce(s, { type: 'error', message: 'boom' });
    s = reduce(s, {
      type: 'rows',
      rows: [row('web'), row('api')],
      at: new Date(1),
    });
    expect(selectedRow(s)?.app).toBe('web');
    expect(s.selected).toBe(0);
    expect(s.error).toBeNull();
  });
  it("select clamps and switches the log view to the other app's buffer; buffers are kept per app; stream switches", () => {
    let s = reduce(s0(), {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: 'x' }],
    });
    s = reduce(s, { type: 'select', delta: -5 });
    expect(s.selected).toBe(0);
    expect(visibleLogs(s)).toHaveLength(1); // no change of selection, logs kept
    s = reduce(s, { type: 'select', delta: 1 });
    expect(s.selected).toBe(1);
    expect(visibleLogs(s)).toEqual([]); // web has no lines yet
    expect(s.logs.api).toHaveLength(1); // api's buffer waits for the next selection: no view consumes another's history
    expect(reduce(s, { type: 'stream', stream: 'err' }).stream).toBe('err');
  });
  it('logs append per app, cap at maxLogs keeping the newest, and reset replaces', () => {
    let s = s0();
    for (let i = 0; i < 8; i++)
      s = reduce(s, {
        type: 'logs',
        app: 'api',
        lines: [{ stream: 'out', text: `l${i}` }],
      });
    expect(s.logs.api.map((l) => l.text)).toEqual([
      'l3',
      'l4',
      'l5',
      'l6',
      'l7',
    ]);
    s = reduce(s, {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: 'fresh' }],
      reset: true,
    });
    expect(s.logs.api.map((l) => l.text)).toEqual(['fresh']);
  });
  it('error keeps the rows (an unreachable host must not blank the screen); host switch resets', () => {
    let s = reduce(s0(), { type: 'error', message: 'ssh: Connection refused' });
    expect(s.rows).toHaveLength(2);
    expect(s.error).toContain('refused');
    s = reduce(s, { type: 'host', host: 'stand' });
    expect(s).toMatchObject({
      host: 'stand',
      rows: [],
      logs: {},
      selected: 0,
      error: null,
    });
  });
});

describe('keyIntent', () => {
  it('maps keys to intents; commands need a selected app and an idle screen', () => {
    const s = s0();
    // the wheel arrives as arrow keys when mouse tracking is off, so ↑↓ scroll the log pane; the selection moves with j/k and Tab
    expect(keyIntent('down', s)).toEqual({
      kind: 'action',
      action: { type: 'scroll', delta: -1 },
    });
    expect(keyIntent('up', s)).toEqual({
      kind: 'action',
      action: { type: 'scroll', delta: 1 },
    });
    expect(keyIntent('pageup', s)).toEqual({
      kind: 'action',
      action: { type: 'scroll', delta: 10 },
    });
    expect(keyIntent('end', s)).toEqual({
      kind: 'action',
      action: { type: 'scroll', delta: -Infinity },
    });
    expect(keyIntent('j', s)).toEqual({
      kind: 'action',
      action: { type: 'select', delta: 1 },
    });
    expect(keyIntent('k', s)).toEqual({
      kind: 'action',
      action: { type: 'select', delta: -1 },
    });
    expect(keyIntent('tab', s)).toEqual({
      kind: 'action',
      action: { type: 'select', delta: 1 },
    });
    expect(keyIntent('S-tab', s)).toEqual({
      kind: 'action',
      action: { type: 'select', delta: -1 },
    });
    expect(keyIntent('e', s)).toEqual({
      kind: 'action',
      action: { type: 'stream', stream: 'err' },
    });
    expect(keyIntent('r', s)).toEqual({
      kind: 'command',
      cmd: 'restart',
      app: 'api',
    });
    expect(keyIntent('x', reduce(s, { type: 'busy', busy: true }))).toBeNull();
    expect(keyIntent('h', s)).toEqual({ kind: 'host-next' });
    expect(keyIntent('h', { ...s, hosts: ['local'] })).toBeNull();
    expect(keyIntent('q', s)).toEqual({ kind: 'quit' });
    expect(keyIntent('C-c', s)).toEqual({ kind: 'quit' });
    expect(keyIntent('z', s)).toBeNull();
  });
});

describe('log scrolling', () => {
  it('scroll counts entries hidden below the view, clamps, stays put while new lines arrive, and resets on select/end', () => {
    let s = s0();
    for (let i = 0; i < 4; i++)
      s = reduce(s, {
        type: 'logs',
        app: 'api',
        lines: [{ stream: 'out', text: `l${i}` }],
      });
    expect(s.logScroll).toBe(0);
    s = reduce(s, { type: 'scroll', delta: 2 });
    expect(s.logScroll).toBe(2);
    s = reduce(s, { type: 'scroll', delta: 10 });
    expect(s.logScroll).toBe(3); // never beyond the oldest entry
    expect(reduce(s, { type: 'scroll', delta: 10, max: 1 }).logScroll).toBe(1); // the screen passes the pane's real ceiling
    s = reduce(s, {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: 'l4' }],
    });
    expect(s.logScroll).toBe(4); // the view did not move when a line was appended below it (maxLogs 5: l0..l4)
    s = reduce(s, { type: 'scroll', delta: -1 });
    expect(s.logScroll).toBe(3);
    s = reduce(s, { type: 'scroll', delta: -Infinity });
    expect(s.logScroll).toBe(0);
    s = reduce(reduce(s, { type: 'scroll', delta: 2 }), {
      type: 'select',
      delta: 1,
    });
    expect(s.logScroll).toBe(0);
    s = reduce(reduce(s, { type: 'scroll', delta: 2 }), {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: 'fresh' }],
      reset: true,
    });
    expect(s.logScroll).toBe(0);
  });
  it('a scroll the screen measured in rows sets the entry and the rows hidden inside it; new lines keep that place, a select drops it', () => {
    let s = reduce(s0(), {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: 'l0' }],
    });
    s = reduce(s, { type: 'scroll', delta: 3, to: { entries: 0, rows: 3 } });
    expect([s.logScroll, s.logRowShift]).toEqual([0, 3]);
    s = reduce(s, {
      type: 'logs',
      app: 'api',
      lines: [
        { stream: 'out', text: 'l1' },
        { stream: 'out', text: 'l2' },
      ],
    });
    expect([s.logScroll, s.logRowShift]).toEqual([2, 3]); // still on the same rows of l0
    s = reduce(s, { type: 'select', delta: 1 });
    expect([s.logScroll, s.logRowShift]).toEqual([0, 0]);
  });
});

describe('flat view', () => {
  it('f toggles the flat view; commands need a visible selection, so they are off there; flat lines append, cap and sort by stamp across apps', () => {
    let s = s0();
    expect(s.view).toBe('dashboard');
    expect(keyIntent('f', s)).toEqual({
      kind: 'action',
      action: { type: 'view', view: 'flat' },
    });
    s = reduce(s, { type: 'view', view: 'flat' });
    expect(keyIntent('f', s)).toEqual({
      kind: 'action',
      action: { type: 'view', view: 'dashboard' },
    });
    expect(keyIntent('r', s)).toBeNull();
    expect(keyIntent('q', s)).toEqual({ kind: 'quit' });
    s = reduce(s, {
      type: 'logs',
      app: 'web',
      lines: [{ stream: 'out', text: '2026-10-11T13:00:08: w' }],
    });
    s = reduce(s, {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'err', text: '2026-10-11T13:00:07: a' }],
    });
    expect(visibleFlat(s).map((l) => `${l.app}:${l.text}`)).toEqual([
      'api:2026-10-11T13:00:07: a',
      'web:2026-10-11T13:00:08: w',
    ]); // one buffer per app, merged by stamp
    for (let i = 0; i < 6; i++)
      s = reduce(s, {
        type: 'logs',
        app: 'api',
        lines: [{ stream: 'out', text: `l${i}` }],
      });
    expect(s.logs.api).toHaveLength(5); // maxLogs applies per app
    expect(visibleFlat(s)).toHaveLength(6);
    s = reduce(s, { type: 'stream', stream: 'err' });
    expect(visibleFlat(s).map((l) => l.text)).toEqual([]); // the stamped err line was capped away; filter works
    s = reduce(s, { type: 'host', host: 'stand' });
    expect(s.logs).toEqual({});
  });
});

describe('visibleLogs', () => {
  it('filters by stream and orders "both" by timestamp', () => {
    let s = reduce(s0(), {
      type: 'logs',
      app: 'api',
      lines: [
        { stream: 'err', text: '2026-10-11T13:00:08: boom' },
        { stream: 'out', text: '2026-10-11T13:00:07: a' },
      ],
    });
    expect(visibleLogs(s).map((l) => l.text)).toEqual([
      '2026-10-11T13:00:07: a',
      '2026-10-11T13:00:08: boom',
    ]);
    s = reduce(s, { type: 'stream', stream: 'out' });
    expect(visibleLogs(s).map((l) => l.text)).toEqual([
      '2026-10-11T13:00:07: a',
    ]);
  });
});

describe('monitViews', () => {
  it('with host-bound apps the screen opens on all of them, then h narrows to each host; without, it cycles the hosts as before', async () => {
    const { loadManifest } = await import('../../src/core/manifest.js');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const fx = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'fixtures',
      'projects'
    );
    expect(
      monitViews(loadManifest(path.join(fx, 'fleet'))).map(viewLabel)
    ).toEqual(['all', 'local', 'box', 'ro']);
    expect(monitViews(loadManifest(path.join(fx, 'basic')))).toEqual([
      'local',
      'stand',
      'prod',
    ]);
  });
});

describe('flat view across hosts', () => {
  it('apps on different hosts merge by arrival (their clocks and time zones differ); apps of one host by pm2 stamp', () => {
    let s = reduce(
      initialState({
        project: 'demo',
        host: 'all',
        hosts: ['all', 'local', 'box'],
        apps,
      }),
      {
        type: 'rows',
        rows: [row('api'), { ...row('web'), host: 'box' }],
        at: new Date(0),
      }
    );
    s = reduce(s, { type: 'view', view: 'flat' });
    s = reduce(s, {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: '2026-10-12T12:00:05: local first' }],
    });
    s = reduce(s, {
      type: 'logs',
      app: 'web',
      lines: [
        { stream: 'out', text: '2026-10-12T09:00:06: utc second' },
        { stream: 'err', text: '2026-10-12T09:00:01: utc err earlier' },
      ],
    });
    s = reduce(s, {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: '2026-10-12T12:00:07: local third' }],
    });
    const texts = (x: MonitState) =>
      visibleFlat(x).map((l) => l.text.slice(21));
    expect(texts(s)).toEqual([
      'local first',
      'utc err earlier',
      'utc second',
      'local third',
    ]); // one poll's out and err still merge by stamp
    const oneHost = reduce(s, {
      type: 'rows',
      rows: [row('api'), row('web')],
      at: new Date(0),
    });
    expect(texts(oneHost)).toEqual([
      'utc err earlier',
      'utc second',
      'local first',
      'local third',
    ]);
  });
});

describe('selection while hosts answer one by one', () => {
  it('until the user moves it, the selection is the first app of the rows so far; after that it stays on the app the user chose', () => {
    let s = initialState({
      project: 'demo',
      host: 'all',
      hosts: ['all', 'local', 'box'],
      apps,
    });
    s = reduce(s, {
      type: 'rows',
      rows: [{ ...row('web'), host: 'box', status: 'unreachable' }],
    }); // the silent host fails first
    expect(selectedRow(s)?.app).toBe('web');
    s = reduce(s, {
      type: 'rows',
      rows: [row('api'), { ...row('web'), host: 'box', status: 'unreachable' }],
      at: new Date(1),
    });
    expect(selectedRow(s)?.app).toBe('api');
    expect(s.logPaths).toBeNull();
    s = reduce(s, { type: 'select', delta: 1 });
    s = reduce(s, {
      type: 'rows',
      rows: [row('api'), { ...row('web'), host: 'box' }],
      at: new Date(2),
    });
    expect(selectedRow(s)?.app).toBe('web');
    s = reduce(s, { type: 'host', host: 'local' }); // a new view starts unchosen again
    s = reduce(s, {
      type: 'rows',
      rows: [row('web'), row('api')],
      at: new Date(3),
    });
    expect(selectedRow(s)?.app).toBe('web');
  });
});

describe('the clear key', () => {
  const rows = () =>
    reduce(s0(), {
      type: 'rows',
      rows: [row('api'), row('web', 'stopped'), row('worker')],
    });
  it('c arms with a notice naming the running apps; c again within CONFIRM_MS clears them; later it arms again', () => {
    const i1 = keyIntent('c', rows(), 1000);
    expect(i1).toEqual({
      kind: 'action',
      action: { type: 'arm', at: 1000, apps: ['api', 'worker'] },
    });
    const s1 = reduce(rows(), {
      type: 'arm',
      at: 1000,
      apps: ['api', 'worker'],
    });
    expect(s1.notice).toBe(
      'press c again to clear the logs of api, worker (incidents start over there)'
    );
    expect(keyIntent('c', s1, 1000 + CONFIRM_MS)).toEqual({
      kind: 'clear',
      apps: ['api', 'worker'],
    });
    expect(keyIntent('c', s1, 1001 + CONFIRM_MS)).toMatchObject({
      kind: 'action',
      action: { type: 'arm', at: 1001 + CONFIRM_MS },
    });
  });
  it('a cancel takes the prompt away; with nothing running, or while busy, c does nothing', () => {
    const s1 = reduce(rows(), { type: 'arm', at: 1000, apps: ['api'] });
    expect(reduce(s1, { type: 'arm', at: null })).toMatchObject({
      armedAt: null,
      notice: null,
    });
    expect(
      keyIntent('c', reduce(rows(), { type: 'busy', busy: true }), 0)
    ).toBeNull();
    expect(
      keyIntent(
        'c',
        reduce(s0(), { type: 'rows', rows: [row('api', 'stopped')] }),
        0
      )
    ).toBeNull();
  });
  it('the recorded clears are kept as the store has them', () => {
    expect(
      reduce(s0(), {
        type: 'cleared',
        cleared: { 'local/api': '2026-10-12T15:04:05' },
      }).cleared
    ).toEqual({ 'local/api': '2026-10-12T15:04:05' });
  });
});

describe('flat view order', () => {
  it('lines of one host follow their stamp, then their arrival: never grouped app by app within a stamp', () => {
    let s = reduce(s0(), { type: 'view', view: 'flat' });
    for (const [app, text] of [
      ['api', 'a1'],
      ['web', 'w1'],
      ['api', 'a2'],
      ['web', 'w2'],
    ])
      s = reduce(s, {
        type: 'logs',
        app,
        lines: [{ stream: 'out', text: `2026-10-12T11:00:00: ${text}` }],
      });
    s = reduce(s, {
      type: 'logs',
      app: 'web',
      lines: [{ stream: 'out', text: '2026-10-11T23:59:59.999: older' }],
    });
    expect(visibleFlat(s).map((l) => l.text.split(' ')[1])).toEqual([
      'older',
      'a1',
      'w1',
      'a2',
      'w2',
    ]);
  });
});

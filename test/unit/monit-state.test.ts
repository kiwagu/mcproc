import { describe, it, expect } from 'vitest';
import { initialState, reduce, keyIntent, selectedRow, visibleLogs, visibleFlat, type MonitState } from '../../src/monit/state.js';
import type { LsRow } from '../../src/core/list.js';

const row = (app: string, status = 'online'): LsRow => ({ app, kind: 'server', description: `${app} desc`, status, pm_id: 0, pid: 1, uptime_ms: 0, restarts: 0, cpu: 0, memory: 0, procs: 1, runtime: null, pm2_cpu: 0, pm2_memory: 0, metrics_source: 'tree', url: null, url_status: 'unchecked', url_code: null, ports: { actual: [], declared: [], checks: [], undeclared: [] } });
const apps = { api: { description: 'd', run: 'r', cwd: '.', pm2Name: 'demo-api' }, web: { description: 'd', run: 'r', cwd: '.', pm2Name: 'demo-web' } };
const s0 = (): MonitState => reduce(initialState({ project: 'demo', host: 'local', hosts: ['local', 'stand'], apps, maxLogs: 5 }), { type: 'rows', rows: [row('api'), row('web')], at: new Date(0) });

describe('reduce', () => {
  it('rows keep the selection by app name and clear a previous error', () => {
    let s = reduce(s0(), { type: 'select', delta: 1 });
    s = reduce(s, { type: 'error', message: 'boom' });
    s = reduce(s, { type: 'rows', rows: [row('web'), row('api')], at: new Date(1) });
    expect(selectedRow(s)?.app).toBe('web');
    expect(s.selected).toBe(0);
    expect(s.error).toBeNull();
  });
  it('select clamps and switches the log view to the other app\'s buffer; buffers are kept per app; stream switches', () => {
    let s = reduce(s0(), { type: 'logs', app: 'api', lines: [{ stream: 'out', text: 'x' }] });
    s = reduce(s, { type: 'select', delta: -5 });
    expect(s.selected).toBe(0);
    expect(visibleLogs(s)).toHaveLength(1);   // no change of selection, logs kept
    s = reduce(s, { type: 'select', delta: 1 });
    expect(s.selected).toBe(1);
    expect(visibleLogs(s)).toEqual([]);       // web has no lines yet
    expect(s.logs.api).toHaveLength(1);       // api's buffer waits for the next selection: no view consumes another's history
    expect(reduce(s, { type: 'stream', stream: 'err' }).stream).toBe('err');
  });
  it('logs append per app, cap at maxLogs keeping the newest, and reset replaces', () => {
    let s = s0();
    for (let i = 0; i < 8; i++) s = reduce(s, { type: 'logs', app: 'api', lines: [{ stream: 'out', text: `l${i}` }] });
    expect(s.logs.api.map((l) => l.text)).toEqual(['l3', 'l4', 'l5', 'l6', 'l7']);
    s = reduce(s, { type: 'logs', app: 'api', lines: [{ stream: 'out', text: 'fresh' }], reset: true });
    expect(s.logs.api.map((l) => l.text)).toEqual(['fresh']);
  });
  it('error keeps the rows (an unreachable host must not blank the screen); host switch resets', () => {
    let s = reduce(s0(), { type: 'error', message: 'ssh: Connection refused' });
    expect(s.rows).toHaveLength(2);
    expect(s.error).toContain('refused');
    s = reduce(s, { type: 'host', host: 'stand' });
    expect(s).toMatchObject({ host: 'stand', rows: [], logs: {}, selected: 0, error: null });
  });
});

describe('keyIntent', () => {
  it('maps keys to intents; commands need a selected app and an idle screen', () => {
    const s = s0();
    // the wheel arrives as arrow keys when mouse tracking is off, so ↑↓ scroll the log pane; the selection moves with j/k and Tab
    expect(keyIntent('down', s)).toEqual({ kind: 'action', action: { type: 'scroll', delta: -1 } });
    expect(keyIntent('up', s)).toEqual({ kind: 'action', action: { type: 'scroll', delta: 1 } });
    expect(keyIntent('pageup', s)).toEqual({ kind: 'action', action: { type: 'scroll', delta: 10 } });
    expect(keyIntent('end', s)).toEqual({ kind: 'action', action: { type: 'scroll', delta: -Infinity } });
    expect(keyIntent('j', s)).toEqual({ kind: 'action', action: { type: 'select', delta: 1 } });
    expect(keyIntent('k', s)).toEqual({ kind: 'action', action: { type: 'select', delta: -1 } });
    expect(keyIntent('tab', s)).toEqual({ kind: 'action', action: { type: 'select', delta: 1 } });
    expect(keyIntent('S-tab', s)).toEqual({ kind: 'action', action: { type: 'select', delta: -1 } });
    expect(keyIntent('e', s)).toEqual({ kind: 'action', action: { type: 'stream', stream: 'err' } });
    expect(keyIntent('r', s)).toEqual({ kind: 'command', cmd: 'restart', app: 'api' });
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
    for (let i = 0; i < 4; i++) s = reduce(s, { type: 'logs', app: 'api', lines: [{ stream: 'out', text: `l${i}` }] });
    expect(s.logScroll).toBe(0);
    s = reduce(s, { type: 'scroll', delta: 2 });
    expect(s.logScroll).toBe(2);
    s = reduce(s, { type: 'scroll', delta: 10 });
    expect(s.logScroll).toBe(3); // never beyond the oldest entry
    expect(reduce(s, { type: 'scroll', delta: 10, max: 1 }).logScroll).toBe(1); // the screen passes the pane's real ceiling
    s = reduce(s, { type: 'logs', app: 'api', lines: [{ stream: 'out', text: 'l4' }] });
    expect(s.logScroll).toBe(4); // the view did not move when a line was appended below it (maxLogs 5: l0..l4)
    s = reduce(s, { type: 'scroll', delta: -1 });
    expect(s.logScroll).toBe(3);
    s = reduce(s, { type: 'scroll', delta: -Infinity });
    expect(s.logScroll).toBe(0);
    s = reduce(reduce(s, { type: 'scroll', delta: 2 }), { type: 'select', delta: 1 });
    expect(s.logScroll).toBe(0);
    s = reduce(reduce(s, { type: 'scroll', delta: 2 }), { type: 'logs', app: 'api', lines: [{ stream: 'out', text: 'fresh' }], reset: true });
    expect(s.logScroll).toBe(0);
  });
});

describe('flat view', () => {
  it('f toggles the flat view; commands need a visible selection, so they are off there; flat lines append, cap and sort by stamp across apps', () => {
    let s = s0();
    expect(s.view).toBe('dashboard');
    expect(keyIntent('f', s)).toEqual({ kind: 'action', action: { type: 'view', view: 'flat' } });
    s = reduce(s, { type: 'view', view: 'flat' });
    expect(keyIntent('f', s)).toEqual({ kind: 'action', action: { type: 'view', view: 'dashboard' } });
    expect(keyIntent('r', s)).toBeNull();
    expect(keyIntent('q', s)).toEqual({ kind: 'quit' });
    s = reduce(s, { type: 'logs', app: 'web', lines: [{ stream: 'out', text: '2026-10-11T13:00:08: w' }] });
    s = reduce(s, { type: 'logs', app: 'api', lines: [{ stream: 'err', text: '2026-10-11T13:00:07: a' }] });
    expect(visibleFlat(s).map((l) => `${l.app}:${l.text}`)).toEqual(['api:2026-10-11T13:00:07: a', 'web:2026-10-11T13:00:08: w']); // one buffer per app, merged by stamp
    for (let i = 0; i < 6; i++) s = reduce(s, { type: 'logs', app: 'api', lines: [{ stream: 'out', text: `l${i}` }] });
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
    let s = reduce(s0(), { type: 'logs', app: 'api', lines: [{ stream: 'err', text: '2026-10-11T13:00:08: boom' }, { stream: 'out', text: '2026-10-11T13:00:07: a' }] });
    expect(visibleLogs(s).map((l) => l.text)).toEqual(['2026-10-11T13:00:07: a', '2026-10-11T13:00:08: boom']);
    s = reduce(s, { type: 'stream', stream: 'out' });
    expect(visibleLogs(s).map((l) => l.text)).toEqual(['2026-10-11T13:00:07: a']);
  });
});

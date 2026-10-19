import { describe, it, expect } from 'vitest';
import { CONFIRM_MS } from '../../src/monit/state.js';
import {
  initialOverview,
  overviewKey,
  overviewRows,
  reduceOverview,
  selectedOverviewRow,
  type OverviewIntent,
} from '../../src/monit/stacks-state.js';
import type { StacksView } from '../../src/core/stacks/collect.js';

const stack = (project: string, root: string, extra: object = {}) => ({
  project,
  root,
  base_project: project,
  slot: null,
  branch: null,
  source: 'registry',
  hosts: [
    {
      name: 'local',
      endpoint: 'local',
      reachable: true,
      error: null,
      age_s: 0,
    },
  ],
  apps: { total: 2, online: 2, errored: 0, stopped: 0, queued: 0 },
  queue_position: null,
  memory: 1,
  cpu: 1,
  ports: [],
  manifest_error: null,
  notes: [],
  present: true,
  rows: [
    { app: 'web', pm_id: 1, status: 'online' },
    { app: 'job', pm_id: 2, status: 'stopped' },
  ],
  ...extra,
});
const view = (stacks: object[], orphans: object[] = []) =>
  ({
    answer: { host: {}, stacks, orphans },
    stacks,
    manifests: new Map(),
  }) as unknown as StacksView;
const at = new Date('2026-10-19T10:00:00');

describe('overview state', () => {
  it('the selection follows a stack by root across refreshes, and falls back to the same index', () => {
    let s = initialOverview({ selected: '/b' });
    s = reduceOverview(s, {
      type: 'view',
      view: view([stack('a', '/a'), stack('b', '/b')]),
      at,
    });
    expect(selectedOverviewRow(s)?.key).toBe('/b');
    s = reduceOverview(s, {
      type: 'view',
      view: view([stack('b', '/b'), stack('a', '/a')]),
      at,
    });
    expect(selectedOverviewRow(s)?.key).toBe('/b');
    s = reduceOverview(s, {
      type: 'view',
      view: view([stack('c', '/c'), stack('a', '/a')]),
      at,
    });
    expect(selectedOverviewRow(s)?.key).toBe('/c'); // /b gone: the row now at its index
  });
  it('rows are the stacks, then the orphans', () => {
    const s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view(
        [stack('a', '/a')],
        [{ namespace: 'default', endpoint: 'local', processes: [], note: null }]
      ),
      at,
    });
    expect(overviewRows(s).map((r) => r.key)).toEqual([
      '/a',
      'orphan:local:default',
    ]);
  });
  it('keys: j/k select, enter opens, a toggles all, q and escape quit', () => {
    const s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view([stack('a', '/a'), stack('b', '/b')]),
      at,
    });
    expect(overviewKey('j', s)).toEqual({
      kind: 'action',
      action: { type: 'select', delta: 1 },
    });
    expect(overviewKey('up', s)).toEqual({
      kind: 'action',
      action: { type: 'select', delta: -1 },
    });
    expect(overviewKey('enter', s)).toEqual({ kind: 'open', root: '/a' });
    expect(overviewKey('a', s)).toEqual({
      kind: 'action',
      action: { type: 'toggle-all' },
    });
    expect(overviewKey('q', s)).toEqual({ kind: 'quit' });
    expect(overviewKey('escape', s)).toEqual({ kind: 'quit' });
  });
  it('x arms with a prompt naming the running apps; a second x in time stops; late, it arms again', () => {
    let s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view([stack('a', '/a')]),
      at,
    });
    const first = overviewKey('x', s, 1000);
    expect(first).toEqual({
      kind: 'action',
      action: { type: 'arm', at: 1000 },
    });
    s = reduceOverview(
      s,
      (first as Extract<OverviewIntent, { kind: 'action' }>).action
    );
    expect(s.notice).toBe('press x again to stop 1 app of a');
    expect(overviewKey('x', s, 1000 + CONFIRM_MS)).toEqual({
      kind: 'stop',
      root: '/a',
    });
    expect(overviewKey('x', s, 1001 + CONFIRM_MS)).toEqual({
      kind: 'action',
      action: { type: 'arm', at: 1001 + CONFIRM_MS },
    });
  });
  it('enter and x refuse an orphan and a stack whose manifest did not load, saying why', () => {
    const s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view(
        [
          stack('bad', '/bad', {
            manifest_error: { code: 'MANIFEST_INVALID', message: 'apps: bad' },
          }),
        ],
        [{ namespace: 'default', endpoint: 'local', processes: [], note: null }]
      ),
      at,
    });
    expect(overviewKey('enter', s)).toEqual({
      kind: 'action',
      action: {
        type: 'notice',
        message: 'bad: the manifest did not load (MANIFEST_INVALID)',
      },
    });
    const o = reduceOverview(s, { type: 'select', delta: 1 });
    expect(overviewKey('x', o)).toEqual({
      kind: 'action',
      action: { type: 'notice', message: 'not an mcproc stack: read-only' },
    });
    expect(overviewKey('enter', o)).toEqual({
      kind: 'action',
      action: {
        type: 'notice',
        message: 'not an mcproc stack: no manifest to open',
      },
    });
  });
  it('enter refuses a stack none of whose hosts answers; one reachable host is enough to open', () => {
    const down = (name: string) => ({
      name,
      endpoint: name,
      reachable: false,
      error: 'container stopped',
      age_s: 30,
    });
    const up = {
      name: 'local',
      endpoint: 'local',
      reachable: true,
      error: null,
      age_s: 0,
    };
    const s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view([
        stack('gone', '/gone', { hosts: [down('ws'), down('box')] }),
        stack('none', '/none', { hosts: [] }),
        stack('mixed', '/mixed', { hosts: [down('ws'), up] }),
      ]),
      at,
    });
    expect(overviewKey('enter', s)).toEqual({
      kind: 'action',
      action: {
        type: 'notice',
        message: 'gone: no host of this stack answers (ws: container stopped)',
      },
    });
    const none = reduceOverview(s, { type: 'select', delta: 1 });
    expect(overviewKey('enter', none)).toEqual({
      kind: 'action',
      action: {
        type: 'notice',
        message: 'none: no host of this stack answers',
      },
    });
    const mixed = reduceOverview(none, { type: 'select', delta: 1 });
    expect(overviewKey('enter', mixed)).toEqual({
      kind: 'open',
      root: '/mixed',
    });
  });
  it('x on a stack whose manifest did not load says why; x does nothing while busy; C-c quits', () => {
    const bad = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view([
        stack('bad', '/bad', {
          manifest_error: { code: 'MANIFEST_INVALID', message: 'apps: bad' },
        }),
      ]),
      at,
    });
    expect(overviewKey('x', bad)).toEqual({
      kind: 'action',
      action: {
        type: 'notice',
        message: 'bad: the manifest did not load (MANIFEST_INVALID)',
      },
    });
    const ok = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view([stack('a', '/a')]),
      at,
    });
    expect(
      overviewKey('x', reduceOverview(ok, { type: 'busy', busy: true }))
    ).toBeNull();
    expect(overviewKey('C-c', ok)).toEqual({ kind: 'quit' });
  });
  it('enter and x refuse a stack whose slug another checkout declares on the same pm2: they share pm2 names', () => {
    const s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: view([stack('demo', '/b', { rivals: ['/a'] })]),
      at,
    });
    const why = (what: string) => ({
      kind: 'action',
      action: {
        type: 'notice',
        message: `demo: 2 checkouts share this slug on one pm2, so ${what} could reach another one's processes; give each checkout its own project slug`,
      },
    });
    expect(overviewKey('enter', s)).toEqual(why('its monit'));
    expect(overviewKey('x', s)).toEqual(why('a stop'));
  });
  it('a refresh that moves the selection to another stack disarms x, so it never stops a stack the prompt did not name', () => {
    let s = initialOverview({ selected: '/b' });
    s = reduceOverview(s, {
      type: 'view',
      view: view([stack('a', '/a'), stack('b', '/b')]),
      at,
    });
    s = reduceOverview(s, { type: 'arm', at: 1000 });
    expect(s.notice).toBe('press x again to stop 1 app of b');
    const kept = reduceOverview(s, {
      type: 'view',
      view: view([stack('b', '/b'), stack('a', '/a')]),
      at,
    });
    expect(overviewKey('x', kept, 1500)).toEqual({ kind: 'stop', root: '/b' });
    s = reduceOverview(s, {
      type: 'view',
      view: view([stack('a', '/a'), stack('c', '/c')]),
      at,
    });
    expect(selectedOverviewRow(s)?.key).toBe('/c');
    expect(s.armedAt).toBeNull();
    expect(s.notice).toBeNull();
    expect(overviewKey('x', s, 1500)).toEqual({
      kind: 'action',
      action: { type: 'arm', at: 1500 },
    });
  });
});

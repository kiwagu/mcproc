import { describe, it, expect } from 'vitest';
import {
  initialOverview,
  reduceOverview,
} from '../../src/monit/stacks-state.js';
import {
  overviewToText,
  renderOverview,
} from '../../src/monit/stacks-frame.js';
import { displayWidth } from '../../src/monit/screentext.js';
import type { StacksView } from '../../src/core/stacks/collect.js';

const row = (app: string, status: string) => ({
  app,
  host: 'local',
  status,
  uptime_ms: 60_000,
  memory: 1_000_000,
  cpu: 1,
  pm_id: 1,
  ports: { actual: [], declared: [], checks: [], undeclared: [] },
});
const stacks = [
  {
    project: 'alpha',
    root: '/home/u/a/really/long/path/to/the/checkout/alpha',
    base_project: 'alpha',
    slot: 0,
    branch: 'main',
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
    apps: { total: 2, online: 1, errored: 0, stopped: 1, queued: 0 },
    queue_position: null,
    memory: 1_000_000,
    cpu: 3,
    ports: [{ app: 'web', port: 3000 }],
    manifest_error: null,
    notes: [],
    present: true,
    rows: [row('web', 'online'), row('job', 'stopped')],
  },
];
const view = {
  answer: {
    host: { name: 'box', memory: null, watcher: null, queue: 0, notes: [] },
    stacks,
    orphans: [
      {
        namespace: 'default',
        endpoint: 'local',
        processes: [{ name: 'loose', status: 'online', memory: 1 }],
        note: null,
      },
    ],
  },
  stacks,
  manifests: new Map(),
} as unknown as StacksView;
const state = () =>
  reduceOverview(initialOverview({}), {
    type: 'view',
    view,
    at: new Date('2026-10-19T10:00:00'),
  });

describe('renderOverview', () => {
  it('the header keeps the host warnings when stacks are listed too', () => {
    const noted = {
      ...view,
      answer: {
        ...view.answer,
        host: { ...view.answer.host, notes: ['registry unreadable: EACCES'] },
      },
    } as unknown as StacksView;
    const f = renderOverview(
      reduceOverview(initialOverview({}), {
        type: 'view',
        view: noted,
        at: new Date(),
      }),
      { width: 160, height: 24 }
    );
    expect(f.header).toContain('registry unreadable: EACCES');
    expect(f.table.length).toBeGreaterThan(1);
  });
  it('fits 80 and 120 columns: the marker on the selected stack, ROOT cut at its start, the orphan last', () => {
    for (const width of [80, 120]) {
      const f = renderOverview(state(), { width, height: 24 });
      for (const l of [
        f.header,
        f.title,
        ...f.table,
        f.appsTitle,
        ...f.apps,
        f.footer,
      ])
        expect(displayWidth(l)).toBeLessThanOrEqual(width);
      expect(f.table[0]).toMatch(/^ STACK\s+ROOT/);
      expect(f.table[1]).toMatch(/^▶alpha/);
      expect(f.table.at(-1)).toMatch(/^ pm2 · default/);
    }
    // ROOT is cut at its start, so the checkout's own folder stays visible
    expect(renderOverview(state(), { width: 80, height: 24 }).table[1]).toMatch(
      /^▶alpha\s+…\S*\/checkout\/alpha\s/
    );
  });
  it('the lower pane shows the selected stack apps; the footer the legend, a notice before it', () => {
    const f = renderOverview(state(), { width: 100, height: 24 });
    expect(f.appsTitle).toContain('apps · alpha');
    expect(f.apps[0]).toMatch(/^APP\s+HOST\s+STATUS/);
    expect(f.apps[1]).toMatch(/^web\s+local\s+online/);
    expect(f.footer).toContain('enter open');
    const n = renderOverview(
      reduceOverview(state(), {
        type: 'notice',
        message: 'stopped 2 apps of alpha',
      }),
      { width: 100, height: 24 }
    );
    expect(n.footer).toMatch(/^stopped 2 apps of alpha {2}│ /);
  });
  it('text for agents has no escapes', () => {
    expect(
      overviewToText(renderOverview(state(), { width: 100, height: 24 }))
    ).not.toMatch(/\x1b/);
  });
  it('a worktree sits indented under its listed base, and names its base when that base is not listed', () => {
    const wt = (
      project: string,
      base: string,
      slot: number,
      branch: string
    ) => ({
      ...stacks[0],
      project,
      base_project: base,
      slot,
      branch,
      root: `/home/u/${project}`,
    });
    const listed = [
      stacks[0],
      wt('alpha-w1', 'alpha', 1, 'feat'),
      wt('beta-w2', 'beta', 2, 'fix'),
    ];
    const v = {
      ...view,
      stacks: listed,
      answer: { ...view.answer, stacks: listed, orphans: [] },
    } as unknown as StacksView;
    const s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: v,
      at: new Date('2026-10-19T10:00:00'),
    });
    const t = renderOverview(s, { width: 120, height: 24 }).table;
    expect(t[1]).toMatch(/^▶alpha\s/);
    expect(t[2]).toMatch(/^ {3}w1 feat\s/);
    expect(t[3]).toMatch(/^ beta w2 fix\s/);
  });
  it('with nothing to list, the header keeps its column and the lower pane says why', () => {
    const empty = {
      answer: {
        host: { ...view.answer.host, notes: ['local pm2: connect refused'] },
        stacks: [],
        orphans: [],
      },
      stacks: [],
      manifests: new Map(),
    } as unknown as StacksView;
    const f = renderOverview(
      reduceOverview(initialOverview({}), {
        type: 'view',
        view: empty,
        at: new Date('2026-10-19T10:00:00'),
      }),
      { width: 100, height: 24 }
    );
    expect(f.table).toHaveLength(1);
    expect(f.table[0]).toMatch(/^ STACK\s+ROOT/);
    expect(f.apps).toEqual([
      'local pm2: connect refused',
      'no stacks running on this host · a: all known',
    ]);
    expect(
      renderOverview(initialOverview({}), { width: 100, height: 24 }).header
    ).toBe('mcproc · reading the stacks…');
  });
  it('the stacks pane scrolls to keep the selection in view and leaves room for the apps', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...stacks[0],
      project: `s${i}`,
      base_project: `s${i}`,
      root: `/home/u/s${i}`,
    }));
    const v = {
      ...view,
      stacks: many,
      answer: { ...view.answer, stacks: many, orphans: [] },
    } as unknown as StacksView;
    let s = reduceOverview(initialOverview({}), {
      type: 'view',
      view: v,
      at: new Date('2026-10-19T10:00:00'),
    });
    s = reduceOverview(s, { type: 'select', delta: 20 });
    const f = renderOverview(s, { width: 100, height: 24 });
    expect(4 + f.table.length + f.apps.length).toBeLessThanOrEqual(24);
    expect(f.apps.length).toBeGreaterThanOrEqual(3);
    expect(f.table[0]).toMatch(/^ STACK/);
    expect(f.table.some((l) => /^▶s20\s/.test(l))).toBe(true);
  });
});

import { describe, it, expect, vi, type Mock } from 'vitest';

vi.mock('../../src/monit/screentext.js', async (orig) => {
  const m = await orig<typeof import('../../src/monit/screentext.js')>();
  return { ...m, screenText: vi.fn(m.screenText) };
});
import { screenText } from '../../src/monit/screentext.js';
import {
  initialState,
  reduce,
  visibleFlat,
  type MonitState,
} from '../../src/monit/state.js';
import { renderFrame } from '../../src/monit/frame.js';
import type { LsRow } from '../../src/core/list.js';

const row = (app: string): LsRow => ({
  app,
  host: 'local',
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
const apps = Object.fromEntries(
  ['web', 'api'].map((a) => [
    a,
    { description: a, run: 'x', cwd: '.', pm2Name: `p-${a}` },
  ])
);
const lines = (app: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    stream: 'out' as const,
    text: `2026-10-12T11:00:${String(i % 60).padStart(2, '0')}: \x1b[35mlevel=\x1b[0minfo ${app} line ${i} ${'x'.repeat(i % 3 ? 20 : 150)}`,
  }));
function filled(): MonitState {
  let s = reduce(
    initialState({ project: 'p', host: 'local', hosts: ['local'], apps }),
    { type: 'rows', rows: [row('web'), row('api')], at: new Date(0) }
  );
  s = reduce(s, { type: 'logs', app: 'web', lines: lines('web', 500) });
  return reduce(s, { type: 'logs', app: 'api', lines: lines('api', 500) });
}
/** How many log lines have been turned into screen text so far (log text is the only caller with colors kept). */
const cleaned = () =>
  (screenText as Mock).mock.calls.filter(
    (c) => (c[1] as { colors?: boolean } | undefined)?.colors
  ).length;
const size = { width: 120, height: 40 };

describe('render cost while scrolling', () => {
  for (const view of ['dashboard', 'flat'] as const) {
    it(`${view}: a log line becomes screen rows once; a repeat render, a scroll back and forth clean none again; a new line cleans just itself`, () => {
      let s = reduce(filled(), { type: 'view', view });
      renderFrame(s, size);
      const first = cleaned();
      expect(first).toBeGreaterThan(0);
      renderFrame(s, size);
      expect(cleaned()).toBe(first);
      const up = reduce(s, { type: 'scroll', delta: 5, max: 10_000 });
      renderFrame(up, size);
      const scrolled = cleaned();
      renderFrame(reduce(up, { type: 'scroll', delta: -5 }), size);
      renderFrame(up, size);
      expect(cleaned()).toBe(scrolled);
      s = reduce(s, {
        type: 'logs',
        app: 'web',
        lines: [{ stream: 'out', text: '2026-10-12T11:59:59: fresh line' }],
      }); // the newest stamp: it lands at the tail of both views
      renderFrame(s, size);
      expect(cleaned()).toBe(scrolled + 1);
    });
  }
  it('another width wraps again, with the rows of that width', () => {
    const s = filled();
    const wide = renderFrame(s, { width: 160, height: 40 }).logs;
    const narrow = renderFrame(s, { width: 60, height: 40 }).logs;
    expect(narrow).not.toEqual(wide);
    for (const r of narrow)
      expect(r.replace(/\x1b\[[0-9;:]*m/g, '').length).toBeLessThanOrEqual(60);
  });
  it('the merged stream is computed once per change of the buffers, with the same line objects each time', () => {
    const s = reduce(filled(), { type: 'view', view: 'flat' });
    const a = visibleFlat(s);
    expect(visibleFlat(s)).toBe(a);
    const scrolled = reduce(s, { type: 'scroll', delta: 3, max: 100 });
    expect(visibleFlat(scrolled)).toBe(a);
    const more = reduce(s, {
      type: 'logs',
      app: 'api',
      lines: [{ stream: 'out', text: 'x' }],
    });
    const b = visibleFlat(more);
    expect(b).not.toBe(a);
    expect(b[0]).toBe(a[0]); // the lines already there keep their objects: their rows stay cached
  });
});

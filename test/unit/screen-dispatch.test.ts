import { describe, it, expect } from 'vitest';
import { screenDispatch } from '../../src/monit/dispatch.js';
import {
  initialState,
  reduce,
  type MonitState,
} from '../../src/monit/state.js';
import { renderFrame, type Frame } from '../../src/monit/frame.js';
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
  containers_memory: 0,
  procs: 1,
  runtime: null,
  pm2_cpu: 0,
  pm2_memory: 0,
  exit_code: null,
  metrics_source: 'tree',
  url: null,
  url_status: 'unchecked',
  url_code: null,
  url_from: null,
  url_reason: null,
  ports: { actual: [], declared: [], checks: [], undeclared: [] },
});
const size = { width: 100, height: 30 };
const tick = () => new Promise((r) => setTimeout(r, 0));

function screen(start: MonitState) {
  let state = start;
  const shown: Frame[] = [];
  let renders = 0;
  const d = screenDispatch({
    get: () => state,
    set: (s) => {
      state = s;
    },
    render: (s) => {
      renders++;
      return renderFrame(s, size);
    },
    show: (f) => {
      shown.push(f);
    },
  });
  return {
    d,
    shown,
    get state() {
      return state;
    },
    get renders() {
      return renders;
    },
  };
}
function flatStderrView(): MonitState {
  let s = reduce(
    initialState({
      project: 'p',
      host: 'local',
      hosts: ['local'],
      apps: { web: { description: 'w', run: 'x', cwd: '.', pm2Name: 'p-web' } },
    }),
    { type: 'rows', rows: [row('web')], at: new Date(0) }
  );
  s = reduce(s, { type: 'view', view: 'flat' });
  s = reduce(s, {
    type: 'logs',
    app: 'web',
    lines: [
      { stream: 'err', text: 'one error' },
      ...Array.from({ length: 100 }, (_, i) => ({
        stream: 'out' as const,
        text: `out ${i}`,
      })),
    ],
  });
  return reduce(s, { type: 'stream', stream: 'err' });
}

describe('screenDispatch', () => {
  it('a key that changes the pane, then a scroll in the same input chunk: the scroll uses the ceiling of the pane as it is now', async () => {
    const sc = screen(flatStderrView());
    sc.d.paint(); // painted: one stderr line, ceiling 0
    expect(sc.shown.at(-1)!.maxScroll).toBe(0);
    sc.d.dispatch({ type: 'stream', stream: 'both' }); // `b`
    sc.d.dispatch({ type: 'scroll', delta: Infinity }); // Home, same chunk
    await tick();
    const f = sc.shown.at(-1)!;
    expect(f.maxScroll).toBeGreaterThan(0);
    expect(f.scroll).toBe(f.maxScroll); // at the top of the 101 lines, not stuck at the tail
  });
  it('a burst of scroll keys paints once and measures nothing extra', async () => {
    const sc = screen(
      reduce(flatStderrView(), { type: 'stream', stream: 'both' })
    );
    sc.d.paint();
    const renders = sc.renders;
    sc.d.dispatch({ type: 'scroll', delta: 1 });
    sc.d.dispatch({ type: 'scroll', delta: 1 });
    sc.d.dispatch({ type: 'scroll', delta: 1 });
    await tick();
    expect(sc.shown).toHaveLength(2); // the first paint and one for the burst
    expect(sc.renders).toBe(renders + 1); // only that paint rendered: the ceiling was known
    expect(sc.state.logScroll).toBe(3);
  });
});

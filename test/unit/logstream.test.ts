import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { parseJlist } from '../../src/core/pm2.js';
import { EMPTY_STATS } from '../../src/core/stats.js';
import type { Snapshot } from '../../src/core/list.js';
import { formatLine, colorFor, streamLogs, type StreamDeps } from '../../src/core/logstream.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const procsOf = (apps: string[]) => parseJlist(JSON.stringify(apps.map((a, i) => ({ pid: 100 + i, name: `demo-${a}`, pm_id: i, pm2_env: { status: 'online', namespace: 'demo', pm_out_log_path: `/l/${a}-out`, pm_err_log_path: `/l/${a}-err` } }))));
const snap = (apps: string[]): Snapshot => ({ procs: procsOf(apps), ports: {}, listeners: [], tree: new Map(), stats: EMPTY_STATS, metrics: {}, sampledAt: 0, urls: new Map() });

/** Fake followers: a queue of poll results per app; an exhausted queue yields no lines. */
function harness(running: string[], polls: Record<string, { lines: { stream: 'out' | 'err'; text: string }[]; reset?: boolean }[]>, later: string[][] = []) {
  const ctx = fakeCtx(basic, 'local', []);
  const out: string[] = []; let snapshots = 0; let sleeps = 0;
  const deps: StreamDeps = {
    snapshot: async () => snap(later[snapshots++] ?? running),
    follower: (_ctx, paths) => { const app = /\/l\/(.*)-out$/.exec(paths.out)![1]; return { poll: async () => { const r = polls[app]?.shift(); return r ? { lines: r.lines, reset: r.reset ?? false } : { lines: [], reset: false }; } }; },
    sleep: async () => { sleeps++; },
    out: (s) => { out.push(s); },
  };
  return { ctx, deps, out, get sleeps() { return sleeps; } };
}
const base = { lines: 10, intervalMs: 1000, color: false, json: false, stream: 'both' as const, resolveEvery: 2 };

describe('formatLine', () => {
  it('pads the label to the width, marks stderr with !, colors only the label when asked', () => {
    expect(formatLine({ app: 'api', stream: 'out', text: 'hello' }, 6, null)).toBe('api    | hello');
    expect(formatLine({ app: 'worker', stream: 'err', text: 'boom' }, 6, null)).toBe('worker ! boom');
    const c = formatLine({ app: 'api', stream: 'out', text: 'hello' }, 6, 36);
    expect(c).toBe('\x1b[36mapi   \x1b[0m | hello');
    expect(colorFor(0)).toBe(36);
    expect(colorFor(6)).toBe(colorFor(0)); // the palette wraps
    expect(new Set([0, 1, 2, 3, 4, 5].map(colorFor)).size).toBe(6);
  });
});

describe('streamLogs', () => {
  it('one shot: history of every app in app order, stderr marked, not-started apps say so', async () => {
    const h = harness(['api'], { api: [{ lines: [{ stream: 'out', text: 'h1' }, { stream: 'err', text: 'e1' }] }] });
    await streamLogs(h.ctx, ['api', 'worker'], { ...base, follow: false }, h.deps);
    expect(h.out).toEqual(['api    | h1', 'api    ! e1', 'worker | (not started)']);
    expect(h.sleeps).toBe(0);
  });
  it('follow: polls every interval in app order, attaches apps that start later, stops on abort', async () => {
    const ac = new AbortController();
    const h = harness(['api'], {
      api: [{ lines: [{ stream: 'out', text: 'a0' }] }, { lines: [] }, { lines: [{ stream: 'out', text: 'a2' }] }, { lines: [{ stream: 'out', text: 'a3' }] }],
      worker: [{ lines: [{ stream: 'out', text: 'w-hist' }] }, { lines: [{ stream: 'out', text: 'w3' }] }],
    }, [['api'], ['api', 'worker']]); // the second snapshot (tick 2, resolveEvery 2) sees the worker up
    const deps: StreamDeps = { ...h.deps, sleep: async () => { h.deps.sleep(0); if (h.out.length >= 6) ac.abort(); } };
    await streamLogs(h.ctx, ['api', 'worker'], { ...base, follow: true, signal: ac.signal }, deps);
    expect(h.out).toEqual(['api    | a0', 'worker | (not started)', 'api    | a2', 'worker | w-hist', 'api    | a3', 'worker | w3']);
  });
  it('stdout and stderr of one app are merged by their pm2 timestamp, not printed as two blocks', async () => {
    const h = harness(['api'], { api: [{ lines: [{ stream: 'out', text: '2026-10-11T13:00:09: o' }, { stream: 'out', text: '2026-10-11T13:00:11: o2' }, { stream: 'err', text: '2026-10-11T13:00:10: e' }] }] });
    await streamLogs(h.ctx, ['api'], { ...base, follow: false }, h.deps);
    expect(h.out).toEqual(['api | 2026-10-11T13:00:09: o', 'api ! 2026-10-11T13:00:10: e', 'api | 2026-10-11T13:00:11: o2']);
  });
  it('a closed pipe (EPIPE on stdout) ends the stream quietly instead of crashing', async () => {
    const h = harness(['api'], { api: [{ lines: [{ stream: 'out', text: 'a' }, { stream: 'out', text: 'b' }] }, { lines: [{ stream: 'out', text: 'c' }] }] });
    const seen: string[] = [];
    const deps: StreamDeps = { ...h.deps, out: (s) => { if (seen.length === 1) throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }); seen.push(s); } };
    await expect(streamLogs(h.ctx, ['api'], { ...base, follow: true }, deps)).resolves.toBeUndefined();
    expect(seen).toEqual(['api | a']);
    expect(h.sleeps).toBe(0); // the follow loop never started: the reader is gone
  });
  it('json lines and the stream filter', async () => {
    let h = harness(['api'], { api: [{ lines: [{ stream: 'out', text: 'h1' }, { stream: 'err', text: 'e1' }] }] });
    await streamLogs(h.ctx, ['api'], { ...base, follow: false, json: true }, h.deps);
    expect(h.out.map((l) => JSON.parse(l))).toEqual([{ app: 'api', stream: 'out', text: 'h1' }, { app: 'api', stream: 'err', text: 'e1' }]);
    h = harness(['api'], { api: [{ lines: [{ stream: 'out', text: 'h1' }, { stream: 'err', text: 'e1' }] }] });
    await streamLogs(h.ctx, ['api'], { ...base, follow: false, stream: 'err' }, h.deps);
    expect(h.out).toEqual(['api ! e1']);
  });
});

import { describe, it, expect } from 'vitest';
import {
  cpuPercent,
  shortCommand,
  treeMetrics,
} from '../../src/core/metrics.js';
import type { ProcStats, StatSample } from '../../src/core/stats.js';
import type { Listener } from '../../src/core/ports.js';

const sample = (t: Record<number, number>): StatSample => ({
  ticks: new Map(Object.entries(t).map(([k, v]) => [Number(k), v])),
  ppid: new Map(),
});
const stats = (over: Partial<ProcStats> = {}): ProcStats => ({
  clkTck: 100,
  samples: [
    sample({ 10: 100, 11: 200, 12: 50 }),
    sample({ 10: 110, 11: 230, 12: 50 }),
  ],
  rssKb: new Map([
    [10, 9000],
    [11, 150000],
    [12, 2000],
  ]),
  args: new Map([
    [10, '/bin/bash -lc bun run dev'],
    [11, '/home/u/.bun/bin/bun --watch src/index.ts'],
    [12, 'esbuild --service'],
  ]),
  dockerPorts: new Map(),
  ...over,
});
const tree = new Set([10, 11, 12]);
const lst = (pid: number, port: number): Listener => ({
  proto: 'tcp',
  addr: '*',
  port,
  pid,
  pids: [pid],
  command: 'bun',
  container: null,
});

describe('cpuPercent', () => {
  it('sums tick deltas over the tree, per core percent', () => {
    expect(
      cpuPercent(tree, stats().samples[0], stats().samples[1], 100, 0.5)
    ).toBeCloseTo(80); // (10+30+0) ticks / 100 / 0.5 s
  });
  it('ignores pids missing from either sample (hot reload between samples)', () => {
    expect(
      cpuPercent(
        new Set([10, 11, 99]),
        sample({ 10: 100, 11: 200, 99: 500 }),
        sample({ 10: 110, 11: 230 }),
        100,
        1
      )
    ).toBeCloseTo(40);
  });
});

describe('shortCommand', () => {
  it('keeps the arguments, reduces argv0 to its basename', () => {
    expect(shortCommand('/home/u/.bun/bin/bun --watch src/index.ts')).toBe(
      'bun --watch src/index.ts'
    );
    expect(shortCommand('next-server (v16.2.9)')).toBe('next-server (v16.2.9)');
  });
});

describe('treeMetrics', () => {
  it('sums RSS, uses the inline second sample, picks the port holder as runtime', () => {
    const m = treeMetrics(tree, stats(), [lst(11, 8787)]);
    expect(m).toEqual({
      memory: 161000 * 1024,
      cpu: expect.closeTo(80, 1),
      procs: 3,
      runtime: 'bun --watch src/index.ts',
      metrics_source: 'tree',
    });
  });
  it('without a listener the largest-RSS process is the runtime; without a second sample cpu is null', () => {
    const m = treeMetrics(tree, stats({ samples: [stats().samples[0]] }), []);
    expect(m).toMatchObject({ cpu: null, runtime: 'bun --watch src/index.ts' });
  });
  it('uses prev + interval when given (monit refresh)', () => {
    const m = treeMetrics(tree, stats({ samples: [stats().samples[1]] }), [], {
      prev: stats().samples[0],
      intervalSec: 2,
    });
    expect(m?.cpu).toBeCloseTo(20);
  });
  it('returns null when the host gave no /proc stats, and zero for an empty tree', () => {
    expect(treeMetrics(tree, stats({ samples: [] }), [])).toBeNull();
    expect(treeMetrics(new Set(), stats(), [])).toEqual({
      memory: 0,
      cpu: 0,
      procs: 0,
      runtime: null,
      metrics_source: 'tree',
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  admit,
  estimateApps,
  needOf,
  reserveMib,
} from '../../src/core/leases/admission.js';
import {
  listCheckout,
  measureSiblings,
} from '../../src/core/leases/siblings.js';
import { loadManifest } from '../../src/core/manifest.js';
import type { LsRow } from '../../src/core/list.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const varsProj = path.join(here, '..', 'fixtures', 'projects', 'vars');
const m = loadManifest(varsProj);

describe('estimateApps', () => {
  it('takes the measured sibling value over the declared one and names the source', () => {
    const r = estimateApps(
      [m.apps.db, m.apps.api, m.apps.tool],
      new Map([['api', { mib: 300, slot: 0 }]])
    );
    expect(r.estimate_mib).toBe(812);
    expect(r.sources).toEqual({
      db: { mib: 512, source: 'declared' },
      api: { mib: 300, source: 'measured from slot 0' },
      tool: { mib: 0, source: 'none' },
    });
  });
  it('never lets a measurement undercut the declaration (a probe that missed the containers)', () => {
    const r = estimateApps(
      [m.apps.db],
      new Map([['db', { mib: 40, slot: 0 }]])
    );
    expect(r.sources).toEqual({ db: { mib: 512, source: 'declared' } });
  });
  it('needOf adds the margin, rounded up', () => {
    expect(needOf(812, 0.1)).toBe(894);
    expect(needOf(0, 0.1)).toBe(0);
    // 100 * 1.1 is 110.00000000000001 in floating point: rounded to six decimals first, not up to 111
    expect(needOf(100, 0.1)).toBe(110);
    expect(needOf(768, 0.2)).toBe(922);
  });
  it('reserveMib reads a size, or a percent of the total, or the default without a reading', () => {
    expect(reserveMib({ kind: 'mib', mib: 4096 }, null)).toBe(4096);
    expect(
      reserveMib(
        { kind: 'percent', ratio: 0.1 },
        { total_mib: 30000, available_mib: 1 }
      )
    ).toBe(3000);
    expect(reserveMib({ kind: 'percent', ratio: 0.1 }, null)).toBe(2048);
  });
});

describe('admit', () => {
  const memory = { total_mib: 31836, available_mib: 9100 };
  it('refuses what can never fit before looking at the queue', () => {
    expect(
      admit({ ahead: 0, memory, need_mib: 30000, reserve_mib: 4096 })
    ).toEqual({
      ok: false,
      reason: 'never',
      waiting_for:
        'needs 29.3G but the host has at most 27.1G over the reserve',
      free_mib: 5004,
    });
  });
  it('queues behind pending leases even when memory would do', () => {
    expect(
      admit({ ahead: 2, memory, need_mib: 100, reserve_mib: 4096 })
    ).toEqual({
      ok: false,
      reason: 'queue',
      waiting_for: '2 ahead in the queue',
      free_mib: 5004,
    });
  });
  it('admits when available minus the reserve covers the need, else says how much is short', () => {
    expect(
      admit({ ahead: 0, memory, need_mib: 5000, reserve_mib: 4096 })
    ).toEqual({ ok: true, free_mib: 5004 });
    expect(
      admit({ ahead: 0, memory, need_mib: 5500, reserve_mib: 4096 })
    ).toEqual({
      ok: false,
      reason: 'memory',
      waiting_for: 'needs 5.4G, host has 4.9G over the reserve (496M short)',
      free_mib: 5004,
    });
  });
  it('admits without a memory reading, in FIFO order', () => {
    expect(
      admit({ ahead: 0, memory: null, need_mib: 5000, reserve_mib: 2048 })
    ).toEqual({ ok: true, free_mib: null });
  });
});

describe('measureSiblings', () => {
  const row = (app: string, status: string, memory: number): LsRow =>
    ({ app, status, memory }) as LsRow;
  it('reads each other checkout of the registry and keeps the largest online value per app', async () => {
    const registry = {
      repo: '/w/demo',
      slots: {
        '0': { path: '/w/demo', branch: null, project: 'demo' },
        '1': { path: '/w/demo.worktrees/a', branch: 'a', project: 'demo-w1' },
        '2': { path: varsProj, branch: 'b', project: 'demo-w2' },
      },
    };
    const seen: string[] = [];
    const list = async (root: string) => {
      seen.push(root);
      return root === '/w/demo'
        ? [
            row('db', 'online', 50 * 1024 * 1024),
            row('api', 'online', 400 * 1024 * 1024),
          ]
        : [
            row('db', 'online', 80 * 1024 * 1024),
            row('api', 'stopped', 999 * 1024 * 1024),
          ];
    };
    const r = await measureSiblings(m, { registry, list, exists: () => true });
    expect(seen).toEqual(['/w/demo', '/w/demo.worktrees/a']);
    expect(r).toEqual(
      new Map([
        ['db', { mib: 80, slot: 1 }],
        ['api', { mib: 400, slot: 0 }],
      ])
    );
  });
  it('probes the siblings at the same time and folds them in slot order: on a tie the lowest slot wins', async () => {
    const registry = {
      repo: '/w/demo',
      slots: {
        '0': { path: '/w/demo', branch: null, project: 'demo' },
        '1': { path: '/w/demo.worktrees/a', branch: 'a', project: 'demo-w1' },
      },
    };
    let inflight = 0;
    let most = 0;
    const list = async (root: string) => {
      inflight++;
      most = Math.max(most, inflight);
      // slot 0 answers last
      await new Promise((r) => setTimeout(r, root === '/w/demo' ? 40 : 5));
      inflight--;
      return [row('db', 'online', 80 * 1024 * 1024)];
    };
    const r = await measureSiblings(m, { registry, list, exists: () => true });
    expect(most).toBe(2);
    expect(r).toEqual(new Map([['db', { mib: 80, slot: 0 }]]));
  });
  it('listCheckout measures nothing at a path whose manifest is an enclosing project', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-sib-'));
    try {
      fs.mkdirSync(path.join(root, '.mcproc'));
      fs.writeFileSync(
        path.join(root, '.mcproc', 'mcproc.yaml'),
        'version: 1\nproject: demo\napps:\n  a: { description: d, run: node a.js }\n'
      );
      fs.mkdirSync(path.join(root, 'nested'));
      const never = async (argv: string[]) => {
        throw new Error(`must not spawn: ${argv.join(' ')}`);
      };
      expect(await listCheckout(path.join(root, 'nested'), never)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('is empty without a registry, and skips a checkout that is gone or does not answer', async () => {
    expect(
      await measureSiblings(m, { registry: null, list: async () => [] })
    ).toEqual(new Map());
    const registry = {
      repo: '/w/demo',
      slots: {
        '0': { path: '/w/demo', branch: null, project: 'demo' },
        '1': { path: '/gone', branch: null, project: 'x' },
      },
    };
    const list = async (root: string) => {
      if (root === '/w/demo') throw new Error('pm2 down');
      return [];
    };
    expect(
      await measureSiblings(m, {
        registry,
        list,
        exists: (p) => p !== '/gone',
      })
    ).toEqual(new Map());
  });
});

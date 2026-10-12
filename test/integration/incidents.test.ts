import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  prepare,
  connect,
  clearResolutionCache,
  type Context,
} from '../../src/core/resolve.js';
import { Fleet, actOn } from '../../src/core/fleet.js';
import {
  clearLogs,
  readStore,
  storePath,
  takeIncidents,
} from '../../src/core/incidents/store.js';

const RUN = process.env.MCPROC_IT === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BOOM = `console.log('starting'); setTimeout(() => { console.error(new TypeError('x is undefined').stack); }, 200); setInterval(() => {}, 1000);`;
const CRASHY = `console.log('up'); setTimeout(() => process.exit(1), 300);`;

describe.skipIf(!RUN)('incidents against a real pm2', () => {
  let base: string;
  let ctx: Context;
  let fleet: Fleet;
  beforeAll(async () => {
    base = fs.mkdtempSync('/tmp/mcproc-inc-');
    fs.mkdirSync(path.join(base, '.mcproc'));
    fs.writeFileSync(path.join(base, 'boom.js'), BOOM);
    fs.writeFileSync(path.join(base, 'crashy.js'), CRASHY);
    fs.writeFileSync(
      path.join(base, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: itinc',
        'apps:',
        '  boom:',
        '    description: logs a TypeError with a stack once',
        '    kind: worker',
        '    run: node boom.js',
        '  crashy:',
        '    description: exits 1 after 300 ms, pm2 restarts it',
        '    kind: worker',
        '    run: node crashy.js',
        '    pm2: { restart_delay: 500 }',
        'hosts:',
        '  local:',
        `    pm2_home: ${path.join(base, 'home')}`,
        '',
      ].join('\n')
    );
    clearResolutionCache();
    ctx = await connect(prepare({ project: base }));
    fleet = new Fleet(prepare({ project: base }).manifest, undefined);
    await actOn(fleet, 'all', 'start');
    await sleep(2500);
  }, 60_000);
  afterAll(async () => {
    try {
      await ctx.pm2.run(['kill']);
    } catch {
      /* already gone */
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('the first take finds the TypeError with its stack; later ones never again; a peek leaves the restarts of crashy for the next take', async () => {
    const first = await takeIncidents(fleet, ['boom', 'crashy']);
    const boom = first.answer.incidents.find((i) => i.app === 'boom')!;
    expect(boom.line).toContain('TypeError: x is undefined');
    expect(boom.after.some((l) => l.includes('    at '))).toBe(true);
    expect(fs.existsSync(path.join(base, '.mcproc', 'incidents.json'))).toBe(
      true
    );
    await sleep(2500);
    const peek = await takeIncidents(fleet, ['boom', 'crashy'], { peek: true });
    expect(peek.answer.incidents.filter((i) => i.app === 'boom')).toEqual([]);
    const peeked =
      peek.answer.incidents.find(
        (i) => i.app === 'crashy' && i.kind === 'restarted'
      )?.count ?? 0;
    expect(peeked).toBeGreaterThan(0);
    const second = await takeIncidents(fleet, ['boom', 'crashy']);
    expect(second.answer.incidents.filter((i) => i.app === 'boom')).toEqual([]);
    expect(
      second.answer.incidents.find(
        (i) => i.app === 'crashy' && i.kind === 'restarted'
      )?.count
    ).toBeGreaterThanOrEqual(peeked);
  }, 30_000);

  it('a clear empties the logs and records it: even with no pick-up point left, the old TypeError never comes back', async () => {
    const file = storePath(fleet.manifest.path);
    fs.rmSync(file);
    expect(
      (
        await takeIncidents(fleet, ['boom'], { peek: true })
      ).answer.incidents.map((i) => i.app)
    ).toEqual(['boom']); // a first call would find it again
    const r = await clearLogs(fleet, ['boom']);
    expect(r).toMatchObject([{ app: 'boom', host: 'local' }]);
    expect(r[0].err_bytes).toBeGreaterThan(0);
    const at = readStore(file).cleared['local/boom'];
    expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    const after = await takeIncidents(fleet, ['boom']);
    expect(after.answer.incidents).toEqual([]);
    expect(after.answer.cleared_at).toBe(at);
  }, 30_000);
});

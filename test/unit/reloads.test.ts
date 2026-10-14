import { describe, it, expect } from 'vitest';
import {
  compileReloadRules,
  detectReloads,
  ReloadTracker,
} from '../../src/core/reloads.js';

const T = (s: string, ms = 0) =>
  `2026-10-14T12:00:${s}.${String(ms).padStart(3, '0')}: `;
const out = (text: string) => ({ stream: 'out' as const, text });
const rules = compileReloadRules({ match: [], ignore: [], defaults: true });
const opts = { app: 'web', start: null, coversStart: false };

describe('detectReloads', () => {
  it('a 43-line Vite burst is one reload', () => {
    const lines = Array.from({ length: 43 }, (_, i) =>
      out(
        `${T('41', 564 + i * 2)}[vite] (client) page reload /repo/packages/domain/dist/f${i}.js`
      )
    );
    const r = detectReloads(lines, rules, opts);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      lines: 43,
      marker: 'vite',
      time: '2026-10-14T12:00:41.564',
      last_time: '2026-10-14T12:00:41.648',
    });
    expect(r[0].line).toContain('page reload /repo/packages/domain/dist/f0.js');
  });
  it('bursts 2.5 s apart are two; 1.9 s apart are one', () => {
    expect(
      detectReloads(
        [
          out(`${T('10')}[vite] (client) hmr update /src/a.css`),
          out(`${T('12', 500)}[vite] (client) hmr update /src/b.css`),
        ],
        rules,
        opts
      )
    ).toHaveLength(2);
    expect(
      detectReloads(
        [
          out(`${T('10')}[vite] (client) hmr update /src/a.css`),
          out(`${T('11', 900)}[vite] (client) hmr update /src/b.css`),
        ],
        rules,
        opts
      )
    ).toHaveLength(1);
  });
  it('a restart and its re-listen are one reload', () => {
    const r = detectReloads(
      [
        out(
          `${T('20')}8:17:10 PM [tsx] change in ./dist/index.js Restarting...`
        ),
        out(`${T('20', 900)}service listening on 3010`),
      ],
      rules,
      opts
    );
    expect(r).toEqual([expect.objectContaining({ lines: 2, marker: 'tsx' })]);
  });
  it('the boot burst is not a reload (coversStart); later re-listens are', () => {
    const lines = [
      out(`${T('01')}api listening on 3010`),
      out(`${T('01', 200)}metrics listening at 9090`),
      out(`${T('30')}api listening on 3010`),
      out(`${T('45')}api listening on 3010`),
    ];
    expect(
      detectReloads(lines, rules, { ...opts, coversStart: true })
    ).toHaveLength(2);
    expect(
      detectReloads(lines, rules, { ...opts, coversStart: false })
    ).toHaveLength(3);
    // a first burst that is not re-listen only is never taken for the boot
    expect(
      detectReloads(
        [
          out(`${T('01')}[tsx] change in x Restarting...`),
          out(`${T('30')}api listening on 3010`),
        ],
        rules,
        { ...opts, coversStart: true }
      )
    ).toHaveLength(2);
  });
  it('lines before the start are ignored; with a start, unstamped lines without a stamped line before them are skipped', () => {
    const lines = [
      out('orphan [vite] (client) page reload /x.js'),
      out(`${T('05')}[vite] (client) page reload /old.js`),
      out(`${T('20')}api listening on 3010`),
      out(`${T('40')}[vite] (client) page reload /new.js`),
    ];
    const r = detectReloads(lines, rules, {
      app: 'web',
      start: '2026-10-14T12:00:15.000',
      coversStart: true,
    });
    expect(r.map((x) => x.line)).toEqual([
      `${T('40')}[vite] (client) page reload /new.js`,
    ]);
  });
  it('a stamp in whole seconds (pm2 logs from before millisecond stamps) is compared with the start at its own precision', () => {
    const sec = (s: string) => `2026-10-14T12:00:${s}: `;
    const r = detectReloads(
      [
        out(`${sec('04')}[tsx] change in old Restarting...`), // the second before the start: an earlier run
        out(`${sec('05')}api listening on 3010`), // the boot, logged in the start's second
        out(`${sec('30')}api listening on 3010`),
      ],
      rules,
      { app: 'api', start: '2026-10-14T12:00:05.700', coversStart: true }
    );
    expect(r).toEqual([
      expect.objectContaining({ time: '2026-10-14T12:00:30.000', lines: 1 }),
    ]);
  });
  it("out and err are merged by time; an unstamped line takes its own stream's previous stamp", () => {
    const r = detectReloads(
      [
        out(`${T('10')}[tsx] change in a Restarting...`),
        { stream: 'err', text: `${T('11')}something` },
        { stream: 'err', text: '[vite] (client) page reload /a.js' }, // takes err's 12:00:11.000
        out(`${T('20')}[tsx] change in b Restarting...`),
      ],
      rules,
      opts
    );
    expect(r.map((x) => x.lines)).toEqual([2, 1]);
  });
  it('the built-in markers', () => {
    const hit = (body: string) =>
      detectReloads([out(`${T('10')}${body}`)], rules, opts).length === 1;
    expect(hit('[nodemon] restarting due to changes...')).toBe(true);
    expect(hit("Restarting 'src/index.js'")).toBe(true);
    expect(hit(' ✓ Compiled in 312ms')).toBe(true);
    expect(hit(' ✓ Compiled /dashboard in 1.2s')).toBe(false); // a first compile of a route
    expect(hit(' ✓ Ready in 900ms')).toBe(false);
    expect(hit('Reload env: .env.local')).toBe(true);
    expect(
      hit(
        '12:00:10 - File change detected. Starting incremental compilation...'
      )
    ).toBe(true);
    expect(hit('\x1b[32m[vite]\x1b[0m (client) page reload /a.js')).toBe(true); // ANSI removed first
    expect(hit('HTTP server listening on port 3000')).toBe(true); // re-listen, coversStart false
    expect(hit('nothing to see')).toBe(false);
  });
  it('per-app settings: match adds, ignore drops, defaults false keeps only the own markers', () => {
    const own = compileReloadRules({
      match: ['^reloaded config'],
      ignore: ['hmr update /src/noisy'],
      defaults: true,
    });
    expect(
      detectReloads([out(`${T('10')}reloaded config`)], own, opts)
    ).toEqual([expect.objectContaining({ marker: 'custom' })]);
    expect(
      detectReloads(
        [out(`${T('10')}[vite] (client) hmr update /src/noisy.css`)],
        own,
        opts
      )
    ).toEqual([]);
    const only = compileReloadRules({
      match: ['^reloaded config'],
      ignore: [],
      defaults: false,
    });
    expect(
      detectReloads(
        [out(`${T('10')}[vite] (client) page reload /a.js`)],
        only,
        opts
      )
    ).toEqual([]);
  });
  it('an own pattern that runs past the budget throws TIMEOUT naming the reloads patterns', () => {
    const slow = compileReloadRules(
      { match: ['^(a|aa)+$'], ignore: [], defaults: false },
      50
    );
    expect(() =>
      detectReloads([out(`${T('10')}${'a'.repeat(40)}b`)], slow, opts)
    ).toThrowError(
      expect.objectContaining({
        code: 'TIMEOUT',
        message: expect.stringContaining('reloads'),
      })
    );
  });
});

describe('ReloadTracker', () => {
  it('reports a burst once, when a marker 2 s later arrives or when it went quiet', () => {
    const t = new ReloadTracker(rules, opts);
    expect(
      t.push(
        [
          out(`${T('10')}[vite] (client) page reload /a.js`),
          out(`${T('10', 5)}[vite] (client) page reload /b.js`),
        ],
        1_000
      )
    ).toEqual([]);
    expect(t.idle(2_500)).toEqual([]); // 1.5 s of wall time since the last marker arrived
    expect(t.idle(3_000)).toEqual([expect.objectContaining({ lines: 2 })]);
    expect(t.idle(9_000)).toEqual([]); // reported once
    t.push([out(`${T('20')}[vite] (client) page reload /c.js`)], 10_000);
    expect(
      t.push([out(`${T('25')}[vite] (client) page reload /d.js`)], 15_000)
    ).toEqual([
      expect.objectContaining({ line: expect.stringContaining('/c.js') }),
    ]);
    expect(t.flush()).toEqual([
      expect.objectContaining({ line: expect.stringContaining('/d.js') }),
    ]);
  });
  it('a push that throws TIMEOUT leaves the tracker as it was', () => {
    const slow = compileReloadRules(
      { match: ['^(a|aa)+$'], ignore: [], defaults: true },
      50
    );
    const t = new ReloadTracker(slow, opts);
    expect(
      t.push([out(`${T('10')}[vite] (client) page reload /a.js`)], 1_000)
    ).toEqual([]);
    expect(() =>
      t.push([out(`${T('50')}${'a'.repeat(40)}b`)], 2_000)
    ).toThrowError(expect.objectContaining({ code: 'TIMEOUT' }));
    // an unstamped marker still takes out's stamp from before the failed push, so it joins the open burst
    expect(t.push([out('[vite] (client) page reload /b.js')], 3_000)).toEqual(
      []
    );
    expect(t.flush()).toEqual([
      expect.objectContaining({
        lines: 2,
        time: '2026-10-14T12:00:10.000',
        last_time: '2026-10-14T12:00:10.000',
      }),
    ]);
  });
  it('a marker pushed later with a much older stamp closes the open burst instead of joining it', () => {
    const t = new ReloadTracker(rules, opts);
    t.push([out(`${T('30')}[vite] (client) page reload /a.js`)], 1_000);
    // a second older still joins: the other stream's line of the same rebuild
    expect(
      t.push(
        [
          {
            stream: 'err',
            text: `${T('29')}[vite] (client) page reload /b.js`,
          },
        ],
        1_100
      )
    ).toEqual([]);
    expect(
      t.push([out(`${T('10')}[vite] (client) page reload /c.js`)], 1_200)
    ).toEqual([
      expect.objectContaining({ lines: 2, time: '2026-10-14T12:00:30.000' }),
    ]);
    expect(t.flush()).toEqual([
      expect.objectContaining({ lines: 1, time: '2026-10-14T12:00:10.000' }),
    ]);
  });
  it('drops the boot burst when it covers the start, and ignores lines before the start', () => {
    const t = new ReloadTracker(rules, {
      app: 'api',
      start: '2026-10-14T12:00:05.000',
      coversStart: true,
    });
    expect(
      t.push(
        [
          out(`${T('01')}[tsx] change in old Restarting...`),
          out(`${T('06')}api listening on 3010`),
        ],
        1_000
      )
    ).toEqual([]);
    expect(t.push([out(`${T('30')}api listening on 3010`)], 30_000)).toEqual(
      []
    ); // closes the boot burst: dropped
    expect(t.flush()).toEqual([
      expect.objectContaining({ time: '2026-10-14T12:00:30.000' }),
    ]);
  });
});

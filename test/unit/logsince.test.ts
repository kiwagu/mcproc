import { describe, it, expect } from 'vitest';
import {
  parseSince,
  cutoffFor,
  stampMs,
  selectSince,
  mergeLines,
  MAX_RELATIVE_MS,
  type SinceLine,
} from '../../src/core/logsince.js';

describe('parseSince', () => {
  it('relative forms', () => {
    expect(parseSince('90s')).toEqual({ kind: 'relative', ms: 90_000 });
    expect(parseSince('5m')).toEqual({ kind: 'relative', ms: 300_000 });
    expect(parseSince('2h')).toEqual({ kind: 'relative', ms: 7_200_000 });
    expect(parseSince('1.5m')).toEqual({ kind: 'relative', ms: 90_000 });
    expect(parseSince('250ms')).toEqual({ kind: 'relative', ms: 250 });
    expect(parseSince('24h')).toEqual({
      kind: 'relative',
      ms: MAX_RELATIVE_MS,
    });
  });
  it('absolute local and absolute with a zone', () => {
    expect(parseSince('2026-10-14T07:30')).toEqual({
      kind: 'local',
      stamp: '2026-10-14T07:30:00.000',
    });
    expect(parseSince('2026-10-14T07:30:15.250')).toEqual({
      kind: 'local',
      stamp: '2026-10-14T07:30:15.250',
    });
    expect(parseSince('2026-10-14T07:30:00Z')).toEqual({
      kind: 'instant',
      epochMs: Date.UTC(2026, 9, 14, 7, 30),
    });
    expect(parseSince('2026-10-14T09:30:00+02:00')).toEqual({
      kind: 'instant',
      epochMs: Date.UTC(2026, 9, 14, 7, 30),
    });
  });
  it('last', () => {
    expect(parseSince('last')).toEqual({ kind: 'last' });
  });
  it('refuses impossible times and offsets instead of rolling them over', () => {
    for (const bad of [
      '2026-02-29T07:30', // 2026 is not a leap year
      '2026-02-30T07:30',
      '2026-10-14T24:00',
      '2026-10-14T07:30:00+99:99',
    ])
      expect(() => parseSince(bad)).toThrowError(
        expect.objectContaining({ code: 'BAD_ARGUMENT' })
      );
    expect(parseSince('2028-02-29T07:30')).toEqual({
      kind: 'local',
      stamp: '2028-02-29T07:30:00.000',
    });
  });
  it('refuses the rest with BAD_ARGUMENT', () => {
    for (const bad of [
      '',
      '5',
      '5 m',
      '25h',
      '-5m',
      'yesterday',
      '2026-10-14',
      '2026-10-14T7:30',
      'LAST',
    ])
      expect(() => parseSince(bad)).toThrowError(
        expect.objectContaining({ code: 'BAD_ARGUMENT' })
      );
  });
});

describe('cutoffFor', () => {
  const clock = { now: '2026-10-14T09:30:00', zone: '+0200' };
  it('relative: the host clock minus the span, with milliseconds', () => {
    expect(cutoffFor(parseSince('90s'), clock)).toBe('2026-10-14T09:28:30.000');
    expect(cutoffFor(parseSince('2h'), clock)).toBe('2026-10-14T07:30:00.000');
  });
  it('local: as given', () => {
    expect(cutoffFor(parseSince('2026-10-14T07:30'), clock)).toBe(
      '2026-10-14T07:30:00.000'
    );
  });
  it('instant: converted to the host zone', () => {
    expect(cutoffFor(parseSince('2026-10-14T07:30:00Z'), clock)).toBe(
      '2026-10-14T09:30:00.000'
    );
    expect(
      cutoffFor(parseSince('2026-10-14T07:30:00Z'), {
        now: clock.now,
        zone: '-0330',
      })
    ).toBe('2026-10-14T04:00:00.000');
  });
  it('last and tail have no cutoff; relative without a clock is an error', () => {
    expect(cutoffFor(parseSince('last'), clock)).toBeNull();
    expect(cutoffFor({ kind: 'tail', n: 100 }, clock)).toBeNull();
    expect(() => cutoffFor(parseSince('5m'), null)).toThrowError(
      expect.objectContaining({ code: 'TRANSPORT_FAILED' })
    );
    expect(cutoffFor(parseSince('2026-10-14T07:30'), null)).toBe(
      '2026-10-14T07:30:00.000'
    ); // local needs no clock
  });
  it('a clock or zone that cannot be read is TRANSPORT_FAILED; each form checks only what it needs', () => {
    const unread = expect.objectContaining({ code: 'TRANSPORT_FAILED' });
    expect(() =>
      cutoffFor(parseSince('2026-10-14T07:30:00Z'), null)
    ).toThrowError(unread);
    for (const now of [
      '',
      '09:30:00',
      '2026-10-14 09:30:00',
      '2026-02-30T09:30:00',
      '2026-10-14T24:00:00',
    ])
      expect(() =>
        cutoffFor(parseSince('5m'), { now, zone: '+0200' })
      ).toThrowError(unread);
    for (const zone of ['', 'CEST', '+02:00', '+2', '+9999'])
      expect(() =>
        cutoffFor(parseSince('2026-10-14T07:30:00Z'), { now: clock.now, zone })
      ).toThrowError(unread);
    // a relative since needs only the clock, an instant only the zone, a local time neither
    expect(cutoffFor(parseSince('90s'), { now: clock.now, zone: 'CEST' })).toBe(
      '2026-10-14T09:28:30.000'
    );
    expect(
      cutoffFor(parseSince('2026-10-14T07:30:00Z'), { now: '', zone: '+0200' })
    ).toBe('2026-10-14T09:30:00.000');
    expect(
      cutoffFor(parseSince('2026-10-14T07:30'), { now: '', zone: '' })
    ).toBe('2026-10-14T07:30:00.000');
  });
});

describe('stampMs', () => {
  it('second stamps compare as .000; millisecond stamps as they are; no stamp → null', () => {
    expect(stampMs('2026-10-14T09:28:30: ready')).toBe(
      '2026-10-14T09:28:30.000'
    );
    expect(stampMs('2026-10-14T09:28:30.123: ready')).toBe(
      '2026-10-14T09:28:30.123'
    );
    expect(stampMs('    at foo (x.js:1)')).toBeNull();
    expect(stampMs('2026-10-14T09:28:30.123:ready')).toBeNull(); // pm2 writes ": " after the stamp
  });
});

describe('selectSince', () => {
  const lines = [
    '2026-10-14T09:28:29.900: old',
    '2026-10-14T09:28:30.000: TypeError: boom',
    '    at a (x.js:1)',
    '    at b (x.js:2)',
    '2026-10-14T09:28:31: later',
    'no stamp at all',
  ];
  it('keeps lines at or after the cutoff; unstamped lines travel with the stamped line before them', () => {
    const r = selectSince(lines, '2026-10-14T09:28:30.000');
    expect(r.kept.map((l) => l.text)).toEqual([
      '2026-10-14T09:28:30.000: TypeError: boom',
      '    at a (x.js:1)',
      '    at b (x.js:2)',
      '2026-10-14T09:28:31: later',
      'no stamp at all',
    ]);
    expect(r.kept[1].time).toBe('2026-10-14T09:28:30.000');
    expect(r.kept[3].time).toBe('2026-10-14T09:28:31.000');
    expect(r.beforeCutoff).toBe(1);
  });
  it('a cutoff after everything keeps nothing; lines before the first stamp are dropped', () => {
    expect(selectSince(lines, '2026-10-14T09:29:00.000').kept).toEqual([]);
    expect(
      selectSince(['orphan', ...lines], '2026-10-14T09:28:30.000').kept[0].text
    ).toContain('TypeError');
  });
  it('a null cutoff keeps everything with inherited times', () => {
    const r = selectSince(lines, null);
    expect(r.kept).toHaveLength(6);
    expect(r.kept[0].time).toBe('2026-10-14T09:28:29.900');
    expect(r.beforeCutoff).toBe(0);
  });
});

describe('mergeLines', () => {
  const L = (
    app: string,
    stream: 'out' | 'err',
    time: string | null,
    text: string
  ): SinceLine => ({ app, host: 'local', stream, time, text });
  it('orders by time across apps, stable within a time, and keeps the last cap lines', () => {
    const r = mergeLines(
      [
        L('web', 'out', '2026-10-14T09:28:31.000', 'w1'),
        L('api', 'out', '2026-10-14T09:28:30.000', 'a1'),
        L('api', 'err', '2026-10-14T09:28:30.000', 'a1-err'),
        L('api', 'out', '2026-10-14T09:28:30.000', 'a1-cont'),
        L('web', 'out', '2026-10-14T09:28:29.000', 'w0'),
      ],
      2000
    );
    expect(r.lines.map((l) => l.text)).toEqual([
      'w0',
      'a1',
      'a1-err',
      'a1-cont',
      'w1',
    ]);
    expect(r.truncated).toBe(0);
    const c = mergeLines(r.lines, 2);
    expect(c.lines.map((l) => l.text)).toEqual(['a1-cont', 'w1']);
    expect(c.truncated).toBe(3);
  });
});

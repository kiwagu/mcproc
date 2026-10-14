import { describe, it, expect } from 'vitest';
import {
  parseSince,
  cutoffFor,
  stampMs,
  selectSince,
  mergeLines,
  hostClock,
  MAX_RELATIVE_MS,
  LogMarks,
  readSince,
  type SinceLine,
} from '../../src/core/logsince.js';
import { fakeHosts, proc, S } from '../helpers/incidents.js';

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

describe('hostClock', () => {
  it('reads now and zone from the clock marker; null when absent or garbled', () => {
    expect(
      hostClock('x\n__MCPROC_LS_CLOCK__ 2026-10-14T09:30:00 +0200\ny')
    ).toEqual({ now: '2026-10-14T09:30:00', zone: '+0200' });
    expect(hostClock('__MCPROC_LS_CLOCK__ \n')).toBeNull();
    expect(hostClock('nothing')).toBeNull();
  });
});

describe('readSince', () => {
  const state = () => ({
    now: '2026-10-12T11:00:40' as string | undefined,
    zone: '+0000',
    procs: {
      local: [proc('watch', 0), proc('tool', 1)],
      box: [proc('web', 2)],
    } as Record<string, object[]>,
    files: {
      '/l/watch-out': `${S(10)}build ok\n${S(35)}change detected\n${S(36)}rebuilt\n`,
      '/l/watch-err': `${S(37)}warning: slow\n    at x\n`,
      '/l/tool-out': `${S(5)}old\n`,
      '/l/tool-err': '',
      '/l/web-out': `${S(38)}\x1b[32mlistening 3000\x1b[0m\n`,
      '/l/web-err': '',
    } as Record<string, string>,
  });
  it('a relative since reads every app on its host once, keeps the window, merges by stamp with labels', async () => {
    const st = state();
    const { fleet, reads } = fakeHosts(st);
    const a = await readSince(fleet, ['watch', 'web', 'tool'], {
      since: parseSince('10s'),
    });
    expect(reads.sort()).toEqual(['box', 'local']); // one read script per host
    expect(a.mode).toBe('relative');
    expect(a.since).toEqual({
      local: '2026-10-12T11:00:30.000',
      box: '2026-10-12T11:00:30.000',
    });
    expect(a.lines.map((l) => `${l.app}:${l.stream}:${l.text}`)).toEqual([
      `watch:out:${S(35)}change detected`,
      `watch:out:${S(36)}rebuilt`,
      `watch:err:${S(37)}warning: slow`,
      'watch:err:    at x',
      `web:out:${S(38)}listening 3000`,
    ]);
    expect(a.lines[3].time).toBe('2026-10-12T11:00:37.000'); // the continuation line carries its stamp
    expect(a.lines[4].host).toBe('box');
    expect(a.lines[4].text).not.toContain('\x1b'); // plain by default
    expect(a.truncated).toBe(0);
    expect(a.skipped).toEqual([]);
    expect(a.not_started).toEqual([]);
    expect(a.errors).toEqual([]);
    expect(a).toMatchObject({ apps: 3, hosts: 2 });
  });
  it('keepColors leaves SGR in; stream filters; lines caps and counts', async () => {
    const { fleet } = fakeHosts(state());
    const a = await readSince(fleet, ['watch', 'web'], {
      since: parseSince('10s'),
      keepColors: true,
      stream: 'out',
      lines: 2,
    });
    expect(a.lines.map((l) => l.text)).toEqual([
      `${S(36)}rebuilt`,
      `${S(38)}\x1b[32mlistening 3000\x1b[0m`,
    ]);
    expect(a.truncated).toBe(1);
  });
  it('lines with one stamp follow the order of the names, not the order of the hosts', async () => {
    const st = state();
    st.files['/l/watch-out'] = `${S(39)}w\n`;
    st.files['/l/watch-err'] = '';
    st.files['/l/web-out'] = `${S(39)}b\n`;
    st.files['/l/tool-out'] = `${S(39)}t\n`;
    const { fleet } = fakeHosts(st);
    // local is read first (it hosts the first name), yet web (box) is named before tool (local)
    const a = await readSince(fleet, ['watch', 'web', 'tool'], {
      since: parseSince('10s'),
    });
    expect(a.lines.map((l) => `${l.host}/${l.app}`)).toEqual([
      'local/watch',
      'box/web',
      'local/tool',
    ]);
  });
  it('an absolute local time and a zoned instant are placed per host', async () => {
    const st = state();
    st.zone = '+0200';
    const { fleet } = fakeHosts(st);
    const local = await readSince(fleet, ['watch'], {
      since: parseSince('2026-10-12T11:00:36'),
    });
    expect(local.lines.map((l) => l.text)).toEqual([
      `${S(36)}rebuilt`,
      `${S(37)}warning: slow`,
      '    at x',
    ]);
    const zoned = await readSince(fleet, ['watch'], {
      since: parseSince('2026-10-12T09:00:36Z'),
    }); // 11:00:36 at +0200
    expect(zoned.since).toEqual({ local: '2026-10-12T11:00:36.000' });
    expect(zoned.lines).toHaveLength(3);
  });
  it('a host without a clock fails a relative since; an absolute local time still works there', async () => {
    const st = state();
    st.now = undefined;
    const { fleet } = fakeHosts(st);
    await expect(
      readSince(fleet, ['watch'], { since: parseSince('10s') })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    const a = await readSince(fleet, ['watch'], {
      since: parseSince('2026-10-12T11:00:36'),
    });
    expect(a.lines).toHaveLength(3);
  });
  it('an app without a pm2 process is a note; an unreachable host is a note with the others still read', async () => {
    const st = state();
    st.procs.local = [proc('watch', 0)]; // tool has no process
    const { fleet } = fakeHosts(st, ['box']);
    const a = await readSince(fleet, ['watch', 'web', 'tool'], {
      since: parseSince('10s'),
    });
    expect(a.not_started).toEqual(['tool']);
    expect(a.errors).toEqual([
      {
        host: 'box',
        apps: ['web'],
        message: 'TRANSPORT_FAILED: ssh box: Connection refused',
      },
    ]);
    expect(a.since).toEqual({ local: '2026-10-12T11:00:30.000' }); // only the hosts that answered
    expect(a.lines.map((l) => l.app)).toEqual([
      'watch',
      'watch',
      'watch',
      'watch',
    ]);
    expect(a).toMatchObject({ apps: 3, hosts: 2 });
  });
  it('a host whose apps are all not started still reports its cutoff', async () => {
    const st = state();
    st.procs.local = [];
    const { fleet } = fakeHosts(st);
    const a = await readSince(fleet, ['watch', 'tool'], {
      since: parseSince('10s'),
    });
    expect(a.since).toEqual({ local: '2026-10-12T11:00:30.000' });
    expect(a.not_started).toEqual(['watch', 'tool']);
    expect(a.lines).toEqual([]);
  });
  it('when no host answers the first error is thrown', async () => {
    const { fleet } = fakeHosts(state(), ['local', 'box']);
    await expect(
      readSince(fleet, ['watch', 'web'], { since: parseSince('10s') })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
  it('tail (no since): the last n lines of each file, merged; lines caps the merge, default n', async () => {
    const { fleet } = fakeHosts(state());
    const a = await readSince(fleet, ['watch', 'tool'], {
      since: { kind: 'tail', n: 2 },
      lines: 5,
    });
    expect(a.mode).toBe('tail');
    expect(a.since).toEqual({ local: null });
    expect(a.lines.map((l) => l.text)).toEqual([
      `${S(5)}old`, // tool-out: its 1 line
      `${S(35)}change detected`, // watch-out: last 2 of 3
      `${S(36)}rebuilt`,
      `${S(37)}warning: slow`, // watch-err: its 2
      '    at x',
    ]);
    expect(a.truncated).toBe(0);
    const capped = await readSince(fleet, ['watch', 'tool'], {
      since: { kind: 'tail', n: 2 },
    });
    expect(capped.lines.map((l) => l.text)).toEqual([
      `${S(37)}warning: slow`,
      '    at x',
    ]);
    expect(capped.truncated).toBe(3);
  });
  it('a tail or a last read that begins on a continuation line gives it the stamp of the line it belongs to', async () => {
    const st = state();
    const { fleet } = fakeHosts(st);
    const t = await readSince(fleet, ['watch', 'web'], {
      since: { kind: 'tail', n: 1 },
      lines: 3,
    });
    expect(t.lines.map((l) => l.text)).toEqual([
      `${S(36)}rebuilt`,
      '    at x',
      `${S(38)}listening 3000`,
    ]);
    expect(t.lines[1].time).toBe('2026-10-12T11:00:37.000');
    const marks = new LogMarks();
    await readSince(fleet, ['watch'], { since: parseSince('last'), marks });
    st.files['/l/watch-err'] += '    at y\n';
    const l = await readSince(fleet, ['watch'], {
      since: parseSince('last'),
      marks,
    });
    expect(l.lines.map((x) => [x.text, x.time])).toEqual([
      ['    at y', '2026-10-12T11:00:37.000'],
    ]);
  });
  it('last twice: the first call is a tail of 100 and sets marks; the second returns only what was written between', async () => {
    const st = state();
    const { fleet } = fakeHosts(st);
    const marks = new LogMarks();
    const a1 = await readSince(fleet, ['watch'], {
      since: parseSince('last'),
      marks,
    });
    expect(a1.mode).toBe('last');
    expect(a1.since).toEqual({ local: null });
    expect(a1.lines).toHaveLength(5);
    st.files['/l/watch-out'] += `${S(41)}after\n`;
    const a2 = await readSince(fleet, ['watch'], {
      since: parseSince('last'),
      marks,
    });
    expect(a2.lines.map((l) => l.text)).toEqual([`${S(41)}after`]);
    const a3 = await readSince(fleet, ['watch'], {
      since: parseSince('last'),
      marks,
    });
    expect(a3.lines).toEqual([]);
  });
  it('last after a replaced file reads the new file from its start', async () => {
    const st = state();
    const { fleet } = fakeHosts(st);
    const marks = new LogMarks();
    await readSince(fleet, ['watch'], { since: parseSince('last'), marks });
    st.files['/l/watch-out'] = `${S(50)}fresh\n`; // flushed and rewritten, shorter than the mark
    const a = await readSince(fleet, ['watch'], {
      since: parseSince('last'),
      marks,
    });
    expect(a.lines.map((l) => l.text)).toEqual([`${S(50)}fresh`]);
  });
  it('every merged read moves the marks, a relative read included', async () => {
    const st = state();
    const { fleet } = fakeHosts(st);
    const marks = new LogMarks();
    await readSince(fleet, ['watch'], { since: parseSince('10s'), marks });
    st.files['/l/watch-out'] += `${S(41)}after\n`;
    const a = await readSince(fleet, ['watch'], {
      since: parseSince('last'),
      marks,
    });
    expect(a.lines.map((l) => l.text)).toEqual([`${S(41)}after`]);
  });
  it('a window read that began past the file start and saw no line before the cutoff reports skipped', async () => {
    const st = state();
    st.files['/l/watch-out'] = `${S(39)}x\n`.repeat(60_000); // 23 bytes × 60000 ≈ 1.38 MB > the 1 MB read, every line inside the window
    const { fleet } = fakeHosts(st);
    const a = await readSince(fleet, ['watch'], { since: parseSince('10s') });
    expect(a.skipped).toEqual([
      expect.objectContaining({ app: 'watch', host: 'local', stream: 'out' }),
    ]);
    expect(a.skipped[0].bytes).toBeGreaterThan(0);
    expect(a.lines.length).toBe(2000);
    expect(a.truncated).toBeGreaterThan(40_000);
  });
  it("a last read with more than 1 MB new since the mark reports the reader's skipped bytes", async () => {
    const st = state();
    const { fleet } = fakeHosts(st);
    const marks = new LogMarks();
    await readSince(fleet, ['watch'], { since: parseSince('last'), marks });
    st.files['/l/watch-out'] += `${S(41)}y\n`.repeat(60_000);
    const a = await readSince(fleet, ['watch'], {
      since: parseSince('last'),
      marks,
    });
    expect(a.skipped).toEqual([
      expect.objectContaining({ app: 'watch', stream: 'out' }),
    ]);
    expect(a.skipped[0].bytes).toBeGreaterThan(300_000);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearLogs,
  readStore,
  takeIncidents,
} from '../../src/core/incidents/store.js';
import {
  isTaken,
  takenPoints,
  type TakenPoints,
} from '../../src/core/incidents/taken.js';
import {
  CONTEXT_LINE,
  type Incident,
} from '../../src/core/incidents/detect.js';
import { ANSWER_CHARS } from '../../src/core/incidents/poll.js';
import { fakeHosts, proc, S } from '../helpers/incidents.js';

let file: string;
beforeEach(() => {
  file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-taken-')),
    'incidents.json'
  );
});

const inc = (o: Partial<Incident>): Incident => ({
  app: 'watch',
  host: 'local',
  kind: 'error',
  stream: 'out',
  time: '2026-10-12T11:00:02',
  first_time: '2026-10-12T11:00:02',
  count: 1,
  line: 'x',
  before: [],
  after: [],
  fingerprint: 'f',
  ...o,
});

describe('isTaken', () => {
  const points: TakenPoints = {
    'local/watch': { out: '2026-10-12T11:00:05.000' },
  };
  it('an incident stamped at or before the point of its own file is taken; a later one is not', () => {
    expect(isTaken(inc({ time: '2026-10-12T11:00:02' }), points)).toBe(true);
    expect(isTaken(inc({ time: '2026-10-12T11:00:05' }), points)).toBe(true);
    expect(isTaken(inc({ time: '2026-10-12T11:00:05.001' }), points)).toBe(
      false
    );
    expect(isTaken(inc({ time: '2026-10-12T11:00:06' }), points)).toBe(false);
  });
  it('another stream, another app or another host has its own point', () => {
    expect(isTaken(inc({ stream: 'err' }), points)).toBe(false);
    expect(isTaken(inc({ app: 'api' }), points)).toBe(false);
    expect(isTaken(inc({ host: 'box' }), points)).toBe(false);
  });
  it('an unstamped incident or a reload is never shown as taken', () => {
    expect(isTaken(inc({ time: null }), points)).toBe(false);
    expect(isTaken(inc({ kind: 'reloaded' }), points)).toBe(false);
  });
});

describe('the point a take leaves', () => {
  const state = () => ({
    files: {
      '/l/watch-out': `${S(1)}ok\n${S(2)}TypeError: x is undefined\n${S(3)}still running\n`,
    },
    procs: { local: [proc('watch', 0)] },
  });
  it('a take records the latest stamp it read in each file; a peek records nothing', async () => {
    const st = state();
    const h = fakeHosts(st);
    const peek = await takeIncidents(h.fleet, ['watch'], { peek: true }, file);
    expect(
      isTaken(peek.answer.incidents[0], takenPoints(readStore(file)))
    ).toBe(false);
    const take = await takeIncidents(h.fleet, ['watch'], {}, file);
    const points = takenPoints(readStore(file));
    expect(points['local/watch']?.out).toBe('2026-10-12T11:00:03.000');
    expect(isTaken(take.answer.incidents[0], points)).toBe(true);
    // a newer error is not taken until the next take
    st.files['/l/watch-out'] += `${S(9)}RangeError: later\n`;
    const later = await takeIncidents(h.fleet, ['watch'], { peek: true }, file);
    expect(
      isTaken(later.answer.incidents[0], takenPoints(readStore(file)))
    ).toBe(false);
  });
  it('a take with nothing new keeps the stamp; a clear keeps it too', async () => {
    const h = fakeHosts(state());
    await takeIncidents(h.fleet, ['watch'], {}, file);
    await takeIncidents(h.fleet, ['watch'], {}, file);
    expect(takenPoints(readStore(file))['local/watch']?.out).toBe(
      '2026-10-12T11:00:03.000'
    );
    await clearLogs(h.fleet, ['watch'], file);
    expect(readStore(file).apps['local/watch'].out?.offset).toBe(0);
    expect(takenPoints(readStore(file))['local/watch']?.out).toBe(
      '2026-10-12T11:00:03.000'
    );
  });
  it('a crash the agent took is taken: its time is the last stamped stderr line', async () => {
    const st = {
      files: { '/l/watch-err': `${S(4)}Error: boom\n` },
      procs: { local: [proc('watch', 0, { status: 'errored' })] },
    };
    const h = fakeHosts(st);
    const take = await takeIncidents(h.fleet, ['watch'], {}, file);
    const crash = take.answer.incidents.find((i) => i.kind === 'crashed');
    expect(crash).toBeDefined();
    expect(isTaken(crash!, takenPoints(readStore(file)))).toBe(true);
  });
  it('a malformed store gives no points instead of failing', () => {
    expect(
      takenPoints({
        v: 1,
        apps: { 'local/watch': { out: { stamp: 7 } } } as never,
      })
    ).toEqual({});
  });
});

describe('the size of an answer', () => {
  const long = (n: number, c = 'x') => c.repeat(n);
  it('context lines are cut shorter than the incident line', async () => {
    const h = fakeHosts({
      files: {
        '/l/watch-out': `${S(1)}${long(5000, 'b')}\n${S(2)}TypeError: ${long(5000)}\n${S(3)}${long(5000, 'a')}\n`,
      },
      procs: { local: [proc('watch', 0)] },
    });
    const { answer } = await takeIncidents(h.fleet, ['watch'], {}, file);
    const [i] = answer.incidents;
    expect(i.line.length).toBe(2000);
    expect(i.before[0].length).toBe(CONTEXT_LINE);
    expect(i.after[0].length).toBe(CONTEXT_LINE);
    expect(i.before[0].endsWith('…')).toBe(true);
  });
  it('past the budget the older incidents are counted, not shown, and taken with the rest', async () => {
    // distinct letters (the fingerprint folds digits and hex), six plain lines apart (each error its own incident)
    const lines = Array.from(
      { length: 20 },
      (_, k) =>
        `${S(k + 1)}TypeError: ${String.fromCharCode(103 + k)} ${long(1990)}\n${`${S(k + 1)}ok\n`.repeat(6)}`
    ).join('');
    const h = fakeHosts({
      files: { '/l/watch-out': lines },
      procs: { local: [proc('watch', 0)] },
    });
    const { answer } = await takeIncidents(h.fleet, ['watch'], {}, file);
    const size = answer.incidents.reduce(
      (n, i) =>
        n +
        i.line.length +
        i.before.reduce((m, l) => m + l.length, 0) +
        i.after.reduce((m, l) => m + l.length, 0),
      0
    );
    expect(size).toBeLessThanOrEqual(ANSWER_CHARS);
    expect(answer.incidents.length).toBeGreaterThan(0);
    expect(answer.incidents.length + answer.more).toBe(20);
    expect(answer.more_by).toBe('size');
    expect(answer.incidents[0].line).toContain('TypeError: z '); // the newest first
    // taken with the rest: nothing comes back
    expect(
      (await takeIncidents(h.fleet, ['watch'], {}, file)).answer.incidents
    ).toEqual([]);
  });
  it('one incident larger than the budget is still shown', async () => {
    const h = fakeHosts({
      files: { '/l/watch-out': `${S(1)}TypeError: ${long(1990)}\n` },
      procs: { local: [proc('watch', 0)] },
    });
    const { answer } = await takeIncidents(
      h.fleet,
      ['watch'],
      { chars: 100 },
      file
    );
    expect(answer.incidents).toHaveLength(1);
    expect(answer.more).toBe(0);
    expect(answer.more_by).toBeUndefined();
  });
  it('max still counts first, and says so', async () => {
    const lines = Array.from(
      { length: 5 },
      (_, k) =>
        `${S(k + 1)}TypeError: ${String.fromCharCode(103 + k)}\n${`${S(k + 1)}ok\n`.repeat(6)}`
    ).join('');
    const h = fakeHosts({
      files: { '/l/watch-out': lines },
      procs: { local: [proc('watch', 0)] },
    });
    const { answer } = await takeIncidents(
      h.fleet,
      ['watch'],
      { peek: true, max: 2 },
      file
    );
    expect(answer.incidents).toHaveLength(2);
    expect(answer.more).toBe(3);
    expect(answer.more_by).toBe('max');
  });
});

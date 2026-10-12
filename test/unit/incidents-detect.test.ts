import { describe, it, expect } from 'vitest';
import { BUILTIN_MARKERS, compileRules, detect, collapse, fingerprint, repeatsARepeat, stampOf, type Incident } from '../../src/core/incidents/detect.js';

const S = (sec: number) => `2026-10-12T11:00:${String(sec).padStart(2, '0')}: `;
const rules = ({ budgetMs, ...over }: Partial<{ match: string[]; ignore: string[]; context: [number, number]; stderr: boolean; defaults: boolean; budgetMs: number }> = {}) =>
  compileRules({ match: [], ignore: [], context: [3, 5], stderr: false, defaults: true, ...over }, undefined, budgetMs);
const who = { app: 'api', host: 'local' };
const hits = (line: string) => BUILTIN_MARKERS.some((re) => re.test(line));

describe('built-in markers', () => {
  it('catch the usual ways programs report errors', () => {
    for (const l of ['level=error msg=boom', 'LEVEL=FATAL x', '{"level":50,"msg":"x"}', '{"level":"error","msg":"x"}', '[ERROR] failed', 'ERROR: x',
      'TypeError: Cannot read properties of undefined', 'Error: listen EADDRINUSE: address already in use :::3000', 'at java.lang.IllegalStateException',
      'Traceback (most recent call last):', 'panic: runtime error: index out of range', "thread 'main' panicked at src/main.rs:2:5",
      'UnhandledPromiseRejection: x', 'connect ECONNREFUSED 127.0.0.1:5432']) expect(hits(l), l).toBe(true);
  });
  it('leave ordinary lines alone: lowercase error words, other levels, names that merely contain Error', () => {
    for (const l of ['0 errors', 'error handler registered', 'failed: 0', 'level=info msg=error budget ok', '{"level":30,"msg":"error"}', 'ErrorBoundary mounted', 'TERROR alert']) expect(hits(l), l).toBe(false);
  });
});

describe('detect', () => {
  it('one incident per error: the line, 3 lines before, 5 after; time from the pm2 stamp', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `${S(i)}line ${i}`);
    lines[10] = `${S(10)}TypeError: x is undefined`;
    const [inc] = detect({ stream: 'out', lines, contextOnly: 0 }, rules(), who);
    expect(inc).toMatchObject({ app: 'api', host: 'local', kind: 'error', stream: 'out', time: '2026-10-12T11:00:10', count: 1, line: `${S(10)}TypeError: x is undefined` });
    expect(inc.before).toEqual([7, 8, 9].map((i) => `${S(i)}line ${i}`));
    expect(inc.after).toEqual([11, 12, 13, 14, 15].map((i) => `${S(i)}line ${i}`));
  });
  it('markers match the text after the pm2 stamp; a stack trace is folded in and does not use up the after-context', () => {
    const lines = [`${S(1)}Traceback (most recent call last):`, `${S(1)}  File "app.py", line 3, in <module>`, `${S(1)}    main()`, `${S(1)}ValueError: bad`, `${S(2)}next 1`, `${S(2)}next 2`];
    const r = detect({ stream: 'err', lines, contextOnly: 0 }, rules({ context: [0, 1] }), who);
    expect(r).toHaveLength(1);
    expect(r[0].after).toEqual(lines.slice(1, 5)); // the frames, the second marker merged in, then one line of context
  });
  it('a node stack longer than 30 frames is cut with a count of the rest', () => {
    const lines = [`${S(1)}Error: deep`, ...Array.from({ length: 40 }, (_, i) => `${S(1)}    at f${i} (/a.js:${i}:1)`), `${S(2)}after`];
    const [inc] = detect({ stream: 'out', lines, contextOnly: 0 }, rules({ context: [0, 1] }), who);
    expect(inc.after.slice(0, 30)).toEqual(lines.slice(1, 31));
    expect(inc.after[30]).toBe('… 10 more');
    expect(inc.after[31]).toBe(`${S(2)}after`);
  });
  it('context-only lines are never a start; ignore wins over a marker; match adds a pattern; defaults: false drops the built-ins', () => {
    const lines = [`${S(1)}ERROR: before the cursor`, `${S(2)}ERROR: healthcheck flapped`, `${S(3)}HTTP 503 from upstream`, `${S(4)}TypeError: x`];
    const r = detect({ stream: 'out', lines, contextOnly: 1 }, rules({ ignore: ['healthcheck'], match: ['HTTP 5\\d\\d'], context: [0, 0] }), who);
    expect(r.map((i) => i.line)).toEqual([lines[2], lines[3]]);
    expect(detect({ stream: 'out', lines, contextOnly: 1 }, rules({ match: ['HTTP 5\\d\\d'], defaults: false, context: [0, 0] }), who).map((i) => i.line)).toEqual([lines[2]]);
  });
  it('stderr lines are errors only when the app opts in', () => {
    const lines = [`${S(1)}compiling…`, `${S(2)}warn: deprecated`];
    expect(detect({ stream: 'err', lines, contextOnly: 0 }, rules(), who)).toEqual([]);
    expect(detect({ stream: 'err', lines, contextOnly: 0 }, rules({ stderr: true }), who)).toHaveLength(1); // a burst within the after-context merges into one
    expect(detect({ stream: 'err', lines, contextOnly: 0 }, rules({ stderr: true, context: [0, 0] }), who)).toHaveLength(2); // no after-context: each its own
    expect(detect({ stream: 'out', lines, contextOnly: 0 }, rules({ stderr: true }), who)).toEqual([]);
  });
  it('an unstamped line takes the time of the stamped line before it; very long lines are cut', () => {
    const lines = [`${S(5)}starting`, `TypeError: ${'x'.repeat(3000)}`];
    const [inc] = detect({ stream: 'out', lines, contextOnly: 0 }, rules(), who);
    expect(inc.time).toBe('2026-10-12T11:00:05');
    expect(inc.line.length).toBe(2000);
    expect(inc.line.endsWith('…')).toBe(true);
  });
  it('a never-ending error burst is split, so one incident never grows past 60 lines after', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${S(i % 60)}ERROR: tick ${i}`);
    const r = detect({ stream: 'out', lines, contextOnly: 0 }, rules(), who);
    expect(r.length).toBeGreaterThan(1);
    for (const inc of r) expect(inc.after.length).toBeLessThanOrEqual(60);
  });
});

describe('fingerprint and collapse', () => {
  it('numbers, ids, hex, paths and quoted strings do not make two errors different', () => {
    expect(fingerprint(`${S(1)}TypeError: id 42 at /srv/a.js "abc" 0xdeadbeef 3fa85f64-5717-4562-b3fc-2c963f66afa6`))
      .toBe(fingerprint(`${S(9)}TypeError: id 7 at /opt/b.js "zz" 0x1 123e4567-e89b-12d3-a456-426614174000`));
    expect(fingerprint('TypeError: a')).not.toBe(fingerprint('RangeError: a'));
    expect(stampOf(`${S(3)}x`)).toBe('2026-10-12T11:00:03');
    expect(stampOf('x')).toBeNull();
  });
  it('the same error of one app collapses into the last occurrence, counted, with the first time kept', () => {
    const mk = (sec: number, msg: string): Incident => ({ app: 'api', host: 'local', kind: 'error', stream: 'out', time: `t${sec}`, first_time: `t${sec}`, count: 1, line: msg, before: [`b${sec}`], after: [], fingerprint: fingerprint(msg) });
    const r = collapse([mk(1, 'TypeError: 1'), mk(2, 'RangeError: 2'), mk(3, 'TypeError: 3')]);
    expect(r.map((i) => [i.line, i.count, i.first_time, i.time, i.before[0]])).toEqual([['RangeError: 2', 1, 't2', 't2', 'b2'], ['TypeError: 3', 2, 't1', 't3', 'b3']]);
  });
  it('collapsing goes by time, not by the order the streams were read: the latest occurrence and its context are kept', () => {
    const mk = (t: string, msg: string, stream: 'out' | 'err'): Incident => ({ app: 'api', host: 'local', kind: 'error', stream, time: t, first_time: t, count: 1, line: msg, before: [`b ${t}`], after: [], fingerprint: fingerprint(msg) });
    const [r] = collapse([mk('2026-10-12T12:10:00', 'ERROR: request 2', 'out'), mk('2026-10-12T12:05:00', 'ERROR: request 1', 'err')]); // out is read first
    expect([r.line, r.stream, r.count, r.first_time, r.time, r.before[0]]).toEqual(['ERROR: request 2', 'out', 2, '2026-10-12T12:05:00', '2026-10-12T12:10:00', 'b 2026-10-12T12:10:00']);
  });
});

describe('patterns that cannot stall a poll', () => {
  it('a group repeated without bound whose content ends in an unbounded repeat is caught; ordinary patterns pass', () => {
    for (const p of ['(a+)+$', '(\\w+\\s*)*x', '(?:x+x+)+y', '((a+))+', '(.*)+', '(a|b+)*c', '(?<n>a+)*', '^(a+b?)+$', '^(?:a+z?)+$', '((a+)?)+', '(a+(?:b)?)*']) expect(repeatsARepeat(p), p).toBe(true);
    for (const p of ['(\\d+\\.)+\\d+', '(\\d+\\.){3}\\d+', 'Request failed with status 5\\d\\d', '[a+]+', '\\(a+\\)+', '(?<name>a+)b', '(a+){2}', 'ECONNRESET.*healthcheck', '(?=a+)b']) expect(repeatsARepeat(p), p).toBe(false);
  });
  it('an app\'s own patterns run with a time budget: one that backtracks without end is stopped and named', () => {
    const t = Date.now();
    expect(() => detect({ stream: 'out', lines: [`${S(1)}${'a'.repeat(30)}!`], contextOnly: 0 }, rules({ match: ['^(a|a)*$'], budgetMs: 200 }), who))
      .toThrowError(expect.objectContaining({ code: 'TIMEOUT', message: expect.stringContaining('errors patterns of api') }));
    expect(Date.now() - t).toBeLessThan(2000);
    expect(detect({ stream: 'out', lines: [`${S(1)}status 503`, `${S(2)}healthcheck status 503`], contextOnly: 0 }, rules({ match: ['status 5\\d\\d'], ignore: ['healthcheck'], context: [0, 0] }), who).map((i) => i.line)).toEqual([`${S(1)}status 503`]);
  });
  it('an app\'s own patterns look only at lines that may start an incident: an old context line cannot stall the new ones', () => {
    const lines = [`${S(1)}${'a'.repeat(30)}!`, `${S(2)}TypeError: new`];
    expect(detect({ stream: 'out', lines, contextOnly: 1 }, rules({ match: ['^(a|a)*$'], budgetMs: 200 }), who).map((i) => i.line)).toEqual([`${S(2)}TypeError: new`]);
  });
  it('markers are looked for in the first 2000 characters of a line: what is cut from the output is not searched either', () => {
    const near = `${S(1)}${'x'.repeat(100)} TypeError: near`;
    const far = `${S(2)}${'x'.repeat(2500)} TypeError: far`;
    expect(detect({ stream: 'out', lines: [near, far], contextOnly: 0 }, rules({ context: [0, 0] }), who).map((i) => i.line)).toEqual([near]);
  });
});

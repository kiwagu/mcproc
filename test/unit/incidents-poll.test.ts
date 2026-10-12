import { describe, it, expect } from 'vitest';
import { pollIncidents } from '../../src/core/incidents/poll.js';
import { mergeCursor } from '../../src/core/incidents/cursor.js';
import { fakeHosts, fleetManifest, proc, S } from '../helpers/incidents.js';

describe('pollIncidents', () => {
  it('first call: errors of the last minutes of each log, from each app\'s own host; second call: nothing new', async () => {
    const state = { files: { '/l/watch-out': `${S(1)}compiling\n${S(2)}TypeError: x is undefined\n${S(3)}    at a (/w.js:1:1)\n${S(4)}done\n`, '/l/web-out': `${S(5)}ready\n` }, procs: { local: [proc('watch', 0)], box: [proc('web', 3)] } };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['watch', 'web']);
    expect(first.answer.incidents.map((i) => `${i.app}@${i.host}:${i.kind}:${i.line}`)).toEqual([`watch@local:error:${S(2)}TypeError: x is undefined`]);
    expect(first.answer.incidents[0].after[0]).toBe(`${S(3)}    at a (/w.js:1:1)`);
    expect(first.answer).toMatchObject({ apps: 2, hosts: 2, more: 0, errors: [], skipped: [] });
    const second = await pollIncidents(h.fleet, ['watch', 'web'], { cursor: first.next });
    expect(second.answer.incidents).toEqual([]);
    state.files['/l/web-out'] += `${S(9)}level=error msg=db down\n`;
    const third = await pollIncidents(h.fleet, ['watch', 'web'], { cursor: mergeCursor(first.next, second.next) });
    expect(third.answer.incidents.map((i) => i.app)).toEqual(['web']);
  });
  it('the first call keeps only errors inside the window, measured from the newest stamp of that file', async () => {
    const state = { files: { '/l/watch-out': `2026-10-12T03:00:00: ERROR: old\n2026-10-12T03:20:00: ERROR: new\n` }, procs: { local: [proc('watch', 0)] } };
    const r = await pollIncidents(fakeHosts(state).fleet, ['watch'], { sinceMin: 15 });
    expect(r.answer.incidents.map((i) => i.line)).toEqual(['2026-10-12T03:20:00: ERROR: new']);
    expect(r.answer.incidents[0].before).toEqual(['2026-10-12T03:00:00: ERROR: old']); // older lines stay as context only
  });
  it('the first call measures its window from the host\'s clock: a quiet app\'s error from yesterday is not new, nor a stale stderr beside a current stdout', async () => {
    const state = { now: '2026-10-12T12:00:00', files: { '/l/watch-out': '2026-10-12T11:59:00: ok\n', '/l/watch-err': '2026-10-11T23:00:00: TypeError: yesterday\n', '/l/web-out': '2026-10-11T23:02:00: ERROR: quiet since yesterday\n' }, procs: { local: [proc('watch', 0)], box: [proc('web', 3)] } };
    const r = await pollIncidents(fakeHosts(state).fleet, ['watch', 'web']);
    expect(r.answer.incidents).toEqual([]);
    state.now = '2026-10-11T23:10:00'; // the same files seen yesterday evening: both errors are recent
    expect((await pollIncidents(fakeHosts(state).fleet, ['watch', 'web'])).answer.incidents.map((i) => i.app).sort()).toEqual(['watch', 'web']);
  });
  it('an app logging without pm2 stamps (time: false) still has its errors found on the first call', async () => {
    const state = { now: '2026-10-12T12:00:00', files: { '/l/watch-out': 'starting\nTypeError: x is undefined\n    at a (/w.js:1:1)\n' }, procs: { local: [proc('watch', 0)] } };
    expect((await pollIncidents(fakeHosts(state).fleet, ['watch'])).answer.incidents.map((i) => i.line)).toEqual(['TypeError: x is undefined']);
  });
  it('an app whose own patterns run away is reported and keeps its point; the other apps still answer', async () => {
    const m = structuredClone(fleetManifest);
    m.apps.watch.errors = { match: ['^(a|a)*$'], ignore: [], context: [3, 5], stderr: false, defaults: true };
    const state = { files: { '/l/watch-out': `${S(1)}${'a'.repeat(30)}!\n`, '/l/web-out': `${S(2)}TypeError: web\n` }, procs: { local: [proc('watch', 0)], box: [proc('web', 3)] } };
    const r = await pollIncidents(fakeHosts(state, [], m).fleet, ['watch', 'web'], { budgetMs: 200 });
    expect(r.answer.incidents.map((i) => i.app)).toEqual(['web']);
    expect(r.answer.errors).toMatchObject([{ host: 'local', apps: ['watch'], message: expect.stringContaining('TIMEOUT') }]);
    expect(r.next.apps['local/watch']).toBeUndefined(); // not analysed: the next poll reads the same lines again
    expect(r.next.apps['box/web']).toBeDefined();
  });
  it('process events: errored is reported once; a restart since the last poll is reported with the count; none on a first call', async () => {
    const state = { files: { '/l/watch-err': `${S(1)}Error: listen EADDRINUSE :::3000\n` }, procs: { local: [proc('watch', 0, { restart_time: 4 })] } as Record<string, object[]> };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['watch']);
    expect(first.answer.incidents.map((i) => i.kind)).toEqual(['error']); // the log line; restarts only recorded
    state.procs.local = [proc('watch', 0, { restart_time: 7 })];
    const second = await pollIncidents(h.fleet, ['watch'], { cursor: first.next });
    expect(second.answer.incidents).toMatchObject([{ kind: 'restarted', count: 3, app: 'watch' }]);
    expect(second.answer.incidents[0].before).toContain(`${S(1)}Error: listen EADDRINUSE :::3000`);
    state.procs.local = [proc('watch', 0, { restart_time: 7, status: 'errored' })];
    const third = await pollIncidents(h.fleet, ['watch'], { cursor: second.next });
    expect(third.answer.incidents.map((i) => i.kind)).toEqual(['crashed']);
    const fourth = await pollIncidents(h.fleet, ['watch'], { cursor: third.next });
    expect(fourth.answer.incidents).toEqual([]);
  });
  it('max keeps the newest incidents and counts the rest; repeats collapse', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${S(i)}ERROR: case ${String.fromCharCode(97 + (i % 26))}${i}`).join('\n');
    const state = { files: { '/l/watch-out': `${lines}\n` }, procs: { local: [proc('watch', 0)] } };
    const r = await pollIncidents(fakeHosts(state).fleet, ['watch'], { max: 5, context: [0, 0] });
    expect(r.answer.incidents).toHaveLength(5);
    expect(r.answer.more).toBeGreaterThan(0);
    expect(r.answer.incidents[0].time).toBe('2026-10-12T11:00:29');
  });
  it('apps not started or with errors: false are skipped; an unreachable host is reported while the others answer; all down throws', async () => {
    const state = { files: {}, procs: { local: [] } };
    const r = await pollIncidents(fakeHosts(state, ['box']).fleet, ['watch', 'web']);
    expect(r.answer.incidents).toEqual([]);
    expect(r.answer.errors).toMatchObject([{ host: 'box', apps: ['web'] }]);
    await expect(pollIncidents(fakeHosts(state, ['box']).fleet, ['web'])).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
  it('one round trip for the logs of all apps of a host', async () => {
    const state = { files: {}, procs: { local: [proc('watch', 0), proc('tool', 1)] } };
    const h = fakeHosts(state);
    await pollIncidents(h.fleet, ['watch', 'tool']);
    expect(h.reads).toEqual(['local']);
  });
});

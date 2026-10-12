import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { LogFollower, sortByStamp } from '../../src/core/logfollow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const paths = { out: '/h/logs/demo-api-out.log', err: '/h/logs/demo-api-error.log' };

function scripted(responses: string[]) {
  let i = 0;
  return fakeCtx(basic, 'local', [{ match: '__MCPROC_LF_out__', result: () => ({ stdout: responses[i++] ?? '' }) }]);
}
const resp = (out: { size: number; body?: string; reset?: boolean }, err: { size: number; body?: string; reset?: boolean }) =>
  `__MCPROC_LF_out__\n${out.size}\n${out.reset ? '__MCPROC_LF_RESET__\n' : ''}${out.body ?? ''}__MCPROC_LF_err__\n${err.size}\n${err.reset ? '__MCPROC_LF_RESET__\n' : ''}${err.body ?? ''}`;

describe('LogFollower', () => {
  it('first poll takes the history, later polls read only new bytes by offset', async () => {
    const ctx = scripted([
      resp({ size: 100, body: '2026-10-11T13:00:01: \x1b[32mready\x1b[39m\n2026-10-11T13:00:02: GET / 200\n' }, { size: 0 }),
      resp({ size: 100 }, { size: 0 }),
      resp({ size: 130, body: '2026-10-11T13:00:09: GET /x 404\n' }, { size: 20, body: '2026-10-11T13:00:08: boom\n' }),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    const first = await f.poll();
    expect(first.lines).toEqual([{ stream: 'out', text: '2026-10-11T13:00:01: \x1b[32mready\x1b[39m' }, { stream: 'out', text: '2026-10-11T13:00:02: GET / 200' }]);
    // reads are bounded to the size just measured: bytes appended between `wc -c` and `tail` belong to the next poll, never to both
    expect(ctx.fake.calls[0].cmd).toContain(`head -c "$sz" '${paths.out}' 2>/dev/null | tail -n 50`);
    expect(f.offsets).toEqual({ out: 100, err: 0 });
    expect((await f.poll()).lines).toEqual([]);
    expect(ctx.fake.calls[1].cmd).toContain(`tail -c +101 '${paths.out}' 2>/dev/null | head -c $((sz-100))`);
    const third = await f.poll();
    expect(third.lines).toEqual([{ stream: 'out', text: '2026-10-11T13:00:09: GET /x 404' }, { stream: 'err', text: '2026-10-11T13:00:08: boom' }]);
    expect(f.offsets).toEqual({ out: 130, err: 20 });
  });
  it('a shrunken file (flush or rotation) resets to the tail', async () => {
    const ctx = scripted([resp({ size: 500, body: 'old\n' }, { size: 0 }), resp({ size: 12, body: 'fresh\n', reset: true }, { size: 0 })]);
    const f = new LogFollower(ctx, paths, 50);
    await f.poll();
    const r = await f.poll();
    expect(r).toEqual({ lines: [{ stream: 'out', text: 'fresh' }], reset: true });
    expect(f.offsets.out).toBe(12);
  });
  it('keeps the app\'s colors and drops every other escape; a color code cut by a read boundary arrives whole', async () => {
    const ctx = scripted([
      resp({ size: 40, body: '2026-10-11T13:00:01: \x1b[?25hstarting\x1b[2K\nx \x1b[3' }, { size: 0 }),
      resp({ size: 60, body: '1mred\x1b[0m\n' }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    expect((await f.poll()).lines).toEqual([{ stream: 'out', text: '2026-10-11T13:00:01: starting' }]);
    expect((await f.poll()).lines).toEqual([{ stream: 'out', text: 'x \x1b[31mred\x1b[0m' }]);
  });
  it('keeps a partial last line until the rest arrives', async () => {
    const ctx = scripted([resp({ size: 10, body: 'hello wor' }, { size: 0 }), resp({ size: 14, body: 'ld\nnext\n' }, { size: 0 })]);
    const f = new LogFollower(ctx, paths, 50);
    expect((await f.poll()).lines).toEqual([]);
    expect((await f.poll()).lines).toEqual([{ stream: 'out', text: 'hello world' }, { stream: 'out', text: 'next' }]);
  });
  it('sortByStamp orders by the pm2 timestamp prefix and keeps unstamped lines in place', () => {
    const s = sortByStamp([{ stream: 'err', text: '2026-10-11T13:00:08: boom' }, { stream: 'out', text: '2026-10-11T13:00:07: a' }, { stream: 'out', text: 'no stamp' }, { stream: 'out', text: '2026-10-11T13:00:09: b' }]);
    expect(s.map((l) => l.text)).toEqual(['2026-10-11T13:00:07: a', '2026-10-11T13:00:08: boom', 'no stamp', '2026-10-11T13:00:09: b']);
  });
});

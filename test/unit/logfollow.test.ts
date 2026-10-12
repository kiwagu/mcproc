import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { LogFollower, sortByStamp } from '../../src/core/logfollow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const paths = {
  out: '/h/logs/demo-api-out.log',
  err: '/h/logs/demo-api-error.log',
};

function scripted(responses: string[]) {
  let i = 0;
  return fakeCtx(basic, 'local', [
    {
      match: '__MCPROC_LF_out__',
      result: () => ({ stdout: responses[i++] ?? '' }),
    },
  ]);
}
/** One file's answer as the host sends it: size, where the read began, why (N new bytes, R replaced), then the raw bytes. */
const sec = (
  s: 'out' | 'err',
  x: { size: number; body?: string; reset?: boolean; start?: number }
) => {
  const body = x.body ?? '';
  const start =
    x.start ?? (x.reset ? 0 : Math.max(0, x.size - Buffer.byteLength(body)));
  return `__MCPROC_LF_${s}__\n${x.size} ${start} ${x.reset ? 'R' : 'N'}\n${body}`;
};
const resp = (
  out: { size: number; body?: string; reset?: boolean; start?: number },
  err: { size: number; body?: string; reset?: boolean; start?: number }
) => sec('out', out) + sec('err', err);

describe('LogFollower', () => {
  it('first poll takes the history, later polls read only new bytes by offset', async () => {
    const ctx = scripted([
      resp(
        {
          size: 100,
          body: '2026-10-11T13:00:01: \x1b[32mready\x1b[39m\n2026-10-11T13:00:02: GET / 200\n',
        },
        { size: 0 }
      ),
      resp({ size: 100 }, { size: 0 }),
      resp(
        { size: 130, body: '2026-10-11T13:00:09: GET /x 404\n' },
        { size: 20, body: '2026-10-11T13:00:08: boom\n' }
      ),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    const first = await f.poll();
    expect(first.lines).toEqual([
      { stream: 'out', text: '2026-10-11T13:00:01: \x1b[32mready\x1b[39m' },
      { stream: 'out', text: '2026-10-11T13:00:02: GET / 200' },
    ]);
    // reads are bounded to the size just measured: bytes appended between `wc -c` and `tail` belong to the next poll, never to both
    expect(ctx.fake.calls[0].cmd).toContain(
      `k=H; st=$((sz>262144?sz-262144:0))`
    ); // history from the last 256 KB at most, never the whole file
    expect(ctx.fake.calls[0].cmd).toContain(
      `tail -c +$((st+1)) '${paths.out}' 2>/dev/null | head -c $((sz-st))`
    );
    expect(f.offsets).toEqual({ out: 100, err: 0 });
    expect((await f.poll()).lines).toEqual([]);
    expect(ctx.fake.calls[1].cmd).toContain('else k=N; st=100; fi');
    const third = await f.poll();
    expect(third.lines).toEqual([
      { stream: 'out', text: '2026-10-11T13:00:09: GET /x 404' },
      { stream: 'err', text: '2026-10-11T13:00:08: boom' },
    ]);
    expect(f.offsets).toEqual({ out: 130, err: 20 });
  });
  it('a short read (the file changed between measuring and reading) advances only by the bytes that arrived', async () => {
    const ctx = scripted([
      resp({ size: 100, body: 'a\n' }, { size: 0 }),
      resp({ size: 160, start: 100, body: 'line one\n' }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    await f.poll();
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['line one']);
    expect(f.offsets.out).toBe(109); // 100 + the 9 bytes received, not the 160 announced
  });
  it('a huge log costs a bounded read: history from its last megabyte, a burst over a megabyte from its newest part, said so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-lf-'));
    const files = {
      out: path.join(dir, 'out.log'),
      err: path.join(dir, 'err.log'),
    };
    fs.writeFileSync(
      files.out,
      Array.from(
        { length: 60_000 },
        (_, i) => `2026-10-11T13:00:00: line ${i} ${'y'.repeat(40)}\n`
      ).join('')
    );
    fs.writeFileSync(files.err, '');
    const real = fakeCtx(basic, 'local', [
      {
        match: '__MCPROC_LF_out__',
        result: (cmd: string) => ({
          stdout: execFileSync('sh', ['-c', cmd], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          }),
        }),
      },
    ]);
    const f = new LogFollower(real, files, 5);
    const first = await f.poll();
    expect(first.lines.map((l) => l.text.split(' ')[2])).toEqual([
      '59995',
      '59996',
      '59997',
      '59998',
      '59999',
    ]);
    expect(real.fake.calls[0].cmd).not.toContain(
      `head -c "$sz" '${files.out}' 2>/dev/null | tail -n`
    ); // never the whole file through a pipe
    fs.appendFileSync(
      files.out,
      Array.from(
        { length: 60_000 },
        (_, i) => `2026-10-11T13:00:01: more ${i} ${'z'.repeat(40)}\n`
      ).join('')
    );
    const burst = await f.poll();
    expect(burst.lines[0].text).toMatch(/^… \d+ bytes of new log skipped$/);
    expect(burst.lines.at(-1)!.text).toContain('more 59999 ');
    expect(burst.lines.length).toBeLessThan(25_000);
    expect(burst.lines[1].text).toMatch(/^2026-10-11T13:00:01: more \d+ z+$/); // the cut first line of the window is dropped
    expect(f.offsets.out).toBe(fs.statSync(files.out).size);
  });
  it('a log replaced or truncated and grown back past the old position starts over from its tail', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-lf-'));
    const files = {
      out: path.join(dir, 'out.log'),
      err: path.join(dir, 'err.log'),
    };
    fs.writeFileSync(files.out, 'old 1\nold 2\n');
    fs.writeFileSync(files.err, '');
    const real = fakeCtx(basic, 'local', [
      {
        match: '__MCPROC_LF_out__',
        result: (cmd: string) => ({
          stdout: execFileSync('sh', ['-c', cmd], { encoding: 'utf8' }),
        }),
      },
    ]);
    const f = new LogFollower(real, files, 5);
    await f.poll();
    fs.writeFileSync(files.out, 'new 1\nnew 2\nnew 3\nnew 4\n'); // rotated: a new file, already longer than the old position
    const r = await f.poll();
    expect(r.reset).toBe(true);
    expect(r.lines.map((l) => l.text)).toEqual([
      'new 1',
      'new 2',
      'new 3',
      'new 4',
    ]);
    fs.appendFileSync(files.out, 'new 5\n');
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['new 5']); // and then goes on as usual
  });
  it('a history, replaced-file or burst read that delivered less than it measured goes on next poll from the bytes that arrived', async () => {
    for (const kind of ['H', 'R', 'S']) {
      const ctx = scripted([
        `__MCPROC_LF_out__\n500 0 ${kind}\n${'x\n'.repeat(50)}__MCPROC_LF_err__\n0 0 N\n`,
        resp({ size: 500, start: 100 }, { size: 0 }),
      ]);
      const f = new LogFollower(ctx, paths, 50);
      if (kind !== 'H') (f.offsets as { out: number | null }).out = 0; // R and S follow a known position
      await f.poll(); // 100 of 500 bytes arrived
      expect(f.offsets.out, kind).toBe(100);
      await f.poll();
      expect(ctx.fake.calls[1].cmd, kind).toContain('else k=N; st=100; fi');
    }
  });
  it('a line that never ends is shown cut instead of growing without limit', async () => {
    const ctx = scripted([
      resp({ size: 0 }, { size: 0 }),
      resp({ size: 200_000, body: 'q'.repeat(200_000) }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    await f.poll();
    const r = await f.poll();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].text.length).toBeLessThanOrEqual(65_537);
    expect(r.lines[0].text.endsWith('…')).toBe(true);
  });
  it('a shrunken file (flush or rotation) resets to the tail', async () => {
    const ctx = scripted([
      resp({ size: 500, body: 'old\n' }, { size: 0 }),
      resp({ size: 6, body: 'fresh\n', reset: true }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    await f.poll();
    const r = await f.poll();
    expect(r).toEqual({
      lines: [{ stream: 'out', text: 'fresh' }],
      reset: true,
    });
    expect(f.offsets.out).toBe(6);
  });
  it("keeps the app's colors and drops every other escape; a color code cut by a read boundary arrives whole", async () => {
    const ctx = scripted([
      resp(
        {
          size: 40,
          body: '2026-10-11T13:00:01: \x1b[?25hstarting\x1b[2K\nx \x1b[3',
        },
        { size: 0 }
      ),
      resp({ size: 60, body: '1mred\x1b[0m\n' }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    expect((await f.poll()).lines).toEqual([
      { stream: 'out', text: '2026-10-11T13:00:01: starting' },
    ]);
    expect((await f.poll()).lines).toEqual([
      { stream: 'out', text: 'x \x1b[31mred\x1b[0m' },
    ]);
  });
  it('keeps a partial last line until the rest arrives', async () => {
    const ctx = scripted([
      resp({ size: 10, body: 'hello wor' }, { size: 0 }),
      resp({ size: 14, body: 'ld\nnext\n' }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 50);
    expect((await f.poll()).lines).toEqual([]);
    expect((await f.poll()).lines).toEqual([
      { stream: 'out', text: 'hello world' },
      { stream: 'out', text: 'next' },
    ]);
  });
  it('sortByStamp orders by the pm2 timestamp prefix and keeps unstamped lines in place', () => {
    const s = sortByStamp([
      { stream: 'err', text: '2026-10-11T13:00:08: boom' },
      { stream: 'out', text: '2026-10-11T13:00:07: a' },
      { stream: 'out', text: 'no stamp' },
      { stream: 'out', text: '2026-10-11T13:00:09: b' },
    ]);
    expect(s.map((l) => l.text)).toEqual([
      '2026-10-11T13:00:07: a',
      '2026-10-11T13:00:08: boom',
      'no stamp',
      '2026-10-11T13:00:09: b',
    ]);
  });
});

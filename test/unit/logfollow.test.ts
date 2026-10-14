import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import {
  createFollower,
  LogFollower,
  readChunk,
  sortByStamp,
} from '../../src/core/logfollow.js';

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
/** One file's answer as the host sends it: size, where the read began, why (N new bytes, R replaced, H history), then the raw bytes. */
type Section = {
  size: number;
  body?: string;
  reset?: boolean;
  history?: boolean;
  start?: number;
};
const sec = (s: 'out' | 'err', x: Section) => {
  const body = x.body ?? '';
  const start =
    x.start ?? (x.reset ? 0 : Math.max(0, x.size - Buffer.byteLength(body)));
  const kind = x.history ? 'H' : x.reset ? 'R' : 'N';
  return `__MCPROC_LF_${s}__\n${x.size} ${start} ${kind}\n${body}`;
};
const resp = (out: Section, err: Section) => sec('out', out) + sec('err', err);

describe('LogFollower', () => {
  it('initialLines 0 takes the position of the history but returns none of its lines', async () => {
    const ctx = scripted([
      resp(
        { size: 20, body: 'old-1\nold-2\n', history: true, start: 8 },
        { size: 0 }
      ),
      resp({ size: 26, body: 'new-1\n' }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 0);
    expect((await f.poll()).lines).toEqual([]);
    expect(f.offsets.out).toBe(20);
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['new-1']);
  });
  it('initialLines 0 keeps every line of a replaced file: all of it was written after the follower began', async () => {
    const ctx = scripted([
      resp({ size: 20, body: 'old-1\nold-2\n', history: true }, { size: 0 }),
      // flushed or rotated: the file starts over and already holds two lines
      resp({ size: 14, body: 'new-1\nnew-2\n', reset: true }, { size: 0 }),
      resp({ size: 20, body: 'new-3\n' }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 0);
    await f.poll();
    const second = await f.poll();
    expect(second.reset).toBe(true);
    expect(second.lines.map((l) => l.text)).toEqual(['new-1', 'new-2']);
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['new-3']);
  });
  it('a replaced file still shows only its last initialLines when history is asked for', async () => {
    const ctx = scripted([
      resp({ size: 6, body: 'a\n', history: true, start: 4 }, { size: 0 }),
      resp({ size: 12, body: 'n1\nn2\nn3\n', reset: true }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 2);
    await f.poll();
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['n2', 'n3']);
  });
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
  it('seek continues exactly at the given offset: the next poll asks from there and returns only what follows', async () => {
    const ctx = scripted([
      resp({ size: 26, body: 'new-1\n', start: 20 }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 0);
    f.seek({
      out: { path: paths.out, offset: 20, at: 20, anchor: 'ab'.repeat(16) },
    });
    expect(f.offsets.out).toBe(20);
    const got = await f.poll();
    expect(got.lines.map((l) => l.text)).toEqual(['new-1']);
    expect(ctx.fake.calls[0].cmd).toContain('st=20'); // a positional read from the seeked offset, not history
    expect(ctx.fake.calls[0].cmd).toContain(`'${'ab'.repeat(16)}'`); // with the anchor, so a replaced file is detected
    expect(f.offsets.out).toBe(26);
  });
  it('seek ignores a mark of another path and an anchor that is not at the offset', async () => {
    const ctx = scripted([
      resp({ size: 6, body: 'a\n', history: true, start: 4 }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 0);
    f.seek({
      out: { path: '/elsewhere', offset: 20 },
      err: { path: paths.err, offset: 7, at: 9, anchor: 'cd'.repeat(16) },
    });
    expect(f.offsets.out).toBeNull();
    expect(f.offsets.err).toBe(7);
    await f.poll();
    expect(ctx.fake.calls[0].cmd).not.toContain('cd'.repeat(16)); // the anchor is for byte 9, the read starts at 7: dropped
  });
  it('a stream without a mark reads its first history since the cutoff: lines at or after it, their continuations with them, nothing older', async () => {
    const hist = [
      'a line before any stamp', // cannot be placed in time
      '2026-10-14T10:00:04.000: old',
      '    at old frame',
      '2026-10-14T10:00:05.000: boot',
      '    at boot frame',
      '2026-10-14T10:00:06: later', // a seconds stamp reads as .000
    ]
      .map((l) => `${l}\n`)
      .join('');
    const size = Buffer.byteLength(hist);
    const ctx = scripted([
      resp({ size, body: hist, history: true, start: 0 }, { size: 0 }),
      resp({ size: size + 6, body: 'new-1\n' }, { size: 0 }),
    ]);
    const f = new LogFollower(ctx, paths, 0);
    f.seek({ cutoff: '2026-10-14T10:00:05.000' });
    expect((await f.poll()).lines.map((l) => l.text)).toEqual([
      '2026-10-14T10:00:05.000: boot',
      '    at boot frame',
      '2026-10-14T10:00:06: later',
    ]);
    expect(f.offsets.out).toBe(size);
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['new-1']); // only the first history is cut by time
  });
  it('the cutoff is only for a stream without a mark: a seeked stream shows everything after its mark, whatever its stamp', async () => {
    const early = '2026-10-14T10:00:01.000: early out\n';
    const errs =
      '2026-10-14T10:00:02.000: old err\n2026-10-14T10:00:07.000: new err\n';
    const ctx = scripted([
      resp(
        { size: 20 + Buffer.byteLength(early), body: early, start: 20 },
        {
          size: Buffer.byteLength(errs),
          body: errs,
          history: true,
          start: 0,
        }
      ),
    ]);
    const f = new LogFollower(ctx, paths, 0);
    f.seek({
      out: { path: paths.out, offset: 20, at: 20, anchor: 'ab'.repeat(16) },
      cutoff: '2026-10-14T10:00:05.000',
    });
    expect((await f.poll()).lines).toEqual([
      { stream: 'out', text: '2026-10-14T10:00:01.000: early out' },
      { stream: 'err', text: '2026-10-14T10:00:07.000: new err' },
    ]);
    expect(ctx.fake.calls[0].cmd).toContain('st=20'); // out went on from its mark
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
  it('sortByStamp orders millisecond stamps within one second, and mixes them with second-only ones', () => {
    const s = sortByStamp([
      { stream: 'out', text: '2026-10-11T13:00:07.900: late' },
      { stream: 'err', text: '2026-10-11T13:00:07.100: early' },
      { stream: 'out', text: '2026-10-11T13:00:06: before' },
    ]);
    expect(s.map((l) => l.text.split(' ')[1])).toEqual([
      'before',
      'early',
      'late',
    ]);
  });
});

describe('the local host reads its logs in-process', () => {
  const tmp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-lf-'));
    return { out: path.join(dir, 'out.log'), err: path.join(dir, 'err.log') };
  };
  /** the same files followed twice: through the shell read (run by a real sh) and by the follower the local host gets */
  const twins = (files: { out: string; err: string }) => {
    const shellCtx = fakeCtx(basic, 'local', [
      {
        match: '__MCPROC_LF_out__',
        result: (cmd: string) => ({
          stdout: execFileSync('sh', ['-c', cmd], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'], // a file not there yet: sh says so on stderr, as a host would
          }),
        }),
      },
    ]);
    const localCtx = fakeCtx(basic, 'local', []);
    return {
      shell: new LogFollower(shellCtx, files, 5),
      local: createFollower(localCtx, files, 5),
      spawned: () => localCtx.fake.calls.length,
    };
  };
  const lines = (n: number, tag: string, pad = 40) =>
    Array.from(
      { length: n },
      (_, i) => `2026-10-12T20:00:00.000: ${tag} ${i} ${'x'.repeat(pad)}\n`
    ).join('');

  it('gives what the shell read gives (history, new bytes, a partial line, a burst, a replaced and a shrunk file, a file that appears later), spawning nothing', async () => {
    const files = tmp();
    fs.writeFileSync(files.out, lines(8_000, 'old')); // over the history window: the read starts inside a line
    const { shell, local, spawned } = twins(files);
    const step = async (what: string) => {
      const [a, b] = [await shell.poll(), await local.poll()];
      expect(b, what).toEqual(a);
      expect(local.offsets, what).toEqual(shell.offsets);
      return b;
    };
    expect((await step('history')).lines).toHaveLength(5);
    fs.appendFileSync(files.out, 'next 1\nnext 2\nhalf');
    expect((await step('new bytes')).lines.map((l) => l.text)).toEqual([
      'next 1',
      'next 2',
    ]);
    fs.appendFileSync(files.out, ' done\n');
    expect((await step('the rest of a line')).lines.map((l) => l.text)).toEqual(
      ['half done']
    );
    expect((await step('nothing new')).lines).toEqual([]);
    fs.appendFileSync(files.out, lines(30_000, 'burst'));
    expect((await step('a burst')).lines[0].text).toMatch(/skipped$/);
    fs.writeFileSync(files.out, lines(40_000, 'rotated')); // replaced, already longer than the old position
    expect((await step('replaced')).reset).toBe(true);
    fs.writeFileSync(files.out, 'flushed\n');
    expect((await step('shrunk')).reset).toBe(true);
    fs.writeFileSync(files.err, '2026-10-12T20:00:01.000: late err\n');
    expect((await step('a file that appears later')).lines).toEqual([
      { stream: 'err', text: '2026-10-12T20:00:01.000: late err' },
    ]);
    expect(spawned()).toBe(0);
  });
  it.skipIf(process.getuid?.() === 0)(
    'a log this process may not read goes through the shell instead',
    async () => {
      const files = tmp();
      fs.writeFileSync(files.out, 'secret\n');
      fs.writeFileSync(files.err, '');
      fs.chmodSync(files.out, 0o000);
      const ctx = fakeCtx(basic, 'local', [
        {
          match: '__MCPROC_LF_out__',
          result: () => ({
            stdout: `__MCPROC_LF_out__\n7 0 H\nsecret\n__MCPROC_LF_err__\n0 0 H\n`,
          }),
        },
      ]);
      const r = await createFollower(ctx, files, 5).poll();
      expect(r.lines).toEqual([{ stream: 'out', text: 'secret' }]);
      expect(ctx.fake.calls).toHaveLength(1);
    }
  );
  it('a host reached over ssh or docker keeps the shell read', async () => {
    const ctx = fakeCtx(basic, 'local', [
      {
        match: '__MCPROC_LF_out__',
        result: {
          stdout: '__MCPROC_LF_out__\n0 0 H\n__MCPROC_LF_err__\n0 0 H\n',
        },
      },
    ]);
    ctx.host = { ...ctx.host, local: false, ssh: 'box' };
    await createFollower(ctx, paths, 5).poll();
    expect(ctx.fake.calls).toHaveLength(1);
  });
});

describe('readChunk', () => {
  /** a file whose content the test swaps right after the reader's first read */
  const swapping = (before: string, after: string, afterRead = 1) => {
    let content = Buffer.from(before);
    let reads = 0;
    const fh = {
      stat: async () => ({ size: content.length }),
      read: async (buf: Buffer, off: number, len: number, pos: number) => {
        const src = content.subarray(pos, pos + len);
        src.copy(buf, off);
        if (++reads === afterRead) content = Buffer.from(after); // truncated and rewritten meanwhile
        return { bytesRead: src.length, buffer: buf };
      },
      close: async () => undefined,
    };
    return async () => fh as never;
  };
  const hexTail = (s: string) => Buffer.from(s).subarray(-16).toString('hex');

  it('takes the anchor from the bytes it delivered, even when the file is rewritten during the read', async () => {
    const old = 'old line one\nold line two\n';
    const c = await readChunk(
      { path: '/l/out.log', off: null, anchor: null },
      swapping(old, 'NEW LINE ONE\nNEW LINE TWO\nmore\n')
    );
    expect(c.body).toBe(old);
    expect(c.anchor).toBe(hexTail(old));
  });
  it('a short append reads the bytes before it in the same read, for its anchor', async () => {
    const before = '2026-10-12T21:00:00.000: started\n';
    const c = await readChunk(
      {
        path: '/l/out.log',
        off: Buffer.byteLength(before),
        anchor: hexTail(before),
      },
      swapping(`${before}ok\n`, 'x'.repeat(80), 2) // read 1 checks the old anchor, read 2 takes the bytes
    );
    expect(c).toMatchObject({ kind: 'N', body: 'ok\n', got: 3 });
    expect(c.anchor).toBe(hexTail(`${before}ok\n`));
  });
});

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FrameReader,
  HostStream,
  loopScript,
  type Frame,
  type StreamMember,
} from '../../src/core/hoststream.js';
import type { ChunkRequest, LogChunk } from '../../src/core/logfollow.js';
import { LogFollower } from '../../src/core/logfollow.js';
import { createTransport } from '../../src/transport/index.js';
import type { Host } from '../../src/core/manifest.js';
import type { StreamProc, Transport } from '../../src/transport/types.js';
import { fakeCtx } from '../helpers/ctx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
/** a host reached "remotely" whose commands run on this machine: the loop runs under the real sh */
const stand: Host = {
  name: 'stand',
  local: false,
  ssh_args: [],
  cwd: '/',
  readonly: false,
  shell: { bin: 'sh', flags: ['-c'] },
  env: {},
};
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-hs-'));
const hexEnd = (b: Buffer) =>
  b.subarray(Math.max(0, b.length - 16)).toString('hex');
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag} ${i} ${'x'.repeat(60)}\n`).join(
    ''
  );

/** runs the loop under sh and collects its frames */
function runLoop(
  files: ChunkRequest[],
  opts: Parameters<typeof loopScript>[2] = {}
) {
  const nonce = 'n0nce1';
  const frames: Frame[] = [];
  let beats = 0;
  let broken = false;
  const child = spawn('sh', ['-c', loopScript(nonce, files, opts)], {
    stdio: ['pipe', 'pipe', 'ignore'], // the client holds stdin open while it follows
  });
  const reader = new FrameReader(nonce, {
    frame: (f) => frames.push(f),
    beat: () => beats++,
    broken: () => (broken = true),
  });
  child.stdout.on('data', (d: Buffer) => reader.push(d));
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  return { child, frames, beats: () => beats, broken: () => broken, exited };
}

describe('the host loop', () => {
  it('sends history, new bytes, a replaced file, a burst and a shrunk file as frames with exact counts and anchors', async () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.log');
    const b = path.join(dir, 'b.log'); // not there yet
    fs.writeFileSync(a, lines(5000, 'old')); // over the history window
    const run = runLoop([
      { path: a, off: null, anchor: null },
      { path: b, off: null, anchor: null },
    ]);
    try {
      await until(() => run.frames.length >= 2);
      const content = fs.readFileSync(a);
      const h = run.frames.find((f) => f.index === 0)!.chunk;
      expect(h).toMatchObject({
        from: null,
        kind: 'H',
        size: content.length,
        start: content.length - 262144,
        got: 262144,
        anchor: hexEnd(content),
      });
      expect(h.body).toBe(content.subarray(content.length - 262144).toString());
      expect(run.frames.find((f) => f.index === 1)!.chunk).toMatchObject({
        kind: 'H',
        size: 0,
        got: 0,
      });

      const seen = () => run.frames.length;
      let n = seen();
      fs.appendFileSync(a, 'next\n');
      await until(() => seen() > n);
      expect(run.frames.at(-1)!.chunk).toMatchObject({
        from: content.length,
        kind: 'N',
        start: content.length,
        got: 5,
        body: 'next\n',
      });

      n = seen();
      fs.writeFileSync(b, 'born\n');
      await until(() => seen() > n);
      expect(run.frames.at(-1)).toMatchObject({
        index: 1,
        chunk: { from: 0, kind: 'N', start: 0, body: 'born\n' },
      });

      n = seen();
      const before = fs.statSync(a).size;
      fs.writeFileSync(a, lines(6000, 'new')); // replaced, longer than the old position
      await until(() => seen() > n);
      const r = run.frames.at(-1)!.chunk;
      expect(r).toMatchObject({ from: before, kind: 'R' });
      expect(r.got).toBe(r.size - r.start);

      n = seen();
      const sz = fs.statSync(a).size;
      fs.appendFileSync(a, lines(20_000, 'burst')); // over a megabyte
      await until(() => seen() > n);
      const s = run.frames.at(-1)!.chunk;
      expect(s).toMatchObject({ from: sz, kind: 'S', got: 1048576 });
      expect(s.start).toBe(s.size - 1048576);

      n = seen();
      fs.writeFileSync(a, 'flushed\n');
      await until(() => seen() > n);
      expect(run.frames.at(-1)!.chunk).toMatchObject({
        kind: 'R',
        size: 8,
        start: 0,
        body: 'flushed\n',
        anchor: Buffer.from('flushed\n').toString('hex'),
      });
      expect(run.broken()).toBe(false);
    } finally {
      run.child.kill();
    }
  });
  it('continues from the positions it was given, and dies when nobody reads it any more', async () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.log');
    fs.writeFileSync(a, 'one\ntwo\n');
    const run = runLoop([
      { path: a, off: 4, anchor: Buffer.from('one\n').toString('hex') },
    ]);
    await until(() => run.frames.length >= 1);
    expect(run.frames[0].chunk).toMatchObject({
      kind: 'N',
      start: 4,
      body: 'two\n',
    });
    await until(() => run.beats() > 0);
    run.child.stdout.destroy(); // the reader went away (ssh dropped): the next heartbeat ends the loop
    await Promise.race([
      run.exited,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('loop still running')), 3000)
      ),
    ]);
  });
});

describe('the host loop sees a replacement that keeps the size', () => {
  it('rewritten in place or replaced by a new file of the same length, without a later append', async () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.log');
    fs.writeFileSync(a, 'old\n');
    const run = runLoop([
      { path: a, off: 4, anchor: Buffer.from('old\n').toString('hex') },
    ]);
    try {
      await until(() => run.beats() > 1);
      fs.writeFileSync(a, 'new\n'); // in place: same inode, same size
      await until(() => run.frames.length >= 1);
      expect(run.frames[0].chunk).toMatchObject({ kind: 'R', body: 'new\n' });
      fs.writeFileSync(`${a}.next`, 'nxt\n');
      fs.renameSync(`${a}.next`, a); // a new file under the name
      await until(() => run.frames.length >= 2);
      expect(run.frames[1].chunk).toMatchObject({ kind: 'R', body: 'nxt\n' });
      const beats = run.beats();
      await until(() => run.beats() > beats + 2);
      expect(run.frames).toHaveLength(2); // an unchanged file sends nothing
    } finally {
      run.child.kill();
    }
  });
});

describe('the host loop where stat cannot show every rewrite', () => {
  const sameSize = async (
    opts: Parameters<typeof loopScript>[2],
    waitMs: number
  ) => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.log');
    fs.writeFileSync(a, 'old\n');
    const run = runLoop(
      [{ path: a, off: 4, anchor: Buffer.from('old\n').toString('hex') }],
      opts
    );
    try {
      await until(() => run.beats() > 0);
      await new Promise((r) => setTimeout(r, waitMs));
      fs.writeFileSync(a, 'new\n'); // in place, same length, nothing written after
      await until(() => run.frames.length >= 1, 4000);
      expect(run.frames[0].chunk).toMatchObject({ kind: 'R', body: 'new\n' });
    } finally {
      run.child.kill();
    }
  };
  it('whole-second mtimes (busybox): a rewrite right after the last change is still seen', async () => {
    await sameSize({ stat: '%s %i 0' }, 300); // an mtime that never moves: only the check after a change can see it
  });
  it('without stat -c: a same-size rewrite long after the last change is seen within a few seconds', async () => {
    await sameSize({ stat: null }, 1600);
  });
});

describe('the host loop ends with its client', () => {
  it('when its stdin closes, even while its output is still read (docker exec outlives a killed client)', async () => {
    const dir = tmpdir();
    const a = path.join(dir, 'a.log');
    fs.writeFileSync(a, '');
    const run = runLoop([{ path: a, off: 0, anchor: null }]);
    await until(() => run.beats() > 0);
    run.child.stdin!.end();
    await Promise.race([
      run.exited,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('loop still running')), 3000)
      ),
    ]);
  });
});

describe('FrameReader', () => {
  const frame = (nonce: string, body: string) =>
    `${nonce} 3 10 20 10 N ${Buffer.byteLength(body)} 0a0b\n${body}\n${nonce} end\n`;
  it('skips lines the host printed besides its frames and takes a frame cut at any byte', () => {
    const got: Frame[] = [];
    let beats = 0;
    const r = new FrameReader('abc', {
      frame: (f) => got.push(f),
      beat: () => beats++,
      broken: () => {
        throw new Error('broken');
      },
    });
    const data = Buffer.from(
      `Welcome to the stand\nabc hb\n${frame('abc', 'héllo\nwörld\n')}abc hb\n`
    );
    for (const byte of data) r.push(Buffer.from([byte]));
    expect(beats).toBe(2);
    expect(got).toEqual([
      {
        index: 3,
        chunk: {
          from: 10,
          size: 20,
          start: 10,
          kind: 'N',
          got: Buffer.byteLength('héllo\nwörld\n'),
          anchor: '0a0b',
          body: 'héllo\nwörld\n',
        },
      },
    ]);
  });
  it('a frame that does not end where its count says is reported broken', () => {
    let broken = false;
    const r = new FrameReader('abc', {
      frame: () => undefined,
      beat: () => undefined,
      broken: () => (broken = true),
    });
    r.push(Buffer.from('abc 0 -1 5 0 H 5 \nabcdefgh\nabc end\n'));
    expect(broken).toBe(true);
  });
});

/** a member following its own files, keeping its own positions like a follower does */
function member(files: string[], accept = () => true) {
  const pos = files.map((p) => ({
    path: p,
    off: fs.existsSync(p) ? fs.statSync(p).size : 0,
    anchor: null as string | null,
  }));
  const got: { k: number; chunk: LogChunk }[] = [];
  const m: StreamMember & { got: typeof got; pos: typeof pos } = {
    got,
    pos,
    requests: () => pos.map((p) => ({ ...p })),
    offer(k, chunk) {
      if (!accept() || (chunk.from ?? -1) !== pos[k].off) return false;
      got.push({ k, chunk });
      pos[k].off = chunk.start + chunk.got;
      pos[k].anchor = chunk.anchor || null;
      return true;
    },
  };
  return m;
}
function counted(t: Transport) {
  const procs: StreamProc[] = [];
  const scripts: string[] = [];
  const wrapped: Transport = {
    ...t,
    stream: (cmd) => {
      scripts.push(cmd);
      const p = t.stream!(cmd);
      procs.push(p);
      return p;
    },
  };
  return { wrapped, procs, scripts };
}

describe('HostStream', () => {
  it('follows its members, restarts when one joins, reconnects after a drop and resyncs a member that fell out of step', async () => {
    const dir = tmpdir();
    const [fa, fb] = [path.join(dir, 'a.log'), path.join(dir, 'b.log')];
    fs.writeFileSync(fa, 'a0\n');
    fs.writeFileSync(fb, 'b0\n');
    const t = counted(createTransport(stand));
    const hs = new HostStream(t.wrapped, {
      debounceMs: 10,
      backoffMs: [50],
      stallMs: 5000,
    });
    const A = member([fa]);
    hs.add(A);
    await until(() => hs.covers(A));
    fs.appendFileSync(fa, 'a1\n');
    await until(() => A.got.length === 1);
    expect(A.got[0].chunk.body).toBe('a1\n');

    let stale = true;
    const B = member([fb], () => {
      if (!stale) return true;
      stale = false;
      return false;
    });
    hs.add(B);
    await until(() => hs.covers(B));
    expect(t.procs).toHaveLength(2); // one restart for the new member
    B.pos[0].off = 0; // B falls behind: the next frame for it does not continue where it stands
    fs.appendFileSync(fb, 'b1\n');
    await until(() => t.procs.length === 3); // resync: a new loop from B's position
    await until(() => B.got.length === 1);
    expect(B.got[0].chunk).toMatchObject({ start: 0, body: 'b0\nb1\n' });

    t.procs.at(-1)!.kill(); // the connection drops
    await until(() => t.procs.length === 4);
    await until(() => hs.covers(A));
    fs.appendFileSync(fa, 'a2\n');
    await until(() => A.got.length === 2);
    expect(A.got[1].chunk.body).toBe('a2\n');

    hs.remove(A);
    hs.remove(B);
    expect(hs.covers(A)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.procs).toHaveLength(4); // no member, no loop
  });
});

describe('a remote follower', () => {
  it('wakes on new lines from the host stream and reads them without a command per poll; closed, it reads through the shell again', async () => {
    const dir = tmpdir();
    const files = {
      out: path.join(dir, 'out.log'),
      err: path.join(dir, 'err.log'),
    };
    fs.writeFileSync(files.out, 'first\n');
    fs.writeFileSync(files.err, '');
    const real = createTransport(stand);
    let execs = 0;
    const transport: Transport = {
      ...real,
      exec: (cmd, o) => {
        execs++;
        return real.exec(cmd, o);
      },
    };
    const ctx = { ...fakeCtx(basic, 'local', []), host: stand, transport };
    const f = new LogFollower(ctx, files, 5);
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['first']);
    let woke = 0;
    f.watch(() => woke++);
    await new Promise((r) => setTimeout(r, 600)); // the stream connects
    fs.appendFileSync(files.out, 'second\n');
    await until(() => woke > 0);
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['second']);
    expect(execs).toBe(1);
    f.close();
    fs.appendFileSync(files.out, 'third\n');
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['third']);
    expect(execs).toBe(2);
  });
});

describe('a follower fed by both reads', () => {
  it('a shell read the stream overtook meanwhile is not applied twice', async () => {
    let release: (stdout: string) => void = () => {};
    let calls = 0;
    const transport: Transport = {
      describe: () => 'stand',
      exec: () =>
        new Promise((resolve) => {
          calls++;
          if (calls === 1)
            resolve({
              code: 0,
              stdout:
                '__MCPROC_LF_out__\n6 0 H\nfirst\n__MCPROC_LF_err__\n0 0 H\n',
              stderr: '',
            });
          else release = (stdout) => resolve({ code: 0, stdout, stderr: '' });
        }),
    };
    const ctx = { ...fakeCtx(basic, 'local', []), host: stand, transport };
    const f = new LogFollower(ctx, { out: '/l/out.log', err: '/l/err.log' }, 5);
    await f.poll();
    const pending = f.poll(); // the shell read is on its way from offset 6
    await until(() => calls === 2);
    expect(
      f.offer(0, {
        from: 6,
        size: 13,
        start: 6,
        kind: 'N',
        anchor: '',
        body: 'second\n',
        got: 7,
      })
    ).toBe(true); // the stream got there first
    release('__MCPROC_LF_out__\n13 6 N\nsecond\n__MCPROC_LF_err__\n0 0 N\n');
    expect((await pending).lines.map((l) => l.text)).toEqual(['second']);
    expect(f.offsets.out).toBe(13);
  });
});

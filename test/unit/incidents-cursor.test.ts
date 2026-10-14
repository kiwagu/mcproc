import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTEXT_BYTES,
  READ_CAP,
  mergeCursor,
  parseRead,
  readSnippet,
  windowStart,
  type CursorState,
} from '../../src/core/incidents/cursor.js';
import { keepSgr } from '../../src/core/logs.js';

/** Runs the real read snippet with sh against a temp file: what the host would print. */
function read(content: string | Buffer, offset: number | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-inc-'));
  const f = path.join(dir, 'out.log');
  fs.writeFileSync(f, content);
  const stdout = execFileSync('sh', ['-c', readSnippet(0, f, offset)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return parseRead(stdout, 0, offset)!;
}

describe('cursor', () => {
  it('a merge keeps the entries a poll did not touch', () => {
    const c: CursorState = {
      v: 1,
      apps: {
        'local/api': {
          out: { path: '/l/o', offset: 5 },
          restarts: 2,
          status: 'online',
        },
      },
    };
    const m = mergeCursor(c, {
      v: 1,
      apps: { 'box/web': { restarts: 0, status: 'online' } },
    });
    expect(Object.keys(m.apps).sort()).toEqual(['box/web', 'local/api']);
  });
});

describe('read snippet + parseRead', () => {
  it('a file replaced or truncated and grown back past the old position is read from its start, in the same read', () => {
    const f = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-anc-')),
      'out.log'
    );
    const run = (offset: number | null, anchor?: { at: number; hex: string }) =>
      parseRead(
        execFileSync('sh', ['-c', readSnippet(0, f, offset, anchor)], {
          encoding: 'utf8',
        }),
        0,
        offset
      )!;
    fs.writeFileSync(f, 'a1\na2\n'.repeat(20));
    const r1 = run(null);
    expect(r1.anchor).not.toBeNull();
    fs.appendFileSync(f, 'a3\n');
    expect(run(r1.nextOffset, r1.anchor!).start).toBe(r1.nextOffset); // the same file, grown: it goes on where it was
    fs.writeFileSync(f, `b1 TypeError: new\n${'b2\n'.repeat(60)}`); // rotated or flushed, and already longer than before
    const r3 = run(r1.nextOffset, r1.anchor!);
    expect(r3.start).toBe(0);
    expect(r3.lines[0]).toBe('b1 TypeError: new');
    const tampered = { at: r1.anchor!.at, hex: "'; touch /tmp/x; '" }; // the store is a file a person can edit
    expect(readSnippet(0, f, r1.nextOffset, tampered)).not.toContain('touch');
    expect(run(r1.nextOffset, tampered).start).toBe(r1.nextOffset); // ignored, never shell text: the read goes on from the position
  });
  it('a read that delivered less than it announced is marked short', () => {
    expect(
      parseRead(`__MCPROC_INC_0__\n100 40 0\n${'x\n'.repeat(5)}`, 0, 40)!.short
    ).toBe(true);
    expect(
      parseRead(`__MCPROC_INC_0__\n10 0 0\n${'x\n'.repeat(5)}`, 0, 0)!.short
    ).toBe(false);
  });
  it('continues at the offset, with up to 4 KB before it as context-only lines; a partial last line waits for the next poll', () => {
    const old = 'a1\na2\n';
    const r = read(`${old}n1\nn2\npart`, Buffer.byteLength(old));
    expect(r.lines).toEqual(['a1', 'a2', 'n1', 'n2']);
    expect(r.contextOnly).toBe(2);
    expect(r.nextOffset).toBe(Buffer.byteLength(`${old}n1\nn2\n`));
    expect(r.skipped).toBe(0);
  });
  it('shrunk: a file smaller than the offset (flush, rotation) is read from the start', () => {
    const r = read('x1\nx2\n', 10_000);
    expect(r.lines).toEqual(['x1', 'x2']);
    expect(r.contextOnly).toBe(0);
  });
  it('cap: more than 1 MB of new bytes → the last 1 MB is read and the rest reported as skipped', () => {
    const line = `${'y'.repeat(99)}\n`; // 100 bytes
    const content = line.repeat(15_000); // 1.5 MB
    const r = read(content, 0);
    expect(r.skipped).toBe(content.length - READ_CAP);
    expect(r.start).toBe(content.length - READ_CAP);
    expect(r.lines.length - r.contextOnly).toBeLessThanOrEqual(
      READ_CAP / 100 + 1
    );
    expect(r.nextOffset).toBe(content.length);
  });
  it('first call (no offset): the tail of the file, nothing reported as skipped', () => {
    const r = read('f1\nf2\n', null);
    expect(r.lines).toEqual(['f1', 'f2']);
    expect(r.contextOnly).toBe(0);
    expect(r.skipped).toBe(0);
  });
  it('utf-8 boundary: a multi-byte character cut by the context start is dropped with its line, no crash', () => {
    const head = 'é'.repeat(CONTEXT_BYTES); // 2 bytes each
    const old = `${head}\nlast old\n`;
    const r = read(`${old}new\n`, Buffer.byteLength(old));
    expect(r.lines.at(-1)).toBe('new');
    expect(r.lines).toContain('last old');
    expect(r.lines.some((l) => l.includes('�'))).toBe(false);
  });
  it('colors and other escapes are removed from the lines', () => {
    const r = read('\x1b[31mERROR: red\x1b[0m\n', 0);
    expect(r.lines).toEqual(['ERROR: red']);
  });
  it('parseRead strips every escape by default and keeps colors with a clean option', () => {
    const body = '\x1b[32mgreen\x1b[0m \x1b]0;title\x07x\n';
    const out = `__MCPROC_INC_0__\n${Buffer.byteLength(body)} 0 0 ${'a'.repeat(32)}\n${body}`;
    expect(parseRead(out, 0, null)!.lines).toEqual(['green x']);
    expect(parseRead(out, 0, null, { clean: keepSgr })!.lines).toEqual([
      '\x1b[32mgreen\x1b[0m x',
    ]);
  });
  it('an empty or missing file is no lines and no error', () => {
    expect(read('', 0)).toMatchObject({ lines: [], nextOffset: 0 });
  });
});

describe('windowStart', () => {
  it("the first call looks back from the file's own newest stamp, whatever the agent's clock or time zone", () => {
    const lines = [
      '2026-10-12T03:00:00: a',
      'no stamp',
      '2026-10-12T03:20:00: b',
    ];
    expect(windowStart(lines, 15)).toBe('2026-10-12T03:05:00');
    expect(windowStart(['plain'], 15)).toBeNull();
  });
  it("with the host's current time it looks back from now: a quiet file's old lines fall outside", () => {
    expect(
      windowStart(['2026-10-11T23:00:00: old'], 15, '2026-10-12T12:00:00')
    ).toBe('2026-10-12T11:45:00');
  });
  it("a file without any stamp gets no window, whatever the host's clock: its lines cannot be placed in time", () => {
    expect(
      windowStart(['TypeError: no stamp', 'at x'], 15, '2026-10-12T12:00:00')
    ).toBeNull();
  });
});

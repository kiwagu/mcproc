import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DirWatchers } from '../../src/core/logwatch.js';
import { createFollower } from '../../src/core/logfollow.js';
import { fakeCtx } from '../helpers/ctx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

/** resolves true at the first wake, false when none came within `ms` */
const nextWake = (arm: (wake: () => void) => void, ms: number) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    arm(() => {
      clearTimeout(t);
      resolve(true);
    });
  });

describe('DirWatchers', () => {
  it('one OS watcher per directory, shared by its subscribers and closed with the last one', () => {
    const opened: string[] = [];
    let closed = 0;
    const fake = (dir: string) => {
      opened.push(dir);
      return { close: () => void closed++, on: () => undefined };
    };
    const w = new DirWatchers(fake as never);
    const a = w.watch('/logs', () => undefined);
    const b = w.watch('/logs', () => undefined);
    const c = w.watch('/other', () => undefined);
    expect(opened).toEqual(['/logs', '/other']);
    a();
    expect(closed).toBe(0);
    b();
    c();
    expect(closed).toBe(2);
    w.watch('/logs', () => undefined);
    expect(opened).toEqual(['/logs', '/other', '/logs']);
  });
  it('a directory that cannot be watched gives no events and is tried again by the next subscriber', () => {
    let tries = 0;
    const failing = () => {
      tries++;
      throw Object.assign(new Error('no dir'), { code: 'ENOENT' });
    };
    const w = new DirWatchers(failing as never);
    const off = w.watch('/missing', () => undefined);
    w.watch('/missing', () => undefined);
    expect(tries).toBe(2);
    off();
  });
});

describe('a local follower wakes on its log files', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-lw-'));
    const files = {
      out: path.join(dir, 'app-out.log'),
      err: path.join(dir, 'app-error.log'),
    };
    fs.writeFileSync(files.out, '');
    fs.writeFileSync(files.err, '');
    const f = createFollower(fakeCtx(basic, 'local', []), files, 5);
    return { dir, files, f };
  };

  it('within milliseconds of an append, also after the file is rotated', async () => {
    const { files, f } = setup();
    await f.poll();
    let wake = () => {};
    f.watch!(() => wake());
    const t0 = performance.now();
    const woke = nextWake((w) => (wake = w), 1000);
    fs.appendFileSync(files.out, 'hello\n');
    expect(await woke).toBe(true);
    expect(performance.now() - t0).toBeLessThan(200);
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['hello']);

    fs.renameSync(files.out, `${files.out}.1`); // rotation: the old file moves away, a new one takes its name
    const rotated = nextWake((w) => (wake = w), 1000);
    fs.writeFileSync(files.out, 'fresh\n');
    expect(await rotated).toBe(true);
    expect((await f.poll()).lines.map((l) => l.text)).toEqual(['fresh']);
    const again = nextWake((w) => (wake = w), 1000);
    fs.appendFileSync(files.err, 'oops\n');
    expect(await again).toBe(true);
    f.close!();
  });
  it("another app's file in the same directory does not wake it, and a closed follower stays asleep", async () => {
    const { dir, files, f } = setup();
    let wake = () => {};
    f.watch!(() => wake());
    const other = nextWake((w) => (wake = w), 150);
    fs.appendFileSync(path.join(dir, 'other-out.log'), 'noise\n');
    expect(await other).toBe(false);
    f.close!();
    const after = nextWake((w) => (wake = w), 150);
    fs.appendFileSync(files.out, 'late\n');
    expect(await after).toBe(false);
  });
});

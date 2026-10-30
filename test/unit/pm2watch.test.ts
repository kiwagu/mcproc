import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { procWorld } from '../helpers/procfs.js';
import type { App } from '../../src/core/manifest.js';
import { Pm2Client } from '../../src/core/pm2.js';
import { ProcReader } from '../../src/core/procfs.js';
import {
  WATCH_CHECK_MS,
  WATCH_RETRY_MS,
  closePidWatches,
  followPids,
  ownPidFile,
  pidPrefix,
  watchPids,
  type FeedNote,
} from '../../src/core/pm2watch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};
const bases: string[] = [];
const base = () => {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-pw-'));
  bases.push(b);
  return b;
};
/** what pm2 does to its pids directory: a start writes `<name>-<pm_id>.pid`, a stop or an exit removes it */
const start = (dir: string, file: string) =>
  fs.writeFileSync(path.join(dir, file), '4242');
const stop = (dir: string, file: string) =>
  fs.rmSync(path.join(dir, file), { force: true });

afterEach(() => {
  closePidWatches();
  vi.restoreAllMocks();
  for (const b of bases.splice(0))
    fs.rmSync(b, { recursive: true, force: true });
});

describe('pidPrefix and ownPidFile', () => {
  it("the start of a project's pid file names, as pm2 writes them", () => {
    expect(pidPrefix('demo')).toBe('demo-');
    expect(pidPrefix('my_proj')).toBe('my-proj-');
    expect(pidPrefix('a.b')).toBe('a.b-');
  });
  it('the app whose pm2 options write its pid file elsewhere', () => {
    const app = (name: string, pm2: Record<string, unknown>) =>
      ({ name, pm2 }) as unknown as App;
    expect(
      ownPidFile({ a: app('a', {}), b: app('b', { kill_timeout: 3000 }) })
    ).toBeNull();
    expect(
      ownPidFile({ a: app('a', {}), b: app('b', { pid_file: '/run/b.pid' }) })
    ).toBe('b');
    expect(ownPidFile({ c: app('c', { pid: '/run/c.pid' }) })).toBe('c');
  });
});

describe('watchPids', () => {
  it("is up while the directory is there, and hears its project's pid files only", async () => {
    const dir = path.join(base(), 'pids');
    fs.mkdirSync(dir);
    const mine: FeedNote[] = [];
    const theirs: FeedNote[] = [];
    const f = watchPids(dir, 'demo-', (n) => mine.push(n));
    watchPids(dir, 'other-', (n) => theirs.push(n));
    await sleep(0);
    expect(f.up).toBe(true);
    expect(mine).toEqual(['up']);
    start(dir, 'demo-api-0.pid');
    await until('the start', () => mine.includes('event'));
    await sleep(100);
    const seen = mine.length;
    fs.writeFileSync(path.join(dir, 'demo-notes.txt'), 'x'); // not a pid file
    start(dir, 'other-web-1.pid');
    await until("the other project's start", () => theirs.includes('event'));
    await sleep(100);
    expect(mine).toHaveLength(seen);
    stop(dir, 'demo-api-0.pid');
    await until('the stop', () => mine.length > seen);
  });
  it('no directory yet (no daemon has run there): not up; up once it is made, and its events come', async () => {
    const dir = path.join(base(), 'pids');
    const notes: FeedNote[] = [];
    const f = watchPids(dir, 'demo-', (n) => notes.push(n));
    await sleep(100);
    expect(f.up).toBe(false);
    expect(notes).toEqual([]);
    fs.mkdirSync(dir);
    await until('up', () => notes.includes('up'), WATCH_RETRY_MS + 2000);
    start(dir, 'demo-api-0.pid');
    await until('the start', () => notes.includes('event'));
  });
  it('a home removed with its pids directory is down, and up again once it is back', async () => {
    const b = base();
    const dir = path.join(b, 'h', 'pids');
    fs.mkdirSync(dir, { recursive: true });
    const notes: FeedNote[] = [];
    const f = watchPids(dir, 'demo-', (n) => notes.push(n));
    await sleep(0);
    fs.rmSync(path.join(b, 'h'), { recursive: true, force: true });
    await until('down', () => notes.includes('down'));
    expect(f.up).toBe(false);
    fs.mkdirSync(dir, { recursive: true });
    await until(
      'up again',
      () => notes.filter((n) => n === 'up').length === 2,
      WATCH_RETRY_MS + 2000
    );
    expect(notes).toEqual(['up', 'down', 'up']);
    start(dir, 'demo-api-0.pid');
    await until('an event from the new directory', () =>
      notes.includes('event')
    );
  });
  it('a home moved away, which sends the watch no event, is down at the next check, then up on the new directory', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // the check only: the retry and the waits stay real
    try {
      const b = base();
      const dir = path.join(b, 'h', 'pids');
      fs.mkdirSync(dir, { recursive: true });
      const notes: FeedNote[] = [];
      const f = watchPids(dir, 'demo-', (n) => notes.push(n));
      await sleep(0);
      // `mv ~/.pm2 ~/.pm2.bak`, then a new daemon at the old path: only an ancestor of the watched directory moved
      fs.renameSync(path.join(b, 'h'), path.join(b, 'h.old'));
      fs.mkdirSync(dir, { recursive: true });
      await sleep(100);
      expect(notes).toEqual(['up']);
      vi.advanceTimersByTime(WATCH_CHECK_MS);
      expect(notes).toEqual(['up', 'down']);
      await until('up again', () => notes.length === 3, WATCH_RETRY_MS + 2000);
      expect(notes).toEqual(['up', 'down', 'up']);
      start(dir, 'demo-api-0.pid');
      await until('an event from the new directory', () =>
        notes.includes('event')
      );
      f.close();
    } finally {
      vi.useRealTimers();
    }
  });
  it('one watch per directory; a subscriber that comes while it is up hears so at once; the last close ends it', async () => {
    const dir = path.join(base(), 'pids');
    fs.mkdirSync(dir);
    const spy = vi.spyOn(fs, 'watch');
    const a: FeedNote[] = [];
    const b: FeedNote[] = [];
    const fa = watchPids(dir, 'demo-', (n) => a.push(n));
    const fb = watchPids(dir, 'demo-', (n) => b.push(n));
    await sleep(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(b).toEqual(['up']);
    const closing = vi.spyOn(
      spy.mock.results[0].value as fs.FSWatcher,
      'close'
    );
    fa.close();
    expect(closing).not.toHaveBeenCalled();
    fb.close();
    expect(closing).toHaveBeenCalledTimes(1);
  });
  it('a watch keeps no process alive, nor does its retry while the directory is missing', () => {
    const b = base();
    fs.mkdirSync(path.join(b, 'pids'));
    const mod = path.resolve(here, '..', '..', 'src', 'core', 'pm2watch.ts');
    const child = path.join(b, 'child.mts');
    fs.writeFileSync(
      child,
      [
        `import { watchPids } from ${JSON.stringify(mod)};`,
        `watchPids(${JSON.stringify(path.join(b, 'pids'))}, 'demo-', () => {});`,
        `watchPids(${JSON.stringify(path.join(b, 'none', 'pids'))}, 'demo-', () => {});`,
        '',
      ].join('\n')
    );
    const r = spawnSync(process.execPath, ['--import', 'tsx', child], {
      timeout: 15_000,
      encoding: 'utf8',
    });
    expect(r.signal).toBeNull(); // not cut by the timeout: it exited by itself
    expect(r.status).toBe(0);
  }, 20_000);
});

describe('followPids', () => {
  const ctxAt = (pm2Home: string) => {
    const ctx = fakeCtx(basic, 'local', []);
    return {
      ...ctx,
      pm2: new Pm2Client(ctx.fake, ctx.host, 'pm2', pm2Home, async () => []),
      proc: new ProcReader(procWorld({ procs: [] })),
    };
  };
  it("watches the daemon home's pids for the project's processes", async () => {
    const h = base();
    fs.mkdirSync(path.join(h, 'pids'));
    const notes: FeedNote[] = [];
    const f = await followPids(ctxAt(h), (n) => notes.push(n));
    expect(f).not.toBeNull();
    start(path.join(h, 'pids'), 'demo-api-0.pid');
    await until('the start', () => notes.includes('event'));
  });
  it('no in-process scan, another host, or an app with a pid file of its own: no watch', async () => {
    const c = ctxAt(base());
    expect(await followPids({ ...c, proc: null }, () => {})).toBeNull();
    expect(
      await followPids({ ...c, host: { ...c.host, local: false } }, () => {})
    ).toBeNull();
    const api = c.manifest.apps.api;
    const own = {
      ...c,
      manifest: {
        ...c.manifest,
        apps: {
          ...c.manifest.apps,
          api: { ...api, pm2: { pid_file: '/run/api.pid' } },
        },
      },
    };
    expect(await followPids(own, () => {})).toBeNull();
  });
});

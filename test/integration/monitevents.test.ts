import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  clearResolutionCache,
  connect,
  prepare,
} from '../../src/core/resolve.js';
import { actOn, Fleet } from '../../src/core/fleet.js';
import { rowsFor, snapshot, type Snapshot } from '../../src/core/list.js';
import { findProcess } from '../../src/core/pm2.js';
import { closeDaemons } from '../../src/core/pm2socket.js';
import { descendants } from '../../src/core/ports.js';
import {
  closePidWatches,
  followPids,
  pidPrefix,
  watchPids,
  type FeedNote,
} from '../../src/core/pm2watch.js';
import { MonitLoop, type LoopDeps } from '../../src/monit/loop.js';
import {
  appInfos,
  initialState,
  reduce,
  viewLabel,
  type MonitState,
} from '../../src/monit/state.js';
import { clearLoginEnvCache } from '../../src/transport/index.js';

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const PORT = 38351;
const pm2Bin = createRequire(import.meta.url).resolve('pm2/bin/pm2');
/** set once beforeAll made them: empty, the teardown touches no daemon and no directory */
let base = '';
let home = '';
let project = '';
const saved = process.env.PM2_HOME;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};
/** A pm2 call that hangs fails its test after this long: a synchronous call blocks the timers that would time the test out. */
const PM2_CALL_MS = 30_000;
/** pm2 itself on the throwaway home: never without it, or it would reach ~/.pm2 */
const pm2 = (...args: string[]) => {
  if (!home) throw new Error('no throwaway home');
  execFileSync(process.execPath, [pm2Bin, ...args], {
    env: { ...process.env, PM2_HOME: home, PORT: String(PORT + 1) },
    stdio: 'ignore',
    timeout: PM2_CALL_MS,
  });
};
/** web's CPU ticks in a snapshot's first sample: its pm2 process and every descendant. */
const webTicks = (s: Snapshot): number => {
  const root = findProcess(s.procs, 'ev', 'web')?.pid ?? 0;
  const ticks = s.stats.samples[0]?.ticks ?? new Map<number, number>();
  return [root, ...descendants(s.tree, root)].reduce(
    (sum, pid) => sum + (ticks.get(pid) ?? 0),
    0
  );
};
/** Stops the daemon of the throwaway home, only when one runs there. */
function killDaemon(at: string) {
  if (!at || !fs.existsSync(path.join(at, 'pm2.pid'))) return;
  execFileSync(process.execPath, [pm2Bin, 'kill'], {
    env: { ...process.env, PM2_HOME: at },
    stdio: 'ignore',
    timeout: PM2_CALL_MS,
  });
}

beforeAll(() => {
  base = fs.mkdtempSync('/tmp/mcproc-ev-'); // short: unix socket paths are capped at 108 bytes
  home = path.join(base, 'h');
  process.env.PM2_HOME = home;
  project = path.join(base, 'p');
  fs.mkdirSync(path.join(project, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(project, 'server.js'), SERVER);
  fs.writeFileSync(
    path.join(project, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      'project: ev',
      'apps:',
      '  web:',
      '    description: http server',
      '    run: node server.js',
      `    env: { PORT: ${PORT} }`,
      `    port: ${PORT}`,
      'hosts:',
      '  local:',
      `    pm2_home: ${home}`,
      '',
    ].join('\n')
  );
  clearResolutionCache();
  clearLoginEnvCache();
});

afterAll(() => {
  closePidWatches();
  closeDaemons();
  let failure: { cause: unknown } | null = null;
  try {
    killDaemon(home);
  } catch (cause) {
    failure = { cause };
  }
  if (saved === undefined) delete process.env.PM2_HOME;
  else process.env.PM2_HOME = saved;
  clearLoginEnvCache();
  // its daemon may still run, and web with it: removing its home would leave them out of pm2's reach
  if (failure)
    throw new Error(
      `pm2 kill failed on ${home}; kept ${base}, so \`PM2_HOME=${home} pm2 kill\` can still stop its daemon`,
      failure
    );
  if (base) fs.rmSync(base, { recursive: true, force: true });
}, 60_000); // pm2 kill may take up to PM2_CALL_MS

describe('monit events, on real pm2', () => {
  it("a pid watch follows a real daemon: up once it made its pids directory, its project's starts and restarts, across a kill and a new daemon", async () => {
    const dir = path.join(home, 'pids');
    const mine: FeedNote[] = [];
    const theirs: FeedNote[] = [];
    const a = watchPids(dir, pidPrefix('ev'), (n) => mine.push(n));
    const b = watchPids(dir, pidPrefix('other'), (n) => theirs.push(n));
    const events = () => mine.filter((n) => n === 'event').length;
    await sleep(1500);
    expect(a.up).toBe(false); // no daemon has made its pids directory yet
    pm2('ping');
    await until('up', () => mine.includes('up'));
    pm2('start', path.join(project, 'server.js'), '--name', 'ev-probe');
    await until('the start', () => events() > 0);
    let before = events();
    pm2('restart', 'ev-probe');
    await until('the restart', () => events() > before);
    // the other project's subscriber listens (it heard the watch come up) and heard none of this project's events
    expect(theirs).toEqual(['up']);
    pm2('kill');
    await sleep(500);
    expect(a.up).toBe(true); // pm2 kill empties the directory; it does not remove it
    expect(mine).not.toContain('down');
    pm2('ping');
    before = events();
    pm2('start', path.join(project, 'server.js'), '--name', 'ev-probe');
    await until('a start under the new daemon', () => events() > before);
    pm2('delete', 'ev-probe');
    a.close();
    b.close();
  }, 60_000);

  it('the in-process scan sees what the script sees', async () => {
    const fleet = new Fleet(prepare({ project }).manifest, undefined);
    // one sample each, so the CPU ticks of the two scans compare
    const once = { cpu: 'none', urls: 'none', leases: 'none' } as const;
    try {
      await actOn(fleet, 'web', 'start');
      const ctx = await connect(prepare({ project }));
      expect(ctx.proc).toBeTruthy();
      let mine = await snapshot(ctx, once);
      for (
        let i = 0;
        i < 40 && mine.ports.web.checks[0]?.status !== 'listening';
        i++
      ) {
        await sleep(250);
        mine = await snapshot(ctx, once);
      }
      // web really listens: two scans that both saw no listener would agree on nothing
      expect(mine.ports.web.checks[0]?.status).toBe('listening');
      const script = await snapshot({ ...ctx, proc: null }, once);
      expect(script.ports.web.actual).not.toEqual([]);
      expect(mine.ports.web.checks).toEqual(script.ports.web.checks);
      expect(mine.ports.web.actual.map((l) => l.pid)).toEqual(
        script.ports.web.actual.map((l) => l.pid)
      );
      const m = mine.metrics.web!;
      const s = script.metrics.web!;
      expect(m.procs).toBe(s.procs);
      expect(Math.abs(m.memory - s.memory)).toBeLessThanOrEqual(s.memory * 0.1);
      expect(m.runtime).toBe(s.runtime);
      // the same ticks read the same way: the script's, taken a moment later, within an order of magnitude
      const ticks = webTicks(mine);
      expect(ticks).toBeGreaterThan(0);
      expect(webTicks(script) / ticks).toBeGreaterThanOrEqual(0.1);
      expect(webTicks(script) / ticks).toBeLessThanOrEqual(10);
    } finally {
      // the next case starts web from stopped, and checks that it is
      await actOn(fleet, 'web', 'stop').catch(() => undefined);
    }
  }, 60_000);

  it('monit reads on the events: a start and a stop show without a timer', async () => {
    pm2('ping'); // so a daemon has made its pids directory and the loop's watch is up at once, even with this case alone
    const { manifest } = prepare({ project });
    /** what the loop's own feed told it: the screen shows no sign of the feed */
    const heard: FeedNote[] = [];
    let state: MonitState = initialState({
      project: manifest.project,
      host: viewLabel('local'),
      hosts: ['local'],
      apps: appInfos(manifest),
    });
    const deps: LoopDeps = {
      fleet: (r) => new Fleet(manifest, r),
      snapshot,
      rows: rowsFor,
      follower: () => ({ poll: async () => ({ lines: [], reset: false }) }),
      command: async () => undefined,
      reloadAll: async () => undefined,
      clear: async () => [],
      cleared: () => ({ at: {}, gen: {} }),
      peekIncidents: async () => {
        throw new Error('not opened here');
      },
      events: (ctx, on) =>
        followPids(ctx, (n) => {
          on(n);
          heard.push(n);
        }),
    };
    const loop = new MonitLoop(
      new Fleet(manifest, 'local'),
      deps,
      { lines: 10 },
      () => state,
      (a) => {
        state = reduce(state, a);
      }
    );
    const web = () => state.rows.find((r) => r.app === 'web');
    const fleet = new Fleet(manifest, undefined);
    try {
      // ten minutes: within this test only pm2's pid files (or a port check after one of their events) can explain a read
      loop.start(600_000);
      await loop.refresh();
      // the loop's own feed must be up before the start: one that came up after it would show web online by the
      // read it makes on coming up, not by the start's event
      await until("the loop's feed up", () => heard.includes('up'));
      // not running before the start: online can only come from the start's event
      expect(['stopped', 'not-started']).toContain(web()?.status);
      await actOn(fleet, 'web', 'start');
      await until('web online on the screen', () => web()?.status === 'online');
      await until(
        'its port listening on the screen',
        () => web()?.ports.checks[0]?.status === 'listening'
      );
      await actOn(fleet, 'web', 'stop');
      await until(
        'web stopped on the screen',
        () => web()?.status === 'stopped'
      );
    } finally {
      loop.close();
      // a case that failed before its stop leaves web running for no one; after the stop above this changes nothing
      await actOn(fleet, 'web', 'stop').catch(() => undefined);
    }
  }, 60_000);
});

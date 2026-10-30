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
import { rowsFor, snapshot } from '../../src/core/list.js';
import { closeDaemons } from '../../src/core/pm2socket.js';
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
/** pm2 itself on the throwaway home: never without it, or it would reach ~/.pm2 */
const pm2 = (...args: string[]) => {
  if (!home) throw new Error('no throwaway home');
  execFileSync(process.execPath, [pm2Bin, ...args], {
    env: { ...process.env, PM2_HOME: home, PORT: String(PORT + 1) },
    stdio: 'ignore',
  });
};
/** Stops the daemon of the throwaway home, only when one runs there. */
function killDaemon(at: string) {
  if (!at || !fs.existsSync(path.join(at, 'pm2.pid'))) return;
  execFileSync(process.execPath, [pm2Bin, 'kill'], {
    env: { ...process.env, PM2_HOME: at },
    stdio: 'ignore',
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
  try {
    killDaemon(home);
  } catch {
    /* no daemon left */
  }
  if (saved === undefined) delete process.env.PM2_HOME;
  else process.env.PM2_HOME = saved;
  clearLoginEnvCache();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

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
    expect(theirs.filter((n) => n === 'event')).toEqual([]);
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
    await actOn(fleet, 'web', 'start');
    const ctx = await connect(prepare({ project }));
    expect(ctx.proc).toBeTruthy();
    let mine = await snapshot(ctx, { urls: 'none', leases: 'none' });
    for (
      let i = 0;
      i < 40 && mine.ports.web.checks[0]?.status !== 'listening';
      i++
    ) {
      await sleep(250);
      mine = await snapshot(ctx, { urls: 'none', leases: 'none' });
    }
    const script = await snapshot(
      { ...ctx, proc: null },
      { urls: 'none', leases: 'none' }
    );
    expect(mine.ports.web.checks).toEqual(script.ports.web.checks);
    expect(mine.ports.web.actual.map((l) => l.pid)).toEqual(
      script.ports.web.actual.map((l) => l.pid)
    );
    const m = mine.metrics.web!;
    const s = script.metrics.web!;
    expect(m.procs).toBe(s.procs);
    expect(Math.abs(m.memory - s.memory)).toBeLessThanOrEqual(s.memory * 0.1);
    expect(m.runtime).toBe(s.runtime);
    await actOn(fleet, 'web', 'stop');
  }, 60_000);

  it('monit reads on the events: a start and a stop show without a timer', async () => {
    const { manifest } = prepare({ project });
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
      events: followPids,
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
    // ten minutes: within this test only pm2's pid files (or a port check after one of their events) can explain a read
    loop.start(600_000);
    await loop.refresh();
    await sleep(500); // the watch is up at once: the daemon of the cases above made its pids directory
    const web = () => state.rows.find((r) => r.app === 'web');
    const fleet = new Fleet(manifest, undefined);
    await actOn(fleet, 'web', 'start');
    await until('web online on the screen', () => web()?.status === 'online');
    await until(
      'its port listening on the screen',
      () => web()?.ports.checks[0]?.status === 'listening'
    );
    await actOn(fleet, 'web', 'stop');
    await until('web stopped on the screen', () => web()?.status === 'stopped');
    loop.close();
  }, 60_000);
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clearResolutionCache, prepare } from '../../src/core/resolve.js';
import { Fleet, actOn, listFleet } from '../../src/core/fleet.js';
import { countReloads } from '../../src/core/reloadcount.js';
import { RELOAD_GAP_MS } from '../../src/core/reloads.js';
import { pollIncidents } from '../../src/core/incidents/poll.js';
import { parseUntil, waitFor } from '../../src/core/wait.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
/** The bundle under test: dist/cli.js, or another build of this tree (a branch built elsewhere, so dist keeps serving the installed mcproc). */
const cli = process.env.MCPROC_CLI ?? path.join(root, 'dist', 'cli.js');
const PORT = 28413;
/**
 * A server that reloads in place the way tsx watch does, without pm2 seeing it: on a `poke` file it prints tsx's
 * restart line and, 300 ms later, its listening line again, in the same process with the port still bound.
 */
const SVC = `
const fs = require('fs');
const path = require('path');
const poke = path.join(__dirname, 'poke');
require('http').createServer((q, s) => s.end('ok')).listen(${PORT}, () => {
  console.log('svc listening on ${PORT}');
  setInterval(() => {
    if (!fs.existsSync(poke)) return;
    fs.rmSync(poke, { force: true });
    console.log('[tsx] change in ./dist/index.js Restarting...');
    setTimeout(() => console.log('svc listening on ${PORT}'), 300);
  }, 200);
});
`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

/** Stops the daemon of a PM2_HOME with the bundled pm2, for a setup that failed before a fleet existed. */
function killDaemon(home: string) {
  if (!fs.existsSync(path.join(home, 'pm2.pid'))) return;
  const pm2 = createRequire(import.meta.url).resolve('pm2/bin/pm2');
  execFileSync(process.execPath, [pm2, 'kill'], {
    env: { ...process.env, PM2_HOME: home },
    stdio: 'ignore',
  });
}

describe.skipIf(process.env.MCPROC_IT !== '1')('reloads on real pm2', () => {
  let base: string | undefined;
  let home: string | undefined;
  let dir = '';
  let fleet: Fleet | undefined;
  /** the fleet, once beforeAll has made it */
  const f = () => fleet!;
  /** svc's reloads since its pm2 start, as ls --reloads counts them */
  const counted = async () => {
    const listed = await listFleet(f(), ['svc']);
    const r = await countReloads(f(), listed.probes, listed.rows);
    expect(r.errors).toEqual([]);
    return r.rows.find((x) => x.app === 'svc')!.reloads;
  };
  /** Waits until svc's next reload, poking it once the wait has had time to take its place at the end of the log. */
  const pokeAndWait = async () => {
    const ctx = await f().ctx('local');
    const stop = new AbortController(); // a failure below must not leave the wait running for its whole timeout
    const p = waitFor(ctx, 'svc', parseUntil('reloaded'), {
      timeoutMs: 20_000,
      signal: stop.signal,
    });
    p.catch(() => {}); // judged by the await below; this only keeps an early failure from going unhandled
    try {
      await sleep(500);
      fs.writeFileSync(path.join(dir, 'poke'), '');
      return await p;
    } finally {
      stop.abort();
    }
  };
  beforeAll(async () => {
    base = fs.mkdtempSync('/tmp/mcproc-rl-'); // short: unix socket paths are capped at 108 bytes
    home = path.join(base, 'home');
    dir = path.join(base, 'p');
    fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'svc.js'), SVC);
    fs.writeFileSync(
      path.join(dir, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: itrl',
        'apps:',
        '  svc:',
        '    description: a server that reloads in place when poked',
        '    run: node svc.js',
        `    port: ${PORT}`,
        'hosts:',
        '  local:',
        `    pm2_home: ${home}`,
        '',
      ].join('\n')
    );
    clearResolutionCache();
    fleet = new Fleet(prepare({ project: dir }).manifest, undefined);
  }, 60_000);
  afterAll(async () => {
    try {
      if (fleet) await (await fleet.ctx('local')).pm2.run(['kill']);
      else if (home) killDaemon(home); // setup failed before a fleet existed: the daemon may still be there
    } catch {
      try {
        if (home) killDaemon(home);
      } catch {
        /* daemon already gone */
      }
    }
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('starts svc and waits until it listens', async () => {
    await actOn(f(), 'svc', 'start');
    expect(
      await waitFor(await f().ctx('local'), 'svc', parseUntil('listening'), {
        timeoutMs: 20_000,
      })
    ).toMatchObject({ ok: true });
    // a marker less than 2 s after the boot's listening line would join the boot's burst: let that burst close first
    await sleep(RELOAD_GAP_MS + 500);
  }, 60_000);

  it('wait until reloaded answers with the restart line and the listening line after it as one reload', async () => {
    const r = await pokeAndWait();
    expect(r).toMatchObject({ ok: true, until: 'reloaded' });
    expect(r.reloaded?.lines).toBe(2);
    expect(r.reloaded?.line).toContain('Restarting');
  }, 30_000);

  it('ls --reloads counts that reload, and not the boot listening line', async () => {
    expect(await counted()).toEqual(
      expect.objectContaining({ count: 1, partial: false })
    );
  }, 30_000);

  it('a first incidents call with reloads reports it as one reloaded incident', async () => {
    const { answer } = await pollIncidents(f(), ['svc'], {
      includeReloads: true,
    });
    expect(answer.errors).toEqual([]);
    const reloads = answer.incidents.filter((i) => i.kind === 'reloaded');
    expect(reloads).toHaveLength(1);
    expect(reloads[0]).toMatchObject({ app: 'svc', count: 1 });
    expect(reloads[0].line).toContain('Restarting');
  }, 30_000);

  it('a second reload is waited for and counted', async () => {
    const r = await pokeAndWait();
    expect(r).toMatchObject({ ok: true });
    expect(r.reloaded?.lines).toBe(2);
    expect(await counted()).toEqual(
      expect.objectContaining({ count: 2, partial: false })
    );
  }, 30_000);

  it('CLI ls --reloads shows the two reloads next to the restarts', async () => {
    const { stdout } = await run(
      process.execPath,
      [cli, 'ls', '--reloads', '--project', dir],
      { timeout: 30_000 }
    );
    const row = stdout.split('\n').find((l) => /^svc\s/.test(l));
    expect(row, stdout).toBeDefined();
    expect(row).toContain('0 (+2)');
  }, 40_000);
});

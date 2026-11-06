import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepare,
  connect,
  clearResolutionCache,
  type Context,
} from '../../src/core/resolve.js';
import { actOn, Fleet } from '../../src/core/fleet.js';
import { loadManifest } from '../../src/core/manifest.js';
import type { HostMemory } from '../../src/core/memory.js';
import { findProcess, withoutPm2Keys } from '../../src/core/pm2.js';
import { waitFor } from '../../src/core/wait.js';
import { defaultGateDeps, type GateDeps } from '../../src/core/leases/gate.js';
import {
  ensureWatcher,
  watcherApp,
  WATCHER_NAME,
  WATCHER_NS,
} from '../../src/core/leases/ensure.js';
import { LeaseStore, type Lease } from '../../src/core/leases/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
/** The bundle the pm2-managed watcher runs: dist/cli.js, or another build of this tree. */
const cli = process.env.MCPROC_CLI ?? path.join(root, 'dist', 'cli.js');
const PORT_DB = 38531;
const PORT_API = 38532;
const server = (port: number) =>
  `require('http').createServer((q, s) => s.end('ok')).listen(${port}, () => console.log('listening', ${port}));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until `ok` holds, for up to `ms`; false when it never did. */
async function eventually(ok: () => boolean, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await sleep(200))
    if (ok()) return true;
  return ok();
}

let base: string;
let state: string;
let c: string;
let ctx: Context;
let prevState: string | undefined;
let prevEntry: string | undefined;
const fleetOf = () => new Fleet(loadManifest(c), undefined);
const store = () => new LeaseStore(state);
/** The real gate on this file's state directory with a fake memory reading; its watcher is the real one, under pm2. */
const gateOf = (memory: HostMemory): GateDeps => ({
  ...defaultGateDeps(state),
  memory: async () => memory,
  siblings: async () => new Map(),
});
/** The raw `pm2 jlist` of this file's daemon: every field pm2 keeps for a process. */
async function rawList(): Promise<
  { name: string; pm2_env: Record<string, unknown> }[]
> {
  const out = (await ctx.pm2.run(['jlist'], { read: true })).stdout;
  return JSON.parse(out.slice(out.indexOf('[')));
}

beforeAll(async () => {
  if (!fs.existsSync(cli))
    throw new Error(`build first: bun run build (no ${cli})`);
  prevState = process.env.MCPROC_STATE_DIR;
  prevEntry = process.env.MCPROC_CLI_ENTRY;
  base = fs.mkdtempSync('/tmp/mcproc-wt-'); // short on purpose: unix socket paths are capped at 108 bytes
  state = path.join(base, 'state');
  process.env.MCPROC_STATE_DIR = state;
  process.env.MCPROC_CLI_ENTRY = cli;
  const home = path.join(base, 'home');
  c = path.join(base, 'c');
  fs.mkdirSync(path.join(c, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(c, 'db.js'), server(PORT_DB));
  fs.writeFileSync(path.join(c, 'api.js'), server(PORT_API));
  // db declares no env and its host none either: pm2 gets an empty env for it, the case a queued start moved
  fs.writeFileSync(
    path.join(c, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      'project: itw',
      'resources: { reserve: 1M, margin: 0%, settle: 0 }',
      'apps:',
      '  db:',
      '    description: a store on a fixed port',
      '    run: node db.js',
      `    port: ${PORT_DB}`,
      '    memory: 16M',
      '  api:',
      '    description: a server that needs the store',
      '    run: node api.js',
      `    port: ${PORT_API}`,
      '    depends_on:',
      '      - { app: db, condition: ready }',
      'hosts:',
      '  local:',
      `    pm2_home: ${home}`,
      '',
    ].join('\n')
  );
  clearResolutionCache();
  ctx = await connect(prepare({ project: c }));
});
afterAll(async () => {
  try {
    await ctx?.pm2.run(['delete', WATCHER_NAME]);
  } catch {
    /* never launched, or gone already */
  }
  try {
    await ctx?.pm2.run(['kill']);
  } catch {
    /* daemon already gone */
  }
  if (prevState === undefined) delete process.env.MCPROC_STATE_DIR;
  else process.env.MCPROC_STATE_DIR = prevState;
  if (prevEntry === undefined) delete process.env.MCPROC_CLI_ENTRY;
  else process.env.MCPROC_CLI_ENTRY = prevEntry;
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe('the pm2-managed lease watcher', () => {
  it("a queued start comes up in its project's namespace under the pm2-managed watcher", async () => {
    // db exists stopped, started once at once and stopped: pm2 keeps it with its project's namespace
    await actOn(fleetOf(), 'db', 'start', {
      gate: gateOf({ total_mib: 100000, available_mib: 100000 }),
    });
    expect(
      await waitFor(ctx, 'db', { kind: 'listening' }, { timeoutMs: 15_000 })
    ).toMatchObject({ ok: true });
    await actOn(fleetOf(), 'db', 'stop');
    const last = store().list().at(-1)?.seq ?? 0;

    // the start of api (and db under it) does not fit the fake reading: it queues, and the real watcher starts it
    const rows = await actOn(fleetOf(), 'api', 'start', {
      gate: gateOf({ total_mib: 1000, available_mib: 1 }),
    });
    expect(rows.map((r) => r.status)).toContain('queued #1');
    const leaseOf = (): Lease | undefined =>
      store()
        .list()
        .filter((l) => l.seq > last)
        .at(-1);
    // the gate launched the real watcher before it answered: by now the lease may be pending, starting or running
    expect(leaseOf()).toBeDefined();
    await eventually(
      () => !['pending', 'starting'].includes(leaseOf()?.state ?? 'pending'),
      60_000
    );
    expect(leaseOf()).toMatchObject({ state: 'running', error: null });
    const procs = await ctx.pm2.jlist();
    for (const app of ['db', 'api'])
      expect(findProcess(procs, 'itw', app), app).toMatchObject({
        namespace: 'itw',
        status: 'online',
      });
    expect(
      procs.filter((p) => p.namespace === WATCHER_NS).map((p) => p.name)
    ).toEqual([WATCHER_NAME]);
  }, 120_000);

  it("the watcher's child environment loses every scalar key pm2 gives the watcher", async () => {
    await ensureWatcher(ctx, state);
    const w = (await rawList()).find((p) => p.name === WATCHER_NAME);
    expect(w).toBeDefined();
    const pm2Env = w!.pm2_env;
    const own = (pm2Env.env ?? {}) as Record<string, unknown>;
    // what pm2 adds to the process's environment from its own description: every scalar field it keeps that the
    // process was not launched with
    const desc = Object.keys(pm2Env).filter(
      (k) =>
        ['string', 'number', 'boolean'].includes(typeof pm2Env[k]) &&
        !Object.hasOwn(own, k)
    );
    expect(desc.length).toBeGreaterThan(10);
    const left = withoutPm2Keys(
      Object.fromEntries(desc.map((k) => [k, String(pm2Env[k])])),
      Object.keys(watcherApp(state, cli, undefined))
    );
    expect(Object.keys(left)).toEqual([]);
  }, 60_000);
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  bareLocalHost,
  clearResolutionCache,
  connectHost,
  prepare,
} from '../../src/core/resolve.js';
import { actOn, Fleet } from '../../src/core/fleet.js';
import { forgetProject, listProjects } from '../../src/core/registry.js';
import { StacksCollector } from '../../src/core/stacks/collect.js';
import { stopStack } from '../../src/core/stacks/stop.js';

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(process.env.PORT, () => console.log('listening', process.env.PORT));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = 38311;
const B = 38312;

function project(dir: string, name: string, port: number, home?: string) {
  fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), SERVER);
  fs.writeFileSync(
    path.join(dir, '.mcproc', 'mcproc.yaml'),
    [
      'version: 1',
      `project: ${name}`,
      'apps:',
      '  web:',
      '    description: http server',
      '    run: node server.js',
      `    env: { PORT: ${port} }`,
      `    port: ${port}`,
      ...(home ? ['hosts:', '  local:', `    pm2_home: ${home}`] : []),
      '',
    ].join('\n')
  );
}

let base: string;
const saved = {
  home: process.env.PM2_HOME,
  state: process.env.MCPROC_STATE_DIR,
};

beforeAll(async () => {
  base = fs.mkdtempSync('/tmp/mcproc-st-'); // short: unix socket paths are capped at 108 bytes
  process.env.PM2_HOME = path.join(base, 'ha'); // the default daemon of the mcproc under test
  process.env.MCPROC_STATE_DIR = path.join(base, 'state');
  project(path.join(base, 'a'), 'sta', A);
  project(path.join(base, 'b'), 'stb', B, path.join(base, 'hb'));
  fs.writeFileSync(path.join(base, 'idle.js'), 'setInterval(() => {}, 1000)');
  clearResolutionCache();
  for (const dir of ['a', 'b'])
    await actOn(
      new Fleet(prepare({ project: path.join(base, dir) }).manifest, undefined),
      'all',
      'start'
    );
  forgetProject('sta', path.join(base, 'a')); // a is found only through the daemon
  // a plain pm2 process no manifest knows, on the default daemon
  const link = await connectHost(bareLocalHost());
  await link.pm2.run(['start', path.join(base, 'idle.js'), '--name', 'loose']);
  await sleep(1500); // both servers listening
}, 60_000);

afterAll(async () => {
  for (const home of ['ha', 'hb']) {
    process.env.PM2_HOME = path.join(base, home);
    try {
      await (await connectHost(bareLocalHost())).pm2.run(['kill']);
    } catch {
      /* daemon already gone */
    }
  }
  if (saved.home === undefined) delete process.env.PM2_HOME;
  else process.env.PM2_HOME = saved.home;
  if (saved.state === undefined) delete process.env.MCPROC_STATE_DIR;
  else process.env.MCPROC_STATE_DIR = saved.state;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('stacks (real pm2)', () => {
  it('lists the stack found in the daemon and the recorded one, the plain pm2 process as an orphan, and records the found one', async () => {
    const v = await new StacksCollector().collect({ all: false });
    const a = v.answer.stacks.find((s) => s.project === 'sta');
    const b = v.answer.stacks.find((s) => s.project === 'stb');
    expect(a).toMatchObject({ source: 'daemon', root: path.join(base, 'a') });
    expect(a?.apps.online).toBe(1);
    expect(a?.ports).toContainEqual({ app: 'web', port: A });
    expect(a?.cpu).not.toBeNull(); // the first read of an endpoint samples cpu inline
    expect(b?.source).toBe('registry');
    expect(b?.hosts[0].endpoint).toBe(`local (${path.join(base, 'hb')})`);
    expect(b?.ports).toContainEqual({ app: 'web', port: B });
    const loose = v.answer.orphans.find((o) =>
      o.processes.some((p) => p.name === 'loose')
    );
    expect(loose?.endpoint).toBe('local');
    expect(
      listProjects()
        .entries.map((e) => e.project)
        .sort()
    ).toEqual(['sta', 'stb']);
  }, 30_000);

  it('stopping one stack leaves the other running', async () => {
    const m = prepare({ project: path.join(base, 'b') }).manifest;
    expect(await stopStack(m)).toMatchObject({
      stopped: ['web'],
      readonly: [],
      failed: [],
    });
    const v = await new StacksCollector().collect({ all: true });
    expect(v.answer.stacks.find((s) => s.project === 'stb')?.apps.online).toBe(
      0
    );
    expect(v.answer.stacks.find((s) => s.project === 'sta')?.apps.online).toBe(
      1
    );
  }, 30_000);
});

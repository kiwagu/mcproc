import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findManifestPath,
  loadManifest,
  type Host,
} from '../../src/core/manifest.js';
import { parseProbe } from '../../src/core/ports.js';
import { parseJlist } from '../../src/core/pm2.js';
import type { HostProbe } from '../../src/core/list.js';
import type { HostLink } from '../../src/core/resolve.js';
import { listProjects, recordProject } from '../../src/core/registry.js';
import {
  RETRY_MS,
  REMOTE_EVERY_MS,
  REGISTRY_EVERY,
  StacksCollector,
  type CollectorDeps,
} from '../../src/core/stacks/collect.js';
import { probeOut } from '../helpers/probe.js';

function checkout(base: string, name: string, yaml: string): string {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mcproc', 'mcproc.yaml'), yaml);
  return root;
}
const proc = (name: string, ns: string, cwd: string, pid: number) => ({
  pid,
  name,
  pm_id: pid,
  monit: { cpu: 0, memory: 1000 },
  pm2_env: {
    status: 'online',
    namespace: ns,
    pm_cwd: cwd,
    pm_uptime: Date.now(),
  },
});
const probeOf = (
  procs: object[],
  extra: { stat?: string; stat2?: string; at?: number } = {}
): HostProbe => {
  const data = parseProbe(
    probeOut({
      jlist: JSON.stringify(procs),
      mem: 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n',
      stat: extra.stat,
      stat2: extra.stat2,
    })
  );
  return {
    data,
    procs: parseJlist(data.jlistRaw),
    sampledAt: extra.at ?? Date.now(),
  };
};

function deps(
  state: string,
  byHost: (h: Host) => HostProbe | Error,
  clock = { t: 1_000_000 }
): CollectorDeps & { probes: string[]; asks: [string, boolean][] } {
  const probes: string[] = [];
  const asks: [string, boolean][] = [];
  return {
    probes,
    asks,
    stateDir: state,
    now: () => clock.t,
    connectHost: async (host) => ({ host }) as unknown as HostLink,
    probeHost: async (link, ask) => {
      probes.push(link.host.name + (link.host.pm2_home ?? ''));
      asks.push([link.host.name, ask.cpuSample]);
      const r = byHost(link.host);
      if (r instanceof Error) throw r;
      return r;
    },
    loadManifest,
    findManifest: findManifestPath,
    hostname: () => 'box',
    hereCheck: async () => {
      throw new Error('no url check');
    },
  };
}

describe('StacksCollector', () => {
  it('finds a namespace of the local daemon by walking up from its cwd, records it, and lists a recorded one', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const state = path.join(base, 'state');
    const alpha = checkout(
      base,
      'alpha',
      'version: 1\nproject: alpha\napps:\n  web: { description: w, run: "node w.js", cwd: apps/web }\n'
    );
    fs.mkdirSync(path.join(alpha, 'apps', 'web'), { recursive: true });
    const beta = checkout(
      base,
      'beta',
      'version: 1\nproject: beta\napps:\n  api: { description: a, run: "node a.js" }\n'
    );
    recordProject(loadManifest(beta), state);
    const local = probeOf([
      proc('alpha-web', 'alpha', path.join(alpha, 'apps', 'web'), 11),
      proc('beta-api', 'beta', beta, 12),
    ]);
    const c = new StacksCollector(deps(state, () => local));
    const v = await c.collect({ all: false });
    expect(v.answer.stacks.map((s) => [s.project, s.source])).toEqual([
      ['alpha', 'daemon'],
      ['beta', 'registry'],
    ]);
    expect(
      listProjects(state)
        .entries.map((e) => e.project)
        .sort()
    ).toEqual(['alpha', 'beta']);
    expect(v.answer.host).toMatchObject({
      name: 'box',
      memory: { total_mib: 7812, available_mib: 3906 },
      queue: 0,
    });
    expect(v.manifests.get(alpha)?.project).toBe('alpha');
  });

  it('a manifest that names another project leaves the namespace an orphan with a note', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const other = checkout(
      base,
      'other',
      'version: 1\nproject: other\napps:\n  a: { description: a, run: "node a.js" }\n'
    );
    const local = probeOf([proc('x-a', 'x', other, 21)]);
    const v = await new StacksCollector(
      deps(path.join(base, 'state'), () => local)
    ).collect({ all: false });
    expect(v.answer.orphans[0]).toMatchObject({
      namespace: 'x',
      note: `manifest at ${path.join(other, '.mcproc', 'mcproc.yaml')} names other`,
    });
  });

  it('a manifest that does not load leaves the namespace an orphan with a note naming its error', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const bad = checkout(base, 'bad', 'version: 1\nproject: x\napps: {}\n');
    const local = probeOf([proc('x-a', 'x', bad, 22)]);
    const v = await new StacksCollector(
      deps(path.join(base, 'state'), () => local)
    ).collect({ all: false });
    expect(v.answer.orphans[0]).toMatchObject({
      namespace: 'x',
      note: `manifest at ${path.join(bad, '.mcproc', 'mcproc.yaml')}: MANIFEST_INVALID`,
    });
  });

  it('the walk up from an orphan cwd is read once until the registry is read again, its note kept', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const other = checkout(
      base,
      'other',
      'version: 1\nproject: other\napps:\n  a: { description: a, run: "node a.js" }\n'
    );
    const local = probeOf([proc('x-a', 'x', other, 23)]);
    const d = deps(path.join(base, 'state'), () => local);
    let parsed = 0;
    d.loadManifest = (root) => {
      if (root === other) parsed++;
      return loadManifest(root);
    };
    const c = new StacksCollector(d);
    await c.collect({ all: false });
    const v = await c.collect({ all: false });
    expect(parsed).toBe(1);
    expect(v.answer.orphans[0].note).toBe(
      `manifest at ${path.join(other, '.mcproc', 'mcproc.yaml')} names other`
    );
    for (let i = 2; i < REGISTRY_EVERY; i++) await c.collect({ all: false });
    expect(parsed).toBe(1);
    await c.collect({ all: false }); // the registry is read again: the walk with it
    expect(parsed).toBe(2);
  });

  it('probes a remote endpoint at most every 10 s, and every 30 s after a failure, keeping the last data with its age', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const state = path.join(base, 'state');
    const gamma = checkout(
      base,
      'gamma',
      'version: 1\nproject: gamma\nhosts:\n  ws: { docker: { container: c1 }, cwd: /w }\napps:\n  api: { description: a, run: "node a.js", host: ws }\n'
    );
    recordProject(loadManifest(gamma), state);
    const clock = { t: 1_000_000 };
    let fail = false;
    const d = deps(
      state,
      (h) =>
        h.local
          ? probeOf([])
          : fail
            ? new Error('container stopped')
            : probeOf([proc('gamma-api', 'gamma', '/w', 31)]),
      clock
    );
    const c = new StacksCollector(d);
    await c.collect({ all: true });
    expect(d.probes.filter((p) => p === 'ws')).toHaveLength(1);
    clock.t += REMOTE_EVERY_MS - 1;
    await c.collect({ all: true });
    expect(d.probes.filter((p) => p === 'ws')).toHaveLength(1); // not due yet
    clock.t += 1;
    fail = true;
    const v = await c.collect({ all: true });
    expect(d.probes.filter((p) => p === 'ws')).toHaveLength(2);
    const ws = v.answer.stacks[0].hosts.find((h) => h.name === 'ws')!;
    expect(ws).toMatchObject({
      reachable: false,
      error: expect.stringContaining('container stopped'),
      age_s: 10,
    });
    expect(v.answer.stacks[0].apps.online).toBe(1); // the last data, aged
    clock.t += RETRY_MS - 1;
    await c.collect({ all: true });
    expect(d.probes.filter((p) => p === 'ws')).toHaveLength(2);
  });

  it('the cpu of a remote stack is the difference of its last two probes, its aged data included', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const state = path.join(base, 'state');
    const gamma = checkout(
      base,
      'gamma',
      'version: 1\nproject: gamma\nhosts:\n  ws: { docker: { container: c1 }, cwd: /w }\napps:\n  api: { description: a, run: "node a.js", host: ws }\n'
    );
    recordProject(loadManifest(gamma), state);
    const clock = { t: 1_000_000 };
    let ticks = 100;
    const d = deps(
      state,
      (h) =>
        h.local
          ? probeOf([])
          : probeOf([proc('gamma-api', 'gamma', '/w', 31)], {
              stat: `CLK 100\n31 1 ${ticks}`,
              at: clock.t,
            }),
      clock
    );
    const c = new StacksCollector(d);
    await c.collect({ all: true });
    clock.t += REMOTE_EVERY_MS;
    ticks += 500; // 5 s of cpu over 10 s
    expect((await c.collect({ all: true })).answer.stacks[0].cpu).toBe(50);
    clock.t += 2000;
    const v = await c.collect({ all: true }); // not due: the same probe, 2 s old
    expect(v.answer.stacks[0].hosts[0].age_s).toBe(2);
    expect(v.answer.stacks[0].cpu).toBe(50);
  });

  it('the first read of each endpoint takes the inline cpu sample, so a one-shot collect has its cpu; later reads use the last probe', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const state = path.join(base, 'state');
    const gamma = checkout(
      base,
      'gamma',
      'version: 1\nproject: gamma\nhosts:\n  ws: { docker: { container: c1 }, cwd: /w }\napps:\n  api: { description: a, run: "node a.js", host: ws }\n'
    );
    recordProject(loadManifest(gamma), state);
    const clock = { t: 1_000_000 };
    let n = 0;
    const d = deps(
      state,
      (h) => {
        if (h.local) return probeOf([]);
        n++;
        // the first probe: two inline samples 0.5 s apart (25 ticks of 100/s: 50%); then one sample per probe
        return n === 1
          ? probeOf([proc('gamma-api', 'gamma', '/w', 31)], {
              stat: 'CLK 100\n31 1 100',
              stat2: 'CLK 100\n31 1 125',
              at: clock.t,
            })
          : probeOf([proc('gamma-api', 'gamma', '/w', 31)], {
              stat: 'CLK 100\n31 1 225', // 1 s of cpu over 10 s since the last sample: 10%
              at: clock.t,
            });
      },
      clock
    );
    const c = new StacksCollector(d);
    const first = await c.collect({ all: true });
    expect(d.asks.sort()).toEqual([
      ['local', true],
      ['ws', true],
    ]);
    expect(first.answer.stacks[0].cpu).toBe(50);
    d.asks.length = 0;
    clock.t += REMOTE_EVERY_MS;
    const next = await c.collect({ all: true });
    expect(d.asks.sort()).toEqual([
      ['local', false],
      ['ws', false],
    ]);
    expect(next.answer.stacks[0].cpu).toBe(10);
  });

  it('probes the local daemon on every refresh, after a failure too', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    let fail = true;
    const d = deps(path.join(base, 'state'), () =>
      fail ? new Error('pm2 daemon restarting') : probeOf([])
    );
    const c = new StacksCollector(d);
    const v = await c.collect({ all: true });
    expect(v.answer.host.notes).toEqual(['local pm2: pm2 daemon restarting']);
    fail = false;
    const w = await c.collect({ all: true });
    expect(d.probes).toEqual(['local', 'local']);
    expect(w.answer.host.notes).toEqual([]);
  });

  it('a checkout whose endpoints cannot be built is a stack with its error, recorded or found on the daemon; the collect goes on', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const state = path.join(base, 'state');
    const long = `/${'h'.repeat(95)}`;
    const yaml = (project: string) =>
      `version: 1\nproject: ${project}\nhosts:\n  local: { pm2_home: ${long} }\napps:\n  a: { description: a, run: "node a.js" }\n`;
    const demo = checkout(base, 'demo', yaml('demo'));
    recordProject(loadManifest(demo), state);
    const alpha = checkout(base, 'alpha', yaml('alpha'));
    const beta = checkout(
      base,
      'beta',
      'version: 1\nproject: beta\napps:\n  api: { description: a, run: "node a.js" }\n'
    );
    recordProject(loadManifest(beta), state);
    const d = deps(state, () =>
      probeOf([
        proc('alpha-a', 'alpha', alpha, 41),
        proc('beta-api', 'beta', beta, 42),
      ])
    );
    const v = await new StacksCollector(d).collect({ all: true });
    const by = (p: string) => v.answer.stacks.find((s) => s.project === p)!;
    expect(by('demo')).toMatchObject({
      source: 'registry',
      manifest_error: { code: 'PM2_HOME_TOO_LONG' },
    });
    expect(by('alpha')).toMatchObject({
      source: 'daemon',
      manifest_error: { code: 'PM2_HOME_TOO_LONG' },
      apps: { online: 1 },
    });
    expect(by('beta')).toMatchObject({
      manifest_error: null,
      apps: { online: 1 },
    });
    expect(v.answer.orphans).toEqual([]);
    expect(d.probes).toEqual(['local']);
    expect(v.manifests.has(demo)).toBe(false);
  });

  it('a namespace whose checkout is known but runs no app on this daemon stays an orphan, never a second stack', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const state = path.join(base, 'state');
    const gamma = checkout(
      base,
      'gamma',
      'version: 1\nproject: gamma\nhosts:\n  ws: { docker: { container: c1 }, cwd: /w }\napps:\n  api: { description: a, run: "node a.js", host: ws }\n'
    );
    recordProject(loadManifest(gamma), state);
    const d = deps(state, (h) =>
      h.local ? probeOf([proc('gamma-api', 'gamma', gamma, 51)]) : probeOf([])
    );
    const c = new StacksCollector(d);
    await c.collect({ all: true });
    const v = await c.collect({ all: true });
    expect(v.answer.stacks.map((s) => s.project)).toEqual(['gamma']);
    expect(v.answer.orphans.map((o) => o.namespace)).toEqual(['gamma']);
  });

  it('a stack found on the daemon stays daemon-found when the registry is read again', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-col-'));
    const state = path.join(base, 'state');
    const alpha = checkout(
      base,
      'alpha',
      'version: 1\nproject: alpha\napps:\n  web: { description: w, run: "node w.js" }\n'
    );
    const local = probeOf([proc('alpha-web', 'alpha', alpha, 61)]);
    const c = new StacksCollector(deps(state, () => local));
    let v = await c.collect({ all: false });
    for (let i = 0; i < REGISTRY_EVERY; i++)
      v = await c.collect({ all: false });
    expect(v.answer.stacks.map((s) => [s.project, s.source])).toEqual([
      ['alpha', 'daemon'],
    ]);
    const fresh = await new StacksCollector(deps(state, () => local)).collect({
      all: false,
    });
    expect(fresh.answer.stacks.map((s) => s.source)).toEqual(['registry']);
  });
});

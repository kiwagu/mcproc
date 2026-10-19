import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest } from '../../src/core/manifest.js';
import { parseProbe } from '../../src/core/ports.js';
import { parseJlist } from '../../src/core/pm2.js';
import type { HostProbe } from '../../src/core/list.js';
import { bareLocalHost } from '../../src/core/resolve.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import { stateDir } from '../../src/core/state.js';
import {
  buildStacks,
  claimKey,
  endpointKey,
  endpointLabel,
  orderStacks,
} from '../../src/core/stacks/discover.js';
import type {
  EndpointRead,
  ProjectInput,
} from '../../src/core/stacks/types.js';
import { probeOut } from '../helpers/probe.js';

const noHere = async () => {
  throw new Error('no url check expected');
};

function checkout(base: string, name: string, yaml: string): string {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.mcproc'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mcproc', 'mcproc.yaml'), yaml);
  return root;
}
const proc = (
  name: string,
  ns: string,
  cwd: string,
  pid: number,
  status = 'online'
) => ({
  pid,
  name,
  pm_id: pid,
  monit: { cpu: 0, memory: 1000 },
  pm2_env: { status, namespace: ns, pm_cwd: cwd, pm_uptime: Date.now() - 1000 },
});
function probeOf(procs: object[], rss = ''): HostProbe {
  const data = parseProbe(probeOut({ jlist: JSON.stringify(procs), rss }));
  return { data, procs: parseJlist(data.jlistRaw), sampledAt: Date.now() };
}
const LOCAL = endpointKey(bareLocalHost());
const read = (
  probe: HostProbe | null,
  error: string | null = null
): EndpointRead => ({
  key: LOCAL,
  label: 'local',
  probe,
  error,
  age_s: 0,
});
function input(
  root: string,
  source: 'registry' | 'daemon' = 'registry'
): ProjectInput {
  const m = loadManifest(root);
  return {
    project: m.project,
    root,
    source,
    manifest: m,
    error: null,
    endpoints: { local: LOCAL },
    slot: m.slot,
    branch: null,
  };
}

describe('endpoints', () => {
  it('projects without pm2_home share the local endpoint; an own pm2_home, docker or ssh is another', () => {
    const local = bareLocalHost();
    expect(endpointKey(local)).toBe('local|');
    expect(endpointKey({ ...local, pm2_home: '/h/pm2' })).toBe('local|/h/pm2');
    expect(
      endpointKey({
        ...local,
        local: false,
        name: 'ws',
        docker: { container: 'c1' },
      })
    ).toBe('docker c1|');
    expect(endpointLabel({ ...local, pm2_home: '/h/pm2' })).toBe(
      'local (/h/pm2)'
    );
    expect(
      endpointLabel({
        ...local,
        local: false,
        name: 'ws',
        docker: { container: 'c1' },
      })
    ).toBe('ws');
  });
});

describe('buildStacks', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-disc-'));
  const alpha = checkout(
    base,
    'alpha',
    'version: 1\nproject: alpha\napps:\n  web: { description: w, run: "node w.js", port: 4100 }\n  job: { description: j, run: "node j.js" }\n'
  );
  const beta = checkout(
    base,
    'beta',
    'version: 1\nproject: beta\napps:\n  api: { description: a, run: "node a.js" }\n'
  );

  it('a stack per checkout from the namespaces of the endpoint, the watcher left out, the rest orphans', async () => {
    const probe = probeOf([
      proc('alpha-web', 'alpha', alpha, 101),
      proc('alpha-job', 'alpha', alpha, 102, 'stopped'),
      proc('mcproc-watcher', 'mcproc', '/s', 103),
      proc('loose', 'default', '/tmp', 104),
    ]);
    const r = await buildStacks(
      [input(alpha), input(beta)],
      new Map([[LOCAL, read(probe)]]),
      {
        all: false,
        hereCheck: noHere,
      }
    );
    const a = r.stacks.find((s) => s.project === 'alpha')!;
    expect(a.apps).toEqual({
      total: 2,
      online: 1,
      errored: 0,
      stopped: 1,
      queued: 0,
    });
    expect(a.present).toBe(true);
    expect(a.rows.map((x) => x.app)).toEqual(['web', 'job']);
    expect(r.stacks.find((s) => s.project === 'beta')!.present).toBe(false);
    expect(r.orphans).toEqual([
      {
        namespace: 'default',
        endpoint: 'local',
        processes: [{ name: 'loose', status: 'online', memory: 1000 }],
        note: null,
      },
    ]);
  });

  it('an unreachable endpoint marks the hosts of its stacks and yields unreachable rows', async () => {
    const r = await buildStacks(
      [input(alpha)],
      new Map([[LOCAL, read(null, 'pm2 not found')]]),
      {
        all: true,
        hereCheck: noHere,
      }
    );
    expect(r.stacks[0].hosts).toEqual([
      {
        name: 'local',
        endpoint: 'local',
        reachable: false,
        error: 'pm2 not found',
        age_s: 0,
      },
    ]);
    expect(r.stacks[0].rows.every((x) => x.status === 'unreachable')).toBe(
      true
    );
  });

  it('a manifest that does not load stays a stack with its error, counted from its namespace', async () => {
    const broken: ProjectInput = {
      project: 'gamma',
      root: path.join(base, 'gamma'),
      source: 'registry',
      manifest: null,
      error: { code: 'MANIFEST_INVALID', message: 'apps: expected an object' },
      endpoints: { local: LOCAL },
      slot: null,
      branch: null,
    };
    const probe = probeOf([proc('gamma-x', 'gamma', '/g', 201)]);
    const r = await buildStacks([broken], new Map([[LOCAL, read(probe)]]), {
      all: false,
      hereCheck: noHere,
    });
    expect(r.stacks[0].manifest_error?.code).toBe('MANIFEST_INVALID');
    expect(r.stacks[0].apps).toMatchObject({ total: 1, online: 1 });
    expect(r.orphans).toEqual([]);
  });

  it('two checkouts with one slug on one endpoint: each process goes to the root its cwd lies under', async () => {
    const one = checkout(
      base,
      'one',
      'version: 1\nproject: same\napps:\n  web: { description: w, run: "node w.js" }\n'
    );
    const two = checkout(
      base,
      'two',
      'version: 1\nproject: same\napps:\n  web: { description: w, run: "node w.js" }\n'
    );
    const probe = probeOf([proc('same-web', 'same', two, 301)]);
    const r = await buildStacks(
      [input(one), input(two)],
      new Map([[LOCAL, read(probe)]]),
      { all: true, hereCheck: noHere }
    );
    const byRoot = Object.fromEntries(r.stacks.map((s) => [s.root, s]));
    expect(byRoot[two].apps.online).toBe(1);
    expect(byRoot[one].apps.online).toBe(0);
    expect(byRoot[one].notes).toContain('slug shared by 2 checkouts');
  });

  it('a checkout nested in another of the same slug keeps the processes that run under it', async () => {
    const outer = checkout(
      base,
      'nest',
      'version: 1\nproject: nested\napps:\n  web: { description: w, run: "node w.js" }\n'
    );
    const inner = checkout(
      outer,
      'wt',
      'version: 1\nproject: nested\napps:\n  web: { description: w, run: "node w.js" }\n'
    );
    const probe = probeOf([proc('nested-web', 'nested', inner, 501)]);
    const r = await buildStacks(
      [input(outer), input(inner)],
      new Map([[LOCAL, read(probe)]]),
      { all: true, hereCheck: noHere }
    );
    const byRoot = Object.fromEntries(r.stacks.map((s) => [s.root, s]));
    expect(byRoot[inner].apps.online).toBe(1);
    expect(byRoot[outer].apps.online).toBe(0);
  });

  it('checkouts that name one shared daemon by different hosts split its processes by their cwds there', async () => {
    const DOCKER = 'docker c1|';
    const app = (host: string) =>
      `version: 1\nproject: boxed\napps:\n  web: { description: w, run: "node w.js", host: ${host} }\n`;
    const one = checkout(
      base,
      'box-one',
      `${app('ws')}hosts:\n  ws: { docker: { container: c1 }, cwd: /w/one }\n`
    );
    const two = checkout(
      base,
      'box-two',
      `${app('box')}hosts:\n  box: { docker: { container: c1 }, cwd: /w/two }\n`
    );
    const probe = probeOf([proc('boxed-web', 'boxed', '/w/two', 601)]);
    const r = await buildStacks(
      [
        { ...input(one), endpoints: { local: LOCAL, ws: DOCKER } },
        { ...input(two), endpoints: { local: LOCAL, box: DOCKER } },
      ],
      new Map([[DOCKER, { ...read(probe), key: DOCKER, label: 'ws' }]]),
      { all: true, hereCheck: noHere }
    );
    const byRoot = Object.fromEntries(r.stacks.map((s) => [s.root, s]));
    expect(byRoot[two].apps.online).toBe(1);
    expect(byRoot[one].apps.online).toBe(0);
    expect(r.orphans).toEqual([]);
  });

  it.each([
    ['plain', '/srv/app'],
    ['slash', '/srv/app/'],
  ])(
    'two checkouts of one slug in one directory on one endpoint (%s): the process belongs to neither',
    async (tag, cwd2) => {
      const SSH = 'ssh box|';
      const yaml = (cwd: string) =>
        `version: 1\nproject: tied\napps:\n  web: { description: w, run: "node w.js", host: box }\nhosts:\n  box: { ssh: box, cwd: ${cwd} }\n`;
      const one = checkout(base, `tied-one-${tag}`, yaml('/srv/app'));
      const two = checkout(base, `tied-two-${tag}`, yaml(cwd2));
      const probe = probeOf([proc('tied-web', 'tied', '/srv/app', 901)]);
      const r = await buildStacks(
        [
          { ...input(one), endpoints: { local: LOCAL, box: SSH } },
          { ...input(two), endpoints: { local: LOCAL, box: SSH } },
        ],
        new Map([[SSH, { ...read(probe), key: SSH, label: 'box' }]]),
        { all: true, hereCheck: noHere }
      );
      expect(r.stacks).toHaveLength(2);
      for (const s of r.stacks) {
        expect(s.apps.online).toBe(0);
        expect(s.present).toBe(false);
        expect(s.notes).toContain('slug shared by 2 checkouts');
      }
      expect(r.orphans).toEqual([]);
    }
  );

  it('a starting lease has left the queue: queued and the queue position count the pending ones only', async () => {
    const leased = checkout(
      base,
      'leased',
      'version: 1\nproject: leased\napps:\n  a: { description: a, run: "node a.js" }\n  b: { description: b, run: "node b.js" }\n'
    );
    const m = loadManifest(leased);
    // the suite's own state directory (test/setup.ts), which deriveSnapshot reads the leases from
    const store = new LeaseStore(stateDir());
    const lease = (apps: string[]) =>
      store.withLock(() =>
        store.create(
          {
            kind: 'start',
            project: m.project,
            root: m.root,
            slot: null,
            repo: m.repo,
            target: apps[0],
            host: null,
            apps,
            reload: false,
            estimate_mib: 1,
            need_mib: 1,
            margin: 0,
            reserve_mib: 0,
            sources: {},
            note: null,
            requester_pid: process.pid,
          },
          'pending'
        )
      );
    const starting = await lease(['a']);
    await store.withLock(() => store.transition(starting.id, 'starting'));
    const pending = await lease(['b']);
    const r = await buildStacks(
      [input(leased)],
      new Map([[LOCAL, read(probeOf([]))]]),
      { all: false, hereCheck: noHere }
    );
    const s = r.stacks[0];
    expect(s.rows.map((x) => x.lease?.state)).toEqual(['starting', 'pending']);
    expect(s.apps.queued).toBe(1);
    expect(store.positionOf(pending.id)).toBe(2);
    expect(s.queue_position).toBe(2);
    expect(s.present).toBe(true);
  });

  it('a checkout that cannot be read with its manifest fails its own stack only', async () => {
    const bad = checkout(
      base,
      'longhome',
      `version: 1\nproject: longhome\napps:\n  web: { description: w, run: "node w.js" }\nhosts:\n  local: { pm2_home: /${'p'.repeat(100)} }\n`
    );
    const LONG = endpointKey(loadManifest(bad).hosts.local);
    const probe = probeOf([proc('alpha-web', 'alpha', alpha, 701)]);
    const r = await buildStacks(
      [{ ...input(bad), endpoints: { local: LONG } }, input(alpha)],
      new Map([
        [LOCAL, read(probe)],
        [LONG, { ...read(probeOf([])), key: LONG }],
      ]),
      { all: true, hereCheck: noHere }
    );
    const byRoot = Object.fromEntries(r.stacks.map((s) => [s.root, s]));
    expect(byRoot[bad].manifest_error?.code).toBe('PM2_HOME_TOO_LONG');
    expect(byRoot[bad].rows).toEqual([]);
    expect(byRoot[alpha].manifest_error).toBeNull();
    expect(byRoot[alpha].apps.online).toBe(1);
  });

  it('a rival whose endpoints name a host its manifest lacks does not fail the other checkout', async () => {
    const yaml =
      'version: 1\nproject: ghost\napps:\n  web: { description: w, run: "node w.js" }\n';
    const one = checkout(base, 'ghost-one', yaml);
    const two = checkout(base, 'ghost-two', yaml);
    const probe = probeOf([proc('ghost-web', 'ghost', one, 801)]);
    const r = await buildStacks(
      [
        input(one),
        { ...input(two), endpoints: { local: LOCAL, nowhere: LOCAL } },
      ],
      new Map([[LOCAL, read(probe)]]),
      { all: true, hereCheck: noHere }
    );
    const byRoot = Object.fromEntries(r.stacks.map((s) => [s.root, s]));
    expect(byRoot[one].manifest_error).toBeNull();
    expect(byRoot[one].apps.online).toBe(1);
    expect(byRoot[two].apps.online).toBe(0);
  });

  it('orphan notes are carried; the namespace of a claimed project never is an orphan', async () => {
    const probe = probeOf([proc('x-a', 'x', '/elsewhere', 401)]);
    const notes = new Map([[claimKey(LOCAL, 'x'), 'manifest at /m names y']]);
    const r = await buildStacks([], new Map([[LOCAL, read(probe)]]), {
      all: false,
      hereCheck: noHere,
      orphanNotes: notes,
    });
    expect(r.orphans[0].note).toBe('manifest at /m names y');
  });
});

describe('orderStacks', () => {
  const s = (
    project: string,
    online: number,
    base_project = project,
    slot: number | null = null,
    present = true
  ) => ({ project, base_project, slot, present, apps: { online } }) as never;
  it('running first, then by name; worktrees under their base by slot; absent ones only with all', () => {
    const out = orderStacks(
      [
        s('zeta', 0),
        s('alpha-w2', 0, 'alpha', 2),
        s('alpha', 3),
        s('beta', 1),
        s('alpha-w1', 0, 'alpha', 1),
        s('gone', 0, 'gone', null, false),
      ],
      false
    );
    expect(out.map((x: { project: string }) => x.project)).toEqual([
      'alpha',
      'alpha-w1',
      'alpha-w2',
      'beta',
      'zeta',
    ]);
    expect(orderStacks([s('gone', 0, 'gone', null, false)], true)).toHaveLength(
      1
    );
  });
  it('two checkouts of one slug are each listed once, its worktrees under the first', () => {
    const out = orderStacks(
      [s('same', 1), s('same', 0), s('same-w1', 0, 'same', 1)],
      false
    );
    expect(out.map((x: { project: string }) => x.project)).toEqual([
      'same',
      'same-w1',
      'same',
    ]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptPorts,
  EPHEMERAL_FROM,
  lineDiff,
  planAdoption,
  spliceManifest,
  type Adopted,
} from '../../src/core/adopt.js';
import { McprocError } from '../../src/core/errors.js';
import { Fleet } from '../../src/core/fleet.js';
import type { LsRow } from '../../src/core/list.js';
import { loadManifest, parseManifest } from '../../src/core/manifest.js';
import type { Context } from '../../src/core/resolve.js';
import { MARK } from '../../src/shell/snippets.js';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';

const MANIFEST = `version: 1
project: fx
# hand note above apps
apps:
  web:    # source: apps/web; port? 3000
    description: web
    run: npm run dev
    # keep me
    port: 3000
  api:
    description: api
    run: npm run dev
    ports: [3310, 3311]  # two listeners
  tool:
    description: tool
    run: node tool.js
  remote:
    description: on box
    run: node r.js
    host: box
profiles:
  dev: [web, api]
hosts:
  box: { ssh: box, cwd: /x }
`;

/** MANIFEST with every port the fake hosts listen on written in (45000 is ephemeral and stays out). */
const SPLICED = `version: 1
project: fx
# hand note above apps
apps:
  web:    # source: apps/web; port? 3000
    description: web
    run: npm run dev
    # keep me
    ports: [3000, 3001]
  api:
    description: api
    run: npm run dev
    ports: [3310, 3311, 3312]  # two listeners
  tool:
    description: tool
    run: node tool.js
    port: 7000
  remote:
    description: on box
    run: node r.js
    host: box
    ports: [9000, 9001]
profiles:
  dev: [web, api]
hosts:
  box: { ssh: box, cwd: /x }
`;

const ALL: Adopted[] = [
  { app: 'web', host: 'local', ports: [3001] },
  { app: 'api', host: 'local', ports: [3312] },
  { app: 'tool', host: 'local', ports: [7000] },
  { app: 'remote', host: 'box', ports: [9000, 9001] },
];

const parse = (text: string) =>
  parseManifest(text, '/p', '/p/.mcproc/mcproc.yaml');
const portsOf = (m: ReturnType<typeof parse>) =>
  Object.fromEntries(Object.entries(m.apps).map(([n, a]) => [n, a.ports]));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
/** A throwaway project whose manifest the test may edit; removed after the test. */
function project(text = MANIFEST): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-adopt-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.mcproc'));
  const file = path.join(dir, '.mcproc', 'mcproc.yaml');
  fs.writeFileSync(file, text);
  return { dir, file };
}

describe('planAdoption', () => {
  const m = parse(MANIFEST);
  const row = (app: string, undeclared: number[], status = 'online') =>
    ({ app, host: 'local', status, ports: { undeclared } }) as unknown as LsRow;

  it('takes undeclared ports, leaves ephemeral ones and ports another app declares', () => {
    expect(
      planAdoption(
        [
          row('web', [3001]),
          row('api', [3312, 45000]),
          row('tool', [3000]),
          row('remote', [], 'unreachable'),
        ],
        m
      )
    ).toEqual({
      adopted: [
        { app: 'web', host: 'local', ports: [3001] },
        { app: 'api', host: 'local', ports: [3312] },
      ],
      skipped: [
        { app: 'api', host: 'local', ports: [45000], reason: 'ephemeral' },
        {
          app: 'tool',
          host: 'local',
          ports: [3000],
          reason: 'declared by web',
        },
      ],
    });
  });
  it('an app with nothing undeclared, or a stopped or unreachable one, adds nothing', () => {
    expect(
      planAdoption(
        [
          row('web', []),
          row('tool', [], 'stopped'),
          row('remote', [], 'unreachable'),
        ],
        m
      )
    ).toEqual({ adopted: [], skipped: [] });
  });
  it('ephemeral starts at 32768', () => {
    expect(EPHEMERAL_FROM).toBe(32768);
    expect(planAdoption([row('tool', [32767, 32768])], m)).toEqual({
      adopted: [{ app: 'tool', host: 'local', ports: [32767] }],
      skipped: [
        { app: 'tool', host: 'local', ports: [32768], reason: 'ephemeral' },
      ],
    });
  });
});

describe('spliceManifest', () => {
  it('writes the ports in and leaves every other byte as it was', () => {
    const after = spliceManifest(MANIFEST, ALL);
    expect(after).toBe(SPLICED);
    const a = MANIFEST.split('\n');
    const b = after.split('\n');
    expect(b.length).toBe(a.length + 2);
    // the only lines that differ are the port lines of the adopted apps
    const changed = b.filter((l) => !a.includes(l));
    expect(changed).toEqual([
      '    ports: [3000, 3001]',
      '    ports: [3310, 3311, 3312]  # two listeners',
      '    port: 7000',
      '    ports: [9000, 9001]',
    ]);
    expect(a.filter((l) => !b.includes(l))).toEqual([
      '    port: 3000',
      '    ports: [3310, 3311]  # two listeners',
    ]);
    expect(portsOf(parse(after))).toEqual({
      web: [3000, 3001],
      api: [3310, 3311, 3312],
      tool: [7000],
      remote: [9000, 9001],
    });
  });
  it('nothing adopted: the text is returned unchanged', () => {
    expect(spliceManifest(MANIFEST, [])).toBe(MANIFEST);
  });
  it('a manifest without a trailing newline gets a well-formed last line', () => {
    const text = 'version: 1\napps:\n  tool:\n    description: t\n    run: x';
    const after = spliceManifest(text, [
      { app: 'tool', host: 'local', ports: [7000] },
    ]);
    expect(after).toBe(`${text}\n    port: 7000`);
    expect(parse(after).apps.tool.ports).toEqual([7000]);
  });
  it('a block sequence gets new items under its last one, its comments kept', () => {
    const text = `version: 1
apps:
  api:
    description: api
    ports:   # listeners
      - 3310
      - 3311   # second
    run: npm run dev
`;
    const after = spliceManifest(text, [
      { app: 'api', host: 'local', ports: [3312] },
    ]);
    expect(after).toBe(text.replace('# second\n', '# second\n      - 3312\n'));
    expect(parse(after).apps.api.ports).toEqual([3310, 3311, 3312]);
  });
  it('a port whose value sits on the next line keeps that layout', () => {
    const text = `version: 1
apps:
  web:
    description: web
    port:
      3000
    run: x
`;
    const after = spliceManifest(text, [
      { app: 'web', host: 'local', ports: [3001] },
    ]);
    expect(after).toBe(
      text.replace('port:\n      3000', 'ports:\n      [3000, 3001]')
    );
    expect(parse(after).apps.web.ports).toEqual([3000, 3001]);
  });
  it('an app ending in a block (a map, a literal) gets its port line after the block, at its own indent', () => {
    const text = `version: 1
apps:
  tool:
    description: tool
    run: node tool.js
    env:
      A: '1'   # a
  job:
    description: job
    run: |
      echo hi
      node job.js
  other:
    description: o
    run: o
`;
    const after = spliceManifest(text, [
      { app: 'tool', host: 'local', ports: [7000] },
      { app: 'job', host: 'local', ports: [7100, 7101] },
    ]);
    expect(after).toBe(
      text
        .replace('# a\n', '# a\n    port: 7000\n')
        .replace('node job.js\n', 'node job.js\n    ports: [7100, 7101]\n')
    );
    const m = parse(after);
    expect(portsOf(m)).toEqual({
      tool: [7000],
      job: [7100, 7101],
      other: [],
    });
    expect(m.apps.job.run).toBe('echo hi\nnode job.js\n');
  });
  it('an app written as a flow map gets the port inside its braces', () => {
    const text =
      'version: 1\napps:\n  tool: { description: tool, run: node tool.js }\n';
    const after = spliceManifest(text, [
      { app: 'tool', host: 'local', ports: [7000] },
    ]);
    expect(after).toBe(
      'version: 1\napps:\n  tool: { description: tool, run: node tool.js, port: 7000 }\n'
    );
    expect(parse(after).apps.tool.ports).toEqual([7000]);
  });
});

describe('lineDiff', () => {
  it('equal texts: no lines', () => {
    expect(lineDiff(MANIFEST, MANIFEST)).toEqual([]);
  });
  it('a changed line: one line of context on each side', () => {
    expect(lineDiff('a\nb\nold\nc\nd', 'a\nb\nnew\nc\nd')).toEqual([
      ' b',
      '-old',
      '+new',
      ' c',
    ]);
  });
  it('an inserted line', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nb\nnew\nc\nd')).toEqual([
      ' b',
      '+new',
      ' c',
    ]);
  });
  it('the spliced manifest: exactly the port lines change', () => {
    expect(lineDiff(MANIFEST, SPLICED)).toEqual([
      '     # keep me',
      '-    port: 3000',
      '+    ports: [3000, 3001]',
      '   api:',
      '     run: npm run dev',
      '-    ports: [3310, 3311]  # two listeners',
      '+    ports: [3310, 3311, 3312]  # two listeners',
      '   tool:',
      '     run: node tool.js',
      '+    port: 7000',
      '   remote:',
      '     host: box',
      '+    ports: [9000, 9001]',
      ' profiles:',
    ]);
  });
});

/** The fake hosts: which pm2 processes run there and the ports their trees listen on. */
const proc = (app: string, pid: number) => ({
  pid,
  name: `fx-${app}`,
  pm_id: pid - 100,
  pm2_env: {
    status: 'online',
    namespace: 'fx',
    pm_out_log_path: `/l/${app}-out`,
    pm_err_log_path: `/l/${app}-err`,
  },
});
const RUNNING: Record<
  string,
  { procs: ReturnType<typeof proc>[]; listen: [number, number][] }
> = {
  local: {
    procs: [proc('web', 101), proc('api', 102), proc('tool', 103)],
    listen: [
      [3000, 101],
      [3001, 101],
      [3310, 102],
      [3311, 102],
      [3312, 102],
      [45000, 102],
      [7000, 103],
    ],
  },
  box: {
    procs: [proc('remote', 104)],
    listen: [
      [9000, 104],
      [9001, 104],
    ],
  },
};
function probeFor(host: string, idle: boolean): string {
  const h = idle ? { procs: [], listen: [] } : RUNNING[host];
  return probeOut({
    jlist: JSON.stringify(h.procs),
    ps: [
      '    PID    PPID',
      '      1       0',
      ...h.procs.map((p) => `${p.pid} 1`),
    ].join('\n'),
    tcp: h.listen
      .map(
        ([port, pid]) =>
          `LISTEN 0      511          0.0.0.0:${port}      0.0.0.0:*    users:(("node",pid=${pid},fd=20))`
      )
      .join('\n'),
  });
}
/** A fleet over the project's manifest whose hosts answer the probe from RUNNING; `down` hosts refuse the connection. */
function fakeFleet(
  dir: string,
  opts: {
    down?: string[];
    idle?: boolean;
    onConnect?: (host: string) => void;
  } = {}
) {
  const connected: string[] = [];
  const fleet = new Fleet(
    loadManifest(dir),
    undefined,
    async (_m, host, fallback): Promise<Context> => {
      connected.push(host);
      if (opts.down?.includes(host))
        throw new McprocError(
          'TRANSPORT_FAILED',
          `ssh ${host}: Connection refused`
        );
      opts.onConnect?.(host);
      return fakeCtx(
        dir,
        host,
        [
          {
            match: MARK.JLIST,
            result: { stdout: probeFor(host, opts.idle ?? false) },
          },
        ],
        fallback
      );
    }
  );
  return { fleet, connected };
}
/** Push the file's mtime into the past, so a rewrite within the same millisecond still shows. */
function age(file: string): number {
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(file, past, past);
  return fs.statSync(file).mtimeMs;
}

describe('adoptPorts', () => {
  it('writes the undeclared ports of the running apps into the manifest and returns the diff', async () => {
    const { dir, file } = project();
    const r = await adoptPorts(fakeFleet(dir).fleet);
    expect(r).toEqual({
      path: file,
      written: true,
      adopted: ALL,
      skipped: [
        { app: 'api', host: 'local', ports: [45000], reason: 'ephemeral' },
      ],
      errors: [],
      diff: lineDiff(MANIFEST, SPLICED),
    });
    expect(r.diff.length).toBeGreaterThan(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(SPLICED);
    expect(portsOf(loadManifest(dir))).toEqual({
      web: [3000, 3001],
      api: [3310, 3311, 3312],
      tool: [7000],
      remote: [9000, 9001],
    });
  });
  it('a second run finds nothing new and leaves the file alone', async () => {
    const { dir, file } = project();
    await adoptPorts(fakeFleet(dir).fleet);
    const mtime = age(file);
    const r = await adoptPorts(fakeFleet(dir).fleet);
    expect(r).toEqual({
      path: file,
      written: false,
      adopted: [],
      skipped: [
        { app: 'api', host: 'local', ports: [45000], reason: 'ephemeral' },
      ],
      errors: [],
      diff: [],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(SPLICED);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });
  it('nothing running: nothing adopted and the file is not rewritten', async () => {
    const { dir, file } = project();
    const mtime = age(file);
    const r = await adoptPorts(fakeFleet(dir, { idle: true }).fleet);
    expect(r).toMatchObject({
      written: false,
      adopted: [],
      skipped: [],
      errors: [],
      diff: [],
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(MANIFEST);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });
  it('a host that does not answer is an error entry; its apps are left alone and the others adopted', async () => {
    const { dir, file } = project();
    const r = await adoptPorts(fakeFleet(dir, { down: ['box'] }).fleet);
    expect(r.written).toBe(true);
    expect(r.errors).toEqual([
      {
        host: 'box',
        apps: ['remote'],
        message: expect.stringContaining('Connection refused'),
      },
    ]);
    expect(r.adopted).toEqual(ALL.filter((a) => a.app !== 'remote'));
    expect(fs.readFileSync(file, 'utf8')).toBe(
      SPLICED.replace('    ports: [9000, 9001]\n', '')
    );
  });
  it('no host answers: TRANSPORT_FAILED and nothing written', async () => {
    const { dir, file } = project();
    await expect(
      adoptPorts(fakeFleet(dir, { down: ['local', 'box'] }).fleet)
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(fs.readFileSync(file, 'utf8')).toBe(MANIFEST);
  });
  it('a readonly local host is refused before any host is contacted', async () => {
    const text = MANIFEST.replace(
      'hosts:\n',
      'hosts:\n  local: { readonly: true }\n'
    );
    const { dir, file } = project(text);
    const h = fakeFleet(dir);
    await expect(adoptPorts(h.fleet)).rejects.toMatchObject({
      code: 'READONLY_HOST',
    });
    expect(h.connected).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
  it('a manifest that changed while the hosts were probed is not written: ALREADY_EXISTS', async () => {
    const { dir, file } = project();
    const h = fakeFleet(dir, {
      onConnect: (host) => {
        if (host === 'local') fs.appendFileSync(file, '# edited meanwhile\n');
      },
    });
    await expect(adoptPorts(h.fleet)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `${MANIFEST}# edited meanwhile\n`
    );
  });
});

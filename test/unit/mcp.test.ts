import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, INSTRUCTIONS } from '../../src/mcp/server.js';
import { MARK } from '../../src/shell/snippets.js';
import { probeOut } from '../helpers/probe.js';
import type { Spawner } from '../../src/transport/types.js';
import type { UnpackDeps } from '../../src/runtime/unpack.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fleet = path.join(here, '..', 'fixtures', 'projects', 'fleet');
const readiness = path.join(here, '..', 'fixtures', 'projects', 'readiness');

async function client(
  spawner?: Spawner,
  unpackDeps?: UnpackDeps,
  project?: string
) {
  const server = createServer({ spawner, unpack: unpackDeps, project });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: 'test', version: '0.0.0' });
  await cl.connect(c);
  return cl;
}
const neverSpawn: Spawner = async (argv) => {
  throw new Error(`spawner must not be called: ${argv.join(' ')}`);
};
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('mcp server', () => {
  it('registers the 15 tools with annotations and short instructions', async () => {
    const cl = await client();
    const tools = await cl.listTools();
    const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      'delete',
      'describe',
      'doctor',
      'flush',
      'hosts',
      'incidents',
      'init',
      'logs',
      'ls',
      'ports',
      'restart',
      'start',
      'stop',
      'unpack',
      'wait',
    ]);
    expect(byName.incidents.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    }); // taking writes the local pick-up point
    for (const n of [
      'hosts',
      'doctor',
      'ls',
      'describe',
      'logs',
      'ports',
      'wait',
    ])
      expect(byName[n].annotations?.readOnlyHint).toBe(true);
    for (const n of ['stop', 'delete', 'flush', 'init'])
      expect(byName[n].annotations?.destructiveHint).toBe(true); // init with force replaces the owner's manifest
    expect(byName.start.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.unpack.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.unpack.description).toMatch(/npm/); // pm2 is assembled with npm from the shipped lockfile, never inside the package
    expect(byName.unpack.description).not.toMatch(
      /bundled with mcproc|ships inside/
    );
    expect(INSTRUCTIONS.length).toBeLessThan(2000);
    expect(cl.getInstructions()).toBe(INSTRUCTIONS);
  });
  it('a server started for a project (mcp --project) answers about it when a call names none; a call that names one still wins', async () => {
    const cl = await client(neverSpawn, undefined, fleet);
    const h: any = await cl.callTool({ name: 'hosts', arguments: {} });
    expect(h.structuredContent.project).toBe('fleet');
    const b: any = await cl.callTool({
      name: 'hosts',
      arguments: { project: basic },
    });
    expect(b.structuredContent.project).toBe('demo');
  });
  it('returns MANIFEST_NOT_FOUND with the init hint as an isError result', async () => {
    const cl = await client(neverSpawn);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-empty-'));
    const r = await cl.callTool({ name: 'ls', arguments: { project: dir } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('MANIFEST_NOT_FOUND');
    expect(text(r)).toContain('Hint: Run init');
  });
  it('hosts and describe (project) work without touching a transport', async () => {
    const cl = await client(neverSpawn);
    const h: any = await cl.callTool({
      name: 'hosts',
      arguments: { project: basic },
    });
    expect(h.structuredContent.hosts.map((x: any) => x.name)).toEqual([
      'local',
      'stand',
      'prod',
    ]);
    const d: any = await cl.callTool({
      name: 'describe',
      arguments: { project: basic },
    });
    expect(d.structuredContent.project).toBe('demo');
    expect(text(d)).toContain('api-build');
  });
  it('refuses mutations on readonly hosts and unknown targets before any transport call', async () => {
    const cl = await client(neverSpawn);
    const ro = await cl.callTool({
      name: 'stop',
      arguments: { project: basic, host: 'prod', target: 'api' },
    });
    expect(ro.isError).toBe(true);
    expect(text(ro)).toContain('READONLY_HOST');
    const un = await cl.callTool({
      name: 'start',
      arguments: { project: basic, target: 'nope' },
    });
    expect(text(un)).toContain('UNKNOWN_APP');
  });
  it('ls renders rows from a fake host', async () => {
    const jlist = JSON.stringify([
      {
        pid: 4242,
        name: 'demo-api',
        pm_id: 0,
        pm2_env: { status: 'online', namespace: 'demo' },
      },
    ]);
    const spawner: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes(MARK.JLIST))
        return {
          code: 0,
          stdout: probeOut({
            jlist,
            ps: '4242 1\n',
            tcp: 'LISTEN 0 1 *:3310 *:* users:(("node",pid=4242,fd=1))\n',
          }),
          stderr: '',
        };
      if (cmd.includes('bin/pm2'))
        return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const cl = await client(spawner);
    const r: any = await cl.callTool({
      name: 'ls',
      arguments: { project: basic },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.rows).toHaveLength(3);
    expect(text(r)).toMatch(/api\s+server\s+online\s+4242/);
    expect(text(r)).toContain(':3310 ✓');
  });
  it('start answers with the waits it made (none for an app without conditions)', async () => {
    const spawner: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes(MARK.JLIST))
        return { code: 0, stdout: probeOut({ jlist: '[]' }), stderr: '' };
      if (cmd.includes('bin/pm2'))
        return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
      if (/pm2 'jlist'/.test(cmd) || cmd.includes('--version'))
        return { code: 0, stdout: '[]', stderr: '' };
      if (/cat >|startOrRestart/.test(cmd))
        return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected: ${cmd}` };
    };
    const cl = await client(spawner);
    const r: any = await cl.callTool({
      name: 'start',
      arguments: { project: basic, target: 'worker' },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.waits).toEqual([]);
  });
  it('wait: a finished one-shot answers ok with its exit code; a bad until is refused before any transport call', async () => {
    const jlist = JSON.stringify([
      {
        pid: 0,
        name: 'ready-libs',
        pm_id: 0,
        pm2_env: { status: 'stopped', namespace: 'ready', exit_code: 0 },
      },
    ]);
    const spawner: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes('bin/pm2'))
        return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
      if (cmd.includes("'jlist'"))
        return { code: 0, stdout: jlist, stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected: ${cmd}` };
    };
    vi.useFakeTimers({ toFake: ['Date'] }); // the clock stands still: the wait took exactly 0.0 s
    try {
      const cl = await client(spawner);
      const r: any = await cl.callTool({
        name: 'wait',
        arguments: { project: readiness, app: 'libs', until: 'exited' },
      });
      expect(r.isError).toBeUndefined();
      expect(text(r)).toBe('libs: done after 0.0 s (exit 0)');
      expect(r.structuredContent).toMatchObject({
        app: 'libs',
        host: 'local',
        ok: true,
        until: 'exited',
        status: 'done',
        exit_code: 0,
      });
    } finally {
      vi.useRealTimers();
    }
    const cl = await client(neverSpawn);
    const bad = await cl.callTool({
      name: 'wait',
      arguments: { project: readiness, app: 'libs', until: 'nope' },
    });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/^BAD_ARGUMENT/);
    expect(
      text(
        await cl.callTool({
          name: 'wait',
          arguments: { project: readiness, app: 'nope', until: 'exited' },
        })
      )
    ).toContain('UNKNOWN_APP');
  });
  it('wait: not reaching the condition is an answer, not an error; an app that never started is an error', async () => {
    const online = (extra: object) =>
      JSON.stringify([
        {
          pid: 4242,
          name: 'ready-api',
          pm_id: 1,
          pm2_env: { status: 'online', namespace: 'ready', ...extra },
        },
      ]);
    const run = async (jlist: string) => {
      const spawner: Spawner = async (argv) => {
        const cmd = argv[argv.length - 1];
        if (cmd.includes('bin/pm2'))
          return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
        if (cmd.includes(MARK.JLIST))
          return {
            code: 0,
            stdout: probeOut({ jlist, ps: '4242 1\n', tcp: '' }),
            stderr: '',
          };
        if (cmd.includes("'jlist'"))
          return { code: 0, stdout: jlist, stderr: '' };
        return { code: 1, stdout: '', stderr: `unexpected: ${cmd}` };
      };
      return (await client(spawner)).callTool({
        name: 'wait',
        arguments: {
          project: readiness,
          app: 'api',
          until: 'listening',
          timeout_s: 1,
        },
      }) as Promise<any>;
    };
    const late = await run(online({}));
    expect(late.isError).toBeUndefined();
    expect(late.structuredContent).toMatchObject({
      ok: false,
      reason: 'timeout',
      status: 'online',
    });
    expect(text(late)).toMatch(
      /^api: listening not reached after 1\.\d s \(status online, :3100 ✗ nothing listens\)$/
    );
    const never = await run('[]');
    expect(never.isError).toBe(true);
    expect(text(never)).toMatch(/^NOT_STARTED/);
  });
  it('host-bound apps: a target on another host than --host, or on a readonly host, is refused before any transport call', async () => {
    const cl = await client(neverSpawn);
    for (const [name, args] of [
      ['restart', { target: 'web', host: 'local' }],
      ['logs', { app: 'watch', host: 'box' }],
      ['ls', { app: 'web', host: 'local' }],
      ['describe', { app: 'watch', host: 'box' }],
      ['flush', { app: 'web', host: 'local' }],
    ] as const) {
      const r = await cl.callTool({
        name,
        arguments: { project: fleet, ...args },
      });
      expect(text(r), name).toContain('WRONG_HOST');
    }
    for (const name of ['logs', 'describe'])
      expect(
        text(
          await cl.callTool({ name, arguments: { project: fleet, app: 'dev' } })
        ),
        name
      ).toContain('UNKNOWN_APP');
    const ro = await cl.callTool({
      name: 'start',
      arguments: { project: fleet, target: 'all' },
    });
    expect(text(ro)).toContain('READONLY_HOST');
    expect(text(ro)).toContain('"audit"');
    expect(
      text(await cl.callTool({ name: 'flush', arguments: { project: fleet } }))
    ).toContain('READONLY_HOST');
  });
  it('host-bound apps: ls without host lists every app from its own host; a host that is down leaves unreachable rows', async () => {
    const jlists: Record<string, string> = {
      local: JSON.stringify([
        {
          pid: 4242,
          name: 'fleet-watch',
          pm_id: 0,
          pm2_env: { status: 'online', namespace: 'fleet' },
        },
      ]),
      box: JSON.stringify([
        {
          pid: 77,
          name: 'fleet-web',
          pm_id: 3,
          pm2_env: { status: 'online', namespace: 'fleet' },
        },
      ]),
    };
    const spawner: Spawner = async (argv) => {
      const host = argv[0] === 'ssh' ? argv[argv.length - 2] : 'local';
      if (host === 'ro')
        return {
          code: 255,
          stdout: '',
          stderr: 'ssh: connect to host ro port 22: Connection refused',
        };
      const cmd = argv[argv.length - 1];
      if (cmd.includes(MARK.JLIST))
        return {
          code: 0,
          stdout: probeOut({ jlist: jlists[host] }),
          stderr: '',
        };
      if (cmd.includes('bin/pm2'))
        return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected on ${host}` };
    };
    const cl = await client(spawner);
    const r: any = await cl.callTool({
      name: 'ls',
      arguments: { project: fleet },
    });
    expect(r.isError).toBeFalsy();
    expect(
      r.structuredContent.rows.map((x: any) => `${x.app}@${x.host}:${x.status}`)
    ).toEqual([
      'watch@local:online',
      'web@box:online',
      'tool@local:not-started',
      'audit@ro:unreachable',
    ]);
    expect(r.structuredContent.hosts).toEqual(['local', 'box', 'ro']);
    expect(r.structuredContent.errors[0]).toMatchObject({
      host: 'ro',
      apps: ['audit'],
    });
    expect(text(r)).toMatch(/web\s+box\s+server\s+online\s+77/);
    expect(text(r)).toMatch(/^ro: TRANSPORT_FAILED/m);
  });
  it('init creates the draft', async () => {
    const cl = await client(neverSpawn);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-init-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node server.js' } })
    );
    const r: any = await cl.callTool({
      name: 'init',
      arguments: { project: dir },
    });
    expect(r.isError).toBeFalsy();
    expect(
      fs.readFileSync(path.join(dir, '.mcproc', '.gitignore'), 'utf8')
    ).toBe('*\n');
    expect(r.structuredContent.candidates).toBe(1);
  });
  it('unpack refuses readonly hosts first and runs end to end over a fake ssh host', async () => {
    const ro = await (await client(neverSpawn)).callTool({
      name: 'unpack',
      arguments: { project: basic, host: 'prod' },
    });
    expect(text(ro)).toContain('READONLY_HOST');
    const sp: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes('__MCPROC_UNPACK__'))
        return {
          code: 0,
          stdout:
            '__MCPROC_UNPACK__\nLinux x86_64\nNODE v22.11.0\nTAR_OK\nMANIFEST_NONE\n__MCPROC_LOCK__\n',
          stderr: '',
        };
      if (cmd.includes('require(process.argv[1]).version'))
        return { code: 0, stdout: '7.0.4\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const fakeDeps: UnpackDeps = {
      pm2Bundle: async () => ({
        version: '7.0.4',
        sha256: 'x',
        data: Buffer.from('t'),
        path: '/tmp/x.tgz',
      }),
      nodeVersion: async () => 'v24.21.0',
      nodeTarball: async () => ({ data: Buffer.from('n'), sha256: 'y' }),
      hostname: () => 'agent',
      now: () => new Date(0),
    };
    const r: any = await (await client(sp, fakeDeps)).callTool({
      name: 'unpack',
      arguments: { project: basic, host: 'stand' },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      host: 'stand',
      pm2: { version: '7.0.4', written: true },
      manifest_copy: 'written',
    });
    expect(text(r)).toContain("'/srv/demo/.mcproc/runtime/bin/pm2' monit");
  });
  it('incidents: errors with context, taken for every later call; a peek leaves them; the point lives next to the manifest', async () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-inc-'));
    fs.cpSync(basic, proj, { recursive: true });
    const S = (s: number) => `2026-10-12T11:00:0${s}: `;
    const jlist = JSON.stringify([
      {
        pid: 10,
        name: 'demo-api',
        pm_id: 0,
        pm2_env: {
          status: 'online',
          namespace: 'demo',
          restart_time: 0,
          pm_out_log_path: '/l/api-out',
          pm_err_log_path: '/l/api-err',
        },
      },
    ]);
    const log = `${S(1)}ok\n${S(2)}TypeError: boom\n`;
    const spawner: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes('bin/pm2'))
        return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
      if (cmd.includes("'jlist'"))
        return { code: 0, stdout: jlist, stderr: '' };
      if (cmd.includes('__MCPROC_INC_')) {
        const out = [0, 1]
          .map((id) => {
            const off = Number(
              new RegExp(`INC_${id}__[^]*?off=(-?\\d+)`).exec(cmd)![1]
            );
            const body = id === 0 ? log : '';
            const sz = Buffer.byteLength(body);
            const st = off >= 0 && sz >= off ? off : 0;
            return `__MCPROC_INC_${id}__\n${sz} ${st} 0\n${body.slice(st)}`;
          })
          .join('');
        return { code: 0, stdout: out, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const cl = await client(spawner);
    const peek: any = await cl.callTool({
      name: 'incidents',
      arguments: { project: proj, app: 'api', peek: true },
    });
    expect(text(peek)).toContain('▶ 2026-10-12T11:00:02: TypeError: boom');
    expect(peek.structuredContent).toMatchObject({ taken: false });
    const first: any = await cl.callTool({
      name: 'incidents',
      arguments: { project: proj, app: 'api' },
    });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      taken: true,
      incidents: [{ app: 'api', kind: 'error' }],
    });
    expect(fs.existsSync(path.join(proj, '.mcproc', 'incidents.json'))).toBe(
      true
    );
    const second: any = await cl.callTool({
      name: 'incidents',
      arguments: { project: proj, app: 'api' },
    });
    expect(text(second)).toMatch(/^no new incidents since/);
  });
});

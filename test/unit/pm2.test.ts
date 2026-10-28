import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJlist,
  findProcess,
  Pm2Client,
  resolvePm2Bin,
  bundledPm2Bin,
  type DaemonLister,
} from '../../src/core/pm2.js';
import { FakeTransport, type Rule } from '../helpers/fake-transport.js';
import type { Host } from '../../src/core/manifest.js';
import { createTransport } from '../../src/transport/index.js';
import { ENV_LOGIN, ENV_PLAIN } from '../../src/transport/loginenv.js';
import type { Spawner } from '../../src/transport/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p: string) =>
  fs.readFileSync(path.join(here, '..', 'fixtures', p), 'utf8');
const local: Host = {
  name: 'local',
  local: true,
  ssh_args: [],
  cwd: '/p',
  readonly: false,
  shell: { bin: '/bin/bash', flags: ['-lc'] },
  env: {},
};
const remote: Host = {
  ...local,
  name: 'stand',
  local: false,
  ssh: 'stand',
  cwd: '/srv/p',
};

describe('parseJlist', () => {
  it('skips the coloured preamble and update notice', () => {
    const procs = parseJlist(fx('jlist/with-preamble.txt'));
    expect(procs).toHaveLength(1);
    expect(procs[0]).toMatchObject({
      pm_id: 0,
      name: 'api',
      namespace: 'demo',
      pid: 69265,
      status: 'online',
      restarts: 2,
      out_log: '/h/logs/api-out.log',
      watch: true,
      memory: 51200000,
    });
    expect(procs[0].uptime_ms).toBeGreaterThan(0);
  });
  it('carries exit_code: a number after a natural exit, null when pm2 recorded none', () => {
    const procs = parseJlist(
      JSON.stringify([
        {
          pid: 0,
          name: 'p-t',
          pm_id: 1,
          pm2_env: { status: 'stopped', namespace: 'p', exit_code: 2 },
        },
        {
          pid: 0,
          name: 'p-s',
          pm_id: 2,
          pm2_env: { status: 'stopped', namespace: 'p', exit_code: null },
        },
        {
          pid: 9,
          name: 'p-o',
          pm_id: 3,
          pm2_env: { status: 'online', namespace: 'p' },
        },
      ])
    );
    expect(procs.map((p) => p.exit_code)).toEqual([2, null, null]);
  });
  it("carries started_at: pm2's last start (pm_uptime, epoch ms) whatever the status, null when absent", () => {
    const procs = parseJlist(
      JSON.stringify([
        {
          pid: 9,
          name: 'p-o',
          pm_id: 1,
          pm2_env: {
            status: 'online',
            namespace: 'p',
            pm_uptime: 1_760_000_000_000,
          },
        },
        {
          pid: 0,
          name: 'p-s',
          pm_id: 2,
          pm2_env: {
            status: 'stopped',
            namespace: 'p',
            pm_uptime: 1_760_000_500_000,
          },
        },
        {
          pid: 0,
          name: 'p-n',
          pm_id: 3,
          pm2_env: { status: 'stopped', namespace: 'p' },
        },
      ])
    );
    expect(procs.map((p) => p.started_at)).toEqual([
      1_760_000_000_000,
      1_760_000_500_000,
      null,
    ]);
  });
  it('parses an empty list and defaults namespace/pid', () => {
    expect(parseJlist('[]')).toEqual([]);
    const [w] = parseJlist(fx('jlist/two-namespaces.json')).filter(
      (p) => p.name === 'demo-worker'
    );
    expect(w).toMatchObject({
      pid: 0,
      status: 'stopped',
      uptime_ms: null,
      unstable_restarts: 1,
    });
  });
  it('throws PM2_FAILED when no JSON array is present', () => {
    expect(() => parseJlist('[PM2] something went wrong\n')).toThrowError(
      /no JSON array/
    );
  });
});

describe('findProcess', () => {
  it('selects the project-prefixed pm2 name inside the project namespace', () => {
    const procs = parseJlist(fx('jlist/two-namespaces.json'));
    expect(findProcess(procs, 'demo', 'web')?.pid).toBe(100);
    expect(findProcess(procs, 'other', 'web')?.pid).toBe(200);
    expect(findProcess(procs, 'third', 'web')).toBeUndefined();
  });
  it('ignores a short-named process and a prefixed name in another namespace', () => {
    const procs = parseJlist(
      JSON.stringify([
        { pid: 1, name: 'web', pm_id: 0, pm2_env: { namespace: 'demo' } },
        { pid: 2, name: 'demo-web', pm_id: 1, pm2_env: { namespace: 'other' } },
      ])
    );
    expect(findProcess(procs, 'demo', 'web')).toBeUndefined();
  });
});

describe('Pm2Client', () => {
  it('runs pm2 through the transport with PM2_HOME and quoted args', async () => {
    const t = new FakeTransport([
      { match: /jlist/, result: { stdout: '[]' } },
      { match: /startOrRestart/, result: {} },
    ]);
    const c = new Pm2Client(t, local, 'pm2', '/tmp/h');
    expect(await c.jlist()).toEqual([]);
    await c.startOrRestart('/p/.mcproc/.generated/ecosystem.json', 'api');
    expect(t.calls[0]).toMatchObject({
      cmd: `pm2 'jlist'`,
      opts: { env: { PM2_HOME: '/tmp/h' } },
    });
    expect(t.calls[1].cmd).toBe(
      `pm2 'startOrRestart' '/p/.mcproc/.generated/ecosystem.json' '--only' 'api' '--update-env'`
    );
    expect(t.calls[1].opts.timeoutMs).toBe(90_000);
  });
  it('maps exit 127 to PM2_NOT_FOUND and other failures to PM2_FAILED', async () => {
    const t = new FakeTransport([
      {
        match: /jlist/,
        result: { code: 127, stderr: 'bash: pm2: command not found' },
      },
      {
        match: /stop/,
        result: { code: 1, stderr: '[PM2][ERROR] Process 9 not found' },
      },
    ]);
    const c = new Pm2Client(t, local, 'pm2');
    await expect(c.jlist()).rejects.toMatchObject({ code: 'PM2_NOT_FOUND' });
    await expect(c.stop(9)).rejects.toMatchObject({
      code: 'PM2_FAILED',
      message: expect.stringContaining('Process 9 not found'),
    });
  });
  it('exit 127 from a missing shell is a transport failure, not a missing pm2', async () => {
    const t = new FakeTransport([
      {
        match: /jlist/,
        result: { code: 127, stderr: 'sh: 1: /bin/bash: not found' },
      },
    ]);
    await expect(new Pm2Client(t, remote, 'pm2').jlist()).rejects.toMatchObject(
      { code: 'TRANSPORT_FAILED' }
    );
  });
});

describe('resolvePm2Bin', () => {
  it('explicit hosts.<h>.pm2 wins without probing', async () => {
    const t = new FakeTransport([]);
    const r = await resolvePm2Bin({ ...local, pm2: '/opt/pm2/bin/pm2' }, t);
    expect(r).toMatchObject({ bin: '/opt/pm2/bin/pm2', source: 'explicit' });
    expect(t.calls).toHaveLength(0);
  });
  it('prefers the runtime bundle, then a usable PATH pm2', async () => {
    const rt = new FakeTransport([
      {
        match: /bin\/pm2/,
        result: { stdout: 'RUNTIME\nPATH_OK\n6.0.8\nv18.20.0\n' },
      },
    ]);
    expect((await resolvePm2Bin(remote, rt)).source).toBe('runtime');
    expect((await resolvePm2Bin(remote, rt)).bin).toBe(
      `'/srv/p/.mcproc/runtime/bin/pm2'`
    );
    const pathOk = new FakeTransport([
      { match: /bin\/pm2/, result: { stdout: 'PATH_OK\n7.0.1\nv22.11.0\n' } },
    ]);
    expect(await resolvePm2Bin(remote, pathOk)).toMatchObject({
      bin: 'pm2',
      source: 'path',
      pm2Version: '7.0.1',
      node: 'v22.11.0',
    });
  });
  it("with the runtime bundle there, a pm2 on PATH is never run; without it, PATH pm2 runs with the host's PM2_HOME", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-res-'));
    const bin = path.join(tmp, 'path-bin');
    const marker = path.join(tmp, 'ran');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'pm2'),
      `#!/bin/sh\nprintf '%s' "$PM2_HOME" > '${marker}'\necho 7.0.4\n`,
      { mode: 0o755 }
    );
    // the probe runs in a real sh, with the fake pm2 first on PATH and the env the resolution passes
    const sh = new FakeTransport([
      {
        match: /bin\/pm2/,
        result: (cmd, opts) => ({
          stdout: execFileSync('sh', ['-c', cmd], {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              ...(opts.env ?? {}),
            },
            encoding: 'utf8',
          }),
        }),
      },
    ]);
    const host: Host = {
      ...remote,
      cwd: tmp,
      pm2_home: path.join(tmp, 'pm2home'),
    };
    fs.mkdirSync(path.join(tmp, '.mcproc', 'runtime', 'bin'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmp, '.mcproc', 'runtime', 'bin', 'pm2'),
      '#!/bin/sh\n',
      { mode: 0o755 }
    );
    expect((await resolvePm2Bin(host, sh)).source).toBe('runtime');
    expect(fs.existsSync(marker)).toBe(false);
    fs.rmSync(path.join(tmp, '.mcproc'), { recursive: true });
    expect((await resolvePm2Bin(host, sh)).source).toBe('path');
    expect(fs.readFileSync(marker, 'utf8')).toBe(path.join(tmp, 'pm2home'));
  });
  it('reports TRANSPORT_FAILED when the probe shell itself did not run', async () => {
    const noShell = new FakeTransport([
      {
        match: /bin\/pm2/,
        result: {
          code: 127,
          stdout: '',
          stderr: 'sh: 1: /bin/bash: not found',
        },
      },
    ]);
    await expect(resolvePm2Bin(remote, noShell)).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
      message: expect.stringContaining('/bin/bash: not found'),
    });
    await expect(resolvePm2Bin(local, noShell)).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
  });
  it('rejects a broken shim or old node on a remote host, falls back to bundled locally', async () => {
    const shim = new FakeTransport([
      { match: /bin\/pm2/, result: { stdout: 'PATH_OK\n\nv26.8.1\n' } },
    ]);
    await expect(resolvePm2Bin(remote, shim)).rejects.toMatchObject({
      code: 'PM2_NOT_FOUND',
    });
    const old = new FakeTransport([
      { match: /bin\/pm2/, result: { stdout: 'PATH_OK\n5.4.0\nv16.20.0\n' } },
    ]);
    await expect(resolvePm2Bin(remote, old)).rejects.toMatchObject({
      code: 'PM2_NOT_FOUND',
    });
    const none = new FakeTransport([
      { match: /bin\/pm2/, result: { stdout: 'PATH_NONE\nNODE_NONE\n' } },
    ]);
    const r = await resolvePm2Bin(local, none);
    expect(r.source).toBe('bundled');
    expect(r.bin).toBe(bundledPm2Bin());
    expect(bundledPm2Bin()).toMatch(/node_modules\/pm2\/bin\/pm2'$/);
  });
});

const here_: Host = {
  name: 'local',
  local: true,
  ssh_args: [],
  cwd: '/p',
  readonly: false,
  shell: { bin: '/bin/bash', flags: ['-lc'] },
  env: {},
};
// stopped: no uptime, so two normalizations of it are equal whenever they run
const RAW = {
  pid: 0,
  name: 'p-web',
  pm_id: 0,
  pm2_env: { status: 'stopped', namespace: 'p', pm_uptime: 1000 },
};
/** A fake transport whose login environment is given. */
class EnvTransport extends FakeTransport {
  constructor(
    rules: Rule[],
    private readonly env: Record<string, string> | null
  ) {
    super(rules);
  }
  override async loginEnv() {
    return this.env;
  }
}

describe('Pm2Client over the socket', () => {
  it('lists the daemon over the socket, normalized as jlist is, with no command', async () => {
    const t = new FakeTransport([]);
    const c = new Pm2Client(t, here_, 'pm2', '/h/.pm2', async () => [RAW]);
    expect(c.listsOverSocket()).toBe(true);
    expect(await c.daemonList()).toEqual(parseJlist(JSON.stringify([RAW])));
    expect(t.calls).toEqual([]);
  });
  it('no daemon: null, and nothing runs', async () => {
    const t = new FakeTransport([]);
    const c = new Pm2Client(t, here_, 'pm2', '/h/.pm2', async () => null);
    expect(await c.daemonList()).toBeNull();
    expect(await c.jlist()).toEqual([]);
    expect(t.calls).toEqual([]);
  });
  it('a socket that fails: the CLI answers, as a read', async () => {
    const t = new FakeTransport([
      { match: /pm2 'jlist'/, result: { stdout: JSON.stringify([RAW]) } },
    ]);
    const c = new Pm2Client(t, here_, 'pm2', '/h/.pm2', async () => {
      throw new Error('hung');
    });
    expect((await c.jlist()).map((p) => p.name)).toEqual(['p-web']);
    expect(t.calls.map((x) => x.read)).toEqual([true]);
  });
  it('no lister: the CLI', async () => {
    const t = new FakeTransport([
      { match: /pm2 'jlist'/, result: { stdout: '[]' } },
    ]);
    const c = new Pm2Client(t, here_, 'pm2');
    expect(c.listsOverSocket()).toBe(false);
    await c.jlist();
    expect(t.calls).toHaveLength(1);
  });
  it('the socket home follows the login PM2_HOME; pm2_home wins', async () => {
    const homes: string[] = [];
    const lister: DaemonLister = async (h) => {
      homes.push(h);
      return [];
    };
    await new Pm2Client(
      new EnvTransport([], { PM2_HOME: '/x/.pm2', HOME: '/h' }),
      here_,
      'pm2',
      undefined,
      lister
    ).jlist();
    await new Pm2Client(
      new EnvTransport([], { HOME: '/h' }),
      here_,
      'pm2',
      undefined,
      lister
    ).jlist();
    await new Pm2Client(
      new EnvTransport([], { PM2_HOME: '/x/.pm2' }),
      here_,
      'pm2',
      '/own',
      lister
    ).jlist();
    expect(homes).toEqual(['/x/.pm2', '/h/.pm2', '/own']);
  });
  it("no login environment: this process's PM2_HOME, else ~/.pm2", async () => {
    const saved = process.env.PM2_HOME;
    const c = new Pm2Client(
      new EnvTransport([], null),
      here_,
      'pm2',
      undefined,
      async () => []
    );
    try {
      process.env.PM2_HOME = '/proc-home';
      expect(await c.home()).toBe('/proc-home');
      delete process.env.PM2_HOME;
      expect(await c.home()).toBe(
        path.join(process.env.HOME || os.homedir(), '.pm2')
      );
    } finally {
      if (saved === undefined) delete process.env.PM2_HOME;
      else process.env.PM2_HOME = saved;
    }
  });
});

describe('Pm2Client: a daemon on TCP ports', () => {
  it('PM2_RPC_PORT in the login environment: the CLI lists, the socket lister is never asked', async () => {
    let asked = 0;
    const t = new EnvTransport(
      [{ match: /pm2 'jlist'/, result: { stdout: JSON.stringify([RAW]) } }],
      { PM2_HOME: '/x/.pm2', PM2_RPC_PORT: '6666', PM2_PUB_PORT: '6667' }
    );
    const c = new Pm2Client(t, here_, 'pm2', undefined, async () => {
      asked++;
      return null;
    });
    expect((await c.jlist()).map((p) => p.name)).toEqual(['p-web']);
    expect(asked).toBe(0);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ cmd: `pm2 'jlist'`, read: true });
  });
  it("no login environment: this process's PM2_RPC_PORT decides", async () => {
    const saved = process.env.PM2_RPC_PORT;
    let asked = 0;
    const t = new EnvTransport(
      [{ match: /pm2 'jlist'/, result: { stdout: '[]' } }],
      null
    );
    const c = new Pm2Client(t, here_, 'pm2', '/own', async () => {
      asked++;
      return [];
    });
    try {
      process.env.PM2_RPC_PORT = '6666';
      await c.jlist();
      expect(asked).toBe(0);
      expect(t.calls).toHaveLength(1);
      delete process.env.PM2_RPC_PORT;
      await c.jlist();
      expect(asked).toBe(1);
      expect(t.calls).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env.PM2_RPC_PORT;
      else process.env.PM2_RPC_PORT = saved;
    }
  });
});

/** captureScript's output in the NUL form, for a transport with an injected spawner. */
const capturedEnv = (
  plain: Record<string, string>,
  login: Record<string, string>
) => {
  const dump = (e: Record<string, string>) =>
    `__MCPROC_ENV0__\n${Object.entries(e)
      .map(([k, v]) => `${k}=${v}\0`)
      .join('')}`;
  return `${ENV_PLAIN}\n${dump(plain)}\n${ENV_LOGIN}\n${dump(login)}`;
};

describe('resolvePm2Bin: a pm2 only the host shell finds', () => {
  /** plain sh finds no pm2; the host's own shell does (a profile function, a wrapper it defines) */
  function shellOnlyPm2() {
    const probes = { plain: 0, host: 0 };
    const spawner: Spawner = async (argv) => {
      const cmd = argv.at(-1) as string;
      if (cmd.includes(ENV_PLAIN))
        return {
          code: 0,
          stdout: capturedEnv({ PATH: '/bin' }, { PATH: '/bin', HOME: '/h' }),
          stderr: '',
        };
      const viaHost =
        argv[0] === '/bin/bash' || cmd.startsWith(`'/bin/bash' '-lc'`);
      probes[viaHost ? 'host' : 'plain']++;
      return {
        code: 0,
        stdout: viaHost
          ? 'PATH_OK\n7.0.4\n\nv22.11.0\n'
          : 'PATH_NONE\nv22.11.0\n',
        stderr: '',
      };
    };
    return { spawner, probes };
  }
  it('another host: PATH_NONE in plain sh reads the environment again, then asks the host shell', async () => {
    const w = shellOnlyPm2();
    const r = await resolvePm2Bin(remote, createTransport(remote, w.spawner));
    expect(r).toMatchObject({
      bin: 'pm2',
      source: 'path',
      pm2Version: '7.0.4',
    });
    expect(w.probes).toEqual({ plain: 2, host: 1 });
  });
  it('this machine: PATH_NONE is final, the bundled pm2 answers', async () => {
    const w = shellOnlyPm2();
    const r = await resolvePm2Bin(local, createTransport(local, w.spawner));
    expect(r.source).toBe('bundled');
    expect(w.probes).toEqual({ plain: 1, host: 0 });
  });
});

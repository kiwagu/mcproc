import { describe, it, expect } from 'vitest';
import {
  createTransport,
  clearLoginEnvCache,
} from '../../src/transport/index.js';
import { ENV_PLAIN, ENV_LOGIN } from '../../src/transport/loginenv.js';
import { McprocError } from '../../src/core/errors.js';
import { shjoin } from '../../src/transport/quote.js';
import type { Host } from '../../src/core/manifest.js';
import type { ExecResult, Spawner } from '../../src/transport/types.js';

const local: Host = {
  name: 'local',
  local: true,
  ssh_args: [],
  cwd: '/p',
  readonly: false,
  shell: { bin: '/bin/bash', flags: ['-lc'] },
  env: {},
};
const ssh: Host = {
  ...local,
  name: 'stand',
  local: false,
  ssh: 'stand',
  cwd: '/srv/p',
};
const docker: Host = {
  ...local,
  name: 'box',
  local: false,
  docker: { container: 'app-1' },
  cwd: '/srv/p',
};

/** captureScript's output in the NUL form. */
const captured = (
  plain: Record<string, string>,
  login: Record<string, string>
) => {
  const dump = (e: Record<string, string>) =>
    `__MCPROC_ENV0__\n${Object.entries(e)
      .map(([k, v]) => `${k}=${v}\0`)
      .join('')}`;
  return `${ENV_PLAIN}\n${dump(plain)}\n${ENV_LOGIN}\n${dump(login)}`;
};
const PLAIN = { PATH: '/bin', HOME: '/h' };
const LOGIN = {
  PATH: '/opt/n/bin:/bin',
  HOME: '/h',
  FROM_PROFILE: 'yes',
  SHLVL: '2',
};

/** A spawner that answers the capture and records every other call; `answer` decides those. */
function world(answer: (argv: string[]) => Partial<ExecResult> = () => ({})) {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  let captures = 0;
  let captureOut = captured(PLAIN, LOGIN);
  let captureCode = 0;
  let onCapture: () => void = () => {};
  const spawner: Spawner = async (argv, opts) => {
    const cmd = argv[argv.length - 1];
    if (cmd.includes(ENV_PLAIN)) {
      captures++;
      onCapture();
      return { code: captureCode, stdout: captureOut, stderr: '' };
    }
    calls.push({ argv, env: opts.env });
    return { code: 0, stdout: '', stderr: '', ...answer(argv) };
  };
  let t = 1_000_000;
  return {
    spawner,
    calls,
    captures: () => captures,
    setCapture: (s: string, code = 0) => {
      captureOut = s;
      captureCode = code;
    },
    /** runs on every capture before it answers: it may move the clock or throw */
    onCapture: (f: () => void) => {
      onCapture = f;
    },
    clock: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('Transport.read', () => {
  it('this machine: plain sh, the login environment as the child environment, read once', async () => {
    const w = world();
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('echo hi');
    await t.read('echo again');
    expect(w.captures()).toBe(1);
    expect(w.calls[0].argv).toEqual(['sh', '-c', 'echo hi']);
    expect(w.calls[0].env).toEqual({
      PATH: '/opt/n/bin:/bin',
      HOME: '/h',
      FROM_PROFILE: 'yes',
    });
    expect(t.readMode()).toEqual({
      shell: 'plain',
      at: 1_000_000,
      reason: null,
    });
  });
  it('another host: the exports of what the profile changed, then opts.env, in plain sh', async () => {
    const w = world();
    const t = createTransport(ssh, w.spawner, undefined, w.clock);
    await t.read('pm2 jlist', { env: { PM2_HOME: '/srv/.pm2' } });
    const argv = w.calls[0].argv;
    expect(argv.slice(0, 2)).toEqual(['ssh', '-o']);
    expect(argv.at(-1)).toBe(
      shjoin([
        'sh',
        '-c',
        "export FROM_PROFILE='yes'; export PATH='/opt/n/bin:/bin'; export PM2_HOME='/srv/.pm2'; pm2 jlist",
      ])
    );
    expect(w.calls[0].env).toBeUndefined();
  });
  it('exec keeps the host shell', async () => {
    const w = world();
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.exec('pm2 stop 1');
    expect(w.calls[0].argv).toEqual(['/bin/bash', '-lc', 'pm2 stop 1']);
    expect(w.captures()).toBe(0);
  });
  it('the environment is read again after 5 minutes, not before', async () => {
    const w = world();
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('a');
    w.advance(299_999);
    await t.read('b');
    expect(w.captures()).toBe(1);
    w.advance(1);
    await t.read('c');
    expect(w.captures()).toBe(2);
  });
  it('reads at the same time share one capture', async () => {
    const w = world();
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await Promise.all([t.read('a'), t.read('b'), t.read('c')]);
    expect(w.captures()).toBe(1);
  });
  it('command not found: reads the environment again and retries once', async () => {
    let n = 0;
    const w = world(() =>
      n++ === 0 ? { code: 127 } : { code: 0, stdout: 'ok' }
    );
    const t = createTransport(local, w.spawner, undefined, w.clock);
    expect((await t.read('x')).stdout).toBe('ok');
    expect(w.captures()).toBe(2);
    expect(w.calls.map((c) => c.argv[0])).toEqual(['sh', 'sh']);
  });
  it('still failing: the host shell, and no second re-read within 5 minutes', async () => {
    const w = world((argv) =>
      argv[0] === 'sh' ? { code: 127 } : { code: 0, stdout: 'via login' }
    );
    const t = createTransport(local, w.spawner, undefined, w.clock);
    expect((await t.read('x')).stdout).toBe('via login');
    expect(t.readMode()).toMatchObject({ shell: 'host' });
    const before = w.captures();
    expect((await t.read('y')).stdout).toBe('via login');
    expect(w.captures()).toBe(before);
    expect(w.calls.at(-1)!.argv).toEqual(['/bin/bash', '-lc', 'y']);
  });
  it('a custom retryIf decides what failing means', async () => {
    let n = 0;
    const w = world(() => ({ stdout: n++ === 0 ? 'garbage' : 'MARK ok' }));
    const t = createTransport(local, w.spawner, undefined, w.clock);
    const r = await t.read('probe', {
      retryIf: (res) => !res.stdout.includes('MARK'),
    });
    expect(r.stdout).toBe('MARK ok');
  });
  it('a dropped ssh connection comes back as it is: no second capture, no host shell, reads stay plain', async () => {
    const refused = {
      code: 255,
      stdout: '',
      stderr: 'ssh: connect to host stand port 22: Connection refused',
    };
    let down = true;
    const w = world(() => (down ? refused : { stdout: 'MARK ok' }));
    const t = createTransport(ssh, w.spawner, undefined, w.clock);
    const probe = {
      retryIf: (res: ExecResult) => !res.stdout.includes('MARK'),
    };
    expect(await t.read('probe', probe)).toEqual(refused);
    expect(w.captures()).toBe(1);
    expect(w.calls).toHaveLength(1);
    expect(t.readMode()).toMatchObject({ shell: 'plain', reason: null });
    // the host is back: its next read is plain sh again, on the environment already read
    down = false;
    w.advance(30_000);
    expect((await t.read('probe', probe)).stdout).toBe('MARK ok');
    expect(w.captures()).toBe(1);
    expect(w.calls[1].argv.at(-1)).toBe(
      shjoin([
        'sh',
        '-c',
        "export FROM_PROFILE='yes'; export PATH='/opt/n/bin:/bin'; probe",
      ])
    );
    expect(t.readMode()).toMatchObject({ shell: 'plain', reason: null });
  });
  it('a docker container that is not running comes back as it is too', async () => {
    const stopped = {
      code: 1,
      stdout: '',
      stderr: 'Error response from daemon: container app-1 is not running',
    };
    const w = world(() => stopped);
    const t = createTransport(docker, w.spawner, undefined, w.clock);
    const r = await t.read('probe', {
      retryIf: (res) => !res.stdout.includes('MARK'),
    });
    expect(r).toEqual(stopped);
    expect(w.captures()).toBe(1);
    expect(w.calls).toHaveLength(1);
    expect(t.readMode()).toMatchObject({ shell: 'plain', reason: null });
  });
  it('a capture that fails leaves reads on the host shell, and is tried again after 30 s', async () => {
    const w = world();
    w.setCapture('bash: no such file\n');
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('a');
    expect(w.calls[0].argv).toEqual(['/bin/bash', '-lc', 'a']);
    expect(t.readMode()).toMatchObject({ shell: 'host' });
    w.setCapture(captured(PLAIN, LOGIN));
    w.advance(30_000);
    await t.read('b');
    expect(w.calls[1].argv).toEqual(['sh', '-c', 'b']);
  });
  it('a capture that exits non-zero is a failed one, even with a dump that parses', async () => {
    const w = world();
    w.setCapture(captured(PLAIN, LOGIN), 127);
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('a');
    expect(w.calls[0].argv).toEqual(['/bin/bash', '-lc', 'a']);
    expect(t.readMode()).toMatchObject({ shell: 'host' });
  });
  it('a capture that times out waits its 30 s from when it gave up, not from when it began', async () => {
    const w = world();
    w.onCapture(() => {
      w.advance(30_000);
      throw new McprocError('TIMEOUT', 'Command timed out after 30000 ms');
    });
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('a');
    w.advance(1_000);
    await t.read('b');
    await Promise.all([t.read('c'), t.read('d')]);
    expect(w.captures()).toBe(1);
    expect(w.calls.map((c) => c.argv[0])).toEqual([
      '/bin/bash',
      '/bin/bash',
      '/bin/bash',
      '/bin/bash',
    ]);
    expect(t.readMode()).toMatchObject({ shell: 'host' });
  });
  it('a plain sh that cannot start with the login environment: the host shell, with no second capture', async () => {
    const w = world((argv) =>
      argv[0] === '/bin/bash' ? { stdout: 'via login' } : {}
    );
    const spawner: Spawner = async (argv, opts) => {
      if (argv[0] === 'sh' && opts.env)
        throw new McprocError(
          'TRANSPORT_FAILED',
          'Cannot spawn sh: spawn sh ENOENT'
        );
      return w.spawner(argv, opts);
    };
    const t = createTransport(local, spawner, undefined, w.clock);
    expect((await t.read('a')).stdout).toBe('via login');
    expect(w.calls.map((c) => c.argv)).toEqual([['/bin/bash', '-lc', 'a']]);
    expect(t.readMode()).toMatchObject({
      shell: 'host',
      reason: expect.stringContaining('Cannot spawn sh'),
    });
    expect(w.captures()).toBe(1);
    expect((await t.read('b')).stdout).toBe('via login');
    expect(w.captures()).toBe(1);
    expect(w.calls.at(-1)!.argv).toEqual(['/bin/bash', '-lc', 'b']);
  });
  it('a plain read that times out fails as it would through the host shell', async () => {
    const w = world();
    const spawner: Spawner = async (argv, opts) => {
      if (argv[0] === 'sh' && opts.env)
        throw new McprocError('TIMEOUT', 'Command timed out after 30000 ms');
      return w.spawner(argv, opts);
    };
    const t = createTransport(local, spawner, undefined, w.clock);
    await expect(t.read('a')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(w.calls).toEqual([]);
  });
  it('a plain host shell: read is exec, nothing is captured', async () => {
    const w = world();
    const t = createTransport(
      { ...local, shell: { bin: '/bin/sh', flags: ['-c'] } },
      w.spawner,
      undefined,
      w.clock
    );
    await t.read('a');
    expect(w.captures()).toBe(0);
    expect(t.readMode()).toEqual({
      shell: 'host',
      at: null,
      reason: 'the host shell is a plain sh',
    });
  });
  it('an injected spawner keeps its environments to the transport', async () => {
    const w = world();
    await createTransport(local, w.spawner, undefined, w.clock).read('a');
    await createTransport(local, w.spawner, undefined, w.clock).read('b');
    expect(w.captures()).toBe(2);
  });
  it('loginEnv gives the login side', async () => {
    const w = world();
    const t = createTransport(local, w.spawner, undefined, w.clock);
    expect(await t.loginEnv()).toEqual(LOGIN);
  });
});

describe('Transport.read with the real spawner', () => {
  it('the local child environment is the login one: a variable the profile exports reaches the read', async () => {
    clearLoginEnvCache();
    const t = createTransport({
      ...local,
      shell: {
        bin: 'sh',
        flags: ['-c', 'export FROM_PROFILE=yes; eval "$1"', 'login'],
      },
    });
    const r = await t.read('echo "[$FROM_PROFILE]"');
    expect(r.stdout.trim()).toBe('[yes]');
    expect(t.readMode()?.shell).toBe('plain');
    clearLoginEnvCache();
  });
});

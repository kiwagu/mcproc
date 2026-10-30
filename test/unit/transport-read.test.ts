import { describe, it, expect } from 'vitest';
import {
  createTransport,
  clearLoginEnvCache,
  ensureOk,
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
  let captureErr = '';
  let onCapture: () => void = () => {};
  const spawner: Spawner = async (argv, opts) => {
    const cmd = argv[argv.length - 1];
    if (cmd.includes(ENV_PLAIN)) {
      captures++;
      onCapture();
      return { code: captureCode, stdout: captureOut, stderr: captureErr };
    }
    calls.push({ argv, env: opts.env });
    return { code: 0, stdout: '', stderr: '', ...answer(argv) };
  };
  let t = 1_000_000;
  return {
    spawner,
    calls,
    captures: () => captures,
    setCapture: (s: string, code = 0, stderr = '') => {
      captureOut = s;
      captureCode = code;
      captureErr = stderr;
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
  it('an ssh host that does not answer the capture: its result comes back as it is, with no second connection', async () => {
    const refused =
      'ssh: connect to host stand port 22: Connection timed out\nmore';
    const w = world(() => ({ stdout: 'MARK ok' }));
    w.setCapture('', 255, refused);
    const t = createTransport(ssh, w.spawner, undefined, w.clock);
    expect(await t.read('probe')).toEqual({
      code: 255,
      stdout: '',
      stderr: refused,
    });
    // the capture was the only spawn: no read through the host shell after it
    expect(w.captures()).toBe(1);
    expect(w.calls).toHaveLength(0);
    expect(t.readMode()).toEqual({
      shell: 'host',
      at: 1_000_000,
      reason:
        'the host did not answer: ssh: connect to host stand port 22: Connection timed out',
    });
    // the next read within 30 s gets the same answer at once; after them the host is asked again
    expect((await t.read('probe')).code).toBe(255);
    expect(w.captures()).toBe(1);
    w.setCapture(captured(PLAIN, LOGIN));
    w.advance(30_000);
    expect((await t.read('probe')).stdout).toBe('MARK ok');
    expect(w.captures()).toBe(2);
    expect(t.readMode()).toMatchObject({ shell: 'plain' });
  });
  it('a docker container that is not running at the capture comes back as it is too', async () => {
    const stopped =
      'Error response from daemon: container app-1 is not running';
    const w = world(() => ({ stdout: 'MARK ok' }));
    w.setCapture('', 1, stopped);
    const t = createTransport(docker, w.spawner, undefined, w.clock);
    expect(await t.read('probe')).toEqual({
      code: 1,
      stdout: '',
      stderr: stopped,
    });
    expect(w.calls).toHaveLength(0);
    expect(t.readMode()).toMatchObject({
      shell: 'host',
      reason: `the host did not answer: ${stopped}`,
    });
  });
  it('a retry whose re-capture finds the connection dropped returns that failure, without pinning the host shell', async () => {
    const refused = 'ssh: connect to host stand port 22: Connection refused';
    const w = world((argv) =>
      argv.at(-1)!.includes('not-found-yet') ? { code: 127 } : {}
    );
    const t = createTransport(ssh, w.spawner, undefined, w.clock);
    // the read is not found in plain sh, and the connection drops before the environment is read again
    w.onCapture(() => {
      if (w.captures() === 2) w.setCapture('', 255, refused);
    });
    expect(await t.read('not-found-yet')).toEqual({
      code: 255,
      stdout: '',
      stderr: refused,
    });
    expect(w.captures()).toBe(2);
    // one plain read, and no host-shell read after the failed re-capture
    expect(w.calls).toHaveLength(1);
    expect(t.readMode()).toMatchObject({
      shell: 'host',
      reason: `the host did not answer: ${refused}`,
    });
    // not pinned for 5 minutes: 30 s on, the host is asked for its environment again
    w.setCapture(captured(PLAIN, LOGIN));
    w.advance(30_000);
    await t.read('later');
    expect(w.captures()).toBe(3);
    expect(w.calls.at(-1)!.argv.at(-1)).toMatch(/^'sh' '-c' .*later'$/);
    expect(t.readMode()).toMatchObject({ shell: 'plain' });
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
  it('a remote host whose ssh outlasts the timeout: the read fails with that timeout, without connecting again', async () => {
    const w = world();
    w.onCapture(() => {
      w.advance(30_000);
      throw new McprocError(
        'TIMEOUT',
        'Command timed out after 30000 ms: ssh -o BatchMode=yes -o'
      );
    });
    const t = createTransport(ssh, w.spawner, undefined, w.clock);
    await expect(t.read('probe')).rejects.toMatchObject({ code: 'TIMEOUT' });
    w.advance(1_000);
    await expect(t.read('again')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(w.captures()).toBe(1);
    expect(w.calls).toEqual([]); // no exec through the host shell: it would wait out the same timeout
    expect(t.readMode()).toMatchObject({
      shell: 'host',
      reason: expect.stringContaining('did not answer'),
    });
    // 30 s after it gave up, the host is asked again
    w.onCapture(() => {});
    w.advance(30_000);
    await t.read('later');
    expect(w.captures()).toBe(2);
    expect(t.readMode()).toMatchObject({ shell: 'plain' });
  });
  it('a remote host where ssh cannot even start: the read fails with that, without a second attempt', async () => {
    const w = world();
    w.onCapture(() => {
      throw new McprocError(
        'TRANSPORT_FAILED',
        'Cannot spawn ssh: spawn ssh ENOENT'
      );
    });
    const t = createTransport(ssh, w.spawner, undefined, w.clock);
    await expect(t.read('probe')).rejects.toMatchObject({
      code: 'TRANSPORT_FAILED',
    });
    expect(w.calls).toEqual([]);
  });
  it('this machine: a capture that times out still falls back to the host shell', async () => {
    const w = world();
    w.onCapture(() => {
      throw new McprocError('TIMEOUT', 'Command timed out after 30000 ms');
    });
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('a');
    expect(w.calls.map((c) => c.argv[0])).toEqual(['/bin/bash']);
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
  it('a plain sh that cannot start: loginEnv still gives the captured environment while reads use the host shell', async () => {
    const w = world();
    const spawner: Spawner = async (argv, opts) => {
      if (argv[0] === 'sh' && opts.env)
        throw new McprocError(
          'TRANSPORT_FAILED',
          'Cannot spawn sh: spawn sh ENOENT'
        );
      return w.spawner(argv, opts);
    };
    const t = createTransport(local, spawner, undefined, w.clock);
    await t.read('a');
    expect(t.readMode()).toMatchObject({ shell: 'host' });
    expect(await t.loginEnv()).toEqual(LOGIN);
    expect(t.readMode()).toMatchObject({ shell: 'host' });
  });
  it('a read that still fails after the retry: loginEnv still gives the captured environment', async () => {
    const w = world((argv) => (argv[0] === 'sh' ? { code: 127 } : {}));
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('x');
    expect(t.readMode()).toMatchObject({ shell: 'host' });
    expect(await t.loginEnv()).toEqual(LOGIN);
  });
  it('a capture that never worked: loginEnv is null', async () => {
    const w = world();
    w.setCapture('bash: no such file\n');
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('a');
    expect(await t.loginEnv()).toBeNull();
    expect(t.readMode()).toMatchObject({ shell: 'host' });
  });
  it('a capture that fails after one that worked: loginEnv keeps the last environment read', async () => {
    const w = world();
    const t = createTransport(local, w.spawner, undefined, w.clock);
    await t.read('a');
    w.setCapture('bash: no such file\n');
    w.advance(300_000);
    await t.read('b');
    expect(t.readMode()).toMatchObject({ shell: 'host' });
    expect(await t.loginEnv()).toEqual(LOGIN);
  });
  it('an ssh capture cut off mid-dump keeps none of the dump: the read and its error carry no environment', async () => {
    const dump = `${ENV_PLAIN}\n__MCPROC_ENV0__\nPATH=/bin\0API_TOKEN=s3cr3t-value\0HO`;
    const w = world();
    w.setCapture(dump, 255, '');
    const t = createTransport(ssh, w.spawner, undefined, w.clock);
    const r = await t.read('probe');
    expect(r).toEqual({ code: 255, stdout: '', stderr: '' });
    let err: McprocError | null = null;
    try {
      ensureOk(r, ssh, 'probe');
    } catch (e) {
      err = e as McprocError;
    }
    expect(err).toMatchObject({ code: 'TRANSPORT_FAILED' });
    expect(err?.message).toMatch(/^ssh to stand failed while running probe/);
    expect(err?.message).not.toContain('s3cr3t');
    expect(err?.message).not.toContain('API_TOKEN');
    expect(JSON.stringify(t.readMode())).not.toContain('s3cr3t');
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

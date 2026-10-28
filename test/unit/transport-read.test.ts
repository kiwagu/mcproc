import { describe, it, expect } from 'vitest';
import {
  createTransport,
  clearLoginEnvCache,
} from '../../src/transport/index.js';
import { ENV_PLAIN, ENV_LOGIN } from '../../src/transport/loginenv.js';
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
  const spawner: Spawner = async (argv, opts) => {
    const cmd = argv[argv.length - 1];
    if (cmd.includes(ENV_PLAIN)) {
      captures++;
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

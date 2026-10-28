import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  captureScript,
  parseCapture,
  childEnv,
  exportsOf,
  isPlainShell,
  ENV_PLAIN,
  ENV_LOGIN,
  type ShellSpec,
} from '../../src/transport/loginenv.js';

/**
 * A stand-in login shell: prints a line that looks like a variable, sets two variables as a profile would, then runs
 * its command.
 */
const fakeLogin: ShellSpec = {
  bin: 'sh',
  flags: [
    '-c',
    'echo NOISE=1; export FROM_PROFILE=yes; export PATH="/opt/tool/bin:$PATH"; eval "$1"',
    'login',
  ],
};
const run = (script: string, env: Record<string, string> = {}) =>
  execFileSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/home/t', ...env },
  });

describe('captureScript + parseCapture on this host', () => {
  it('reads the plain environment and the one the host shell sets up, skipping its profile output', () => {
    const e = parseCapture(run(captureScript(fakeLogin)));
    expect(e).not.toBeNull();
    expect(e!.plain.FROM_PROFILE).toBeUndefined();
    expect(e!.login.FROM_PROFILE).toBe('yes');
    expect(e!.login.NOISE).toBeUndefined();
    expect(e!.login.PATH).toBe('/opt/tool/bin:/usr/bin:/bin');
    expect(e!.plain.HOME).toBe('/home/t');
  });
  it('a plain variable that holds the capture script itself (a forced command over ssh) cuts nothing', () => {
    const script = captureScript(fakeLogin);
    const e = parseCapture(run(script, { SSH_ORIGINAL_COMMAND: script }));
    expect(e!.plain.HOME).toBe('/home/t');
    expect(e!.plain.SSH_ORIGINAL_COMMAND).toBe(script);
    expect(e!.login.FROM_PROFILE).toBe('yes');
    expect(e!.login.PATH).toBe('/opt/tool/bin:/usr/bin:/bin');
  });
  it('keeps a value with a newline and quotes whole (NUL form)', () => {
    const e = parseCapture(run(captureScript(fakeLogin), { ODD: "a\nb'c" }));
    expect(e!.plain.ODD).toBe("a\nb'c");
    expect(e!.login.ODD).toBe("a\nb'c");
  });
});

describe('parseCapture', () => {
  it('the line form (BusyBox env without -0): a continuation line drops out', () => {
    const out = [
      ENV_PLAIN,
      '__MCPROC_ENVL__',
      'A=1',
      'M=one',
      'two',
      '',
      ENV_LOGIN,
      'NOISE=1',
      '__MCPROC_ENVL__',
      'A=1',
      'B=2',
      '',
    ].join('\n');
    expect(parseCapture(out)).toEqual({
      plain: { A: '1', M: 'one' },
      login: { A: '1', B: '2' },
    });
  });
  it('no login dump (the host shell did not run): null', () => {
    expect(parseCapture(`${ENV_PLAIN}\n__MCPROC_ENVL__\nA=1\n`)).toBeNull();
    expect(
      parseCapture(
        `${ENV_PLAIN}\n__MCPROC_ENVL__\nA=1\n${ENV_LOGIN}\nbash: not found\n`
      )
    ).toBeNull();
  });
  it('names that are not shell identifiers never appear (exported bash functions)', () => {
    const out = `${ENV_PLAIN}\n__MCPROC_ENV0__\nA=1\0\n${ENV_LOGIN}\n__MCPROC_ENV0__\nA=1\0BASH_FUNC_f%%=() {  echo; }\0B=2\0`;
    expect(parseCapture(out)!.login).toEqual({ A: '1', B: '2' });
  });
});

describe('childEnv / exportsOf', () => {
  const e = {
    plain: { PATH: '/bin', HOME: '/h', SHLVL: '1', PWD: '/x', KEEP: 'same' },
    login: {
      PATH: '/opt/n/bin:/bin',
      HOME: '/h',
      SHLVL: '2',
      PWD: '/y',
      OLDPWD: '/z',
      _: '/usr/bin/env',
      KEEP: 'same',
      NEW: "it's",
    },
  };
  it('this machine: the login environment without the shell bookkeeping', () => {
    expect(childEnv(e)).toEqual({
      PATH: '/opt/n/bin:/bin',
      HOME: '/h',
      KEEP: 'same',
      NEW: "it's",
    });
  });
  it('another host: exports of what the login shell adds or changes, in name order, quoted', () => {
    expect(exportsOf(e)).toBe(
      `export NEW='it'\\''s'; export PATH='/opt/n/bin:/bin';`
    );
  });
  it('nothing changed: no exports', () => {
    expect(exportsOf({ plain: { A: '1' }, login: { A: '1' } })).toBe('');
  });
});

describe('isPlainShell', () => {
  it('sh -c and /bin/sh -c only', () => {
    expect(isPlainShell({ bin: 'sh', flags: ['-c'] })).toBe(true);
    expect(isPlainShell({ bin: '/bin/sh', flags: ['-c'] })).toBe(true);
    expect(isPlainShell({ bin: '/bin/bash', flags: ['-lc'] })).toBe(false);
    expect(isPlainShell({ bin: '/bin/sh', flags: ['-lc'] })).toBe(false);
  });
});

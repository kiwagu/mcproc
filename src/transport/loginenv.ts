import { shjoin, shq } from './quote.js';

/** A host's shell as the manifest gives it: the binary and its flags, the command goes last. */
export interface ShellSpec {
  bin: string;
  flags: string[];
}
export type Env = Record<string, string>;
/** The environment of a plain `sh -c` on a host, and the one its own shell (the login shell by default) sets up. */
export interface LoginEnv {
  plain: Env;
  login: Env;
}

export const ENV_PLAIN = '__MCPROC_ENV_PLAIN__';
export const ENV_LOGIN = '__MCPROC_ENV_LOGIN__';
const ENV_NUL = '__MCPROC_ENV0__';
const ENV_LINES = '__MCPROC_ENVL__';
/** How long a host's login environment is used before it is read again. */
export const LOGIN_ENV_TTL_MS = 300_000;
/** How long a host whose environment could not be read stays on its own shell before the next try. */
export const CAPTURE_RETRY_MS = 30_000;
/** Shell bookkeeping and read-only names: each shell sets these for itself, and exporting one can stop a script. */
const SKIPPED = new Set([
  '_',
  'SHLVL',
  'PWD',
  'OLDPWD',
  'PPID',
  'UID',
  'EUID',
  'BASHOPTS',
  'SHELLOPTS',
]);
const NAME = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** One environment dump: NUL-separated where `env -0` works (GNU, BSD), one variable per line where it does not (BusyBox). */
const DUMP = `if env -0 >/dev/null 2>&1; then echo ${ENV_NUL}; env -0; else echo ${ENV_LINES}; env; fi`;

/**
 * One round trip, run in a plain `sh -c` on the host: its own environment, then the one `shell` sets up. Whatever the
 * shell's profile prints before the dump is skipped by the marker.
 */
export function captureScript(shell: ShellSpec): string {
  return [
    `echo ${ENV_PLAIN}`,
    DUMP,
    'echo',
    `echo ${ENV_LOGIN}`,
    shjoin([shell.bin, ...shell.flags, DUMP]),
  ].join('\n');
}

function parseDump(part: string): Env | null {
  const z = part.indexOf(`${ENV_NUL}\n`);
  const l = part.indexOf(`${ENV_LINES}\n`);
  if (z < 0 && l < 0) return null;
  const nul = z >= 0 && (l < 0 || z < l);
  const body = part.slice(
    nul ? z + ENV_NUL.length + 1 : l + ENV_LINES.length + 1
  );
  const env: Env = {};
  // in the line form a value with a newline is cut there, and its continuation lines drop out (unless one looks like a variable)
  for (const entry of body.split(nul ? '\0' : '\n')) {
    const m = NAME.exec(entry);
    if (m) env[m[1]] = entry.slice(m[0].length);
  }
  return env;
}

/**
 * Both environments from captureScript's output; null when a dump is missing (the host shell did not run). The login
 * marker counts only as a line of its own: a plain variable can hold the script's text (ssh puts a forced command's
 * original one in SSH_ORIGINAL_COMMAND), and there the marker follows an `echo`.
 */
export function parseCapture(stdout: string): LoginEnv | null {
  const p = stdout.indexOf(ENV_PLAIN);
  const g = p < 0 ? -1 : stdout.indexOf(`\n${ENV_LOGIN}\n`, p);
  if (g < 0) return null;
  const plain = parseDump(stdout.slice(p, g));
  const login = parseDump(stdout.slice(g + 1));
  return plain && login ? { plain, login } : null;
}

/** The environment a read on this machine runs with: the login one as it is, without the shell's bookkeeping. */
export function childEnv(e: LoginEnv): Env {
  return Object.fromEntries(
    Object.entries(e.login).filter(([k]) => !SKIPPED.has(k))
  );
}

/** What a read on another host runs after: an export of each variable the login shell adds or changes, in name order. */
export function exportsOf(e: LoginEnv): string {
  return Object.keys(e.login)
    .filter((k) => !SKIPPED.has(k) && e.plain[k] !== e.login[k])
    .sort()
    .map((k) => `export ${k}=${shq(e.login[k])};`)
    .join(' ');
}

/** A host shell that is already a plain sh: reads use it as it is, with nothing to read first. */
export function isPlainShell(shell: ShellSpec): boolean {
  return (
    (shell.bin === 'sh' || shell.bin === '/bin/sh') &&
    shell.flags.length === 1 &&
    shell.flags[0] === '-c'
  );
}

import type { Host } from '../core/manifest.js';
import { McprocError } from '../core/errors.js';
import { shq, shjoin } from './quote.js';
import { nodeSpawner } from './spawn.js';
import type { ExecOptions, ExecResult, Spawner, Transport } from './types.js';

export type { ExecOptions, ExecResult, Spawner, Transport } from './types.js';
export { nodeSpawner } from './spawn.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

export function withEnv(cmd: string, env?: Record<string, string>): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return cmd;
  return entries.map(([k, v]) => `export ${k}=${shq(v)};`).join(' ') + ' ' + cmd;
}

function shellArgv(host: Host, cmd: string): string[] {
  return [host.shell.bin, ...host.shell.flags, cmd];
}

function dockerArgv(host: Host, cmd: string): string[] {
  const d = host.docker!;
  return ['docker', 'exec', ...(d.user ? ['-u', d.user] : []), '-i', d.container, ...shellArgv(host, cmd)];
}

export const SSH_CONNECT_TIMEOUT_S = 10;

export function buildArgv(host: Host, cmd: string): string[] {
  const inner = host.docker ? dockerArgv(host, cmd) : shellArgv(host, cmd);
  // a host that does not answer at all must fail in seconds, not hang a whole fleet of probes; after ssh_args, so a
  // ConnectTimeout given there wins (ssh keeps the first value it sees)
  if (host.ssh) return ['ssh', '-o', 'BatchMode=yes', ...host.ssh_args, '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`, host.ssh, shjoin(inner)];
  return inner;
}

export function describeHost(host: Host): string {
  const parts: string[] = [];
  if (host.ssh) parts.push(`ssh ${host.ssh}`);
  if (host.docker) parts.push(`docker ${host.docker.container}${host.docker.user ? ` (${host.docker.user})` : ''}`);
  return parts.length ? parts.join(' → ') : 'local';
}

export function createTransport(host: Host, spawner: Spawner = nodeSpawner): Transport {
  return {
    describe: () => describeHost(host),
    exec(cmd: string, opts: ExecOptions = {}) {
      const argv = buildArgv(host, withEnv(cmd, opts.env));
      return spawner(argv, { stdin: opts.stdin, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    },
  };
}

/** Turns transport-level failures into TRANSPORT_FAILED; leaves command exit codes to the caller. */
export function ensureOk(res: ExecResult, host: Host, what: string): ExecResult {
  const tail = (res.stderr || res.stdout).trim().split('\n').slice(-5).join('\n');
  if (host.ssh && res.code === 255) {
    throw new McprocError('TRANSPORT_FAILED', `ssh to ${host.ssh} failed while running ${what}: ${tail}`, { hint: 'Check the ssh alias in ~/.ssh/config and that key-based login works non-interactively (BatchMode).' });
  }
  if (host.docker && /No such container|is not running|Cannot connect to the Docker daemon|permission denied while trying to connect|OCI runtime exec failed|executable file not found|unable to find user/i.test(res.stderr)) {
    throw new McprocError('TRANSPORT_FAILED', `docker exec into ${host.docker.container} failed while running ${what}: ${tail}`);
  }
  return res;
}

import type { Host } from '../core/manifest.js';
import { isMcprocError, McprocError } from '../core/errors.js';
import {
  CAPTURE_RETRY_MS,
  captureScript,
  childEnv,
  exportsOf,
  isPlainShell,
  LOGIN_ENV_TTL_MS,
  type LoginEnv,
  parseCapture,
} from './loginenv.js';
import { shq, shjoin } from './quote.js';
import { nodeSpawner, nodeStreamer } from './spawn.js';
import type {
  ExecOptions,
  ExecResult,
  ReadMode,
  ReadOptions,
  Spawner,
  Streamer,
  Transport,
} from './types.js';

export type {
  ExecOptions,
  ExecResult,
  ReadMode,
  ReadOptions,
  Spawner,
  StreamProc,
  Streamer,
  Transport,
} from './types.js';
export { nodeSpawner, nodeStreamer } from './spawn.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

export function withEnv(cmd: string, env?: Record<string, string>): string {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return cmd;
  return `${entries.map(([k, v]) => `export ${k}=${shq(v)};`).join(' ')} ${cmd}`;
}

type Shell = Host['shell'];
/** no login profile: for a loop that only needs POSIX tools */
const PLAIN_SH: Shell = { bin: 'sh', flags: ['-c'] };

function shellArgv(shell: Shell, cmd: string): string[] {
  return [shell.bin, ...shell.flags, cmd];
}

function dockerArgv(host: Host, cmd: string, shell: Shell): string[] {
  const d = host.docker!;
  return [
    'docker',
    'exec',
    ...(d.user ? ['-u', d.user] : []),
    '-i',
    d.container,
    ...shellArgv(shell, cmd),
  ];
}

export const SSH_CONNECT_TIMEOUT_S = 10;

export function buildArgv(
  host: Host,
  cmd: string,
  shell: Shell = host.shell
): string[] {
  const inner = host.docker
    ? dockerArgv(host, cmd, shell)
    : shellArgv(shell, cmd);
  // a host that does not answer at all must fail in seconds, not hang a whole fleet of probes; after ssh_args, so a
  // ConnectTimeout given there wins (ssh keeps the first value it sees)
  if (host.ssh)
    return [
      'ssh',
      '-o',
      'BatchMode=yes',
      ...host.ssh_args,
      '-o',
      `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
      host.ssh,
      shjoin(inner),
    ];
  return inner;
}

export function describeHost(host: Host): string {
  const parts: string[] = [];
  if (host.ssh) parts.push(`ssh ${host.ssh}`);
  if (host.docker)
    parts.push(
      `docker ${host.docker.container}${host.docker.user ? ` (${host.docker.user})` : ''}`
    );
  return parts.length ? parts.join(' → ') : 'local';
}

/** A host's login environment as reads use it: null when they use the host shell (and why), until when it holds. */
interface Entry {
  env: LoginEnv | null;
  at: number;
  until: number;
  reason: string | null;
}
/** One host's entry, and when a failed read last made it read the environment again. */
interface Slot {
  entry: Promise<Entry> | null;
  failAt: number | null;
}
/** The login environments of the hosts the real spawner reaches, shared by every transport of this process. */
const SHARED = new Map<string, Slot>();
/** Forgets every host's login environment (tests; a profile changed on purpose). */
export function clearLoginEnvCache(): void {
  SHARED.clear();
}
const envKey = (host: Host): string =>
  `${describeHost(host)}|${host.ssh_args.join(' ')}|${shjoin([host.shell.bin, ...host.shell.flags])}`;

export function createTransport(
  host: Host,
  spawner: Spawner = nodeSpawner,
  streamer: Streamer = nodeStreamer,
  clock: () => number = Date.now
): Transport {
  // a test's fake spawner keeps its environments to itself: its world is not this machine's
  const store = spawner === nodeSpawner ? SHARED : new Map<string, Slot>();
  const key = envKey(host);
  const plainHost = isPlainShell(host.shell);
  let mode: ReadMode | null = plainHost
    ? { shell: 'host', at: null, reason: 'the host shell is a plain sh' }
    : null;
  const exec = (cmd: string, opts: ExecOptions = {}) =>
    spawner(buildArgv(host, withEnv(cmd, opts.env)), {
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  const slotOf = (): Slot => {
    let s = store.get(key);
    if (!s) {
      s = { entry: null, failAt: null };
      store.set(key, s);
    }
    return s;
  };
  const capture = (s: Slot): Promise<Entry> => {
    s.entry = (async (): Promise<Entry> => {
      // an entry holds from when its capture settled: one that timed out would otherwise be stale on arrival, and a
      // host whose shell hangs would pay the whole timeout on every read
      try {
        const res = await spawner(
          buildArgv(host, captureScript(host.shell), PLAIN_SH),
          { timeoutMs: DEFAULT_TIMEOUT_MS }
        );
        const at = clock();
        // only a capture that ran to its end counts: a dump cut short, or a login PATH without `env`, still parses,
        // as an environment with variables missing
        const env = res.code === 0 ? parseCapture(res.stdout) : null;
        return env
          ? { env, at, until: at + LOGIN_ENV_TTL_MS, reason: null }
          : {
              env: null,
              at,
              until: at + CAPTURE_RETRY_MS,
              reason: `${host.shell.bin} printed no environment (exit ${res.code})`,
            };
      } catch (e) {
        const at = clock();
        return {
          env: null,
          at,
          until: at + CAPTURE_RETRY_MS,
          reason: `reading the login environment failed: ${(e as Error).message.split('\n')[0]}`,
        };
      }
    })();
    return s.entry;
  };
  /** the entry reads use now; a stale one is read again, once for every read waiting on it */
  const current = async (): Promise<Entry> => {
    const s = slotOf();
    const held = s.entry;
    if (held) {
      const e = await held;
      if (clock() < e.until) return e;
      if (s.entry !== held) return s.entry as Promise<Entry>;
    }
    return capture(s);
  };
  const note = (e: Entry) => {
    mode = e.env
      ? { shell: 'plain', at: e.at, reason: null }
      : { shell: 'host', at: e.at, reason: e.reason };
  };
  const plain = (env: LoginEnv, cmd: string, opts: ReadOptions) =>
    spawner(
      buildArgv(
        host,
        host.local
          ? withEnv(cmd, opts.env)
          : `${exportsOf(env)} ${withEnv(cmd, opts.env)}`.trim(),
        PLAIN_SH
      ),
      {
        stdin: opts.stdin,
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(host.local ? { env: childEnv(env) } : {}),
      }
    );
  /** this host's reads go through its own shell for LOGIN_ENV_TTL_MS, this one first */
  const fallBack = (reason: string, cmd: string, opts: ReadOptions) => {
    const at = clock();
    const fallback: Entry = {
      env: null,
      at,
      until: at + LOGIN_ENV_TTL_MS,
      reason,
    };
    slotOf().entry = Promise.resolve(fallback);
    note(fallback);
    return exec(cmd, opts);
  };
  /**
   * The read in plain sh, or why plain sh could not even start: the login PATH may lack sh's own directory, and the
   * spawn resolves sh through it. A timeout or any other failure is the read's own, as it would be through exec.
   */
  const tryPlain = async (
    env: LoginEnv,
    cmd: string,
    opts: ReadOptions
  ): Promise<ExecResult | string> => {
    try {
      return await plain(env, cmd, opts);
    } catch (err) {
      if (isMcprocError(err) && err.code === 'TRANSPORT_FAILED')
        return `plain sh did not start with the login environment: ${err.message.split('\n')[0]}`;
      throw err;
    }
  };
  return {
    describe: () => describeHost(host),
    exec,
    async read(cmd: string, opts: ReadOptions = {}) {
      if (plainHost) return exec(cmd, opts);
      const retryIf = opts.retryIf ?? ((r) => r.code === 127);
      let e = await current();
      note(e);
      if (!e.env) return exec(cmd, opts);
      // a plain sh that does not start is the environment's fault: reading it again would bring the same one back
      const res = await tryPlain(e.env, cmd, opts);
      if (typeof res === 'string') return fallBack(res, cmd, opts);
      // a dropped connection or a stopped container is the link's failure, not plain sh's: it goes back as it is,
      // for ensureOk to report, and the host's next read tries plain sh again
      if (isTransportFailure(host, res) || !retryIf(res)) return res;
      const s = slotOf();
      // a failure reads the environment again at most once per LOGIN_ENV_TTL_MS: a host that lacks the command for
      // good must not pay a capture on every read
      if (s.failAt === null || clock() - s.failAt >= LOGIN_ENV_TTL_MS) {
        s.failAt = clock();
        e = await capture(s);
        note(e);
        if (e.env) {
          const again = await tryPlain(e.env, cmd, opts);
          if (typeof again === 'string') return fallBack(again, cmd, opts);
          if (isTransportFailure(host, again) || !retryIf(again)) return again;
        }
      }
      return fallBack(
        'a read did not work in plain sh with the login environment',
        cmd,
        opts
      );
    },
    async loginEnv() {
      if (plainHost) return null;
      const e = await current();
      note(e);
      return e.env?.login ?? null;
    },
    readMode: () => mode,
    stream: (cmd: string) => streamer(buildArgv(host, cmd, PLAIN_SH)),
  };
}

const sshFailed = (host: Host, res: ExecResult): boolean =>
  Boolean(host.ssh) && res.code === 255;
const DOCKER_FAILED =
  /No such container|is not running|Cannot connect to the Docker daemon|permission denied while trying to connect|OCI runtime exec failed|executable file not found|unable to find user/i;

/** Whether a result is the connection's failure (ssh, docker exec) rather than the command's own answer. */
export function isTransportFailure(host: Host, res: ExecResult): boolean {
  return (
    sshFailed(host, res) ||
    (Boolean(host.docker) && DOCKER_FAILED.test(res.stderr))
  );
}

/** Turns transport-level failures into TRANSPORT_FAILED; leaves command exit codes to the caller. */
export function ensureOk(
  res: ExecResult,
  host: Host,
  what: string
): ExecResult {
  if (!isTransportFailure(host, res)) return res;
  const tail = (res.stderr || res.stdout)
    .trim()
    .split('\n')
    .slice(-5)
    .join('\n');
  if (sshFailed(host, res)) {
    throw new McprocError(
      'TRANSPORT_FAILED',
      `ssh to ${host.ssh} failed while running ${what}: ${tail}`,
      {
        hint: 'Check the ssh alias in ~/.ssh/config and that key-based login works non-interactively (BatchMode).',
      }
    );
  }
  throw new McprocError(
    'TRANSPORT_FAILED',
    `docker exec into ${host.docker?.container} failed while running ${what}: ${tail}`
  );
}

import type { Host } from '../core/manifest.js';
import { McprocError } from '../core/errors.js';
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
      const at = clock();
      try {
        const res = await spawner(
          buildArgv(host, captureScript(host.shell), PLAIN_SH),
          { timeoutMs: DEFAULT_TIMEOUT_MS }
        );
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
  return {
    describe: () => describeHost(host),
    exec,
    async read(cmd: string, opts: ReadOptions = {}) {
      if (plainHost) return exec(cmd, opts);
      const retryIf = opts.retryIf ?? ((r) => r.code === 127);
      let e = await current();
      note(e);
      if (!e.env) return exec(cmd, opts);
      const res = await plain(e.env, cmd, opts);
      if (!retryIf(res)) return res;
      const s = slotOf();
      // a failure reads the environment again at most once per LOGIN_ENV_TTL_MS: a host that lacks the command for
      // good must not pay a capture on every read
      if (s.failAt === null || clock() - s.failAt >= LOGIN_ENV_TTL_MS) {
        s.failAt = clock();
        e = await capture(s);
        note(e);
        if (e.env) {
          const again = await plain(e.env, cmd, opts);
          if (!retryIf(again)) return again;
        }
      }
      const at = clock();
      const fallback: Entry = {
        env: null,
        at,
        until: at + LOGIN_ENV_TTL_MS,
        reason: 'a read did not work in plain sh with the login environment',
      };
      s.entry = Promise.resolve(fallback);
      note(fallback);
      return exec(cmd, opts);
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

/** Turns transport-level failures into TRANSPORT_FAILED; leaves command exit codes to the caller. */
export function ensureOk(
  res: ExecResult,
  host: Host,
  what: string
): ExecResult {
  const tail = (res.stderr || res.stdout)
    .trim()
    .split('\n')
    .slice(-5)
    .join('\n');
  if (host.ssh && res.code === 255) {
    throw new McprocError(
      'TRANSPORT_FAILED',
      `ssh to ${host.ssh} failed while running ${what}: ${tail}`,
      {
        hint: 'Check the ssh alias in ~/.ssh/config and that key-based login works non-interactively (BatchMode).',
      }
    );
  }
  if (
    host.docker &&
    /No such container|is not running|Cannot connect to the Docker daemon|permission denied while trying to connect|OCI runtime exec failed|executable file not found|unable to find user/i.test(
      res.stderr
    )
  ) {
    throw new McprocError(
      'TRANSPORT_FAILED',
      `docker exec into ${host.docker.container} failed while running ${what}: ${tail}`
    );
  }
  return res;
}

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { McprocError } from './errors.js';
import type { Host } from './manifest.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';
import { isPlainShell } from '../transport/loginenv.js';
import type { ExecResult, Transport } from '../transport/types.js';

export interface Pm2Process {
  pm_id: number;
  name: string;
  namespace: string;
  pid: number;
  status: string;
  cwd: string;
  out_log: string;
  err_log: string;
  restarts: number;
  unstable_restarts: number;
  /** pm2's last recorded exit code for the process, any app; null when pm2 has recorded none (it never exited, or the field is absent) */
  exit_code: number | null;
  uptime_ms: number | null;
  /** when pm2 last started the process (pm_uptime, epoch ms), any status: a stopped process keeps its last start; null when absent */
  started_at: number | null;
  cpu: number;
  memory: number;
  watch: boolean;
}

const RUNNING = new Set(['online', 'launching']);
/** Whether a pm2 status is a process that is running, or about to be: the only one with a current run to look at. */
export const isRunning = (status: string): boolean => RUNNING.has(status);

export const PM2_NOT_FOUND_HINT =
  'No usable pm2 on this host. Run unpack for it (brings pm2, and Node when missing), install pm2 there (Node 18 or newer), or set hosts.<host>.pm2.';

type RawProc = {
  pid?: number;
  name: string;
  pm_id: number;
  monit?: { memory?: number; cpu?: number };
  pm2_env?: Record<string, unknown>;
};

function normalize(p: RawProc): Pm2Process {
  const env = p.pm2_env ?? {};
  const status = String(env.status ?? 'unknown');
  const up = typeof env.pm_uptime === 'number' ? env.pm_uptime : null;
  return {
    pm_id: p.pm_id,
    name: p.name,
    namespace: String(env.namespace ?? 'default'),
    pid: p.pid ?? 0,
    status,
    cwd: String(env.pm_cwd ?? ''),
    out_log: String(env.pm_out_log_path ?? ''),
    err_log: String(env.pm_err_log_path ?? ''),
    restarts: Number(env.restart_time ?? 0),
    unstable_restarts: Number(env.unstable_restarts ?? 0),
    exit_code: typeof env.exit_code === 'number' ? env.exit_code : null,
    uptime_ms: status === 'online' && up ? Math.max(0, Date.now() - up) : null,
    started_at: up,
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    watch: Boolean(env.watch),
  };
}

/**
 * pm2 prints coloured "[PM2] …" lines before the JSON when it spawns the daemon, and an update notice on any
 * command; take the last line that opens a JSON array. Real pm2 prints the array on one line; a pretty-printed
 * array (a wrapper, a fixture) is accepted too by parsing from that line to the end of the output.
 */
export function parseJlist(stdout: string): Pm2Process[] {
  const lines = stdout.split('\n');
  const asArray = (text: string): RawProc[] | null => {
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? (v as RawProc[]) : null;
    } catch {
      return null;
    }
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('[') || l.startsWith('[PM2]')) continue;
    const arr = asArray(l) ?? asArray(lines.slice(i).join('\n'));
    if (arr) return arr.map(normalize);
  }
  throw new McprocError('PM2_FAILED', 'pm2 jlist returned no JSON array', {
    details: stdout.slice(-500),
  });
}

/**
 * The pm2 process name of a manifest app. pm2 matches processes by NAME only (`start`/`startOrRestart --only`
 * ignore the namespace), so a bare app name would let one project take over another project's process on a
 * shared daemon. The project prefix keeps names unique per project; the namespace is still set for grouping.
 */
export function pm2Name(project: string, app: string): string {
  return `${project}-${app}`;
}

export function findProcess(
  procs: Pm2Process[],
  project: string,
  app: string
): Pm2Process | undefined {
  const name = pm2Name(project, app);
  return procs.find((p) => p.namespace === project && p.name === name);
}

/** Lists the daemon at a home over its socket; null when none runs there (src/core/pm2socket.ts). */
export type DaemonLister = (home: string) => Promise<unknown[] | null>;

export class Pm2Client {
  constructor(
    readonly transport: Transport,
    readonly host: Host,
    readonly bin: string,
    readonly pm2Home?: string,
    private readonly lister: DaemonLister | null = null
  ) {}
  /** whether pm2's list comes from the daemon's socket (this machine) rather than from `pm2 jlist` */
  listsOverSocket(): boolean {
    return this.lister !== null;
  }
  /**
   * the environment pm2 runs with here: the login one; this process's own where the host shell is a plain sh, which
   * inherits it; null when the login environment could not be read
   */
  private async daemonEnv(): Promise<NodeJS.ProcessEnv | null> {
    return (
      (await this.transport.loginEnv()) ??
      (isPlainShell(this.host.shell) ? process.env : null)
    );
  }
  /** the daemon's home: hosts.<h>.pm2_home, else PM2_HOME of the login environment, else ~/.pm2 of it */
  async home(): Promise<string> {
    if (this.pm2Home) return this.pm2Home;
    const env = (await this.daemonEnv()) ?? process.env;
    return env.PM2_HOME || path.join(env.HOME || os.homedir(), '.pm2');
  }
  /** pm2's processes; null when no daemon runs (only the socket can tell: `pm2 jlist` starts one and answers) */
  async daemonList(): Promise<Pm2Process[] | null> {
    if (this.lister) {
      const env = await this.daemonEnv();
      // the socket only for a daemon whose home is known and that listens at <home>/rpc.sock: PM2_DAEMON_RPC_PORT
      // moves that endpoint, and an environment that could not be read leaves the home unknown; the CLI finds both
      if ((this.pm2Home || env) && !(env ?? process.env).PM2_DAEMON_RPC_PORT) {
        try {
          const list = await this.lister(await this.home());
          return list === null ? null : (list as RawProc[]).map(normalize);
        } catch {
          /* a daemon that errs or hangs: the CLI answers this once */
        }
      }
    }
    return parseJlist((await this.run(['jlist'], { read: true })).stdout);
  }
  /**
   * the directory pm2 writes its processes' pid files to, for monit to watch: only where its list comes over the socket
   * (this machine, mcproc's own pm2), its home is known, and PM2_DEFAULT_PID_PATH (pm2 reads it from its environment)
   * does not move it; else why not
   */
  async pids(): Promise<
    { dir: string; why: null } | { dir: null; why: string }
  > {
    if (!this.lister)
      return {
        dir: null,
        why: "pm2's list does not come over its socket here",
      };
    const env = await this.daemonEnv();
    if (!this.pm2Home && !env)
      return { dir: null, why: 'the login environment could not be read' };
    if ((env ?? process.env).PM2_DEFAULT_PID_PATH)
      return { dir: null, why: 'PM2_DEFAULT_PID_PATH moves its pid files' };
    return { dir: path.join(await this.home(), 'pids'), why: null };
  }
  env(): Record<string, string> | undefined {
    return this.pm2Home ? { PM2_HOME: this.pm2Home } : undefined;
  }
  async run(
    args: string[],
    opts: { timeoutMs?: number; read?: boolean } = {}
  ): Promise<ExecResult> {
    const cmd = `${this.bin} ${args.map(shq).join(' ')}`;
    const how = { env: this.env(), timeoutMs: opts.timeoutMs };
    const res = ensureOk(
      // a list or a version is a read; start, stop and delete keep the host shell, whose environment pm2 hands to the app
      await (opts.read
        ? this.transport.read(cmd, how)
        : this.transport.exec(cmd, how)),
      this.host,
      `pm2 ${args[0]}`
    );
    if (res.code === 127 && !/pm2/i.test(res.stderr))
      throw new McprocError(
        'TRANSPORT_FAILED',
        `the shell on ${this.transport.describe()} could not run pm2 ${args[0]}: ${res.stderr.trim()}`
      );
    if (res.code === 127)
      throw new McprocError(
        'PM2_NOT_FOUND',
        `pm2 not found on ${this.transport.describe()}: ${res.stderr.trim()}`,
        { hint: PM2_NOT_FOUND_HINT }
      );
    if (res.code !== 0) {
      const tail = (res.stderr || res.stdout)
        .trim()
        .split('\n')
        .slice(-5)
        .join('\n');
      throw new McprocError(
        'PM2_FAILED',
        `pm2 ${args[0]} failed (exit ${res.code}): ${tail}`
      );
    }
    return res;
  }
  async jlist(): Promise<Pm2Process[]> {
    return (await this.daemonList()) ?? [];
  }
  startOrRestart(file: string, app: string) {
    return this.run(['startOrRestart', file, '--only', app, '--update-env'], {
      timeoutMs: 90_000,
    });
  }
  stop(id: number) {
    return this.run(['stop', String(id)]);
  }
  delete(id: number) {
    return this.run(['delete', String(id)]);
  }
  async version(): Promise<string> {
    return (
      (await this.run(['-v'], { read: true })).stdout
        .trim()
        .split('\n')
        .pop() ?? ''
    );
  }
}

export interface Pm2Resolution {
  bin: string;
  source: 'explicit' | 'runtime' | 'path' | 'bundled';
  node: string | null;
  pm2Version: string | null;
  reason: string;
}

export function runtimeDir(host: Host): string {
  return host.runtime ?? path.posix.join(host.cwd, '.mcproc', 'runtime');
}

export function bundledPm2Bin(): string {
  const req = createRequire(import.meta.url);
  const pm2Path = req.resolve('pm2/bin/pm2');
  return `${shq(process.execPath)} ${shq(pm2Path)}`;
}

export function nodeMajor(v: string | null): number {
  const m = /^v?(\d+)/.exec(v ?? '');
  return m ? Number(m[1]) : 0;
}

const RESOLVED = /^(RUNTIME|PATH_OK|PATH_NONE)$/m;
/** this machine: only a missing marker retries; PATH_NONE is a real answer, the bundled pm2 takes over */
const resolutionRetryHere = (r: ExecResult): boolean =>
  !RESOLVED.test(r.stdout);
/**
 * another host: "pm2 not found" retries too, so the environment is read again and then the host shell asked: a pm2
 * that only the login shell defines (a profile function, a wrapper) is still found
 */
const resolutionRetryRemote = (r: ExecResult): boolean =>
  resolutionRetryHere(r) || /^PATH_NONE$/m.test(r.stdout);

export async function resolvePm2Bin(
  host: Host,
  transport: Transport
): Promise<Pm2Resolution> {
  if (host.pm2)
    return {
      bin: host.pm2,
      source: 'explicit',
      node: null,
      pm2Version: null,
      reason: `hosts.${host.name}.pm2`,
    };
  const rt = path.posix.join(runtimeDir(host), 'bin', 'pm2');
  // the runtime bundle wins without running any other pm2 (a hanging shim cannot block it); `pm2 -v` talks to a daemon,
  // so it runs with the host's PM2_HOME, never against the default one
  const probe = [
    `if [ -x ${shq(rt)} ]; then echo RUNTIME; elif command -v pm2 >/dev/null 2>&1; then echo PATH_OK; pm2 -v 2>/dev/null | tail -n 1; echo; else echo PATH_NONE; fi`,
    `node -v 2>/dev/null || echo NODE_NONE`,
  ].join('; ');
  const res = ensureOk(
    await transport.read(probe, {
      env: host.pm2_home ? { PM2_HOME: host.pm2_home } : undefined,
      retryIf: host.local ? resolutionRetryHere : resolutionRetryRemote,
    }),
    host,
    'pm2 probe'
  );
  const lines = res.stdout.split('\n').map((l) => l.trim());
  if (
    !lines.includes('RUNTIME') &&
    !lines.includes('PATH_OK') &&
    !lines.includes('PATH_NONE')
  ) {
    const tail = (res.stderr || res.stdout)
      .trim()
      .split('\n')
      .slice(-5)
      .join('\n');
    throw new McprocError(
      'TRANSPORT_FAILED',
      `the shell on ${transport.describe()} did not run the pm2 probe (exit ${res.code}): ${tail}`,
      {
        hint: `Check hosts.${host.name}.shell (default /bin/bash -lc) exists on that host.`,
      }
    );
  }
  const node = lines.find((l) => /^v\d+\./.test(l)) ?? null;
  if (lines.includes('RUNTIME'))
    return {
      bin: shq(rt),
      source: 'runtime',
      node,
      pm2Version: null,
      reason: `runtime bundle at ${runtimeDir(host)}`,
    };
  const i = lines.indexOf('PATH_OK');
  const pm2Version =
    i >= 0 && /^\d+\.\d+/.test(lines[i + 1] ?? '') ? lines[i + 1] : null;
  if (pm2Version && nodeMajor(node) >= 18)
    return {
      bin: 'pm2',
      source: 'path',
      node,
      pm2Version,
      reason: 'pm2 on the login-shell PATH',
    };
  if (host.local)
    return {
      bin: bundledPm2Bin(),
      source: 'bundled',
      node: process.version,
      pm2Version: null,
      reason: 'pm2 bundled with mcproc',
    };
  const why =
    i < 0
      ? 'no pm2 on PATH'
      : !pm2Version
        ? 'pm2 on PATH does not run (`pm2 -v` printed nothing)'
        : `Node ${node ?? 'missing'} is older than 18`;
  throw new McprocError('PM2_NOT_FOUND', `${transport.describe()}: ${why}`, {
    hint: PM2_NOT_FOUND_HINT,
  });
}

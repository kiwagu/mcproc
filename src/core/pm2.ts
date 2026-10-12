import { createRequire } from 'node:module';
import path from 'node:path';
import { McprocError } from './errors.js';
import type { Host } from './manifest.js';
import { shq } from '../transport/quote.js';
import { ensureOk } from '../transport/index.js';
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
  uptime_ms: number | null;
  cpu: number;
  memory: number;
  watch: boolean;
}

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
    uptime_ms: status === 'online' && up ? Math.max(0, Date.now() - up) : null,
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

export class Pm2Client {
  constructor(
    readonly transport: Transport,
    readonly host: Host,
    readonly bin: string,
    readonly pm2Home?: string
  ) {}
  env(): Record<string, string> | undefined {
    return this.pm2Home ? { PM2_HOME: this.pm2Home } : undefined;
  }
  async run(
    args: string[],
    opts: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const cmd = `${this.bin} ${args.map(shq).join(' ')}`;
    const res = ensureOk(
      await this.transport.exec(cmd, {
        env: this.env(),
        timeoutMs: opts.timeoutMs,
      }),
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
    return parseJlist((await this.run(['jlist'])).stdout);
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
    return (await this.run(['-v'])).stdout.trim().split('\n').pop() ?? '';
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
    await transport.exec(probe, {
      env: host.pm2_home ? { PM2_HOME: host.pm2_home } : undefined,
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

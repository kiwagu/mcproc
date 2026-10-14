import path from 'node:path';
import type { App, Host, Manifest } from './manifest.js';
import { pm2Name } from './pm2.js';

/** The stamp pm2 writes before every log line; mcproc's log readers accept it and the older second-only form. */
export const LOG_STAMP = 'YYYY-MM-DDTHH:mm:ss.SSS';

/**
 * In front of a one-shot app's command. pm2 records exit_code 0 for a process killed by a signal, so a plain
 * `pm2 stop` would read as a successful run; the shell runs the trap after its foreground child exits and leaves
 * 130 (SIGINT) or 143 (SIGTERM) instead, which the status word reads as "stopped". Natural exits pass through.
 */
export const STOP_TRAP = "trap 'exit 130' INT; trap 'exit 143' TERM; ";

export interface Pm2AppConfig {
  name: string;
  namespace: string;
  cwd: string;
  script: string;
  args: string[];
  interpreter: 'none';
  env: Record<string, string>;
  autorestart: boolean;
  treekill: true;
  /** pm2's stamp before every log line, to the millisecond (pm2 would overwrite it with seconds if `time` were set) */
  log_date_format: string;
  watch?: boolean | string[];
  watch_delay?: number;
  ignore_watch?: string[];
  [k: string]: unknown;
}

export function appCwd(host: Host, app: App): string {
  return path.posix.resolve(host.cwd, app.cwd);
}

export function generatedDir(host: Host): string {
  return path.posix.join(host.cwd, '.mcproc', '.generated');
}

export function ecosystemPath(host: Host): string {
  return path.posix.join(generatedDir(host), 'ecosystem.json');
}

export function buildEcosystem(
  m: Manifest,
  host: Host
): { apps: Pm2AppConfig[] } {
  const apps = Object.values(m.apps).map((app): Pm2AppConfig => {
    const base: Pm2AppConfig = {
      name: pm2Name(m.project, app.name),
      namespace: m.project,
      cwd: appCwd(host, app),
      script: host.shell.bin,
      args: [
        ...host.shell.flags,
        app.autorestart ? app.run : STOP_TRAP + app.run,
      ],
      interpreter: 'none',
      env: { ...app.env, ...host.env },
      autorestart: app.autorestart,
      treekill: true,
      log_date_format: LOG_STAMP,
    };
    if (app.watch !== undefined) {
      base.watch = app.watch;
      base.watch_delay = app.watch_delay;
    }
    if (app.ignore_watch) base.ignore_watch = app.ignore_watch;
    return { ...base, ...app.pm2 } as Pm2AppConfig; // protected keys were rejected at validation
  });
  return { apps };
}

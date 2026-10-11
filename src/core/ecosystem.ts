import path from 'node:path';
import type { App, Host, Manifest } from './manifest.js';
import { pm2Name } from './pm2.js';

export interface Pm2AppConfig {
  name: string; namespace: string; cwd: string; script: string; args: string[]; interpreter: 'none';
  env: Record<string, string>; autorestart: boolean; treekill: true; time: true;
  watch?: boolean | string[]; watch_delay?: number; ignore_watch?: string[];
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

export function buildEcosystem(m: Manifest, host: Host): { apps: Pm2AppConfig[] } {
  const apps = Object.values(m.apps).map((app): Pm2AppConfig => {
    const base: Pm2AppConfig = {
      name: pm2Name(m.project, app.name), namespace: m.project, cwd: appCwd(host, app),
      script: host.shell.bin, args: [...host.shell.flags, app.run], interpreter: 'none',
      env: { ...app.env, ...host.env }, autorestart: app.autorestart, treekill: true, time: true,
    };
    if (app.watch !== undefined) { base.watch = app.watch; base.watch_delay = app.watch_delay; }
    if (app.ignore_watch) base.ignore_watch = app.ignore_watch;
    return { ...base, ...app.pm2 } as Pm2AppConfig;  // protected keys were rejected at validation
  });
  return { apps };
}

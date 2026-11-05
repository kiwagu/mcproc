import { actOn, defaultConnector, Fleet, type Connector } from '../fleet.js';
import { describeError } from '../errors.js';
import type { Host, Manifest } from '../manifest.js';
import { pickHost } from '../resolve.js';
import { appCwd } from '../ecosystem.js';
import { findProcess, type Pm2Process } from '../pm2.js';

/** What a stop of a whole stack did: the apps it stopped, the apps of readonly hosts it left alone, what failed. */
export interface StackStop {
  stopped: string[];
  readonly: { host: string; apps: string[] }[];
  failed: { host: string; message: string }[];
}

/**
 * Stops every app of the stack at its own host, the way `stop all` does, leaving the apps of readonly hosts alone and
 * saying so. pm2 names are `<slug>-<app>`, so two checkouts declaring one slug on one daemon share them: a process that
 * runs from another checkout's folder is left alone and named, never stopped on this stack's behalf.
 */
export async function stopStack(
  m: Manifest,
  connector: Connector = defaultConnector()
): Promise<StackStop> {
  const out: StackStop = { stopped: [], readonly: [], failed: [] };
  // a host the manifest cannot give (pickHost) is reported like any other failure, never thrown
  try {
    const fleet = new Fleet(m, undefined, connector);
    const ro = new Map<string, string[]>();
    const names = fleet.select(['all']).filter((a) => {
      const h = fleet.hostOf(a);
      if (!pickHost(m, h).readonly) return true;
      ro.set(h, [...(ro.get(h) ?? []), a]);
      return false;
    });
    out.readonly = [...ro].map(([host, apps]) => ({ host, apps }));
    const mine = await ownApps(m, fleet, names, out);
    if (mine.length === 0) return out;
    for (const r of await actOn(fleet, mine, 'stop'))
      if (r.error)
        out.failed.push({ host: r.host, message: `${r.app}: ${r.error}` });
      else out.stopped.push(r.app);
  } catch (e) {
    out.failed.push({ host: '-', message: describeError(e) });
  }
  return out;
}

/**
 * The apps whose pm2 process, when there is one, runs from this checkout's folder; the others go to `failed`. A host
 * whose pm2 list cannot be read stops nothing: its apps go to `failed` with the reason, since a stop without the check
 * could reach another checkout's process of the same name.
 */
async function ownApps(
  m: Manifest,
  fleet: Fleet,
  names: string[],
  out: StackStop
): Promise<string[]> {
  const keep: string[] = [];
  for (const g of fleet.groups(names)) {
    let procs: Pm2Process[];
    let host: Host;
    try {
      const ctx = await fleet.ctx(g.host);
      host = ctx.host;
      procs = await ctx.pm2.jlist();
    } catch (e) {
      for (const a of g.apps)
        out.failed.push({ host: g.host, message: `${a}: ${describeError(e)}` });
      continue;
    }
    for (const a of g.apps) {
      const p = findProcess(procs, m.project, a);
      const own = appCwd(host, m.apps[a]);
      if (p?.cwd && p.cwd !== own)
        out.failed.push({
          host: g.host,
          message: `${a}: runs from another checkout (${p.cwd}), left alone`,
        });
      else keep.push(a);
    }
  }
  // the stop goes in the manifest's order, as `stop all` does
  return names.filter((a) => keep.includes(a));
}

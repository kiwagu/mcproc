import { actOn, defaultConnector, Fleet, type Connector } from '../fleet.js';
import { describeError } from '../errors.js';
import type { Manifest } from '../manifest.js';
import { pickHost } from '../resolve.js';

/** What a stop of a whole stack did: the apps it stopped, the apps of readonly hosts it left alone, what failed. */
export interface StackStop {
  stopped: string[];
  readonly: { host: string; apps: string[] }[];
  failed: { host: string; message: string }[];
}

/**
 * Stops every app of the stack at its own host, the way `stop all` does, leaving the apps of readonly hosts alone and
 * saying so.
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
    if (names.length === 0) return out;
    for (const r of await actOn(fleet, names, 'stop'))
      if (r.error)
        out.failed.push({ host: r.host, message: `${r.app}: ${r.error}` });
      else out.stopped.push(r.app);
  } catch (e) {
    out.failed.push({ host: '-', message: describeError(e) });
  }
  return out;
}

import { pickHost } from '../resolve.js';
import { scopeManifest, type Host, type Manifest } from '../manifest.js';
import { Fleet } from '../fleet.js';
import {
  deriveSnapshot,
  rowsFor,
  unreachableRow,
  type HostProbe,
  type LsRow,
} from '../list.js';
import { descendants } from '../ports.js';
import { treeMetrics } from '../metrics.js';
import { WATCHER_NS } from '../leases/ensure.js';
import { describeHost } from '../../transport/index.js';
import type { HereCheck } from '../urlcheck.js';
import type { StatSample } from '../stats.js';
import type { Pm2Process } from '../pm2.js';
import { describeError, isMcprocError } from '../errors.js';
import type {
  EndpointRead,
  Orphan,
  ProjectInput,
  StackApps,
  StackError,
  StackView,
} from './types.js';

type Prev = Map<string, { sample: StatSample; at: number }>;

/** Where one pm2 daemon is reached: the transport plus the home it runs from (none: that transport's default). */
export function endpointKey(host: Host): string {
  return `${describeHost(host)}|${host.pm2_home ?? ''}`;
}
/** How an endpoint is named on screen: a remote host by its name, the local daemon by its home when it has its own. */
export function endpointLabel(host: Host): string {
  if (!host.local) return host.name;
  return host.pm2_home ? `local (${host.pm2_home})` : 'local';
}
/** One pm2 namespace on one endpoint: what a checkout claims, and what an orphan note is filed under. */
export const claimKey = (endpoint: string, namespace: string) =>
  `${endpoint}\0${namespace}`;

/** Whether a path lies at or below a root (POSIX paths: a remote host's too). */
const under = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);
/** A directory without its trailing slashes, so that one directory written two ways compares equal. */
const bare = (dir: string) => dir.replace(/(.)\/+$/, '$1');

/**
 * The directories a checkout's apps run from on one endpoint: the cwd of each of its hosts there, its root without a
 * manifest. A host its manifest does not know adds none: a rival's bad input never fails this checkout's read.
 */
function cwdsOn(p: ProjectInput, key: string): string[] {
  const m = p.manifest;
  if (!m) return [bare(p.root)];
  return Object.entries(p.endpoints)
    .filter(([name, k]) => k === key && Object.hasOwn(m.hosts, name))
    .map(([name]) => bare(m.hosts[name].cwd));
}

/**
 * The processes of `p`'s namespace on an endpoint that are its own. With one claimant, all of them; when checkouts share
 * the slug there, each process goes to the one whose directory holds its cwd most closely. A process that no directory
 * holds, or that two checkouts hold through the same directory, is no one's.
 */
function ownProcs(
  p: ProjectInput,
  key: string,
  procs: Pm2Process[],
  claimants: ProjectInput[]
): Pm2Process[] {
  const mine = procs.filter((pr) => pr.namespace === p.project);
  if (claimants.length < 2) return mine;
  const dirs = claimants.flatMap((c) =>
    cwdsOn(c, key).map((dir) => ({ c, dir }))
  );
  return mine.filter((pr) => {
    let best = -1;
    let owners = new Set<ProjectInput>();
    for (const d of dirs) {
      if (!under(pr.cwd, d.dir) || d.dir.length < best) continue;
      if (d.dir.length > best) {
        best = d.dir.length;
        owners = new Set();
      }
      owners.add(d.c);
    }
    return owners.size === 1 && owners.has(p);
  });
}

/** An error as a stack carries it: an mcproc error's code, message and hint; ERROR and the message for anything else. */
function stackError(e: unknown): StackError {
  if (!isMcprocError(e)) return { code: 'ERROR', message: describeError(e) };
  return e.hint
    ? { code: e.code, message: e.message, hint: e.hint }
    : { code: e.code, message: e.message };
}

/** A process's memory as the tree under it holds it; pm2's root number without /proc stats. */
function procMemory(p: Pm2Process, probe: HostProbe): number {
  if (p.pid <= 0) return p.memory;
  const set = descendants(probe.data.tree, p.pid);
  set.add(p.pid);
  return (
    treeMetrics(set, probe.data.stats, probe.data.listeners)?.memory ?? p.memory
  );
}

const ERRORED = (s: string) => s === 'errored' || s.startsWith('failed');
const STOPPED = (s: string) => s === 'stopped' || s === 'done';

/** The counts of a stack by status word (pm2's own, or the one-shot words of statusWord). */
function counts(statuses: string[], queued: number): StackApps {
  return {
    total: statuses.length,
    online: statuses.filter((s) => s === 'online').length,
    errored: statuses.filter(ERRORED).length,
    stopped: statuses.filter(STOPPED).length,
    queued,
  };
}

/**
 * A stack's totals from its app rows: what runs, what waits in the queue (a starting lease has left it), the memory and
 * cpu of what is online, its ports.
 */
function summary(rows: LsRow[]) {
  const online = rows.filter((r) => r.status === 'online');
  const queued = rows.flatMap((r) =>
    r.lease?.state === 'pending' ? [r.lease.position] : []
  );
  const cpus = online.flatMap((r) => (r.cpu === null ? [] : [r.cpu]));
  return {
    apps: counts(
      rows.map((r) => r.status),
      queued.length
    ),
    queue_position: queued.length ? Math.min(...queued) : null,
    memory: online.reduce((a, r) => a + r.memory, 0),
    cpu: cpus.length ? cpus.reduce((a, b) => a + b, 0) : null,
    ports: online.flatMap((r) =>
      [...new Set(r.ports.actual.map((l) => l.port))]
        .sort((a, b) => a - b)
        .map((port) => ({ app: r.app, port }))
    ),
    present: rows.some((r) => r.pm_id !== null || r.lease !== undefined),
  };
}

/**
 * One stack per checkout, read from what its endpoints answered, and the namespaces no checkout claims on an endpoint
 * (the lease watcher's aside) as orphans. Pure but for the leases deriveSnapshot reads on this machine.
 */
export async function buildStacks(
  projects: ProjectInput[],
  reads: Map<string, EndpointRead>,
  opts: {
    all: boolean;
    hereCheck: HereCheck;
    prev?: Prev;
    orphanNotes?: Map<string, string>;
  }
): Promise<{ stacks: StackView[]; orphans: Orphan[] }> {
  // who claims a namespace on an endpoint: every checkout whose apps run there under that slug
  const claims = new Map<string, ProjectInput[]>();
  for (const p of projects)
    for (const key of new Set(Object.values(p.endpoints))) {
      const k = claimKey(key, p.project);
      claims.set(k, [...(claims.get(k) ?? []), p]);
    }
  const stacks: StackView[] = [];
  for (const p of projects) stacks.push(await stackOf(p, reads, claims, opts));
  const orphans: Orphan[] = [];
  for (const r of reads.values()) {
    const probe = r.probe;
    if (!probe) continue;
    const byNs = new Map<string, Pm2Process[]>();
    for (const pr of probe.procs)
      byNs.set(pr.namespace, [...(byNs.get(pr.namespace) ?? []), pr]);
    for (const [ns, procs] of byNs) {
      if (ns === WATCHER_NS || claims.has(claimKey(r.key, ns))) continue;
      orphans.push({
        namespace: ns,
        endpoint: r.label,
        processes: procs.map((pr) => ({
          name: pr.name,
          status: pr.status,
          memory: procMemory(pr, probe),
        })),
        note: opts.orphanNotes?.get(claimKey(r.key, ns)) ?? null,
      });
    }
  }
  orphans.sort(
    (a, b) =>
      a.endpoint.localeCompare(b.endpoint) ||
      a.namespace.localeCompare(b.namespace)
  );
  return { stacks, orphans };
}

async function stackOf(
  p: ProjectInput,
  reads: Map<string, EndpointRead>,
  claims: Map<string, ProjectInput[]>,
  opts: { hereCheck: HereCheck; prev?: Prev }
): Promise<StackView> {
  const hosts = Object.entries(p.endpoints).map(([name, key]) => {
    const r = reads.get(key);
    return {
      name,
      endpoint: r?.label ?? key,
      reachable: Boolean(r?.probe) && !r?.error,
      error: r?.error ?? null,
      age_s: r?.age_s ?? 0,
    };
  });
  const claimantsOn = (key: string) =>
    claims.get(claimKey(key, p.project)) ?? [];
  const shared = Math.max(
    0,
    ...Object.values(p.endpoints).map((k) => claimantsOn(k).length)
  );
  const notes = shared > 1 ? [`slug shared by ${shared} checkouts`] : [];

  // no rows to read (the manifest did not load, or reading with it failed): its namespace on the local daemon says what runs
  const fromNamespace = (error: StackError | null): StackView => {
    const key = p.endpoints.local;
    const probe = key ? reads.get(key)?.probe : undefined;
    const procs = probe ? ownProcs(p, key, probe.procs, claimantsOn(key)) : [];
    return {
      ...identity(p),
      hosts,
      apps: counts(
        procs.map((x) => x.status),
        0
      ),
      queue_position: null,
      memory: probe ? procs.reduce((a, x) => a + procMemory(x, probe), 0) : 0,
      cpu: null,
      ports: [],
      manifest_error: error,
      notes,
      present: procs.length > 0,
      rows: [],
    };
  };
  if (!p.manifest) return fromNamespace(p.error);
  let rows: LsRow[];
  try {
    rows = await manifestRows(p, p.manifest, reads, claimantsOn, opts);
  } catch (e) {
    // one checkout's bad input fails its own stack, never the whole answer
    return fromNamespace(stackError(e));
  }
  return {
    ...identity(p),
    hosts,
    ...summary(rows),
    manifest_error: null,
    notes,
    rows,
  };
}

/** A checkout's app rows, each read with its manifest from what the endpoint of its host answered. */
async function manifestRows(
  p: ProjectInput,
  m: Manifest,
  reads: Map<string, EndpointRead>,
  claimantsOn: (key: string) => ProjectInput[],
  opts: { hereCheck: HereCheck; prev?: Prev }
): Promise<LsRow[]> {
  const byApp = new Map<string, LsRow>();
  for (const g of new Fleet(m, undefined).groups(Object.keys(m.apps))) {
    const key = p.endpoints[g.host];
    const r = key ? reads.get(key) : undefined;
    let rows: LsRow[];
    if (!r?.probe) {
      rows = g.apps.map((a) =>
        unreachableRow(m.apps[a], g.host, r?.error ?? 'not probed yet')
      );
    } else {
      const claimants = claimantsOn(key);
      const probe: HostProbe =
        claimants.length < 2
          ? r.probe
          : {
              ...r.probe,
              procs: [
                ...r.probe.procs.filter((pr) => pr.namespace !== p.project),
                ...ownProcs(p, key, r.probe.procs, claimants),
              ],
            };
      const view = {
        manifest: scopeManifest(m, g.host, 'local'),
        host: pickHost(m, g.host),
        hereCheck: opts.hereCheck,
      };
      const snap = await deriveSnapshot(view, probe, {
        urls: 'none',
        prev: opts.prev?.get(key),
      });
      rows = rowsFor(view, snap, g.apps);
    }
    for (const row of rows) byApp.set(row.app, row);
  }
  // the manifest's order, as ls shows it, whichever host each app runs on
  return Object.keys(m.apps).map((a) => byApp.get(a)!);
}

function identity(p: ProjectInput) {
  return {
    project: p.project,
    root: p.root,
    base_project: p.manifest?.base_project ?? p.project,
    slot: p.slot,
    branch: p.branch,
    source: p.source,
  };
}

/** Running stacks first, then by name; a worktree right under its base, by slot; stacks with nothing in pm2 only with `all`. */
export function orderStacks(stacks: StackView[], all: boolean): StackView[] {
  const shown = stacks.filter((s) => all || s.present);
  const names = new Set(shown.map((s) => s.project));
  const child = (s: StackView) =>
    s.base_project !== s.project && names.has(s.base_project);
  const bases = shown
    .filter((s) => !child(s))
    .sort(
      (a, b) =>
        Number(b.apps.online > 0) - Number(a.apps.online > 0) ||
        a.project.localeCompare(b.project)
    );
  // checkouts sharing a slug are each a base: the worktrees go under the first of them only
  const placed = new Set<string>();
  return bases.flatMap((b) => {
    if (placed.has(b.project)) return [b];
    placed.add(b.project);
    return [
      b,
      ...shown
        .filter((s) => child(s) && s.base_project === b.project)
        .sort((x, y) => (x.slot ?? 0) - (y.slot ?? 0)),
    ];
  });
}

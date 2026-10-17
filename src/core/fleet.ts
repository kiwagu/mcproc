import { McprocError, describeError } from './errors.js';
import type { Dep, Manifest } from './manifest.js';
import { assertApp, connect, pickHost, type Context } from './resolve.js';
import {
  deleteApps,
  orderWithDeps,
  resolveTargets,
  restartApps,
  startApps,
  stopApps,
  type WaitRecord,
} from './actions.js';
import { waitDependency } from './wait.js';
import {
  depView,
  describeApp,
  queuedRow,
  rowsFor,
  snapshot,
  unreachableRow,
  type LsRow,
  type Snapshot,
  type SnapshotOptions,
} from './list.js';
import {
  cancelBefore,
  defaultGateDeps,
  finishLeasedStart,
  freeAfter,
  freeOnFailure,
  gateStart,
  liveLeasesOf,
  type GateDeps,
} from './leases/gate.js';
import type { Lease } from './leases/store.js';
import type { Spawner } from '../transport/types.js';
import type { HereCheck } from './urlcheck.js';

/** Opens a context for `host`; `fallback` is where the unbound apps run for this command (see connect). */
export type Connector = (
  m: Manifest,
  host: string,
  fallback: string
) => Promise<Context>;
export interface HostApps {
  host: string;
  apps: string[];
}

export const defaultConnector =
  (spawner?: Spawner, hereCheck?: HereCheck): Connector =>
  (m, host, fallback) =>
    connect(
      { manifest: m, host: pickHost(m, host) },
      { spawner, fallback, hereCheck }
    );

/**
 * The hosts one command acts on. An app with `host:` always runs there; an app without one runs on the host the command
 * names (--host), or on local when it names none. Without --host a command reaches every app at its own host; with
 * --host X it reaches only the apps that run on X.
 */
export class Fleet {
  /** where the unbound apps run for this command */
  readonly fallback: string;
  private readonly ctxs = new Map<string, Promise<Context>>();

  constructor(
    readonly manifest: Manifest,
    readonly requested: string | undefined,
    private readonly connector: Connector = defaultConnector()
  ) {
    if (requested !== undefined) pickHost(manifest, requested); // UNKNOWN_HOST before anything runs
    this.fallback = requested ?? 'local';
  }

  hostOf(app: string): string {
    return this.manifest.apps[app].host ?? this.fallback;
  }

  /** The host of one app named by the caller (describe, logs): a profile is not an app; an app elsewhere than --host is refused. */
  one(app: string): string {
    assertApp(this.manifest, app);
    this.select([app]);
    return this.hostOf(app);
  }

  /** Apps, profiles or "all" to app names, each once. With --host, names that run elsewhere are refused or left out. */
  select(targets: string[]): string[] {
    const out = new Set<string>();
    for (const t of targets) {
      const names = resolveTargets(this.manifest, t);
      const here =
        this.requested === undefined
          ? names
          : names.filter((n) => this.hostOf(n) === this.requested);
      const byName = t !== 'all' && !Object.hasOwn(this.manifest.profiles, t);
      if (byName && here.length === 0) {
        throw new McprocError(
          'WRONG_HOST',
          `"${t}" runs on host ${this.hostOf(t)}, not on ${this.requested} (apps.${t}.host in ${this.manifest.path})`,
          {
            hint: `Drop --host to reach every app at its own host, or use --host ${this.hostOf(t)}.`,
          }
        );
      }
      if (names.length > 0 && here.length === 0) {
        throw new McprocError(
          'WRONG_HOST',
          `no app of "${t}" runs on host ${this.requested}`,
          {
            hint: `Its apps run on ${[...new Set(names.map((n) => this.hostOf(n)))].join(', ')}; drop --host to reach each at its own host.`,
          }
        );
      }
      for (const n of here) out.add(n);
    }
    return [...out];
  }

  /** One group per host, each app in it, hosts in first-appearance order: for reads, which may run in parallel. */
  groups(names: string[]): HostApps[] {
    const by = new Map<string, string[]>();
    for (const n of names) {
      const h = this.hostOf(n);
      by.set(h, [...(by.get(h) ?? []), n]);
    }
    return [...by].map(([host, apps]) => ({ host, apps }));
  }

  /** Consecutive apps of one host form one run, the given order kept: for changes, where dependency order matters. */
  runs(names: string[]): HostApps[] {
    const out: HostApps[] = [];
    for (const n of names) {
      const h = this.hostOf(n);
      const last = out.at(-1);
      if (last?.host === h) last.apps.push(n);
      else out.push({ host: h, apps: [n] });
    }
    return out;
  }

  /** The hosts that a whole-project command reaches. */
  hosts(): string[] {
    return this.groups(this.select(['all'])).map((g) => g.host);
  }

  /** One context per host for the life of the command; a failed connect is not kept, so the next call retries. */
  ctx(host: string): Promise<Context> {
    let p = this.ctxs.get(host);
    if (!p) {
      p = this.connector(this.manifest, host, this.fallback);
      this.ctxs.set(host, p);
      p.catch(() => {
        if (this.ctxs.get(host) === p) this.ctxs.delete(host);
      });
    }
    return p;
  }
}

export type Act = 'start' | 'restart' | 'stop' | 'delete';

/**
 * Refuse before any host is touched when one of the runs lands on a readonly host. `named` are the apps the caller asked
 * for: an app on that host that was only pulled in as a dependency is named as such, with the way to leave it out.
 */
export function assertWritableRuns(
  fleet: Fleet,
  runs: HostApps[],
  named?: string[]
): void {
  for (const r of runs) {
    const host = pickHost(fleet.manifest, r.host);
    if (!host.readonly) continue;
    const apps = [
      ...new Set(runs.filter((x) => x.host === r.host).flatMap((x) => x.apps)),
    ];
    const askers = (dep: string) =>
      (named ?? []).filter(
        (n) => n !== dep && dependsOn(fleet.manifest, n, dep)
      );
    const label = (a: string) =>
      named && !named.includes(a) && askers(a).length
        ? `"${a}" (a dependency of ${askers(a)
            .map((n) => `"${n}"`)
            .join(', ')})`
        : `"${a}"`;
    const viaDeps =
      named !== undefined && apps.every((a) => !named.includes(a));
    const askHosts = [
      ...new Set(
        (named ?? []).map((n) => fleet.hostOf(n)).filter((h) => h !== r.host)
      ),
    ];
    throw new McprocError(
      'READONLY_HOST',
      `Host "${host.name}" is readonly: no start/stop/restart/delete/flush/init there, and ${apps.map(label).join(', ')} ${apps.length > 1 ? 'run' : 'runs'} there; nothing was changed`,
      {
        hint:
          viaDeps && askHosts.length === 1
            ? `Start with --host ${askHosts[0]} to leave dependencies on other hosts alone.`
            : 'Name the apps, or a profile, that leave those out. Read-only tools (ls, describe, logs, ports, doctor) still work there.',
      }
    );
  }
}

/**
 * Refuse a start before any host is touched when one of its runs lands on a remote host with an app that declares
 * memory: the lease queue works on the local host only in this version.
 */
function assertLocalBudgets(fleet: Fleet, runs: HostApps[]): void {
  for (const r of runs) {
    if (pickHost(fleet.manifest, r.host).local) continue;
    const budgeted = r.apps.filter(
      (a) => fleet.manifest.apps[a].memory_mib !== null
    );
    if (budgeted.length === 0) continue;
    throw new McprocError(
      'LEASE_UNSUPPORTED_HOST',
      `${budgeted.join(', ')} declare memory but run on host ${r.host}; the lease queue works on the local host only in this version`,
      { hint: 'Drop memory: from apps bound to remote hosts.' }
    );
  }
}

function dependsOn(
  m: Manifest,
  app: string,
  dep: string,
  seen = new Set<string>()
): boolean {
  for (const d of m.apps[app]?.depends_on ?? []) {
    if (d.app === dep) return true;
    if (!seen.has(d.app)) {
      seen.add(d.app);
      if (dependsOn(m, d.app, dep, seen)) return true;
    }
  }
  return false;
}

/** A host that could not be reached, or a change it refused: the apps of that run get rows saying so. */
function failedRows(fleet: Fleet, r: HostApps, e: unknown): LsRow[] {
  const code = (e as { code?: string }).code;
  const status =
    code === 'TRANSPORT_FAILED' || code === 'TIMEOUT'
      ? 'unreachable'
      : 'failed';
  return r.apps.map((a) =>
    unreachableRow(fleet.manifest.apps[a], r.host, describeError(e), status)
  );
}

/**
 * start/restart/stop/delete of a target across hosts. start adds the dependencies first (with --host only those that
 * run on that host); the apps are then cut into runs of one host each and acted on run by run, in that order. A run that
 * fails leaves rows saying so and the other runs go on — except for start, where the later runs are skipped (they may
 * need what did not start). When nothing happened at all, the first error is thrown. A start that would run an app
 * declaring memory on a remote host is refused before any host is touched; a local start of such apps goes through the
 * lease gate first (a queued run answers queued rows for the apps the gate counted, the real rows of the others, and
 * holds back the dependents of the queued ones in later runs), and a start the watcher admitted ends its lease once,
 * over every local row. A local stop or delete first cancels the checkout's queued and starting leases it overlaps
 * (ending a starting one's child), then acts, then frees the running leases that no longer hold anything.
 */
export async function actOn(
  fleet: Fleet,
  target: string,
  act: Act,
  opts: {
    reload?: boolean;
    waits?: WaitRecord[];
    /** ends the dependency waits of a start as `aborted`: the caller's request was cancelled */
    signal?: AbortSignal;
    /** a note kept on the lease (what this start is for) */
    note?: string | null;
    /** the id of a lease the watcher admitted: the start skips the queue and ends the lease as running or failed */
    lease?: string | null;
    /** the lease machinery (tests pass fakes); default the host state directory */
    gate?: GateDeps;
  } = {}
): Promise<LsRow[]> {
  const named = fleet.select([target]);
  const names =
    act === 'start'
      ? orderWithDeps(fleet.manifest, named).filter(
          (n) =>
            fleet.requested === undefined || fleet.hostOf(n) === fleet.requested
        )
      : named;
  const runs = fleet.runs(names);
  assertWritableRuns(fleet, runs, named);
  if (act === 'start') assertLocalBudgets(fleet, runs);
  const rows: LsRow[] = [];
  let failed: { host: string; error: unknown } | null = null;
  let done = 0;
  const notStarted = new Map<string, string>(); // app -> why it did not start; one map for every run
  /** every dependency of an app from the full manifest; with --host X the ones that run elsewhere are left out (neither started nor waited for) */
  const depsOf = (n: string): Dep[] =>
    fleet.manifest.apps[n].depends_on.filter(
      (d) =>
        fleet.requested === undefined || fleet.hostOf(d.app) === fleet.requested
    );
  /** a dependency is observed on the host it runs on, whatever run the dependent is in */
  const waitDep = async (d: Dep) =>
    waitDependency(await fleet.ctx(fleet.hostOf(d.app)), d, {
      signal: opts.signal,
    });
  const gate = opts.gate ?? defaultGateDeps();
  for (const r of runs) {
    if (failed && act === 'start') {
      rows.push(
        ...r.apps.map((a) =>
          unreachableRow(
            fleet.manifest.apps[a],
            r.host,
            `skipped: the start on ${failed!.host} before it failed`,
            'skipped'
          )
        )
      );
      continue;
    }
    try {
      const ctx = await fleet.ctx(r.host);
      let admitted: Lease | null = null;
      // only a run with an app that declares memory asks pm2 what runs already: the others never touch the queue
      const budgeted = r.apps.some(
        (a) => fleet.manifest.apps[a].memory_mib !== null
      );
      if (act === 'start' && ctx.host.local && !opts.lease && budgeted) {
        const g = await gateStart(
          ctx,
          r.apps,
          {
            target,
            reload: opts.reload,
            note: opts.note,
            procs: await ctx.pm2.jlist(),
          },
          gate
        );
        if (g.kind === 'queued') {
          // only the apps the gate counted wait: what needs them in a later run (another host) is skipped, not
          // started without them; an app that was online already answers as it is
          const queued = new Set(
            g.lease.apps.filter((a) => r.apps.includes(a))
          );
          for (const a of queued)
            notStarted.set(a, `queued: lease ${g.lease.id}`);
          const up = r.apps.filter((a) => !queued.has(a));
          const real = new Map(
            (up.length
              ? rowsFor(ctx, await snapshot(ctx, { urls: up }), up)
              : []
            ).map((x) => [x.app, x])
          );
          rows.push(
            ...r.apps.map(
              (a) =>
                real.get(a) ??
                queuedRow(fleet.manifest.apps[a], r.host, g.lease, g.position)
            )
          );
          done++;
          continue;
        }
        admitted = g.lease;
      }
      // a stop must not race a start it overlaps: the queued and starting leases go first, their children with them
      if ((act === 'stop' || act === 'delete') && ctx.host.local)
        await cancelBefore(gate.store, ctx, r.apps);
      let runRows: LsRow[];
      try {
        runRows = await (act === 'start'
          ? startApps(ctx, r.apps, {
              reload: opts.reload,
              waitDep,
              depsOf,
              waits: opts.waits,
              failed: notStarted,
              signal: opts.signal,
            })
          : act === 'restart'
            ? restartApps(ctx, r.apps)
            : act === 'stop'
              ? stopApps(ctx, r.apps)
              : deleteApps(ctx, r.apps));
      } catch (e) {
        if (admitted) await freeOnFailure(gate.store, admitted, e);
        throw e;
      }
      // a checkout with no live lease skips pm2's list and the lock
      if (
        (act === 'stop' || act === 'delete') &&
        ctx.host.local &&
        liveLeasesOf(gate.store, ctx).length > 0
      )
        await freeAfter(gate.store, ctx, await ctx.pm2.jlist());
      rows.push(...runRows);
      done++;
    } catch (e) {
      failed ??= { host: r.host, error: e };
      rows.push(...failedRows(fleet, r, e));
    }
  }
  if (failed && done === 0) throw failed.error;
  // the watcher's start ends its lease once, over every local row (two local runs around a remote one included)
  const local = rows.filter((r) => pickHost(fleet.manifest, r.host).local);
  if (act === 'start' && opts.lease && local.length > 0)
    await finishLeasedStart(gate.store, opts.lease, local);
  return rows;
}

export interface HostProbe extends HostApps {
  ctx?: Context;
  snap?: Snapshot;
  error?: unknown;
}
export interface HostError {
  host: string;
  apps: string[];
  message: string;
}

/** One probe per host, all hosts in parallel; a host that fails carries its error instead of a snapshot. */
export function probeFleet(
  fleet: Fleet,
  names: string[],
  take: (ctx: Context) => Promise<Snapshot>
): Promise<HostProbe[]> {
  return Promise.all(
    fleet.groups(names).map(async (g): Promise<HostProbe> => {
      try {
        const ctx = await fleet.ctx(g.host);
        return { ...g, ctx, snap: await take(ctx) };
      } catch (e) {
        return { ...g, error: e };
      }
    })
  );
}

/**
 * Rows of the named apps in their order, each from its own host. A host that does not answer leaves unreachable rows,
 * unless none answers. Only the named apps' urls are asked, unless `opts.urls` says otherwise.
 */
export async function listFleet(
  fleet: Fleet,
  names: string[],
  opts: SnapshotOptions = {}
): Promise<{ rows: LsRow[]; errors: HostError[]; probes: HostProbe[] }> {
  const probes = await probeFleet(fleet, names, (ctx) =>
    snapshot(ctx, { urls: names, ...opts })
  );
  const failed = probes.filter((p) => p.error !== undefined);
  if (failed.length === probes.length && failed.length > 0)
    throw failed[0].error;
  const byApp = new Map<string, LsRow>();
  for (const p of probes) {
    const rows = p.snap
      ? rowsFor(p.ctx!, p.snap, p.apps)
      : p.apps.map((a) =>
          unreachableRow(fleet.manifest.apps[a], p.host, describeError(p.error))
        );
    for (const r of rows) byApp.set(r.app, r);
  }
  return {
    rows: names.map((n) => byApp.get(n)!),
    errors: failed.map((p) => ({
      host: p.host,
      apps: p.apps,
      message: describeError(p.error),
    })),
    probes,
  };
}

/**
 * One app in detail, read on its host. The manifest entry is the full one (the host's view drops dependencies that run
 * elsewhere), with its dependencies in the shape the project summary uses.
 */
export async function describeFleetApp(fleet: Fleet, app: string) {
  const host = fleet.one(app);
  const d = await describeApp(await fleet.ctx(host), app);
  const full = fleet.manifest.apps[app];
  return {
    ...d,
    app: { ...full, depends_on: full.depends_on.map(depView) },
    host,
  };
}

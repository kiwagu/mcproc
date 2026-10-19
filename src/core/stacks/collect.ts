import os from 'node:os';
import { describeError } from '../errors.js';
import {
  findManifestPath,
  loadManifest,
  type Host,
  type Manifest,
} from '../manifest.js';
import { probeHost, type HostProbe, type ProbeAsk } from '../list.js';
import {
  bareLocalHost,
  connectHost,
  pickHost,
  type HostLink,
} from '../resolve.js';
import { forgetProject, listProjects, recordProject } from '../registry.js';
import { readRegistry, realOf, registryPath } from '../slots.js';
import { LeaseStore } from '../leases/store.js';
import { WATCHER_NAME, WATCHER_NS } from '../leases/ensure.js';
import { Fleet } from '../fleet.js';
import { stateDir } from '../state.js';
import { checkHere, type HereCheck } from '../urlcheck.js';
import type { StatSample } from '../stats.js';
import type { Spawner } from '../../transport/types.js';
import {
  buildStacks,
  claimKey,
  endpointKey,
  endpointLabel,
  orderStacks,
  stackError,
} from './discover.js';
import type {
  EndpointRead,
  ProjectInput,
  StacksAnswer,
  StackView,
} from './types.js';

/** A remote endpoint is probed at most this often; the local daemon on every refresh. */
export const REMOTE_EVERY_MS = 10_000;
/** A remote endpoint whose probe failed is tried again only after this long. */
export const RETRY_MS = 30_000;
/** The host registry is read again every this many refreshes. */
export const REGISTRY_EVERY = 10;
/** The light probe of a polling loop: no inline cpu sample, no url, no docker. */
const ASK: ProbeAsk = {
  cpuSample: false,
  metrics: true,
  urls: [],
  containers: [],
};
/** An endpoint's first probe: with no earlier sample to diff against, it takes the inline pair so its cpu shows at once. */
const FIRST_ASK: ProbeAsk = { ...ASK, cpuSample: true };

export interface CollectorDeps {
  stateDir: string;
  now: () => number;
  connectHost: (host: Host) => Promise<HostLink>;
  probeHost: (link: HostLink, ask: ProbeAsk) => Promise<HostProbe>;
  loadManifest: (root: string) => Manifest;
  findManifest: (dir: string) => { root: string; path: string } | null;
  hostname: () => string;
  hereCheck: HereCheck;
}
export function defaultCollectorDeps(spawner?: Spawner): CollectorDeps {
  return {
    stateDir: stateDir(),
    now: Date.now,
    connectHost: (host) => connectHost(host, { spawner }),
    probeHost,
    loadManifest,
    findManifest: findManifestPath,
    hostname: os.hostname,
    hereCheck: checkHere,
  };
}
export interface StacksView {
  answer: StacksAnswer;
  stacks: StackView[];
  /** the loaded manifest of each stack, by root: the drill-in and the stop act through them */
  manifests: Map<string, Manifest>;
}

type Sample = { sample: StatSample; at: number };
/** The last answer of one endpoint, kept between refreshes. */
interface Cached {
  /** the last probe that succeeded; null when none has */
  probe: HostProbe | null;
  /** the sample of the probe before `probe`: its cpu is the difference of the two */
  prev: Sample | undefined;
  error: string | null;
  /** when `probe` was taken, by the collector's clock */
  at: number;
  /** when the endpoint is due again */
  next: number;
}

/** What the walk up from a cwd found: a checkout to adopt, or the note an orphan carries (null: none). */
type Walk = { manifest: Manifest } | { note: string | null };

const short = (e: unknown) => describeError(e).split('\n')[0].slice(0, 120);

/** The stacks of this host, refresh after refresh: one probe per endpoint, remote ones at their own pace. */
export class StacksCollector {
  private known: ProjectInput[] = [];
  private refreshes = 0;
  private registryError: string | null = null;
  private readonly local = bareLocalHost();
  private readonly localKey = endpointKey(this.local);
  /** the host each endpoint is reached through: the first checkout naming it gives it; local's is the bare one */
  private hosts = new Map<string, Host>();
  /** the real roots of the checkouts this collector found on the daemon: they stay daemon-found for its life */
  private readonly adopted = new Set<string>();
  /** the walks that made no stack, by namespace and cwd, with the note each leaves; cleared with each registry read */
  private readonly misses = new Map<string, string | null>();
  private readonly links = new Map<string, Promise<HostLink>>();
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly deps: CollectorDeps = defaultCollectorDeps()) {}

  async collect(opts: { all: boolean }): Promise<StacksView> {
    if (this.refreshes % REGISTRY_EVERY === 0) this.known = this.readKnown();
    this.refreshes++;
    const reads = new Map<string, EndpointRead>();
    await this.readAll(reads);
    const notes = this.adopt(reads.get(this.localKey));
    await this.readAll(reads); // the endpoints of a checkout adopted just now
    const prev = new Map<string, Sample>();
    for (const key of reads.keys()) {
      const p = this.cache.get(key)?.prev;
      if (p) prev.set(key, p);
    }
    const built = await buildStacks(this.known, reads, {
      all: opts.all,
      hereCheck: this.deps.hereCheck,
      prev,
      orphanNotes: notes,
    });
    const stacks = orderStacks(built.stacks, opts.all);
    const localRead = reads.get(this.localKey);
    const watcher = localRead?.probe?.procs.find(
      (p) => p.name === WATCHER_NAME && p.namespace === WATCHER_NS
    );
    const mem = localRead?.probe?.data.memory ?? null;
    let queue = 0;
    try {
      queue = new LeaseStore(this.deps.stateDir)
        .list()
        .filter((l) => l.state === 'pending').length;
    } catch {
      // an unreadable lease directory counts no queue
    }
    const answer: StacksAnswer = {
      host: {
        name: this.deps.hostname(),
        memory: mem
          ? { available_mib: mem.available_mib, total_mib: mem.total_mib }
          : null,
        watcher: watcher
          ? {
              online: watcher.status === 'online',
              pid: watcher.pid > 0 ? watcher.pid : null,
            }
          : null,
        queue,
        notes: [
          this.registryError
            ? `registry unreadable: ${this.registryError}`
            : '',
          localRead?.error ? `local pm2: ${localRead.error}` : '',
        ].filter(Boolean),
      },
      stacks: stacks.map(({ rows: _rows, rivals: _rivals, ...s }) => s),
      orphans: built.orphans,
    };
    const manifests = new Map(
      this.known.flatMap((p) =>
        p.manifest ? [[p.root, p.manifest] as const] : []
      )
    );
    return { answer, stacks, manifests };
  }

  /** Reads every endpoint the known checkouts need, and the local daemon: those not read yet this refresh. */
  private async readAll(reads: Map<string, EndpointRead>): Promise<void> {
    const keys = new Set([
      this.localKey,
      ...this.known.flatMap((p) => Object.values(p.endpoints)),
    ]);
    await Promise.all(
      [...keys]
        .filter((key) => !reads.has(key))
        .map(async (key) => {
          const host = this.hosts.get(key);
          if (host) reads.set(key, await this.read(key, host));
        })
    );
  }

  /** One endpoint's answer: a fresh probe when it is due, else (or when the probe fails) the last data with its age. */
  private async read(key: string, host: Host): Promise<EndpointRead> {
    const now = this.deps.now();
    const c = this.cache.get(key);
    const answer = (e: Cached): EndpointRead => ({
      key,
      label: endpointLabel(host),
      probe: e.probe,
      error: e.error,
      age_s: e.probe ? Math.round((now - e.at) / 1000) : 0,
    });
    if (c && now < c.next) return answer(c);
    let entry: Cached;
    try {
      let link = this.links.get(key);
      if (!link) {
        link = this.deps.connectHost(host);
        this.links.set(key, link);
      }
      const last = c?.probe;
      const probe = await this.deps.probeHost(
        await link,
        last ? ASK : FIRST_ASK
      );
      // the next refresh diffs against the latest sample: the second of an inline pair
      const sample = last?.data.stats.samples.at(-1);
      entry = {
        probe,
        prev: last && sample ? { sample, at: last.sampledAt } : undefined,
        error: null,
        at: now,
        next: host.local ? now : now + REMOTE_EVERY_MS,
      };
    } catch (e) {
      this.links.delete(key); // a failed connect or probe connects afresh next time
      entry = {
        probe: c?.probe ?? null,
        prev: c?.prev,
        error: short(e),
        at: c?.at ?? now,
        next: host.local ? now : now + RETRY_MS,
      };
    }
    this.cache.set(key, entry);
    return answer(entry);
  }

  /** The checkouts the registry records, one per real root; an entry whose project changed follows its manifest. */
  private readKnown(): ProjectInput[] {
    const { entries, error } = listProjects(this.deps.stateDir);
    this.registryError = error;
    this.hosts = new Map([[this.localKey, this.local]]);
    this.misses.clear();
    const byRoot = new Map<string, ProjectInput>();
    for (const e of entries) {
      const source = this.adopted.has(realOf(e.root)) ? 'daemon' : 'registry';
      let m: Manifest;
      try {
        m = this.deps.loadManifest(e.root);
      } catch (err) {
        byRoot.set(realOf(e.root), this.broken(e.project, e.root, source, err));
        continue;
      }
      if (m.project !== e.project) {
        forgetProject(e.project, e.root, this.deps.stateDir);
        recordProject(m, this.deps.stateDir);
      }
      byRoot.set(realOf(m.root), this.inputOf(m, source));
    }
    return [...byRoot.values()];
  }

  /** A checkout without a usable manifest: its error, and its namespace on the local daemon for what runs. */
  private broken(
    project: string,
    root: string,
    source: ProjectInput['source'],
    e: unknown
  ): ProjectInput {
    return {
      project,
      root,
      source,
      manifest: null,
      error: stackError(e),
      endpoints: { local: this.localKey },
      slot: null,
      branch: null,
    };
  }

  /** A loaded checkout with its hosts' endpoints and its slot; one whose endpoints cannot be built carries the error. */
  private inputOf(m: Manifest, source: ProjectInput['source']): ProjectInput {
    const endpoints: Record<string, string> = {};
    const hosts = new Map<string, Host>();
    try {
      for (const g of new Fleet(m, undefined).groups(Object.keys(m.apps))) {
        const host = pickHost(m, g.host);
        endpoints[g.host] = endpointKey(host);
        hosts.set(endpoints[g.host], host);
      }
    } catch (e) {
      return this.broken(m.project, m.root, source, e);
    }
    for (const [key, host] of hosts)
      if (!this.hosts.has(key)) this.hosts.set(key, host);
    let slot = m.slot;
    let branch: string | null = null;
    try {
      const reg = readRegistry(
        registryPath(this.deps.stateDir, m.base_project, m.repo)
      );
      const hit =
        reg &&
        Object.entries(reg.slots).find(
          ([, s]) => realOf(s.path) === realOf(m.root)
        );
      if (hit) {
        slot = Number(hit[0]);
        branch = hit[1].branch;
      }
    } catch {
      // an unreadable slot registry leaves the manifest's slot
    }
    return {
      project: m.project,
      root: m.root,
      source,
      manifest: m,
      error: null,
      endpoints,
      slot,
      branch,
    };
  }

  /**
   * The local daemon's namespaces no known checkout claims: a manifest above a process's cwd that names the namespace
   * makes it a stack, recorded from then on. One that names another project, or does not load, leaves a note on the
   * orphan; a checkout known already (its apps run elsewhere) is never a second stack. A walk that made no stack is
   * kept with its note until the registry is read again: a refresh does not parse the same manifest twice.
   */
  private adopt(read: EndpointRead | undefined): Map<string, string> {
    const notes = new Map<string, string>();
    if (!read?.probe) return notes;
    const claimed = new Set(
      this.known
        .filter((p) => Object.values(p.endpoints).includes(this.localKey))
        .map((p) => p.project)
    );
    const roots = new Set(this.known.map((p) => realOf(p.root)));
    const cwds = new Map<string, Set<string>>();
    for (const p of read.probe.procs)
      if (p.cwd && p.namespace !== WATCHER_NS && !claimed.has(p.namespace))
        cwds.set(p.namespace, (cwds.get(p.namespace) ?? new Set()).add(p.cwd));
    for (const [ns, dirs] of cwds) {
      const note = claimKey(this.localKey, ns);
      for (const cwd of dirs) {
        const missed = `${ns}\0${cwd}`;
        const r: Walk = this.misses.has(missed)
          ? { note: this.misses.get(missed) ?? null }
          : this.walk(ns, cwd, roots);
        if ('manifest' in r) {
          const real = realOf(r.manifest.root);
          recordProject(r.manifest, this.deps.stateDir);
          this.adopted.add(real);
          roots.add(real);
          this.known.push(this.inputOf(r.manifest, 'daemon'));
          notes.delete(note);
          break;
        }
        this.misses.set(missed, r.note);
        if (r.note !== null) notes.set(note, r.note);
      }
    }
    return notes;
  }

  /** The walk up from one cwd of namespace `ns`: the manifest that makes it a stack, or the note it leaves (null: none). */
  private walk(ns: string, cwd: string, roots: Set<string>): Walk {
    const found = this.deps.findManifest(cwd);
    if (!found) return { note: null };
    let m: Manifest;
    try {
      m = this.deps.loadManifest(found.root);
    } catch (e) {
      return { note: `manifest at ${found.path}: ${stackError(e).code}` };
    }
    if (m.project !== ns)
      return { note: `manifest at ${found.path} names ${m.project}` };
    if (roots.has(realOf(m.root))) return { note: null };
    return { manifest: m };
  }
}

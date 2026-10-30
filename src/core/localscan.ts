import type { HostProbe, ListenCheck, ProbeAsk } from './list.js';
import {
  parseProbe,
  parseUrlProbe,
  type Listener,
  type ProbeData,
} from './ports.js';
import { zoneOf, type ProcReader, type ProcSweep } from './procfs.js';
import { scriptNotRun, type HostLink } from './resolve.js';
import { EMPTY_STATS, type ProcStats } from './stats.js';
import {
  MARK,
  dockerScript,
  probeTimeoutMs,
  urlSection,
} from '../shell/snippets.js';
import { ensureOk } from '../transport/index.js';
import type { ExecResult } from '../transport/types.js';

/** A link to this machine whose processes are read in-process. */
export type LocalLink = HostLink & { proc: ProcReader };

/** Whether a link's processes are read in-process: this machine, with a reader. */
export const inProcess = (link: HostLink): link is LocalLink =>
  Boolean(link.proc) && link.host.local;

/** The docker-published ports are read again at most this often while a declared port's listener has no pid. */
export const DOCKER_EVERY_MS = 30_000;
/** The gap between the two sweeps of an inline CPU reading, as the script's `sleep 0.5`. */
const INLINE_GAP_MS = 500;

let dockerSeen: { at: number; ports: Map<number, string> } | null = null;
/** Forgets the published ports read last (tests). */
export function clearLocalScanCache(): void {
  dockerSeen = null;
}

/** A url read the plain shell could not run: it never reached the url marker. */
const urlRetry = (r: ExecResult): boolean => !r.stdout.includes(MARK.URL);
/** A docker read the plain shell could not run: it never reached the docker marker. */
const dockerRetry = (r: ExecResult): boolean => !r.stdout.includes(MARK.DOCKER);

/** The url checks this machine makes, as its probe made them: the script's url section alone, in plain sh. */
async function hostUrls(
  link: LocalLink,
  urls: string[]
): Promise<Pick<ProbeData, 'urls' | 'env'>> {
  if (urls.length === 0) return { urls: new Map(), env: null };
  const res = ensureOk(
    await link.transport.read(urlSection(urls).join('\n'), {
      env: link.pm2.env(),
      timeoutMs: probeTimeoutMs(urls.length),
      retryIf: urlRetry,
    }),
    link.host,
    'url check'
  );
  if (!res.stdout.includes(MARK.URL))
    throw scriptNotRun(link, res, 'the url checks');
  return parseUrlProbe(res.stdout);
}

/**
 * What the scan asks docker: the declared containers' memory when asked (with the published ports, in one read), else
 * the published ports when a listener of a holder port has no pid (a container's port), at most every DOCKER_EVERY_MS
 * and every time for 'all'; nothing otherwise.
 */
async function dockerPart(
  link: LocalLink,
  ask: ProbeAsk,
  listeners: Listener[]
): Promise<{ ports: Map<number, string>; containers: Map<string, number> }> {
  const holders = ask.holders ?? [];
  const unnamed = listeners.some(
    (l) => l.pid === null && (holders === 'all' || holders.includes(l.port))
  );
  if (ask.containers.length === 0 && !unnamed)
    return { ports: new Map(), containers: new Map() };
  const now = Date.now();
  if (
    ask.containers.length === 0 &&
    holders !== 'all' &&
    dockerSeen &&
    now - dockerSeen.at < DOCKER_EVERY_MS
  )
    return { ports: dockerSeen.ports, containers: new Map() };
  const res = ensureOk(
    await link.transport.read(dockerScript(ask.containers), {
      env: link.pm2.env(),
      retryIf: dockerRetry,
    }),
    link.host,
    'docker'
  );
  const d = parseProbe(res.stdout);
  dockerSeen = { at: now, ports: d.stats.dockerPorts };
  return { ports: d.stats.dockerPorts, containers: d.containers };
}

/**
 * One look at this machine without the probe script: pm2's list first (its processes root the trees), then /proc read
 * in-process, the url checks and docker only when asked or needed. null when /proc could not be read: the caller runs
 * the script. `sweep`: one this refresh already took (the stacks overview reads every local daemon from one); an
 * inline CPU pair takes both of its own, so the gap it divides by is the real one.
 */
export async function probeLocal(
  link: LocalLink,
  ask: ProbeAsk,
  sweep?: ProcSweep
): Promise<HostProbe | null> {
  const reader = link.proc;
  const inline = ask.metrics && ask.cpuSample;
  const procs = await link.pm2.jlist();
  let first: ProcSweep;
  let last: ProcSweep;
  try {
    first = !inline && sweep ? sweep : reader.sweep();
    last = first;
    if (inline) {
      await new Promise((r) => setTimeout(r, INLINE_GAP_MS));
      last = reader.sweep();
    }
  } catch {
    return null;
  }
  const trees = reader.trees(last, {
    roots: procs.flatMap((p) => (p.pid > 0 ? [p.pid] : [])),
    metrics: ask.metrics,
    holders: ask.holders ?? [],
  });
  const [urls, docker, env] = await Promise.all([
    hostUrls(link, ask.urls),
    dockerPart(link, ask, trees.listeners),
    link.transport.loginEnv(),
  ]);
  for (const l of trees.listeners)
    if (l.pid === null) l.container = docker.ports.get(l.port) ?? null;
  const stats: ProcStats = ask.metrics
    ? {
        clkTck: reader.clkTck,
        samples: inline ? [first.sample, last.sample] : [last.sample],
        rssKb: trees.rssKb,
        args: trees.args,
        dockerPorts: docker.ports,
      }
    : { ...EMPTY_STATS, dockerPorts: docker.ports };
  return {
    procs,
    sampledAt: last.at,
    data: {
      jlistRaw: '',
      jlistRc: 0,
      tree: last.tree,
      listeners: trees.listeners,
      stats,
      urls: urls.urls,
      env: urls.env,
      // pm2 stamps its logs in its daemon's zone, and the daemon runs with the login environment
      zone: zoneOf(new Date(last.at), env?.TZ),
      memory: last.memory,
      containers: docker.containers,
    },
  };
}

/** The listening pre-check without a script: the ports /proc/net lists, and pm2's list; null when /proc/net cannot be read. */
export async function listenLocal(
  link: LocalLink
): Promise<ListenCheck | null> {
  let ports: Set<number>;
  try {
    ports = link.proc.ports();
  } catch {
    return null;
  }
  return { procs: await link.pm2.jlist(), ports };
}

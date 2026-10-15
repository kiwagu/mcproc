import { McprocError } from './errors.js';
import { type Host, type Manifest, scopeManifest } from './manifest.js';
import { Pm2Client, resolvePm2Bin, runtimeDir } from './pm2.js';
import { parseUrlProbe } from './ports.js';
import { pickHost } from './resolve.js';
import {
  checkHere,
  type HereCheck,
  type HostEnv,
  isItself,
  settleUrls,
  type UrlResult,
} from './urlcheck.js';
import { MARK, urlBudgetMs, urlName, urlSection } from '../shell/snippets.js';
import { shq } from '../transport/quote.js';
import { createTransport, ensureOk } from '../transport/index.js';
import type { Spawner, Transport } from '../transport/types.js';
import { LOCK_MARK } from '../runtime/probe.js';

/** One url of the host's apps: its name and the address it resolves to there, and where it answers. */
export interface DoctorUrl {
  app: string;
  url: string;
  name: string | null;
  /** the name's first address on that host; null when it does not resolve there or getent is missing */
  addr: string | null;
  /** the name resolves there to the host itself (see isItself) */
  itself: boolean;
  /** where it answers, decided as url_check: auto decides it */
  check: UrlResult;
}

export interface DoctorReport {
  host: string;
  transport: string;
  reachable: boolean;
  error: string | null;
  node: string | null;
  pm2: {
    source: string;
    bin: string;
    version: string | null;
    reason: string;
  } | null;
  tools: { ps: boolean; ss: boolean; tar: boolean };
  pm2_home: string | null;
  runtime_dir: string;
  runtime_present: boolean;
  runtime_pm2: string | null;
  runtime_node: string | null;
  daemon: 'answers' | 'error' | 'unknown';
  processes: number;
  in_namespace: number;
  recommendations: string[];
  /** the host's own account of itself (container, hostname, own addresses); null when not read */
  environment: HostEnv | null;
  urls: DoctorUrl[];
}

const MARKER = '__MCPROC_DOCTOR__';

export async function doctorHost(
  m: Manifest,
  host: Host,
  spawner?: Spawner,
  hereCheck: HereCheck = checkHere
): Promise<DoctorReport> {
  const transport = createTransport(host, spawner);
  const rt = runtimeDir(host);
  const r: DoctorReport = {
    host: host.name,
    transport: transport.describe(),
    reachable: false,
    error: null,
    node: null,
    pm2: null,
    tools: { ps: false, ss: false, tar: false },
    pm2_home: host.pm2_home ?? null,
    runtime_dir: rt,
    runtime_present: false,
    runtime_pm2: null,
    runtime_node: null,
    daemon: 'unknown',
    processes: 0,
    in_namespace: 0,
    recommendations: [],
    environment: null,
    urls: [],
  };
  const probe = [
    `echo ${MARKER}`,
    `node -v 2>/dev/null || echo NODE_NONE`,
    `for t in ps ss tar; do if command -v $t >/dev/null 2>&1; then echo "tool $t yes"; else echo "tool $t no"; fi; done`,
    `echo "pm2home \${PM2_HOME:-}"`,
    `if [ -x ${shq(`${rt}/bin/pm2`)} ]; then echo RUNTIME yes; else echo RUNTIME no; fi`,
    `echo ${LOCK_MARK}; cat ${shq(`${rt}/lock.json`)} 2>/dev/null || true`,
  ].join('; ');
  try {
    const res = ensureOk(
      await transport.exec(probe, {
        env: host.pm2_home ? { PM2_HOME: host.pm2_home } : undefined,
        timeoutMs: 15_000,
      }),
      host,
      'doctor probe'
    );
    if (!res.stdout.includes(MARKER))
      throw new McprocError(
        'TRANSPORT_FAILED',
        `unexpected probe output: ${(res.stderr || res.stdout).trim().slice(0, 200)}`
      );
    r.reachable = true;
    const lockAt = res.stdout.indexOf(LOCK_MARK);
    const head = lockAt < 0 ? res.stdout : res.stdout.slice(0, lockAt);
    if (lockAt >= 0) {
      try {
        const lock = JSON.parse(
          res.stdout.slice(lockAt + LOCK_MARK.length).trim() || 'null'
        ) as { pm2?: string; node?: string | null } | null;
        r.runtime_pm2 = lock?.pm2 ?? null;
        r.runtime_node = lock?.node ?? null;
      } catch {
        /* unreadable lock: versions stay unknown */
      }
    }
    for (const line of head.split('\n')) {
      const l = line.trim();
      if (/^v\d+\./.test(l)) r.node = l;
      const t = /^tool (ps|ss|tar) (yes|no)$/.exec(l);
      if (t) r.tools[t[1] as 'ps' | 'ss' | 'tar'] = t[2] === 'yes';
      const h = /^pm2home (.+)$/.exec(l);
      if (h) r.pm2_home = h[1].trim();
      if (l === 'RUNTIME yes') r.runtime_present = true;
    }
  } catch (e) {
    r.error = (e as Error).message;
    r.recommendations.push(
      host.ssh
        ? `ssh ${host.ssh} does not answer non-interactively: check the alias in ~/.ssh/config, the key, and that no prompt is needed (BatchMode)`
        : host.docker
          ? `docker exec into ${host.docker.container} failed: is the container running and the user allowed?`
          : 'the local shell probe failed'
    );
    return r;
  }
  try {
    const res = await resolvePm2Bin(host, transport);
    r.pm2 = {
      source: res.source,
      bin: res.bin,
      version: res.pm2Version,
      reason: res.reason,
    };
  } catch (e) {
    r.recommendations.push(
      `no usable pm2: ${(e as Error).message}. Run unpack for this host (brings pm2 along), or set hosts.${host.name}.pm2`
    );
  }
  if (r.pm2) {
    try {
      const procs = await new Pm2Client(
        transport,
        host,
        r.pm2.bin,
        host.pm2_home
      ).jlist();
      r.daemon = 'answers';
      r.processes = procs.length;
      r.in_namespace = procs.filter((p) => p.namespace === m.project).length;
      if (procs.length === 0)
        r.recommendations.push(
          `pm2 daemon is empty here: if ${m.project} should already run on this host under another user or PM2_HOME, set hosts.${host.name}.pm2_home`
        );
    } catch (e) {
      r.daemon = 'error';
      r.recommendations.push(`pm2 jlist failed: ${(e as Error).message}`);
    }
  }
  const major = Number(/^v(\d+)/.exec(r.node ?? '')?.[1] ?? 0);
  if (major < 18)
    r.recommendations.push(
      `Node ${r.node ?? 'missing'} in the login shell: pm2 7 needs Node >= 18 (unpack with with_node: auto brings an official build)`
    );
  if (!r.tools.ss)
    r.recommendations.push(
      'no ss: port detection falls back to /proc (slower, same result)'
    );
  if (!r.tools.tar)
    r.recommendations.push(
      'no tar: unpack cannot deliver a runtime bundle to this host'
    );
  await checkUrlsOf(m, host, transport, r, hereCheck);
  return r;
}

/**
 * The bound on doctor's url round trip: its base, plus the bounds of the environment section and of each url, so a
 * host whose resolver hangs, which is what doctor is there to show, still answers; never more than two minutes.
 */
const urlStepMs = (urls: number): number => urlBudgetMs(15_000, urls, true);

/**
 * The host's environment and where the urls of its apps answer: those bound to it, plus on local the unbound ones,
 * which run there by default. Each url is decided as url_check: auto decides it, whatever the app declares: doctor says
 * where a url works, and recommends auto for an app with url_check: host whose url answers only from this machine. Its
 * own round trip, judged by the exit status and the markers, never by stderr: BusyBox timeout prints "Terminated"
 * there each time it cuts a hung lookup, and the answer is still whole.
 */
async function checkUrlsOf(
  m: Manifest,
  host: Host,
  transport: Transport,
  r: DoctorReport,
  here: HereCheck
): Promise<void> {
  const apps = Object.values(scopeManifest(m, host.name, 'local').apps).flatMap(
    (a) => (a.url === null ? [] : [{ app: a, url: a.url }])
  );
  const urls = [...new Set(apps.map((x) => x.url))];
  try {
    const res = ensureOk(
      await transport.exec(urlSection(urls, true).join('\n'), {
        timeoutMs: urlStepMs(urls.length),
      }),
      host,
      'doctor url check'
    );
    const lines = res.stdout.split('\n').map((l) => l.trim());
    if (
      res.code !== 0 ||
      !lines.includes(MARK.ENV) ||
      !lines.includes(MARK.URL)
    )
      throw new McprocError(
        'TRANSPORT_FAILED',
        `unexpected output (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 200)}`
      );
    const probe = parseUrlProbe(res.stdout);
    r.environment = probe.env;
    const checks = await settleUrls(
      apps.map((x) => ({
        name: x.app.name,
        url: x.url,
        url_check: 'auto' as const,
      })),
      { host: host.name, local: host.local },
      probe,
      here
    );
    for (const { app, url } of apps) {
      const name = urlName(url);
      const addr = probe.urls.get(url)?.addr ?? null;
      const check = checks[app.name];
      r.urls.push({
        app: app.name,
        url,
        name,
        addr,
        itself: !host.local && isItself(name, addr, probe.env),
        check,
      });
      if (
        app.url_check === 'host' &&
        check.from === 'here' &&
        check.status !== 'down'
      )
        r.recommendations.push(
          probe.urls.get(url)?.code === null
            ? `apps.${app.name}.url_check is host, but ${host.name} cannot check its url (no curl or wget) and it answers from this machine: set url_check: auto (or drop the line)`
            : `apps.${app.name}.url_check is host, but its url answers only from this machine: set url_check: auto (or drop the line)`
        );
    }
  } catch (e) {
    r.recommendations.push(
      `the environment and url checks failed: ${(e as Error).message}`
    );
  }
}

export async function doctor(
  m: Manifest,
  hostName?: string,
  spawner?: Spawner,
  hereCheck?: HereCheck
): Promise<DoctorReport[]> {
  const names = hostName
    ? [hostName]
    : ['local', ...Object.keys(m.hosts).filter((n) => n !== 'local')];
  const out: DoctorReport[] = [];
  for (const n of names) {
    try {
      out.push(await doctorHost(m, pickHost(m, n), spawner, hereCheck));
    } catch (e) {
      out.push({
        host: n,
        transport: '?',
        reachable: false,
        error: (e as Error).message,
        node: null,
        pm2: null,
        tools: { ps: false, ss: false, tar: false },
        pm2_home: null,
        runtime_dir: '',
        runtime_present: false,
        runtime_pm2: null,
        runtime_node: null,
        daemon: 'unknown',
        processes: 0,
        in_namespace: 0,
        recommendations: [],
        environment: null,
        urls: [],
      });
    }
  }
  return out;
}

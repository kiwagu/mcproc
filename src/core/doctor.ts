import { McprocError } from './errors.js';
import type { Host, Manifest } from './manifest.js';
import { Pm2Client, resolvePm2Bin, runtimeDir } from './pm2.js';
import { pickHost } from './resolve.js';
import { shq } from '../transport/quote.js';
import { createTransport, ensureOk } from '../transport/index.js';
import type { Spawner } from '../transport/types.js';

export interface DoctorReport {
  host: string; transport: string; reachable: boolean; error: string | null; node: string | null;
  pm2: { source: string; bin: string; version: string | null; reason: string } | null;
  tools: { ps: boolean; ss: boolean; tar: boolean }; pm2_home: string | null;
  runtime_dir: string; runtime_present: boolean;
  daemon: 'answers' | 'error' | 'unknown'; processes: number; in_namespace: number; recommendations: string[];
}

const MARKER = '__MCPROC_DOCTOR__';

export async function doctorHost(m: Manifest, host: Host, spawner?: Spawner): Promise<DoctorReport> {
  const transport = createTransport(host, spawner);
  const rt = runtimeDir(host);
  const r: DoctorReport = {
    host: host.name, transport: transport.describe(), reachable: false, error: null, node: null, pm2: null,
    tools: { ps: false, ss: false, tar: false }, pm2_home: host.pm2_home ?? null, runtime_dir: rt, runtime_present: false,
    daemon: 'unknown', processes: 0, in_namespace: 0, recommendations: [],
  };
  const probe = [
    `echo ${MARKER}`, `node -v 2>/dev/null || echo NODE_NONE`,
    `for t in ps ss tar; do if command -v $t >/dev/null 2>&1; then echo "tool $t yes"; else echo "tool $t no"; fi; done`,
    `echo "pm2home \${PM2_HOME:-}"`,
    `if [ -x ${shq(rt + '/bin/pm2')} ]; then echo RUNTIME yes; else echo RUNTIME no; fi`,
  ].join('; ');
  try {
    const res = ensureOk(await transport.exec(probe, { env: host.pm2_home ? { PM2_HOME: host.pm2_home } : undefined, timeoutMs: 15_000 }), host, 'doctor probe');
    if (!res.stdout.includes(MARKER)) throw new McprocError('TRANSPORT_FAILED', `unexpected probe output: ${(res.stderr || res.stdout).trim().slice(0, 200)}`);
    r.reachable = true;
    for (const line of res.stdout.split('\n')) {
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
    r.recommendations.push(host.ssh
      ? `ssh ${host.ssh} does not answer non-interactively: check the alias in ~/.ssh/config, the key, and that no prompt is needed (BatchMode)`
      : host.docker ? `docker exec into ${host.docker.container} failed: is the container running and the user allowed?` : 'the local shell probe failed');
    return r;
  }
  try {
    const res = await resolvePm2Bin(host, transport);
    r.pm2 = { source: res.source, bin: res.bin, version: res.pm2Version, reason: res.reason };
  } catch (e) {
    r.recommendations.push(`no usable pm2: ${(e as Error).message}. Install pm2 there (Node 18 or newer) or set hosts.${host.name}.pm2`);
  }
  if (r.pm2) {
    try {
      const procs = await new Pm2Client(transport, host, r.pm2.bin, host.pm2_home).jlist();
      r.daemon = 'answers'; r.processes = procs.length; r.in_namespace = procs.filter((p) => p.namespace === m.project).length;
      if (procs.length === 0) r.recommendations.push(`pm2 daemon is empty here: if ${m.project} should already run on this host under another user or PM2_HOME, set hosts.${host.name}.pm2_home`);
    } catch (e) {
      r.daemon = 'error';
      r.recommendations.push(`pm2 jlist failed: ${(e as Error).message}`);
    }
  }
  const major = Number(/^v(\d+)/.exec(r.node ?? '')?.[1] ?? 0);
  if (major < 18) r.recommendations.push(`Node ${r.node ?? 'missing'} in the login shell: pm2 7 needs Node >= 18`);
  if (!r.tools.ss) r.recommendations.push('no ss: port detection falls back to /proc (slower, same result)');
    return r;
}

export async function doctor(m: Manifest, hostName?: string, spawner?: Spawner): Promise<DoctorReport[]> {
  const names = hostName ? [hostName] : ['local', ...Object.keys(m.hosts).filter((n) => n !== 'local')];
  const out: DoctorReport[] = [];
  for (const n of names) {
    try { out.push(await doctorHost(m, pickHost(m, n), spawner)); }
    catch (e) { out.push({ host: n, transport: '?', reachable: false, error: (e as Error).message, node: null, pm2: null, tools: { ps: false, ss: false, tar: false }, pm2_home: null, runtime_dir: '', runtime_present: false, daemon: 'unknown', processes: 0, in_namespace: 0, recommendations: [] }); }
  }
  return out;
}

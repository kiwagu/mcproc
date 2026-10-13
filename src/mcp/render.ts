import type { LsRow, HostInfo } from '../core/list.js';
import type { DoctorReport } from '../core/doctor.js';
import type { AppPorts, Listener } from '../core/ports.js';
import type { LogsResult } from '../core/logs.js';
import type { UnpackResult } from '../runtime/unpack.js';
import type { Cleared, TakenAnswer } from '../core/incidents/store.js';
import type { WaitRecord } from '../core/actions.js';
import { shq } from '../transport/quote.js';

export function fmtUptime(ms: number | null): string {
  if (ms === null) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}
export function fmtBytes(b: number): string {
  if (b < 1024) return `${b}B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)}K`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)}M`;
  return `${(b / 1024 ** 3).toFixed(2)}G`;
}
export function fmtPorts(p: AppPorts): string {
  const parts: string[] = [];
  for (const c of p.checks) {
    if (c.status === 'listening') parts.push(`:${c.port} ✓`);
    else if (c.held_by) {
      const who = c.held_by.app
        ? `app ${c.held_by.app}`
        : c.held_by.container
          ? `container ${c.held_by.container}`
          : c.held_by.pid !== null
            ? `pid ${c.held_by.pid}${c.held_by.command ? ` (${c.held_by.command})` : ''}`
            : "another user's process";
      parts.push(`:${c.port} ✗ held by ${who}`);
    } else parts.push(`:${c.port} ✗ nothing listens`);
  }
  for (const u of p.undeclared) parts.push(`:${u} (undeclared)`);
  return parts.length ? parts.join(', ') : '-';
}
export function table(rows: string[][]): string {
  const w = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? '').length))
  );
  return rows
    .map((r) =>
      r
        .map((c, i) => (c ?? '').padEnd(w[i]))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}
export function fmtCpu(c: number | null): string {
  return c === null ? '-' : `${c.toFixed(1)}%`;
}
export function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
/** The declared url with its HTTP answer when one was requested; the bare url when not (monit's live screen never asks). */
export function fmtUrl(r: LsRow): string {
  if (!r.url) return '-';
  if (r.url_status === 'ok') return `${r.url} ✓ ${r.url_code}`;
  if (r.url_status === 'error') return `${r.url} ✗ ${r.url_code}`;
  if (r.url_status === 'down') return `${r.url} ✗ down`;
  return r.url;
}
/** One table; a HOST column and the list of hosts only when the rows span more than one, then one line per host that did not answer. */
export function renderLs(rows: LsRow[], host: string): string {
  const hosts = [...new Set(rows.map((r) => r.host))];
  const multi = hosts.length > 1;
  const head = multi
    ? `hosts: ${hosts.join(', ')}`
    : `host: ${hosts[0] ?? host}`;
  const errors = [
    ...new Map(
      rows.filter((r) => r.error).map((r) => [r.host, `${r.host}: ${r.error}`])
    ).values(),
  ];
  return [
    head,
    table([
      [
        'APP',
        ...(multi ? ['HOST'] : []),
        'KIND',
        'STATUS',
        'PID',
        'UPTIME',
        'RESTARTS',
        'MEM',
        'CPU',
        'PORTS',
        'URL',
        'RUNTIME',
        'DESCRIPTION',
      ],
      ...rows.map((r) => [
        r.app,
        ...(multi ? [r.host] : []),
        r.kind,
        r.status,
        r.pid === null ? '-' : String(r.pid),
        fmtUptime(r.uptime_ms),
        String(r.restarts),
        r.memory ? fmtBytes(r.memory) : '-',
        r.status === 'online' ? fmtCpu(r.cpu) : '-',
        fmtPorts(r.ports),
        fmtUrl(r),
        r.runtime ? cut(r.runtime, 32) : '-',
        cut(r.description.split('\n')[0], 40),
      ]),
    ]),
    ...errors,
  ].join('\n');
}
/** `host` when the rows come from one host (the shape results had before apps could run on several), `hosts` always. */
export function hostsOf(
  rows: LsRow[],
  fallback: string
): { host?: string; hosts: string[] } {
  const hosts = rows.length
    ? [...new Set(rows.map((r) => r.host))]
    : [fallback];
  return hosts.length === 1 ? { host: hosts[0], hosts } : { hosts };
}
/** A port sampled right after start may simply not be bound yet; say so instead of letting "✗" read as a failure. */
export function startNote(rows: LsRow[]): string {
  const booting = rows.filter(
    (r) =>
      r.status === 'online' &&
      r.ports.checks.some(
        (c) => c.status === 'declared-not-listening' && !c.held_by
      )
  );
  return booting.length
    ? `note: ${booting.map((r) => r.app).join(', ')} not listening yet; ports are sampled right after start, call ls again if the app is still booting`
    : '';
}

export function renderPorts(
  rep: {
    port: number | null;
    listeners: Array<Listener & { app: string | null }>;
  },
  host: string
): string {
  if (rep.listeners.length === 0)
    return `host: ${host}\n${rep.port ? `nothing listens on port ${rep.port}` : 'no listening sockets visible'}`;
  return (
    `host: ${host}\n` +
    table([
      ['PROTO', 'ADDR', 'PORT', 'PID', 'COMMAND', 'APP', 'CONTAINER'],
      ...rep.listeners.map((l) => [
        l.proto,
        l.addr,
        String(l.port),
        l.pid === null ? '?' : String(l.pid),
        l.command ?? '?',
        l.app ?? '-',
        l.container ?? '-',
      ]),
    ])
  );
}
export function renderHosts(info: HostInfo[]): string {
  return table([
    ['HOST', 'TRANSPORT', 'CWD', 'READONLY', 'PM2_HOME', 'APPS'],
    ...info.map((h) => [
      h.name,
      h.transport,
      h.cwd,
      h.readonly ? 'yes' : 'no',
      h.pm2_home ?? '-',
      h.apps.length ? h.apps.join(', ') : '-',
    ]),
  ]);
}
export function renderDoctor(reps: DoctorReport[]): string {
  return reps
    .map((r) => {
      const L = [
        `${r.host} (${r.transport}): ${r.reachable ? 'reachable' : `UNREACHABLE: ${r.error}`}`,
      ];
      if (r.reachable) {
        L.push(
          `  node: ${r.node ?? 'missing'}  tools: ps=${r.tools.ps} ss=${r.tools.ss} tar=${r.tools.tar}`
        );
        L.push(
          `  pm2: ${r.pm2 ? `${r.pm2.source} (${r.pm2.reason})${r.pm2.version ? ` ${r.pm2.version}` : ''}` : 'none'}  daemon: ${r.daemon}, ${r.processes} processes, ${r.in_namespace} in this project`
        );
        L.push(
          `  PM2_HOME: ${r.pm2_home ?? 'default (~/.pm2)'}  runtime: ${r.runtime_present ? `${r.runtime_dir} (pm2 ${r.runtime_pm2 ?? '?'}${r.runtime_node ? `, node ${r.runtime_node}` : ''})` : 'not unpacked'}`
        );
        if (r.runtime_present)
          L.push(
            `  watch from a shell there: ${r.pm2_home ? `PM2_HOME=${shq(r.pm2_home)} ` : ''}${shq(`${r.runtime_dir}/bin/pm2`)} monit`
          );
      }
      for (const rec of r.recommendations) L.push(`  → ${rec}`);
      return L.join('\n');
    })
    .join('\n');
}
export function renderUnpack(r: UnpackResult): string {
  const L = [
    `${r.host}: runtime at ${r.runtime_dir}${r.noop ? ', already up to date' : ''}`,
  ];
  L.push(`  pm2 ${r.pm2.version} ${r.pm2.written ? 'unpacked' : 'kept'}`);
  if (r.node)
    L.push(
      `  node ${r.node.version} (${r.node.platform}) ${r.node.written ? 'unpacked' : 'kept'}`
    );
  L.push(`  manifest copy on the host: ${r.manifest_copy}`);
  if (r.runtime_line)
    L.push(
      `  add to .mcproc/mcproc.yaml so later calls find it: ${r.runtime_line}`
    );
  L.push(`  watch it from a shell there: ${r.monit}`);
  if (r.update_hint) L.push(`  note: ${r.update_hint}`);
  return L.join('\n');
}
export function renderLogs(l: LogsResult): string {
  const parts: string[] = [];
  if (l.out !== undefined)
    parts.push(`--- ${l.app} out (${l.paths.out}) ---\n${l.out}`);
  if (l.err !== undefined)
    parts.push(`--- ${l.app} err (${l.paths.err}) ---\n${l.err}`);
  return parts.join('\n');
}
/** `libs (completed), api (ready), logger`: a started dependency is its bare name. */
export function fmtDeps(deps: { app: string; condition: string }[]): string {
  return deps
    .map((d) =>
      d.condition === 'started' ? d.app : `${d.app} (${d.condition})`
    )
    .join(', ');
}

export function renderProject(d: {
  project: string;
  root: string;
  apps: {
    name: string;
    kind: string;
    description: string;
    ports: number[];
    url: string | null;
    depends_on: { app: string; condition: string }[];
    host: string | null;
  }[];
  profiles: Record<string, string[]>;
  hosts: HostInfo[];
  readme: string | null;
}): string {
  const L = [`project: ${d.project} (${d.root})`, 'apps:'];
  for (const a of d.apps)
    L.push(
      `  ${a.name} [${a.kind}]${a.host ? ` on ${a.host}` : ''}${a.ports.length ? ` :${a.ports.join(',:')}` : ''}${a.url ? ` → ${a.url}` : ''}${a.depends_on.length ? ` after ${fmtDeps(a.depends_on)}` : ''}: ${a.description}`
    );
  L.push('profiles:');
  for (const [p, apps] of Object.entries(d.profiles))
    L.push(`  ${p}: ${apps.join(', ')}`);
  L.push(
    'hosts:',
    renderHosts(d.hosts)
      .split('\n')
      .map((x) => `  ${x}`)
      .join('\n')
  );
  if (d.readme) L.push('', 'README:', d.readme.trim());
  return L.join('\n');
}

/** Incidents newest first: a header, context lines `│`, the error line `▶`; then how to go on. Nothing new is one short line. */
export function renderIncidents(
  a: TakenAnswer,
  opts: { color?: boolean } = {}
): string {
  const tail: string[] = [];
  if (a.more > 0)
    tail.push(
      a.taken
        ? `+${a.more} older incidents not shown, taken with these (read logs for them)`
        : `+${a.more} more incidents (raise max)`
    );
  for (const s of a.skipped)
    tail.push(
      `skipped ${fmtBytes(s.bytes)} of ${s.app} ${s.stream} on ${s.host} (too much new log; the most recent 1 MB was read)`
    );
  for (const e of a.errors) tail.push(`${e.host}: ${e.message}`);
  if (a.incidents.length === 0) {
    const cleared = a.cleared_at ? `; logs cleared ${a.cleared_at}` : '';
    return [
      `no new incidents since ${a.latest ?? 'the last call'} (${a.apps} app${a.apps === 1 ? '' : 's'} on ${a.hosts} host${a.hosts === 1 ? '' : 's'}${cleared})`,
      ...tail,
    ].join('\n');
  }
  const red = (s: string) => (opts.color ? `\x1b[31m${s}\x1b[0m` : s);
  const L: string[] = [];
  for (const i of a.incidents) {
    const count = i.count > 1 ? ` ×${i.count}` : '';
    const first =
      i.count > 1 && i.first_time && i.first_time !== i.time
        ? `first ${i.first_time}, `
        : '';
    L.push(
      `${i.app}@${i.host} ${i.time ?? '-'} ${i.kind}${count} (${first}${i.stream})`
    );
    for (const b of i.before) L.push(`  │ ${b}`);
    L.push(red(`  ▶ ${i.line}`));
    for (const x of i.after) L.push(`  │ ${x}`);
  }
  L.push(
    ...tail,
    `next: call incidents again later (${a.taken ? 'these are taken now' : 'peeked: nothing taken'}); full logs with logs app=${a.incidents[0].app}`
  );
  return L.join('\n');
}

/** What a flush did: one line per app (with its host when several answered), naming the files it could not truncate. */
export function renderFlushed(r: Cleared[], multi: boolean): string {
  if (r.length === 0)
    return 'nothing to flush (no pm2 processes for this project there)';
  return r
    .map(
      (x) =>
        `${x.app}${multi ? ` (${x.host})` : ''}: freed ${x.out_bytes + x.err_bytes} bytes${x.failed?.length ? `; could not truncate ${x.failed.join(', ')}` : ''}`
    )
    .join('\n');
}

/** `waited 4.2 s for libs (completed), 1.1 s for api (ready)`: the waits that were met; the failed ones are in the rows. */
export function waitNote(waits: WaitRecord[]): string {
  const ok = waits.filter((w) => w.ok);
  return ok.length
    ? `waited ${ok.map((w) => `${(w.ms / 1000).toFixed(1)} s for ${w.dep} (${w.condition})`).join(', ')}`
    : '';
}

/** A fleet mutation's answer: when a host failed or was skipped, a first line that says which apps and why; then the table, the start note and the waits made. */
export function renderMutation(
  rows: LsRow[],
  fallback: string,
  act: string,
  waits: WaitRecord[] = []
): { text: string; failed: boolean } {
  const bad = rows.filter((r) => r.error);
  const notes = [
    act === 'start' || act === 'restart' ? startNote(rows) : '',
    waitNote(waits),
  ].filter(Boolean);
  const head = bad.length
    ? `${act} partly failed: ${bad.map((r) => `${r.app} (${r.host}): ${r.error}`).join('; ')}\n`
    : '';
  return {
    text: head + renderLs(rows, fallback) + notes.map((n) => `\n${n}`).join(''),
    failed: bad.length > 0,
  };
}

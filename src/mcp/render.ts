import os from 'node:os';
import type { LsRow, HostInfo } from '../core/list.js';
import type { HostError } from '../core/fleet.js';
import type { DoctorReport, DoctorUrl } from '../core/doctor.js';
import type { AppPorts, Listener } from '../core/ports.js';
import type { LogsResult } from '../core/logs.js';
import type { UnpackResult } from '../runtime/unpack.js';
import type { Cleared, TakenAnswer } from '../core/incidents/store.js';
import type { WaitRecord } from '../core/actions.js';
import type { WaitResult } from '../core/wait.js';
import type { SinceAnswer } from '../core/logsince.js';
import type { AdoptResult } from '../core/adopt.js';
import type { VarInfo } from '../core/manifest.js';
import type { LeasesView } from '../core/leases/view.js';
import type { ExecResult } from '../core/exec.js';
import type {
  WorktreeAdded,
  WorktreeRemoved,
  WorktreeRow,
} from '../core/worktree.js';
import type { Orphan, Stack, StacksAnswer } from '../core/stacks/types.js';
import { fmtMib } from '../core/sizes.js';
import {
  type HostEnv,
  reasonWord,
  withoutItselfNote,
} from '../core/urlcheck.js';
import { formatLine } from '../core/logstream.js';
import { bodyOf, type Incident } from '../core/incidents/detect.js';
import { shq } from '../transport/quote.js';
import { cutStartWidth, cutWidth, displayWidth } from '../monit/screentext.js';

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
/** How a table meets a width: `wrap` continues a long cell on the next lines (the CLI on a terminal), `fit` keeps one line per row and cuts it with … (the TUI). */
export interface TableOpts {
  /** the terminal columns to stay within; none: no limit, the output tables always had (MCP answers, piped output) */
  width?: number;
  /** the free-text columns, by index: the only ones that shrink */
  flex?: number[];
  mode?: 'wrap' | 'fit';
  /** `fit`: the columns cut at the start (paths, whose end says more); the others are cut at the end */
  cutStart?: number[];
}
const GUTTER = 2;
/** A free-text column never shrinks below this, or below its own longest cell. */
export const FLEX_MIN = 12;

/** The column widths for `width`: the widest free-text column loses one column at a time until the row fits or every one is at its floor. */
export function fitWidths(
  natural: number[],
  flex: number[],
  width: number
): number[] {
  const w = [...natural];
  const floor = (i: number) => Math.min(FLEX_MIN, natural[i]);
  let total = w.reduce((a, b) => a + b, 0) + GUTTER * (w.length - 1);
  while (total > width) {
    let pick = -1;
    for (const i of flex)
      if (w[i] > floor(i) && (pick < 0 || w[i] > w[pick])) pick = i;
    if (pick < 0) break; // every free-text column at its floor: the rest is the terminal's
    w[pick]--;
    total--;
  }
  return w;
}

/** The longest start of `s` within `width` columns, at least one character. */
function takeWidth(s: string, width: number): string {
  let out = '';
  for (const ch of s) {
    if (out && displayWidth(out + ch) > width) break;
    out += ch;
  }
  return out;
}

/** `s` as lines of at most `width` columns: broken after a space, `/`, `,`, `:` or `-`; a longer run is split where it reaches the width. */
export function wrapCell(s: string, width: number): string[] {
  if (displayWidth(s) <= width) return [s];
  const lines: string[] = [];
  let line = '';
  for (let t of s.match(/[^\s/,:-]*[\s/,:-]*/g)?.filter(Boolean) ?? []) {
    if (displayWidth((line + t).trimEnd()) <= width) {
      line += t;
      continue;
    }
    if (line.trim()) lines.push(line.trimEnd());
    line = '';
    while (displayWidth(t.trimEnd()) > width) {
      const head = takeWidth(t, width);
      lines.push(head);
      t = t.slice(head.length);
    }
    line = t;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** The table every renderer prints. Without a width: each column as wide as its longest cell. With one: see TableOpts. */
export function table(rows: string[][], opts: TableOpts = {}): string {
  if (opts.width === undefined) {
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
  const at = (r: string[], i: number) => r[i] ?? '';
  const natural = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => displayWidth(at(r, i))))
  );
  const widths = fitWidths(natural, opts.flex ?? [], opts.width);
  const flex = new Set(opts.flex ?? []);
  const starts = new Set(opts.cutStart ?? []);
  const pad = (s: string, w: number) =>
    s + ' '.repeat(Math.max(0, w - displayWidth(s)));
  const out: string[] = [];
  for (const r of rows) {
    const cells = widths.map((w, i) => {
      const s = at(r, i);
      if (!flex.has(i) || displayWidth(s) <= w) return [s];
      if (opts.mode === 'fit')
        return [starts.has(i) ? cutStartWidth(s, w) : cutWidth(s, w)];
      return wrapCell(s, w);
    });
    const height = Math.max(...cells.map((c) => c.length));
    for (let k = 0; k < height; k++)
      out.push(
        cells
          .map((c, i) => pad(c[k] ?? '', widths[i]))
          .join(' '.repeat(GUTTER))
          .trimEnd()
      );
  }
  return out.join('\n');
}
export function fmtCpu(c: number | null): string {
  return c === null ? '-' : `${c.toFixed(1)}%`;
}
export function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
/**
 * The declared url with its HTTP answer when one was requested, `(here)` when that answer came from this machine, and
 * the short reason of a url that answered nowhere; the bare url when not requested (monit's live screen never asks).
 */
export function fmtUrl(r: LsRow): string {
  // a queued app without a url: the column says what its lease waits for
  if (!r.url) return r.lease?.waiting_for ?? '-';
  const here = r.url_from === 'here' ? ' (here)' : '';
  if (r.url_status === 'ok') return `${r.url} ✓ ${r.url_code}${here}`;
  if (r.url_status === 'error')
    return `${r.url} ✗ ${r.url_code ?? 'error'}${here}`;
  if (r.url_status === 'down')
    return `${r.url} ✗ down${r.url_reason ? ` (${reasonWord(r.url_reason)})` : ''}`;
  return r.url;
}
/** describe's line for the url when the table cell does not say it all: where it answered and why, or why it did not. */
export function urlNote(r: LsRow): string {
  if (!r.url || !r.url_reason) return '';
  if (r.url_status === 'ok' || r.url_status === 'error')
    return `url: answered ${r.url_from === 'here' ? 'from this machine' : `on ${r.host}`} (${r.url_reason})`;
  return `url: ${r.url_status} (${r.url_reason})`;
}
/** pm2's restarts, then the in-process reloads counted since the start when there are any: `0 (+3)`, `0 (+≥3)` when partial. */
function fmtRestarts(r: LsRow): string {
  const n = r.reloads;
  return n && n.count > 0
    ? `${r.restarts} (+${n.partial ? '≥' : ''}${n.count})`
    : String(r.restarts);
}
/**
 * One table; a HOST column and the list of hosts only when the rows span more than one, then one line per host that did
 * not answer, then one per error of a later read of a host that did (`errors`, the reload count's).
 */
export function renderLs(
  rows: LsRow[],
  host: string,
  errors: HostError[] = [],
  width?: number
): string {
  const hosts = [...new Set(rows.map((r) => r.host))];
  const multi = hosts.length > 1;
  const head = multi
    ? `hosts: ${hosts.join(', ')}`
    : `host: ${hosts[0] ?? host}`;
  const unreachable = [
    ...new Map(
      rows.filter((r) => r.error).map((r) => [r.host, `${r.host}: ${r.error}`])
    ).values(),
  ];
  const o = multi ? 1 : 0;
  // without a width the long cells keep their caps (MCP answers, piped output); a terminal wraps them instead
  const cap = (s: string, n: number) => (width === undefined ? cut(s, n) : s);
  return [
    head,
    table(
      [
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
          fmtRestarts(r),
          r.memory ? fmtBytes(r.memory) : '-',
          r.status === 'online' ? fmtCpu(r.cpu) : '-',
          fmtPorts(r.ports),
          fmtUrl(r),
          r.runtime ? cap(r.runtime, 32) : '-',
          cap(r.description.split('\n')[0], 40),
        ]),
      ],
      { width, flex: [8 + o, 9 + o, 10 + o, 11 + o], mode: 'wrap' }
    ),
    ...unreachable,
    ...errors.map((e) => `${e.host}: ${e.message}`),
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
    ? `note: ${booting.map((r) => r.app).join(', ')} not listening yet; ports are sampled right after start, call wait until listening instead of polling ls`
    : '';
}

export function renderPorts(
  rep: {
    port: number | null;
    listeners: Array<Listener & { app: string | null }>;
  },
  host: string,
  width?: number
): string {
  if (rep.listeners.length === 0)
    return `host: ${host}\n${rep.port ? `nothing listens on port ${rep.port}` : 'no listening sockets visible'}`;
  return (
    `host: ${host}\n` +
    table(
      [
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
      ],
      { width, flex: [4], mode: 'wrap' }
    )
  );
}
export function renderHosts(info: HostInfo[], width?: number): string {
  return table(
    [
      ['HOST', 'TRANSPORT', 'CWD', 'READONLY', 'PM2_HOME', 'APPS'],
      ...info.map((h) => [
        h.name,
        h.transport,
        h.cwd,
        h.readonly ? 'yes' : 'no',
        h.pm2_home ?? '-',
        h.apps.length ? h.apps.join(', ') : '-',
      ]),
    ],
    { width, flex: [1, 2, 4, 5], mode: 'wrap' }
  );
}
/** `container (docker), hostname ws-01`, or `no container, hostname dev-box` */
export function fmtEnv(e: HostEnv): string {
  const kind =
    e.container === 'none' ? 'no container' : `container (${e.container})`;
  return e.hostname ? `${kind}, hostname ${e.hostname}` : kind;
}
/**
 * `localhost → ::1 on box; answers from this machine (200); on box: refused`: after an answer from here, why the host
 * had none, unless that reason is the host itself, which the first part already says; for the same reason a url that
 * answers nowhere drops the address note from its reason.
 */
function fmtDoctorUrl(host: string, u: DoctorUrl): string {
  const name = u.name ?? u.url;
  const where = `${name} → ${u.addr ?? 'no address'} on ${host}${u.itself ? ', the host itself' : ''}`;
  const c = u.check;
  const code = c.code ?? 'error';
  const why =
    c.reason && !(u.itself && reasonWord(c.reason) === 'itself')
      ? `; ${c.reason}`
      : '';
  const answers =
    c.status === 'unchecked'
      ? `not checked (${c.reason ?? 'not asked'})`
      : c.status === 'down'
        ? `answers nowhere (${u.itself && c.reason ? withoutItselfNote(c.reason) : c.reason})`
        : c.from === 'here'
          ? `answers from this machine (${code})${why}`
          : `answers on ${host} (${code})`;
  return `${where}; ${answers}`;
}
/** Each host's report: whether it answers, its Node, pm2 and runtime, on this machine its memory and lease state, its urls and the fixes. */
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
        if (r.memory)
          L.push(
            `  memory: ${fmtMib(r.memory.available_mib)} available of ${fmtMib(r.memory.total_mib)}`
          );
        if (r.state_dir)
          L.push(
            `  leases: ${r.state_dir}, watcher ${r.watcher ? (r.watcher.online ? `online pid ${r.watcher.pid}` : 'not running') : 'unknown'}`
          );
        if (r.environment) L.push(`  environment: ${fmtEnv(r.environment)}`);
        for (const u of r.urls)
          L.push(`  url ${u.app}: ${fmtDoctorUrl(r.host, u)}`);
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
/** `since <cutoff> (<host> time)`; several hosts list each cutoff; a `last` or tail read has no cutoff. */
function sinceWhen(a: SinceAnswer): string {
  if (a.mode === 'last') return 'since the previous logs call';
  if (a.mode === 'tail') return 'latest lines';
  const hosts = Object.entries(a.since);
  return hosts.length === 1
    ? `since ${hosts[0][1]} (${hosts[0][0]} time)`
    : `since ${hosts.map(([h, c]) => `${h} ${c}`).join(', ')} (each host's time)`;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** The notes after the lines: what was cut, what may be missing or misplaced, who was not read; the CLI prints the same on stderr. */
export function sinceNotes(a: SinceAnswer): string[] {
  const notes: string[] = [];
  if (a.truncated > 0)
    notes.push(`truncated ${plural(a.truncated, 'older line')}`);
  // a last read jumped over new bytes past its mark; a window read may miss lines between the cutoff and its 1 MB
  const why =
    a.mode === 'last'
      ? 'more than 1 MB new since the previous call; the most recent 1 MB was read'
      : 'more than the 1 MB read before the window';
  for (const s of a.skipped)
    notes.push(
      `skipped ${fmtBytes(s.bytes)} of ${s.app} ${s.stream} on ${s.host} (${why})`
    );
  if (a.not_started.length)
    notes.push(`not started: ${a.not_started.join(', ')}`);
  if (a.unzoned.length)
    notes.push(
      `zone unknown on ${a.unzoned.join(', ')}: ${a.unzoned.length === 1 ? 'its' : 'their'} lines are placed by their stamps as if in UTC, so they may be out of place among the other hosts' lines`
    );
  // unreachable, or it answered without a clock the since needs: either way its apps were not read
  for (const e of a.errors)
    notes.push(`${e.host} not read (${e.apps.join(', ')}): ${e.message}`);
  return notes;
}
/** Header, then compose lines (`app | text`, `app ! text` for stderr, no colors), then the notes. */
export function renderLogsSince(a: SinceAnswer): string {
  const who = `${plural(a.apps, 'app')} on ${plural(a.hosts, 'host')}`;
  const notes = sinceNotes(a);
  if (a.lines.length === 0) {
    const none =
      a.mode === 'last'
        ? `no new log lines ${sinceWhen(a)}`
        : a.mode === 'tail'
          ? 'no log lines'
          : `no log lines ${sinceWhen(a)}`;
    return [`${none} (${who})`, ...notes].join('\n');
  }
  const width = Math.max(...a.lines.map((l) => l.app.length));
  return [
    `${sinceWhen(a)} · ${who} · ${plural(a.lines.length, 'line')}`,
    ...a.lines.map((l) =>
      formatLine({ app: l.app, stream: l.stream, text: l.text }, width, null)
    ),
    ...notes,
  ].join('\n');
}
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** One line: what was reached (or not) after how long, and what was seen (a start still queued says its place). */
export function renderWait(app: string, r: WaitResult): string {
  const seen = r.observed ? ` (${r.observed})` : '';
  if (r.ok) {
    if (r.until === 'exited') {
      // "failed (exit 2)" already names its code; a stop has none
      const code =
        typeof r.exit_code === 'number' && !r.status.includes('exit')
          ? ` (exit ${r.exit_code})`
          : '';
      return `${app}: ${r.status} after ${secs(r.waited_ms)}${code}`;
    }
    if (r.until.startsWith('log:'))
      return `${app}: log matched after ${secs(r.waited_ms)}: ${r.matched_line}`;
    if (r.reloaded) {
      // the time is shown once, in its own place: the line follows without pm2's stamp
      const { time, lines, line } = r.reloaded;
      const count = `${lines} line${lines === 1 ? '' : 's'}`;
      return `${app}: reloaded after ${secs(r.waited_ms)} (${time ? `${count} from ${time}` : count}): ${bodyOf(line)}`;
    }
    return `${app}: ${r.until} after ${secs(r.waited_ms)}${seen}`;
  }
  if (r.reason === 'timeout')
    return `${app}: ${r.until} not reached after ${secs(r.waited_ms)}${seen}`;
  if (r.reason === 'aborted')
    return `${app}: aborted after ${secs(r.waited_ms)} while waiting for ${r.until}${seen}`;
  return `${app}: ${r.reason} (${r.status}) after ${secs(r.waited_ms)} while waiting for ${r.until}`;
}
/** `libs (completed), api (ready), logger`: a started dependency is its bare name. */
export function fmtDeps(deps: { app: string; condition: string }[]): string {
  return deps
    .map((d) =>
      d.condition === 'started' ? d.app : `${d.app} (${d.condition})`
    )
    .join(', ');
}

export function renderProject(
  d: {
    project: string;
    root: string;
    mcproc: { manifest: string | null; running: string };
    vars: VarInfo[];
    override: string | null;
    slot: number | null;
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
  },
  width?: number
): string {
  const L = [`project: ${d.project} (${d.root})`];
  const w = d.mcproc.manifest;
  if (w)
    L.push(
      `manifest: written by mcproc ${w}${w === d.mcproc.running ? '' : `, this is ${d.mcproc.running}`}`
    );
  if (d.vars.some((v) => v.source !== 'built-in') || d.override) {
    L.push(
      `vars:${d.override ? ` (override ${d.override})` : ''}${d.slot !== null ? ` slot ${d.slot}` : ''}`
    );
    for (const v of d.vars)
      L.push(`  ${v.name} = ${JSON.stringify(v.value)} (${v.source})`);
  }
  L.push('apps:');
  for (const a of d.apps)
    L.push(
      `  ${a.name} [${a.kind}]${a.host ? ` on ${a.host}` : ''}${a.ports.length ? ` :${a.ports.join(',:')}` : ''}${a.url ? ` → ${a.url}` : ''}${a.depends_on.length ? ` after ${fmtDeps(a.depends_on)}` : ''}: ${a.description}`
    );
  L.push('profiles:');
  for (const [p, apps] of Object.entries(d.profiles))
    L.push(`  ${p}: ${apps.join(', ')}`);
  // the hosts table is indented by two columns: it fits what is left of the width
  L.push(
    'hosts:',
    renderHosts(d.hosts, width === undefined ? undefined : width - 2)
      .split('\n')
      .map((x) => `  ${x}`)
      .join('\n')
  );
  if (d.readme) L.push('', 'README:', d.readme.trim());
  return L.join('\n');
}

/**
 * Incidents newest first: a header, context lines `│`, the error line `▶`; an app's reloads are one line with the last
 * reload's line; then how to go on. Nothing new is one short line.
 */
/**
 * One incident as text: its head (app@host, time, kind, ×count, first time, stream), the lines before it, its own line
 * (red with `color`) and the lines after; a reload is one plain line (both streams, no context, not an error).
 */
export function incidentLines(
  i: Incident,
  opts: { color?: boolean } = {}
): string[] {
  const count = i.count > 1 ? ` ×${i.count}` : '';
  const first =
    i.count > 1 && i.first_time && i.first_time !== i.time
      ? i.first_time
      : null;
  if (i.kind === 'reloaded')
    return [
      `${i.app}@${i.host} ${i.time ?? '-'} reloaded${count}${first ? ` (first ${first})` : ''}: ${i.line}`,
    ];
  const red = (s: string) => (opts.color ? `\x1b[31m${s}\x1b[0m` : s);
  return [
    `${i.app}@${i.host} ${i.time ?? '-'} ${i.kind}${count} (${first ? `first ${first}, ` : ''}${i.stream})`,
    ...i.before.map((b) => `  │ ${b}`),
    red(`  ▶ ${i.line}`),
    ...i.after.map((x) => `  │ ${x}`),
  ];
}

export function renderIncidents(
  a: TakenAnswer,
  opts: { color?: boolean } = {}
): string {
  const tail: string[] = [];
  if (a.more > 0) {
    const short = a.more_by === 'size' ? ' to keep this answer short' : '';
    tail.push(
      a.taken
        ? `+${a.more} older incidents not shown${short}, taken with these (read logs for them)`
        : short
          ? `+${a.more} more incidents not shown${short} (pass app for one app, or read logs)`
          : `+${a.more} more incidents (raise max)`
    );
  }
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
  const L = a.incidents.flatMap((i) => incidentLines(i, opts));
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

/** One line per distinct note the change left on its rows, with the apps it concerns. */
export function rowNote(rows: LsRow[]): string {
  const by = new Map<string, string[]>();
  for (const r of rows)
    if (r.note) by.set(r.note, [...(by.get(r.note) ?? []), r.app]);
  return [...by]
    .map(([note, apps]) => `${apps.join(', ')}: ${note}`)
    .join('\n');
}

/** One line per queued app of a start: its position and what the head of the queue waits for. */
export function queuedNote(rows: LsRow[]): string {
  const by = new Map<string, LsRow[]>();
  for (const r of rows)
    if (r.lease) by.set(r.lease.id, [...(by.get(r.lease.id) ?? []), r]);
  return [...by.values()]
    .map((rs) => {
      const l = rs[0].lease!;
      const apps = rs.map((r) => r.app).join(', ');
      return l.state === 'starting'
        ? `${apps}: starting (lease ${l.id})`
        : `${apps}: queued #${l.position}${l.waiting_for ? `: ${l.waiting_for}` : ''} (lease ${l.id}; wait on an app, or leases)`;
    })
    .join('\n');
}

/** The queue as a table, oldest first, with the host's memory and the watcher's state above it. */
export function renderLeases(v: LeasesView, width?: number): string {
  const head = [
    `state: ${v.state_dir}`,
    v.memory
      ? `memory: ${fmtMib(v.memory.available_mib)} available of ${fmtMib(v.memory.total_mib)}`
      : 'memory: no reading on this host (leases are admitted in FIFO order without a check)',
    v.watcher
      ? `watcher: ${v.watcher.online ? `online pid ${v.watcher.pid}` : 'not running'}`
      : '',
  ].filter(Boolean);
  if (v.leases.length === 0) return [...head, 'no leases'].join('\n');
  const rows = v.leases.map((l) => [
    l.position ? `#${l.position}` : '',
    l.state,
    l.kind,
    l.project + (l.slot !== null ? ` (slot ${l.slot})` : ''),
    l.target,
    `${fmtMib(l.estimate_mib)} → ${fmtMib(l.need_mib)}`,
    Object.values(l.sources).some((s) => s.source.startsWith('measured'))
      ? 'measured'
      : 'declared',
    l.waiting_for ?? l.error ?? '',
    l.id,
  ]);
  return [
    ...head,
    table(
      [
        [
          'POS',
          'STATE',
          'KIND',
          'PROJECT',
          'TARGET',
          'EST → NEED',
          'FROM',
          'WAITING FOR / ERROR',
          'ID',
        ],
        ...rows,
      ],
      { width, flex: [4, 7], mode: 'wrap' }
    ),
  ].join('\n');
}

/** A fleet mutation's answer: when a host failed or was skipped, a first line that says which apps and why; then the table, the start and queue notes and the waits made. */
export function renderMutation(
  rows: LsRow[],
  fallback: string,
  act: string,
  waits: WaitRecord[] = [],
  width?: number
): { text: string; failed: boolean } {
  const bad = rows.filter((r) => r.error);
  const notes = [
    act === 'start' || act === 'restart' ? startNote(rows) : '',
    act === 'start' ? queuedNote(rows) : '',
    waitNote(waits),
    rowNote(rows),
  ].filter(Boolean);
  const head = bad.length
    ? `${act} partly failed: ${bad.map((r) => `${r.app} (${r.host}): ${r.error}`).join('; ')}\n`
    : '';
  return {
    text:
      head +
      renderLs(rows, fallback, [], width) +
      notes.map((n) => `\n${n}`).join(''),
    failed: bad.length > 0,
  };
}

/** One line per adopted or skipped app, the hosts not read, then the written file and its diff; `failed` when a host was not read. */
export function renderAdopted(r: AdoptResult): {
  text: string;
  failed: boolean;
} {
  const at = (h: string) => (h === 'local' ? '' : ` (${h})`);
  const lines = [
    ...r.adopted.map(
      (a) => `${a.app}: adopted ${a.ports.join(', ')}${at(a.host)}`
    ),
    ...r.skipped.map(
      (s) =>
        `${s.app}: skipped ${s.ports.join(', ')} (${s.reason})${at(s.host)}`
    ),
    ...r.errors.map(
      (e) => `${e.host} not read (${e.apps.join(', ')}): ${e.message}`
    ),
  ];
  if (r.written) lines.push(`written ${r.path}:`, ...r.diff);
  else if (lines.length === 0)
    lines.push(
      'nothing to adopt: every port the running apps hold is declared'
    );
  return { text: lines.join('\n'), failed: r.errors.length > 0 };
}

/** An exec's answer: the command, how long it waited, its lease, the exit code, then the captured tail. */
export function renderExec(command: string[], r: ExecResult): string {
  const head = `exec ${command.join(' ')}: exit ${r.code}${r.waited_ms > 1000 ? ` after ${Math.round(r.waited_ms / 1000)} s in the queue` : ''}${r.lease ? ` (lease ${r.lease.id}, ${r.lease.state})` : ''}`;
  return r.output ? `${head}\n${r.output}` : head;
}

/** A new worktree: where, its branch (new or existing), slot and project, what was copied, linked, missing and installed, its vars, then how to go on. */
export function renderWorktreeAdded(r: WorktreeAdded): string {
  const L = [
    `worktree ${r.path}`,
    `branch: ${r.branch} (${r.created_branch ? 'new' : 'existing'})`,
    `slot ${r.slot}, project ${r.project}`,
    `decided by: the ${r.manifest === 'worktree' ? "worktree's own" : "main checkout's"} manifest`,
  ];
  const mark = (e: string) =>
    r.from_override.includes(e) ? `${e} (override)` : e;
  if (r.copied.length) L.push(`copied: ${r.copied.map(mark).join(', ')}`);
  if (r.linked.length) L.push(`linked: ${r.linked.map(mark).join(', ')}`);
  if (r.excluded.length)
    L.push(
      `ignored in git: ${r.excluded.join(', ')} (the repository's info/exclude)`
    );
  if (r.missing.length) L.push(`missing: ${r.missing.join(', ')}`);
  L.push(`installed: ${r.installed ?? 'nothing'}`);
  const vars = r.vars.filter((v) => v.source !== 'built-in');
  if (vars.length) {
    L.push('vars:');
    for (const v of vars) L.push(`  ${v.name} = ${JSON.stringify(v.value)}`);
  }
  L.push(`next: ${r.next}`);
  return L.join('\n');
}

/** Every checkout of the repository as a table, slot 0 marked as the main one. */
export function renderWorktrees(rows: WorktreeRow[], width?: number): string {
  return table(
    [
      ['SLOT', 'PROJECT', 'BRANCH', 'ONLINE', 'LEASE', 'PATH'],
      ...rows.map((r) => [
        r.main ? `${r.slot} (main)` : String(r.slot),
        r.project,
        r.branch ?? '(detached)',
        String(r.online),
        r.lease ?? '-',
        r.path,
      ]),
    ],
    { width, flex: [2, 5], mode: 'wrap' }
  );
}

/** A removed worktree in one line: its path, the slot it freed, the branch it kept and the apps it stopped. */
export function renderWorktreeRemoved(r: WorktreeRemoved): string {
  return `removed ${r.path}: slot ${r.slot} is free, branch ${r.branch ?? '(detached)'} kept; stopped ${r.stopped.length ? r.stopped.join(', ') : 'nothing'}`;
}

/** A path with the home directory as ~. */
export function tildePath(p: string, home = os.homedir()): string {
  return p === home || p.startsWith(`${home}/`)
    ? `~${p.slice(home.length)}`
    : p;
}
/**
 * A stack's name: a base is its project; a worktree is `w<slot> <branch>`, indented when `nested` (its base is in the
 * same list, which puts it under that base), else after its base's name, flush left, so the row still names its project.
 */
export function stackLabel(
  s: Pick<Stack, 'project' | 'base_project' | 'slot' | 'branch'>,
  nested: boolean
): string {
  if (s.base_project === s.project) return s.project;
  const wt = `${s.slot !== null ? `w${s.slot} ` : ''}${s.branch ?? s.project}`;
  return nested ? `  ${wt}` : `${s.base_project} ${wt}`;
}
/** `online/total`, `queued #N` while its start waits, `not running` with nothing in pm2. */
export function stackApps(s: Stack): string {
  if (s.queue_position !== null && s.apps.online === 0)
    return `queued #${s.queue_position}`;
  return s.present ? `${s.apps.online}/${s.apps.total}` : 'not running';
}
/** The listening ports, the first `max` and how many more. */
export function stackPorts(s: Stack, max = 3): string {
  const ports = [...new Set(s.ports.map((p) => p.port))].sort((a, b) => a - b);
  if (ports.length === 0) return '-';
  const shown = ports
    .slice(0, max)
    .map((p) => `:${p}`)
    .join(' ');
  return ports.length > max ? `${shown} +${ports.length - max}` : shown;
}
/** `root`: the ROOT cell, absolute where it is read back as `project` (MCP, piped), with ~ on a terminal. */
const stackCells = (
  s: Stack,
  nested: boolean,
  root: (p: string) => string
): string[] => [
  stackLabel(s, nested),
  root(s.root),
  s.hosts.map((h) => h.name).join(','),
  s.manifest_error ? 'manifest error' : stackApps(s),
  String(s.apps.errored),
  s.memory ? fmtBytes(s.memory) : '-',
  s.cpu === null ? '-' : `${Math.round(s.cpu)}%`,
  stackPorts(s),
];
/** A pm2 namespace no manifest claims, as a row under STACK_HEADER. */
export const orphanCells = (o: Orphan): string[] => {
  const mem = o.processes.reduce((a, p) => a + p.memory, 0);
  return [
    `pm2 · ${o.namespace}`,
    '(no manifest)',
    o.endpoint,
    `${o.processes.filter((p) => p.status === 'online').length}/${o.processes.length}`,
    '-',
    mem ? fmtBytes(mem) : '-',
    '-',
    '-',
  ];
};
export const STACK_HEADER = [
  'STACK',
  'ROOT',
  'HOSTS',
  'APPS',
  'ERR',
  'MEM',
  'CPU',
  'PORTS',
];

export function stacksHostLine(h: StacksAnswer['host']): string {
  const mem = h.memory
    ? `RAM ${fmtMib(h.memory.available_mib)} free of ${fmtMib(h.memory.total_mib)}`
    : 'no memory reading';
  const watcher = h.watcher
    ? h.watcher.online
      ? 'watcher online'
      : 'watcher stopped'
    : 'no watcher';
  return `${h.name} · ${mem} · ${watcher} · queue ${h.queue}`;
}

/**
 * Every stack of the host: a host line, the table, then a line per manifest error, note and host that did not answer.
 * Without a width (MCP, piped) ROOT is the absolute path, which passes back as `project`; on a terminal the home is ~.
 */
export function renderStacks(
  a: StacksAnswer,
  width?: number,
  home = os.homedir()
): string {
  const lines = [`host: ${stacksHostLine(a.host)}`, ...a.host.notes];
  if (a.stacks.length === 0 && a.orphans.length === 0)
    return [
      ...lines,
      'no stacks running on this host (--all lists the recorded ones)',
    ].join('\n');
  const bases = new Set(a.stacks.map((s) => s.project));
  const root = (p: string) => (width === undefined ? p : tildePath(p, home));
  lines.push(
    table(
      [
        STACK_HEADER,
        ...a.stacks.map((s) =>
          stackCells(
            s,
            s.base_project !== s.project && bases.has(s.base_project),
            root
          )
        ),
        ...a.orphans.map(orphanCells),
      ],
      { width, flex: [1, 7], mode: 'wrap' }
    )
  );
  for (const s of a.stacks) {
    if (s.manifest_error)
      lines.push(
        `${s.project}: ${s.manifest_error.code}: ${s.manifest_error.message}${s.manifest_error.hint ? ` (${s.manifest_error.hint})` : ''}`
      );
    for (const n of s.notes) lines.push(`${s.project}: ${n}`);
    for (const h of s.hosts)
      if (h.error)
        lines.push(
          `${s.project} on ${h.name}: ${h.error}${h.age_s ? ` (last read ${h.age_s}s ago)` : ''}`
        );
  }
  for (const o of a.orphans)
    if (o.note) lines.push(`pm2 · ${o.namespace}: ${o.note}`);
  return lines.join('\n');
}

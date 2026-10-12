import { describeError, isMcprocError } from '../errors.js';
import { findProcess, type Pm2Process } from '../pm2.js';
import type { Fleet, HostError } from '../fleet.js';
import { ensureOk } from '../../transport/index.js';
import { collapse, compileRules, detect, stampOf, type Incident, type Stream } from './detect.js';
import { NOW_SNIPPET, hostNow, markKey, parseRead, readSnippet, windowStart, type AppMark, type CursorState } from './cursor.js';

export interface IncidentsAnswer {
  incidents: Incident[]; skipped: { app: string; host: string; stream: Stream; bytes: number }[];
  errors: HostError[]; more: number; apps: number; hosts: number; latest: string | null;
}
/** `budgetMs`: how long an app's own patterns may take on one file (default MATCH_BUDGET_MS). */
export interface PollOptions { cursor?: CursorState; sinceMin?: number; max?: number; context?: [number, number]; budgetMs?: number }

const EVENT_TAIL = 10;
const STREAMS: Stream[] = ['out', 'err'];

/** New incidents of the named apps since `cursor`, each app read on its own host (hosts in parallel). */
export async function pollIncidents(fleet: Fleet, names: string[], opts: PollOptions = {}): Promise<{ answer: IncidentsAnswer; next: CursorState }> {
  const sinceMin = opts.sinceMin ?? 15;
  const groups = fleet.groups(names);
  const next: CursorState = { v: 1, apps: {} };
  const skipped: IncidentsAnswer['skipped'] = [];
  const results = await Promise.all(groups.map(async (g) => {
    try {
      const ctx = await fleet.ctx(g.host);
      const procs = await ctx.pm2.jlist();
      const targets = g.apps.flatMap((app) => {
        const settings = fleet.manifest.apps[app].errors;
        const p = findProcess(procs, fleet.manifest.project, app);
        return p && settings ? [{ app, p, settings, prev: opts.cursor?.apps[markKey(g.host, app)] }] : [];
      });
      if (targets.length === 0) return { incidents: [] as Incident[], latest: null as string | null, stalled: [] as HostError[] };
      const files = targets.flatMap((t) => STREAMS.map((stream) => {
        const path = stream === 'out' ? t.p.out_log : t.p.err_log;
        const mark = t.prev?.[stream];
        return { t, stream, path, offset: mark && mark.path === path ? mark.offset : null };
      }));
      const res = ensureOk(await ctx.transport.exec([NOW_SNIPPET, ...files.map((f, i) => readSnippet(i, f.path, f.offset))].join('; ')), ctx.host, 'read logs for incidents');
      const now = hostNow(res.stdout); // one cutoff for every file of this host: a first call looks back from the host's clock
      const incidents: Incident[] = [];
      let latest: string | null = null;
      const perApp = new Map<string, { mark: AppMark; errLines: string[] }>();
      const stalled = new Map<string, string>();
      files.forEach((f, i) => {
        const r = parseRead(res.stdout, i, f.offset);
        const entry = perApp.get(f.t.app) ?? { mark: { restarts: f.t.p.restarts, status: f.t.p.status }, errLines: [] };
        perApp.set(f.t.app, entry);
        if (!r) return;
        entry.mark[f.stream] = { path: f.path, offset: r.nextOffset };
        if (f.stream === 'err') entry.errLines = r.lines;
        if (r.skipped > 0) skipped.push({ app: f.t.app, host: g.host, stream: f.stream, bytes: r.skipped });
        for (let k = r.lines.length - 1; k >= r.contextOnly; k--) { const t = stampOf(r.lines[k]); if (t) { if (!latest || t > latest) latest = t; break; } }
        const from = f.offset === null ? windowStart(r.lines, sinceMin, now) : null; // a first call: only the last minutes, by the host's clock
        const contextOnly = from ? Math.max(r.contextOnly, insideFrom(r.lines, from)) : r.contextOnly;
        try {
          incidents.push(...detect({ stream: f.stream, lines: r.lines, contextOnly }, compileRules(f.t.settings, opts.context, opts.budgetMs), { app: f.t.app, host: g.host }));
        } catch (e) {
          if (!isMcprocError(e) || e.code !== 'TIMEOUT') throw e;
          stalled.set(f.t.app, describeError(e)); // its own patterns ran away: this app waits, the others go on
        }
      });
      for (const t of targets) {
        if (stalled.has(t.app)) continue; // not analysed: its point stays, the next poll reads the same lines again
        const entry = perApp.get(t.app)!;
        next.apps[markKey(g.host, t.app)] = entry.mark;
        incidents.push(...processEvents(t.app, g.host, t.p, t.prev, entry.errLines));
      }
      return { incidents: incidents.filter((i) => !stalled.has(i.app)), latest, stalled: [...stalled].map(([app, message]) => ({ host: g.host, apps: [app], message })) };
    } catch (e) {
      return { error: { host: g.host, apps: g.apps, message: describeError(e) }, cause: e };
    }
  }));
  const failed = results.filter((r): r is { error: HostError; cause: unknown } => 'error' in r);
  if (failed.length === results.length && failed.length > 0) throw failed[0].cause;
  const ok = results.filter((r): r is { incidents: Incident[]; latest: string | null; stalled: HostError[] } => !('error' in r));
  const all = collapse(ok.flatMap((r) => r.incidents)).sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
  const max = opts.max ?? 20;
  const latest = ok.map((r) => r.latest).filter((t): t is string => t !== null).sort().at(-1) ?? null;
  return {
    answer: { incidents: all.slice(0, max), skipped, errors: [...failed.map((f) => f.error), ...ok.flatMap((r) => r.stalled)], more: Math.max(0, all.length - max), apps: names.length, hosts: groups.length, latest },
    next,
  };
}

/** Index of the first line inside a first call's window; the lines before it are context only (an unstamped line goes with the one before it). */
function insideFrom(lines: string[], from: string): number {
  let t: string | null = null;
  for (let i = 0; i < lines.length; i++) { t = stampOf(lines[i]) ?? t; if (t !== null && t >= from) return i; }
  return lines.length;
}

/** pm2's view of an app since the last poll: gave up (errored, reported once) or restarted (with how many times). */
function processEvents(app: string, host: string, p: Pm2Process, prev: AppMark | undefined, errLines: string[]): Incident[] {
  const tail = errLines.slice(-EVENT_TAIL);
  const time = [...tail].reverse().map(stampOf).find((t) => t !== null) ?? null;
  const event = (kind: 'crashed' | 'restarted', count: number, line: string): Incident =>
    ({ app, host, kind, stream: 'err', time, first_time: time, count, line, before: tail, after: [], fingerprint: `pm2:${kind}` });
  const out: Incident[] = [];
  if (p.status === 'errored' && prev?.status !== 'errored') out.push(event('crashed', 1, `pm2: ${app} crashed (status errored)`));
  if (prev && p.restarts > prev.restarts) out.push(event('restarted', p.restarts - prev.restarts, `pm2: ${app} restarted ${p.restarts - prev.restarts} time(s)`));
  return out;
}

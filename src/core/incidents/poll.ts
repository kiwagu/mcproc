import { describeError, isMcprocError } from '../errors.js';
import { findProcess, type Pm2Process } from '../pm2.js';
import type { Fleet, HostError } from '../fleet.js';
import { ensureOk } from '../../transport/index.js';
import { CLOCK_SNIPPET, hostClock, hostStamp } from '../logsince.js';
import { laterStamp } from './taken.js';
import {
  beforeStart,
  compileReloadRules,
  ReloadTracker,
  type Reload,
  type ReloadInput,
} from '../reloads.js';
import {
  collapse,
  cutContext,
  compileRules,
  detect,
  stampOf,
  type Incident,
  type Stream,
} from './detect.js';
import {
  NOW_SNIPPET,
  hostNow,
  markKey,
  type Anchor,
  parseRead,
  readSnippet,
  windowStart,
  type AppMark,
  type CursorState,
} from './cursor.js';

export interface IncidentsAnswer {
  incidents: Incident[];
  skipped: { app: string; host: string; stream: Stream; bytes: number }[];
  errors: HostError[];
  more: number;
  /** why `more` incidents were left out, when any were: past `max`, or past the answer's size budget */
  more_by?: 'max' | 'size';
  apps: number;
  hosts: number;
  latest: string | null;
  /**
   * Only for a caller that passed `restart`: per host/app, the files this poll positioned (read, or left to read again
   * from where it began). A restart of any other file was not applied (its host failed, its app stalled or is not
   * running), so the caller keeps it for its next poll.
   */
  positioned?: Record<string, Stream[]>;
}
/**
 * `budgetMs`: how long an app's own patterns may take on one file (default MATCH_BUDGET_MS). `includeReloads`: also
 * report each app's in-process reloads since the last poll, as one `reloaded` incident per app (apps with `reloads`).
 */
export interface PollOptions {
  cursor?: CursorState;
  sinceMin?: number;
  max?: number;
  /** the size budget of the answer's incidents, in characters (default ANSWER_CHARS; Infinity for none) */
  chars?: number;
  context?: [number, number];
  budgetMs?: number;
  includeReloads?: boolean;
  /**
   * Files a caller with its own position knows were emptied since it last read them, per host/app and stream: their
   * paths, or `*` for whichever file the stream writes now. The file pm2 writes is read from its start when it is one of
   * them, whatever the cursor says (an old offset would skip a file that regrew past it, and a new path would read only
   * the last minutes).
   */
  restart?: Record<string, Partial<Record<Stream, string[]>>>;
}

/** How far back a first call looks, in minutes, when it names no window of its own. */
export const DEFAULT_SINCE_MIN = 15;
/**
 * How many characters of incident text an answer carries, newest first: the rest are counted in `more` (and taken
 * with the others), so one burst of huge lines never overflows a client's tool-result limit. One incident always shows.
 */
export const ANSWER_CHARS = 20_000;
const EVENT_TAIL = 10;
const STREAMS: Stream[] = ['out', 'err'];

/** New incidents of the named apps since `cursor`, each app read on its own host (hosts in parallel). */
export async function pollIncidents(
  fleet: Fleet,
  names: string[],
  opts: PollOptions = {}
): Promise<{ answer: IncidentsAnswer; next: CursorState }> {
  const sinceMin = opts.sinceMin ?? DEFAULT_SINCE_MIN;
  const groups = fleet.groups(names);
  const next: CursorState = { v: 1, apps: {} };
  const skipped: IncidentsAnswer['skipped'] = [];
  const results = await Promise.all(
    groups.map(async (g) => {
      try {
        const ctx = await fleet.ctx(g.host);
        const procs = await ctx.pm2.jlist();
        const targets = g.apps.flatMap((app) => {
          const settings = fleet.manifest.apps[app].errors;
          const reloads = opts.includeReloads
            ? fleet.manifest.apps[app].reloads
            : null; // an app takes part for its errors, its reloads, or both
          const p = findProcess(procs, fleet.manifest.project, app);
          return p && (settings || reloads)
            ? [
                {
                  app,
                  p,
                  settings,
                  reloads,
                  prev: opts.cursor?.apps[markKey(g.host, app)],
                },
              ]
            : [];
        });
        if (targets.length === 0)
          return {
            incidents: [] as Incident[],
            latest: null as string | null,
            stalled: [] as HostError[],
          };
        const files = targets.flatMap((t) =>
          STREAMS.map((stream) => {
            const path = stream === 'out' ? t.p.out_log : t.p.err_log;
            const mark = t.prev?.[stream];
            const same = mark && mark.path === path;
            const emptied = opts.restart?.[markKey(g.host, t.app)]?.[stream];
            const restarted =
              !!emptied && (emptied.includes(path) || emptied.includes('*'));
            const anchor: Anchor | null =
              !restarted &&
              same &&
              mark.at !== undefined &&
              mark.anchor !== undefined
                ? { at: mark.at, hex: mark.anchor }
                : null;
            return {
              t,
              stream,
              path,
              offset: restarted ? 0 : same ? mark.offset : null,
              anchor,
              restarted,
            };
          })
        );
        const res = ensureOk(
          await ctx.transport.exec(
            [
              NOW_SNIPPET,
              ...(opts.includeReloads ? [CLOCK_SNIPPET] : []), // the host's zone puts pm2's start in the stamps' wall time
              ...files.map((f, i) =>
                readSnippet(i, f.path, f.offset, f.anchor)
              ),
            ].join('; ')
          ),
          ctx.host,
          'read logs for incidents'
        );
        const now = hostNow(res.stdout); // one cutoff for every file of this host: a first call looks back from the host's clock
        const zone = opts.includeReloads
          ? (hostClock(res.stdout)?.zone ?? null)
          : null;
        const incidents: Incident[] = [];
        let latest: string | null = null;
        const perApp = new Map<
          string,
          {
            mark: AppMark;
            errLines: string[];
            newLines: ReloadInput[];
            ctxStamps: string[];
          }
        >();
        const stalled = new Map<string, string>();
        files.forEach((f, i) => {
          const r = parseRead(res.stdout, i, f.offset);
          const entry = perApp.get(f.t.app) ?? {
            mark: { restarts: f.t.p.restarts, status: f.t.p.status },
            errLines: [],
            newLines: [],
            ctxStamps: [],
          };
          perApp.set(f.t.app, entry);
          if (!r) return;
          const was = f.t.prev?.[f.stream]?.stamp; // what earlier takes have read here stays read
          if (r.short) {
            if (f.restarted)
              entry.mark[f.stream] = {
                path: f.path,
                offset: 0,
                ...(was ? { stamp: was } : {}),
              };
            else if (f.t.prev?.[f.stream])
              entry.mark[f.stream] = f.t.prev[f.stream];
            return;
          } // read again next poll from where this one began: nothing analysed, nothing taken
          const stamp = laterStamp(was, lastStamp(r.lines));
          entry.mark[f.stream] = {
            path: f.path,
            offset: r.nextOffset,
            ...(r.anchor ? { at: r.anchor.at, anchor: r.anchor.hex } : {}),
            ...(stamp ? { stamp } : {}),
          };
          if (f.stream === 'err') entry.errLines = r.lines;
          if (r.skipped > 0)
            skipped.push({
              app: f.t.app,
              host: g.host,
              stream: f.stream,
              bytes: r.skipped,
            });
          for (let k = r.lines.length - 1; k >= r.contextOnly; k--) {
            const t = stampOf(r.lines[k]);
            if (t) {
              if (!latest || t > latest) latest = t;
              break;
            }
          }
          const from =
            f.offset === null ? windowStart(r.lines, sinceMin, now) : null; // a first call: only the last minutes, by the host's clock
          const contextOnly = from
            ? Math.max(r.contextOnly, insideFrom(r.lines, from))
            : r.contextOnly;
          if (f.t.reloads) {
            const before = lastStampBefore(r.lines, contextOnly);
            if (before) entry.ctxStamps.push(before);
            for (const text of r.lines.slice(contextOnly))
              entry.newLines.push({ stream: f.stream, text });
          }
          if (!f.t.settings) return; // errors: false, here for its reloads only
          try {
            incidents.push(
              ...detect(
                { stream: f.stream, lines: r.lines, contextOnly },
                compileRules(f.t.settings, opts.context, opts.budgetMs),
                { app: f.t.app, host: g.host }
              )
            );
          } catch (e) {
            if (!isMcprocError(e) || e.code !== 'TIMEOUT') throw e;
            stalled.set(f.t.app, describeError(e)); // its own patterns ran away: this app waits, the others go on
          }
        });
        for (const t of targets) {
          const entry = perApp.get(t.app)!;
          if (t.reloads && !stalled.has(t.app)) {
            const start =
              t.p.started_at !== null && zone
                ? hostStamp(t.p.started_at, zone)
                : null;
            try {
              const tracker = new ReloadTracker(
                compileReloadRules(t.reloads, opts.budgetMs),
                {
                  app: t.app,
                  start,
                  coversStart: bootAhead(start, t.prev, entry.ctxStamps),
                }
              );
              const found = [
                ...tracker.push(entry.newLines, 0),
                ...tracker.flush(),
              ];
              entry.mark.start = start;
              entry.mark.boot = tracker.awaitingBoot; // no burst closed: the boot is still to come
              if (found.length) incidents.push(reloaded(t.app, g.host, found));
            } catch (e) {
              if (!isMcprocError(e) || e.code !== 'TIMEOUT') throw e;
              stalled.set(t.app, describeError(e));
            }
          }
          if (stalled.has(t.app)) continue; // not analysed: its point stays, the next poll reads the same lines again
          next.apps[markKey(g.host, t.app)] = entry.mark;
          if (t.settings)
            incidents.push(
              ...processEvents(t.app, g.host, t.p, t.prev, entry.errLines)
            );
        }
        return {
          incidents: incidents.filter((i) => !stalled.has(i.app)),
          latest,
          stalled: [...stalled].map(([app, message]) => ({
            host: g.host,
            apps: [app],
            message,
          })),
        };
      } catch (e) {
        return {
          error: { host: g.host, apps: g.apps, message: describeError(e) },
          cause: e,
        };
      }
    })
  );
  const failed = results.filter(
    (r): r is { error: HostError; cause: unknown } => 'error' in r
  );
  if (failed.length === results.length && failed.length > 0)
    throw failed[0].cause;
  const ok = results.filter(
    (
      r
    ): r is {
      incidents: Incident[];
      latest: string | null;
      stalled: HostError[];
    } => !('error' in r)
  );
  const all = collapse(ok.flatMap((r) => r.incidents)).sort((a, b) =>
    (b.time ?? '').localeCompare(a.time ?? '')
  );
  const max = opts.max ?? 20;
  const capped = all.slice(0, max);
  const shown = withinBudget(capped, opts.chars ?? ANSWER_CHARS);
  const more = all.length - shown.length;
  const latest =
    ok
      .map((r) => r.latest)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1) ?? null;
  return {
    answer: {
      incidents: shown,
      skipped,
      errors: [...failed.map((f) => f.error), ...ok.flatMap((r) => r.stalled)],
      more,
      ...(more > 0
        ? { more_by: shown.length < capped.length ? 'size' : 'max' }
        : {}),
      apps: names.length,
      hosts: groups.length,
      latest,
      ...(opts.restart
        ? {
            positioned: Object.fromEntries(
              Object.entries(next.apps).map(([k, m]) => [
                k,
                STREAMS.filter((st) => m[st] !== undefined),
              ])
            ),
          }
        : {}),
    },
    next,
  };
}

/** The newest incidents whose text fits in `chars`, in order; the first always fits. */
function withinBudget(incidents: Incident[], chars: number): Incident[] {
  const out: Incident[] = [];
  let used = 0;
  for (const i of incidents) {
    const size =
      i.line.length +
      i.before.reduce((n, l) => n + l.length, 0) +
      i.after.reduce((n, l) => n + l.length, 0);
    if (out.length > 0 && used + size > chars) break;
    out.push(i);
    used += size;
  }
  return out;
}

/** The stamp of the last stamped line read (pm2's, as the file has it); null when none is stamped. */
function lastStamp(lines: string[]): string | null {
  for (let k = lines.length - 1; k >= 0; k--) {
    const t = stampOf(lines[k]);
    if (t) return t;
  }
  return null;
}

/** Index of the first line inside a first call's window; the lines before it are context only (an unstamped line goes with the one before it). */
function insideFrom(lines: string[], from: string): number {
  let t: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    t = stampOf(lines[i]) ?? t;
    if (t !== null && t >= from) return i;
  }
  return lines.length;
}

/** The stamp of the last stamped line before index `end`; null when none is. */
function lastStampBefore(lines: string[], end: number): string | null {
  for (let k = end - 1; k >= 0; k--) {
    const t = stampOf(lines[k]);
    if (t) return t;
  }
  return null;
}

/**
 * Whether the run's boot may still come in the lines this poll analyses. A run looked at before keeps the state that
 * poll left; a new run since then has its boot ahead. A run not looked at yet (a first poll, or polls without reloads):
 * its boot is behind the point when a line before the analysed ones (`ctxStamps`, the last stamp of each stream's
 * context) is of this run. Without a start nothing is taken for the boot.
 */
function bootAhead(
  start: string | null,
  prev: AppMark | undefined,
  ctxStamps: string[]
): boolean {
  if (start === null) return false;
  if (prev?.start === start) return prev.boot === true;
  if (typeof prev?.start === 'string') return true;
  return ctxStamps.every((s) => beforeStart(s, start));
}

/**
 * An app's reloads of one poll as one incident: how many, the first and the last one's time, the last one's line (its
 * first restart or rebuild line, else its first line). Times are the stamps as pm2 wrote them on those lines, like the other incidents' (an unstamped marker line keeps
 * the stamp it inherited).
 */
const reloaded = (app: string, host: string, rs: Reload[]): Incident => ({
  app,
  host,
  kind: 'reloaded',
  stream: 'out',
  time: stampOf(rs[rs.length - 1].line) ?? rs[rs.length - 1].time,
  first_time: stampOf(rs[0].line) ?? rs[0].time,
  count: rs.length,
  line: rs[rs.length - 1].line,
  before: [],
  after: [],
  fingerprint: 'reloaded',
});

/** pm2's view of an app since the last poll: gave up (errored, reported once) or restarted (with how many times). */
function processEvents(
  app: string,
  host: string,
  p: Pm2Process,
  prev: AppMark | undefined,
  errLines: string[]
): Incident[] {
  const last = errLines.slice(-EVENT_TAIL);
  const time =
    [...last]
      .reverse()
      .map(stampOf)
      .find((t) => t !== null) ?? null;
  const tail = last.map(cutContext); // context, cut like any other incident's
  const event = (
    kind: 'crashed' | 'restarted',
    count: number,
    line: string
  ): Incident => ({
    app,
    host,
    kind,
    stream: 'err',
    time,
    first_time: time,
    count,
    line,
    before: tail,
    after: [],
    fingerprint: `pm2:${kind}`,
  });
  const out: Incident[] = [];
  if (p.status === 'errored' && prev?.status !== 'errored')
    out.push(event('crashed', 1, `pm2: ${app} crashed (status errored)`));
  if (prev && p.restarts > prev.restarts)
    out.push(
      event(
        'restarted',
        p.restarts - prev.restarts,
        `pm2: ${app} restarted ${p.restarts - prev.restarts} time(s)`
      )
    );
  return out;
}

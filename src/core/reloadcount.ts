import { describeError, isMcprocError } from './errors.js';
import type { Fleet, HostError, HostProbe } from './fleet.js';
import type { LsRow } from './list.js';
import { msStamp } from './logsince.js';
import { findProcess } from './pm2.js';
import {
  beforeStart,
  compileReloadRules,
  detectReloads,
  type ReloadInput,
} from './reloads.js';
import { stampOf } from './incidents/detect.js';
import {
  CONTEXT_BYTES,
  parseRead,
  readSnippet,
  type FileRead,
} from './incidents/cursor.js';
import { ensureOk } from '../transport/index.js';

/**
 * A log read from its first byte began with this run when its first stamped line comes this soon after the start (a
 * slow boot included); a log cleared during the run (flush, monit's c) also begins at byte 0, with lines from long after.
 */
const FRESH_LOG_MS = 60_000;
/** pm2 statuses of a process that is running this run: an app that is not has no reloads to count. */
const RUNNING = new Set(['online', 'launching']);
const STREAMS = ['out', 'err'] as const;

type Counted = NonNullable<LsRow['reloads']>;
/**
 * How far back one stream's read reaches. `start`: it holds a line of an earlier run (stamped before the start), or it
 * begins at the file's first byte with its first stamped line soon after the start. `nothing`: it begins at the first
 * byte and holds no stamped line, so this run left nothing there to count. `after`: the read is the last part of a longer
 * log, the log was cleared during the run, or the read did not come through whole.
 */
type Reach = 'start' | 'nothing' | 'after';

const wallMs = (stamp: string): number => Date.parse(`${msStamp(stamp)}Z`);

function reach(r: FileRead | null, started: string): Reach {
  if (!r || r.short) return 'after';
  const stamps = r.lines.map(stampOf).filter((t): t is string => t !== null);
  if (stamps.some((t) => beforeStart(t, started))) return 'start';
  if (r.start > CONTEXT_BYTES) return 'after'; // a read begins CONTEXT_BYTES before its start, at byte 0 at the earliest
  if (stamps.length === 0) return 'nothing';
  return wallMs(stamps[0]) - wallMs(started) <= FRESH_LOG_MS
    ? 'start'
    : 'after';
}

/**
 * Each running app's in-process reloads since pm2 started it (ls --reloads), on top of the rows and probes of listFleet:
 * one read script per host over the out and err logs of its apps that run with reloads on and a known start (at most the
 * last READ_CAP bytes of each), hosts in parallel. The count is partial when a stream's read does not reach back to the
 * start; the first `listening`-only burst is taken for the boot only when one does. Rows of other apps come back as they
 * were; a host whose read fails, or an app whose own reloads patterns run away, keeps its rows without a count and is
 * named in errors. `budgetMs`: how long an app's own patterns may take (default MATCH_BUDGET_MS).
 */
export async function countReloads(
  fleet: Fleet,
  probes: HostProbe[],
  rows: LsRow[],
  opts: { budgetMs?: number } = {}
): Promise<{ rows: LsRow[]; errors: HostError[] }> {
  const counted = new Map<string, Counted>();
  const perHost = await Promise.all(
    probes.map(async (p): Promise<HostError[]> => {
      const { ctx, snap } = p;
      if (!ctx || !snap) return []; // a host the probe did not reach is already in the errors
      const targets = rows.flatMap((row) => {
        const settings = fleet.manifest.apps[row.app]?.reloads;
        const proc = findProcess(snap.procs, fleet.manifest.project, row.app);
        return row.host === p.host &&
          p.apps.includes(row.app) &&
          settings &&
          proc &&
          row.started !== null &&
          RUNNING.has(row.status)
          ? [
              {
                app: row.app,
                started: row.started,
                settings,
                logs: [proc.out_log, proc.err_log],
              },
            ]
          : [];
      });
      if (targets.length === 0) return [];
      const id = (k: number, s: number) => k * STREAMS.length + s;
      let stdout: string;
      try {
        stdout = ensureOk(
          await ctx.transport.exec(
            targets
              .flatMap((t, k) =>
                t.logs.map((log, s) => readSnippet(id(k, s), log, null, null))
              )
              .join('; ')
          ),
          ctx.host,
          'read logs for reloads'
        ).stdout;
      } catch (e) {
        return [
          {
            host: p.host,
            apps: targets.map((t) => t.app),
            message: `reloads not counted: ${describeError(e)}`,
          },
        ];
      }
      const errors: HostError[] = [];
      targets.forEach((t, k) => {
        const reads = STREAMS.map((_, s) => parseRead(stdout, id(k, s), null));
        const reaches = reads.map((r) => reach(r, t.started));
        const input: ReloadInput[] = reads.flatMap((r, s) =>
          r && !r.short
            ? r.lines.map((text) => ({ stream: STREAMS[s], text }))
            : []
        );
        try {
          const found = detectReloads(
            input,
            compileReloadRules(t.settings, opts.budgetMs),
            {
              app: t.app,
              start: t.started,
              // lines of the run's beginning are in the read: its first `listening`-only burst may be the boot
              coversStart: reaches.includes('start'),
            }
          );
          const last = found.at(-1);
          counted.set(t.app, {
            count: found.length,
            last: last ? (stampOf(last.line) ?? last.time) : null,
            partial: reaches.includes('after'),
          });
        } catch (e) {
          if (!isMcprocError(e) || e.code !== 'TIMEOUT') throw e;
          errors.push({
            host: p.host,
            apps: [t.app],
            message: `reloads not counted: ${describeError(e)}`,
          }); // its own patterns ran away: this app goes without a count, the others are counted
        }
      });
      return errors;
    })
  );
  return {
    rows: rows.map((r) => {
      const c = counted.get(r.app);
      return c ? { ...r, reloads: c } : r;
    }),
    errors: perHost.flat(),
  };
}

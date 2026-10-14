import { describeError, isMcprocError } from './errors.js';
import {
  listFleet,
  type Fleet,
  type HostError,
  type HostProbe,
} from './fleet.js';
import type { LsRow } from './list.js';
import { findProcess, isRunning } from './pm2.js';
import {
  compileReloadRules,
  detectReloads,
  reach,
  reloadCount,
  type ReloadCount,
  type ReloadInput,
} from './reloads.js';
import { CONTEXT_BYTES, parseRead, readSnippet } from './incidents/cursor.js';
import { ensureOk } from '../transport/index.js';
import { shq } from '../transport/quote.js';

const STREAMS = ['out', 'err'] as const;

/**
 * A log that exists but the host's user may not read measures as empty, which would count as an exact zero. Before
 * its reads the script names each such log by its read's id, and ends that part with UNREAD_END: never inside a read's
 * output, and after whatever a login shell prints first.
 */
const unreadMark = (id: number) => `__MCPROC_RL_UNREAD_${id}__`;
const UNREAD_END = '__MCPROC_RL_UNREAD_END__';
const unreadChecks = (reads: { id: number; log: string }[]): string[] => [
  ...reads.map(({ id, log }) => {
    const f = shq(log);
    return `[ ! -e ${f} ] || [ -r ${f} ] || echo ${unreadMark(id)}`; // a missing log is no failure: nothing written yet
  }),
  `echo ${UNREAD_END}`,
];
function unreadIds(stdout: string): Set<number> {
  const end = stdout.indexOf(`${UNREAD_END}\n`);
  return new Set(
    [
      ...(end < 0 ? '' : stdout.slice(0, end)).matchAll(
        /^__MCPROC_RL_UNREAD_(\d+)__$/gm
      ),
    ].map((m) => Number(m[1]))
  );
}

/**
 * Each running app's in-process reloads since pm2 started it (ls --reloads), on top of the rows and probes of listFleet:
 * one read script per host over the out and err logs of its apps that run with reloads on and a known start (at most the
 * last READ_CAP bytes of each), hosts in parallel. The count is partial when a stream's read does not reach back to the
 * start; the first `listening`-only burst is taken for the boot only when one does. Rows of other apps come back as they
 * were; a host whose read fails, an app with a log that exists but may not be read, or an app whose own reloads patterns
 * run away keeps its rows without a count and is named in errors. `budgetMs`: how long an app's own patterns may take
 * (default MATCH_BUDGET_MS).
 */
export async function countReloads(
  fleet: Fleet,
  probes: HostProbe[],
  rows: LsRow[],
  opts: { budgetMs?: number } = {}
): Promise<{ rows: LsRow[]; errors: HostError[] }> {
  const counted = new Map<string, ReloadCount>();
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
          isRunning(row.status)
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
      const files = targets.flatMap((t, k) =>
        t.logs.map((log, s) => ({ id: id(k, s), log }))
      );
      let stdout: string;
      try {
        stdout = ensureOk(
          await ctx.transport.exec(
            [
              ...unreadChecks(files),
              ...files.map((f) => readSnippet(f.id, f.log, null, null)),
            ].join('; ')
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
      const unread = unreadIds(stdout);
      targets.forEach((t, k) => {
        const denied = t.logs.filter((_, s) => unread.has(id(k, s)));
        if (denied.length) {
          errors.push({
            host: p.host,
            apps: [t.app],
            message: `reloads not counted: cannot read ${denied.length > 1 ? `the logs ${denied.join(' and ')}` : `the log ${denied[0]}`} of ${t.app}`,
          });
          return;
        }
        const reads = STREAMS.map((_, s) => parseRead(stdout, id(k, s), null));
        // a read that did not come through whole reaches nowhere; one begins CONTEXT_BYTES before its start, at byte 0 at the earliest
        const reaches = reads.map((r) =>
          r && !r.short
            ? reach(r.lines, t.started, r.start <= CONTEXT_BYTES)
            : 'after'
        );
        const input: ReloadInput[] = reads.flatMap((r, s) =>
          r && !r.short
            ? r.lines.map((text) => ({ stream: STREAMS[s], text }))
            : []
        );
        const rules = compileReloadRules(t.settings, opts.budgetMs);
        try {
          counted.set(
            t.app,
            reloadCount(reaches, (coversStart) =>
              detectReloads(input, rules, {
                app: t.app,
                start: t.started,
                coversStart,
              })
            )
          );
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

/**
 * What `ls` answers: the rows of the named apps from listFleet, and with `reloads` each running app's reloads counted
 * on top (countReloads, one more read per host). `errors`: the hosts not probed, then the logs not read or counted;
 * `unread`: those last ones alone, which the table names beside the rows. Without `reloads` it is listFleet as is.
 */
export async function listWithReloads(
  fleet: Fleet,
  names: string[],
  reloads: boolean
): Promise<{ rows: LsRow[]; errors: HostError[]; unread: HostError[] }> {
  const listed = await listFleet(fleet, names);
  if (!reloads) return { rows: listed.rows, errors: listed.errors, unread: [] };
  const r = await countReloads(fleet, listed.probes, listed.rows);
  return {
    rows: r.rows,
    errors: [...listed.errors, ...r.errors],
    unread: r.errors,
  };
}

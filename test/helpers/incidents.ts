import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../src/core/manifest.js';
import { Fleet } from '../../src/core/fleet.js';
import { McprocError } from '../../src/core/errors.js';
import { fakeCtx } from './ctx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fleetDir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
export const fleetManifest = loadManifest(fleetDir);
/** pm2's stamp for 2026-10-12T11:00:<sec>, with the separator pm2 writes after it. */
export const S = (sec: number) =>
  `2026-10-12T11:00:${String(sec).padStart(2, '0')}: `;
/**
 * `short`: files whose read delivers only half of what it announced (a file rotated between measuring and reading).
 * `clocks`: one host's own `now` and `zone` in place of the shared ones (hosts in different time zones).
 */
export interface FakeState {
  files: Record<string, string>;
  procs: Record<string, object[]>;
  now?: string;
  zone?: string;
  clocks?: Record<string, { now?: string; zone?: string }>;
  unwritable?: string[];
  short?: string[];
}

/**
 * Hosts whose log files live in memory: the read script is answered from `files` (and the host's clock from `now` and
 * `zone`; a state without `now` answers a garbled clock line, a host whose `date` printed nothing), jlist from `procs`,
 * a flush empties files.
 */
export function fakeHosts(
  state: FakeState,
  down: string[] = [],
  manifest = fleetManifest
) {
  const reads: string[] = [];
  const clock = (host: string) => {
    const c = { now: state.now, zone: state.zone, ...state.clocks?.[host] };
    return `__MCPROC_LS_CLOCK__ ${c.now ?? ''} ${c.zone ?? '+0000'}\n`;
  };
  const fleet = new Fleet(manifest, undefined, async (_m, host, fallback) => {
    if (down.includes(host))
      throw new McprocError(
        'TRANSPORT_FAILED',
        `ssh ${host}: Connection refused`
      );
    return fakeCtx(
      fleetDir,
      host,
      [
        {
          match: /pm2 'jlist'/,
          result: () => ({ stdout: JSON.stringify(state.procs[host] ?? []) }),
        },
        {
          match: '__MCPROC_INC_',
          result: (cmd: string) => {
            reads.push(host);
            return {
              stdout:
                (cmd.includes('__MCPROC_NOW__')
                  ? `__MCPROC_NOW__ ${state.now ?? ''}\n`
                  : '') +
                (cmd.includes('__MCPROC_LS_CLOCK__') ? clock(host) : '') +
                answerReads(cmd, state.files, state.short ?? []),
            };
          },
        },
        {
          // a since script with no file to read (no app started there) asks only for the clock
          match: '__MCPROC_LS_CLOCK__',
          result: () => ({ stdout: clock(host) }),
        },
        {
          match: ': > ',
          result: (cmd: string) => ({
            stdout: answerFlush(cmd, state.files, state.unwritable ?? []),
          }),
        },
      ],
      fallback
    );
  });
  return { fleet, reads };
}
/** Executes the read snippets against the in-memory files: same arithmetic as the shell. */
export function answerReads(
  cmd: string,
  files: Record<string, string>,
  short: string[] = []
): string {
  let out = '';
  for (const part of cmd.split('echo __MCPROC_INC_').slice(1)) {
    const id = Number(/^(\d+)__/.exec(part)![1]);
    const file = /wc -c < '([^']+)'/.exec(part)![1];
    const off = Number(/off=(-?\d+)/.exec(part)![1]);
    const at = Number(/ at=(-?\d+)/.exec(part)?.[1] ?? -1);
    const ah = /ah='([0-9a-f]*)'/.exec(part)?.[1] ?? '';
    const buf = Buffer.from(files[file] ?? '', 'utf8');
    const sz = buf.length;
    const hex16 = (end: number) =>
      buf.subarray(Math.max(0, end - 16), end).toString('hex');
    const same = at < 0 || (sz >= at && hex16(at) === ah); // a replaced file reads from its start
    let st = off >= 0 && sz >= off && same ? off : 0;
    if (sz - st > 1048576) st = sz - 1048576;
    const cs = Math.max(0, st - 4096);
    const body = buf.subarray(cs);
    out += `__MCPROC_INC_${id}__\n${sz} ${st} ${cs} ${hex16(sz)}\n${(short.includes(file) ? body.subarray(0, Math.floor(body.length / 2)) : body).toString('utf8')}`;
  }
  return out;
}
/** Executes a flush against the in-memory files: each file's size before, then whether it is empty now (an unwritable one stays). */
function answerFlush(
  cmd: string,
  files: Record<string, string>,
  unwritable: string[]
): string {
  return `${[...cmd.matchAll(/: > '([^']+)'/g)]
    .map(([, f]) => {
      const n = Buffer.byteLength(files[f] ?? '');
      if (unwritable.includes(f)) return `${n}\nfail`;
      files[f] = '';
      return `${n}\nok`;
    })
    .join('\n')}\n`;
}
export const proc = (app: string, pm_id: number, extra: object = {}) => ({
  pid: 100 + pm_id,
  name: `fleet-${app}`,
  pm_id,
  pm2_env: {
    status: 'online',
    namespace: 'fleet',
    restart_time: 0,
    pm_out_log_path: `/l/${app}-out`,
    pm_err_log_path: `/l/${app}-err`,
    ...extra,
  },
});

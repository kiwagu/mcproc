import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { McprocError } from '../errors.js';
import { flushLogs } from '../logs.js';
import { assertWritableRuns, type Fleet } from '../fleet.js';
import {
  markKey,
  mergeCursor,
  type CursorState,
  type FileMark,
} from './cursor.js';
import {
  pollIncidents,
  type IncidentsAnswer,
  type PollOptions,
} from './poll.js';

/**
 * The pick-up point of a project, shared by every session, agent and CLI call on this machine: per `host/app` where
 * incidents were last taken (the marks of a poll), when each app's logs were last cleared, and how many clears emptied a
 * file of it (a screen that shows the logs starts over whenever that count moves, even twice within one second).
 */
export interface Store extends CursorState {
  cleared: Record<string, string>;
  clears: Record<string, number>;
}
export interface TakenAnswer extends IncidentsAnswer {
  taken: boolean;
  cleared_at: string | null;
}
export interface Cleared {
  app: string;
  host: string;
  out_bytes: number;
  err_bytes: number;
  failed?: string[];
}

const LOCK_WAIT_MS = 30_000;

/** `.mcproc/incidents.json`, next to the manifest. */
export const storePath = (manifestPath: string): string =>
  path.join(path.dirname(manifestPath), 'incidents.json');

const pad = (n: number) => String(n).padStart(2, '0');
/** Local time of this machine in the shape of pm2's stamps: `YYYY-MM-DDTHH:MM:SS`. */
export const localStamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** The stored point; a missing, unreadable or foreign file is a fresh start. */
export function readStore(file: string): Store {
  try {
    const s = JSON.parse(
      fs.readFileSync(file, 'utf8')
    ) as Partial<Store> | null;
    const obj = <V>(o: Record<string, V> | undefined): Record<string, V> =>
      typeof o === 'object' && o !== null ? o : {};
    if (s && s.v === 1 && typeof s.apps === 'object' && s.apps !== null)
      return {
        v: 1,
        apps: s.apps,
        cleared: obj(s.cleared),
        clears: obj(s.clears),
      };
  } catch {
    /* a fresh start */
  }
  return { v: 1, apps: {}, cleared: {}, clears: {} };
}

/**
 * The store's lock is a listening socket, which the kernel lets one process hold and frees when that process ends,
 * however it ends: nothing is ever taken over from a holder, so a slow or suspended one never sees a successor write
 * under it. Linux: an abstract socket named after the store; elsewhere a loopback port derived from its path.
 */
export function lockAddress(file: string): net.ListenOptions {
  let dir = path.dirname(path.resolve(file));
  try {
    dir = fs.realpathSync(dir);
  } catch {
    /* not there yet: the path as given */
  } // a symlinked project path is the same store
  const id = createHash('sha256')
    .update(path.join(dir, path.basename(file)))
    .digest();
  return process.platform === 'linux'
    ? { path: `\0mcproc-incidents-${id.toString('hex').slice(0, 32)}` }
    : { host: '127.0.0.1', port: 40000 + (id.readUInt16BE(0) % 9000) };
}
function tryLock(addr: net.ListenOptions): Promise<net.Server | null> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((c) => c.destroy()); // the lock is the bound address; a program that connects is let go at once
    srv.once('error', (e: NodeJS.ErrnoException) =>
      e.code === 'EADDRINUSE' ? resolve(null) : reject(e)
    );
    srv.listen(addr, () => {
      srv.unref();
      resolve(srv);
    });
  });
}

/**
 * Read, change and write back the store while holding its lock, so two callers never take the same incidents: the
 * second waits (up to `waitMs`, then TIMEOUT). The new store replaces the old one in one rename.
 */
export async function withStore<T>(
  file: string,
  fn: (s: Store) => Promise<{ result: T; next: Store }>,
  waitMs = LOCK_WAIT_MS
): Promise<T> {
  const addr = lockAddress(file);
  const until = Date.now() + waitMs;
  let lock = await tryLock(addr);
  while (!lock) {
    if (Date.now() >= until) {
      throw new McprocError(
        'TIMEOUT',
        'another mcproc call is taking incidents of this project right now',
        {
          hint: addr.port
            ? `Retry in a moment. The lock is the loopback port ${addr.port}: if a program other than mcproc listens there, stop it.`
            : 'Retry in a moment.',
        }
      );
    }
    await new Promise((r) => setTimeout(r, 100));
    lock = await tryLock(addr);
  }
  try {
    const { result, next } = await fn(readStore(file));
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
    return result;
  } finally {
    await new Promise((r) => lock!.close(r));
  }
}

/**
 * The new incidents of the named apps. Taking (the default) moves the pick-up point past what it returns, for every
 * caller; `peek` looks without moving it, from `cursor` (a peeking follower's own position) or else the stored point.
 * `next` is the position after this call.
 */
export async function takeIncidents(
  fleet: Fleet,
  names: string[],
  opts: PollOptions & { peek?: boolean } = {},
  file = storePath(fleet.manifest.path)
): Promise<{ answer: TakenAnswer; next: CursorState }> {
  if (opts.peek) {
    const s = readStore(file);
    const base = opts.cursor ?? s;
    const { answer, next } = await pollIncidents(fleet, names, {
      ...opts,
      cursor: base,
    });
    return {
      answer: {
        ...answer,
        taken: false,
        cleared_at: lastClear(fleet, names, s),
      },
      next: mergeCursor(base, next),
    };
  }
  return withStore(file, async (s) => {
    const { answer, next } = await pollIncidents(fleet, names, {
      ...opts,
      cursor: s,
    });
    const stored: Store = {
      ...mergeCursor(s, next),
      cleared: s.cleared,
      clears: s.clears,
    };
    return {
      result: {
        answer: {
          ...answer,
          taken: true,
          cleared_at: lastClear(fleet, names, s),
        },
        next: stored,
      },
      next: stored,
    };
  });
}

/** The latest clear among the named apps, each at the host it runs on. */
function lastClear(fleet: Fleet, names: string[], s: Store): string | null {
  return (
    fleet
      .groups(names)
      .flatMap((g) => g.apps.map((a) => s.cleared[markKey(g.host, a)] ?? ''))
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  );
}

/**
 * Truncate the logs of the named apps (each on the host it runs on; readonly hosts are refused before anything) and
 * start their incidents there: the pick-up point moves to the start of each file the host confirmed empty, with pm2's
 * restart count and status as they are now, and the time of the clear is kept for an app whose files all emptied.
 * Nothing logged before the clear comes up again, and nothing written right after it is missed. A file that could not
 * be truncated keeps its point and is named in `failed`. When a host drops mid-way, what it did is unknown: its apps keep
 * their points, and a file found shorter than its point is read from the start anyway.
 */
export async function clearLogs(
  fleet: Fleet,
  names: string[],
  file = storePath(fleet.manifest.path),
  now = new Date()
): Promise<Cleared[]> {
  const groups = fleet.groups(names);
  assertWritableRuns(fleet, groups);
  let failure: unknown = null;
  const done = await withStore(file, async (s) => {
    const at = localStamp(now);
    const next: Store = {
      v: 1,
      apps: { ...s.apps },
      cleared: { ...s.cleared },
      clears: { ...s.clears },
    };
    const out: Cleared[] = [];
    for (const g of groups) {
      try {
        for (const f of await flushLogs(await fleet.ctx(g.host), g.apps)) {
          const key = markKey(g.host, f.app);
          const prev = s.apps[key];
          const mark = (path: string, was: FileMark | undefined) =>
            f.failed.includes(path) ? was : { path, offset: 0 };
          next.apps[key] = {
            restarts: f.proc.restarts,
            status: f.proc.status,
            out: mark(f.proc.out_log, prev?.out),
            err: mark(f.proc.err_log, prev?.err),
            ...(prev && 'start' in prev
              ? { start: prev.start, boot: prev.boot }
              : {}), // a clear ends no run: the boot state stays with the start it was taken for
          };
          if (f.failed.length === 0) next.cleared[key] = at;
          if (f.failed.length < 2) next.clears[key] = (s.clears[key] ?? 0) + 1; // a file of it was emptied
          const freed = (path: string, bytes: number) =>
            f.failed.includes(path) ? 0 : bytes;
          out.push({
            app: f.app,
            host: g.host,
            out_bytes: freed(f.proc.out_log, f.out_bytes),
            err_bytes: freed(f.proc.err_log, f.err_bytes),
            ...(f.failed.length ? { failed: f.failed } : {}),
          });
        }
      } catch (e) {
        failure = e; // what was cleared before stays recorded
        break;
      }
    }
    return { result: out, next };
  });
  if (failure) throw failure;
  return done;
}

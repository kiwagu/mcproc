import fs from 'node:fs';
import path from 'node:path';
import type { App } from './manifest.js';
import { pm2Name } from './pm2.js';
import type { Context } from './resolve.js';

/** A pids directory that is not there (no daemon has run at that home yet, or the home was removed) is looked for again after this long. */
export const WATCH_RETRY_MS = 1_000;
/** A watch that is up looks at its directory this often: a home moved away (an ancestor renamed) sends it no event. */
export const WATCH_CHECK_MS = 30_000;
/** What a subscriber hears: a process of its project started, stopped or exited (its pid file was written or removed), the watch came up, or it was lost. */
export type FeedNote = 'event' | 'up' | 'down';
export interface EventFeed {
  /** the watch is up: its subscriber may wait for events instead of reading on a timer */
  readonly up: boolean;
  close(): void;
}

/**
 * The start of the pid file names of `project`'s processes. pm2 writes `<name>-<pm_id>.pid` for each, its name with
 * every character but letters, digits, `.`, `-` and `\` made `-` (so `my_app` writes `my-app-…`). A project whose name
 * starts the same way wakes this one too, which costs one read and misses nothing.
 */
export function pidPrefix(project: string): string {
  return pm2Name(project, '').replace(/[^a-zA-Z0-9.\\-]/g, '-');
}

/** The app whose pm2 options write its pid file elsewhere (`pid_file`, or its alias `pid`); null when none does. */
export function ownPidFile(apps: Record<string, App>): string | null {
  return (
    Object.values(apps).find(
      (a) => Object.hasOwn(a.pm2, 'pid_file') || Object.hasOwn(a.pm2, 'pid')
    )?.name ?? null
  );
}

interface Subscriber {
  prefix: string;
  on: (n: FeedNote) => void;
}

/** One pids directory, watched for as long as someone subscribes. */
class PidWatch {
  up = false;
  readonly subscribers = new Set<Subscriber>();
  private watcher: fs.FSWatcher | null = null;
  private ino: number | null = null;
  private retry: NodeJS.Timeout | null = null;
  private check: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly dir: string) {
    this.arm();
  }

  private arm(): void {
    this.retry = null;
    if (this.closed) return;
    let w: fs.FSWatcher;
    try {
      this.ino = fs.statSync(this.dir).ino;
      // not persistent: the watch never keeps a quitting monit, or a one-shot command, alive
      w = fs.watch(this.dir, { persistent: false });
    } catch {
      this.later(); // no daemon has made it yet, or the system refused a watch: look again
      return;
    }
    this.watcher = w;
    w.on('change', (_type, name) =>
      this.saw(typeof name === 'string' ? name : null)
    );
    w.on('error', () => this.lost());
    // a home moved away is no event of this directory's: it is found when the path names another directory, or none
    this.check = setInterval(() => {
      if (this.moved()) this.lost();
    }, WATCH_CHECK_MS);
    this.check.unref();
    this.up = true;
    this.tell('up');
  }

  /** Whether the path no longer names the directory watched: removed, or replaced by another. */
  private moved(): boolean {
    try {
      return fs.statSync(this.dir).ino !== this.ino;
    } catch {
      return true; // gone
    }
  }

  private saw(name: string | null): void {
    // an event about the directory itself: if it was removed or replaced (its home deleted), this watch hears nothing more
    if (name === null || name === path.basename(this.dir)) {
      if (this.moved()) {
        this.lost();
        return;
      }
      if (name !== null) return;
    }
    if (name !== null && !name.endsWith('.pid')) return;
    for (const s of [...this.subscribers])
      if (name === null || name.startsWith(s.prefix)) s.on('event');
  }

  private lost(): void {
    this.stopWatching();
    if (this.up) {
      this.up = false;
      this.tell('down');
    }
    this.later();
  }

  private later(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => this.arm(), WATCH_RETRY_MS);
    this.retry.unref();
  }

  private tell(n: FeedNote): void {
    for (const s of [...this.subscribers]) s.on(n);
  }

  private stopWatching(): void {
    if (this.check) clearInterval(this.check);
    this.check = null;
    this.watcher?.close();
    this.watcher = null;
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.stopWatching();
    this.up = false;
  }
}

const pool = new Map<string, PidWatch>();

/**
 * Watches the pids directory `dir` for the pid files whose names start with `prefix`. `on` hears 'up' when the watch
 * is (or comes) up, 'down' when it is lost (the directory removed, or moved away: seen within WATCH_CHECK_MS; it is
 * looked for again every WATCH_RETRY_MS), and 'event' when such a file is written or removed: a process started,
 * stopped or exited. One watch per directory, shared by its subscribers and closed with the last; it never keeps a
 * process alive.
 */
export function watchPids(
  dir: string,
  prefix: string,
  on: (n: FeedNote) => void
): EventFeed {
  let watch = pool.get(dir);
  if (!watch) {
    watch = new PidWatch(dir);
    pool.set(dir, watch);
  }
  const w = watch;
  const me: Subscriber = { prefix, on };
  w.subscribers.add(me);
  if (w.up)
    queueMicrotask(() => {
      if (w.subscribers.has(me)) on('up');
    });
  return {
    get up() {
      return w.up;
    },
    close() {
      if (!w.subscribers.delete(me) || w.subscribers.size > 0) return;
      w.close();
      if (pool.get(dir) === w) pool.delete(dir);
    },
  };
}

/** Closes every watch (tests). */
export function closePidWatches(): void {
  for (const w of pool.values()) w.close();
  pool.clear();
}

/**
 * monit's feed for a host group: pm2's process events, as the daemon's pid files show them, for the view's project;
 * only on this machine, read in-process, with no app writing its pid file elsewhere and a pids directory from
 * Pm2Client.pids. null otherwise: the group is read every interval as before.
 */
export async function followPids(
  ctx: Context,
  on: (n: FeedNote) => void
): Promise<EventFeed | null> {
  if (!ctx.proc || !ctx.host.local || ownPidFile(ctx.manifest.apps))
    return null;
  const p = await ctx.pm2.pids();
  return p.dir ? watchPids(p.dir, pidPrefix(ctx.manifest.project), on) : null;
}

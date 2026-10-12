import { watch as fsWatch, type FSWatcher } from 'node:fs';

type Listener = (file: string | null) => void;
type Watch = (
  dir: string,
  opts: { persistent: boolean },
  cb: (event: string, file: string | Buffer | null) => void
) => Pick<FSWatcher, 'close' | 'on'>;
interface Entry {
  watcher: Pick<FSWatcher, 'close' | 'on'> | null;
  listeners: Set<Listener>;
}

/**
 * Tells subscribers which file of a directory changed (null when the system does not say). One OS watcher per
 * directory, shared by every subscriber and closed with the last one; it never keeps the process alive. A directory
 * that cannot be watched (missing, no access) gives no events, and the next subscriber tries again: callers keep their
 * own clock as the fallback.
 */
export class DirWatchers {
  private dirs = new Map<string, Entry>();
  constructor(private readonly open: Watch = fsWatch as unknown as Watch) {}

  watch(dir: string, onChange: Listener): () => void {
    let e = this.dirs.get(dir);
    if (!e) {
      e = { watcher: null, listeners: new Set() };
      this.dirs.set(dir, e);
    }
    const entry = e;
    if (!entry.watcher) {
      try {
        entry.watcher = this.open(dir, { persistent: false }, (_ev, file) => {
          for (const l of entry.listeners) l(file ? String(file) : null);
        });
        // the directory went away: no more events until someone subscribes again
        entry.watcher.on('error', () => {
          entry.watcher?.close();
          entry.watcher = null;
        });
      } catch {
        entry.watcher = null;
      }
    }
    entry.listeners.add(onChange);
    return () => {
      entry.listeners.delete(onChange);
      if (entry.listeners.size || this.dirs.get(dir) !== entry) return;
      entry.watcher?.close();
      this.dirs.delete(dir);
    };
  }
}

/** the watchers of this process */
export const dirWatchers = new DirWatchers();

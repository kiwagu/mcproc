import { describeError, isMcprocError } from '../core/errors.js';
import {
  unreachableRow,
  type LsRow,
  type Snapshot,
  type SnapshotOptions,
} from '../core/list.js';
import { findProcess } from '../core/pm2.js';
import { assertWritable, pickHost, type Context } from '../core/resolve.js';
import {
  assertWritableRuns,
  type Fleet,
  type HostApps,
} from '../core/fleet.js';
import type { StatSample } from '../core/stats.js';
import type { FollowPoll, LogLine } from '../core/logfollow.js';
import type { Cleared } from '../core/incidents/store.js';
import {
  compileReloadRules,
  historyReaches,
  reloadCount,
  reloadStamp,
  ReloadTracker,
} from '../core/reloads.js';
import { fmtBytes } from '../mcp/render.js';
import {
  monitViews,
  selectedRow,
  viewLabel,
  type MonitAction,
  type MonitState,
  type ReloadInfo,
} from './state.js';

export type Cmd = 'start' | 'restart' | 'stop';
export interface Follower {
  poll(): Promise<FollowPoll>;
  /** calls `wake` as soon as the followed files change, when the follower can tell */
  watch?(wake: () => void): void;
  /** stops the wakes */
  close?(): void;
}
type Paths = { out: string; err: string };
interface WakeQueue {
  dirty: Set<string>;
  /** a poll of these apps is scheduled or running */
  running: boolean;
  timer: NodeJS.Timeout | null;
  last: number;
}
/** What the loop needs from the rest of mcproc, injectable so the races below are testable without a terminal. */
export interface LoopDeps {
  /** the fleet a view acts on: `requested` is the --host it stands for (undefined = every app at its own host) */
  fleet(requested: string | undefined): Fleet;
  snapshot(ctx: Context, opts: SnapshotOptions): Promise<Snapshot>;
  rows(ctx: Context, snap: Snapshot, apps: string[]): LsRow[];
  follower(
    ctx: Context,
    paths: { out: string; err: string },
    lines: number
  ): Follower;
  /** the rows of what the command touched (a dependency on another host included), or nothing */
  command(fleet: Fleet, cmd: Cmd, app: string): Promise<LsRow[] | undefined>;
  /** `start all --reload` over the fleet: every app in dependency order with its waits; `signal` ends those waits as aborted */
  reloadAll(fleet: Fleet, signal: AbortSignal): Promise<LsRow[] | undefined>;
  /** truncate the apps' logs and record the clear in the project's store (incidents start there) */
  clear(fleet: Fleet, apps: string[]): Promise<Cleared[]>;
  /** the clears recorded in the project's store, keyed host/app: when (shown in the title) and how many (a new one restarts that app's logs) */
  cleared(fleet: Fleet): {
    at: Record<string, string>;
    gen: Record<string, number>;
  };
}

export { describeError };

/** One followed app's reloads since its pm2 start: the run it counts (its start and restarts) and the count so far. */
interface Counter {
  tracker: ReloadTracker;
  started: string;
  restarts: number;
  info: ReloadInfo;
}

/** polls a wake asks for run at most this often: a chatty app repaints the screen in steps, not on every write */
const WAKE_GAP_MS = 50;

/**
 * The monit screen's data loop: periodic refreshes of every host the view reaches, each host on its own, log following
 * for the selected app (or every app in the flat view) on the host it runs on, view switches and commands. Every refresh
 * belongs to a generation; a view switch starts a new one, and whatever an older refresh still returns is dropped. The
 * followers of the apps on screen wake the loop when their files change, so new lines show without waiting for a
 * refresh; the refresh stays as the clock behind them.
 */
export class MonitLoop {
  private gen = 0;
  /** one refresh in flight per host: a host that hangs holds back only its own rows, never the others' */
  private inflight = new Map<string, { gen: number; done: Promise<void> }>();
  private followers = new Map<string, { f: Follower; paths: Paths }>(); // app names are unique across hosts
  private watched = new Set<string>(); // apps whose follower wakes the loop: the ones on screen
  /** per host: woken apps waiting for their poll — a slow host never holds another host's lines */
  private wakes = new Map<string, WakeQueue>();
  private closed = false;
  private prev = new Map<string, { sample: StatSample; at: number }>(); // per host: cpu is a difference of two samples of one clock
  private latest = new Map<string, LsRow>(); // the newest row of each app in this view
  private errors = new Map<string, string>(); // hosts whose last refresh failed, and why
  private epochs = new Map<string, number>(); // per app, bumped by each clear: a read begun before it is dropped
  private seen: Record<string, number> = {}; // the clear counts of the store this screen has acted on
  private switchSeq = 0; // the newest view switch asked for: an older one that connects late changes nothing
  private counters = new Map<string, Counter>(); // per followed app with reloads on and a known start
  /**
   * per app, when its lines were last lost (a poll that lost some, or a clear), numbered by `losses`: until rows taken
   * after it were looked at, a run those rows did not know yet may have begun in that gap, so a fresh look at a run
   * counts as partial
   */
  private gaps = new Map<string, number>();
  private losses = 0;
  private uncounted = new Set<string>(); // apps whose own reloads patterns ran away: not counted again in this view
  private reloading: AbortController | null = null; // the running reload of the view: quitting ends its dependency waits
  private names: string[];
  private groups: HostApps[];

  constructor(
    public fleet: Fleet,
    private readonly deps: LoopDeps,
    /** budgetMs: how long an app's own reloads patterns may take on one poll's lines (default MATCH_BUDGET_MS) */
    private readonly opts: { lines: number; budgetMs?: number },
    private readonly getState: () => MonitState,
    public readonly dispatch: (a: MonitAction) => void
  ) {
    this.names = fleet.select(['all']);
    this.groups = fleet.groups(this.names);
  }

  /** One refresh of every host of the view (or of `hosts`); a host whose refresh of this generation is still in flight shares it. */
  refresh(hosts?: string[]): Promise<void> {
    this.readCleared();
    this.syncWatches();
    const gen = this.gen;
    return Promise.all(
      this.groups
        .filter((g) => !hosts || hosts.includes(g.host))
        .map((g) => {
          const cur = this.inflight.get(g.host);
          if (cur && cur.gen === gen) return cur.done;
          const done: Promise<void> = this.runHost(gen, g).finally(() => {
            if (this.inflight.get(g.host)?.done === done)
              this.inflight.delete(g.host);
          });
          this.inflight.set(g.host, { gen, done });
          return done;
        })
    ).then(() => undefined);
  }

  /** A refresh that reflects a change just made on `hosts`: waits for their current refresh, then runs again. */
  private async refreshAfterCurrent(hosts: string[]): Promise<void> {
    const current = hosts
      .map((h) => this.inflight.get(h))
      .filter((c) => c && c.gen === this.gen);
    await Promise.all(current.map((c) => c!.done.catch(() => undefined)));
    return this.refresh(hosts);
  }

  /** Rows of every app in manifest order: the newest of each, the error of every host that did not answer in the footer. */
  private publish(heard: boolean): void {
    this.dispatch({
      type: 'rows',
      rows: this.names.flatMap((n) => this.latest.get(n) ?? []),
      ...(heard ? { at: new Date() } : {}),
    });
    if (this.errors.size)
      this.dispatch({
        type: 'error',
        message: [...this.errors]
          .map(([h, m]) => (this.groups.length > 1 ? `${h}: ${m}` : m))
          .join('; '),
      });
  }

  private async runHost(gen: number, g: HostApps): Promise<void> {
    const probed = this.losses; // a gap numbered after this was not seen by the rows this refresh takes
    try {
      const ctx = await this.fleet.ctx(g.host);
      // the live screen never requests the apps' URLs: dev servers log every request, and this pane is where those logs are read
      const snap = await this.deps.snapshot(ctx, {
        cpu: 'none',
        prev: this.prev.get(g.host),
        urls: 'none',
      });
      if (gen !== this.gen) return; // the view changed meanwhile
      if (snap.stats.samples[0])
        this.prev.set(g.host, {
          sample: snap.stats.samples[0],
          at: snap.sampledAt,
        });
      for (const r of this.deps.rows(ctx, snap, g.apps))
        this.latest.set(r.app, r);
      this.errors.delete(g.host);
      this.publish(true);
      // every app gets its own buffer and follower; the dashboard polls the selected app, the flat view every running one.
      // Lines are consumed from the file by offset, so a poll's result always lands in its app's buffer — even if the
      // selection moved on meanwhile (the reducer only shows the selected app; nothing is lost).
      const state = this.getState();
      const selected = selectedRow(state)?.app;
      for (const app of state.view === 'flat'
        ? g.apps
        : g.apps.filter((a) => a === selected)) {
        const proc = findProcess(snap.procs, this.fleet.manifest.project, app);
        if (!proc) continue;
        const paths = { out: proc.out_log, err: proc.err_log };
        let e = this.followers.get(app);
        if (!e) {
          e = { f: this.deps.follower(ctx, paths, this.opts.lines), paths };
          this.followers.set(app, e);
        }
        const epoch = this.epochs.get(app);
        const r = await e.f.poll();
        if (gen !== this.gen) return; // the view moved on during the poll
        if (this.epochs.get(app) !== epoch) continue; // cleared during the read: these lines are from before the clear
        const before = this.getState().logs[app] ?? [];
        this.dispatch({
          type: 'logs',
          app,
          lines: r.lines,
          reset: r.reset,
          paths,
        });
        this.track(app, r.lines, before, r.lost === true);
        // the rows were taken before this poll, so what it lost may hold a run they do not know yet; an older gap is
        // settled once a counter of the app has looked at rows taken after it
        if (r.lost) this.gaps.set(app, ++this.losses);
        else if (this.counters.has(app) && (this.gaps.get(app) ?? 0) <= probed)
          this.gaps.delete(app);
      }
      this.syncWatches();
    } catch (e) {
      if (gen !== this.gen) return;
      // a host that did not answer keeps its apps' last rows (unreachable ones the first time); the footer says why
      this.errors.set(g.host, describeError(e));
      for (const a of g.apps)
        if (!this.latest.has(a))
          this.latest.set(
            a,
            unreachableRow(
              this.fleet.manifest.apps[a],
              g.host,
              describeError(e)
            )
          );
      this.publish(false);
    }
  }

  /** the apps whose logs the screen shows: the selected one, or every app in the flat view */
  private onScreen(): Set<string> {
    const s = this.getState();
    if (s.view === 'flat') return new Set(this.names);
    const app = selectedRow(s)?.app;
    return new Set(app ? [app] : []);
  }

  /** The followers of the apps on screen wake the loop; the others stop. */
  private syncWatches(): void {
    if (this.closed) return;
    const want = this.onScreen();
    for (const app of [...this.watched]) if (!want.has(app)) this.unwatch(app);
    for (const app of want) {
      const e = this.followers.get(app);
      if (!e?.f.watch || this.watched.has(app)) continue;
      this.watched.add(app);
      e.f.watch(() => this.wake(app));
    }
  }

  private unwatch(app: string): void {
    if (this.watched.delete(app)) this.followers.get(app)?.f.close?.();
  }

  private wake(app: string): void {
    if (!this.watched.has(app)) return;
    const host = this.fleet.hostOf(app);
    let q = this.wakes.get(host);
    if (!q) {
      q = { dirty: new Set(), running: false, timer: null, last: 0 };
      this.wakes.set(host, q);
    }
    q.dirty.add(app);
    this.kick(q);
  }

  /** Polls a host's woken apps now, or once the gap since its last such poll has passed. */
  private kick(q: WakeQueue): void {
    if (q.running || !q.dirty.size || this.closed) return;
    q.running = true;
    const run = () => {
      q.timer = null;
      void this.pollWoken(q);
    };
    const wait = q.last + WAKE_GAP_MS - Date.now();
    if (wait > 0) q.timer = setTimeout(run, wait);
    else queueMicrotask(run);
  }

  /** One poll of a host's woken apps; their lines are dispatched together, so the screen paints once. */
  private async pollWoken(q: WakeQueue): Promise<void> {
    const gen = this.gen;
    const apps = [...q.dirty];
    q.dirty.clear();
    q.last = Date.now();
    try {
      const got = await Promise.allSettled(
        apps.map(async (app) => {
          const e = this.followers.get(app);
          if (!e) return null;
          const epoch = this.epochs.get(app);
          return { app, e, epoch, r: await e.f.poll() }; // a host that fails here is reported by the next refresh
        })
      );
      for (const g of got) {
        if (g.status !== 'fulfilled' || !g.value) continue;
        const { app, e, epoch, r } = g.value;
        // the view moved on, the follower was replaced or the logs were cleared during the read
        if (
          gen !== this.gen ||
          this.followers.get(app) !== e ||
          this.epochs.get(app) !== epoch
        )
          continue;
        const before = this.getState().logs[app] ?? [];
        if (r.lines.length || r.reset)
          this.dispatch({
            type: 'logs',
            app,
            lines: r.lines,
            reset: r.reset,
            paths: e.paths,
          });
        this.track(app, r.lines, before, r.lost === true);
        if (r.lost) this.gaps.set(app, ++this.losses);
      }
    } finally {
      q.running = false;
      this.kick(q);
    }
  }

  /**
   * Counts the reloads in a followed app's new lines and closes a burst that went quiet. The first look at a run (the
   * app's first poll, or the first after pm2 started it again) starts a tracker over what the screen buffered of the
   * app's log before this poll, then every line of this poll: a new run's boot that a wake delivered before the rows told
   * of the restart is still taken for the boot, and a catch-up poll longer than the buffer loses nothing. After a
   * restart the count starts at 0 and is exact (the new run is followed from its start); a first look is judged by how
   * far those lines reach back. Lines lost by this poll (`lost`), or by one since the rows were taken (`gaps`), make the
   * count partial for the rest of its run, and the change is shown even when no reload closed.
   */
  private track(
    app: string,
    lines: LogLine[],
    before: LogLine[],
    lost: boolean
  ): void {
    const settings = this.fleet.manifest.apps[app]?.reloads;
    const row = this.latest.get(app);
    if (!settings || !row || this.uncounted.has(app)) return;
    const prev = this.counters.get(app);
    const { started, restarts } = row;
    const now = Date.now();
    const gap = lost || this.gaps.has(app);
    try {
      if (
        started !== null &&
        (!prev || prev.started !== started || prev.restarts !== restarts)
      ) {
        const input = [...before, ...lines];
        const rules = compileReloadRules(settings, this.opts.budgetMs);
        let tracker = null as ReloadTracker | null;
        const info = reloadCount(
          prev ? ['start'] : historyReaches(input, started),
          (coversStart) => {
            tracker = new ReloadTracker(rules, {
              app,
              start: started,
              coversStart,
            });
            return [...tracker.push(input, now), ...tracker.idle(now)];
          }
        );
        if (!tracker) return;
        if (gap) info.partial = true;
        this.counters.set(app, { tracker, started, restarts, info });
        this.dispatch({ type: 'reloads', app, info });
        return;
      }
      if (!prev) return;
      const found = [
        ...prev.tracker.push(lines, now),
        ...prev.tracker.idle(now),
      ];
      const last = found.at(-1);
      const partial = prev.info.partial || gap;
      if (!last && partial === prev.info.partial) return;
      prev.info = {
        count: prev.info.count + found.length,
        last: last ? reloadStamp(last) : prev.info.last,
        partial,
      };
      this.dispatch({ type: 'reloads', app, info: prev.info });
    } catch (e) {
      if (!isMcprocError(e) || e.code !== 'TIMEOUT') throw e;
      // its own patterns ran away: this app goes without a count, its logs and the other apps' counts go on
      this.counters.delete(app);
      this.uncounted.add(app);
      this.dispatch({ type: 'reloads', app, info: null });
      this.dispatch({
        type: 'notice',
        message: `reloads of ${app} not counted: ${describeError(e)}`,
      });
    }
  }

  /** The screen is going away: no follower wakes it any more, and a running reload stops waiting for dependencies. */
  close(): void {
    this.closed = true;
    this.reloading?.abort();
    for (const q of this.wakes.values()) {
      if (q.timer) clearTimeout(q.timer);
      q.timer = null;
      q.dirty.clear();
    }
    for (const app of [...this.watched]) this.unwatch(app);
  }

  /** The user moved the selection: refresh its host so an app seen for the first time gets its follower (history) at once. */
  dispatchSelect(delta: number): void {
    const before = selectedRow(this.getState())?.app;
    this.dispatch({ type: 'select', delta });
    const after = selectedRow(this.getState())?.app;
    if (after && after !== before)
      void this.refreshAfterCurrent([this.fleet.hostOf(after)]);
  }

  /** `h`: the next view — all apps at their hosts, then each host as --host would narrow it. */
  nextView(): Promise<void> {
    const views = monitViews(this.fleet.manifest);
    return this.switchView(
      views[(views.indexOf(this.fleet.requested) + 1) % views.length]
    );
  }

  /** Switch to the view of `requested`; when none of its hosts can be reached, the current view stays and the footer says why. */
  async switchView(requested: string | undefined): Promise<void> {
    const seq = ++this.switchSeq;
    this.dispatch({ type: 'busy', busy: true });
    try {
      const fleet = this.deps.fleet(requested);
      const names = fleet.select(['all']);
      const groups = fleet.groups(names);
      const connected = await Promise.allSettled(
        groups.map((g) => fleet.ctx(g.host))
      );
      if (seq !== this.switchSeq) return; // a newer switch was asked for meanwhile: it decides the view
      const firstFailure = connected.find(
        (c): c is PromiseRejectedResult => c.status === 'rejected'
      );
      if (firstFailure && connected.every((c) => c.status === 'rejected'))
        throw firstFailure.reason;
      this.gen++;
      this.fleet = fleet;
      this.names = names;
      this.groups = groups;
      for (const app of [...this.watched]) this.unwatch(app);
      this.followers.clear();
      this.counters.clear(); // the new view's followers start with their history, which is counted afresh
      this.gaps.clear();
      this.uncounted.clear();
      this.prev.clear();
      this.latest.clear();
      this.errors.clear();
      this.dispatch({ type: 'host', host: viewLabel(requested) });
      await this.refresh(); // a new generation: starts at once, the old view's pending probes are dropped when they return
    } catch (e) {
      if (seq === this.switchSeq)
        this.dispatch({ type: 'error', message: describeError(e) });
    } finally {
      if (seq === this.switchSeq) this.dispatch({ type: 'busy', busy: false });
    }
  }

  async runCommand(cmd: Cmd, app: string): Promise<void> {
    this.dispatch({ type: 'busy', busy: true });
    this.dispatch({ type: 'notice', message: `${cmd} ${app}…` });
    try {
      // the actions do not check by themselves: the CLI and the MCP tools guard, so must the screen — on the app's own host
      const host = this.fleet.hostOf(app);
      assertWritable(pickHost(this.fleet.manifest, host));
      const bad = (
        (await this.deps.command(this.fleet, cmd, app)) ?? []
      ).filter((r) => r.error);
      // a dependency may have started on one host while the app itself failed on another: never report that as done
      this.dispatch({
        type: 'notice',
        message: bad.length
          ? `${cmd} ${app} partly failed: ${bad[0].app} (${bad[0].host}): ${bad[0].error}`
          : `${cmd} ${app}: done`,
      });
      await this.refreshAfterCurrent([host]);
    } catch (e) {
      // a notice, not an `error`: the next good refresh clears errors within the interval, but a failed command must stay readable
      this.dispatch({
        type: 'notice',
        message: `${cmd} ${app} failed: ${describeError(e)}`,
      });
    } finally {
      this.dispatch({ type: 'busy', busy: false });
    }
  }

  /**
   * `R` twice: `start all --reload` over the view — every app at its own host, or only those of the host `h` narrowed
   * to — in dependency order with their waits; running apps restart, stopped ones start, tasks run again. A view with an
   * app on a readonly host is refused whole before anything runs: reloading only the writable hosts could stop halfway on
   * a dependency there. Then every host of the view is refreshed.
   */
  async reloadAll(): Promise<void> {
    const fleet = this.fleet;
    const names = this.names;
    const hosts = this.groups.map((g) => g.host);
    const abort = new AbortController();
    this.reloading = abort;
    this.dispatch({ type: 'busy', busy: true });
    this.dispatch({ type: 'notice', message: 'reload all…' });
    try {
      assertWritableRuns(fleet, fleet.runs(names), names);
      const bad = (
        (await this.deps.reloadAll(fleet, abort.signal)) ?? []
      ).filter((r) => r.error);
      if (this.closed) return; // the screen is gone: nothing to show, nothing to refresh
      this.dispatch({
        type: 'notice',
        message: bad.length
          ? `reload all partly failed: ${bad[0].app} (${bad[0].host}): ${bad[0].error}`
          : 'reload all: done',
      });
      await this.refreshAfterCurrent(hosts);
    } catch (e) {
      if (this.closed) return;
      // a notice, as for one app's command: the next good refresh clears errors, a failed reload must stay readable
      this.dispatch({
        type: 'notice',
        message: `reload all failed: ${describeError(e)}`,
      });
    } finally {
      if (this.reloading === abort) this.reloading = null;
      this.dispatch({ type: 'busy', busy: false });
    }
  }

  /** The clears recorded in the store (by this screen, the CLI or an agent), dispatched when they changed: the log pane title shows them. */
  private readCleared(): void {
    const { at, gen } = this.deps.cleared(this.fleet);
    const again = Object.keys(gen)
      .filter((key) => gen[key] !== this.seen[key])
      .map((key) => key.slice(key.indexOf('/') + 1));
    this.seen = { ...gen };
    this.restart(again.filter((a) => this.names.includes(a)));
    if (JSON.stringify(at) !== JSON.stringify(this.getState().cleared))
      this.dispatch({ type: 'cleared', cleared: at });
  }

  /**
   * The logs of these apps start over (they were cleared): buffers empty, the next refresh reads the emptied files with a
   * new follower — the old one would go on at its offset if the file regrew past it — and a read begun before is dropped.
   * A count kept across the clear is partial from now on: what the clear removed may hold reloads, or a new run's start.
   */
  private restart(apps: string[]): void {
    for (const app of apps) {
      this.unwatch(app);
      this.followers.delete(app);
      this.epochs.set(app, (this.epochs.get(app) ?? 0) + 1);
      this.dispatch({ type: 'logs', app, lines: [], reset: true });
      const c = this.counters.get(app);
      if (!c) continue;
      this.gaps.set(app, ++this.losses);
      if (c.info.partial) continue;
      c.info = { ...c.info, partial: true };
      this.dispatch({ type: 'reloads', app, info: c.info });
    }
  }

  /** `c` twice: clear the logs of the view's running apps; apps on a readonly host are skipped and named. */
  async runClear(apps: string[]): Promise<void> {
    const ro = apps.filter(
      (a) => pickHost(this.fleet.manifest, this.fleet.hostOf(a)).readonly
    );
    const go = apps.filter((a) => !ro.includes(a));
    const skipped = ro.length
      ? `; skipped ${ro.join(', ')} (readonly host)`
      : '';
    if (go.length === 0)
      return this.dispatch({
        type: 'notice',
        message: `nothing cleared${skipped}`,
      });
    this.dispatch({ type: 'busy', busy: true });
    this.dispatch({
      type: 'notice',
      message: `clearing logs of ${go.join(', ')}…`,
    });
    try {
      const r = await this.deps.clear(this.fleet, go);
      const freed = r.reduce((t, x) => t + x.out_bytes + x.err_bytes, 0);
      const failed = r.flatMap((x) => x.failed ?? []);
      const kept = failed.length
        ? `; could not truncate ${failed.join(', ')} (its incidents go on from before)`
        : '';
      this.dispatch({
        type: 'notice',
        message: `cleared logs of ${go.join(', ')} (${fmtBytes(freed)}); incidents start here${skipped}${kept}`,
      });
      this.readCleared(); // the store counted the clear: the apps whose files emptied start over
      await this.refreshAfterCurrent([
        ...new Set(go.map((a) => this.fleet.hostOf(a))),
      ]);
    } catch (e) {
      this.dispatch({
        type: 'notice',
        message: `clear failed: ${describeError(e)}`,
      });
    } finally {
      this.dispatch({ type: 'busy', busy: false });
    }
  }
}

import { describeError } from '../core/errors.js';
import {
  unreachableRow,
  type LsRow,
  type Snapshot,
  type SnapshotOptions,
} from '../core/list.js';
import { findProcess } from '../core/pm2.js';
import { assertWritable, pickHost, type Context } from '../core/resolve.js';
import type { Fleet, HostApps } from '../core/fleet.js';
import type { StatSample } from '../core/stats.js';
import type { LogLine } from '../core/logfollow.js';
import type { Cleared } from '../core/incidents/store.js';
import { fmtBytes } from '../mcp/render.js';
import {
  monitViews,
  selectedRow,
  viewLabel,
  type MonitAction,
  type MonitState,
} from './state.js';

export type Cmd = 'start' | 'restart' | 'stop';
export interface Follower {
  poll(): Promise<{ lines: LogLine[]; reset: boolean }>;
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
  /** truncate the apps' logs and record the clear in the project's store (incidents start there) */
  clear(fleet: Fleet, apps: string[]): Promise<Cleared[]>;
  /** the clears recorded in the project's store, keyed host/app: when (shown in the title) and how many (a new one restarts that app's logs) */
  cleared(fleet: Fleet): {
    at: Record<string, string>;
    gen: Record<string, number>;
  };
}

export { describeError };

/**
 * The monit screen's data loop: periodic refreshes of every host the view reaches, each host on its own, log following
 * for the selected app (or every app in the flat view) on the host it runs on, view switches and commands. Every refresh
 * belongs to a generation; a view switch starts a new one, and whatever an older refresh still returns is dropped.
 */
export class MonitLoop {
  private gen = 0;
  /** one refresh in flight per host: a host that hangs holds back only its own rows, never the others' */
  private inflight = new Map<string, { gen: number; done: Promise<void> }>();
  private followers = new Map<string, Follower>(); // app names are unique across hosts
  private prev = new Map<string, { sample: StatSample; at: number }>(); // per host: cpu is a difference of two samples of one clock
  private latest = new Map<string, LsRow>(); // the newest row of each app in this view
  private errors = new Map<string, string>(); // hosts whose last refresh failed, and why
  private epochs = new Map<string, number>(); // per app, bumped by each clear: a read begun before it is dropped
  private seen: Record<string, number> = {}; // the clear counts of the store this screen has acted on
  private switchSeq = 0; // the newest view switch asked for: an older one that connects late changes nothing
  private names: string[];
  private groups: HostApps[];

  constructor(
    public fleet: Fleet,
    private readonly deps: LoopDeps,
    private readonly opts: { lines: number },
    private readonly getState: () => MonitState,
    public readonly dispatch: (a: MonitAction) => void
  ) {
    this.names = fleet.select(['all']);
    this.groups = fleet.groups(this.names);
  }

  /** One refresh of every host of the view (or of `hosts`); a host whose refresh of this generation is still in flight shares it. */
  refresh(hosts?: string[]): Promise<void> {
    this.readCleared();
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
        let f = this.followers.get(app);
        if (!f) {
          f = this.deps.follower(ctx, paths, this.opts.lines);
          this.followers.set(app, f);
        }
        const epoch = this.epochs.get(app);
        const r = await f.poll();
        if (gen !== this.gen) return; // the view moved on during the poll
        if (this.epochs.get(app) !== epoch) continue; // cleared during the read: these lines are from before the clear
        this.dispatch({
          type: 'logs',
          app,
          lines: r.lines,
          reset: r.reset,
          paths,
        });
      }
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
      this.followers.clear();
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
   */
  private restart(apps: string[]): void {
    for (const app of apps) {
      this.followers.delete(app);
      this.epochs.set(app, (this.epochs.get(app) ?? 0) + 1);
      this.dispatch({ type: 'logs', app, lines: [], reset: true });
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

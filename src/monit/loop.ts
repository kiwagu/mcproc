import { describeError } from '../core/errors.js';
import { unreachableRow, type LsRow, type Snapshot, type SnapshotOptions } from '../core/list.js';
import { findProcess } from '../core/pm2.js';
import { assertWritable, pickHost, type Context } from '../core/resolve.js';
import type { Fleet, HostApps } from '../core/fleet.js';
import type { StatSample } from '../core/stats.js';
import type { LogLine } from '../core/logfollow.js';
import { monitViews, selectedRow, viewLabel, type MonitAction, type MonitState } from './state.js';

export type Cmd = 'start' | 'restart' | 'stop';
export interface Follower { poll(): Promise<{ lines: LogLine[]; reset: boolean }> }
/** What the loop needs from the rest of mcproc, injectable so the races below are testable without a terminal. */
export interface LoopDeps {
  /** the fleet a view acts on: `requested` is the --host it stands for (undefined = every app at its own host) */
  fleet(requested: string | undefined): Fleet;
  snapshot(ctx: Context, opts: SnapshotOptions): Promise<Snapshot>;
  rows(ctx: Context, snap: Snapshot, apps: string[]): LsRow[];
  follower(ctx: Context, paths: { out: string; err: string }, lines: number): Follower;
  command(fleet: Fleet, cmd: Cmd, app: string): Promise<unknown>;
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
  private names: string[];
  private groups: HostApps[];

  constructor(
    public fleet: Fleet,
    private readonly deps: LoopDeps,
    private readonly opts: { lines: number },
    private readonly getState: () => MonitState,
    public readonly dispatch: (a: MonitAction) => void,
  ) {
    this.names = fleet.select(['all']);
    this.groups = fleet.groups(this.names);
  }

  /** One refresh of every host of the view (or of `hosts`); a host whose refresh of this generation is still in flight shares it. */
  refresh(hosts?: string[]): Promise<void> {
    const gen = this.gen;
    return Promise.all(this.groups.filter((g) => !hosts || hosts.includes(g.host)).map((g) => {
      const cur = this.inflight.get(g.host);
      if (cur && cur.gen === gen) return cur.done;
      const done: Promise<void> = this.runHost(gen, g).finally(() => { if (this.inflight.get(g.host)?.done === done) this.inflight.delete(g.host); });
      this.inflight.set(g.host, { gen, done });
      return done;
    })).then(() => undefined);
  }

  /** A refresh that reflects a change just made on `hosts`: waits for their current refresh, then runs again. */
  private async refreshAfterCurrent(hosts: string[]): Promise<void> {
    const current = hosts.map((h) => this.inflight.get(h)).filter((c) => c && c.gen === this.gen);
    await Promise.all(current.map((c) => c!.done.catch(() => undefined)));
    return this.refresh(hosts);
  }

  /** Rows of every app in manifest order: the newest of each, the error of every host that did not answer in the footer. */
  private publish(heard: boolean): void {
    this.dispatch({ type: 'rows', rows: this.names.flatMap((n) => this.latest.get(n) ?? []), ...(heard ? { at: new Date() } : {}) });
    if (this.errors.size) this.dispatch({ type: 'error', message: [...this.errors].map(([h, m]) => (this.groups.length > 1 ? `${h}: ${m}` : m)).join('; ') });
  }

  private async runHost(gen: number, g: HostApps): Promise<void> {
    try {
      const ctx = await this.fleet.ctx(g.host);
      // the live screen never requests the apps' URLs: dev servers log every request, and this pane is where those logs are read
      const snap = await this.deps.snapshot(ctx, { cpu: 'none', prev: this.prev.get(g.host), urls: 'none' });
      if (gen !== this.gen) return; // the view changed meanwhile
      if (snap.stats.samples[0]) this.prev.set(g.host, { sample: snap.stats.samples[0], at: snap.sampledAt });
      for (const r of this.deps.rows(ctx, snap, g.apps)) this.latest.set(r.app, r);
      this.errors.delete(g.host);
      this.publish(true);
      // every app gets its own buffer and follower; the dashboard polls the selected app, the flat view every running one.
      // Lines are consumed from the file by offset, so a poll's result always lands in its app's buffer — even if the
      // selection moved on meanwhile (the reducer only shows the selected app; nothing is lost).
      const state = this.getState();
      const selected = selectedRow(state)?.app;
      for (const app of state.view === 'flat' ? g.apps : g.apps.filter((a) => a === selected)) {
        const proc = findProcess(snap.procs, this.fleet.manifest.project, app);
        if (!proc) continue;
        const paths = { out: proc.out_log, err: proc.err_log };
        let f = this.followers.get(app);
        if (!f) { f = this.deps.follower(ctx, paths, this.opts.lines); this.followers.set(app, f); }
        const r = await f.poll();
        if (gen !== this.gen) return; // the view moved on during the poll
        this.dispatch({ type: 'logs', app, lines: r.lines, reset: r.reset, paths });
      }
    } catch (e) {
      if (gen !== this.gen) return;
      // a host that did not answer keeps its apps' last rows (unreachable ones the first time); the footer says why
      this.errors.set(g.host, describeError(e));
      for (const a of g.apps) if (!this.latest.has(a)) this.latest.set(a, unreachableRow(this.fleet.manifest.apps[a], g.host, describeError(e)));
      this.publish(false);
    }
  }

  /** The user moved the selection: refresh its host so an app seen for the first time gets its follower (history) at once. */
  dispatchSelect(delta: number): void {
    const before = selectedRow(this.getState())?.app;
    this.dispatch({ type: 'select', delta });
    const after = selectedRow(this.getState())?.app;
    if (after && after !== before) void this.refreshAfterCurrent([this.fleet.hostOf(after)]);
  }

  /** `h`: the next view — all apps at their hosts, then each host as --host would narrow it. */
  nextView(): Promise<void> {
    const views = monitViews(this.fleet.manifest);
    return this.switchView(views[(views.indexOf(this.fleet.requested) + 1) % views.length]);
  }

  /** Switch to the view of `requested`; when none of its hosts can be reached, the current view stays and the footer says why. */
  async switchView(requested: string | undefined): Promise<void> {
    this.dispatch({ type: 'busy', busy: true });
    try {
      const fleet = this.deps.fleet(requested);
      const names = fleet.select(['all']);
      const groups = fleet.groups(names);
      const connected = await Promise.allSettled(groups.map((g) => fleet.ctx(g.host)));
      const firstFailure = connected.find((c): c is PromiseRejectedResult => c.status === 'rejected');
      if (firstFailure && connected.every((c) => c.status === 'rejected')) throw firstFailure.reason;
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
      this.dispatch({ type: 'error', message: describeError(e) });
    } finally {
      this.dispatch({ type: 'busy', busy: false });
    }
  }

  async runCommand(cmd: Cmd, app: string): Promise<void> {
    this.dispatch({ type: 'busy', busy: true });
    this.dispatch({ type: 'notice', message: `${cmd} ${app}…` });
    try {
      // the actions do not check by themselves: the CLI and the MCP tools guard, so must the screen — on the app's own host
      const host = this.fleet.hostOf(app);
      assertWritable(pickHost(this.fleet.manifest, host));
      await this.deps.command(this.fleet, cmd, app);
      this.dispatch({ type: 'notice', message: `${cmd} ${app}: done` });
      await this.refreshAfterCurrent([host]);
    } catch (e) {
      // a notice, not an `error`: the next good refresh clears errors within the interval, but a failed command must stay readable
      this.dispatch({ type: 'notice', message: `${cmd} ${app} failed: ${describeError(e)}` });
    } finally {
      this.dispatch({ type: 'busy', busy: false });
    }
  }
}

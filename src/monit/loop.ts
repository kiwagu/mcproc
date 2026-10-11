import { isMcprocError } from '../core/errors.js';
import type { LsRow, Snapshot, SnapshotOptions } from '../core/list.js';
import { findProcess } from '../core/pm2.js';
import { assertWritable, type Context } from '../core/resolve.js';
import type { StatSample } from '../core/stats.js';
import type { LogLine } from '../core/logfollow.js';
import { selectedRow, type MonitAction, type MonitState } from './state.js';

export type Cmd = 'start' | 'restart' | 'stop';
export interface Follower { poll(): Promise<{ lines: LogLine[]; reset: boolean }> }
/** What the loop needs from the rest of mcproc, injectable so the races below are testable without a terminal. */
export interface LoopDeps {
  connect(host: string): Promise<Context>;
  snapshot(ctx: Context, opts: SnapshotOptions): Promise<Snapshot>;
  rows(ctx: Context, snap: Snapshot): LsRow[];
  follower(ctx: Context, paths: { out: string; err: string }, lines: number): Follower;
  command(ctx: Context, cmd: Cmd, app: string): Promise<unknown>;
}

export const describeError = (e: unknown): string => (isMcprocError(e) ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

/**
 * The monit screen's data loop: periodic refreshes, log following for the selected app, host switches and commands.
 * Every refresh belongs to a generation; a host switch starts a new one, and whatever an older refresh still returns is dropped.
 */
export class MonitLoop {
  private gen = 0;
  private inflight: { gen: number; done: Promise<void> } | null = null;
  private followers = new Map<string, Follower>();
  private prev: { sample: StatSample; at: number } | undefined;

  constructor(
    public ctx: Context,
    private readonly deps: LoopDeps,
    private readonly opts: { lines: number },
    private readonly getState: () => MonitState,
    private readonly dispatch: (a: MonitAction) => void,
  ) {}

  /** One refresh of the current host; a refresh of the same generation already in flight is shared, not duplicated. */
  refresh(): Promise<void> {
    if (this.inflight && this.inflight.gen === this.gen) return this.inflight.done;
    const gen = this.gen;
    const done = this.run(gen).finally(() => { if (this.inflight?.gen === gen) this.inflight = null; });
    this.inflight = { gen, done };
    return done;
  }

  /** A refresh that reflects a change just made: waits for the current one, then runs again. */
  private async refreshAfterCurrent(): Promise<void> {
    if (this.inflight && this.inflight.gen === this.gen) await this.inflight.done.catch(() => undefined);
    return this.refresh();
  }

  private async run(gen: number): Promise<void> {
    const ctx = this.ctx;
    try {
      // the live screen never requests the apps' URLs: dev servers log every request, and this pane is where those logs are read
      const snap = await this.deps.snapshot(ctx, { cpu: 'none', prev: this.prev, urls: 'none' });
      if (gen !== this.gen) return; // a host switch happened meanwhile
      if (snap.stats.samples[0]) this.prev = { sample: snap.stats.samples[0], at: snap.sampledAt };
      this.dispatch({ type: 'rows', rows: this.deps.rows(ctx, snap), at: new Date() });
      const row = selectedRow(this.getState());
      const proc = row ? findProcess(snap.procs, ctx.manifest.project, row.app) : undefined;
      if (!row || !proc) return;
      const paths = { out: proc.out_log, err: proc.err_log };
      let f = this.followers.get(row.app);
      if (!f) { f = this.deps.follower(ctx, paths, this.opts.lines); this.followers.set(row.app, f); }
      const r = await f.poll();
      if (gen !== this.gen || selectedRow(this.getState())?.app !== row.app) return; // the selection or the host moved on during the poll
      this.dispatch({ type: 'logs', lines: r.lines, reset: r.reset, paths });
    } catch (e) {
      if (gen === this.gen) this.dispatch({ type: 'error', message: describeError(e) });
    }
  }

  /** The user moved the selection: the newly selected app's log view starts from its history. */
  dispatchSelect(delta: number): void {
    const before = selectedRow(this.getState())?.app;
    this.dispatch({ type: 'select', delta });
    const after = selectedRow(this.getState())?.app;
    if (after && after !== before) { this.followers.delete(after); void this.refreshAfterCurrent(); }
  }

  async switchHost(next: string): Promise<void> {
    this.dispatch({ type: 'busy', busy: true });
    try {
      const ctx = await this.deps.connect(next);
      this.gen++;
      this.ctx = ctx;
      this.followers.clear();
      this.prev = undefined;
      this.dispatch({ type: 'host', host: next });
      await this.refresh(); // a new generation: starts at once, the old host's pending probe is dropped when it returns
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
      assertWritable(this.ctx.host); // the actions do not check by themselves: the CLI and the MCP tools guard, so must the screen
      await this.deps.command(this.ctx, cmd, app);
      this.dispatch({ type: 'notice', message: `${cmd} ${app}: done` });
      await this.refreshAfterCurrent();
    } catch (e) {
      // a notice, not an `error`: the next good refresh clears errors within the interval, but a failed command must stay readable
      this.dispatch({ type: 'notice', message: `${cmd} ${app} failed: ${describeError(e)}` });
    } finally {
      this.dispatch({ type: 'busy', busy: false });
    }
  }
}

import { prepare, connect } from '../core/resolve.js';
import { rowsFor, snapshot } from '../core/list.js';
import { findProcess } from '../core/pm2.js';
import { LogFollower } from '../core/logfollow.js';
import { appInfos, hostNames, initialState, reduce, selectedRow } from './state.js';
import { frameToText, renderFrame } from './frame.js';

/** One frame of the monit surface as plain text: the same renderer the interactive screen uses. */
export async function monitOnce(opts: { project?: string; host?: string; lines: number; width?: number }): Promise<string> {
  const prep = prepare({ project: opts.project, host: opts.host });
  const ctx = await connect(prep);
  let state = initialState({ project: prep.manifest.project, host: ctx.host.name, hosts: hostNames(prep.manifest), apps: appInfos(prep.manifest) });
  const snap = await snapshot(ctx); // defaults: inline cpu sample and the url checks — --once is the tool-facing frame
  state = reduce(state, { type: 'rows', rows: rowsFor(ctx, snap, Object.keys(prep.manifest.apps)), at: new Date() });
  const row = selectedRow(state);
  const proc = row ? findProcess(snap.procs, prep.manifest.project, row.app) : undefined;
  if (proc) {
    const paths = { out: proc.out_log, err: proc.err_log };
    const { lines } = await new LogFollower(ctx, paths, opts.lines).poll();
    state = reduce(state, { type: 'logs', app: row!.app, lines, paths });
  }
  return frameToText(renderFrame(state, { width: opts.width ?? (process.stdout.columns || 120), height: 40 }));
}

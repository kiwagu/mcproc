import { prepare } from '../core/resolve.js';
import { describeError, isMcprocError } from '../core/errors.js';
import { Fleet, listFleet } from '../core/fleet.js';
import type { Manifest } from '../core/manifest.js';
import { findProcess } from '../core/pm2.js';
import { createFollower } from '../core/logfollow.js';
import { historyReloads, type LoopDeps } from './loop.js';
import {
  appInfos,
  initialState,
  monitViews,
  reduce,
  selectedRow,
  viewLabel,
} from './state.js';
import { frameToText, renderFrame } from './frame.js';

/**
 * One frame of the monit surface as plain text: the same renderer the interactive screen uses, the same view it opens
 * on, with the selected app's reloads counted from the history it reads. `deps` stand in for the project's manifest,
 * its fleet and the log follower (tests).
 */
export async function monitOnce(
  opts: {
    project?: string;
    host?: string;
    lines: number;
    width?: number;
  },
  deps: {
    manifest?: Manifest;
    fleet?: LoopDeps['fleet'];
    follower?: LoopDeps['follower'];
  } = {}
): Promise<string> {
  const manifest = deps.manifest ?? prepare({ project: opts.project }).manifest;
  const views = monitViews(manifest);
  const requested = opts.host ?? views[0];
  const fleet = deps.fleet?.(requested) ?? new Fleet(manifest, requested);
  let state = initialState({
    project: manifest.project,
    host: viewLabel(fleet.requested),
    hosts: views.map(viewLabel),
    apps: appInfos(manifest),
  });
  // defaults: inline cpu sample and the url checks — --once is the tool-facing frame
  const { rows, errors, probes } = await listFleet(
    fleet,
    fleet.select(['all'])
  );
  state = reduce(state, { type: 'rows', rows, at: new Date() });
  if (errors.length)
    state = reduce(state, {
      type: 'error',
      message: errors.map((e) => `${e.host}: ${e.message}`).join('; '),
    });
  const row = selectedRow(state);
  const probe = row ? probes.find((p) => p.apps.includes(row.app)) : undefined;
  const proc =
    row && probe?.snap
      ? findProcess(probe.snap.procs, manifest.project, row.app)
      : undefined;
  if (row && probe?.ctx && proc) {
    const paths = { out: proc.out_log, err: proc.err_log };
    const follow = deps.follower ?? createFollower;
    const { lines } = await follow(probe.ctx, paths, opts.lines).poll();
    state = reduce(state, { type: 'logs', app: row.app, lines, paths });
    try {
      const info = historyReloads(manifest.apps[row.app]?.reloads, row, lines);
      if (info) state = reduce(state, { type: 'reloads', app: row.app, info });
    } catch (e) {
      if (!isMcprocError(e) || e.code !== 'TIMEOUT') throw e;
      state = reduce(state, {
        type: 'notice',
        message: `reloads of ${row.app} not counted: ${describeError(e)}`,
      });
    }
  }
  return frameToText(
    renderFrame(state, {
      width: opts.width ?? (process.stdout.columns || 120),
      height: 40,
    })
  );
}

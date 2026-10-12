import { prepare } from '../core/resolve.js';
import { Fleet, listFleet } from '../core/fleet.js';
import { findProcess } from '../core/pm2.js';
import { LogFollower } from '../core/logfollow.js';
import {
  appInfos,
  initialState,
  monitViews,
  reduce,
  selectedRow,
  viewLabel,
} from './state.js';
import { frameToText, renderFrame } from './frame.js';

/** One frame of the monit surface as plain text: the same renderer the interactive screen uses, the same view it opens on. */
export async function monitOnce(opts: {
  project?: string;
  host?: string;
  lines: number;
  width?: number;
}): Promise<string> {
  const { manifest } = prepare({ project: opts.project });
  const views = monitViews(manifest);
  const fleet = new Fleet(manifest, opts.host ?? views[0]);
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
    const { lines } = await new LogFollower(
      probe.ctx,
      paths,
      opts.lines
    ).poll();
    state = reduce(state, { type: 'logs', app: row.app, lines, paths });
  }
  return frameToText(
    renderFrame(state, {
      width: opts.width ?? (process.stdout.columns || 120),
      height: 40,
    })
  );
}

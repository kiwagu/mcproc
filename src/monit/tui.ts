import blessed from '@pm2/blessed';
import { prepare, connect } from '../core/resolve.js';
import { rowsFor, snapshot } from '../core/list.js';
import { startApps, restartApps, stopApps } from '../core/actions.js';
import { LogFollower } from '../core/logfollow.js';
import { appInfos, hostNames, initialState, keyIntent, reduce, selectedRow, type MonitAction, type MonitState } from './state.js';
import { renderFrame } from './frame.js';
import { MonitLoop, type LoopDeps } from './loop.js';

const deps = (project: string | undefined): LoopDeps => ({
  connect: (host) => connect(prepare({ project, host })),
  snapshot,
  rows: (ctx, snap) => rowsFor(ctx, snap, Object.keys(ctx.manifest.apps)),
  follower: (ctx, paths, lines) => new LogFollower(ctx, paths, lines),
  command: (ctx, cmd, app) => (cmd === 'start' ? startApps(ctx, app) : cmd === 'restart' ? restartApps(ctx, app) : stopApps(ctx, app)),
});

/** The blessed shell: it only paints frames from the pure renderer and forwards keys to the loop. */
export async function runMonit(opts: { project?: string; host?: string; intervalMs: number; lines: number }): Promise<void> {
  const prep = prepare({ project: opts.project, host: opts.host });
  const ctx = await connect(prep);
  let state: MonitState = initialState({ project: prep.manifest.project, host: ctx.host.name, hosts: hostNames(prep.manifest), apps: appInfos(prep.manifest) });

  const screen = blessed.screen({ smartCSR: true, title: 'mcproc monit', fullUnicode: true });
  // wrap: false everywhere — the renderer already cuts lines to the width; blessed would wrap a full-width line inside a bordered box
  const header = blessed.box({ top: 0, left: 0, height: 1, width: '100%', wrap: false });
  const tableBox = blessed.box({ top: 1, left: 0, height: 'shrink', width: '100%', border: 'line', label: ' apps ', wrap: false });
  const logBox = blessed.box({ top: 0, left: 0, height: 10, width: '100%', border: 'line', label: ' logs ', scrollable: true, alwaysScroll: true, wrap: false });
  const detailsBox = blessed.box({ bottom: 1, left: 0, height: 8, width: '100%', border: 'line', label: ' details ', wrap: false });
  const footer = blessed.box({ bottom: 0, left: 0, height: 1, width: '100%', wrap: false });
  for (const b of [header, tableBox, logBox, detailsBox, footer]) screen.append(b);

  const paint = () => {
    const f = renderFrame(state, { width: (screen.width as number) - 2, height: screen.height as number }); // -2: the bordered boxes' interior
    header.setContent(f.header);
    tableBox.height = f.table.length + 2;
    logBox.top = 1 + f.table.length + 2;
    logBox.height = Math.max(5, (screen.height as number) - logBox.top - 9);
    tableBox.setContent(f.table.join('\n'));
    logBox.setLabel(` logs · ${selectedRow(state)?.app ?? '-'} · ${state.stream} `);
    logBox.setContent(f.logs.join('\n'));
    logBox.setScrollPerc(100);
    detailsBox.setContent(f.details.join('\n'));
    footer.setContent(f.footer);
    screen.render();
  };
  const dispatch = (a: MonitAction) => { state = reduce(state, a); paint(); };
  const loop = new MonitLoop(ctx, deps(opts.project), { lines: opts.lines }, () => state, dispatch);

  return new Promise<void>((resolve) => {
    const timer = setInterval(() => { void loop.refresh(); }, opts.intervalMs);
    const quit = () => { clearInterval(timer); screen.destroy(); resolve(); };
    screen.on('keypress', (_ch: string, key: { full?: string; name?: string }) => {
      const intent = keyIntent(key.full ?? key.name ?? '', state);
      if (!intent) return;
      if (intent.kind === 'quit') return quit();
      if (intent.kind === 'action') {
        if (intent.action.type === 'select') loop.dispatchSelect(intent.action.delta);
        else dispatch(intent.action);
        return;
      }
      if (intent.kind === 'host-next') return void loop.switchHost(state.hosts[(state.hosts.indexOf(state.host) + 1) % state.hosts.length]);
      void loop.runCommand(intent.cmd, intent.app);
    });
    screen.on('resize', paint);
    void loop.refresh().then(paint);
  });
}

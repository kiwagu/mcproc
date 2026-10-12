import blessed from '@pm2/blessed';
import { prepare } from '../core/resolve.js';
import type { Manifest } from '../core/manifest.js';
import { rowsFor, snapshot } from '../core/list.js';
import { Fleet, actOn } from '../core/fleet.js';
import { LogFollower } from '../core/logfollow.js';
import { appInfos, initialState, keyIntent, monitViews, reduce, selectedRow, viewLabel, type MonitAction, type MonitState } from './state.js';
import { paneTitle, renderFrame, type Frame } from './frame.js';
import { colorFor } from '../core/logstream.js';
import { MonitLoop, type LoopDeps } from './loop.js';

const deps = (manifest: Manifest): LoopDeps => ({
  fleet: (requested) => new Fleet(manifest, requested),
  snapshot,
  rows: rowsFor,
  follower: (ctx, paths, lines) => new LogFollower(ctx, paths, lines),
  command: (fleet, cmd, app) => actOn(fleet, app, cmd),
});

/** The blessed shell: it only paints frames from the pure renderer and forwards keys to the loop. */
export async function runMonit(opts: { project?: string; host?: string; intervalMs: number; lines: number }): Promise<void> {
  const { manifest } = prepare({ project: opts.project });
  // apps bound to a host (`host:`) are shown from there: without --host the screen opens on every app at its own host
  const views = monitViews(manifest);
  const fleet = new Fleet(manifest, opts.host ?? views[0]);
  fleet.select(['all']); // a --host that no app runs on is refused here, before the screen takes the terminal
  let state: MonitState = initialState({ project: manifest.project, host: viewLabel(fleet.requested), hosts: views.map(viewLabel), apps: appInfos(manifest) });

  const screen = blessed.screen({ smartCSR: true, title: 'mcproc monit', fullUnicode: true });
  // No frames: every pane is a one-line title rule plus full-width content, so a terminal drag-selection copies text only
  // (blessed enables mouse tracking only when something listens for mouse events, and nothing here does).
  // wrap: false everywhere — the renderer already cuts lines to the width.
  const box = (opts: Record<string, unknown>) => blessed.box({ left: 0, width: '100%', wrap: false, ...opts });
  const header = box({ top: 0, height: 1 });
  const appsTitle = box({ top: 1, height: 1 });
  const tableBox = box({ top: 2, height: 1 });
  const logsTitle = box({ top: 3, height: 1 });
  const logBox = box({ top: 4, height: 5, scrollable: true, alwaysScroll: true });
  const detailsTitle = box({ bottom: 7, height: 1 });
  const detailsBox = box({ bottom: 1, height: 6 });
  const footer = box({ bottom: 0, height: 1 });
  for (const b of [header, appsTitle, tableBox, logsTitle, logBox, detailsTitle, detailsBox, footer]) screen.append(b);

  // labels get the same ANSI colors as `mcproc logs`; blessed renders SGR codes in content, and the log text itself is
  // already ANSI-stripped by the follower, so no tag syntax and no escaping are involved
  const appColor = new Map(Object.keys(manifest.apps).map((a, i) => [a, colorFor(i)]));
  const colorLabel = (line: string) => {
    const m = /^(\S+)(\s*)( [|!] )/.exec(line); // continuation rows start with spaces and keep no label
    const c = m && appColor.get(m[1]);
    return c ? `\x1b[${c}m${m[1]}\x1b[0m${line.slice(m[1].length)}` : line;
  };

  let frame: Frame | null = null;
  const paint = () => {
    const w = screen.width as number;
    const h = screen.height as number;
    const f = renderFrame(state, { width: w, height: h });
    frame = f;
    const scrolled = f.scroll ? ` · ↑${f.scroll} (End: tail)` : '';
    header.setContent(f.header);
    footer.setContent(f.footer);
    if (state.view === 'flat') {
      for (const b of [appsTitle, tableBox, detailsTitle, detailsBox]) b.hide();
      logsTitle.top = 1;
      logsTitle.setContent(paneTitle(`logs · all apps · ${state.stream}${scrolled}`, w));
      logBox.top = 2;
      logBox.height = Math.max(3, h - 3);
      logBox.setContent(f.logs.map(colorLabel).join('\n'));
    } else {
      for (const b of [appsTitle, tableBox, detailsTitle, detailsBox]) b.show();
      appsTitle.setContent(paneTitle('apps', w));
      tableBox.height = f.table.length;
      tableBox.setContent(f.table.join('\n'));
      logsTitle.top = 2 + f.table.length;
      logsTitle.setContent(paneTitle(`logs · ${selectedRow(state)?.app ?? '-'} · ${state.stream}${scrolled}`, w));
      logBox.top = 3 + f.table.length;
      logBox.height = Math.max(3, h - logBox.top - 8); // 8: details title + 6 details + footer
      logBox.setContent(f.logs.join('\n'));
      detailsTitle.setContent(paneTitle('details', w));
      detailsBox.setContent(f.details.join('\n'));
    }
    logBox.setScrollPerc(100);
    screen.render();
  };
  const dispatch = (a: MonitAction) => {
    state = reduce(state, a.type === 'scroll' ? { ...a, max: frame?.maxScroll } : a); // the pane's real ceiling clamps the scroll
    paint();
  };
  const loop = new MonitLoop(fleet, deps(manifest), { lines: opts.lines }, () => state, dispatch);

  return new Promise<void>((resolve) => {
    const timer = setInterval(() => { void loop.refresh(); }, opts.intervalMs);
    const quit = () => { clearInterval(timer); screen.destroy(); resolve(); };
    screen.on('keypress', (_ch: string, key: { full?: string; name?: string }) => {
      const intent = keyIntent(key.full ?? key.name ?? '', state);
      if (!intent) return;
      if (intent.kind === 'quit') return quit();
      if (intent.kind === 'action') {
        if (intent.action.type === 'select') loop.dispatchSelect(intent.action.delta);
        else { dispatch(intent.action); if (intent.action.type === 'view') void loop.refresh(); } // fill the new view at once
        return;
      }
      if (intent.kind === 'host-next') return void loop.nextView();
      void loop.runCommand(intent.cmd, intent.app);
    });
    screen.on('resize', paint);
    void loop.refresh().then(paint);
  });
}

import blessed from '@pm2/blessed';
import { prepare } from '../core/resolve.js';
import type { Manifest } from '../core/manifest.js';
import { rowsFor, snapshot } from '../core/list.js';
import { Fleet, actOn } from '../core/fleet.js';
import { createFollower } from '../core/logfollow.js';
import {
  appInfos,
  CONFIRM_MS,
  initialState,
  keyIntent,
  monitViews,
  viewLabel,
  type MonitState,
} from './state.js';
import {
  logsTitle,
  paneTitle,
  renderFrame,
  scrollTo,
  type Frame,
} from './frame.js';
import { colorFor } from '../core/logstream.js';
import { MonitLoop, peekView, reloadView, type LoopDeps } from './loop.js';
import { screenDispatch } from './dispatch.js';
import { clearLogs, readStore, storePath } from '../core/incidents/store.js';
import { takenPoints } from '../core/incidents/taken.js';

const deps = (manifest: Manifest): LoopDeps => ({
  fleet: (requested) => new Fleet(manifest, requested),
  snapshot,
  rows: rowsFor,
  follower: createFollower,
  command: (fleet, cmd, app) => actOn(fleet, app, cmd),
  reloadAll: reloadView,
  clear: (fleet, apps) => clearLogs(fleet, apps),
  cleared: (fleet) => {
    const s = readStore(storePath(fleet.manifest.path));
    return { at: s.cleared, gen: s.clears, taken: takenPoints(s) };
  },
  peekIncidents: (fleet, names, cursor, restart) =>
    peekView(fleet, names, cursor, restart),
});

/** A blessed screen: monit's own, or the stacks overview's that monit draws on for a while. */
export type Screen = ReturnType<typeof blessed.screen>;

/**
 * The blessed shell: it only paints frames from the pure renderer and forwards keys to the loop. On a screen the caller
 * owns (the stacks overview) it draws there and leaves it as it found it, and with `back` esc returns 'back' to it.
 */
export async function runMonit(opts: {
  project?: string;
  host?: string;
  intervalMs: number;
  lines: number;
  screen?: Screen;
  back?: boolean;
}): Promise<'quit' | 'back'> {
  const { manifest } = prepare({ project: opts.project });
  // apps bound to a host (`host:`) are shown from there: without --host the screen opens on every app at its own host
  const views = monitViews(manifest);
  const fleet = new Fleet(manifest, opts.host ?? views[0]);
  fleet.select(['all']); // a --host that no app runs on is refused here, before the screen takes the terminal
  let state: MonitState = initialState({
    project: manifest.project,
    host: viewLabel(fleet.requested),
    hosts: views.map(viewLabel),
    apps: appInfos(manifest),
    toStacks: Boolean(opts.back),
  });

  const own = !opts.screen;
  const screen =
    opts.screen ??
    blessed.screen({
      smartCSR: true,
      title: 'mcproc monit',
      fullUnicode: true,
    });
  // No frames: every pane is a one-line title rule plus full-width content, so a terminal drag-selection copies text only
  // (blessed enables mouse tracking only when something listens for mouse events, and nothing here does).
  // wrap: false everywhere — the renderer already cuts lines to the width.
  const box = (opts: Record<string, unknown>) =>
    blessed.box({ left: 0, width: '100%', wrap: false, ...opts });
  const header = box({ top: 0, height: 1 });
  const appsTitle = box({ top: 1, height: 1 });
  const tableBox = box({ top: 2, height: 1 });
  const logsHead = box({ top: 3, height: 1 });
  const logBox = box({
    top: 4,
    height: 5,
    scrollable: true,
    alwaysScroll: true,
  });
  const detailsTitle = box({ bottom: 7, height: 1 });
  const detailsBox = box({ bottom: 1, height: 6 });
  const footer = box({ bottom: 0, height: 1 });
  const boxes = [
    header,
    appsTitle,
    tableBox,
    logsHead,
    logBox,
    detailsTitle,
    detailsBox,
    footer,
  ];
  for (const b of boxes) screen.append(b);

  // labels get the same ANSI colors as `mcproc logs`; blessed renders SGR codes in content, and the log text itself is
  // reduced by screen text to the apps' own color codes in the form blessed reads; tags are off, so no escaping is involved
  const appColor = new Map(
    Object.keys(manifest.apps).map((a, i) => [a, colorFor(i)])
  );
  const colorLabel = (line: string) => {
    const m = /^(\S+)(\s*)( [|!] )/.exec(line); // continuation rows start with spaces and keep no label
    const c = m && appColor.get(m[1]);
    return c ? `\x1b[${c}m${m[1]}\x1b[0m${line.slice(m[1].length)}` : line;
  };

  const size = () => ({
    width: screen.width as number,
    height: screen.height as number,
  });
  /** monit has left the screen: a paint that a late dispatch or the first refresh still asks for touches nothing */
  let left = false;
  const show = (f: Frame) => {
    if (left) return;
    const { width: w, height: h } = size();
    header.setContent(f.header);
    footer.setContent(f.footer);
    if (state.view !== 'dashboard') {
      // the flat view and the incidents view: one pane across the screen
      for (const b of [appsTitle, tableBox, detailsTitle, detailsBox]) b.hide();
      logsHead.top = 1;
      logsHead.setContent(paneTitle(logsTitle(state, f.scroll), w));
      logBox.top = 2;
      logBox.height = Math.max(3, h - 3);
      logBox.setContent(
        (state.view === 'flat' ? f.logs.map(colorLabel) : f.logs).join('\n')
      );
    } else {
      for (const b of [appsTitle, tableBox, detailsTitle, detailsBox]) b.show();
      appsTitle.setContent(paneTitle('apps', w));
      tableBox.height = f.table.length;
      tableBox.setContent(f.table.join('\n'));
      logsHead.top = 2 + f.table.length;
      logsHead.setContent(paneTitle(logsTitle(state, f.scroll), w));
      logBox.top = 3 + f.table.length;
      logBox.height = Math.max(3, h - logBox.top - 8); // 8: details title + 6 details + footer
      logBox.setContent(f.logs.join('\n'));
      detailsTitle.setContent(paneTitle('details', w));
      detailsBox.setContent(f.details.join('\n'));
    }
    logBox.setScrollPerc(100);
    screen.render();
  };
  // reduce at once, paint once per burst (a wheel notch is three key presses), clamp a scroll by the pane as it is now
  const { dispatch, paint } = screenDispatch({
    get: () => state,
    set: (s) => {
      state = s;
    },
    render: (s) => renderFrame(s, size()),
    show,
    scrollTo: (s, delta) => scrollTo(s, size(), delta),
  });
  const loop = new MonitLoop(
    fleet,
    deps(manifest),
    { lines: opts.lines },
    () => state,
    dispatch
  );

  return new Promise<'quit' | 'back'>((resolve) => {
    const timer = setInterval(() => {
      void loop.refresh();
    }, opts.intervalMs);
    // a screen of its own goes with monit; the overview's screen is left as monit found it, its own boxes taken off
    const leave = (why: 'quit' | 'back') => {
      left = true;
      clearInterval(timer);
      loop.close();
      screen.removeListener('keypress', onKey);
      screen.removeListener('resize', paint);
      if (own) screen.destroy();
      else for (const b of boxes) b.detach();
      resolve(why);
    };
    const onKey = (_ch: string, key: { full?: string; name?: string }) => {
      const intent = keyIntent(key.full ?? key.name ?? '', state);
      // a pending clear or reload waits for the second press of its key; any other key cancels it (c and R arm their own)
      if (
        state.armedAt !== null &&
        !(intent?.kind === 'action' && intent.action.type === 'arm')
      )
        dispatch({ type: 'arm', at: null });
      if (!intent) return;
      if (intent.kind === 'quit') return leave('quit');
      if (intent.kind === 'back') return leave('back');
      if (intent.kind === 'action') {
        if (intent.action.type === 'arm' && intent.action.at !== null) {
          const { at, what } = intent.action;
          setTimeout(() => {
            if (state.armedAt === at && state.armed === what)
              dispatch({ type: 'arm', at: null });
          }, CONFIRM_MS + 50).unref();
        }
        if (intent.action.type === 'select')
          loop.dispatchSelect(intent.action.delta);
        else {
          dispatch(intent.action);
          if (intent.action.type === 'view') void loop.refresh();
        } // fill the new view at once
        return;
      }
      if (intent.kind === 'host-next') return void loop.nextView();
      if (intent.kind === 'clear') return void loop.runClear(intent.apps);
      if (intent.kind === 'reload-all') return void loop.reloadAll();
      void loop.runCommand(intent.cmd, intent.app);
    };
    screen.on('keypress', onKey);
    screen.on('resize', paint);
    void loop.refresh().then(paint);
  });
}

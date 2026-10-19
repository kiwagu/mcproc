import blessed from '@pm2/blessed';
import { describeError } from '../core/errors.js';
import { StacksCollector } from '../core/stacks/collect.js';
import { stopStack, type StackStop } from '../core/stacks/stop.js';
import { CONFIRM_MS } from './state.js';
import {
  initialOverview,
  overviewKey,
  reduceOverview,
  type OverviewAction,
  type OverviewState,
} from './stacks-state.js';
import { overviewToText, renderOverview } from './stacks-frame.js';
import { runMonit } from './tui.js';

/** The footer line after `x x`: what stopped, the readonly hosts left alone, the hosts that failed. */
export function stopNotice(project: string, r: StackStop): string {
  const n = r.stopped.length;
  const parts = [`stopped ${n} app${n === 1 ? '' : 's'} of ${project}`];
  for (const x of r.readonly)
    parts.push(`readonly: ${x.host} (${x.apps.length})`);
  for (const f of r.failed) parts.push(`failed: ${f.host} ${f.message}`);
  return parts.join(' · ');
}

/** One overview frame as text: what `monit --all --once` prints. */
export async function overviewOnce(opts: {
  width?: number;
  all?: boolean;
}): Promise<string> {
  const view = await new StacksCollector().collect({
    all: Boolean(opts.all),
  });
  const s = reduceOverview(initialOverview({}), {
    type: 'view',
    view,
    at: new Date(),
  });
  return overviewToText(
    renderOverview(s, { width: opts.width ?? 120, height: 1000 })
  );
}

/**
 * The stacks overview: every stack of the host; Enter opens one in monit on the same screen and esc there comes back.
 * One screen for both, so blessed never re-enters raw mode or rebinds stdin between them.
 */
export async function runOverview(opts: {
  intervalMs: number;
  lines: number;
  selected?: string;
}): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'mcproc monit',
    fullUnicode: true,
  });
  // the same panes as monit: one-line title rules, no frames, full-width content cut to the width by the renderer
  const box = (o: Record<string, unknown>) =>
    blessed.box({ left: 0, width: '100%', wrap: false, ...o });
  const header = box({ top: 0, height: 1 });
  const title = box({ top: 1, height: 1 });
  const tableBox = box({ top: 2, height: 1 });
  const appsTitle = box({ top: 3, height: 1 });
  const appsBox = box({ top: 4, height: 1 });
  const footer = box({ bottom: 0, height: 1 });
  const boxes = [header, title, tableBox, appsTitle, appsBox, footer];
  const attach = () => {
    for (const b of boxes) screen.append(b);
  };
  const detach = () => {
    for (const b of boxes) b.detach();
  };
  attach();

  const collector = new StacksCollector();
  let state: OverviewState = initialOverview({ selected: opts.selected });
  /** false while monit has the screen: the overview neither paints nor takes keys */
  let active = true;
  const paint = () => {
    if (!active) return;
    const f = renderOverview(state, {
      width: screen.width as number,
      height: screen.height as number,
    });
    header.setContent(f.header);
    title.setContent(f.title);
    tableBox.height = f.table.length;
    tableBox.setContent(f.table.join('\n'));
    appsTitle.top = 2 + f.table.length;
    appsTitle.setContent(f.appsTitle);
    appsBox.top = 3 + f.table.length;
    appsBox.height = Math.max(
      1,
      (screen.height as number) - (appsBox.top as number) - 1
    );
    appsBox.setContent(f.apps.join('\n'));
    footer.setContent(f.footer);
    screen.render();
  };
  const act = (a: OverviewAction) => {
    state = reduceOverview(state, a);
    paint();
  };
  let inflight = false;
  const refresh = async () => {
    if (inflight) return; // a slow probe delays the next tick instead of overlapping it
    inflight = true;
    try {
      const view = await collector.collect({ all: state.all });
      act({ type: 'view', view, at: new Date() });
    } catch (e) {
      act({ type: 'error', message: describeError(e) });
    } finally {
      inflight = false;
    }
  };
  let timer = setInterval(() => void refresh(), opts.intervalMs);

  return new Promise<void>((resolve) => {
    const quit = () => {
      clearInterval(timer);
      screen.destroy();
      resolve();
    };
    const onKey = async (key: string) => {
      const intent = overviewKey(key, state);
      // an armed stop waits for its second x; any other key cancels it
      if (
        state.armedAt !== null &&
        intent?.kind !== 'stop' &&
        !(intent?.kind === 'action' && intent.action.type === 'arm')
      )
        act({ type: 'arm', at: null });
      if (!intent) return;
      if (intent.kind === 'quit') return quit();
      if (intent.kind === 'action') {
        act(intent.action);
        if (intent.action.type === 'arm' && intent.action.at !== null) {
          const at = intent.action.at;
          setTimeout(() => {
            if (state.armedAt === at) act({ type: 'arm', at: null });
          }, CONFIRM_MS + 50).unref();
        }
        if (intent.action.type === 'toggle-all') void refresh();
        return;
      }
      const m = state.view?.manifests.get(intent.root);
      if (!m) {
        act({ type: 'notice', message: 'that stack is gone; refreshing' });
        return void refresh();
      }
      if (intent.kind === 'stop') {
        act({ type: 'busy', busy: true });
        const r = await stopStack(m);
        act({ type: 'busy', busy: false });
        act({ type: 'notice', message: stopNotice(m.project, r) });
        return void refresh();
      }
      // open: monit takes the screen until esc (back) or q (quit)
      active = false;
      clearInterval(timer);
      detach();
      const why = await runMonit({
        project: intent.root,
        intervalMs: opts.intervalMs,
        lines: opts.lines,
        screen,
        back: true,
      }).catch((e: unknown) => {
        state = reduceOverview(state, {
          type: 'error',
          message: describeError(e),
        });
        return 'back' as const;
      });
      if (why === 'quit') return quit();
      attach();
      active = true;
      timer = setInterval(() => void refresh(), opts.intervalMs);
      paint();
      void refresh();
    };
    screen.on(
      'keypress',
      (_ch: string, key: { full?: string; name?: string }) => {
        if (!active) return; // the drill-in owns the keys
        void onKey(key.full ?? key.name ?? '');
      }
    );
    screen.on('resize', paint);
    paint();
    void refresh();
  });
}

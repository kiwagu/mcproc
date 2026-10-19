import type { StacksView } from '../core/stacks/collect.js';
import type { Orphan, StackView } from '../core/stacks/types.js';
import { CONFIRM_MS } from './state.js';

/** A line of the stacks pane: a stack (keyed by its root) or a pm2 namespace no manifest claims. */
export type OverviewRow =
  | { kind: 'stack'; key: string; stack: StackView }
  | { kind: 'orphan'; key: string; orphan: Orphan };
export interface OverviewState {
  view: StacksView | null;
  /** the selected row's key, which the selection follows across refreshes */
  selected: string | null;
  index: number;
  /** list the recorded stacks with nothing in pm2 too */
  all: boolean;
  /** when the first x of a stop was pressed */
  armedAt: number | null;
  notice: string | null;
  error: string | null;
  busy: boolean;
  updatedAt: Date | null;
}
export type OverviewAction =
  | { type: 'view'; view: StacksView; at: Date }
  | { type: 'select'; delta: number }
  | { type: 'arm'; at: number | null }
  | { type: 'toggle-all' }
  | { type: 'notice'; message: string | null }
  | { type: 'error'; message: string }
  | { type: 'busy'; busy: boolean };
export type OverviewIntent =
  | { kind: 'action'; action: OverviewAction }
  | { kind: 'open'; root: string }
  | { kind: 'stop'; root: string }
  | { kind: 'quit' }
  | null;

const orphanKey = (o: Orphan) => `orphan:${o.endpoint}:${o.namespace}`;

/** The stacks in their order, then the namespaces no manifest claims. */
export function overviewRows(s: OverviewState): OverviewRow[] {
  if (!s.view) return [];
  return [
    ...s.view.stacks.map((stack) => ({
      kind: 'stack' as const,
      key: stack.root,
      stack,
    })),
    ...s.view.answer.orphans.map((orphan) => ({
      kind: 'orphan' as const,
      key: orphanKey(orphan),
      orphan,
    })),
  ];
}
export function selectedOverviewRow(s: OverviewState): OverviewRow | null {
  return overviewRows(s)[s.index] ?? null;
}
export function initialOverview(opts: { selected?: string }): OverviewState {
  return {
    view: null,
    selected: opts.selected ?? null,
    index: 0,
    all: false,
    armedAt: null,
    notice: null,
    error: null,
    busy: false,
    updatedAt: null,
  };
}
/** The apps a stop would stop: those that exist in pm2 and are not stopped already. */
const running = (st: StackView) =>
  st.rows.filter(
    (r) => r.pm_id !== null && r.status !== 'stopped' && r.status !== 'done'
  ).length;
export function stopPrompt(st: StackView): string {
  const n = running(st);
  return `press x again to stop ${n} app${n === 1 ? '' : 's'} of ${st.project}`;
}
const unloaded = (st: StackView) =>
  `${st.project}: the manifest did not load (${st.manifest_error?.code})`;

export function reduceOverview(
  s: OverviewState,
  a: OverviewAction
): OverviewState {
  switch (a.type) {
    case 'view': {
      const next = { ...s, view: a.view, updatedAt: a.at, error: null };
      const rows = overviewRows(next);
      const found = rows.findIndex((r) => r.key === s.selected);
      const index =
        found >= 0 ? found : Math.min(s.index, Math.max(0, rows.length - 1));
      const selected = rows[index]?.key ?? null;
      // a stop armed on a stack that left the selected line is dropped with its prompt: a second x would stop another one
      const moved = s.armedAt !== null && selected !== s.selected;
      return {
        ...next,
        index,
        selected,
        ...(moved ? { armedAt: null, notice: null } : {}),
      };
    }
    case 'select': {
      const rows = overviewRows(s);
      if (rows.length === 0) return s;
      const index = Math.max(0, Math.min(rows.length - 1, s.index + a.delta));
      return { ...s, index, selected: rows[index].key, armedAt: null };
    }
    case 'arm': {
      const r = selectedOverviewRow(s);
      if (a.at === null)
        return {
          ...s,
          armedAt: null,
          notice: s.armedAt !== null ? null : s.notice,
        };
      return {
        ...s,
        armedAt: a.at,
        notice: r?.kind === 'stack' ? stopPrompt(r.stack) : s.notice,
      };
    }
    case 'toggle-all':
      return { ...s, all: !s.all };
    case 'notice':
      return { ...s, notice: a.message, armedAt: null };
    case 'error':
      return { ...s, error: a.message };
    case 'busy':
      return { ...s, busy: a.busy };
  }
}

export function overviewKey(
  key: string,
  s: OverviewState,
  now = Date.now()
): OverviewIntent {
  const r = selectedOverviewRow(s);
  const notice = (message: string): OverviewIntent => ({
    kind: 'action',
    action: { type: 'notice', message },
  });
  switch (key) {
    case 'up':
    case 'k':
      return { kind: 'action', action: { type: 'select', delta: -1 } };
    case 'down':
    case 'j':
      return { kind: 'action', action: { type: 'select', delta: 1 } };
    case 'enter':
    case 'return': {
      if (!r) return null;
      if (r.kind === 'orphan')
        return notice('not an mcproc stack: no manifest to open');
      if (r.stack.manifest_error) return notice(unloaded(r.stack));
      // its monit would only show unreachable rows: say which host failed instead
      if (!r.stack.hosts.some((h) => h.reachable)) {
        const why = r.stack.hosts.find((h) => h.error);
        return notice(
          `${r.stack.project}: no host of this stack answers${why ? ` (${why.name}: ${why.error})` : ''}`
        );
      }
      return { kind: 'open', root: r.stack.root };
    }
    case 'x': {
      // x stops every app of the selected stack, so it asks twice: a second x within CONFIRM_MS does it
      if (!r || s.busy) return null;
      if (r.kind === 'orphan') return notice('not an mcproc stack: read-only');
      if (r.stack.manifest_error) return notice(unloaded(r.stack));
      if (s.armedAt !== null && now - s.armedAt <= CONFIRM_MS)
        return { kind: 'stop', root: r.stack.root };
      return { kind: 'action', action: { type: 'arm', at: now } };
    }
    case 'a':
      return { kind: 'action', action: { type: 'toggle-all' } };
    case 'q':
    case 'C-c':
    case 'escape':
      return { kind: 'quit' };
    default:
      return null;
  }
}

import { coalesce } from './coalesce.js';
import { reduce, type MonitAction, type MonitState } from './state.js';
import type { Frame } from './frame.js';

/**
 * The screen's dispatch: every action reduces at once, the screen paints once per burst (see coalesce), and a scroll
 * is clamped by the ceiling of the pane as it is NOW. The ceiling only changes with what the pane shows, never with the
 * scroll position, so a burst of scroll keys reuses the one of the last paint; a key that changed the pane in the same
 * burst (`b`, then Home) makes the next scroll measure it again instead of trusting a frame painted before that key.
 */
export function screenDispatch(io: {
  get: () => MonitState;
  set: (s: MonitState) => void;
  render: (s: MonitState) => Frame;
  show: (f: Frame) => void;
  defer?: (cb: () => void) => void;
  /** where a scroll of `delta` rows lands, measured on the pane as it is now (frame scrollTo); without it, whole entries */
  scrollTo?: (
    s: MonitState,
    delta: number
  ) => { entries: number; rows: number };
}): { dispatch: (a: MonitAction) => void; paint: () => void } {
  let ceiling: number | undefined;
  const paint = () => {
    const f = io.render(io.get());
    ceiling = f.maxScroll;
    io.show(f);
  };
  const schedule = coalesce(paint, io.defer);
  const dispatch = (a: MonitAction) => {
    if (a.type === 'scroll' && io.scrollTo) {
      io.set(reduce(io.get(), { ...a, to: io.scrollTo(io.get(), a.delta) }));
    } else if (a.type === 'scroll') {
      ceiling ??= io.render(io.get()).maxScroll;
      io.set(reduce(io.get(), { ...a, max: ceiling }));
    } else {
      io.set(reduce(io.get(), a));
      ceiling = undefined;
    }
    schedule();
  };
  return { dispatch, paint };
}

/**
 * Work asked for several times in one synchronous burst runs once, right after it: a wheel notch arrives as three key
 * events in one input chunk, a refresh dispatches rows and an error together, and the screen needs one paint for each
 * burst. The run is a microtask, so it happens before the next input or I/O callback: a key never acts on a frame
 * older than the state (the scroll ceiling comes from the last painted frame).
 */
export function coalesce(
  run: () => void,
  defer: (cb: () => void) => void = queueMicrotask
): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    defer(() => {
      pending = false;
      run();
    });
  };
}

import { describe, it, expect } from 'vitest';
import { coalesce } from '../../src/monit/coalesce.js';

describe('coalesce', () => {
  it('calls within one turn of the event loop run the work once, after them; a later turn runs it again', async () => {
    let runs = 0;
    const paint = coalesce(() => { runs++; });
    paint(); paint(); paint(); // a wheel notch: three key events in one input chunk
    expect(runs).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(runs).toBe(1);
    paint();
    await new Promise((r) => setImmediate(r));
    expect(runs).toBe(2);
  });
  it('the paint runs right after the burst, before the next input or I/O callback: the next key sees the painted frame', async () => {
    let runs = 0;
    const paint = coalesce(() => { runs++; });
    paint(); paint();
    await Promise.resolve(); // one microtask later, still before any I/O callback
    expect(runs).toBe(1);
  });
});

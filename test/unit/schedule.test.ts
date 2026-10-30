import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EVENT_DEBOUNCE_MS,
  HostSchedule,
  PORT_CHECKS_MS,
  SAFETY_MS,
  type Settled,
} from '../../src/monit/schedule.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A schedule whose reads are recorded (ms since its start) and end at once with what `world` says, as the loop's do. */
function harness(
  intervalMs = 2000,
  world: Settled = { running: false, portsPending: false }
) {
  const t0 = Date.now();
  const at: number[] = [];
  const s: HostSchedule = new HostSchedule({
    intervalMs,
    refresh: () => {
      at.push(Date.now() - t0);
      queueMicrotask(() => s.settled({ ...world }));
    },
  });
  return { s, at, world };
}

describe('HostSchedule', () => {
  it('polled: a read every interval, as before', async () => {
    const { s, at } = harness();
    s.start();
    await vi.advanceTimersByTimeAsync(6000);
    expect(at).toEqual([2000, 4000, 6000]);
    s.stop();
  });
  it('events, nothing running: no read for 25 s, one at 30 s, then one every 30 s', async () => {
    const { s, at } = harness();
    s.start();
    s.setMode('events');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(at).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(at).toEqual([SAFETY_MS]);
    await vi.advanceTimersByTimeAsync(SAFETY_MS);
    expect(at).toEqual([SAFETY_MS, 2 * SAFETY_MS]);
    s.stop();
  });
  it('an event: one read 100 ms later for a burst of them', async () => {
    const { s, at } = harness();
    s.start();
    s.setMode('events');
    s.event();
    await vi.advanceTimersByTimeAsync(50);
    s.event();
    s.event();
    await vi.advanceTimersByTimeAsync(EVENT_DEBOUNCE_MS);
    expect(at).toEqual([EVENT_DEBOUNCE_MS]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(at).toEqual([EVENT_DEBOUNCE_MS]); // nothing runs, no port waits: nothing more until the safety read
    s.stop();
  });
  it('an app running: a read every interval for its CPU, none once a read found it stopped', async () => {
    const { s, at, world } = harness(2000, {
      running: true,
      portsPending: false,
    });
    s.start();
    s.setMode('events');
    s.settled({ ...world }); // the read that found it running
    await vi.advanceTimersByTimeAsync(4000);
    expect(at).toEqual([2000, 4000]);
    world.running = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(at).toEqual([2000, 4000, 6000]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(at).toEqual([2000, 4000, 6000]);
    s.stop();
  });
  it("after an event, reads at 0.5, 1, 2, 4 and 8 s while a running app's declared ports do not listen", async () => {
    const { s, at } = harness(60_000, { running: true, portsPending: true });
    s.start();
    s.setMode('events');
    s.event();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(at).toEqual([EVENT_DEBOUNCE_MS, ...PORT_CHECKS_MS]);
    s.stop();
  });
  it('the feed coming up starts the port checks too: an app still launching then shows its port within seconds', async () => {
    const { s, at, world } = harness(60_000, {
      running: true,
      portsPending: true,
    });
    s.start();
    s.settled({ ...world }); // a polled read found it launching
    s.setMode('events');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(at).toEqual([...PORT_CHECKS_MS]);
    s.stop();
  });
  it('a check that finds every declared port listening ends the checks', async () => {
    const { s, at, world } = harness(60_000, {
      running: true,
      portsPending: true,
    });
    s.start();
    s.setMode('events');
    s.event();
    await vi.advanceTimersByTimeAsync(600);
    world.portsPending = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(at).toEqual([EVENT_DEBOUNCE_MS, 500, 1000]);
    s.stop();
  });
  it('back to the interval when the feed drops, and to events when it is up again', async () => {
    const { s, at } = harness();
    s.start();
    s.setMode('events');
    await vi.advanceTimersByTimeAsync(3000);
    expect(at).toEqual([]);
    s.setMode('polled');
    await vi.advanceTimersByTimeAsync(4000);
    expect(at).toEqual([5000, 7000]);
    s.setMode('events');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(at).toEqual([5000, 7000]);
    s.stop();
  });
  it('polled ignores events; stop ends every read', async () => {
    const { s, at } = harness();
    s.start();
    s.event();
    await vi.advanceTimersByTimeAsync(1000);
    expect(at).toEqual([]);
    s.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(at).toEqual([]);
  });
});

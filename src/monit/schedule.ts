/** A read a pm2 event asks for waits this long, so a burst of events (a restart removes and writes its pid file) is read once. */
export const EVENT_DEBOUNCE_MS = 100;
/** After an event (or the feed coming up), while a running app's declared ports do not all listen, the group is read at these times. */
export const PORT_CHECKS_MS = [500, 1000, 2000, 4000, 8000] as const;
/** An event-driven group is read at least this often: for what pm2 does not announce (a stopped app deleted, a process outside pm2 taking a port). */
export const SAFETY_MS = 30_000;

/** What a read of the group found: whether an app runs, and whether one that runs has a declared port that does not listen. */
export interface Settled {
  running: boolean;
  portsPending: boolean;
}

/**
 * When one host group of the monit view is read. Polled (another host, or nothing to watch): every `intervalMs`, as
 * before. Event-driven (this machine, its pid files watched): EVENT_DEBOUNCE_MS after a pm2 event; every `intervalMs`
 * while an app of the group runs (CPU is a difference of two samples; with nothing running there is none to take); at
 * PORT_CHECKS_MS after an event, or after the feed came up, while a running app's declared ports do not all listen; and
 * SAFETY_MS after the last read in any case. The reads the screen's keys ask for are the loop's own, as before.
 */
export class HostSchedule {
  private mode: 'polled' | 'events' = 'polled';
  private last: Settled = { running: false, portsPending: false };
  private poll: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private safety: NodeJS.Timeout | null = null;
  private check: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly o: { intervalMs: number; refresh: () => void }
  ) {}

  /** Starts polled: the group is read every interval until its feed is up. */
  start(): void {
    this.armPoll();
  }

  setMode(mode: 'polled' | 'events'): void {
    if (this.stopped || mode === this.mode) return;
    this.mode = mode;
    this.clearAll();
    if (mode === 'polled') {
      this.armPoll();
      return;
    }
    this.armSafety();
    if (this.last.running) this.armTick();
    // an app may be launching as the feed comes up: its ports are checked as after an event
    this.armCheck(0);
  }

  /** A pm2 event of the group's processes: one read soon, and the port checks start over. */
  event(): void {
    if (this.stopped || this.mode !== 'events') return;
    this.soon ??= setTimeout(() => {
      this.soon = null;
      this.o.refresh();
    }, EVENT_DEBOUNCE_MS);
    if (this.check) clearTimeout(this.check);
    this.armCheck(0);
  }

  /** A read of the group ended (or failed) with what it found. */
  settled(s: Settled): void {
    this.last = s;
    if (this.stopped || this.mode !== 'events') return;
    this.armSafety();
    if (s.running) {
      if (!this.tick) this.armTick();
    } else if (this.tick) {
      clearTimeout(this.tick);
      this.tick = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearAll();
  }

  private armPoll(): void {
    if (this.stopped) return;
    this.poll = setTimeout(() => {
      this.poll = null;
      this.o.refresh();
      this.armPoll();
    }, this.o.intervalMs);
  }

  private armTick(): void {
    if (this.stopped) return;
    this.tick = setTimeout(() => {
      this.tick = null;
      this.o.refresh();
    }, this.o.intervalMs);
  }

  private armSafety(): void {
    if (this.safety) clearTimeout(this.safety);
    this.safety = null;
    if (this.stopped) return;
    this.safety = setTimeout(() => {
      this.safety = null;
      this.o.refresh();
    }, SAFETY_MS);
  }

  /** Port check number `step` after the event: it reads only while a running app's declared ports do not all listen, and ends the checks otherwise. */
  private armCheck(step: number): void {
    this.check = null;
    if (this.stopped || step >= PORT_CHECKS_MS.length) return;
    const gap =
      PORT_CHECKS_MS[step] - (step > 0 ? PORT_CHECKS_MS[step - 1] : 0);
    this.check = setTimeout(() => {
      this.check = null;
      if (!this.last.portsPending) return;
      this.o.refresh();
      this.armCheck(step + 1);
    }, gap);
  }

  private clearAll(): void {
    for (const t of [this.poll, this.soon, this.tick, this.safety, this.check])
      if (t) clearTimeout(t);
    this.poll = null;
    this.soon = null;
    this.tick = null;
    this.safety = null;
    this.check = null;
  }
}

import { describe, it, expect } from 'vitest';
import { listFleet } from '../../src/core/fleet.js';
import { CONTEXT_BYTES, READ_CAP } from '../../src/core/incidents/cursor.js';
import type { LsRow } from '../../src/core/list.js';
import type { Manifest } from '../../src/core/manifest.js';
import { countReloads, listWithReloads } from '../../src/core/reloadcount.js';
import {
  fakeHosts,
  fleetManifest,
  proc,
  S,
  type FakeState,
} from '../helpers/incidents.js';

// the fake hosts run at +0000: pm2's start (epoch ms) is the wall time the log stamps are written in
const START = '2026-10-12T11:00:00';
const running = (app: string, pm_id: number, extra: object = {}) =>
  proc(app, pm_id, { pm_uptime: Date.parse(`${START}Z`), ...extra });
const withApps = (apps: Partial<Manifest['apps']>): Manifest => ({
  ...fleetManifest,
  apps: { ...fleetManifest.apps, ...apps } as Manifest['apps'],
});

/** ls over every app of the fleet, then the reload count on top of it, as `ls --reloads` does. */
async function lsReloads(
  state: FakeState,
  manifest = fleetManifest,
  opts: { budgetMs?: number } = {}
) {
  const h = fakeHosts(state, [], manifest);
  const listed = await listFleet(h.fleet, h.fleet.select(['all']));
  const r = await countReloads(h.fleet, listed.probes, listed.rows, opts);
  const row = (app: string) => r.rows.find((x) => x.app === app)!;
  return { ...h, ...r, row };
}

// this run: the boot, two Vite bursts and a tsx restart with its re-listen
const thisRun = [
  `${S(1)}listening on :3000`,
  `${S(10)}[vite] page reload src/a.ts`,
  `${S(10)}[vite] page reload src/b.ts`,
  `${S(20)}[vite] (client) hmr update /src/c.css`,
  `${S(30)}8:17:10 PM [tsx] change in ./dist/index.js Restarting...`,
  `${S(31)}listening on :3000`,
]
  .map((l) => `${l}\n`)
  .join('');

describe('countReloads (ls --reloads)', () => {
  it("counts a running app's reloads since its pm2 start, the boot not among them, with the last one's stamp", async () => {
    const r = await lsReloads({
      files: { '/l/web-out': thisRun },
      procs: { box: [running('web', 3)] },
    });
    expect(r.row('web').started).toBe('2026-10-12T11:00:00.000');
    expect(r.row('web').reloads).toEqual({
      count: 3,
      last: '2026-10-12T11:00:30',
      partial: false,
    });
    expect(r.errors).toEqual([]);
    // one read script, on the only host with an app to count, over that app's two logs
    expect(r.reads).toEqual(['box']);
    expect(r.scripts[0]).toContain("'/l/web-out'");
    expect(r.scripts[0]).toContain("'/l/web-err'");
  });
  it('a previous run in the same file is not counted', async () => {
    const before = [
      '2026-10-12T10:58:00: listening on :3000',
      '2026-10-12T10:58:30: [vite] page reload src/old.ts',
      '2026-10-12T10:59:00: 8:15:00 PM [tsx] change in ./dist/index.js Restarting...',
      '2026-10-12T10:59:01: listening on :3000',
    ]
      .map((l) => `${l}\n`)
      .join('');
    const r = await lsReloads({
      files: { '/l/web-out': before + thisRun },
      procs: { box: [running('web', 3)] },
    });
    expect(r.row('web').reloads).toEqual({
      count: 3,
      last: '2026-10-12T11:00:30',
      partial: false,
    });
  });
  it('a log longer than the read whose window begins after the start: partial, the count of the window', async () => {
    const traffic = `${S(3)}GET /api/items 200 ${'x'.repeat(80)}\n`.repeat(
      12_000
    ); // about 1.4 MB written after the start, more than one read takes
    const r = await lsReloads({
      files: {
        '/l/web-out': `${S(1)}listening on :3000\n${S(2)}[vite] page reload src/a.ts\n${traffic}${S(40)}[vite] page reload src/b.ts\n${S(50)}[tsx] change in ./dist/index.js Restarting...\n${S(50)}listening on :3000\n`,
      },
      procs: { box: [running('web', 3)] },
    });
    expect(r.row('web').reloads).toEqual({
      count: 2,
      last: '2026-10-12T11:00:50',
      partial: true,
    });
  });
  it('the read reaches byte 0 up to READ_CAP + CONTEXT_BYTES bytes: the boot is known and the count whole; one byte more and it is partial', async () => {
    /** a log of exactly `size` bytes: the boot, traffic after it, one re-listen at the end */
    const sized = (size: number) => {
      const head = `${S(1)}listening on :3000\n`;
      const tail = `${S(40)}listening on :3000\n`;
      const line = `${S(3)}GET /api/items 200 ${'x'.repeat(59)}\n`; // 100 bytes
      let fill = size - head.length - tail.length;
      const lines = line.repeat(Math.floor(fill / line.length) - 1);
      fill -= lines.length;
      const last = `${S(3)}GET / 200 ${'y'.repeat(fill - 32)}\n`;
      const log = head + lines + last + tail;
      expect(Buffer.byteLength(log)).toBe(size);
      return log;
    };
    const atCap = await lsReloads({
      files: { '/l/web-out': sized(READ_CAP + CONTEXT_BYTES) },
      procs: { box: [running('web', 3)] },
    });
    expect(atCap.row('web').reloads).toEqual({
      count: 1,
      last: '2026-10-12T11:00:40',
      partial: false,
    });
    const past = await lsReloads({
      files: { '/l/web-out': sized(READ_CAP + CONTEXT_BYTES + 1) },
      procs: { box: [running('web', 3)] },
    });
    expect(past.row('web').reloads).toEqual({
      count: 1,
      last: '2026-10-12T11:00:40',
      partial: true,
    });
  });
  it("a short read (the file rotated while it was read) reaches nowhere: its lines are not counted and the count is partial; the other stream's still are", async () => {
    const r = await lsReloads({
      short: ['/l/web-out'],
      files: {
        '/l/web-out': thisRun,
        '/l/web-err': `${S(20)}[vite] page reload src/x.ts\n`,
      },
      procs: { box: [running('web', 3)] },
    });
    expect(r.row('web').reloads).toEqual({
      count: 1,
      last: '2026-10-12T11:00:20',
      partial: true,
    });
  });
  it('a log cleared during the run starts at byte 0 but long after the start: partial, and its first re-listen is a reload, not the boot', async () => {
    const r = await lsReloads({
      files: { '/l/web-out': '2026-10-12T11:05:00: listening on :3000\n' },
      procs: { box: [running('web', 3)] },
    });
    expect(r.row('web').reloads).toEqual({
      count: 1,
      last: '2026-10-12T11:05:00',
      partial: true,
    });
  });
  it('a log from byte 0 whose first line comes soon after the start holds the boot: its first re-listen is not counted', async () => {
    const r = await lsReloads({
      files: {
        '/l/web-out': `${S(20)}listening on :3000\n${S(40)}listening on :3000\n`,
      },
      procs: { box: [running('web', 3)] },
    });
    expect(r.row('web').reloads).toEqual({
      count: 1,
      last: '2026-10-12T11:00:40',
      partial: false,
    });
  });
  it('an app that has logged nothing yet has no reloads, and the count is whole', async () => {
    const r = await lsReloads({
      files: {},
      procs: { box: [running('web', 3)] },
    });
    expect(r.row('web').reloads).toEqual({
      count: 0,
      last: null,
      partial: false,
    });
  });
  it('a stopped app, an app with reloads: false, an app without a start and an app not started get no reloads field, and no log is read', async () => {
    const m = withApps({
      tool: { ...fleetManifest.apps.tool, reloads: null },
    });
    const r = await lsReloads(
      {
        files: {
          '/l/watch-out': `${S(12)}File change detected. Starting incremental compilation...\n`,
          '/l/tool-out': `${S(12)}[nodemon] restarting due to changes...\n`,
          '/l/web-out': thisRun,
        },
        procs: {
          local: [
            running('watch', 0, { status: 'stopped' }),
            running('tool', 1),
          ],
          box: [proc('web', 3)], // pm2 reported no start time
          ro: [],
        },
      },
      m
    );
    expect(r.row('tool').status).toBe('online');
    expect(r.row('web').started).toBeNull();
    for (const app of ['watch', 'web', 'tool', 'audit'])
      expect(r.row(app), app).not.toHaveProperty('reloads');
    expect(r.reads).toEqual([]);
    expect(r.errors).toEqual([]);
  });
  it("a host whose read fails: its rows stay without reloads and errors names it; the other host's rows are counted", async () => {
    const r = await lsReloads({
      failReads: ['box'],
      files: {
        '/l/watch-out': `${S(1)}Starting compilation in watch mode...\n${S(12)}File change detected. Starting incremental compilation...\n`,
        '/l/web-out': thisRun,
      },
      procs: { local: [running('watch', 0)], box: [running('web', 3)] },
    });
    expect(r.row('watch').reloads).toEqual({
      count: 1,
      last: '2026-10-12T11:00:12',
      partial: false,
    });
    expect(r.row('web')).not.toHaveProperty('reloads');
    expect(r.errors).toEqual([
      {
        host: 'box',
        apps: ['web'],
        message: expect.stringMatching(
          /^reloads not counted: TRANSPORT_FAILED/
        ),
      },
    ]);
  });
  it('an app whose own reloads patterns run away is named in errors without its count; the other apps of its host are counted', async () => {
    const m = withApps({
      tool: {
        ...fleetManifest.apps.tool,
        reloads: { match: ['^(a|aa)+$'], ignore: [], defaults: true },
      },
    });
    const r = await lsReloads(
      {
        files: {
          '/l/watch-out': `${S(12)}File change detected. Starting incremental compilation...\n`,
          '/l/tool-out': `${S(12)}${'a'.repeat(40)}b\n`,
        },
        procs: { local: [running('watch', 0), running('tool', 1)] },
      },
      m,
      { budgetMs: 50 }
    );
    expect(r.row('watch').reloads).toMatchObject({ count: 1 });
    expect(r.row('tool')).not.toHaveProperty('reloads');
    expect(r.errors).toEqual([
      {
        host: 'local',
        apps: ['tool'],
        message: expect.stringMatching(
          /^reloads not counted: TIMEOUT.*the reloads patterns of tool/
        ),
      },
    ]);
  });
});

describe('listWithReloads (ls, with and without --reloads)', () => {
  const state = (): FakeState => ({
    failReads: ['box'],
    files: {
      '/l/watch-out': `${S(1)}Starting compilation in watch mode...\n${S(12)}File change detected. Starting incremental compilation...\n`,
      '/l/web-out': thisRun,
    },
    procs: { local: [running('watch', 0)], box: [running('web', 3)] },
  });
  const all = (h: ReturnType<typeof fakeHosts>) => h.fleet.select(['all']);
  /** how many commands each host was sent */
  const sent = async (h: ReturnType<typeof fakeHosts>, hosts: string[]) =>
    Promise.all(
      hosts.map(
        async (host) =>
          ((await h.fleet.ctx(host)) as unknown as { fake: { calls: [] } }).fake
            .calls.length
      )
    );
  it("without reloads: listFleet's rows and errors as they are, nothing unread, one probe per host and no log read", async () => {
    const plain = fakeHosts(state(), ['ro']);
    const listed = await listFleet(plain.fleet, all(plain));
    const h = fakeHosts(state(), ['ro']);
    const r = await listWithReloads(h.fleet, all(h), false);
    // uptime is measured against the clock of each call
    const still = (rows: LsRow[]) => rows.map(({ uptime_ms, ...x }) => x);
    expect({ ...r, rows: still(r.rows) }).toEqual({
      rows: still(listed.rows),
      errors: listed.errors,
      unread: [],
    });
    expect(r.errors.map((e) => e.host)).toEqual(['ro']);
    expect(h.reads).toEqual([]);
    expect(await sent(h, ['local', 'box'])).toEqual([1, 1]);
  });
  it("with reloads: the counted rows; a host whose logs were not read is in unread and, after the probes' own, in errors", async () => {
    const h = fakeHosts(state(), ['ro']);
    const r = await listWithReloads(h.fleet, all(h), true);
    expect(r.rows.find((x) => x.app === 'watch')!.reloads).toMatchObject({
      count: 1,
    });
    expect(r.rows.find((x) => x.app === 'web')).not.toHaveProperty('reloads');
    expect(r.unread).toEqual([
      {
        host: 'box',
        apps: ['web'],
        message: expect.stringMatching(/^reloads not counted/),
      },
    ]);
    expect(r.errors.map((e) => e.host)).toEqual(['ro', 'box']);
    expect(r.errors[1]).toBe(r.unread[0]);
  });
});

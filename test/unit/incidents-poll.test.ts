import { describe, it, expect } from 'vitest';
import { pollIncidents } from '../../src/core/incidents/poll.js';
import { mergeCursor } from '../../src/core/incidents/cursor.js';
import { fakeHosts, fleetManifest, proc, S } from '../helpers/incidents.js';

describe('pollIncidents', () => {
  it("first call: errors of the last minutes of each log, from each app's own host; second call: nothing new", async () => {
    const state = {
      files: {
        '/l/watch-out': `${S(1)}compiling\n${S(2)}TypeError: x is undefined\n${S(3)}    at a (/w.js:1:1)\n${S(4)}done\n`,
        '/l/web-out': `${S(5)}ready\n`,
      },
      procs: { local: [proc('watch', 0)], box: [proc('web', 3)] },
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['watch', 'web']);
    expect(
      first.answer.incidents.map(
        (i) => `${i.app}@${i.host}:${i.kind}:${i.line}`
      )
    ).toEqual([`watch@local:error:${S(2)}TypeError: x is undefined`]);
    expect(first.answer.incidents[0].after[0]).toBe(
      `${S(3)}    at a (/w.js:1:1)`
    );
    expect(first.answer).toMatchObject({
      apps: 2,
      hosts: 2,
      more: 0,
      errors: [],
      skipped: [],
    });
    const second = await pollIncidents(h.fleet, ['watch', 'web'], {
      cursor: first.next,
    });
    expect(second.answer.incidents).toEqual([]);
    state.files['/l/web-out'] += `${S(9)}level=error msg=db down\n`;
    const third = await pollIncidents(h.fleet, ['watch', 'web'], {
      cursor: mergeCursor(first.next, second.next),
    });
    expect(third.answer.incidents.map((i) => i.app)).toEqual(['web']);
  });
  it('the first call keeps only errors inside the window, measured from the newest stamp of that file', async () => {
    const state = {
      files: {
        '/l/watch-out': `2026-10-12T03:00:00: ERROR: old\n2026-10-12T03:20:00: ERROR: new\n`,
      },
      procs: { local: [proc('watch', 0)] },
    };
    const r = await pollIncidents(fakeHosts(state).fleet, ['watch'], {
      sinceMin: 15,
    });
    expect(r.answer.incidents.map((i) => i.line)).toEqual([
      '2026-10-12T03:20:00: ERROR: new',
    ]);
    expect(r.answer.incidents[0].before).toEqual([
      '2026-10-12T03:00:00: ERROR: old',
    ]); // older lines stay as context only
  });
  it("the first call measures its window from the host's clock: a quiet app's error from yesterday is not new, nor a stale stderr beside a current stdout", async () => {
    const state = {
      now: '2026-10-12T12:00:00',
      files: {
        '/l/watch-out': '2026-10-12T11:59:00: ok\n',
        '/l/watch-err': '2026-10-11T23:00:00: TypeError: yesterday\n',
        '/l/web-out': '2026-10-11T23:02:00: ERROR: quiet since yesterday\n',
      },
      procs: { local: [proc('watch', 0)], box: [proc('web', 3)] },
    };
    const r = await pollIncidents(fakeHosts(state).fleet, ['watch', 'web']);
    expect(r.answer.incidents).toEqual([]);
    state.now = '2026-10-11T23:10:00'; // the same files seen yesterday evening: both errors are recent
    expect(
      (
        await pollIncidents(fakeHosts(state).fleet, ['watch', 'web'])
      ).answer.incidents
        .map((i) => i.app)
        .sort()
    ).toEqual(['watch', 'web']);
  });
  it('an app logging without pm2 stamps (time: false) still has its errors found on the first call', async () => {
    const state = {
      now: '2026-10-12T12:00:00',
      files: {
        '/l/watch-out':
          'starting\nTypeError: x is undefined\n    at a (/w.js:1:1)\n',
      },
      procs: { local: [proc('watch', 0)] },
    };
    expect(
      (
        await pollIncidents(fakeHosts(state).fleet, ['watch'])
      ).answer.incidents.map((i) => i.line)
    ).toEqual(['TypeError: x is undefined']);
  });
  it('an app whose own patterns run away is reported and keeps its point; the other apps still answer', async () => {
    const m = structuredClone(fleetManifest);
    m.apps.watch.errors = {
      match: ['^(a|a)*$'],
      ignore: [],
      context: [3, 5],
      stderr: false,
      defaults: true,
    };
    const state = {
      files: {
        '/l/watch-out': `${S(1)}${'a'.repeat(30)}!\n`,
        '/l/web-out': `${S(2)}TypeError: web\n`,
      },
      procs: { local: [proc('watch', 0)], box: [proc('web', 3)] },
    };
    const r = await pollIncidents(
      fakeHosts(state, [], m).fleet,
      ['watch', 'web'],
      { budgetMs: 200 }
    );
    expect(r.answer.incidents.map((i) => i.app)).toEqual(['web']);
    expect(r.answer.errors).toMatchObject([
      {
        host: 'local',
        apps: ['watch'],
        message: expect.stringContaining('TIMEOUT'),
      },
    ]);
    expect(r.next.apps['local/watch']).toBeUndefined(); // not analysed: the next poll reads the same lines again
    expect(r.next.apps['box/web']).toBeDefined();
  });
  it('a short read (the file rotated between measuring and reading) is neither analysed nor taken: the next poll reads it again', async () => {
    const state: {
      files: Record<string, string>;
      procs: Record<string, object[]>;
      short?: string[];
    } = {
      files: { '/l/watch-out': `${S(1)}ok\n${S(2)}TypeError: late\n` },
      procs: { local: [proc('watch', 0)] },
      short: ['/l/watch-out'],
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['watch']);
    expect(first.answer.incidents).toEqual([]);
    expect(first.next.apps['local/watch'].out).toBeUndefined();
    state.short = [];
    const second = await pollIncidents(h.fleet, ['watch'], {
      cursor: first.next,
    });
    expect(second.answer.incidents.map((i) => i.line)).toEqual([
      `${S(2)}TypeError: late`,
    ]);
  });
  it('a log rotated or flushed outside mcproc that grew back past the old position is read from its start', async () => {
    const state = {
      files: { '/l/watch-out': `${S(1)}${'x'.repeat(200)}\n` },
      procs: { local: [proc('watch', 0)] },
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['watch']);
    state.files['/l/watch-out'] =
      `${S(5)}TypeError: right after the rotation\n${`${S(6)}${'y'.repeat(100)}\n`.repeat(3)}`;
    const second = await pollIncidents(h.fleet, ['watch'], {
      cursor: first.next,
    });
    expect(second.answer.incidents.map((i) => i.line)).toEqual([
      `${S(5)}TypeError: right after the rotation`,
    ]);
  });
  it('process events: errored is reported once; a restart since the last poll is reported with the count; none on a first call', async () => {
    const state = {
      files: { '/l/watch-err': `${S(1)}Error: listen EADDRINUSE :::3000\n` },
      procs: { local: [proc('watch', 0, { restart_time: 4 })] } as Record<
        string,
        object[]
      >,
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['watch']);
    expect(first.answer.incidents.map((i) => i.kind)).toEqual(['error']); // the log line; restarts only recorded
    state.procs.local = [proc('watch', 0, { restart_time: 7 })];
    const second = await pollIncidents(h.fleet, ['watch'], {
      cursor: first.next,
    });
    expect(second.answer.incidents).toMatchObject([
      { kind: 'restarted', count: 3, app: 'watch' },
    ]);
    expect(second.answer.incidents[0].before).toContain(
      `${S(1)}Error: listen EADDRINUSE :::3000`
    );
    state.procs.local = [
      proc('watch', 0, { restart_time: 7, status: 'errored' }),
    ];
    const third = await pollIncidents(h.fleet, ['watch'], {
      cursor: second.next,
    });
    expect(third.answer.incidents.map((i) => i.kind)).toEqual(['crashed']);
    const fourth = await pollIncidents(h.fleet, ['watch'], {
      cursor: third.next,
    });
    expect(fourth.answer.incidents).toEqual([]);
  });
  it('max keeps the newest incidents and counts the rest; repeats collapse', async () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `${S(i)}ERROR: case ${String.fromCharCode(97 + (i % 26))}${i}`
    ).join('\n');
    const state = {
      files: { '/l/watch-out': `${lines}\n` },
      procs: { local: [proc('watch', 0)] },
    };
    const r = await pollIncidents(fakeHosts(state).fleet, ['watch'], {
      max: 5,
      context: [0, 0],
    });
    expect(r.answer.incidents).toHaveLength(5);
    expect(r.answer.more).toBeGreaterThan(0);
    expect(r.answer.incidents[0].time).toBe('2026-10-12T11:00:29');
  });
  it('apps not started or with errors: false are skipped; an unreachable host is reported while the others answer; all down throws', async () => {
    const state = { files: {}, procs: { local: [] } };
    const r = await pollIncidents(fakeHosts(state, ['box']).fleet, [
      'watch',
      'web',
    ]);
    expect(r.answer.incidents).toEqual([]);
    expect(r.answer.errors).toMatchObject([{ host: 'box', apps: ['web'] }]);
    await expect(
      pollIncidents(fakeHosts(state, ['box']).fleet, ['web'])
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });
  it('one round trip for the logs of all apps of a host', async () => {
    const state = {
      files: {},
      procs: { local: [proc('watch', 0), proc('tool', 1)] },
    };
    const h = fakeHosts(state);
    await pollIncidents(h.fleet, ['watch', 'tool']);
    expect(h.reads).toEqual(['local']);
  });
});

describe('pollIncidents with includeReloads', () => {
  // the hosts run at +0200: pm2's start (epoch ms) becomes their wall time, the time of the stamps in the logs
  const startedAt = (wall: string) => Date.parse(`${wall}Z`) - 2 * 3600_000;
  const vite = () => ({
    now: '2026-10-12T11:01:00',
    zone: '+0200',
    files: {
      '/l/web-out': `${S(1)}[vite] page reload src/a.ts\n${S(1)}[vite] page reload src/b.ts\n${S(6)}[vite] hmr update /src/c.ts\n${S(8)}TypeError: boom\n`,
    },
    procs: {
      box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T10:59:30') })],
    } as Record<string, object[]>,
  });
  const web = (i: { kind: string; app: string }) =>
    i.kind === 'reloaded' && i.app === 'web';

  it("adds one reloaded incident per app beside its errors: the reloads of this poll counted, the first and the last one's time, the last one's line", async () => {
    const h = fakeHosts(vite());
    const r = await pollIncidents(h.fleet, ['web'], { includeReloads: true });
    expect(r.answer.incidents).toEqual([
      expect.objectContaining({
        kind: 'error',
        app: 'web',
        line: `${S(8)}TypeError: boom`,
      }),
      {
        app: 'web',
        host: 'box',
        kind: 'reloaded',
        stream: 'out',
        time: '2026-10-12T11:00:06',
        first_time: '2026-10-12T11:00:01',
        count: 2,
        line: `${S(6)}[vite] hmr update /src/c.ts`,
        before: [],
        after: [],
        fingerprint: 'reloaded',
      },
    ]);
    expect(h.scripts[0]).toContain('__MCPROC_LS_CLOCK__');
    expect(r.next.apps['box/web'].start).toBe('2026-10-12T10:59:30.000'); // the start in the host's wall time
  });
  it('without the flag the same lines give only the error, the read script asks for no clock and the point records no start', async () => {
    const h = fakeHosts(vite());
    const r = await pollIncidents(h.fleet, ['web']);
    expect(r.answer.incidents.map((i) => `${i.kind}:${i.line}`)).toEqual([
      `error:${S(8)}TypeError: boom`,
    ]);
    expect(h.scripts).toHaveLength(1);
    expect(h.scripts[0]).not.toContain('__MCPROC_LS_CLOCK__');
    expect(r.next.apps['box/web']).not.toHaveProperty('start');
    expect(r.next.apps['box/web']).not.toHaveProperty('boot');
  });
  it("the first burst after the start, listening lines only, is the boot; a later poll of the same run counts its first re-listen; lines of an earlier run don't count", async () => {
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `2026-10-12T10:59:50: listening on :3000\n${S(2)}listening on :3000\n${S(9)}listening on :3000\n`,
      },
      procs: {
        box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T11:00:00') })],
      } as Record<string, object[]>,
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
    });
    expect(first.answer.incidents).toMatchObject([
      {
        kind: 'reloaded',
        count: 1,
        time: '2026-10-12T11:00:09',
        first_time: '2026-10-12T11:00:09',
        line: `${S(9)}listening on :3000`,
      },
    ]);
    state.files['/l/web-out'] += `${S(30)}listening on :3000\n`;
    const second = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: first.next,
    });
    expect(second.answer.incidents).toMatchObject([
      { kind: 'reloaded', count: 1, time: '2026-10-12T11:00:30' },
    ]); // not taken for a boot: this run's boot was seen by the first poll
  });
  it("after a pm2 restart between polls the new run's boot is not a reload", async () => {
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `${S(2)}listening on :3000\n${S(9)}listening on :3000\n`,
      },
      procs: {
        box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T11:00:00') })],
      } as Record<string, object[]>,
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
    });
    expect(first.answer.incidents.filter(web)).toHaveLength(1);
    state.procs.box = [
      proc('web', 3, {
        pm_uptime: startedAt('2026-10-12T11:00:40'),
        restart_time: 1,
      }),
    ];
    state.files['/l/web-out'] += `${S(41)}listening on :3000\n`;
    const second = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: first.next,
    });
    expect(second.answer.incidents.map((i) => i.kind)).toEqual(['restarted']);
    expect(second.next.apps['box/web'].start).toBe('2026-10-12T11:00:40.000');
  });
  it("a poll between a restart and the new run's first line leaves its boot pending: the next poll drops the boot, a later re-listen counts", async () => {
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `${S(2)}listening on :3000\n${S(9)}listening on :3000\n`,
      },
      procs: {
        box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T11:00:00') })],
      } as Record<string, object[]>,
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
    });
    expect(first.next.apps['box/web']).toMatchObject({ boot: false });
    state.procs.box = [
      proc('web', 3, {
        pm_uptime: startedAt('2026-10-12T11:00:40'),
        restart_time: 1,
      }),
    ];
    const second = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: first.next,
    }); // the new run has printed nothing yet
    expect(second.answer.incidents.map((i) => i.kind)).toEqual(['restarted']);
    expect(second.next.apps['box/web']).toMatchObject({
      start: '2026-10-12T11:00:40.000',
      boot: true,
    });
    state.files['/l/web-out'] += `${S(42)}listening on :3000\n`;
    const third = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: second.next,
    });
    expect(third.answer.incidents).toEqual([]);
    expect(third.next.apps['box/web'].boot).toBe(false);
    state.files['/l/web-out'] += `${S(50)}listening on :3000\n`;
    const fourth = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: third.next,
    });
    expect(fourth.answer.incidents).toMatchObject([
      { kind: 'reloaded', count: 1, time: '2026-10-12T11:00:50' },
    ]);
  });
  it('a first poll of an app that started before the window: its boot is behind the point, so the first re-listen in the window counts', async () => {
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `2026-10-12T10:00:02: listening on :3000\n2026-10-12T10:30:00: GET / 200\n${S(5)}listening on :3000\n`,
      },
      procs: {
        box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T10:00:00') })],
      } as Record<string, object[]>,
    };
    const r = await pollIncidents(fakeHosts(state).fleet, ['web'], {
      includeReloads: true,
    });
    expect(r.answer.incidents).toMatchObject([
      {
        kind: 'reloaded',
        count: 1,
        line: `${S(5)}listening on :3000`,
      },
    ]);
  });
  it("after polls without the flag, the first one with it reads the boot's place from the lines before the new part", async () => {
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `${S(2)}listening on :3000\n${S(4)}GET / 200\n`,
      },
      procs: {
        box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T11:00:00') })],
      } as Record<string, object[]>,
    };
    const h = fakeHosts(state);
    const off = await pollIncidents(h.fleet, ['web']);
    expect(off.next.apps['box/web']).not.toHaveProperty('start');
    state.files['/l/web-out'] += `${S(20)}listening on :3000\n`;
    const on = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: off.next,
    });
    expect(on.answer.incidents).toMatchObject([
      { kind: 'reloaded', count: 1, time: '2026-10-12T11:00:20' },
    ]);
  });
  it('the boot stays pending across a poll that saw no burst of the run', async () => {
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: { '/l/web-out': `${S(1)}compiling\n` },
      procs: {
        box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T11:00:00') })],
      } as Record<string, object[]>,
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
    });
    expect(first.next.apps['box/web'].boot).toBe(true);
    state.files['/l/web-out'] += `${S(3)}listening on :3000\n`;
    const second = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: first.next,
    });
    expect(second.answer.incidents).toEqual([]); // the boot, though a line of the run came before it
    state.files['/l/web-out'] += `${S(10)}listening on :3000\n`;
    const third = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: second.next,
    });
    expect(third.answer.incidents).toMatchObject([
      { kind: 'reloaded', count: 1 },
    ]);
  });
  it('an app with errors: false takes part only for its reloads: no errors, no crashes or restarts; without the flag it is not read at all', async () => {
    const m = structuredClone(fleetManifest);
    m.apps.watch.errors = null;
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/watch-out': `${S(1)}TypeError: not an incident here\n${S(3)}File change detected. Starting incremental compilation...\n`,
      },
      procs: {
        local: [
          proc('watch', 0, { pm_uptime: startedAt('2026-10-12T10:00:00') }),
        ],
      } as Record<string, object[]>,
    };
    const off = fakeHosts(state, [], m);
    expect(
      (await pollIncidents(off.fleet, ['watch'])).answer.incidents
    ).toEqual([]);
    expect(off.reads).toEqual([]);
    const h = fakeHosts(state, [], m);
    const first = await pollIncidents(h.fleet, ['watch'], {
      includeReloads: true,
    });
    expect(first.answer.incidents).toMatchObject([
      {
        app: 'watch',
        kind: 'reloaded',
        count: 1,
        line: `${S(3)}File change detected. Starting incremental compilation...`,
      },
    ]);
    state.procs.local = [
      proc('watch', 0, {
        pm_uptime: startedAt('2026-10-12T10:00:00'),
        restart_time: 2,
        status: 'errored',
      }),
    ];
    const second = await pollIncidents(h.fleet, ['watch'], {
      includeReloads: true,
      cursor: first.next,
    });
    expect(second.answer.incidents).toEqual([]);
  });
  it('an app with reloads: false gets no reloaded incident even with the flag', async () => {
    const m = structuredClone(fleetManifest);
    m.apps.web.reloads = null;
    const r = await pollIncidents(fakeHosts(vite(), [], m).fleet, ['web'], {
      includeReloads: true,
    });
    expect(r.answer.incidents.map((i) => i.kind)).toEqual(['error']);
    expect(r.next.apps['box/web']).not.toHaveProperty('start');
    expect(r.next.apps['box/web']).not.toHaveProperty('boot');
  });
  it('an app whose reloads patterns run away is reported and keeps its point, its errors held back with it; the other apps still answer', async () => {
    const m = structuredClone(fleetManifest);
    m.apps.web.reloads = {
      match: ['^(a|a)*$'],
      ignore: [],
      defaults: true,
    };
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `${S(1)}${'a'.repeat(30)}!\n${S(2)}TypeError: web\n`,
        '/l/watch-out': `${S(3)}TypeError: watch\n`,
      },
      procs: { local: [proc('watch', 0)], box: [proc('web', 3)] },
    };
    const r = await pollIncidents(
      fakeHosts(state, [], m).fleet,
      ['watch', 'web'],
      { includeReloads: true, budgetMs: 200 }
    );
    expect(r.answer.incidents.map((i) => i.app)).toEqual(['watch']);
    expect(r.answer.errors).toMatchObject([
      {
        host: 'box',
        apps: ['web'],
        message: expect.stringMatching(
          /TIMEOUT.*the reloads patterns of web ran over 200 ms/
        ),
      },
    ]);
    expect(r.next.apps['box/web']).toBeUndefined(); // not analysed: the next poll reads the same lines again
    expect(r.next.apps['local/watch']).toBeDefined();
  });
  it('an app stalled by its errors patterns gets no reload pass: only that error, no point, no start or boot written', async () => {
    const m = structuredClone(fleetManifest);
    m.apps.web.errors = {
      match: ['^(a|a)*$'],
      ignore: [],
      context: [3, 5],
      stderr: false,
      defaults: true,
    };
    m.apps.web.reloads = { match: ['^(a|a)*$'], ignore: [], defaults: true }; // would name itself if it ran
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `${S(1)}${'a'.repeat(30)}!\n${S(2)}[vite] page reload src/a.ts\n`,
      },
      procs: { box: [proc('web', 3)] },
    };
    const r = await pollIncidents(fakeHosts(state, [], m).fleet, ['web'], {
      includeReloads: true,
      budgetMs: 200,
    });
    expect(r.answer.incidents).toEqual([]);
    expect(r.answer.errors).toMatchObject([
      {
        host: 'box',
        apps: ['web'],
        message: expect.stringContaining('the errors patterns of web'),
      },
    ]);
    expect(r.next.apps['box/web']).toBeUndefined();
  });
  it('a short read of one stream: the other still feeds the reloads, and the short one keeps its point', async () => {
    const state: {
      now: string;
      zone: string;
      files: Record<string, string>;
      procs: Record<string, object[]>;
      short?: string[];
    } = {
      now: '2026-10-12T11:01:00',
      zone: '+0200',
      files: {
        '/l/web-out': `${S(1)}ready\n`,
        '/l/web-err': `${S(1)}warming up\n`,
      },
      procs: {
        box: [proc('web', 3, { pm_uptime: startedAt('2026-10-12T11:00:00') })],
      },
    };
    const h = fakeHosts(state);
    const first = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
    });
    state.files['/l/web-out'] += `${S(20)}[vite] page reload src/a.ts\n`;
    state.files['/l/web-err'] += `${S(21)}${'w'.repeat(40)}\n`;
    state.short = ['/l/web-err'];
    const second = await pollIncidents(h.fleet, ['web'], {
      includeReloads: true,
      cursor: first.next,
    });
    expect(second.answer.incidents).toMatchObject([
      {
        kind: 'reloaded',
        count: 1,
        line: `${S(20)}[vite] page reload src/a.ts`,
      },
    ]);
    expect(second.next.apps['box/web'].err).toEqual(
      first.next.apps['box/web'].err
    );
    expect(second.next.apps['box/web'].out).not.toEqual(
      first.next.apps['box/web'].out
    );
  });
});

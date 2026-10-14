import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { parseJlist } from '../../src/core/pm2.js';
import { EMPTY_STATS } from '../../src/core/stats.js';
import type { Snapshot } from '../../src/core/list.js';
import {
  formatLine,
  colorFor,
  streamLogs,
  resolveColor,
  type StreamDeps,
} from '../../src/core/logstream.js';
import { McprocError } from '../../src/core/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fleetDir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
const procsOf = (apps: string[]) =>
  parseJlist(
    JSON.stringify(
      apps.map((a, i) => ({
        pid: 100 + i,
        name: `demo-${a}`,
        pm_id: i,
        pm2_env: {
          status: 'online',
          namespace: 'demo',
          pm_out_log_path: `/l/${a}-out`,
          pm_err_log_path: `/l/${a}-err`,
        },
      }))
    )
  );
const snap = (apps: string[]): Snapshot => ({
  procs: procsOf(apps),
  ports: {},
  listeners: [],
  tree: new Map(),
  stats: EMPTY_STATS,
  metrics: {},
  sampledAt: 0,
  urls: new Map(),
});

/** Fake followers: a queue of poll results per app; an exhausted queue yields no lines. */
function harness(
  running: string[],
  polls: Record<
    string,
    { lines: { stream: 'out' | 'err'; text: string }[]; reset?: boolean }[]
  >,
  later: string[][] = []
) {
  const ctx = fakeCtx(basic, 'local', []);
  const out: string[] = [];
  let snapshots = 0;
  let sleeps = 0;
  const deps: StreamDeps = {
    snapshot: async () => snap(later[snapshots++] ?? running),
    follower: (_ctx, paths) => {
      const app = /\/l\/(.*)-out$/.exec(paths.out)![1];
      return {
        poll: async () => {
          const r = polls[app]?.shift();
          return r
            ? { lines: r.lines, reset: r.reset ?? false }
            : { lines: [], reset: false };
        },
      };
    },
    sleep: async () => {
      sleeps++;
    },
    out: (s) => {
      out.push(s);
    },
  };
  return {
    ctx,
    deps,
    out,
    get sleeps() {
      return sleeps;
    },
  };
}
const base = {
  lines: 10,
  intervalMs: 1000,
  color: false,
  json: false,
  stream: 'both' as const,
  resolveEvery: 2,
};

describe('formatLine', () => {
  it('pads the label to the width, marks stderr with !, colors only the label when asked', () => {
    expect(
      formatLine({ app: 'api', stream: 'out', text: 'hello' }, 6, null)
    ).toBe('api    | hello');
    expect(
      formatLine({ app: 'worker', stream: 'err', text: 'boom' }, 6, null)
    ).toBe('worker ! boom');
    const c = formatLine({ app: 'api', stream: 'out', text: 'hello' }, 6, 36);
    expect(c).toBe('\x1b[36mapi   \x1b[0m | hello');
    expect(colorFor(0)).toBe(36);
    expect(colorFor(6)).toBe(colorFor(0)); // the palette wraps
    expect(new Set([0, 1, 2, 3, 4, 5].map(colorFor)).size).toBe(6);
  });
});

describe('colors of the apps themselves', () => {
  it("with colors on, the app's own colors pass through and every line ends with a reset; off, they are removed", () => {
    expect(
      formatLine(
        {
          app: 'api',
          stream: 'out',
          text: '\x1b[35mlevel=\x1b[0minfo \x1b[32mok',
        },
        3,
        36
      )
    ).toBe('\x1b[36mapi\x1b[0m | \x1b[35mlevel=\x1b[0minfo \x1b[32mok\x1b[0m');
    expect(
      formatLine(
        {
          app: 'api',
          stream: 'out',
          text: '\x1b[35mlevel=\x1b[0minfo \x1b[32mok',
        },
        3,
        null
      )
    ).toBe('api | level=info ok');
    expect(
      formatLine({ app: 'api', stream: 'out', text: 'plain' }, 3, 36)
    ).toBe('\x1b[36mapi\x1b[0m | plain'); // no reset when the app wrote no colors
  });
  it('json lines carry the text without color codes', async () => {
    const h = harness(['api'], {
      api: [{ lines: [{ stream: 'out', text: '\x1b[32mok\x1b[0m' }] }],
    });
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api'] }],
      { ...base, follow: false, json: true, color: true },
      h.deps
    );
    expect(JSON.parse(h.out[0])).toEqual({
      app: 'api',
      stream: 'out',
      text: 'ok',
    });
  });
  it('resolveColor: --no-color and NO_COLOR win, then --color and FORCE_COLOR, else only a terminal gets colors', () => {
    expect(resolveColor(false, { FORCE_COLOR: '1' }, true)).toBe(false);
    expect(
      resolveColor(undefined, { NO_COLOR: '1', FORCE_COLOR: '1' }, true)
    ).toBe(false);
    expect(resolveColor(true, {}, false)).toBe(true);
    expect(resolveColor(undefined, { FORCE_COLOR: '1' }, false)).toBe(true);
    expect(resolveColor(undefined, { FORCE_COLOR: '0' }, true)).toBe(false);
    expect(resolveColor(undefined, {}, true)).toBe(true);
    expect(resolveColor(undefined, {}, false)).toBe(false);
  });
});

describe('streamLogs', () => {
  it('one shot: history of every app in app order, stderr marked, not-started apps say so', async () => {
    const h = harness(['api'], {
      api: [
        {
          lines: [
            { stream: 'out', text: 'h1' },
            { stream: 'err', text: 'e1' },
          ],
        },
      ],
    });
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api', 'worker'] }],
      { ...base, follow: false },
      h.deps
    );
    expect(h.out).toEqual([
      'api    | h1',
      'api    ! e1',
      'worker | (not started)',
    ]);
    expect(h.sleeps).toBe(0);
  });
  it("startAt seeks an app's follower to its marks before its first poll; an app without an entry is not seeked", async () => {
    const h = harness(['api', 'worker'], {
      api: [{ lines: [{ stream: 'out', text: 'after the mark' }] }],
    });
    const calls: string[] = [];
    const created: { app: string; lines: number }[] = [];
    const deps: StreamDeps = {
      ...h.deps,
      follower: (ctx, paths, lines) => {
        const app = /\/l\/(.*)-out$/.exec(paths.out)![1];
        created.push({ app, lines });
        const f = h.deps.follower(ctx, paths, lines);
        return {
          poll: () => {
            calls.push(`${app} poll`);
            return f.poll();
          },
          seek: (marks) => {
            calls.push(`${app} seek ${JSON.stringify(marks)}`);
          },
        };
      },
    };
    const mark = { out: { path: '/l/api-out', offset: 5 } };
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api', 'worker'] }],
      { ...base, lines: 0, follow: false, startAt: { api: mark } },
      deps
    );
    expect(created).toEqual([
      { app: 'api', lines: 0 },
      { app: 'worker', lines: 0 },
    ]);
    expect(calls).toEqual([
      `api seek ${JSON.stringify(mark)}`,
      'api poll',
      'worker poll',
    ]);
    expect(h.out).toEqual(['api    | after the mark']);
  });
  it('an app attached later, on a re-probe, gets its startAt (a cutoff here) before its first poll', async () => {
    const ac = new AbortController();
    const h = harness(
      ['api'],
      {
        api: [{ lines: [{ stream: 'out', text: 'a0' }] }],
        worker: [{ lines: [{ stream: 'out', text: 'w-boot' }] }],
      },
      [['api'], ['api', 'worker']]
    ); // the second snapshot (tick 2, resolveEvery 2) sees the worker up
    const calls: string[] = [];
    const deps: StreamDeps = {
      ...h.deps,
      follower: (ctx, paths, lines) => {
        const app = /\/l\/(.*)-out$/.exec(paths.out)![1];
        const f = h.deps.follower(ctx, paths, lines);
        return {
          poll: () => {
            calls.push(`${app} poll`);
            return f.poll();
          },
          seek: (at) => {
            calls.push(`${app} seek ${JSON.stringify(at)}`);
          },
        };
      },
      sleep: async () => {
        if (h.out.includes('worker | w-boot')) ac.abort();
      },
    };
    const cutoff = '2026-10-14T10:00:05.000';
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api', 'worker'] }],
      {
        ...base,
        lines: 0,
        follow: true,
        signal: ac.signal,
        startAt: { api: { cutoff }, worker: { cutoff } },
      },
      deps
    );
    const seek = `worker seek ${JSON.stringify({ cutoff })}`;
    expect(calls).toContain(seek);
    expect(calls.indexOf(seek)).toBeLessThan(calls.indexOf('worker poll'));
    expect(h.out).toContain('worker | w-boot');
  });
  it('follow: polls every interval in app order, attaches apps that start later, stops on abort', async () => {
    const ac = new AbortController();
    const h = harness(
      ['api'],
      {
        api: [
          { lines: [{ stream: 'out', text: 'a0' }] },
          { lines: [] },
          { lines: [{ stream: 'out', text: 'a2' }] },
          { lines: [{ stream: 'out', text: 'a3' }] },
        ],
        worker: [
          { lines: [{ stream: 'out', text: 'w-hist' }] },
          { lines: [{ stream: 'out', text: 'w3' }] },
        ],
      },
      [['api'], ['api', 'worker']]
    ); // the second snapshot (tick 2, resolveEvery 2) sees the worker up
    const deps: StreamDeps = {
      ...h.deps,
      sleep: async () => {
        h.deps.sleep(0);
        if (h.out.length >= 6) ac.abort();
      },
    };
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api', 'worker'] }],
      { ...base, follow: true, signal: ac.signal },
      deps
    );
    expect(h.out).toEqual([
      'api    | a0',
      'worker | (not started)',
      'api    | a2',
      'worker | w-hist',
      'api    | a3',
      'worker | w3',
    ]);
  });
  it('stdout and stderr of one app are merged by their pm2 timestamp, not printed as two blocks', async () => {
    const h = harness(['api'], {
      api: [
        {
          lines: [
            { stream: 'out', text: '2026-10-11T13:00:09: o' },
            { stream: 'out', text: '2026-10-11T13:00:11: o2' },
            { stream: 'err', text: '2026-10-11T13:00:10: e' },
          ],
        },
      ],
    });
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api'] }],
      { ...base, follow: false },
      h.deps
    );
    expect(h.out).toEqual([
      'api | 2026-10-11T13:00:09: o',
      'api ! 2026-10-11T13:00:10: e',
      'api | 2026-10-11T13:00:11: o2',
    ]);
  });
  it('a closed pipe (EPIPE on stdout) ends the stream quietly instead of crashing', async () => {
    const h = harness(['api'], {
      api: [
        {
          lines: [
            { stream: 'out', text: 'a' },
            { stream: 'out', text: 'b' },
          ],
        },
        { lines: [{ stream: 'out', text: 'c' }] },
      ],
    });
    const seen: string[] = [];
    const deps: StreamDeps = {
      ...h.deps,
      out: (s) => {
        if (seen.length === 1)
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        seen.push(s);
      },
    };
    await expect(
      streamLogs(
        [{ host: 'local', ctx: h.ctx, apps: ['api'] }],
        { ...base, follow: true },
        deps
      )
    ).resolves.toBeUndefined();
    expect(seen).toEqual(['api | a']);
    expect(h.sleeps).toBe(0); // the follow loop never started: the reader is gone
  });
  it('json lines and the stream filter', async () => {
    let h = harness(['api'], {
      api: [
        {
          lines: [
            { stream: 'out', text: 'h1' },
            { stream: 'err', text: 'e1' },
          ],
        },
      ],
    });
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api'] }],
      { ...base, follow: false, json: true },
      h.deps
    );
    expect(h.out.map((l) => JSON.parse(l))).toEqual([
      { app: 'api', stream: 'out', text: 'h1' },
      { app: 'api', stream: 'err', text: 'e1' },
    ]);
    h = harness(['api'], {
      api: [
        {
          lines: [
            { stream: 'out', text: 'h1' },
            { stream: 'err', text: 'e1' },
          ],
        },
      ],
    });
    await streamLogs(
      [{ host: 'local', ctx: h.ctx, apps: ['api'] }],
      { ...base, follow: false, stream: 'err' },
      h.deps
    );
    expect(h.out).toEqual(['api ! e1']);
  });
  it('several hosts: one source per host, labels padded across all of them, apps in source order', async () => {
    const local = fakeCtx(fleetDir, 'local', [], 'local');
    const box = fakeCtx(fleetDir, 'box', [], 'local');
    const procs = (host: string, apps: string[]) =>
      parseJlist(
        JSON.stringify(
          apps.map((a, i) => ({
            pid: 100 + i,
            name: `fleet-${a}`,
            pm_id: i,
            pm2_env: {
              status: 'online',
              namespace: 'fleet',
              pm_out_log_path: `/${host}/${a}-out`,
              pm_err_log_path: `/${host}/${a}-err`,
            },
          }))
        )
      );
    const out: string[] = [];
    const deps: StreamDeps = {
      snapshot: async (ctx) => ({
        ...snap([]),
        procs:
          ctx.host.name === 'box'
            ? procs('box', ['web'])
            : procs('local', ['watch']),
      }),
      follower: (ctx, paths) => ({
        poll: async () => ({
          lines: [
            { stream: 'out', text: `${ctx.host.name} says ${paths.out}` },
          ],
          reset: false,
        }),
      }),
      sleep: async () => undefined,
      out: (l) => {
        out.push(l);
      },
    };
    await streamLogs(
      [
        { host: 'local', ctx: local, apps: ['watch', 'tool'] },
        { host: 'box', ctx: box, apps: ['web'] },
      ],
      { ...base, follow: false },
      deps
    );
    expect(out).toEqual([
      'watch | local says /local/watch-out',
      'tool  | (not started)',
      'web   | box says /box/web-out',
    ]);
  });
  it('a host that cannot be reached prints one note per app and the others keep streaming; when no host answers, the error is thrown', async () => {
    const h = harness(['api'], {
      api: [{ lines: [{ stream: 'out', text: 'h1' }] }],
    });
    const down = new McprocError(
      'TRANSPORT_FAILED',
      'ssh box: Connection refused'
    );
    await streamLogs(
      [
        { host: 'local', ctx: h.ctx, apps: ['api'] },
        { host: 'box', error: down, apps: ['web'] },
      ],
      { ...base, follow: false },
      h.deps
    );
    expect(h.out).toEqual([
      'api | h1',
      'web | (host box unreachable: TRANSPORT_FAILED: ssh box: Connection refused)',
    ]);
    const h2 = harness(['api'], {});
    const failing: StreamDeps = {
      ...h2.deps,
      snapshot: async () => {
        throw down;
      },
    };
    await expect(
      streamLogs(
        [
          { host: 'local', ctx: h2.ctx, apps: ['api'] },
          { host: 'box', error: down, apps: ['web'] },
        ],
        { ...base, follow: false },
        failing
      )
    ).rejects.toBe(down);
  });
  it('follow: a host that fails mid-stream prints one note per app, the other hosts keep streaming, and it resumes where it was', async () => {
    const local = fakeCtx(fleetDir, 'local', [], 'local');
    const box = fakeCtx(fleetDir, 'box', [], 'local');
    const procs = (host: string, apps: string[]) =>
      parseJlist(
        JSON.stringify(
          apps.map((a, i) => ({
            pid: 100 + i,
            name: `fleet-${a}`,
            pm_id: i,
            pm2_env: {
              status: 'online',
              namespace: 'fleet',
              pm_out_log_path: `/${host}/${a}-out`,
              pm_err_log_path: `/${host}/${a}-err`,
            },
          }))
        )
      );
    const ac = new AbortController();
    const out: string[] = [];
    let boxPolls = 0;
    let localPolls = 0;
    const deps: StreamDeps = {
      snapshot: async (ctx) => ({
        ...snap([]),
        procs:
          ctx.host.name === 'box'
            ? procs('box', ['web'])
            : procs('local', ['watch']),
      }),
      follower: (ctx) => ({
        poll: async () => {
          if (ctx.host.name === 'local')
            return {
              lines: [{ stream: 'out', text: `l${localPolls++}` }],
              reset: false,
            };
          const n = boxPolls++;
          if (n === 1 || n === 2)
            throw new McprocError(
              'TRANSPORT_FAILED',
              'ssh box: Connection refused'
            );
          return { lines: [{ stream: 'out', text: `b${n}` }], reset: false };
        },
      }),
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 1));
        if (localPolls >= 6 && boxPolls >= 5) ac.abort();
      },
      out: (l) => {
        out.push(l);
      },
    };
    await streamLogs(
      [
        { host: 'local', ctx: local, apps: ['watch'] },
        { host: 'box', ctx: box, apps: ['web'] },
      ],
      { ...base, follow: true, signal: ac.signal },
      deps
    );
    const web = out.filter((l) => l.startsWith('web'));
    expect(web).toEqual([
      'web   | b0',
      'web   | (host box unreachable: TRANSPORT_FAILED: ssh box: Connection refused)',
      'web   | b3',
      'web   | b4',
    ]);
    expect(
      out.filter((l) => l.startsWith('watch')).length
    ).toBeGreaterThanOrEqual(6); // the local app never paused
  });
  it('follow: a host that could not be reached at the start is connected again on the re-probe ticks', async () => {
    const local = fakeCtx(fleetDir, 'local', [], 'local');
    const box = fakeCtx(fleetDir, 'box', [], 'local');
    const procs = (apps: string[]) =>
      parseJlist(
        JSON.stringify(
          apps.map((a, i) => ({
            pid: 100 + i,
            name: `fleet-${a}`,
            pm_id: i,
            pm2_env: {
              status: 'online',
              namespace: 'fleet',
              pm_out_log_path: `/l/${a}-out`,
              pm_err_log_path: `/l/${a}-err`,
            },
          }))
        )
      );
    const ac = new AbortController();
    const out: string[] = [];
    let attempts = 0;
    const down = new McprocError(
      'TRANSPORT_FAILED',
      'ssh box: Connection refused'
    );
    const deps: StreamDeps = {
      snapshot: async (ctx) => ({
        ...snap([]),
        procs: ctx.host.name === 'box' ? procs(['web']) : procs(['watch']),
      }),
      follower: (ctx, paths) => ({
        poll: async () => ({
          lines: [{ stream: 'out', text: `${ctx.host.name} ${paths.out}` }],
          reset: false,
        }),
      }),
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 1));
        if (out.some((l) => l.startsWith('web   | box'))) ac.abort();
      },
      out: (l) => {
        out.push(l);
      },
    };
    const connect = async () => {
      if (++attempts < 2) throw down;
      return box;
    };
    await streamLogs(
      [
        { host: 'local', ctx: local, apps: ['watch'] },
        { host: 'box', error: down, connect, apps: ['web'] },
      ],
      { ...base, follow: true, signal: ac.signal, resolveEvery: 1 },
      deps
    );
    expect(out.filter((l) => l.startsWith('web'))).toEqual([
      'web   | (host box unreachable: TRANSPORT_FAILED: ssh box: Connection refused)',
      'web   | box /l/web-out',
    ]);
    expect(attempts).toBe(2); // one failed retry printed nothing new: the outage was already announced
  });
});

describe('streamLogs follows on wakes', () => {
  /** followers whose wakes the test fires; `next` holds an app's next lines */
  function live(running: string[]) {
    const h = harness(running, {});
    const wakes = new Map<string, () => void>();
    const next = new Map<string, string[]>();
    const closed: string[] = [];
    let snapshots = 0;
    const deps: StreamDeps = {
      ...h.deps,
      snapshot: async () => {
        snapshots++;
        return h.deps.snapshot(h.ctx);
      },
      follower: (_ctx, paths) => {
        const app = /\/l\/(.*)-out$/.exec(paths.out)![1];
        return {
          poll: async () => ({
            lines: (next.get(app)?.splice(0) ?? []).map((text) => ({
              stream: 'out' as const,
              text,
            })),
            reset: false,
          }),
          watch: (w) => void wakes.set(app, w),
          close: () => void closed.push(app),
        };
      },
      sleep: () => new Promise<void>(() => {}), // the interval never elapses: only wakes move the stream
    };
    const say = (app: string, text: string) => {
      next.set(app, [...(next.get(app) ?? []), text]);
      wakes.get(app)!();
    };
    return {
      ...h,
      deps,
      say,
      wakes,
      closed,
      get snapshots() {
        return snapshots;
      },
    };
  }
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it("prints a woken app's new lines without waiting for the interval, and stops at once when aborted", async () => {
    const t = live(['api']);
    const ac = new AbortController();
    const done = streamLogs(
      [{ host: 'local', apps: ['api'], ctx: t.ctx }],
      { ...base, follow: true, signal: ac.signal },
      t.deps
    );
    await waitFor(() => t.wakes.has('api'));
    t.say('api', 'fresh');
    await waitFor(() => t.out.some((l) => l.endsWith('fresh')));
    ac.abort();
    await done;
    expect(t.closed).toEqual(['api']);
  });
  it('a long run of wakes piles no handlers onto a pending clock', async () => {
    let thens = 0;
    class Counting<T> extends Promise<T> {
      // biome-ignore lint/suspicious/noThenProperty: counts the handlers attached to a pending clock
      then<A = T, B = never>(
        ok?: ((v: T) => A | PromiseLike<A>) | null,
        bad?: ((r: unknown) => B | PromiseLike<B>) | null
      ): Promise<A | B> {
        thens++;
        return super.then(ok, bad);
      }
    }
    const t = live(['api']);
    const ac = new AbortController();
    const done = streamLogs(
      [{ host: 'local', apps: ['api'], ctx: t.ctx }],
      { ...base, follow: true, signal: ac.signal },
      { ...t.deps, sleep: () => new Counting<void>(() => {}) }
    );
    await waitFor(() => t.wakes.has('api'));
    for (let i = 0; i < 30; i++) {
      t.say('api', `line ${i}`);
      await waitFor(() => t.out.some((l) => l.endsWith(`line ${i}`)));
    }
    expect(thens).toBeLessThan(5);
    ac.abort();
    await done;
  });
  it('wakes do not re-probe for apps that are not started more often than the interval says', async () => {
    const t = live(['api']); // worker not started
    const ac = new AbortController();
    const done = streamLogs(
      [{ host: 'local', apps: ['api', 'worker'], ctx: t.ctx }],
      { ...base, follow: true, signal: ac.signal, resolveEvery: 1 },
      t.deps
    );
    await waitFor(() => t.wakes.has('api'));
    for (let i = 0; i < 5; i++) {
      t.say('api', `line ${i}`);
      await waitFor(() => t.out.some((l) => l.endsWith(`line ${i}`)));
    }
    expect(t.snapshots).toBe(1); // the history probe only
    ac.abort();
    await done;
  });
});

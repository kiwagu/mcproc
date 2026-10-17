import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { MARK } from '../../src/shell/snippets.js';
import {
  parseUntil,
  waitFor,
  untilLabel,
  untilFor,
  waitDependency,
  depFailure,
  defaultWaitDeps,
  abortableSleep,
  WAIT_TIMEOUT_MAX_MS,
  type WaitDeps,
} from '../../src/core/wait.js';
import { snapshot, type Snapshot } from '../../src/core/list.js';
import { loadManifest } from '../../src/core/manifest.js';
import { parseJlist, type Pm2Process } from '../../src/core/pm2.js';
import type { AppPorts } from '../../src/core/ports.js';
import { EMPTY_STATS } from '../../src/core/stats.js';
import { LeaseStore } from '../../src/core/leases/store.js';
import type { HereCheck } from '../../src/core/urlcheck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readiness = path.join(here, '..', 'fixtures', 'projects', 'readiness');
const varsProj = path.join(here, '..', 'fixtures', 'projects', 'vars');
const PS = '1 0\n100 1\n101 100\n';
const ss = (port: number, pid: number) =>
  `LISTEN 0 511 *:${port} *:* users:(("node",pid=${pid},fd=20))\n`;
const proc = (
  name: string,
  status: string,
  extra: Record<string, unknown> = {}
) => ({
  pid: status === 'online' ? 100 : 0,
  name: `ready-${name}`,
  pm_id: 1,
  pm2_env: {
    status,
    namespace: 'ready',
    pm_out_log_path: '/l/o',
    pm_err_log_path: '/l/e',
    ...extra,
  },
});

/** A fake clock: sleep advances it; the probe answers from a queue (the last one repeats). */
function harness(probes: string[], jlists: string[] = probes) {
  let t = 1_000_000;
  let pi = 0;
  let ji = 0;
  const calls = { probes: 0, jlists: 0, slept: [] as number[] };
  const ctx = fakeCtx(readiness, 'local', [
    {
      match: MARK.JLIST,
      result: () => {
        calls.probes++;
        return { stdout: probes[Math.min(pi++, probes.length - 1)] };
      },
    },
    {
      match: /pm2 'jlist'/,
      result: () => {
        calls.jlists++;
        return { stdout: jlists[Math.min(ji++, jlists.length - 1)] };
      },
    },
  ]);
  const deps: WaitDeps = {
    jlist: (c) => c.pm2.jlist(),
    snapshot: (c, o) => snapshot(c, o),
    follower: () => {
      throw new Error('not used here');
    },
    sleep: async (ms) => {
      calls.slept.push(ms);
      t += ms;
    },
    now: () => t,
    leases: async () => [],
  };
  return { ctx, deps, calls };
}
/** A pm2 process online in a namespace, as Pm2Client.jlist gives it. */
const onlineProc = (name: string, namespace: string): Pm2Process =>
  parseJlist(
    JSON.stringify([
      {
        pid: 100,
        name,
        pm_id: 0,
        pm2_env: {
          status: 'online',
          namespace,
          pm_out_log_path: '/l/o',
          pm_err_log_path: '/l/e',
        },
      },
    ])
  )[0];
/** The ports of an app whose one declared port listens. */
const listening = (port: number): AppPorts => ({
  actual: [
    {
      proto: 'tcp',
      addr: '*',
      port,
      pid: 100,
      pids: [100],
      command: 'node',
      container: null,
    },
  ],
  declared: [port],
  checks: [{ port, status: 'listening' }],
  undeclared: [],
});
/** A light snapshot holding at most one process, with the given ports per app. */
const snapWith = (
  p?: Pm2Process,
  ports: Record<string, AppPorts> = {}
): Snapshot => ({
  procs: p ? [p] : [],
  ports,
  listeners: [],
  tree: new Map(),
  stats: EMPTY_STATS,
  metrics: {},
  sampledAt: 0,
  urlChecks: {},
  zone: null,
  memory: null,
  leases: [],
});
/** WaitDeps on a fake clock (sleep advances it): no process, no follower, no lease, unless `over` says otherwise. */
const fakeDeps = (over: Partial<WaitDeps> = {}): WaitDeps => {
  let t = 1_000_000;
  return {
    jlist: async () => [],
    snapshot: async () => snapWith(),
    follower: () => {
      throw new Error('not used here');
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    leases: async () => [],
    ...over,
  };
};
const probe = (p: ReturnType<typeof proc>, tcp = '') =>
  probeOut({ jlist: JSON.stringify([p]), ps: PS, tcp });
const jl = (p: ReturnType<typeof proc>) => JSON.stringify([p]);

describe('parseUntil', () => {
  it('accepts the six forms and labels them back', () => {
    expect(parseUntil('listening')).toEqual({ kind: 'listening' });
    expect(parseUntil('url-ok')).toEqual({ kind: 'url-ok' });
    expect(parseUntil('exited')).toEqual({ kind: 'exited' });
    expect(parseUntil('reloaded')).toEqual({ kind: 'reloaded' });
    expect(untilLabel(parseUntil('reloaded'))).toBe('reloaded');
    const l = parseUntil('log:listening on \\d+');
    expect(l.kind).toBe('log');
    if (l.kind === 'log') expect(l.re.test('listening on 3010')).toBe(true);
    expect(parseUntil('idle:5')).toEqual({ kind: 'idle', seconds: 5 });
    expect(untilLabel(parseUntil('idle:2.5'))).toBe('idle:2.5');
    expect(untilLabel(l)).toBe('log:listening on \\d+');
  });
  it('refuses anything else with BAD_ARGUMENT', () => {
    for (const bad of [
      '',
      'ready',
      'log:',
      'log:(',
      'idle:',
      'idle:0',
      'idle:x',
      'reload',
    ])
      expect(() => parseUntil(bad)).toThrowError(
        expect.objectContaining({ code: 'BAD_ARGUMENT' })
      );
  });
  it('the hint for an unknown until lists every form', () => {
    expect(() => parseUntil('ready')).toThrowError(
      expect.objectContaining({
        hint: expect.stringMatching(
          /listening.*url-ok.*exited.*log:<regex>.*idle:<seconds>.*reloaded/
        ),
      })
    );
  });
});

describe('parseUntil: log: patterns', () => {
  it('refuses a group that ends in a repeat, which can run for minutes on a line that almost matches', () => {
    for (const re of ['(a+)+', '(\\w+\\s*)*', '(.*)+$'])
      expect(() => parseUntil(`log:${re}`)).toThrowError(
        expect.objectContaining({
          code: 'BAD_ARGUMENT',
          hint: expect.stringContaining('without the nested repeat'),
        })
      );
  });
  it('lets a repeated group through when its content ends in a literal', () => {
    expect(parseUntil('log:(\\d+\\.)+ ready').kind).toBe('log');
  });
});

describe('waitFor: listening / url-ok / exited', () => {
  it('listening: polls the light probe every 500 ms locally until every declared port listens', async () => {
    const h = harness([
      probe(proc('api', 'online')),
      probe(proc('api', 'online')),
      probe(proc('api', 'online'), ss(3100, 101)),
    ]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({
      ok: true,
      until: 'listening',
      status: 'online',
      waited_ms: 1000,
    });
    expect(r.observed).toContain(':3100 ✓');
    expect(h.calls.slept).toEqual([500, 500]);
    expect(h.ctx.fake.calls[0].cmd).not.toContain('/proc/[0-9]*/stat');
  });
  it('listening: refuses an app without declared ports before any probe', async () => {
    const h = harness([probe(proc('logger', 'online'))]);
    await expect(
      waitFor(h.ctx, 'logger', { kind: 'listening' }, { deps: h.deps })
    ).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
    expect(h.calls.probes).toBe(0);
  });
  it('listening: a process that dies meanwhile ends the wait with exited and its exit code', async () => {
    const h = harness([
      probe(proc('api', 'online')),
      probe(proc('api', 'stopped', { exit_code: 1 })),
    ]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'exited',
      status: 'stopped',
      exit_code: 1,
    });
  });
  it('listening: errored is crashed', async () => {
    const h = harness([probe(proc('api', 'errored', { exit_code: 1 }))]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'crashed',
      status: 'errored',
    });
  });
  it('listening: times out with what was last seen', async () => {
    const h = harness([probe(proc('api', 'online'))]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps, timeoutMs: 1200 }
    );
    expect(r).toMatchObject({ ok: false, reason: 'timeout', waited_ms: 1200 });
    expect(r.observed).toBe('status online, :3100 ✗ nothing listens');
    expect(h.calls.slept).toEqual([500, 500, 200]);
  });
  it('listening: no pm2 process at all is NOT_STARTED', async () => {
    const h = harness([probe(proc('web', 'online'))]);
    await expect(
      waitFor(h.ctx, 'api', { kind: 'listening' }, { deps: h.deps })
    ).rejects.toMatchObject({ code: 'NOT_STARTED' });
  });
  it('url-ok: asks the probe for that one url and succeeds on 2xx/3xx', async () => {
    const h = harness([
      probeOut({
        jlist: jl(proc('web', 'online')),
        ps: PS,
        urls: 'http://localhost:3200/\t000\n',
      }),
      probeOut({
        jlist: jl(proc('web', 'online')),
        ps: PS,
        urls: 'http://localhost:3200/\t302\n',
      }),
    ]);
    const r = await waitFor(h.ctx, 'web', { kind: 'url-ok' }, { deps: h.deps });
    expect(r).toMatchObject({ ok: true, waited_ms: 500 });
    expect(r.observed).toBe('http://localhost:3200/ 302');
    expect(h.ctx.fake.calls[0].cmd).toContain("'http://localhost:3200/'");
  });
  it('url-ok: refused without a url', async () => {
    const h = harness([probe(proc('api', 'online'))]);
    await expect(
      waitFor(h.ctx, 'api', { kind: 'url-ok' }, { deps: h.deps })
    ).rejects.toMatchObject({ code: 'BAD_ARGUMENT' });
  });
  it('exited: uses jlist only and answers with the status word and exit code', async () => {
    const h = harness(
      [],
      [
        jl(proc('libs', 'online')),
        jl(proc('libs', 'online')),
        jl(proc('libs', 'stopped', { exit_code: 0 })),
      ]
    );
    const r = await waitFor(
      h.ctx,
      'libs',
      { kind: 'exited' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({
      ok: true,
      status: 'done',
      exit_code: 0,
      waited_ms: 1000,
    });
    expect(h.calls.probes).toBe(0);
    expect(h.calls.jlists).toBe(3);
  });
  it('exited: a task that failed is still ok (the caller judges the code); already stopped answers at once', async () => {
    const h = harness([], [jl(proc('libs', 'stopped', { exit_code: 2 }))]);
    const r = await waitFor(
      h.ctx,
      'libs',
      { kind: 'exited' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({
      ok: true,
      status: 'failed (exit 2)',
      exit_code: 2,
      waited_ms: 0,
    });
  });
  it('exited: a process deleted meanwhile ends the wait', async () => {
    const h = harness([], [jl(proc('libs', 'online')), '[]']);
    const r = await waitFor(
      h.ctx,
      'libs',
      { kind: 'exited' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'exited',
      status: 'not-started',
    });
  });
  it('a remote host is polled every second', async () => {
    const h = harness(
      [],
      [
        jl(proc('libs', 'online')),
        jl(proc('libs', 'stopped', { exit_code: 0 })),
      ]
    );
    const ctx = { ...h.ctx, host: { ...h.ctx.host, local: false } };
    await waitFor(ctx, 'libs', { kind: 'exited' }, { deps: h.deps });
    expect(h.calls.slept).toEqual([1000]);
  });
  it('an aborted wait answers aborted', async () => {
    const ac = new AbortController();
    const h = harness([], [jl(proc('libs', 'online'))]);
    const deps = {
      ...h.deps,
      sleep: async (ms: number) => {
        h.deps.sleep(ms);
        ac.abort();
      },
    };
    const r = await waitFor(
      h.ctx,
      'libs',
      { kind: 'exited' },
      { deps, signal: ac.signal }
    );
    expect(r).toMatchObject({ ok: false, reason: 'aborted' });
  });
});

describe('waitFor: limits and the real sleep', () => {
  it('caps the timeout at the maximum', async () => {
    const h = harness([probe(proc('api', 'online'))]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps, timeoutMs: WAIT_TIMEOUT_MAX_MS * 10 }
    );
    expect(r).toMatchObject({
      reason: 'timeout',
      waited_ms: WAIT_TIMEOUT_MAX_MS,
    });
  });
  it('an app the manifest does not know is UNKNOWN_APP, before any look at the host', async () => {
    const h = harness([probe(proc('api', 'online'))]);
    await expect(
      waitFor(h.ctx, 'nope', { kind: 'exited' }, { deps: h.deps })
    ).rejects.toMatchObject({ code: 'UNKNOWN_APP' });
    expect(h.calls.jlists + h.calls.probes).toBe(0);
  });
  it('the real sleep wakes at once on abort, also when the signal was aborted before it began', async () => {
    const { sleep } = defaultWaitDeps();
    const ac = new AbortController();
    const woke = sleep(60_000, ac.signal);
    ac.abort();
    await woke;
    await sleep(60_000, ac.signal);
    const t0 = Date.now();
    await sleep(20);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
  });
  it('the real sleep is the shared abortableSleep', async () => {
    expect(defaultWaitDeps().sleep).toBe(abortableSleep);
    const ac = new AbortController();
    const woke = abortableSleep(60_000, ac.signal);
    ac.abort();
    await woke;
  });
});

/** A scripted follower: each poll returns the next batch; `watch` keeps the wake so a test can fire it. */
function fakeFollower(
  batches: { out?: string[]; err?: string[]; reset?: boolean }[]
) {
  const offsets = { out: 0 as number | null, err: 0 as number | null };
  let i = 0;
  let wake: (() => void) | null = null;
  const f = {
    offsets,
    polls: 0,
    closed: false,
    async poll() {
      f.polls++;
      const b = batches[i++] ?? {};
      const lines = [
        ...(b.out ?? []).map((text) => ({ stream: 'out' as const, text })),
        ...(b.err ?? []).map((text) => ({ stream: 'err' as const, text })),
      ];
      offsets.out = (offsets.out ?? 0) + (b.out ?? []).join('\n').length;
      offsets.err = (offsets.err ?? 0) + (b.err ?? []).join('\n').length;
      return { lines, reset: b.reset ?? false };
    },
    watch(w: () => void) {
      wake = w;
    },
    close() {
      f.closed = true;
    },
    fire: () => wake?.(),
  };
  return f;
}

describe('waitFor: log: and idle:', () => {
  const online = jl(proc('api', 'online'));
  it('log: matches a new line (ANSI stripped) and returns it; history is never searched', async () => {
    const f = fakeFollower([
      { out: ['old listening on 3100'] },
      {},
      { out: ['\x1b[32mlistening on 3100\x1b[0m'] },
    ]);
    const h = harness([], [online]);
    const deps = { ...h.deps, follower: () => f };
    const r = await waitFor(h.ctx, 'api', parseUntil('log:listening on \\d+'), {
      deps,
    });
    expect(r).toMatchObject({
      ok: true,
      matched_line: 'listening on 3100',
      status: 'online',
    });
    expect(f.polls).toBe(3); // history read, one empty tick, the match
    expect(f.closed).toBe(true);
  });
  it('log: a line that arrives in the same tick the process exits still counts', async () => {
    // the 5 s status check (a stopped process) falls in the tick that reads the line: lines are judged first
    const f = fakeFollower([
      {},
      {},
      {},
      {},
      {},
      {},
      { out: ['build finished'] },
    ]);
    const h = harness(
      [],
      [online, jl(proc('api', 'stopped', { exit_code: 0 }))]
    );
    const r = await waitFor(h.ctx, 'api', parseUntil('log:finished'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: true,
      matched_line: 'build finished',
      waited_ms: 5000,
    });
  });
  it('log: a process that exits without a match ends the wait, checked at most every 5 s', async () => {
    const f = fakeFollower([{}]);
    const h = harness(
      [],
      [online, jl(proc('api', 'stopped', { exit_code: 1 }))]
    );
    const r = await waitFor(h.ctx, 'api', parseUntil('log:never'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'exited',
      status: 'stopped',
      exit_code: 1,
    });
    expect(h.calls.jlists).toBe(2); // one at the start, one after 5 s of ticks
    expect(r.waited_ms).toBe(5000);
  });
  it('log: times out with the last line seen', async () => {
    const f = fakeFollower([{}, { err: ['warming up'] }]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('log:never'), {
      deps: { ...h.deps, follower: () => f },
      timeoutMs: 3000,
    });
    expect(r).toMatchObject({ ok: false, reason: 'timeout', waited_ms: 3000 });
    expect(r.observed).toBe('last line: warming up');
  });
  it('idle: ok once nothing arrived for the given seconds, counted from the last byte', async () => {
    const f = fakeFollower([{}, { out: ['a'] }, { out: ['b'] }, {}, {}, {}]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('idle:2'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({ ok: true, status: 'online', waited_ms: 3000 }); // bytes at 0 s and 1 s; quiet 2 s → 3 s
  });
  it('idle: a log replaced by content of the same size counts as activity', async () => {
    // offsets do not move, but the follower says the file was replaced at the third poll (1 s): quiet 2 s counts from there
    const f = fakeFollower([{}, {}, { reset: true }, {}, {}, {}]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('idle:2'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({ ok: true, status: 'online', waited_ms: 3000 });
  });
  it('idle: a process that is no longer online when the quiet period ends is not settled', async () => {
    const f = fakeFollower([{}, {}, {}]);
    const h = harness(
      [],
      [online, jl(proc('api', 'errored', { exit_code: 1 }))]
    );
    const r = await waitFor(h.ctx, 'api', parseUntil('idle:1'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'crashed',
      status: 'errored',
    });
  });
  it('a wake that arrives during a poll skips the next sleep', async () => {
    const f = fakeFollower([{}, {}, { out: ['ready'] }]);
    const h = harness([], [online]);
    // the file changes while the first loop poll runs (the watch is set by then)
    const follower = {
      ...f,
      poll: async () => {
        const r = await f.poll();
        if (f.polls === 2) f.fire();
        return r;
      },
    };
    const deps = {
      ...h.deps,
      follower: () => follower,
      sleep: async () => {
        throw new Error('slept although a wake was pending');
      },
    };
    const r = await waitFor(h.ctx, 'api', parseUntil('log:ready'), { deps });
    expect(r).toMatchObject({ ok: true, matched_line: 'ready', waited_ms: 0 });
  });
  it('a wake that arrives during a sleep ends that sleep (it would not end by itself here)', async () => {
    const f = fakeFollower([{}, {}, { out: ['ready'] }]);
    const h = harness([], [online]);
    const deps = {
      ...h.deps,
      follower: () => f,
      // a sleep that only ends when its signal aborts; the file wake comes while it waits
      sleep: (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
          queueMicrotask(f.fire);
        }),
    };
    const r = await waitFor(h.ctx, 'api', parseUntil('log:ready'), { deps });
    expect(r).toMatchObject({ ok: true, matched_line: 'ready', waited_ms: 0 });
  });
  it('log: the clock is read again after a status check, so its duration does not push the timeout out', async () => {
    const f = fakeFollower([{}]);
    const h = harness([], [online]);
    const deps = {
      ...h.deps,
      follower: () => f,
      // every pm2 look takes 400 ms
      jlist: async (c: Parameters<WaitDeps['jlist']>[0]) => {
        await h.deps.sleep(400);
        return h.deps.jlist(c);
      },
    };
    const r = await waitFor(h.ctx, 'api', parseUntil('log:never'), {
      deps,
      timeoutMs: 5600,
    });
    // the 5 s check starts at 5400 ms and ends at 5800 ms, past the deadline: answered then, not after another sleep
    expect(r).toMatchObject({ ok: false, reason: 'timeout', waited_ms: 5800 });
  });
  it('log: an aborted wait answers aborted with what it saw, and closes the follower', async () => {
    const ac = new AbortController();
    const f = fakeFollower([{}, { out: ['starting'] }]);
    const h = harness([], [online]);
    const deps = {
      ...h.deps,
      follower: () => f,
      sleep: async (ms: number) => {
        await h.deps.sleep(ms);
        ac.abort();
      },
    };
    const r = await waitFor(h.ctx, 'api', parseUntil('log:never'), {
      deps,
      signal: ac.signal,
    });
    expect(r).toMatchObject({ ok: false, reason: 'aborted', status: 'online' });
    expect(r.observed).toBe('last line: starting');
    expect(f.closed).toBe(true);
  });
});

describe('waitFor: pm2 restarts the process meanwhile (stopping, waiting restart)', () => {
  const online = jl(proc('api', 'online'));
  it('listening: a stopping process in the middle of a watch restart does not end the wait', async () => {
    const h = harness([
      probe(proc('api', 'online')),
      probe(proc('api', 'stopping')),
      probe(proc('api', 'online'), ss(3100, 101)),
    ]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({ ok: true, status: 'online', waited_ms: 1000 });
  });
  it('listening: waiting restart is waited out too, and a restart that never ends is a timeout, not a death', async () => {
    const h = harness([probe(proc('api', 'waiting restart'))]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps, timeoutMs: 1200 }
    );
    expect(r).toMatchObject({ ok: false, reason: 'timeout', waited_ms: 1200 });
    expect(r.observed).toContain('status waiting restart');
  });
  it('url-ok: a waiting restart in the middle does not end the wait', async () => {
    const urls = (code: string) => `http://localhost:3200/\t${code}\n`;
    const h = harness([
      probeOut({ jlist: jl(proc('web', 'online')), ps: PS, urls: urls('000') }),
      probeOut({
        jlist: jl(proc('web', 'waiting restart')),
        ps: PS,
        urls: urls('000'),
      }),
      probeOut({ jlist: jl(proc('web', 'online')), ps: PS, urls: urls('200') }),
    ]);
    const r = await waitFor(h.ctx, 'web', { kind: 'url-ok' }, { deps: h.deps });
    expect(r).toMatchObject({ ok: true, status: 'online', waited_ms: 1000 });
  });
  it('log: a status check that finds the process stopping keeps waiting, and a later line matches', async () => {
    // the 5 s check falls on the 7th poll; the line arrives at 7 s
    const f = fakeFollower([
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      {},
      { out: ['ready'] },
    ]);
    const h = harness([], [online, jl(proc('api', 'stopping')), online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('log:ready'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: true,
      matched_line: 'ready',
      waited_ms: 7000,
    });
  });
  it('log: a status check that finds the process dead ends the wait even after a stopping one', async () => {
    const f = fakeFollower([{}]);
    const h = harness(
      [],
      [
        online,
        jl(proc('api', 'waiting restart')),
        jl(proc('api', 'stopped', { exit_code: 1 })),
      ]
    );
    const r = await waitFor(h.ctx, 'api', parseUntil('log:never'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'exited',
      status: 'stopped',
      waited_ms: 10_000,
    });
  });
  it('idle: a quiet period that ends while the process is stopping keeps waiting until it is online', async () => {
    const f = fakeFollower([{}]);
    const h = harness([], [online, jl(proc('api', 'stopping')), online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('idle:1'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({ ok: true, status: 'online', waited_ms: 2000 });
    expect(h.calls.slept.every((ms) => ms > 0)).toBe(true); // no busy loop while it waits for pm2
  });
  it('idle: a process that turns out dead after stopping is not settled', async () => {
    const f = fakeFollower([{}]);
    const h = harness(
      [],
      [online, jl(proc('api', 'stopping')), jl(proc('api', 'stopped'))]
    );
    const r = await waitFor(h.ctx, 'api', parseUntil('idle:1'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({ ok: false, reason: 'exited', status: 'stopped' });
  });
  it('exited: stopping is waited out, waiting restart counts as left online', async () => {
    const h = harness(
      [],
      [
        jl(proc('libs', 'online')),
        jl(proc('libs', 'stopping')),
        jl(proc('libs', 'waiting restart')),
      ]
    );
    const r = await waitFor(
      h.ctx,
      'libs',
      { kind: 'exited' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({ ok: true, waited_ms: 1000 });
    expect(r.status).toBe('waiting restart');
  });
});

describe('waitFor: a process that is not running is not ready, whatever answers', () => {
  const urls = (code: string) => `http://localhost:3200/\t${code}\n`;
  const webProbe = (status: string, code = '200', list = true) =>
    probeOut({
      jlist: list ? jl(proc('web', status)) : '[]',
      ps: PS,
      urls: urls(code),
    });
  it('url-ok: a stopped process behind a url that still answers 200 is exited, not ready', async () => {
    const h = harness([webProbe('stopped')]);
    const r = await waitFor(h.ctx, 'web', { kind: 'url-ok' }, { deps: h.deps });
    expect(r).toMatchObject({ ok: false, reason: 'exited', status: 'stopped' });
    expect(r.observed).toBe('http://localhost:3200/ 200');
  });
  it('url-ok: an errored process behind a url that still answers is crashed', async () => {
    const h = harness([webProbe('errored')]);
    const r = await waitFor(h.ctx, 'web', { kind: 'url-ok' }, { deps: h.deps });
    expect(r).toMatchObject({
      ok: false,
      reason: 'crashed',
      status: 'errored',
    });
  });
  it('url-ok: a process deleted on a later sample while the url stays healthy is exited (not-started), not ok', async () => {
    const h = harness([
      webProbe('online', '000'),
      webProbe('online', '200', false),
    ]);
    const r = await waitFor(h.ctx, 'web', { kind: 'url-ok' }, { deps: h.deps });
    expect(r).toMatchObject({
      ok: false,
      reason: 'exited',
      status: 'not-started',
    });
  });
  it('listening: ports bound while the process is stopping are not ready yet; the wait goes on and succeeds once it is online', async () => {
    // a restarting process still has its pid, so the bound port is attributed to the app
    const alive = (status: string) => ({ ...proc('api', status), pid: 100 });
    const h = harness([
      probe(alive('stopping'), ss(3100, 101)),
      probe(alive('waiting restart'), ss(3100, 101)),
      probe(alive('online'), ss(3100, 101)),
    ]);
    const r = await waitFor(
      h.ctx,
      'api',
      { kind: 'listening' },
      { deps: h.deps }
    );
    expect(r).toMatchObject({ ok: true, status: 'online', waited_ms: 1000 });
  });
  it('url-ok: an answering url while pm2 restarts the process is waited out too, and a restart that never ends times out', async () => {
    const h = harness([webProbe('waiting restart')]);
    const r = await waitFor(
      h.ctx,
      'web',
      { kind: 'url-ok' },
      { deps: h.deps, timeoutMs: 1200 }
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'timeout',
      status: 'waiting restart',
    });
    expect(r.observed).toBe(
      'status waiting restart, http://localhost:3200/ 200'
    );
  });
});

describe('waitFor: log: and pm2 stamps', () => {
  const online = jl(proc('api', 'online'));
  const stamped = (text: string) => `2026-10-13T20:00:00.123: ${text}`;
  it('log: the pattern is tested against the line without the stamp, and the answer keeps the stamp', async () => {
    const f = fakeFollower([
      {},
      { out: [stamped('\x1b[32mlistening on 3100')] },
    ]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('log:^listening'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: true,
      matched_line: stamped('listening on 3100'),
    });
  });
  it('log: a seconds-only stamp is stripped too', async () => {
    const f = fakeFollower([{}, { err: ['2026-10-13T20:00:00: ready'] }]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('log:^ready$'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r.ok).toBe(true);
  });
  it('log: a pattern that could match only with the stamp does not', async () => {
    const f = fakeFollower([{}, { out: [stamped('listening on 3100')] }]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('log:^2026-10-13'), {
      deps: { ...h.deps, follower: () => f },
      timeoutMs: 3000,
    });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

/**
 * A follower over a timeline: each write lands at its time (ms after the wait began) and a poll returns what landed
 * since the last one. Its file wake ends a sleep at the next write, as the real watch does.
 */
function timedFollower(
  now: () => number,
  writes: { at: number; out?: string[]; err?: string[] }[]
) {
  const base = now();
  const offsets = { out: 0 as number | null, err: 0 as number | null };
  let read = 0;
  const f = {
    offsets,
    polls: 0,
    closed: false,
    async poll() {
      f.polls++;
      const lines: { stream: 'out' | 'err'; text: string }[] = [];
      while (read < writes.length && base + writes[read].at <= now()) {
        const w = writes[read++];
        for (const text of w.out ?? []) lines.push({ stream: 'out', text });
        for (const text of w.err ?? []) lines.push({ stream: 'err', text });
        offsets.out = (offsets.out ?? 0) + (w.out ?? []).join('\n').length;
        offsets.err = (offsets.err ?? 0) + (w.err ?? []).join('\n').length;
      }
      return { lines, reset: false };
    },
    watch() {},
    close() {
      f.closed = true;
    },
    /** how long a sleep of `ms` from now lasts: until the next write at the latest */
    cut(ms: number) {
      const next = writes.find((w) => base + w.at > now());
      return next ? Math.min(ms, base + next.at - now()) : ms;
    },
  };
  return f;
}

describe('waitFor: reloaded', () => {
  const online = jl(proc('api', 'online'));
  const at = (s: string) => `2026-10-14T12:00:${s}: `;
  const vite = (s: string, file: string) =>
    `${at(s)}[vite] (client) page reload /src/${file}`;
  it('lines written before the call never count: the history the follower skips holds a whole reload', async () => {
    const f = fakeFollower([
      { out: [vite('01.000', 'a.ts'), vite('01.010', 'b.ts')] },
    ]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), {
      deps: { ...h.deps, follower: () => f },
      timeoutMs: 4000,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'timeout',
      until: 'reloaded',
      observed: 'no new output',
    });
    expect(r.reloaded).toBeUndefined();
  });
  it('ok only once the burst went quiet for 2 s, answered at that moment rather than a tick later', async () => {
    const h = harness([], [online]);
    const start = h.deps.now();
    const f = timedFollower(h.deps.now, [
      {
        at: 1000,
        out: [
          vite('01.000', 'a.ts'),
          vite('01.004', 'b.ts'),
          vite('01.009', 'c.ts'),
        ],
      },
      { at: 2500, out: [`${at('02.500')}GET / 200`] }, // other output wakes the follower: no marker, still waiting
    ]);
    const polledAt: number[] = [];
    const deps = {
      ...h.deps,
      follower: () => ({
        ...f,
        poll: () => {
          polledAt.push(h.deps.now() - start);
          return f.poll();
        },
      }),
      sleep: (ms: number) => h.deps.sleep(f.cut(ms)),
    };
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), { deps });
    expect(r).toMatchObject({
      ok: true,
      until: 'reloaded',
      status: 'online',
      waited_ms: 3000, // 2 s after the burst arrived, not at the next 1 s tick after 2.5 s
      reloaded: { time: '2026-10-14T12:00:01.000', lines: 3 },
    });
    expect(r.reloaded?.line).toContain('page reload /src/a.ts');
    expect(polledAt).toEqual([0, 0, 1000, 2000, 2500, 3000]); // position, then each tick or wake
    expect(f.closed).toBe(true);
  });
  it('a marker 2 s or more later than the open burst closes it at once: the first burst is the answer', async () => {
    const f = fakeFollower([
      {},
      { out: [vite('10.000', 'a.ts')] },
      { err: [vite('12.500', 'b.ts')] },
    ]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: true,
      waited_ms: 1000, // the poll that read the later marker, before the first burst's quiet period ended
      reloaded: { time: '2026-10-14T12:00:10.000', lines: 1 },
    });
    expect(r.reloaded?.line).toContain('/src/a.ts');
  });
  it('a re-listen line after the call is a reload: the boot is before the call', async () => {
    const f = fakeFollower([
      {},
      { out: [`${at('20.000')}api listening on 3100`] },
    ]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({ ok: true, waited_ms: 2000 });
  });
  it('times out with the last line seen when no reload came', async () => {
    const f = fakeFollower([{}, { err: ['warming up'] }]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), {
      deps: { ...h.deps, follower: () => f },
      timeoutMs: 3000,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'timeout',
      until: 'reloaded',
      waited_ms: 3000,
      observed: 'last line: warming up',
    });
  });
  it('a burst still open at the deadline is named in what was observed: a reload in progress, not none', async () => {
    const h = harness([], [online]);
    const f = timedFollower(h.deps.now, [
      {
        at: 3000,
        out: [vite('03.000', 'a.ts'), vite('03.004', 'b.ts')],
      },
    ]);
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), {
      deps: {
        ...h.deps,
        follower: () => f,
        sleep: (ms: number) => h.deps.sleep(f.cut(ms)),
      },
      timeoutMs: 4000,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'timeout',
      until: 'reloaded',
      waited_ms: 4000,
      observed:
        'reload in progress since 2026-10-14T12:00:03.000 (2 lines): [vite] (client) page reload /src/a.ts',
    });
    expect(r.reloaded).toBeUndefined();
  });
  it('an aborted wait with a burst open names it too', async () => {
    const ac = new AbortController();
    const f = fakeFollower([{}, { out: [vite('05.000', 'a.ts')] }]);
    const h = harness([], [online]);
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), {
      deps: {
        ...h.deps,
        follower: () => f,
        sleep: async (ms: number) => {
          await h.deps.sleep(ms);
          ac.abort();
        },
      },
      signal: ac.signal,
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'aborted',
      observed:
        'reload in progress since 2026-10-14T12:00:05.000 (1 line): [vite] (client) page reload /src/a.ts',
    });
  });
  it('a process that dies meanwhile ends the wait as gone', async () => {
    const f = fakeFollower([{}]);
    const h = harness(
      [],
      [online, jl(proc('api', 'errored', { exit_code: 1 }))]
    );
    const r = await waitFor(h.ctx, 'api', parseUntil('reloaded'), {
      deps: { ...h.deps, follower: () => f },
    });
    expect(r).toMatchObject({
      ok: false,
      reason: 'crashed',
      status: 'errored',
      exit_code: 1,
      waited_ms: 5000,
    });
    expect(f.closed).toBe(true);
  });
  it('an app with reloads: false is refused before the host is asked or a follower is made', async () => {
    const h = harness([], [online]);
    h.ctx.manifest.apps.api = { ...h.ctx.manifest.apps.api, reloads: null };
    await expect(
      waitFor(h.ctx, 'api', parseUntil('reloaded'), { deps: h.deps })
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      message: expect.stringContaining('reloads: false'),
    });
    expect(h.calls.jlists).toBe(0);
  });
});

describe('untilFor / waitDependency / depFailure', () => {
  const m = loadManifest(readiness);
  it('ready prefers declared ports, falls back to the url; completed is exited', () => {
    expect(
      untilFor({ app: 'api', condition: 'ready', timeoutMs: 1 }, m.apps.api)
    ).toEqual({ kind: 'listening' });
    expect(
      untilFor(
        { app: 'web', condition: 'ready', timeoutMs: 1 },
        { ...m.apps.web, ports: [] }
      )
    ).toEqual({ kind: 'url-ok' });
    expect(
      untilFor(
        { app: 'libs', condition: 'completed', timeoutMs: 1 },
        m.apps.libs
      )
    ).toEqual({ kind: 'exited' });
  });
  it('completed is ok only with exit 0', async () => {
    const h = harness([], [jl(proc('libs', 'stopped', { exit_code: 2 }))]);
    const r = await waitDependency(
      h.ctx,
      { app: 'libs', condition: 'completed', timeoutMs: 1000 },
      { deps: h.deps }
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'failed',
      status: 'failed (exit 2)',
      exit_code: 2,
    });
    expect(
      depFailure({ app: 'libs', condition: 'completed', timeoutMs: 1000 }, r)
    ).toBe('libs failed (exit 2)');
  });
  it('a dependency the manifest does not know is UNKNOWN_APP, before anything is looked at', async () => {
    const h = harness([], [jl(proc('libs', 'stopped', { exit_code: 0 }))]);
    await expect(
      waitDependency(
        h.ctx,
        { app: 'nope', condition: 'ready', timeoutMs: 1000 },
        { deps: h.deps }
      )
    ).rejects.toMatchObject({ code: 'UNKNOWN_APP' });
    expect(h.calls.jlists + h.calls.probes).toBe(0);
  });
  it('depFailure names timeouts, exits and crashes', () => {
    const d = { app: 'api', condition: 'ready' as const, timeoutMs: 90_000 };
    expect(
      depFailure(d, {
        ok: false,
        reason: 'timeout',
        until: 'listening',
        waited_ms: 90_000,
        status: 'online',
        observed: 'status online, :3100 ✗ nothing listens',
      })
    ).toBe('api not ready in 90 s (status online, :3100 ✗ nothing listens)');
    expect(
      depFailure(d, {
        ok: false,
        reason: 'exited',
        until: 'listening',
        waited_ms: 5,
        status: 'stopped',
        exit_code: null,
      })
    ).toBe('api exited (stopped)');
    expect(
      depFailure(d, {
        ok: false,
        reason: 'crashed',
        until: 'listening',
        waited_ms: 5,
        status: 'errored',
      })
    ).toBe('api crashed');
    expect(
      depFailure(
        { ...d, condition: 'completed', timeoutMs: 60_000 },
        {
          ok: false,
          reason: 'timeout',
          until: 'exited',
          waited_ms: 60_000,
          status: 'online',
        }
      )
    ).toBe('api not completed in 60 s (status online)');
  });
});

describe('waitFor: url-ok follows the url_check decision', () => {
  const fleetDir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
  const web = (status: string) => ({
    pid: status === 'online' ? 100 : 0,
    name: 'fleet-web',
    pm_id: 3,
    pm2_env: {
      status,
      namespace: 'fleet',
      pm_out_log_path: '/l/o',
      pm_err_log_path: '/l/e',
    },
  });
  const boxProbe = (line: string, status: string) =>
    probeOut({ jlist: JSON.stringify([web(status)]), ps: PS, urls: line });
  const mk = (line: string, check: HereCheck, status = 'online') => {
    let t = 1_000_000;
    const ctx = fakeCtx(
      fleetDir,
      'box',
      [
        {
          match: MARK.JLIST,
          result: () => ({ stdout: boxProbe(line, status) }),
        },
      ],
      'local',
      check
    );
    const deps: WaitDeps = {
      jlist: (c) => c.pm2.jlist(),
      snapshot: (c, o) => snapshot(c, o),
      follower: () => {
        throw new Error('not used here');
      },
      sleep: async (ms) => {
        t += ms;
      },
      now: () => t,
      leases: async () => [],
    };
    return { ctx, deps };
  };
  it('a url the box cannot reach but this machine can is ok, and observed says where and why', async () => {
    const asked: string[] = [];
    const { ctx, deps } = mk(
      'http://localhost:3000/\t000\t7\t::1\n',
      async (u) => {
        asked.push(u);
        return { answered: true, code: 200 };
      }
    );
    const r = await waitFor(ctx, 'web', { kind: 'url-ok' }, { deps });
    expect(r).toMatchObject({ ok: true, waited_ms: 0 });
    expect(r.observed).toBe(
      'http://localhost:3000/ 200 from this machine (on box: refused)'
    );
    expect(asked).toEqual(['http://localhost:3000/']);
  });
  it('neither answers: the timeout names both reasons', async () => {
    const { ctx, deps } = mk(
      'http://localhost:3000/\t000\t7\t::1\n',
      async () => ({ answered: false, fail: 'refused' })
    );
    const r = await waitFor(
      ctx,
      'web',
      { kind: 'url-ok' },
      { deps, timeoutMs: 1500 }
    );
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(r.observed).toBe(
      'http://localhost:3000/ down (on box: refused; here: refused)'
    );
  });
  it('a ready dependency with only a url is ready once it answers from this machine', async () => {
    const { ctx, deps } = mk(
      'http://localhost:3000/\t000\t7\t::1\n',
      async () => ({ answered: true, code: 204 })
    );
    ctx.manifest.apps.web = { ...ctx.manifest.apps.web, ports: [] }; // no port: ready is the url
    const r = await waitDependency(
      ctx,
      { app: 'web', condition: 'ready', timeoutMs: 5000 },
      { deps }
    );
    expect(r).toMatchObject({ ok: true, until: 'url-ok' });
  });
  // the accepted risk of a localhost url: this machine may serve the same port while the box's app is down
  it.each([
    ['stopped', 'exited'],
    ['errored', 'crashed'],
  ])(
    'a url this machine answers while the box process is %s is not ready: %s',
    async (status, reason) => {
      const { ctx, deps } = mk(
        'http://localhost:3000/\t000\t7\t::1\n',
        async () => ({ answered: true, code: 200 }),
        status
      );
      const r = await waitFor(ctx, 'web', { kind: 'url-ok' }, { deps });
      expect(r).toMatchObject({ ok: false, reason, status });
      expect(r.observed).toBe(
        'http://localhost:3000/ 200 from this machine (on box: refused)'
      );
    }
  );
});

describe('waitFor: a start that is queued (lease-aware)', () => {
  it('keeps waiting while a pending lease covers an app with no process, then sees it come up', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    let polls = 0;
    const deps = fakeDeps({
      jlist: async () =>
        polls >= 2 ? [onlineProc('demo-w2-api', 'demo-w2')] : [],
      snapshot: async () => {
        polls++;
        return polls >= 2
          ? snapWith(onlineProc('demo-w2-api', 'demo-w2'), {
              api: listening(3510),
            })
          : snapWith();
      },
      leases: async () =>
        polls >= 2
          ? []
          : [
              {
                id: 'l_x',
                state: 'pending',
                position: 1,
                waiting_for: '100M short',
                apps: ['api'],
              },
            ],
    });
    const r = await waitFor(
      ctx,
      'api',
      { kind: 'listening' },
      { deps, timeoutMs: 5000 }
    );
    expect(r.ok).toBe(true);
  });
  it('times out with the queue position as what was observed', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const deps = fakeDeps({
      jlist: async () => [],
      snapshot: async () => snapWith(),
      leases: async () => [
        {
          id: 'l_x',
          state: 'pending',
          position: 3,
          waiting_for: '100M short',
          apps: ['api'],
        },
      ],
    });
    const r = await waitFor(
      ctx,
      'api',
      { kind: 'listening' },
      { deps, timeoutMs: 1000 }
    );
    expect(r).toMatchObject({
      ok: false,
      reason: 'timeout',
      status: 'queued #3',
      observed: 'queued #3: 100M short',
    });
  });
  it('still throws NOT_STARTED when no lease covers the app', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const deps = fakeDeps({
      jlist: async () => [],
      snapshot: async () => snapWith(),
      leases: async () => [],
    });
    await expect(
      waitFor(ctx, 'api', { kind: 'listening' }, { deps })
    ).rejects.toMatchObject({ code: 'NOT_STARTED' });
  });
  it('a starting lease reads starting; an aborted wait names the queue too', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const starting = fakeDeps({
      leases: async () => [
        {
          id: 'l_s',
          state: 'starting',
          position: 0,
          waiting_for: null,
          apps: ['db', 'api'],
        },
      ],
    });
    expect(
      await waitFor(
        ctx,
        'api',
        { kind: 'listening' },
        { deps: starting, timeoutMs: 600 }
      )
    ).toMatchObject({
      ok: false,
      reason: 'timeout',
      status: 'starting',
      observed: 'starting',
    });
    const ac = new AbortController();
    ac.abort();
    const queued = fakeDeps({
      leases: async () => [
        {
          id: 'l_q',
          state: 'pending',
          position: 2,
          waiting_for: '1 ahead in the queue',
          apps: ['api'],
        },
      ],
    });
    expect(
      await waitFor(
        ctx,
        'api',
        { kind: 'listening' },
        { deps: queued, signal: ac.signal }
      )
    ).toMatchObject({
      ok: false,
      reason: 'aborted',
      status: 'queued #2',
      observed: 'queued #2: 1 ahead in the queue',
    });
  });
  it('a lease that ends without the app ever starting is NOT_STARTED at the next look', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    let looks = 0;
    const deps = fakeDeps({
      snapshot: async () => {
        looks++;
        return snapWith();
      },
      leases: async () =>
        looks >= 2
          ? []
          : [
              {
                id: 'l_x',
                state: 'pending',
                position: 1,
                waiting_for: null,
                apps: ['api'],
              },
            ],
    });
    await expect(
      waitFor(ctx, 'api', { kind: 'listening' }, { deps, timeoutMs: 5000 })
    ).rejects.toMatchObject({ code: 'NOT_STARTED' });
    expect(looks).toBe(2);
  });
  it('exited rides through a lease too, then answers with the exit', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    let looks = 0;
    const done: Pm2Process = {
      ...onlineProc('demo-w2-tool', 'demo-w2'),
      pid: 0,
      status: 'stopped',
      exit_code: 0,
    };
    const deps = fakeDeps({
      jlist: async () => (++looks >= 3 ? [done] : []),
      leases: async () =>
        looks >= 3
          ? []
          : [
              {
                id: 'l_t',
                state: 'starting',
                position: 0,
                waiting_for: null,
                apps: ['tool'],
              },
            ],
    });
    expect(
      await waitFor(ctx, 'tool', { kind: 'exited' }, { deps })
    ).toMatchObject({ ok: true, status: 'done', exit_code: 0 });
    expect(looks).toBe(3);
  });
  it('log: rides through a pending lease until the process appears on the third look, then matches a line', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    let looks = 0;
    const f = fakeFollower([
      { out: ['old: ready on 3510'] },
      { out: ['2026-10-17T10:00:00.000: ready on 3510'] },
    ]);
    const slept: number[] = [];
    let t = 1_000_000;
    const deps = fakeDeps({
      jlist: async () =>
        ++looks >= 3 ? [onlineProc('demo-w2-api', 'demo-w2')] : [],
      leases: async () =>
        looks >= 3
          ? []
          : [
              {
                id: 'l_x',
                state: 'pending',
                position: 1,
                waiting_for: '100M short',
                apps: ['api'],
              },
            ],
      follower: () => f,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
      now: () => t,
    });
    const r = await waitFor(ctx, 'api', parseUntil('log:ready on \\d+'), {
      deps,
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({
      ok: true,
      status: 'online',
      matched_line: '2026-10-17T10:00:00.000: ready on 3510',
    });
    expect(looks).toBe(3);
    // pm2 is asked again at the local poll interval while queued
    expect(slept).toEqual([500, 500]);
    expect(f.closed).toBe(true);
  });
  it('log: times out while queued with the queue word as the status, and never makes a follower', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const deps = fakeDeps({
      leases: async () => [
        {
          id: 'l_x',
          state: 'pending',
          position: 2,
          waiting_for: '1 ahead in the queue',
          apps: ['api'],
        },
      ],
    });
    expect(
      await waitFor(ctx, 'api', parseUntil('log:ready'), {
        deps,
        timeoutMs: 1000,
      })
    ).toMatchObject({
      ok: false,
      reason: 'timeout',
      until: 'log:ready',
      status: 'queued #2',
      observed: 'queued #2: 1 ahead in the queue',
    });
  });
  it('idle: a lease that ends without the app ever starting is NOT_STARTED, as before', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    let reads = 0;
    const deps = fakeDeps({
      leases: async () =>
        ++reads >= 2
          ? []
          : [
              {
                id: 'l_x',
                state: 'starting',
                position: 0,
                waiting_for: null,
                apps: ['api'],
              },
            ],
    });
    await expect(
      waitFor(ctx, 'api', parseUntil('idle:2'), { deps, timeoutMs: 5000 })
    ).rejects.toMatchObject({ code: 'NOT_STARTED' });
    expect(reads).toBe(2);
  });
  it('listening: a stopped process that a pending lease covers is waited through until it is online (a stop, then a start that queued)', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const stopped: Pm2Process = {
      ...onlineProc('demo-w2-api', 'demo-w2'),
      pid: 0,
      status: 'stopped',
    };
    const pending = [
      {
        id: 'l_x',
        state: 'pending' as const,
        position: 1,
        waiting_for: '100M short',
        apps: ['api'],
      },
    ];
    let polls = 0;
    const deps = fakeDeps({
      snapshot: async () => {
        polls++;
        return polls >= 3
          ? snapWith(onlineProc('demo-w2-api', 'demo-w2'), {
              api: listening(3510),
            })
          : snapWith(stopped);
      },
      leases: async () => (polls >= 3 ? [] : pending),
    });
    expect(
      await waitFor(
        ctx,
        'api',
        { kind: 'listening' },
        { deps, timeoutMs: 5000 }
      )
    ).toMatchObject({ ok: true, status: 'online' });
    expect(polls).toBe(3);
    // the lease never admits it: the wait times out as queued, not as exited
    const never = fakeDeps({
      snapshot: async () => snapWith(stopped),
      leases: async () => pending,
    });
    expect(
      await waitFor(
        ctx,
        'api',
        { kind: 'listening' },
        { deps: never, timeoutMs: 2000 }
      )
    ).toMatchObject({
      ok: false,
      reason: 'timeout',
      status: 'queued #1',
      observed: 'queued #1: 100M short',
    });
    // no covering lease: a stopped process still ends the wait at once, as before
    expect(
      await waitFor(
        ctx,
        'api',
        { kind: 'listening' },
        {
          deps: fakeDeps({
            snapshot: async () =>
              snapWith(stopped, {
                api: {
                  actual: [],
                  declared: [3510],
                  checks: [{ port: 3510, status: 'declared-not-listening' }],
                  undeclared: [],
                },
              }),
          }),
          timeoutMs: 2000,
        }
      )
    ).toMatchObject({ ok: false, reason: 'exited', status: 'stopped' });
  });
  it('exited and log: ride through a covering lease over a stopped process too', async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const done: Pm2Process = {
      ...onlineProc('demo-w2-tool', 'demo-w2'),
      pid: 0,
      status: 'stopped',
      exit_code: 0,
    };
    const lease = (app: string) => [
      {
        id: 'l_t',
        state: 'starting' as const,
        position: 0,
        waiting_for: null,
        apps: [app],
      },
    ];
    // the last run's exit is not the answer while the queued run has not started
    expect(
      await waitFor(
        ctx,
        'tool',
        { kind: 'exited' },
        {
          deps: fakeDeps({
            jlist: async () => [done],
            leases: async () => lease('tool'),
          }),
          timeoutMs: 1000,
        }
      )
    ).toMatchObject({ ok: false, reason: 'timeout', status: 'starting' });
    let looks = 0;
    const f = fakeFollower([{}, { out: ['ready on 3510'] }]);
    const stoppedApi: Pm2Process = {
      ...onlineProc('demo-w2-api', 'demo-w2'),
      pid: 0,
      status: 'stopped',
    };
    expect(
      await waitFor(ctx, 'api', parseUntil('log:ready'), {
        deps: fakeDeps({
          jlist: async () =>
            ++looks >= 3
              ? [onlineProc('demo-w2-api', 'demo-w2')]
              : [stoppedApi],
          leases: async () => (looks >= 3 ? [] : lease('api')),
          follower: () => f,
        }),
        timeoutMs: 5000,
      })
    ).toMatchObject({ ok: true, matched_line: 'ready on 3510' });
    expect(looks).toBe(3);
  });
  it("the poll's snapshot reads no leases itself: they come from deps.leases, only while the app has no process", async () => {
    const ctx = fakeCtx(varsProj, 'local', []);
    const asked: unknown[] = [];
    let leaseReads = 0;
    const deps = fakeDeps({
      snapshot: async (_c, o) => {
        asked.push(o.leases);
        return snapWith(onlineProc('demo-w2-api', 'demo-w2'), {
          api: listening(3510),
        });
      },
      leases: async () => {
        leaseReads++;
        return [];
      },
    });
    expect(
      (await waitFor(ctx, 'api', { kind: 'listening' }, { deps })).ok
    ).toBe(true);
    expect(asked).toEqual(['none']);
    expect(leaseReads).toBe(0);
  });
  it("the start this process runs under its own lease (the watcher's child) sees its apps as pm2 does: a task that finished is completed, not starting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wait-'));
    const prev = process.env.MCPROC_STATE_DIR;
    process.env.MCPROC_STATE_DIR = dir;
    try {
      const store = new LeaseStore(dir);
      const m = loadManifest(varsProj);
      const own = await store.create(
        {
          kind: 'start',
          project: m.project,
          root: m.root,
          slot: m.slot,
          repo: m.repo,
          target: 'tool',
          apps: ['tool'],
          reload: false,
          estimate_mib: 1,
          need_mib: 1,
          margin: 0,
          reserve_mib: 0,
          sources: {},
          note: null,
          requester_pid: 1,
        },
        'pending'
      );
      await store.transition(own.id, 'starting', { child_pid: process.pid });
      const ctx = fakeCtx(varsProj, 'local', []);
      const done: Pm2Process = {
        ...onlineProc('demo-w2-tool', 'demo-w2'),
        pid: 0,
        status: 'stopped',
        exit_code: 0,
      };
      const deps = fakeDeps({
        jlist: async () => [done],
        leases: defaultWaitDeps().leases,
      });
      // a completed dependency of the leased start itself: its own lease must not hide the exit
      expect(
        await waitFor(
          ctx,
          'tool',
          { kind: 'exited' },
          { deps, timeoutMs: 1000 }
        )
      ).toMatchObject({ ok: true, status: 'done', exit_code: 0 });
      // the same lease run by another process covers the app for this one
      await store.patch(own.id, { child_pid: 1 });
      expect(
        await waitFor(
          ctx,
          'tool',
          { kind: 'exited' },
          { deps, timeoutMs: 1000 }
        )
      ).toMatchObject({ ok: false, reason: 'timeout', status: 'starting' });
    } finally {
      if (prev === undefined) delete process.env.MCPROC_STATE_DIR;
      else process.env.MCPROC_STATE_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("the default leases read covers this checkout's pending and starting leases, on this machine only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wait-'));
    const prev = process.env.MCPROC_STATE_DIR;
    process.env.MCPROC_STATE_DIR = dir;
    try {
      const store = new LeaseStore(dir);
      const fleetDir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
      const make = (root: string, apps: string[]) => {
        const m = loadManifest(root);
        return store.create(
          {
            kind: 'start',
            project: m.project,
            root: m.root,
            slot: m.slot,
            repo: m.repo,
            target: apps.join(','),
            apps,
            reload: false,
            estimate_mib: 1,
            need_mib: 1,
            margin: 0,
            reserve_mib: 0,
            sources: {},
            note: null,
            requester_pid: 1,
          },
          'pending'
        );
      };
      const mine = await make(varsProj, ['api']);
      const done = await make(varsProj, ['db']);
      await store.transition(done.id, 'running');
      await make(fleetDir, ['web']);
      const leases = defaultWaitDeps().leases;
      expect(await leases(fakeCtx(varsProj, 'local', []))).toEqual([
        {
          id: mine.id,
          state: 'pending',
          position: 1,
          waiting_for: null,
          apps: ['api'],
        },
      ]);
      expect(await leases(fakeCtx(fleetDir, 'box', [], 'local'))).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.MCPROC_STATE_DIR;
      else process.env.MCPROC_STATE_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

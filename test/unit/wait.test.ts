import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { probeOut } from '../helpers/probe.js';
import { MARK } from '../../src/shell/snippets.js';
import {
  parseUntil,
  waitFor,
  untilLabel,
  defaultWaitDeps,
  WAIT_TIMEOUT_MAX_MS,
  type WaitDeps,
} from '../../src/core/wait.js';
import { snapshot } from '../../src/core/list.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readiness = path.join(here, '..', 'fixtures', 'projects', 'readiness');
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
  };
  return { ctx, deps, calls };
}
const probe = (p: ReturnType<typeof proc>, tcp = '') =>
  probeOut({ jlist: JSON.stringify([p]), ps: PS, tcp });
const jl = (p: ReturnType<typeof proc>) => JSON.stringify([p]);

describe('parseUntil', () => {
  it('accepts the five forms and labels them back', () => {
    expect(parseUntil('listening')).toEqual({ kind: 'listening' });
    expect(parseUntil('url-ok')).toEqual({ kind: 'url-ok' });
    expect(parseUntil('exited')).toEqual({ kind: 'exited' });
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
      'reloaded',
    ])
      expect(() => parseUntil(bad)).toThrowError(
        expect.objectContaining({ code: 'BAD_ARGUMENT' })
      );
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
});

/** A scripted follower: each poll returns the next batch; `watch` keeps the wake so a test can fire it. */
function fakeFollower(batches: { out?: string[]; err?: string[] }[]) {
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
      return { lines, reset: false };
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

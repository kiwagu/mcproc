import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearResolutionCache, prepare } from '../../src/core/resolve.js';
import { Fleet, actOn } from '../../src/core/fleet.js';
import {
  LogMarks,
  parseSince,
  readSince,
  type SinceLine,
} from '../../src/core/logsince.js';
import { buildProgram } from '../../src/cli/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
/** The bundle under test: dist/cli.js, or another build of this tree (a branch built elsewhere, so dist keeps serving the installed mcproc). */
const cli = process.env.MCPROC_CLI ?? path.join(root, 'dist', 'cli.js');

/** A counter on stdout every 200 ms: a line's number says whether a reader lost or repeated it. */
const counter = (word: string) =>
  `node -e "let i=0; setInterval(() => console.log('${word}', ++i), 200)"`;
const WORD = { a: 'tick', b: 'tock' } as const;
/** An app that says it booted once, then ticks: its boot line exists only in the history of its log. */
const booting = `node -e "console.log('boot c'); let i=0; setInterval(() => console.log('tuck', ++i), 200)"`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops the daemon of a PM2_HOME with the bundled pm2, for a setup that failed before a context existed. */
function killDaemon(home: string) {
  if (!fs.existsSync(path.join(home, 'pm2.pid'))) return;
  const pm2 = createRequire(import.meta.url).resolve('pm2/bin/pm2');
  execFileSync(process.execPath, [pm2, 'kill'], {
    env: { ...process.env, PM2_HOME: home },
    stdio: 'ignore',
  });
}

/** One printed line (`a | <stamp>: tick 7`): its app, pm2 stamp and counter; null when it is not one of ours. */
function parse(l: string): { app: 'a' | 'b'; time: string; n: number } | null {
  const m = /^([ab]) \| (\S+): (tick|tock) (\d+)$/.exec(l);
  const app = m?.[1] as 'a' | 'b' | undefined;
  return m && app && WORD[app] === m[3]
    ? { app, time: m[2], n: Number(m[4]) }
    : null;
}
/** The counters of each app in the order they were printed. */
function counters(lines: string[]): Record<'a' | 'b', number[]> {
  const seen = { a: [] as number[], b: [] as number[] };
  for (const l of lines) {
    const x = parse(l);
    if (x) seen[x.app].push(x.n);
  }
  return seen;
}
/** Lines of the since answer as the CLI prints them, for `counters`. */
const printed = (lines: SinceLine[]) =>
  lines.map((l) => `${l.app} | ${l.text}`);
/** This machine's wall clock at `ms` in pm2's stamp shape (the apps run here, so their stamps use the same clock). */
const stampAt = (ms: number) =>
  new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 23);
async function until(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(50);
}
const consecutive = (ns: number[]) =>
  ns.every((n, i) => i === 0 || n === ns[i - 1] + 1);
const newest = (lines: SinceLine[], app: string) =>
  lines
    .filter((l) => l.app === app)
    .reduce((t, l) => (l.time !== null && l.time > t ? l.time : t), '');

describe.skipIf(process.env.MCPROC_IT !== '1')('logs since on real pm2', () => {
  let base: string | undefined;
  let home: string | undefined;
  let dir = '';
  let fleet: Fleet | undefined;
  const children: ChildProcess[] = [];
  /** the fleet, once beforeAll has made it */
  const f = () => fleet!;
  /**
   * The built CLI in its own process, against the same daemon: the manifest's pm2_home goes with --project, and mcproc
   * puts it in front of each pm2 command, so a PM2_HOME inherited from the environment cannot point it elsewhere.
   */
  const run = (args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args, '--project', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let err = '';
    child.stderr!.on('data', (d) => {
      err += String(d);
    });
    // 'close', not 'exit': stdio may still deliver data after the process exited
    const closed = new Promise<number | null>((resolve) =>
      child.on('close', (code) => resolve(code))
    );
    return { child, closed, stderr: () => err };
  };
  beforeAll(async () => {
    base = fs.mkdtempSync('/tmp/mcproc-ls-'); // short: unix socket paths are capped at 108 bytes
    home = path.join(base, 'home');
    dir = path.join(base, 'p');
    fs.mkdirSync(path.join(dir, '.mcproc'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.mcproc', 'mcproc.yaml'),
      [
        'version: 1',
        'project: itls',
        'apps:',
        '  a:',
        '    description: counts tick lines',
        '    kind: worker',
        `    run: ${JSON.stringify(counter('tick'))}`,
        '  b:',
        '    description: counts tock lines',
        '    kind: worker',
        `    run: ${JSON.stringify(counter('tock'))}`,
        '  c:',
        '    description: says boot c once, then ticks; started only by its test',
        '    kind: worker',
        `    run: ${JSON.stringify(booting)}`,
        'profiles:',
        '  pair: [a, b]',
        'hosts:',
        '  local:',
        `    pm2_home: ${home}`,
        '',
      ].join('\n')
    );
    clearResolutionCache();
    fleet = new Fleet(prepare({ project: dir }).manifest, undefined);
    await actOn(fleet, 'pair', 'start');
    await sleep(1500);
  }, 60_000);
  afterAll(async () => {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    try {
      if (fleet) await (await fleet.ctx('local')).pm2.run(['kill']);
      else if (home) killDaemon(home); // setup failed before a fleet existed: the daemon may still be there
    } catch {
      try {
        if (home) killDaemon(home);
      } catch {
        /* daemon already gone */
      }
    }
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('since 1s: both apps, every line at or after the host cutoff, ordered by stamp, each under its own label', async () => {
    const r = await readSince(f(), ['a', 'b'], { since: parseSince('1s') });
    const cutoff = r.since.local;
    expect(cutoff).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}$/);
    expect(r.errors).toEqual([]);
    expect(r.not_started).toEqual([]);
    expect(new Set(r.lines.map((l) => l.app))).toEqual(new Set(['a', 'b']));
    for (const l of r.lines) {
      expect(l.time! >= cutoff!, `${l.time} < ${cutoff}`).toBe(true);
      expect(l).toMatchObject({ host: 'local', stream: 'out' });
      expect(l.text).toMatch(
        new RegExp(
          `^${l.time!.replace(/\./g, '\\.')}: ${WORD[l.app as 'a' | 'b']} \\d+$`
        )
      );
    }
    for (let i = 1; i < r.lines.length; i++)
      expect(r.lines[i].time! >= r.lines[i - 1].time!).toBe(true);
    // inside the window nothing is lost or repeated: each app's counters run on
    const seen = counters(printed(r.lines));
    for (const app of ['a', 'b'] as const)
      expect(consecutive(seen[app]), `${app}: ${seen[app].join(' ')}`).toBe(
        true
      );
  });

  it('since last: the second call returns only what came after the first, nothing repeated or lost', async () => {
    const marks = new LogMarks();
    const first = await readSince(f(), ['a', 'b'], {
      since: parseSince('last'),
      marks,
    });
    expect(first.lines.length).toBeGreaterThan(0);
    await sleep(600);
    const second = await readSince(f(), ['a', 'b'], {
      since: parseSince('last'),
      marks,
    });
    const seen = new Set(first.lines.map((l) => l.text));
    for (const app of ['a', 'b'] as const) {
      const after = second.lines.filter((l) => l.app === app);
      expect(after.length, app).toBeGreaterThan(0);
      // marks are per file: each app's new lines start past that app's newest stamp of the first call
      const top = newest(first.lines, app);
      for (const l of after)
        expect(l.time! > top, `${l.time} <= ${top}`).toBe(true);
      expect(after.filter((l) => seen.has(l.text))).toEqual([]);
      // the counters run on across the two calls without a gap
      const ns = counters(printed([...first.lines, ...second.lines]))[app];
      expect(consecutive(ns), ns.join(' ')).toBe(true);
    }
  });

  it('CLI logs pair --since 2s prints the labeled lines of both apps and returns', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      out: (s: string) => {
        out.push(s);
      },
      err: (s: string) => {
        err.push(s);
      },
    };
    try {
      await buildProgram(io).parseAsync(
        ['logs', 'pair', '--since', '2s', '--project', dir, '--no-color'],
        { from: 'user' }
      );
      expect(process.exitCode).not.toBe(1);
    } finally {
      process.exitCode = 0;
    }
    expect(err).toEqual([]);
    for (const l of out) expect(l).toMatch(/^[ab] \| /);
    const seen = counters(out);
    expect(seen.a.length).toBeGreaterThanOrEqual(2);
    expect(seen.b.length).toBeGreaterThanOrEqual(2);
  });

  it('CLI -f --since reads the window, then follows from exactly where that read ended: every counter once, in order, and exits 0 on SIGINT', async () => {
    const spawned = Date.now();
    const p = run([
      'logs',
      'pair',
      '--since',
      '1s',
      '-f',
      '--no-color',
      '--interval',
      '200',
    ]);
    let out = '';
    let firstAt: number | null = null;
    p.child.stdout!.on('data', (d) => {
      firstAt ??= Date.now();
      out += String(d);
    });
    // the since read ended before its first line reached us, and its window ends at most ~1 s after the spawn: a line
    // stamped 2.5 s after the spawn and 1 s after that first output can only have come through the follow
    const followed = () => {
      if (firstAt === null) return false;
      const late = stampAt(Math.max(spawned + 2500, firstAt + 1000));
      const got = out.split('\n').map(parse);
      return (['a', 'b'] as const).every((app) =>
        got.some((x) => x?.app === app && x.time >= late)
      );
    };
    const ended = () =>
      p.child.exitCode !== null || p.child.signalCode !== null;
    await until(() => followed() || ended(), 15_000);
    expect(ended(), 'the CLI ended instead of following').toBe(false);
    expect(
      followed(),
      `no line from the follow for both apps within 15 s:\n${out}`
    ).toBe(true);
    // still running here, so the SIGINT reaches the follow's handler, which ends the command
    p.child.kill('SIGINT');
    const code = await Promise.race([
      p.closed,
      sleep(10_000).then(() => 'hung'),
    ]);
    expect(code).toBe(0);
    expect(p.stderr()).toBe('');
    const lines = out.split('\n').filter(Boolean);
    for (const l of lines) expect(l).toMatch(/^[ab] \| /);
    // the since part and the follow part together: no counter twice, none skipped at the seam
    const seen = counters(lines);
    for (const app of ['a', 'b'] as const) {
      expect(seen[app].length, app).toBeGreaterThanOrEqual(5);
      expect(consecutive(seen[app]), `${app}: ${seen[app].join(' ')}`).toBe(
        true
      );
    }
  }, 30_000);

  it('CLI -f --since: an app started while following shows its first lines, read since the cutoff', async () => {
    const p = run([
      'logs',
      'a',
      'c',
      '--since',
      '5s',
      '-f',
      '--no-color',
      '--interval',
      '200',
    ]);
    let out = '';
    p.child.stdout!.on('data', (d) => {
      out += String(d);
    });
    const ended = () =>
      p.child.exitCode !== null || p.child.signalCode !== null;
    // the stream printed its first pass (c not started) and a line of a came through the follow after it
    const following = () => {
      const at = out.indexOf('c | (not started)\n');
      return at >= 0 && /^a \| \S+: tick \d+$/m.test(out.slice(at));
    };
    await until(() => following() || ended(), 15_000);
    expect(ended(), 'the CLI ended instead of following').toBe(false);
    expect(following(), `the follow did not begin within 15 s:\n${out}`).toBe(
      true
    );
    await actOn(f(), 'c', 'start');
    // c is found on a re-probe (every 10 ticks of 200 ms): its boot line is already in its log by then
    const booted = () => /^c \| \S+: boot c$/m.test(out);
    await until(() => booted() || ended(), 15_000);
    expect(booted(), `no boot line of c within 15 s:\n${out}`).toBe(true);
    p.child.kill('SIGINT');
    const code = await Promise.race([
      p.closed,
      sleep(10_000).then(() => 'hung'),
    ]);
    expect(code).toBe(0);
    expect(out.match(/^c \| \S+: boot c$/gm)).toHaveLength(1);
  }, 45_000);

  it('CLI --since to a reader that closes the pipe at once ends quietly with exit 0', async () => {
    const p = run(['logs', 'pair', '--since', '5s']);
    p.child.stdout!.destroy(); // the first write meets a closed pipe
    const code = await Promise.race([
      p.closed,
      sleep(10_000).then(() => 'hung'),
    ]);
    expect(code).toBe(0);
    expect(p.stderr()).not.toMatch(/EPIPE|\n\s+at /);
  }, 20_000);
});

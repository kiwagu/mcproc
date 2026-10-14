import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram, printSince } from '../../src/cli/program.js';
import { parseSince } from '../../src/core/logsince.js';
import { fakeHosts, proc, S } from '../helpers/incidents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const fleet = path.join(here, '..', 'fixtures', 'projects', 'fleet');
const readiness = path.join(here, '..', 'fixtures', 'projects', 'readiness');

function capture() {
  const out: string[] = [],
    err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (s: string) => {
        out.push(s);
      },
      err: (s: string) => {
        err.push(s);
      },
    },
  };
}
afterEach(() => {
  process.exitCode = 0;
});

describe('cli', () => {
  it('hosts --json prints the hosts', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(
      ['hosts', '--project', basic, '--json'],
      { from: 'user' }
    );
    expect(
      JSON.parse(c.out.join('')).map((h: { name: string }) => h.name)
    ).toEqual(['local', 'stand', 'prod']);
  });
  it('describe prints the project summary as text', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(['describe', '--project', basic], {
      from: 'user',
    });
    expect(c.out.join('\n')).toContain('api-build [build]');
  });
  it('errors go to stderr with code and hint, exit code 1', async () => {
    const c = capture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'));
    await buildProgram(c.io).parseAsync(['ls', '--project', dir], {
      from: 'user',
    });
    expect(c.err[0]).toContain('MANIFEST_NOT_FOUND');
    expect(c.err[0]).toContain('Hint:');
    expect(process.exitCode).toBe(1);
  });
  it('init creates a draft and start refuses readonly hosts before connecting', async () => {
    const c = capture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node s.js' } })
    );
    await buildProgram(c.io).parseAsync(['init', '--project', dir], {
      from: 'user',
    });
    expect(fs.existsSync(path.join(dir, '.mcproc', 'mcproc.yaml'))).toBe(true);
    const c2 = capture();
    await buildProgram(c2.io).parseAsync(
      ['start', 'api', '--project', basic, '--host', 'prod'],
      { from: 'user' }
    );
    expect(c2.err[0]).toContain('READONLY_HOST');
  });
  it('lists every command in --help', () => {
    const help = buildProgram(capture().io).helpInformation();
    for (const cmd of [
      'init',
      'hosts',
      'doctor',
      'ls',
      'describe',
      'logs',
      'ports',
      'start',
      'restart',
      'stop',
      'delete',
      'flush',
      'incidents',
      'wait',
      'monit',
      'unpack',
      'install',
      'mcp',
    ])
      expect(help).toContain(cmd);
  });
  it('unpack refuses readonly hosts and a bad --with-node before touching any host', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(
      ['unpack', '--project', basic, '--host', 'prod'],
      { from: 'user' }
    );
    expect(c.err[0]).toContain('READONLY_HOST');
    const c2 = capture();
    await buildProgram(c2.io).parseAsync(
      ['unpack', '--project', basic, '--with-node', 'sometimes'],
      { from: 'user' }
    );
    expect(c2.err[0]).toContain('BAD_ARGUMENT');
  });
  it('logs resolves apps and profiles before connecting: an unknown target is refused without touching a host', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(['logs', 'nope', '--project', basic], {
      from: 'user',
    });
    expect(c.err[0]).toContain('UNKNOWN_APP');
    const c2 = capture();
    await buildProgram(c2.io).parseAsync(
      ['logs', 'api', '--project', basic, '--host', 'stand', '--lines', '0'],
      { from: 'user' }
    );
    expect(c2.err[0]).toMatch(/TRANSPORT_FAILED|PM2_NOT_FOUND/); // a real target reaches the (unreachable) host: the command shape is accepted
  });
  it('logs --since refuses a bad time, last, and -n together, before contacting a host', async () => {
    for (const [argv, needle] of [
      [
        ['logs', '--since', 'yesterday', '--project', basic],
        'since is a span like',
      ],
      [['logs', '--since', 'last', '--project', basic], 'MCP session'],
      [['logs', '-n', '5', '--since', '2m', '--project', basic], '-n'],
    ] as const) {
      const c = capture();
      try {
        await buildProgram(c.io).parseAsync(argv, { from: 'user' });
        expect(c.err[0]).toContain('BAD_ARGUMENT');
        expect(c.err.join('\n')).toContain(needle);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = 0;
      }
    }
  });
  it('monit --once reports MANIFEST_NOT_FOUND cleanly outside a project', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(
      [
        'monit',
        '--once',
        '--project',
        fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-')),
      ],
      { from: 'user' }
    );
    expect(c.err[0]).toContain('MANIFEST_NOT_FOUND');
  });
  it('host-bound apps: hosts and describe show where each app runs, without touching a host', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(
      ['hosts', '--project', fleet, '--json'],
      { from: 'user' }
    );
    expect(
      JSON.parse(c.out.join('')).map(
        (h: { name: string; apps: string[] }) => `${h.name}:${h.apps.join(',')}`
      )
    ).toEqual(['local:watch', 'box:web', 'ro:audit']);
    const c2 = capture();
    await buildProgram(c2.io).parseAsync(['describe', '--project', fleet], {
      from: 'user',
    });
    expect(c2.out.join('\n')).toContain('web [server] on box');
  });
  it("host-bound apps: --host naming another host than the app's, or a readonly host in the way, is refused before connecting", async () => {
    for (const argv of [
      ['ls', 'web', '--host', 'local'],
      ['logs', 'watch', '--host', 'box'],
      ['describe', 'watch', '--host', 'box'],
      ['restart', 'web', '--host', 'local'],
      ['flush', 'web', '--host', 'local'],
    ]) {
      const c = capture();
      await buildProgram(c.io).parseAsync([...argv, '--project', fleet], {
        from: 'user',
      });
      expect(c.err[0], argv.join(' ')).toContain('WRONG_HOST');
    }
    const cp = capture();
    await buildProgram(cp.io).parseAsync(
      ['describe', 'dev', '--project', fleet],
      { from: 'user' }
    );
    expect(cp.err[0]).toContain('UNKNOWN_APP'); // a profile is not an app: refused, never a stack trace
    const c = capture();
    await buildProgram(c.io).parseAsync(['stop', 'all', '--project', fleet], {
      from: 'user',
    });
    expect(c.err[0]).toContain('READONLY_HOST');
    expect(c.err[0]).toContain('"audit"');
    const c2 = capture();
    await buildProgram(c2.io).parseAsync(['flush', '--project', fleet], {
      from: 'user',
    });
    expect(c2.err[0]).toContain('READONLY_HOST');
  });
  it('incidents: unknown targets, a target on another host and a bad --context are refused before any host is touched', async () => {
    for (const [argv, code] of [
      [['incidents', 'nope', '--project', fleet], 'UNKNOWN_APP'],
      [
        ['incidents', 'watch', '--host', 'box', '--project', fleet],
        'WRONG_HOST',
      ],
      [['incidents', '--context', 'x', '--project', fleet], 'BAD_ARGUMENT'],
    ] as const) {
      const c = capture();
      await buildProgram(c.io).parseAsync([...argv], { from: 'user' });
      expect(c.err[0], argv.join(' ')).toContain(code);
    }
  });
  it('wait: a bad --until, an unknown app and an app bound elsewhere are refused before any host is touched', async () => {
    for (const [argv, code] of [
      [
        ['wait', 'libs', '--until', 'nope', '--project', readiness],
        'BAD_ARGUMENT',
      ],
      [
        ['wait', 'libs', '--until', 'log:(', '--project', readiness],
        'BAD_ARGUMENT',
      ],
      [
        ['wait', 'nope', '--until', 'exited', '--project', readiness],
        'UNKNOWN_APP',
      ],
      [
        [
          'wait',
          'web',
          '--until',
          'exited',
          '--host',
          'local',
          '--project',
          fleet,
        ],
        'WRONG_HOST',
      ],
    ] as const) {
      const c = capture();
      process.exitCode = 0;
      await buildProgram(c.io).parseAsync([...argv], { from: 'user' });
      expect(c.err[0], argv.join(' ')).toContain(code);
      expect(process.exitCode, argv.join(' ')).toBe(1);
    }
  });
  it('wait needs --until and takes -t', () => {
    const cmd = buildProgram(capture().io).commands.find(
      (c) => c.name() === 'wait'
    )!;
    expect(cmd.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--until', '--timeout'])
    );
    expect(cmd.options.find((o) => o.long === '--until')!.mandatory).toBe(true);
  });
  it('incidents takes by default; --peek looks without taking, -f keeps watching', () => {
    const cmd = buildProgram(capture().io).commands.find(
      (c) => c.name() === 'incidents'
    )!;
    expect(cmd.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--peek',
        '--follow',
        '--interval',
        '--since',
        '--max',
        '--context',
      ])
    );
  });
});

describe('printSince (logs --since, one shot)', () => {
  const state = () => ({
    now: '2026-10-12T11:00:40',
    procs: { local: [proc('watch', 0)], box: [proc('web', 2)] },
    files: {
      '/l/watch-out': `${S(5)}old\n${S(35)}change\n`,
      '/l/watch-err': '',
      '/l/web-out': `${S(38)}listening\n`,
      '/l/web-err': '',
    },
  });
  it('prints the merged lines with the labels and colors of the follow, notes on stderr, and returns where each app follows from', async () => {
    const st = state();
    const { fleet } = fakeHosts(st);
    const c = capture();
    const at = await printSince(
      fleet,
      ['watch', 'web', 'tool'],
      parseSince('10s'),
      { stream: 'both', color: true, json: false },
      c.io
    );
    // colors by host-group order (local: watch, tool; box: web), as the follow assigns them
    expect(c.out).toEqual([
      `\x1b[36mwatch\x1b[0m | ${S(35)}change`,
      `\x1b[33mweb  \x1b[0m | ${S(38)}listening`,
    ]);
    expect(c.err).toEqual(['not started: tool']);
    // each mark is the end of what was read: the follow continues right after it
    for (const app of ['watch', 'web'] as const)
      expect(at?.[app]?.out).toMatchObject({
        path: `/l/${app}-out`,
        offset: Buffer.byteLength(st.files[`/l/${app}-out`]),
      });
    // not started at the read: no mark, so its follow reads its first history since its host's cutoff
    expect(at?.tool).toEqual({ cutoff: '2026-10-12T11:00:30.000' });
    expect(at?.watch?.cutoff).toBe('2026-10-12T11:00:30.000');
    expect(process.exitCode).not.toBe(1);
  });
  it("each app gets its own host's cutoff; an app on a host that was not read gets neither marks nor a cutoff", async () => {
    const st: Parameters<typeof fakeHosts>[0] = state();
    st.clocks = { box: { now: '2026-10-12T11:00:50' } };
    const read = await printSince(
      fakeHosts(st).fleet,
      ['watch', 'web', 'tool'],
      parseSince('10s'),
      { stream: 'both', color: false, json: false },
      capture().io
    );
    expect(read?.tool).toEqual({ cutoff: '2026-10-12T11:00:30.000' });
    expect(read?.web?.cutoff).toBe('2026-10-12T11:00:40.000');
    const down = await printSince(
      fakeHosts(state(), ['box']).fleet,
      ['watch', 'web', 'tool'],
      parseSince('10s'),
      { stream: 'both', color: false, json: false },
      capture().io
    );
    process.exitCode = 0;
    expect(down?.web).toEqual({});
    expect(down?.tool).toEqual({ cutoff: '2026-10-12T11:00:30.000' });
  });
  it("a host that was not read: the other host's lines are printed, the note goes to stderr, and the exit code is 1", async () => {
    const { fleet } = fakeHosts(state(), ['box']);
    const c = capture();
    try {
      await printSince(
        fleet,
        ['watch', 'web'],
        parseSince('10s'),
        { stream: 'both', color: false, json: false },
        c.io
      );
      expect(c.out).toEqual([`watch | ${S(35)}change`]);
      expect(c.err).toEqual([
        'box not read (web): TRANSPORT_FAILED: ssh box: Connection refused',
      ]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
    }
  });
  it('a reader that went away (EPIPE on stdout, or the stream aborted) stops the print quietly and gives nothing to follow', async () => {
    const { fleet } = fakeHosts(state());
    const err: string[] = [];
    let writes = 0;
    const io = {
      out: () => {
        writes++;
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      },
      err: (s: string) => {
        err.push(s);
      },
    };
    const how = { stream: 'both', color: false, json: false } as const;
    const apps = ['watch', 'web', 'tool'];
    expect(
      await printSince(fleet, apps, parseSince('10s'), how, io)
    ).toBeNull();
    expect(writes).toBe(1);
    expect(err).toEqual(['not started: tool']); // stderr still says what it has to
    const ac = new AbortController();
    ac.abort();
    const c = capture();
    expect(
      await printSince(fleet, apps, parseSince('10s'), how, c.io, ac.signal)
    ).toBeNull();
    expect(c.out).toEqual([]);
  });
});

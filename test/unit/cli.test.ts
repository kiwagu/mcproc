import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram, printLs, printSince } from '../../src/cli/program.js';
import { parseSince } from '../../src/core/logsince.js';
import { Fleet } from '../../src/core/fleet.js';
import { fakeHosts, proc, S } from '../helpers/incidents.js';
import { LeaseStore } from '../../src/core/leases/store.js';

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
  it('registers leases with cancel; start takes --note and a hidden --lease', () => {
    const p = buildProgram(capture().io);
    const leases = p.commands.find((x) => x.name() === 'leases')!;
    expect(leases).toBeDefined();
    expect(leases.commands.map((x) => x.name())).toEqual(['cancel']);
    const start = p.commands.find((x) => x.name() === 'start')!;
    const help = start.helpInformation();
    expect(help).toContain('--note <text>');
    expect(help).not.toContain('--lease');
    expect(start.options.map((o) => o.long)).toContain('--lease');
  });
  it('registers the lease watcher as a hidden watch-leases', () => {
    const p = buildProgram(capture().io);
    const w = p.commands.find((x) => x.name() === 'watch-leases');
    expect(w).toBeDefined();
    expect(p.helpInformation()).not.toContain('watch-leases');
  });
  it('leases prints the queue without a manifest; leases cancel cancels a pending lease and refuses it the second time', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-state-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'));
    vi.stubEnv('MCPROC_STATE_DIR', state);
    try {
      const l = await new LeaseStore(state).create(
        {
          kind: 'start',
          project: 'demo',
          root: '/w/demo',
          slot: 0,
          repo: '/w/demo',
          target: 'dev',
          apps: ['db'],
          reload: false,
          estimate_mib: 512,
          need_mib: 615,
          margin: 0.2,
          reserve_mib: 1024,
          sources: {},
          note: null,
          requester_pid: 1,
        },
        'pending'
      );
      const c = capture();
      await buildProgram(c.io).parseAsync(['leases', '--project', dir], {
        from: 'user',
      });
      expect(c.err).toEqual([]);
      expect(c.out.join('\n')).toContain(`state: ${state}`);
      expect(c.out.join('\n')).toContain(l.id);
      const j = capture();
      await buildProgram(j.io).parseAsync(
        ['leases', '--project', dir, '--json'],
        { from: 'user' }
      );
      expect(JSON.parse(j.out.join(''))).toMatchObject({
        leases: [{ id: l.id, position: 1 }],
      });
      const x = capture();
      await buildProgram(x.io).parseAsync(['leases', 'cancel', l.id], {
        from: 'user',
      });
      expect(x.out).toEqual([`cancelled ${l.id} (demo dev)`]);
      const y = capture();
      await buildProgram(y.io).parseAsync(['leases', 'cancel', l.id], {
        from: 'user',
      });
      expect(y.err[0]).toContain('LEASE_NOT_PENDING');
      expect(process.exitCode).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(state, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('init --adopt-ports needs a manifest, and refuses a readonly local host before connecting, force or not', async () => {
    const init = buildProgram(capture().io).commands.find(
      (x) => x.name() === 'init'
    )!;
    // commander wraps the help text at the terminal's width
    expect(init.helpInformation().replace(/\s+/g, ' ')).toContain(
      '--adopt-ports write the ports ls reports as undeclared for the running apps into the existing manifest (comments kept) and print the diff; needs that manifest, drafts nothing and ignores --force'
    );
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'));
    try {
      const c = capture();
      await buildProgram(c.io).parseAsync(
        ['init', '--adopt-ports', '--project', empty],
        { from: 'user' }
      );
      expect(c.err[0]).toContain('MANIFEST_NOT_FOUND');
      expect(process.exitCode).toBe(1);
      expect(fs.existsSync(path.join(empty, '.mcproc'))).toBe(false); // nothing drafted
      process.exitCode = 0;
      // the fleet's other hosts are ssh aliases: a connection attempt would fail with another error
      fs.cpSync(fleet, dir, { recursive: true });
      const file = path.join(dir, '.mcproc', 'mcproc.yaml');
      const text = fs
        .readFileSync(file, 'utf8')
        .replace('hosts:\n', 'hosts:\n  local: { readonly: true }\n');
      fs.writeFileSync(file, text);
      const c2 = capture();
      await buildProgram(c2.io).parseAsync(
        ['init', '--adopt-ports', '--force', '--project', dir],
        { from: 'user' }
      );
      expect(c2.err[0]).toContain('READONLY_HOST');
      expect(c2.err[0]).toContain('its ports are not adopted');
      expect(process.exitCode).toBe(1);
      expect(fs.readFileSync(file, 'utf8')).toBe(text);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      'exec',
      'worktree',
    ])
      expect(help).toContain(cmd);
  });
  it('registers worktree with add, ls and remove and their options; the slug is no global --project', () => {
    const p = buildProgram(capture().io);
    const wt = p.commands.find((x) => x.name() === 'worktree')!;
    expect(wt.commands.map((x) => x.name())).toEqual(['add', 'ls', 'remove']);
    const opts = (n: string) =>
      wt.commands.find((x) => x.name() === n)!.options.map((o) => o.long);
    expect(opts('add')).toEqual(['--from', '--slot', '--slug', '--no-install']);
    expect(opts('remove')).toEqual(['--force']);
    expect(
      wt.commands
        .find((x) => x.name() === 'add')!
        .options.find((o) => o.long === '--slug')!.description
    ).toBe(
      'the project slug this checkout runs under (default: <project>-w<slot>)'
    );
  });
  it('worktree add --json keeps stdout to its JSON: the install prints to stderr', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wt-json-'));
    const main = path.join(base, 'wtj');
    const git = (args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd: main, stdio: 'pipe' }
      );
    try {
      fs.mkdirSync(path.join(main, '.mcproc'), { recursive: true });
      // an explicit pm2 binary: connecting runs no probe; a plain sh runs the install
      fs.writeFileSync(
        path.join(main, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: wtj',
          'hosts:',
          '  local: { pm2: /bin/false, shell: "/bin/sh -c" }',
          'worktree:',
          '  install: "echo install-out; echo install-err >&2"',
          'apps:',
          '  db: { description: db, run: node db.js }',
          '',
        ].join('\n')
      );
      git(['init', '-q', '-b', 'main']);
      git(['add', '-A']);
      git(['commit', '-qm', 'init']);
      // the real CLI in a child: an install that inherited stdout would write ahead of the JSON
      const r = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          path.join(here, '..', '..', 'src', 'cli.ts'),
          'worktree',
          'add',
          'j',
          '--project',
          main,
          '--json',
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 }
      );
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        branch: 'j',
        slot: 1,
        installed: 'echo install-out; echo install-err >&2',
      });
      expect(r.stderr).toContain('install-out');
      expect(r.stderr).toContain('install-err');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it('worktree refuses another host before touching it', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(
      ['worktree', 'ls', '--project', basic, '--host', 'stand'],
      { from: 'user' }
    );
    expect(c.err[0]).toMatch(
      /^BAD_ARGUMENT: worktree runs on the local host only/
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
  it('worktree add makes the checkout with --slot, --slug and --no-install; remove refuses slot 0 and an unknown ref', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wt-cli-'));
    const main = path.join(base, 'wtc');
    const git = (args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd: main, stdio: 'pipe' }
      );
    try {
      fs.mkdirSync(path.join(main, '.mcproc'), { recursive: true });
      // an explicit pm2 binary: connecting runs no probe on this machine
      fs.writeFileSync(
        path.join(main, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: wtc',
          'hosts:',
          '  local: { pm2: /bin/false }',
          'apps:',
          '  db: { description: db, run: node db.js }',
          '',
        ].join('\n')
      );
      fs.writeFileSync(path.join(main, 'package-lock.json'), '{}');
      git(['init', '-q', '-b', 'main']);
      git(['add', '-A']);
      git(['commit', '-qm', 'init']);
      const real = fs.realpathSync(main);
      const c = capture();
      await buildProgram(c.io).parseAsync(
        [
          'worktree',
          'add',
          'feat/y',
          '--slot',
          '3',
          '--slug',
          'wtc-three',
          '--no-install',
          '--project',
          main,
          '--json',
        ],
        { from: 'user' }
      );
      expect(c.err).toEqual([]);
      const r = JSON.parse(c.out[0]);
      expect(r).toMatchObject({
        path: path.join(`${real}.worktrees`, 'feat', 'y'),
        slot: 3,
        project: 'wtc-three',
        installed: null,
        next: `cd ${path.join(`${real}.worktrees`, 'feat', 'y')} && mcproc start db`,
      });
      for (const [ref, code] of [
        ['0', 'BAD_ARGUMENT'],
        ['nope', 'NOT_A_WORKTREE'],
      ]) {
        const e = capture();
        await buildProgram(e.io).parseAsync(
          ['worktree', 'remove', ref, '--force', '--project', main],
          { from: 'user' }
        );
        expect(e.err[0]).toMatch(new RegExp(`^${code}: `));
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it('exec refuses a bad --memory or --timeout and another host before touching any host', async () => {
    for (const argv of [
      ['exec', '--memory', '4X', '--project', basic, '--', 'echo', 'hi'],
      ['exec', '--timeout', 'soon', '--project', basic, '--', 'echo', 'hi'],
      ['exec', '--project', basic, '--host', 'stand', '--', 'echo', 'hi'],
    ]) {
      const c = capture();
      await buildProgram(c.io).parseAsync(argv, { from: 'user' });
      expect(c.err[0], argv.join(' ')).toMatch(/^BAD_ARGUMENT/);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
    }
  });
  it('exec takes its options before -- and the command after it verbatim, runs it from the root with exec.env and exits with its code', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-exec-'));
    try {
      fs.mkdirSync(path.join(dir, '.mcproc'));
      // an explicit pm2 binary: connecting runs no probe on this machine
      fs.writeFileSync(
        path.join(dir, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: exec-cli',
          'hosts:',
          '  local: { pm2: /bin/false }',
          'exec:',
          '  env: { GREETING: hi }',
          'apps:',
          '  tool: { description: a one-shot, kind: task, run: echo done }',
          '',
        ].join('\n')
      );
      const check = path.join(dir, 'check.js');
      fs.writeFileSync(
        check,
        [
          'const [root, ...rest] = process.argv.slice(2);',
          'const ok =',
          '  process.env.GREETING === "hi" &&',
          '  process.env.MCPROC_PROJECT === root &&',
          '  process.cwd() === require("node:fs").realpathSync(root) &&',
          '  JSON.stringify(rest) === JSON.stringify(["--timeout", "5", "--json", "--memory", "1G", "--help"]);',
          'process.exit(ok ? 3 : 4);',
          '',
        ].join('\n')
      );
      const c = capture();
      await buildProgram(c.io).parseAsync(
        [
          'exec',
          '--project',
          dir,
          '--json',
          '--',
          process.execPath,
          check,
          dir,
          '--timeout',
          '5',
          '--json',
          '--memory',
          '1G',
          '--help',
        ],
        { from: 'user' }
      );
      expect(c.err).toEqual([]);
      expect(JSON.parse(c.out.join(''))).toMatchObject({
        code: 3,
        lease: null,
        waited_ms: expect.any(Number),
      });
      expect(process.exitCode).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('exec ends its command on SIGINT, SIGTERM or SIGHUP, every time it gets one, and drops its handlers after', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-exec-'));
    try {
      fs.mkdirSync(path.join(dir, '.mcproc'));
      // an explicit pm2 binary: connecting runs no probe on this machine
      fs.writeFileSync(
        path.join(dir, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: exec-cli',
          'hosts:',
          '  local: { pm2: /bin/false }',
          'apps:',
          '  tool: { description: a one-shot, kind: task, run: echo done }',
          '',
        ].join('\n')
      );
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        const before = process.rawListeners(sig);
        const c = capture();
        const run = buildProgram(c.io).parseAsync(
          [
            'exec',
            '--project',
            dir,
            '--json',
            '--',
            process.execPath,
            '-e',
            'setInterval(() => {}, 1000)',
          ],
          { from: 'user' }
        );
        let mine = process.rawListeners(sig).filter((f) => !before.includes(f));
        while (mine.length === 0) {
          await new Promise((r) => setTimeout(r, 10));
          mine = process.rawListeners(sig).filter((f) => !before.includes(f));
        }
        // the exec's own handler only, called the way the signal would: never the test runner's
        for (const f of mine) f(sig);
        // still there after the first one: a second signal is handled too, never Node's default exit
        expect(
          process.rawListeners(sig).filter((f) => !before.includes(f)),
          sig
        ).toHaveLength(1);
        for (const f of mine) f(sig);
        await run;
        expect(JSON.parse(c.out.join('')), sig).toMatchObject({
          code: 128,
          lease: null,
        });
        expect(process.rawListeners(sig), sig).toEqual(before);
        process.exitCode = 0;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
  it('incidents --reloads adds the reloads of each app since the last call', () => {
    const cmd = buildProgram(capture().io).commands.find(
      (c) => c.name() === 'incidents'
    )!;
    const opt = cmd.options.find((o) => o.long === '--reloads');
    expect(opt?.description).toMatch(/reload/);
    expect(opt?.required || opt?.optional).toBeFalsy(); // a switch, no value
  });
});

describe('printLs (ls)', () => {
  const state = () => ({
    files: {
      '/l/web-out': `${S(1)}listening on :3000\n${S(20)}listening on :3000\n`,
    },
    procs: {
      local: [proc('watch', 0)],
      box: [proc('web', 2, { pm_uptime: Date.parse('2026-10-12T11:00:00Z') })],
    },
  });
  it('the ls command takes --reloads as a switch', () => {
    const cmd = buildProgram(capture().io).commands.find(
      (c) => c.name() === 'ls'
    )!;
    const opt = cmd.options.find((o) => o.long === '--reloads');
    expect(opt?.description).toMatch(/reload/);
    expect(opt?.required || opt?.optional).toBeFalsy();
  });
  it('--reloads prints the reloads in the RESTARTS cell and the JSON rows carry them; without it no log is read', async () => {
    const h = fakeHosts(state());
    const c = capture();
    await printLs(
      h.fleet,
      h.fleet.select(['all']),
      { reloads: true, json: false },
      c.io
    );
    expect(c.out.join('\n')).toMatch(
      /web\s+box\s+server\s+online\s+102\s+\S+\s+0 \(\+1\)\s/
    );
    expect(h.reads).toEqual(['box']);
    expect(process.exitCode).not.toBe(1);
    const j = capture();
    await printLs(
      fakeHosts(state()).fleet,
      ['web'],
      { reloads: true, json: true },
      j.io
    );
    expect(JSON.parse(j.out.join(''))[0].reloads).toEqual({
      count: 1,
      last: '2026-10-12T11:00:20',
      partial: false,
    });
    const plain = fakeHosts(state());
    const p = capture();
    await printLs(
      plain.fleet,
      plain.fleet.select(['all']),
      { reloads: false, json: false },
      p.io
    );
    expect(plain.reads).toEqual([]);
    expect(p.out.join('\n')).toMatch(/web\s+box\s+server\s+online\s+102\s/);
    expect(p.out.join('\n')).not.toContain('(+');
  });
  it('a host whose logs could not be read: the other rows are counted, a line names the host, and the exit code is 1', async () => {
    const h = fakeHosts({
      ...state(),
      failReads: ['box'],
      files: {
        '/l/watch-out': `${S(1)}Starting compilation in watch mode...\n${S(12)}File change detected. Starting incremental compilation...\n`,
      },
      procs: {
        local: [
          proc('watch', 0, { pm_uptime: Date.parse('2026-10-12T11:00:00Z') }),
        ],
        box: state().procs.box,
      },
    });
    const c = capture();
    await printLs(
      h.fleet,
      h.fleet.select(['all']),
      { reloads: true, json: false },
      c.io
    );
    const out = c.out.join('\n');
    expect(out).toMatch(
      /watch\s+local\s+build\s+online\s+100\s+\S+\s+0 \(\+1\)\s/
    );
    expect(out.split('\n').at(-1)).toMatch(
      /^box: reloads not counted: TRANSPORT_FAILED/
    );
    expect(process.exitCode).toBe(1);
  });
  it('a url the box cannot reach answers from this machine: the cell says (here), the JSON says why', async () => {
    const st = {
      ...state(),
      urls: { box: 'http://localhost:3000/\t000\t7\t::1' },
      here: {
        'http://localhost:3000/': { answered: true as const, code: 200 },
      },
    };
    const c = capture();
    await printLs(
      fakeHosts(st).fleet,
      ['web'],
      { reloads: false, json: false },
      c.io
    );
    expect(c.out.join('\n')).toContain('http://localhost:3000/ ✓ 200 (here)');
    const j = capture();
    await printLs(
      fakeHosts(st).fleet,
      ['web'],
      { reloads: false, json: true },
      j.io
    );
    expect(JSON.parse(j.out.join(''))[0]).toMatchObject({
      url_from: 'here',
      url_reason: 'on box: refused',
    });
  });
});

describe('describe <app>', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('says where the url answered and why, under the table', async () => {
    const h = fakeHosts({
      files: {},
      procs: { local: [proc('watch', 0)], box: [proc('web', 2)] },
      urls: { box: 'http://localhost:3000/\t000\t7\t::1' },
      here: { 'http://localhost:3000/': { answered: true, code: 200 } },
    });
    // the command builds its own fleet: its hosts are answered by the fake ones
    const real = Fleet.prototype.ctx;
    vi.spyOn(Fleet.prototype, 'ctx').mockImplementation((host: string) =>
      real.call(h.fleet, host)
    );
    const c = capture();
    await buildProgram(c.io).parseAsync(
      ['describe', 'web', '--project', fleet],
      { from: 'user' }
    );
    expect(c.err).toEqual([]);
    const out = c.out.join('\n');
    expect(out).toContain('http://localhost:3000/ ✓ 200 (here)');
    expect(out).toContain('url: answered from this machine (on box: refused)');
    expect(out.split('\n').at(-1)).toMatch(/^logs: /);
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

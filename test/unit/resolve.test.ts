import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveProjectDir,
  prepare,
  assertWritable,
  assertApp,
  connect,
  clearResolutionCache,
  bareLocalHost,
  daemonFor,
  procFor,
} from '../../src/core/resolve.js';
import { listDaemon } from '../../src/core/pm2socket.js';
import { localProc, ProcReader } from '../../src/core/procfs.js';
import { procWorld } from '../helpers/procfs.js';
import type { Pm2Resolution } from '../../src/core/pm2.js';
import type { Spawner } from '../../src/transport/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

describe('resolveProjectDir', () => {
  it('follows param → MCPROC_PROJECT → CLAUDE_PROJECT_DIR → roots → cwd', () => {
    expect(
      resolveProjectDir('/a', ['/r'], {
        MCPROC_PROJECT: '/m',
        CLAUDE_PROJECT_DIR: '/c',
      })
    ).toBe('/a');
    expect(
      resolveProjectDir(undefined, ['/r'], {
        MCPROC_PROJECT: '/m',
        CLAUDE_PROJECT_DIR: '/c',
      })
    ).toBe('/m');
    expect(
      resolveProjectDir(undefined, ['/r'], { CLAUDE_PROJECT_DIR: '/c' })
    ).toBe('/c');
    expect(resolveProjectDir(undefined, ['/r'], {})).toBe('/r');
    expect(resolveProjectDir(undefined, [], {})).toBe(process.cwd());
  });
});

describe('prepare', () => {
  it('loads the manifest and defaults to the local host', () => {
    const p = prepare({ project: basic });
    expect(p.manifest.project).toBe('demo');
    expect(p.host.name).toBe('local');
    expect(prepare({ project: basic, host: 'stand' }).host.ssh).toBe('stand');
  });
  it('rejects unknown hosts with the list of known ones', () => {
    expect(() => prepare({ project: basic, host: 'nope' })).toThrowError(
      /UNKNOWN_HOST|nope/
    );
    try {
      prepare({ project: basic, host: 'nope' });
    } catch (e: any) {
      expect(e.code).toBe('UNKNOWN_HOST');
      expect(e.hint).toContain('stand');
    }
  });
  it('refuses a pm2_home longer than 90 characters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-'));
    fs.mkdirSync(path.join(dir, '.mcproc'));
    fs.writeFileSync(
      path.join(dir, '.mcproc', 'mcproc.yaml'),
      `version: 1\napps:\n  a: { description: d, run: r }\nhosts:\n  h: { ssh: h, cwd: /x, pm2_home: /${'x'.repeat(95)} }\n`
    );
    expect(() => prepare({ project: dir, host: 'h' })).toThrowError(
      /PM2_HOME_TOO_LONG|108/
    );
  });
  it('assertWritable and assertApp', () => {
    const p = prepare({ project: basic, host: 'prod' });
    expect(() => assertWritable(p.host)).toThrowError(/readonly/);
    expect(() => assertApp(p.manifest, 'zzz')).toThrowError(/zzz/);
    try {
      assertApp(p.manifest, 'zzz');
    } catch (e: any) {
      expect(e.code).toBe('UNKNOWN_APP');
      expect(e.hint).toContain('api-build');
    }
    expect(() => assertApp(p.manifest, 'api')).not.toThrow();
  });
});

describe('connect', () => {
  beforeEach(() => clearResolutionCache());
  it('resolves pm2 once per project+host and caches it', async () => {
    let calls = 0;
    // counts the resolution probe only: a read also reads the host's login environment first
    const spawner: Spawner = async (argv) => {
      if (argv.some((a) => a.includes('PATH_OK'))) calls++;
      return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
    };
    const ctx = await connect(prepare({ project: basic, host: 'stand' }), {
      spawner,
    });
    expect(ctx.resolution).toMatchObject({ source: 'path', bin: 'pm2' });
    expect(ctx.pm2.bin).toBe('pm2');
    expect(ctx.transport.describe()).toBe('ssh stand');
    await connect(prepare({ project: basic, host: 'stand' }), { spawner });
    expect(calls).toBe(1);
    await connect(prepare({ project: basic, host: 'stand' }), {
      spawner,
      fresh: true,
    });
    expect(calls).toBe(2);
  });
  it('a daemon override stands in for how the list is read; without one an injected spawner keeps the CLI', async () => {
    const spawner: Spawner = async () => ({
      code: 0,
      stdout: 'PATH_OK\n7.0.4\nv22.0.0\n',
      stderr: '',
    });
    const prep = prepare({ project: basic });
    expect((await connect(prep, { spawner })).pm2.listsOverSocket()).toBe(
      false
    );
    const over = await connect(prep, { spawner, daemon: async () => [] });
    expect(over.pm2.listsOverSocket()).toBe(true);
  });
});

describe('daemonFor', () => {
  const res = (source: Pm2Resolution['source']): Pm2Resolution => ({
    bin: 'pm2',
    source,
    node: null,
    pm2Version: null,
    reason: 'test',
  });
  const mine = bareLocalHost();
  const other = { ...mine, name: 'stand', local: false, ssh: 'stand' };
  it('this machine reads its daemon over the socket, unless a wrapper stands in for pm2 or a test fakes the world', () => {
    for (const s of ['path', 'bundled', 'runtime'] as const)
      expect(daemonFor(mine, res(s))).toBe(listDaemon);
    expect(daemonFor(mine, res('explicit'))).toBeNull();
    expect(daemonFor(other, res('path'))).toBeNull();
    expect(
      daemonFor(mine, res('path'), async () => ({
        code: 0,
        stdout: '',
        stderr: '',
      }))
    ).toBeNull();
  });
});

describe('procFor', () => {
  it('this machine is read in-process where it has /proc, unless a test fakes the world; another host never', () => {
    const mine = bareLocalHost();
    const other = { ...mine, name: 'stand', local: false, ssh: 'stand' };
    expect(procFor(mine)).toBe(localProc());
    expect(
      procFor(mine, async () => ({ code: 0, stdout: '', stderr: '' }))
    ).toBeNull();
    expect(procFor(other)).toBeNull();
  });
  it('connect: an injected spawner reads with the script; a proc override stands in', async () => {
    clearResolutionCache();
    const spawner: Spawner = async () => ({
      code: 0,
      stdout: 'PATH_OK\n7.0.4\nv22.0.0\n',
      stderr: '',
    });
    const prep = prepare({ project: basic });
    expect((await connect(prep, { spawner })).proc).toBeNull();
    const r = new ProcReader(procWorld({ procs: [] }));
    expect((await connect(prep, { spawner, proc: r })).proc).toBe(r);
  });
});

describe('bareLocalHost', () => {
  it('bareLocalHost is the local host a manifest without hosts.local declares', () => {
    expect(bareLocalHost()).toMatchObject({
      name: 'local',
      local: true,
      readonly: false,
      shell: { bin: '/bin/bash', flags: ['-lc'] },
      env: {},
    });
    expect(bareLocalHost().pm2_home).toBeUndefined();
  });
});

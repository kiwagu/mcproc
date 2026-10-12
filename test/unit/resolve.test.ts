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
} from '../../src/core/resolve.js';
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
    const spawner: Spawner = async () => {
      calls++;
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
});

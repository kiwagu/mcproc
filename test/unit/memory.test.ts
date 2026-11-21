import { describe, it, expect } from 'vitest';
import {
  memoryFrom,
  parseMeminfo,
  parseDockerStats,
  readHostMemory,
  readHostMemoryOrWhy,
} from '../../src/core/memory.js';
import {
  dockerMemSnippet,
  MARK,
  MEM_READ_SNIPPET,
  MEM_SNIPPET,
  MEM_STATUS,
} from '../../src/shell/snippets.js';
import { FakeTransport } from '../helpers/fake-transport.js';
import { prepare } from '../../src/core/resolve.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

describe('parseMeminfo', () => {
  it('reads MemTotal and MemAvailable in kB into MiB', () => {
    expect(
      parseMeminfo('MemTotal:       32600000 kB\nMemAvailable:   17500000 kB\n')
    ).toEqual({ total_mib: 31835, available_mib: 17089 });
  });
  it('is null without both lines', () => {
    expect(parseMeminfo('')).toBeNull();
    expect(parseMeminfo('MemTotal: 1 kB')).toBeNull();
  });
});

describe('parseDockerStats', () => {
  it('maps each container to its usage in MiB, rounded up, whatever the unit', () => {
    const m = parseDockerStats(
      'demo-db\t27.06MiB / 31.09GiB\ndemo-caddy\t1.2GiB / 31.09GiB\nsmall\t512kB / 31.09GiB\nzero\t0B / 31.09GiB\njunk line\n'
    );
    expect([...m]).toEqual([
      ['demo-db', 28],
      ['demo-caddy', 1229],
      ['small', 1],
      ['zero', 0],
    ]);
  });
});

describe('dockerMemSnippet', () => {
  it('asks docker stats only for the declared names that are running', () => {
    const s = dockerMemSnippet(['demo-db', "it's"]);
    expect(s).toContain(MARK.DOCKERMEM);
    expect(s).toContain("docker ps --format '{{.Names}}'");
    expect(s).toContain("'demo-db' 'it'\\''s'");
    expect(s).toContain('docker stats --no-stream');
    expect(s).toContain('grep -qxF --');
    expect(dockerMemSnippet([])).toBe('');
  });
});

describe('readHostMemory', () => {
  it('runs the meminfo snippet alone and parses it; null when the host has none', async () => {
    const prep = prepare({ project: basic, host: 'local' });
    const fake = new FakeTransport([
      {
        match: MARK.MEM,
        result: {
          stdout: `${MARK.MEM}\nMemTotal: 2048000 kB\nMemAvailable: 1024000 kB\n`,
        },
      },
    ]);
    expect(await readHostMemory(fake, prep.host)).toEqual({
      total_mib: 2000,
      available_mib: 1000,
    });
    const none = new FakeTransport([
      { match: MARK.MEM, result: { stdout: `${MARK.MEM}\n` } },
    ]);
    expect(await readHostMemory(none, prep.host)).toBeNull();
  });
  it('stays null for the gate and the watcher on every failed reading; readHostMemoryOrWhy says why', async () => {
    const prep = prepare({ project: basic, host: 'local' });
    const failing = new FakeTransport([
      {
        match: MARK.MEM,
        result: { stdout: `${MARK.MEM}\n${MEM_STATUS.FAIL}\n` },
      },
    ]);
    expect(await readHostMemory(failing, prep.host)).toBeNull();
    await expect(readHostMemoryOrWhy(failing, prep.host)).rejects.toThrow(
      '/proc/meminfo could not be read'
    );
    const absent = new FakeTransport([
      {
        match: MARK.MEM,
        result: { stdout: `${MARK.MEM}\n${MEM_STATUS.NONE}\n` },
      },
    ]);
    expect(await readHostMemoryOrWhy(absent, prep.host)).toBeNull();
  });
});

describe('memoryFrom', () => {
  it('a reading, or null only where the host has no /proc/meminfo', () => {
    expect(
      memoryFrom(
        `${MARK.MEM}\nMemTotal: 2048000 kB\nMemAvailable: 1024000 kB\n`
      )
    ).toEqual({ total_mib: 2000, available_mib: 1000 });
    expect(memoryFrom(`${MARK.MEM}\n${MEM_STATUS.NONE}\n`)).toBeNull();
  });
  it('throws why for a meminfo that could not be read, lacks a line, or a read that did not run', () => {
    expect(() => memoryFrom(`${MARK.MEM}\n${MEM_STATUS.FAIL}\n`)).toThrow(
      '/proc/meminfo could not be read'
    );
    expect(() => memoryFrom(`${MARK.MEM}\nMemTotal: 1 kB\n`)).toThrow(
      'no MemTotal and MemAvailable lines'
    );
    expect(() => memoryFrom(`${MARK.MEM}\n`)).toThrow(
      'no MemTotal and MemAvailable lines'
    );
    expect(() => memoryFrom('')).toThrow('printed nothing of its own');
  });
  it('a missing awk keeps its exit 127, so the transport reads again with a fresh login environment', () => {
    const r = spawnSync('/bin/sh', ['-c', MEM_READ_SNIPPET], {
      env: { PATH: '/nonexistent' },
      encoding: 'utf8',
    });
    if (!fs.existsSync('/proc/meminfo')) {
      expect(r.stdout).toContain(MEM_STATUS.NONE);
      return;
    }
    expect(r.status).toBe(127);
    expect(r.stdout).toContain(MEM_STATUS.FAIL);
  });
  it.skipIf(!fs.existsSync('/proc/meminfo'))(
    'reads this machine with exit 0',
    () => {
      const r = spawnSync('/bin/sh', ['-c', MEM_READ_SNIPPET], {
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(memoryFrom(r.stdout)?.total_mib).toBeGreaterThan(0);
    }
  );
  it('the round trip says why there is no reading; the probe keeps its own snippet', () => {
    expect(MEM_READ_SNIPPET).toContain(MEM_STATUS.NONE);
    expect(MEM_READ_SNIPPET).toContain(MEM_STATUS.FAIL);
    expect(MEM_SNIPPET).not.toContain(MEM_STATUS.NONE);
  });
});

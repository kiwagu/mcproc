import { describe, it, expect } from 'vitest';
import {
  parseMeminfo,
  parseDockerStats,
  readHostMemory,
} from '../../src/core/memory.js';
import { dockerMemSnippet, MARK } from '../../src/shell/snippets.js';
import { FakeTransport } from '../helpers/fake-transport.js';
import { prepare } from '../../src/core/resolve.js';
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
});

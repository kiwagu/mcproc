import { describe, it, expect } from 'vitest';
import {
  parseStat,
  parseRss,
  parseArgs,
  parseDockerPorts,
} from '../../src/core/stats.js';

describe('stats parsers', () => {
  it('parseStat reads CLK_TCK and pid/ppid/ticks lines, ignoring noise', () => {
    const r = parseStat(
      'CLK 100\n1 0 2\n7 1 0\n765834 765557 1234\nawk: cannot open /proc/99/stat\n'
    );
    expect(r.clkTck).toBe(100);
    expect(r.sample.ticks.get(765834)).toBe(1234);
    expect(r.sample.ppid.get(765834)).toBe(765557);
    expect(r.sample.ticks.size).toBe(3);
    expect(parseStat('').clkTck).toBe(100);
  });
  it('parseRss maps pid to kB', () => {
    const m = parseRss('1 1184\n11 828\n765834 151552\n');
    expect(m.get(765834)).toBe(151552);
    expect(m.size).toBe(3);
  });
  it('parseArgs handles GNU (no header) and busybox (header) output', () => {
    const gnu = parseArgs(
      '    1 /sbin/init splash\n765834 bun --watch src/index.ts\n'
    );
    expect(gnu.get(765834)).toBe('bun --watch src/index.ts');
    const bb = parseArgs(
      'PID   COMMAND\n    1 sh -c sleep 900\n   14 ps -o pid,args\n'
    );
    expect(bb.get(1)).toBe('sh -c sleep 900');
    expect(bb.size).toBe(2);
  });
  it('parseDockerPorts maps every published host port to the container name', () => {
    const m = parseDockerPorts(
      'supabase_kong_zero-memory\t0.0.0.0:55321->8000/tcp, [::]:55321->8000/tcp, 8443/tcp\nsupabase_db_zero-memory\t0.0.0.0:55322->5432/tcp\nidle\t\n'
    );
    expect(m.get(55321)).toBe('supabase_kong_zero-memory');
    expect(m.get(55322)).toBe('supabase_db_zero-memory');
    expect(m.size).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { shq, shjoin } from '../../src/transport/quote.js';

describe('shq', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shq('plain')).toBe("'plain'");
    expect(shq("it's")).toBe("'it'\\''s'");
    expect(shq('')).toBe("''");
  });
  it('round-trips hostile strings through /bin/sh', () => {
    for (const s of [
      `a'b"c$d e&&f`,
      '$(touch /tmp/x)',
      'back`tick`',
      'new\nline',
      'tab\tchar',
    ]) {
      const out = execFileSync('/bin/sh', [
        '-c',
        `printf %s ${shq(s)}`,
      ]).toString();
      expect(out).toBe(s);
    }
  });
  it('joins argv with one space', () => {
    expect(shjoin(['ssh', 'host', 'a b'])).toBe("'ssh' 'host' 'a b'");
  });
});

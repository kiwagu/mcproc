import { describe, it, expect } from 'vitest';
import { parseSizeMib, parsePercent, fmtMib } from '../../src/core/sizes.js';

describe('parseSizeMib', () => {
  it('reads binary sizes into MiB, rounding up', () => {
    expect(parseSizeMib('512M')).toBe(512);
    expect(parseSizeMib('1.5G')).toBe(1536);
    expect(parseSizeMib('2g')).toBe(2048);
    expect(parseSizeMib('100K')).toBe(1);
    expect(parseSizeMib('1536')).toBe(1536);
    expect(parseSizeMib(' 256 MiB ')).toBe(256);
  });
  it('refuses what is not a size', () => {
    for (const bad of ['', 'G', '1.5', '-1G', '10%', 'big'])
      expect(() => parseSizeMib(bad)).toThrow(/size/);
  });
});

describe('parsePercent', () => {
  it('reads a percent into a ratio', () => {
    expect(parsePercent('10%')).toBe(0.1);
    expect(parsePercent('12.5 %')).toBe(0.125);
    expect(parsePercent('0%')).toBe(0);
  });
  it('refuses anything else', () => {
    for (const bad of ['10', '%', '-5%', '101%', ''])
      expect(() => parsePercent(bad)).toThrow(/percent/);
  });
});

describe('fmtMib', () => {
  it('prints MiB under a GiB and GiB with one decimal above', () => {
    expect(fmtMib(0)).toBe('0M');
    expect(fmtMib(512)).toBe('512M');
    expect(fmtMib(1024)).toBe('1.0G');
    expect(fmtMib(1536)).toBe('1.5G');
    expect(fmtMib(2365)).toBe('2.3G');
  });
});

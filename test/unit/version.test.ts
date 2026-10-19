import { describe, it, expect } from 'vitest';
import {
  VERSION,
  VERSION_PATTERN,
  compareVersions,
} from '../../src/version.js';

describe('compareVersions', () => {
  it('orders by major, minor, then patch, numerically', () => {
    expect(compareVersions('0.13.0', '0.12.2')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.13.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.12.10', '0.12.9')).toBeGreaterThan(0);
    expect(compareVersions('0.13.0', '0.13.0')).toBe(0);
  });

  it('puts a pre-release before its release and ignores build metadata', () => {
    expect(compareVersions('0.13.0-rc.1', '0.13.0')).toBeLessThan(0);
    expect(compareVersions('0.13.0', '0.13.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.13.0-rc.2', '0.13.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.13.0+abc', '0.13.0')).toBe(0);
  });

  it('compares long numeric identifiers exactly', () => {
    expect(
      compareVersions('1.2.3-9007199254740993', '1.2.3-9007199254740992')
    ).toBeGreaterThan(0);
    expect(
      compareVersions('90071992547409930.0.0', '90071992547409920.0.0')
    ).toBeGreaterThan(0);
    expect(compareVersions('1.2.3-10', '1.2.3-9')).toBeGreaterThan(0);
  });

  it('the pattern admits semver and nothing looser', () => {
    for (const v of [
      '0.13.0',
      '1.2.3-rc.1',
      '1.2.3-0.a-b',
      '1.2.3+build.5',
      '1.2.3-x+y',
    ])
      expect(VERSION_PATTERN.test(v), v).toBe(true);
    for (const v of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-rc..1',
      '1.2.3-',
      '1.2.3-01',
      '1.2.3+.',
      '1.2.3+',
      '1.2.3+a..b',
      'v1.2.3',
      '1.2',
    ])
      expect(VERSION_PATTERN.test(v), v).toBe(false);
  });

  it('knows its own version as a plain x.y.z', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(compareVersions(VERSION, VERSION)).toBe(0);
  });
});

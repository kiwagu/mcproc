import { describe, it, expect } from 'vitest';
import { VERSION, compareVersions } from '../../src/version.js';

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

  it('knows its own version as a plain x.y.z', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(compareVersions(VERSION, VERSION)).toBe(0);
  });
});

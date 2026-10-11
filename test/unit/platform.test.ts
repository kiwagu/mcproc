import { describe, it, expect } from 'vitest';
import { parsePlatform, nodeDistFile, nodeDistUrl, parseShasums, normalizeVersion, compareVersions } from '../../src/runtime/platform.js';

describe('parsePlatform', () => {
  it('maps uname -sm and the musl probe to a nodejs.org platform', () => {
    expect(parsePlatform('Linux x86_64', false)).toBe('linux-x64');
    expect(parsePlatform('Linux aarch64\n', false)).toBe('linux-arm64');
    expect(parsePlatform('Linux x86_64', true)).toBe('linux-x64-musl');
    expect(parsePlatform('Darwin arm64', false)).toBe('darwin-arm64');
    expect(parsePlatform('Darwin x86_64', false)).toBe('darwin-x64');
  });
  it('returns null where nodejs.org publishes no build', () => {
    expect(parsePlatform('Linux aarch64', true)).toBeNull();
    expect(parsePlatform('Linux armv7l', false)).toBeNull();
    expect(parsePlatform('FreeBSD amd64', false)).toBeNull();
  });
});

describe('dist naming and checksums', () => {
  it('builds file names and URLs', () => {
    expect(nodeDistFile('v24.21.0', 'linux-x64-musl')).toBe('node-v24.21.0-linux-x64-musl.tar.gz');
    expect(nodeDistUrl('v24.21.0', 'SHASUMS256.txt')).toBe('https://nodejs.org/dist/v24.21.0/SHASUMS256.txt');
  });
  it('parses SHASUMS256.txt', () => {
    const m = parseShasums('aaa111  node-v24.21.0-linux-x64.tar.gz\nbbb222  node-v24.21.0-linux-x64.tar.xz\n\n');
    expect(m.get('node-v24.21.0-linux-x64.tar.gz')).toBe('aaa111');
    expect(m.size).toBe(2);
  });
  it('normalizes and compares versions', () => {
    expect(normalizeVersion('24.21.0')).toBe('v24.21.0');
    expect(normalizeVersion('v22.1.0')).toBe('v22.1.0');
    expect(() => normalizeVersion('latest')).toThrowError(/not a Node version/);
    expect(['v22.1.0', 'v24.21.0', 'v24.3.0'].sort(compareVersions).reverse()).toEqual(['v24.21.0', 'v24.3.0', 'v22.1.0']);
  });
});

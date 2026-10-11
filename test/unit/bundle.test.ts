import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { findPackageRoot, ensurePm2Bundle, lockfileHash, type Runner } from '../../src/runtime/bundle.js';

function fakeRoot(pm2Pin = '7.0.4', runtimePin = pm2Pin) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-pkg-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'mcproc', dependencies: { pm2: pm2Pin } }));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'runtime', 'package.json'), JSON.stringify({ dependencies: { pm2: runtimePin } }));
  fs.writeFileSync(path.join(root, 'runtime', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/pm2': { version: runtimePin } } }));
  fs.mkdirSync(path.join(root, 'dist', 'deep'), { recursive: true });
  return root;
}
/** Pretends to be `npm ci`: lays down a tiny node_modules/pm2 in the staging dir. */
const fakeNpm = (): Runner & { calls: string[] } => {
  const r = ((cmd, args, cwd) => {
    r.calls.push(`${cmd} ${args.join(' ')}`);
    fs.mkdirSync(path.join(cwd, 'node_modules', 'pm2', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules', 'pm2', 'package.json'), JSON.stringify({ name: 'pm2', version: '7.0.4', license: 'AGPL-3.0' }));
    fs.writeFileSync(path.join(cwd, 'node_modules', 'pm2', 'bin', 'pm2'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(cwd, 'node_modules', '.package-lock.json'), '{}');
  }) as Runner & { calls: string[] };
  r.calls = [];
  return r;
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('pm2 bundle', () => {
  it('finds the mcproc package root from a nested directory', () => {
    const root = fakeRoot();
    expect(findPackageRoot(path.join(root, 'dist', 'deep'))).toBe(root);
    expect(findPackageRoot()).toBe(path.resolve(import.meta.dirname, '..', '..'));
  });
  it('assembles with npm ci once, caches the archive with a checksum sidecar, and reuses it', async () => {
    const root = fakeRoot(); const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-pm2cache-')); const npm = fakeNpm();
    const b = await ensurePm2Bundle({ root, cacheDir, run: npm });
    expect(b.version).toBe('7.0.4');
    expect(b.path).toBe(path.join(cacheDir, `pm2-7.0.4-${lockfileHash(root).slice(0, 12)}.tgz`));
    expect(sha(b.data)).toBe(b.sha256);
    expect(JSON.parse(fs.readFileSync(`${b.path}.json`, 'utf8'))).toMatchObject({ pm2: '7.0.4', sha256: b.sha256, lock_sha256: lockfileHash(root) });
    expect(npm.calls).toEqual(['npm ci --omit=dev --ignore-scripts --no-audit --no-fund']);
    const { execFileSync } = await import('node:child_process');
    const listing = execFileSync('tar', ['-tzf', b.path], { encoding: 'utf8' });
    expect(listing).toContain('node_modules/pm2/bin/pm2');
    expect(listing).not.toContain('.package-lock.json');
    const again = await ensurePm2Bundle({ root, cacheDir, run: npm });
    expect(again.sha256).toBe(b.sha256);
    expect(npm.calls).toHaveLength(1);
    await ensurePm2Bundle({ root, cacheDir, run: npm, force: true });
    expect(npm.calls).toHaveLength(2);
  });
  it('a corrupted cache entry is rebuilt; a failing npm is DOWNLOAD_FAILED; mismatched pins are BUNDLE_INVALID', async () => {
    const root = fakeRoot(); const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-pm2cache-')); const npm = fakeNpm();
    const b = await ensurePm2Bundle({ root, cacheDir, run: npm });
    fs.writeFileSync(b.path, 'garbage');
    expect((await ensurePm2Bundle({ root, cacheDir, run: npm })).sha256).toBe(b.sha256);
    expect(npm.calls).toHaveLength(2);
    const broken: Runner = () => { throw new Error('npm ERR! network'); };
    await expect(ensurePm2Bundle({ root: fakeRoot(), cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'c-')), run: broken })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', message: expect.stringContaining('npm ci') });
    await expect(ensurePm2Bundle({ root: fakeRoot('7.0.4', '7.0.3'), cacheDir, run: npm })).rejects.toMatchObject({ code: 'BUNDLE_INVALID' });
    await expect(ensurePm2Bundle({ root: fakeRoot('^7'), cacheDir, run: npm })).rejects.toMatchObject({ code: 'BUNDLE_INVALID' });
  });
});

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePm2Bundle } from '../../src/runtime/bundle.js';

describe('ensurePm2Bundle (network: npm registry, real npm and tar)', () => {
  it('assembles the pinned pm2 tree, caches it, and rebuilds byte-identically under GNU tar', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-pm2cache-'));
    const a = await ensurePm2Bundle({ cacheDir });
    expect(a.version).toBe('7.0.4');
    expect(a.data.length).toBeLessThan(10 * 1048576);
    const listing = execFileSync('tar', ['-tzf', a.path], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
    expect(listing).toContain('node_modules/pm2/bin/pm2');
    expect(listing).toContain('node_modules/pm2/LICENSE');
    const b = await ensurePm2Bundle({ cacheDir, force: true });
    if (/GNU tar/.test(execFileSync('tar', ['--version']).toString()))
      expect(b.sha256).toBe(a.sha256);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }, 300_000);
});

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveNodeVersion, fetchNodeTarball, defaultFetcher, type Fetcher } from '../../src/runtime/node-dist.js';

describe('defaultFetcher', () => {
  it('bounds every request with a timeout signal (a stalled connection must not hang the tool call forever)', async () => {
    const seen: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => { seen.push(init?.signal); return new Response('x'); });
    try {
      await defaultFetcher('https://nodejs.org/dist/index.json');
      await defaultFetcher('https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz');
    } finally { vi.unstubAllGlobals(); }
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toBeInstanceOf(AbortSignal);
  });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tarball = Buffer.from('fake node tarball bytes');
const FILE = 'node-v24.21.0-linux-x64.tar.gz';

function fakeFetcher(routes: Record<string, string | Buffer | number>) {
  const calls: string[] = [];
  const f: Fetcher = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) throw new Error(`offline: ${url}`);
    if (typeof r === 'number') return { ok: false, status: r, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = Buffer.isBuffer(r) ? r : Buffer.from(r);
    return { ok: true, status: 200, text: async () => buf.toString(), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer };
  };
  return { f, calls };
}
const tmpCache = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-nodecache-'));
const index = JSON.stringify([
  { version: 'v26.11.1', lts: false }, { version: 'v24.21.0', lts: 'Krypton' }, { version: 'v22.23.3', lts: 'Jod' },
]);

describe('resolveNodeVersion', () => {
  it('takes the newest LTS from index.json, or the requested version', async () => {
    const { f } = fakeFetcher({ 'https://nodejs.org/dist/index.json': index });
    expect(await resolveNodeVersion(undefined, 'linux-x64', { fetcher: f, cacheDir: tmpCache() })).toBe('v24.21.0');
    expect(await resolveNodeVersion('22.1.0', 'linux-x64', { fetcher: f, cacheDir: tmpCache() })).toBe('v22.1.0');
  });
  it('offline: falls back to the newest verified cached version, else DOWNLOAD_FAILED', async () => {
    const { f } = fakeFetcher({});
    const cache = tmpCache();
    await expect(resolveNodeVersion(undefined, 'linux-x64', { fetcher: f, cacheDir: cache })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' });
    for (const v of ['v22.1.0', 'v24.3.0']) {
      fs.writeFileSync(path.join(cache, `node-${v}-linux-x64.tar.gz`), 'x');
      fs.writeFileSync(path.join(cache, `node-${v}-linux-x64.tar.gz.sha256`), 'abc\n');
    }
    fs.writeFileSync(path.join(cache, 'node-v26.0.0-linux-x64.tar.gz'), 'no sidecar, not verified');
    expect(await resolveNodeVersion(undefined, 'linux-x64', { fetcher: f, cacheDir: cache })).toBe('v24.3.0');
  });
});

describe('fetchNodeTarball', () => {
  const base = 'https://nodejs.org/dist/v24.21.0/';
  it('downloads, verifies against SHASUMS256 and caches; the second call does not fetch', async () => {
    const { f, calls } = fakeFetcher({ [base + 'SHASUMS256.txt']: `${sha(tarball)}  ${FILE}\n`, [base + FILE]: tarball });
    const cache = tmpCache();
    const t = await fetchNodeTarball('v24.21.0', 'linux-x64', { fetcher: f, cacheDir: cache });
    expect(t).toMatchObject({ version: 'v24.21.0', platform: 'linux-x64', file: FILE, sha256: sha(tarball), bytes: tarball.length });
    expect(fs.readFileSync(t.path)).toEqual(tarball);
    const n = calls.length;
    await fetchNodeTarball('v24.21.0', 'linux-x64', { fetcher: f, cacheDir: cache });
    expect(calls.length).toBe(n);
  });
  it('checksum mismatch → DOWNLOAD_FAILED and nothing cached', async () => {
    const { f } = fakeFetcher({ [base + 'SHASUMS256.txt']: `deadbeef  ${FILE}\n`, [base + FILE]: tarball });
    const cache = tmpCache();
    await expect(fetchNodeTarball('v24.21.0', 'linux-x64', { fetcher: f, cacheDir: cache })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', message: expect.stringContaining('checksum mismatch') });
    expect(fs.readdirSync(cache)).toEqual([]);
  });
  it('file missing from SHASUMS or HTTP error → DOWNLOAD_FAILED', async () => {
    const { f } = fakeFetcher({ [base + 'SHASUMS256.txt']: 'aaa  other.tar.gz\n' });
    await expect(fetchNodeTarball('v24.21.0', 'linux-x64', { fetcher: f, cacheDir: tmpCache() })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', message: expect.stringContaining('no node-v24.21.0-linux-x64.tar.gz') });
    const { f: f404 } = fakeFetcher({ [base + 'SHASUMS256.txt']: 404 });
    await expect(fetchNodeTarball('v24.21.0', 'linux-x64', { fetcher: f404, cacheDir: tmpCache() })).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', message: expect.stringContaining('HTTP 404') });
  });
  it('a corrupted cache entry is downloaded again', async () => {
    const { f, calls } = fakeFetcher({ [base + 'SHASUMS256.txt']: `${sha(tarball)}  ${FILE}\n`, [base + FILE]: tarball });
    const cache = tmpCache();
    fs.writeFileSync(path.join(cache, FILE), 'garbage');
    fs.writeFileSync(path.join(cache, FILE + '.sha256'), sha(tarball) + '\n');
    const t = await fetchNodeTarball('v24.21.0', 'linux-x64', { fetcher: f, cacheDir: cache });
    expect(fs.readFileSync(t.path)).toEqual(tarball);
    expect(calls).toContain(base + FILE);
  });
});

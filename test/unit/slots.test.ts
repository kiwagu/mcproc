import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claimSlot,
  emptyRegistry,
  readRegistry,
  reclaimGone,
  registryKey,
  registryPath,
  releaseSlot,
  siblingsOf,
  withMain,
  writeRegistry,
} from '../../src/core/slots.js';

const entry = (p: string, project: string) => ({
  path: p,
  branch: null,
  project,
});

describe('slot registry', () => {
  it('keys by base project and a hash of the main checkout path', () => {
    expect(registryKey('demo', '/w/demo')).toMatch(/^demo-[0-9a-f]{8}$/);
    expect(registryKey('demo', '/w/demo')).not.toBe(
      registryKey('demo', '/x/demo')
    );
    expect(registryPath('/state', 'demo', '/w/demo')).toBe(
      `/state/slots/${registryKey('demo', '/w/demo')}.json`
    );
  });
  it('claims the lowest free slot from 1, a wanted one when free, and refuses when none is left', () => {
    let r = withMain(emptyRegistry('/w/demo'), entry('/w/demo', 'demo'));
    expect(r.slots['0']).toEqual(entry('/w/demo', 'demo'));
    const a = claimSlot(r, { max: 2, entry: entry('/w/a', 'demo-w1') });
    expect(a.slot).toBe(1);
    r = a.registry;
    expect(() =>
      claimSlot(r, { max: 2, want: 1, entry: entry('/w/b', 'x') })
    ).toThrowError(expect.objectContaining({ code: 'SLOT_TAKEN' }));
    const b = claimSlot(r, {
      max: 2,
      want: 2,
      entry: entry('/w/b', 'demo-w2'),
    });
    expect(b.slot).toBe(2);
    r = b.registry;
    expect(() =>
      claimSlot(r, { max: 2, entry: entry('/w/c', 'x') })
    ).toThrowError(expect.objectContaining({ code: 'NO_FREE_SLOT' }));
    expect(() =>
      claimSlot(r, { max: 2, want: 0, entry: entry('/w/c', 'x') })
    ).toThrow(/slot 0/);
    r = releaseSlot(r, 1);
    expect(claimSlot(r, { max: 2, entry: entry('/w/c', 'demo-w1') }).slot).toBe(
      1
    );
  });
  it('reclaims slots whose path is gone, never slot 0', () => {
    let r = withMain(emptyRegistry('/w/demo'), entry('/w/demo', 'demo'));
    r = claimSlot(r, { max: 9, entry: entry('/w/a', 'demo-w1') }).registry;
    r = claimSlot(r, { max: 9, entry: entry('/w/b', 'demo-w2') }).registry;
    const { registry, freed } = reclaimGone(r, (p) => p === '/w/b');
    expect(freed).toEqual([1]);
    expect(Object.keys(registry.slots)).toEqual(['0', '2']);
    expect(siblingsOf(registry, '/w/b')).toEqual([
      { slot: 0, entry: entry('/w/demo', 'demo') },
    ]);
  });
  it('reads and writes the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-slots-'));
    const file = registryPath(dir, 'demo', '/w/demo');
    expect(readRegistry(file)).toBeNull();
    const r = withMain(emptyRegistry('/w/demo'), entry('/w/demo', 'demo'));
    writeRegistry(file, r);
    expect(readRegistry(file)).toEqual(r);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

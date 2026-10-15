import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/core/fleet.js', async (orig) => {
  const m = await orig<typeof import('../../src/core/fleet.js')>();
  return { ...m, actOn: vi.fn(async () => []) };
});
import { actOn, Fleet } from '../../src/core/fleet.js';
import { loadManifest } from '../../src/core/manifest.js';
import { reloadView } from '../../src/monit/loop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

describe('reloadView, what R twice runs on the screen', () => {
  it("is start all --reload over the view's fleet, with the screen's signal", async () => {
    const fleet = new Fleet(loadManifest(basic), 'local', async () => {
      throw new Error('no host is reached here');
    });
    const abort = new AbortController();
    await reloadView(fleet, abort.signal);
    expect(actOn).toHaveBeenCalledTimes(1);
    expect(actOn).toHaveBeenCalledWith(fleet, 'all', 'start', {
      reload: true,
      signal: abort.signal,
    });
  });
});

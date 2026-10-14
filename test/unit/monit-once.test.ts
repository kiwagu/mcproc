import { describe, it, expect } from 'vitest';
import { monitOnce } from '../../src/monit/once.js';
import type { LoopDeps } from '../../src/monit/loop.js';
import type { Manifest } from '../../src/core/manifest.js';
import { fakeHosts, fleetManifest, proc, S } from '../helpers/incidents.js';

// the fake hosts run at +0000: pm2's start (epoch ms) is the wall time the log stamps are written in
const START = '2026-10-12T11:00:00';

/** one frame over the fleet fixture, its first app (watch, on local) started at START, its log history `lines` */
async function frame(
  lines: string[],
  manifest: Manifest = fleetManifest,
  budgetMs?: number
): Promise<string> {
  const h = fakeHosts(
    {
      files: {},
      procs: {
        local: [proc('watch', 0, { pm_uptime: Date.parse(`${START}Z`) })],
      },
    },
    [],
    manifest
  );
  const follower: LoopDeps['follower'] = () => ({
    poll: async () => ({
      lines: lines.map((text) => ({ stream: 'out' as const, text })),
      reset: false,
    }),
  });
  return monitOnce(
    { lines: 50, width: 200 },
    { manifest, fleet: () => h.fleet, follower, budgetMs }
  );
}

describe('monitOnce', () => {
  it("the details carry the selected app's reloads counted from the history it read, the boot not among them", async () => {
    const text = await frame([
      `${S(1)}Starting compilation in watch mode...`,
      `${S(12)}File change detected. Starting incremental compilation...`,
    ]);
    expect(text).toContain('restarts 0 (+1 reload, last 11:00:12)');
  });
  it('a history that does not reach back to the start gives a partial count', async () => {
    const text = await frame([
      '2026-10-12T12:00:00: File change detected. Starting incremental compilation...',
      '2026-10-12T12:05:00: File change detected. Starting incremental compilation...',
    ]);
    expect(text).toContain('restarts 0 (+≥2 reloads, last 12:05:00)');
  });
  it('an app whose own reloads patterns run away gets no count, and the footer says why', async () => {
    const manifest: Manifest = {
      ...fleetManifest,
      apps: {
        ...fleetManifest.apps,
        watch: {
          ...fleetManifest.apps.watch,
          reloads: { match: ['^(a|aa)+$'], ignore: [], defaults: true },
        },
      },
    };
    const text = await frame(
      [
        `${S(1)}${'a'.repeat(40)}b`,
        `${S(12)}File change detected. Starting incremental compilation...`,
      ],
      manifest,
      50
    );
    expect(text).toMatch(/restarts 0 {2}procs/);
    expect(text).toMatch(
      /reloads of watch not counted: TIMEOUT.*the reloads patterns of watch/
    );
  });
  it('without reloads in the history the details read as before', async () => {
    const text = await frame([`${S(1)}Starting compilation in watch mode...`]);
    expect(text).toMatch(/restarts 0 {2}procs/);
  });
});

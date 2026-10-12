import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  prepare,
  connect,
  clearResolutionCache,
  type Context,
} from '../../src/core/resolve.js';
import { Fleet, actOn } from '../../src/core/fleet.js';
import { snapshot } from '../../src/core/list.js';
import { findProcess } from '../../src/core/pm2.js';
import { createFollower, LogFollower } from '../../src/core/logfollow.js';
import { createTransport } from '../../src/transport/index.js';
import type { Transport } from '../../src/transport/types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(20);
  }
}
const TICKER = `setInterval(() => console.log('tick ' + Date.now()), 150);`;

describe.skipIf(process.env.MCPROC_IT !== '1')(
  'live logs against a real pm2',
  () => {
    let base: string;
    let ctx: Context;
    beforeAll(async () => {
      base = fs.mkdtempSync('/tmp/mcproc-live-');
      fs.mkdirSync(path.join(base, '.mcproc'));
      fs.writeFileSync(path.join(base, 'ticker.js'), TICKER);
      fs.writeFileSync(
        path.join(base, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: itlive',
          'apps:',
          '  ticker:',
          '    description: logs the time it writes each line',
          '    kind: worker',
          '    run: node ticker.js',
          'hosts:',
          '  local:',
          `    pm2_home: ${path.join(base, 'home')}`,
          '',
        ].join('\n')
      );
      clearResolutionCache();
      ctx = await connect(prepare({ project: base }));
      await actOn(
        new Fleet(prepare({ project: base }).manifest, undefined),
        'all',
        'start'
      );
      await sleep(1000);
    }, 60_000);
    afterAll(async () => {
      try {
        await ctx.pm2.run(['kill']);
      } catch {
        /* already gone */
      }
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('a line the app writes reaches the local follower within 100 ms (median)', async () => {
      const snap = await snapshot(ctx, { cpu: 'none', urls: 'none' });
      const p = findProcess(snap.procs, 'itlive', 'ticker')!;
      const f = createFollower(ctx, { out: p.out_log, err: p.err_log }, 5);
      await f.poll();
      const late: number[] = [];
      f.watch(() => {
        void f.poll().then((r) => {
          for (const l of r.lines) {
            const m = /tick (\d+)$/.exec(l.text);
            if (m) late.push(Date.now() - Number(m[1]));
          }
        });
      });
      await until(() => late.length >= 12, 10_000);
      f.close();
      const sorted = [...late].sort((a, b) => a - b);
      expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(100);
    }, 20_000);
  }
);

describe.skipIf(process.env.MCPROC_IT_DOCKER !== '1')(
  'the host stream inside a busybox container',
  () => {
    const name = `mcproc-it-live-${process.pid}`;
    beforeAll(() => {
      execFileSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          '--name',
          name,
          'alpine:3',
          'sh',
          '-c',
          'i=0; while :; do i=$((i+1)); echo "tick $i" >> /tmp/app-out.log; sleep 0.2; done',
        ],
        { stdio: 'ignore' }
      );
    }, 120_000);
    afterAll(() => {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    });

    it('streams every line in order without a command per poll, and the loop ends after close', async () => {
      const dir = fs.mkdtempSync('/tmp/mcproc-live-dk-');
      fs.mkdirSync(path.join(dir, '.mcproc'));
      fs.writeFileSync(
        path.join(dir, '.mcproc', 'mcproc.yaml'),
        [
          'version: 1',
          'project: itlivedk',
          'apps:',
          '  app:',
          '    description: writes a numbered line every 200 ms',
          '    kind: worker',
          '    run: "true"',
          'hosts:',
          '  box:',
          `    docker: { container: ${name} }`,
          '    cwd: /tmp',
          '    shell: /bin/sh -c',
          '',
        ].join('\n')
      );
      const p = prepare({ project: dir, host: 'box' });
      const real = createTransport(p.host);
      let execs = 0;
      const transport: Transport = {
        ...real,
        exec: (cmd, o) => {
          execs++;
          return real.exec(cmd, o);
        },
      };
      const ctx = { manifest: p.manifest, host: p.host, transport } as Context;
      const f = new LogFollower(
        ctx,
        { out: '/tmp/app-out.log', err: '/tmp/app-err.log' },
        1
      );
      const seen: number[] = (await f.poll()).lines.map((l) =>
        Number(l.text.split(' ')[1])
      );
      f.watch(() => {
        void f.poll().then((r) => {
          for (const l of r.lines) seen.push(Number(l.text.split(' ')[1]));
        });
      });
      await until(() => seen.length >= 15, 15_000);
      f.close();
      expect(execs).toBe(1); // the history; everything after came through the stream
      for (let i = 1; i < seen.length; i++)
        expect(seen[i]).toBe(seen[i - 1] + 1);
      await sleep(1500);
      const ps = execFileSync(
        'docker',
        ['exec', name, 'ps', '-o', 'stat,args'],
        { encoding: 'utf8' }
      );
      expect(ps).not.toContain('HB=262144'); // the loop ended with its client
      expect(ps).not.toMatch(/^\s*Z/m); // and left nothing unreaped behind
      fs.rmSync(dir, { recursive: true, force: true });
    }, 30_000);
  }
);

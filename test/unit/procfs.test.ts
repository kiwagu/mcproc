import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import {
  HOLDER_WALK_MS,
  ProcReader,
  procAvailable,
  zoneOf,
  type ProcFs,
} from '../../src/core/procfs.js';
import { descendants, parseProbe } from '../../src/core/ports.js';
import { probeScript } from '../../src/shell/snippets.js';
import { procWorld, type FakeWorld } from '../helpers/procfs.js';

const CONSTS = { clkTck: 100, pageSize: 4096 };
/** pm2's daemon (100) runs an app: sh 200 → node 201 → esbuild 202; postgres (300) is another user's; 400 is this user's, outside pm2. */
const WORLD: FakeWorld = {
  procs: [
    { pid: 1, ppid: 0, comm: 'systemd' },
    { pid: 100, ppid: 1, comm: 'PM2 v7.0.4: God' },
    {
      pid: 200,
      ppid: 100,
      comm: 'sh',
      rss: 500,
      cmdline: 'sh -c node server.js',
      ticks: 3,
    },
    {
      pid: 201,
      ppid: 200,
      comm: 'node-MainThread',
      rss: 25_000,
      cmdline: 'node server.js',
      ticks: 120,
      sockets: [5001, 5002],
    },
    {
      pid: 202,
      ppid: 201,
      comm: 'esbuild',
      rss: 2000,
      cmdline: '/x/esbuild --service',
      ticks: 7,
      sockets: [5002],
    },
    { pid: 300, ppid: 1, comm: 'postgres', foreign: true },
    {
      pid: 400,
      ppid: 1,
      comm: 'node-MainThread',
      cmdline: 'node other.js',
      sockets: [7001],
    },
  ],
  tcp: [
    { port: 3000, inode: 5001 },
    { port: 5432, inode: 6001, addr: '127.0.0.1' },
    { port: 8080, inode: 7001 },
  ],
  tcp6: [{ port: 3000, inode: 5002 }],
  gone: [999],
};
const reader = (w: FakeWorld = WORLD, clock = { t: 1_000_000 }) => {
  const fs = procWorld(w);
  return { fs, clock, r: new ProcReader(fs, () => clock.t, CONSTS) };
};

describe('ProcReader.sweep', () => {
  it('every process with its parent and CPU ticks, the listening sockets, the memory', () => {
    const { r } = reader();
    const s = r.sweep();
    expect(s.tree.get(201)).toBe(200);
    expect(s.sample.ticks.get(201)).toBe(120);
    expect(s.sample.ppid.get(202)).toBe(201);
    expect(s.sockets.map((x) => [x.proto, x.addr, x.port, x.inode])).toEqual([
      ['tcp', '0.0.0.0', 3000, 5001],
      ['tcp', '127.0.0.1', 5432, 6001],
      ['tcp', '0.0.0.0', 8080, 7001],
      ['tcp', '::', 3000, 5002],
    ]);
    expect(s.memory).toEqual({ total_mib: 7812, available_mib: 3906 });
    expect(s.at).toBe(1_000_000);
  });
  it('a process gone between the listing and its read is skipped; a comm with spaces and parentheses still parses', () => {
    const { r } = reader({
      ...WORLD,
      procs: [
        ...WORLD.procs,
        { pid: 500, ppid: 1, comm: 'we (ird)) x', ticks: 9 },
      ],
    });
    const s = r.sweep();
    expect(s.tree.has(999)).toBe(false);
    expect(s.tree.get(500)).toBe(1);
    expect(s.sample.ticks.get(500)).toBe(9);
  });
  it('no IPv6 or UDP table is no listener there; no /proc/net/tcp is no /proc to read ports from: it throws', () => {
    expect(
      reader({ ...WORLD, tcp6: undefined }).r.sweep().sockets
    ).toHaveLength(3);
    expect(() => reader({ ...WORLD, noNet: true }).r.sweep()).toThrow();
  });
  it('ports: every port something listens on, whoever holds it, without reading any fd', () => {
    const { r, fs } = reader();
    expect([...r.ports()].sort((a, b) => a - b)).toEqual([3000, 5432, 8080]);
    expect(fs.asked.some((p) => p.includes('/fd'))).toBe(false);
  });
});

describe('ProcReader.trees', () => {
  it("the trees' listeners with their pids and command, their RSS and command lines; nothing of other processes", () => {
    const { r } = reader();
    const t = r.trees(r.sweep(), { roots: [200], metrics: true, holders: [] });
    expect(
      t.listeners.map((l) => [l.port, l.addr, l.pid, l.pids, l.command])
    ).toEqual([
      [3000, '0.0.0.0', 201, [201], 'node-MainThread'],
      [5432, '127.0.0.1', null, [], null],
      [8080, '0.0.0.0', null, [], null],
      [3000, '::', 201, [201, 202], 'node-MainThread'],
    ]);
    expect(t.rssKb).toEqual(
      new Map([
        [200, 2000],
        [201, 100_000],
        [202, 8000],
      ])
    );
    expect(t.args.get(201)).toBe('node server.js');
    expect(t.args.get(200)).toBe('sh -c node server.js');
    expect(t.args.has(400)).toBe(false);
  });
  it('without metrics: the listeners only', () => {
    const { r } = reader();
    const t = r.trees(r.sweep(), { roots: [200], metrics: false, holders: [] });
    expect(t.rssKb.size).toBe(0);
    expect(t.args.size).toBe(0);
    expect(t.listeners[0].pid).toBe(201);
  });
  it("a declared port held outside the trees is named by a walk over every process's fds; another user's stays unnamed", () => {
    const { r } = reader();
    const t = r.trees(r.sweep(), {
      roots: [200],
      metrics: false,
      holders: [8080, 5432],
    });
    const by = (port: number) => t.listeners.find((l) => l.port === port)!;
    expect([by(8080).pid, by(8080).pids, by(8080).command]).toEqual([
      400,
      [400],
      'node-MainThread',
    ]);
    expect(by(5432).pid).toBeNull();
  });
  it('no foreign holder of a declared port: no walk', () => {
    const { r, fs } = reader();
    r.trees(r.sweep(), { roots: [200], metrics: false, holders: [3000] });
    expect(fs.asked).not.toContain('/proc/400/fd');
  });
  it('the walk is made at most every 30 s; for every port (ports) every time', () => {
    const { r, fs, clock } = reader();
    const walks = () => fs.asked.filter((p) => p === '/proc/400/fd').length;
    const look = (holders: number[] | 'all') =>
      r.trees(r.sweep(), { roots: [200], metrics: false, holders });
    look([8080]);
    clock.t += HOLDER_WALK_MS - 1;
    expect(look([8080]).listeners.find((l) => l.port === 8080)?.pid).toBe(400);
    expect(walks()).toBe(1);
    clock.t += 1;
    look([8080]);
    expect(walks()).toBe(2);
    look('all');
    look('all');
    expect(walks()).toBe(4);
  });
  it('a root that is gone is a tree of its own that reads nothing', () => {
    const { r } = reader();
    const t = r.trees(r.sweep(), { roots: [777], metrics: true, holders: [] });
    expect(t.rssKb.size).toBe(0);
    expect(t.listeners.every((l) => l.pid === null)).toBe(true);
  });
});

describe('procAvailable', () => {
  it('a /proc with processes and /proc/net/tcp: yes; none (macOS), or one without its net tables: no', () => {
    expect(procAvailable(procWorld(WORLD))).toBe(true);
    expect(procAvailable(procWorld({ ...WORLD, noNet: true }))).toBe(false);
    const none: ProcFs = {
      readdir: () => {
        throw new Error('ENOENT');
      },
      read: () => {
        throw new Error('ENOENT');
      },
      readlink: () => {
        throw new Error('ENOENT');
      },
    };
    expect(procAvailable(none)).toBe(false);
  });
});

describe('zoneOf', () => {
  const summer = new Date('2026-07-01T00:00:00Z');
  const own = (d: Date) => {
    const m = -d.getTimezoneOffset();
    const a = Math.abs(m);
    return `${m < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
  };
  it('the offset of a named zone, as date +%z prints it', () => {
    expect(zoneOf(summer, 'Europe/Berlin')).toBe('+0200');
    expect(zoneOf(summer, 'Asia/Kolkata')).toBe('+0530');
    expect(zoneOf(summer, 'America/St_Johns')).toBe('-0230');
    expect(zoneOf(summer, 'UTC')).toBe('+0000');
    expect(zoneOf(summer, ':Europe/Berlin')).toBe('+0200');
  });
  it("no zone, or one Intl does not know (a POSIX rule string): this process's own offset", () => {
    expect(zoneOf(summer)).toBe(own(summer));
    expect(zoneOf(summer, 'Nowhere/Land')).toBe(own(summer));
  });
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.runIf(process.platform === 'linux')(
  'ProcReader on this machine',
  () => {
    it('agrees with the probe script: the tree, the listener and its pid, RSS within 10%, the command lines, the ticks', async () => {
      const port = await freePort();
      const js = `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1'); require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
      // `; true` keeps sh from exec'ing node: a real tree, sh above node above its child
      const root = spawn('sh', ['-c', `node -e "${js}"; true`], {
        stdio: 'ignore',
      });
      const r = new ProcReader();
      try {
        await until(
          () =>
            r.ports().has(port) &&
            descendants(r.sweep().tree, root.pid!).size >= 2
        );
        const script = parseProbe(
          execFileSync('sh', ['-c', probeScript('pm2', { jlist: false })], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
          })
        );
        const sweep = r.sweep();
        const mine = r.trees(sweep, {
          roots: [root.pid!],
          metrics: true,
          holders: [],
        });
        const pids = new Set([
          root.pid!,
          ...descendants(sweep.tree, root.pid!),
        ]);
        expect(pids).toEqual(
          new Set([root.pid!, ...descendants(script.tree, root.pid!)])
        );
        const a = script.listeners.find((l) => l.port === port)!;
        const b = mine.listeners.find((l) => l.port === port)!;
        expect(b.pid).toBe(a.pid);
        if (a.command !== null) expect(b.command).toBe(a.command); // ss -p names it; the script's /proc fallback does not
        for (const pid of pids) {
          const ra = script.stats.rssKb.get(pid) ?? 0;
          expect(Math.abs((mine.rssKb.get(pid) ?? 0) - ra)).toBeLessThanOrEqual(
            ra * 0.1
          );
          expect(mine.args.get(pid)).toBe(script.stats.args.get(pid));
          const ta = script.stats.samples[0].ticks.get(pid) ?? 0;
          expect(
            Math.abs((sweep.sample.ticks.get(pid) ?? 0) - ta)
          ).toBeLessThanOrEqual(50);
        }
        expect(r.clkTck).toBe(script.stats.clkTck);
      } finally {
        for (const pid of descendants(new ProcReader().sweep().tree, root.pid!))
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            /* gone */
          }
        root.kill('SIGTERM');
      }
    }, 30_000);
  }
);

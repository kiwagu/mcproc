import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import {
  ENV_SNIPPET,
  MARK,
  probeScript,
  STAT_AWK,
  RSS_AWK,
  urlCheck,
} from '../../src/shell/snippets.js';
import {
  parseProbe,
  parseUrlChecks,
  parseUrlProbe,
} from '../../src/core/ports.js';
import { parseStat, parseRss } from '../../src/core/stats.js';
import { hostAttempt } from '../../src/core/urlcheck.js';
import { createTransport } from '../../src/transport/index.js';
import type { Host } from '../../src/core/manifest.js';

describe('probe script executed on this host', () => {
  it('falls back to /proc when ss exists but fails (old iproute2), and still finds our own listener with its pid', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-fakess-'));
    fs.writeFileSync(
      path.join(bin, 'ss'),
      '#!/bin/sh\necho "ss: invalid option -- H" >&2\nexit 255\n',
      { mode: 0o755 }
    );
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const host: Host = {
        name: 'local',
        local: true,
        ssh_args: [],
        cwd: '/',
        readonly: false,
        shell: { bin: '/bin/sh', flags: ['-c'] },
        env: {},
      };
      const res = await createTransport(host).exec(
        `PATH=${bin}:$PATH; export PATH; ${probeScript("echo '[]'")}`,
        { timeoutMs: 60_000 }
      );
      const mine = parseProbe(res.stdout).listeners.find(
        (l) => l.port === port
      );
      expect(mine).toMatchObject({ proto: 'tcp', pid: process.pid });
    } finally {
      server.close();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 70_000);
  it('stats sections on this host: our own process has memory, ticks and a command line', async () => {
    const host: Host = {
      name: 'local',
      local: true,
      ssh_args: [],
      cwd: '/',
      readonly: false,
      shell: { bin: '/bin/sh', flags: ['-c'] },
      env: {},
    };
    const res = await createTransport(host).exec(
      probeScript("echo '[]'", { cpuSample: true }),
      { timeoutMs: 60_000 }
    );
    const d = parseProbe(res.stdout);
    expect(d.stats.clkTck).toBeGreaterThan(0);
    expect(d.stats.samples).toHaveLength(2);
    expect(d.stats.rssKb.get(process.pid)).toBeGreaterThan(1000);
    expect(d.stats.samples[1].ticks.get(process.pid)).toBeGreaterThanOrEqual(
      d.stats.samples[0].ticks.get(process.pid)!
    );
    expect(d.stats.args.get(process.pid)).toMatch(/node|vitest|bun/);
    expect(d.zone).toMatch(/^[+-]\d{4}$/); // this host's `date +%z`
  }, 70_000);
  it('the stat/rss awk programs keep going past a vanished /proc entry (mawk and busybox awk abort on a missing file)', async () => {
    const host: Host = {
      name: 'local',
      local: true,
      ssh_args: [],
      cwd: '/',
      readonly: false,
      shell: { bin: '/bin/sh', flags: ['-c'] },
      env: {},
    };
    const t = createTransport(host);
    const stat = await t.exec(
      `cat /proc/1/stat /proc/999999999/stat /proc/self/stat 2>/dev/null | ${STAT_AWK}`
    );
    const ticks = parseStat(stat.stdout).sample.ticks;
    expect(ticks.has(1)).toBe(true);
    expect(ticks.size).toBe(2);
    const rss = await t.exec(
      `cat /proc/1/status /proc/999999999/status /proc/self/status 2>/dev/null | ${RSS_AWK}`
    );
    expect(parseRss(rss.stdout).size).toBe(2);
  }, 20_000);
  it('url checks on this host: our own http server answers 200, a closed port gives 0', async () => {
    const http = await import('node:http');
    const server = http
      .createServer((_q, s) => s.end('ok'))
      .listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const host: Host = {
        name: 'local',
        local: true,
        ssh_args: [],
        cwd: '/',
        readonly: false,
        shell: { bin: '/bin/sh', flags: ['-c'] },
        env: {},
      };
      const res = await createTransport(host).exec(
        probeScript("echo '[]'", {
          urls: [`http://127.0.0.1:${port}/`, 'http://127.0.0.1:1/'],
        }),
        { timeoutMs: 60_000 }
      );
      const d = parseProbe(res.stdout);
      expect(d.urls.get(`http://127.0.0.1:${port}/`)).toEqual({
        code: 200,
        exit: '0',
        addr: '127.0.0.1',
      });
      expect(d.urls.get('http://127.0.0.1:1/')).toEqual({
        code: 0,
        exit: '7',
        addr: '127.0.0.1',
      });
      expect(d.env).toMatchObject({
        hostname: os.hostname(),
        self: expect.arrayContaining(['127.0.0.1', '::1']),
      });
    } finally {
      server.close();
    }
  }, 70_000);
  it('the wget and no-tool branches print lines the parser reads', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wget-'));
    try {
      for (const t of ['tr', 'cut', 'getent', 'awk']) {
        const p = execFileSync('/bin/sh', ['-c', `command -v ${t}`], {
          encoding: 'utf8',
        }).trim();
        fs.symlinkSync(p, path.join(bin, t));
      }
      // BusyBox wget: exit 1, the reason on stderr even under -q
      fs.writeFileSync(
        path.join(bin, 'wget'),
        `#!/bin/sh\necho "wget: can't connect to remote host (127.0.0.1): Connection refused" >&2\nexit 1\n`,
        { mode: 0o755 }
      );
      const run = (cmd: string) =>
        execFileSync('/bin/sh', ['-c', `PATH=${bin}; ${cmd}`], {
          encoding: 'utf8',
        });
      expect(
        parseUrlChecks(run(urlCheck('http://127.0.0.1:1/'))).get(
          'http://127.0.0.1:1/'
        )
      ).toEqual({
        code: 0,
        exit: "w1:wget: can't connect to remote host (127.0.0.1): Connection refused",
        addr: '127.0.0.1',
      });
      fs.rmSync(path.join(bin, 'wget'));
      expect(
        parseUrlChecks(run(urlCheck('http://127.0.0.1:1/'))).get(
          'http://127.0.0.1:1/'
        )
      ).toEqual({ code: null, exit: null, addr: '127.0.0.1' });
      // no timeout on this PATH: the lookup runs unguarded and still answers
      expect(run('command -v timeout || true')).toBe('');
      expect(
        parseUrlChecks(run(urlCheck('http://localhost:1/'))).get(
          'http://localhost:1/'
        )?.addr
      ).toMatch(/^(::1|127\.)/);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });
  it('a name lookup that hangs is cut after 2 s where the host has timeout: the environment and the url line still come', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-lookup-'));
    const which = (t: string) =>
      execFileSync('/bin/sh', ['-c', `command -v ${t}`], {
        encoding: 'utf8',
      }).trim();
    try {
      for (const t of ['tr', 'awk', 'timeout'])
        fs.symlinkSync(which(t), path.join(bin, t));
      // a resolver that never answers for the url's name, and answers at once for the host's own
      fs.writeFileSync(
        path.join(bin, 'getent'),
        `#!/bin/sh\n[ "$2" = ws.local ] && exec ${which('sleep')} 30\necho "10.0.0.7 $2"\n`,
        { mode: 0o755 }
      );
      fs.writeFileSync(
        path.join(bin, 'hostname'),
        `#!/bin/sh\n[ "$1" = -i ] && { echo 10.0.0.7; exit 0; }\necho ws-01\n`,
        { mode: 0o755 }
      );
      const t0 = Date.now();
      const out = execFileSync(
        '/bin/sh',
        [
          '-c',
          `PATH=${bin}; ${ENV_SNIPPET}\necho ${MARK.URL}\n${urlCheck('http://ws.local:1/')}`,
        ],
        { encoding: 'utf8', timeout: 25_000 }
      );
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(1_500); // the url's lookup hung and was cut...
      expect(took).toBeLessThan(10_000); // ...at 2 s, not after the fake's 30
      const d = parseUrlProbe(out);
      expect(d.env).toMatchObject({
        hostname: 'ws-01',
        self: ['10.0.0.7', '127.0.0.1', '::1'],
      });
      expect(d.urls.get('http://ws.local:1/')).toEqual({
        code: null,
        exit: null,
        addr: null,
      });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);
  it('a wget that never finishes is cut as a whole after 3 s where the host has timeout, and reads timeout', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-wget-hang-'));
    const which = (t: string) =>
      execFileSync('/bin/sh', ['-c', `command -v ${t}`], {
        encoding: 'utf8',
      }).trim();
    try {
      for (const t of ['tr', 'cut', 'timeout'])
        fs.symlinkSync(which(t), path.join(bin, t));
      // a body that streams on, or a resolver inside wget that hangs: -T 2 bounds neither as a whole
      fs.writeFileSync(
        path.join(bin, 'wget'),
        `#!/bin/sh\nexec ${which('sleep')} 30\n`,
        { mode: 0o755 }
      );
      const t0 = Date.now();
      const out = execFileSync(
        '/bin/sh',
        ['-c', `PATH=${bin}; ${urlCheck('http://127.0.0.1:1/')}`],
        { encoding: 'utf8', timeout: 25_000 }
      );
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(2_500);
      expect(took).toBeLessThan(10_000);
      const line = parseUrlChecks(out).get('http://127.0.0.1:1/')!;
      expect(line.exit).toMatch(/^w124\b/); // coreutils timeout here; BusyBox's reads w143 (see urlcheck tests)
      expect(hostAttempt(line)).toEqual({ answered: false, fail: 'timeout' });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);
});

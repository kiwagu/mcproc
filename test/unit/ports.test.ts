import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARK,
  probeScript,
  probeTimeoutMs,
  urlBudgetMs,
  STAT_AWK,
  RSS_AWK,
  urlCheck,
} from '../../src/shell/snippets.js';
import {
  parsePs,
  parseSs,
  parseProcNet,
  parseFdMap,
  parseProbe,
  descendants,
  joinPorts,
  hexToIp,
  splitAddr,
  parseUrlChecks,
  parseEnv,
  parseUrlProbe,
} from '../../src/core/ports.js';
import { parseJlist } from '../../src/core/pm2.js';
import type { App } from '../../src/core/manifest.js';
import { probeOut } from '../helpers/probe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p: string) =>
  fs.readFileSync(path.join(here, '..', 'fixtures', 'probe', p), 'utf8');
const app = (name: string, ports: number[] = []): App => ({
  name,
  description: name,
  kind: 'server',
  run: 'x',
  cwd: '.',
  env: {},
  ports,
  url: null,
  url_check: 'auto',
  depends_on: [],
  autorestart: true,
  pm2: {},
  host: null,
  errors: null,
  reloads: null,
});

describe('probeScript', () => {
  it('contains every marker and the pm2 command', () => {
    const s = probeScript("'/usr/bin/node' '/x/pm2'");
    for (const m of Object.values(MARK))
      if (m !== MARK.STAT2 && m !== MARK.ENV) expect(s).toContain(m); // STAT2 only with cpuSample, ENV only with urls
    expect(s).toContain("'/usr/bin/node' '/x/pm2' jlist");
    expect(s).toContain('ss -ltnp');
    expect(s).toContain('/proc/net/tcp');
  });
  it("prints the host's UTC offset right after pm2's list, in the full and the light form", () => {
    for (const s of [
      probeScript('pm2'),
      probeScript('pm2', { metrics: false }),
    ]) {
      const at = s.indexOf('echo __MCPROC_CLOCK__');
      expect(at).toBeGreaterThan(s.indexOf('__MCPROC_JLIST_RC__'));
      expect(at).toBeLessThan(s.indexOf('echo __MCPROC_PS__'));
      expect(s).toContain("echo __MCPROC_CLOCK__\ndate '+%z' 2>/dev/null");
    }
  });
});

describe('the time budget of a round trip that checks urls', () => {
  it('the probe keeps the transport default without urls, adds the environment and 5 s per url with them, and stops at 120 s', () => {
    expect(probeTimeoutMs(0)).toBe(30_000);
    // each url: a 2 s lookup, then curl's 2 s (-m 2) or wget's 3 s, whichever is longer; the environment: two 2 s lookups
    expect(probeTimeoutMs(1)).toBe(30_000 + 4_000 + 5_000);
    expect(probeTimeoutMs(11)).toBe(30_000 + 4_000 + 11 * 5_000);
    expect(probeTimeoutMs(17)).toBe(119_000);
    expect(probeTimeoutMs(18)).toBe(120_000);
    expect(probeTimeoutMs(500)).toBe(120_000);
  });
  it("doctor's url step: its base, the environment it always asks, 5 s per url, at most 120 s", () => {
    expect(urlBudgetMs(15_000, 0, true)).toBe(19_000);
    expect(urlBudgetMs(15_000, 3, true)).toBe(34_000);
    expect(urlBudgetMs(15_000, 40, true)).toBe(120_000);
  });
});

describe('parsers', () => {
  it('splitAddr handles IPv4, IPv6, wildcard and scoped addresses', () => {
    expect(splitAddr('127.0.0.1:8222')).toEqual({
      addr: '127.0.0.1',
      port: 8222,
    });
    expect(splitAddr('[::]:3000')).toEqual({ addr: '::', port: 3000 });
    expect(splitAddr('*:3310')).toEqual({ addr: '*', port: 3310 });
    expect(splitAddr('127.0.0.53%lo:53')).toEqual({
      addr: '127.0.0.53%lo',
      port: 53,
    });
  });
  it('parseSs keeps listeners without a pid and takes the first pid of many', () => {
    const l = parseSs(fx('ss-tcp.txt'), 'tcp');
    expect(l).toHaveLength(5);
    expect(l[0]).toMatchObject({
      proto: 'tcp',
      addr: '127.0.0.1',
      port: 8222,
      pid: null,
      command: null,
    });
    expect(l[1]).toMatchObject({
      proto: 'tcp',
      addr: '*',
      port: 3310,
      pid: 69265,
      command: 'node',
    });
    expect(l[2]).toMatchObject({
      proto: 'tcp',
      addr: '::',
      port: 3000,
      pid: 4242,
      command: 'node',
    });
    expect(l[2].pids).toEqual([4242, 4243]);
    expect(parseSs(fx('ss-udp.txt'), 'udp')[1]).toMatchObject({
      proto: 'udp',
      port: 41234,
      pid: 69265,
    });
  });
  it('parsePs builds pid→ppid and descendants walks it', () => {
    const tree = parsePs(fx('ps.txt'));
    expect(tree.size).toBe(7);
    expect(tree.get(69300)).toBe(69265);
    expect([...descendants(tree, 69265)]).toEqual([69300]);
    expect([...descendants(tree, 1000)].sort()).toEqual(
      [4242, 4243, 69253, 69265, 69300].sort()
    );
    expect(descendants(tree, 0).size).toBe(0);
  });
  it('parseProcNet decodes LISTEN sockets only and parseFdMap maps inodes', () => {
    expect(hexToIp('0100007F')).toBe('127.0.0.1');
    expect(hexToIp('00000000000000000000000000000000')).toBe('::');
    const l = parseProcNet(fx('proc-net-tcp.txt'), 'tcp');
    expect(l).toEqual([
      { addr: '127.0.0.1', port: 8222, inode: 1355235 },
      { addr: '0.0.0.0', port: 3310, inode: 2171731 },
    ]);
    expect(parseFdMap(fx('proc-fd.txt')).get(2171731)).toBe(69265);
  });
  it("parseProbe reads the host's zone; an absent or garbled clock section is null and the rest still parses", () => {
    expect(parseProbe(probeOut({ clock: '+0200' })).zone).toBe('+0200');
    expect(parseProbe(probeOut({ clock: '-0330\n' })).zone).toBe('-0330');
    expect(parseProbe(probeOut({ clock: '' })).zone).toBeNull();
    expect(parseProbe(probeOut({ clock: 'CEST' })).zone).toBeNull();
    expect(parseProbe(probeOut({ clock: '+02:00' })).zone).toBeNull();
    // the shape of a zone but no real offset: refused as logs since refuses it, so both read the host alike
    expect(parseProbe(probeOut({ clock: '+9900' })).zone).toBeNull();
    expect(parseProbe(probeOut({ clock: '-0260' })).zone).toBeNull();
    expect(parseProbe(probeOut({ clock: '+1400' })).zone).toBe('+1400');
    // the output of a probe without the section (an older script): no zone, every other section as before
    const old = probeOut({ jlist: '[]', ps: fx('ps.txt') }).replace(
      `${MARK.CLOCK}\n+0000\n`,
      ''
    );
    expect(old).not.toContain(MARK.CLOCK);
    const d = parseProbe(old);
    expect(d.zone).toBeNull();
    expect(d.jlistRc).toBe(0);
    expect(d.jlistRaw.trim()).toBe('[]');
    expect(d.tree.size).toBe(7);
  });
  it('parseProbe splits sections (ss path) and falls back to /proc', () => {
    const d = parseProbe(
      probeOut({
        jlist: '[]',
        ps: fx('ps.txt'),
        tcp: fx('ss-tcp.txt'),
        udp: fx('ss-udp.txt'),
      })
    );
    expect(d.jlistRc).toBe(0);
    expect(d.jlistRaw.trim()).toBe('[]');
    expect(d.tree.size).toBe(7);
    expect(d.listeners.filter((l) => l.proto === 'udp')).toHaveLength(2);
    const p = parseProbe(
      probeOut({
        rc: 127,
        ps: fx('ps.txt'),
        tcp: `${MARK.PROC}\n${fx('proc-net-tcp.txt')}`,
        udp: `${MARK.PROC}\n`,
        fd: fx('proc-fd.txt'),
      })
    );
    expect(p.jlistRc).toBe(127);
    expect(p.listeners).toHaveLength(2);
    expect(p.listeners[0]).toMatchObject({
      proto: 'tcp',
      addr: '127.0.0.1',
      port: 8222,
      pid: 392433,
      command: null,
    });
    expect(p.listeners[1]).toMatchObject({
      proto: 'tcp',
      addr: '0.0.0.0',
      port: 3310,
      pid: 69265,
      command: null,
    });
  });
});

describe('probe stats, shared sockets and docker ports', () => {
  it('probeScript emits the stat/rss/args/docker sections, the second CPU sample only on request', () => {
    const once = probeScript('pm2');
    for (const m of [MARK.STAT, MARK.RSS, MARK.ARGS, MARK.DOCKER])
      expect(once).toContain(m);
    expect(once).not.toContain(MARK.STAT2);
    const two = probeScript('pm2', { cpuSample: true });
    expect(two).toContain(MARK.STAT2);
    expect(two).toContain('sleep 0.5');
    expect(once).toContain(MARK.URL);
    expect(once).not.toContain('curl');
    const u = probeScript('pm2', {
      urls: ['http://localhost:3100/', "http://h/it's"],
    });
    expect(u).toContain(
      "curl -s -k -o /dev/null --connect-timeout 1 -m 2 -w '%{http_code}' 'http://localhost:3100/'"
    ); // -k: a liveness check, self-signed dev certs must not read as down
    // -t 1: GNU wget retries a timed-out request up to 20 times; BusyBox accepts -t and makes one try anyway. timeout 3:
    // -T bounds each phase only, so a body that streams on, or a resolver inside wget that hangs, is cut as a whole
    expect(u).toContain(
      "then timeout 3 wget -q --no-check-certificate -t 1 -T 2 -O /dev/null 'http://localhost:3100/' 2>&1"
    );
    expect(u).toContain(
      "else wget -q --no-check-certificate -t 1 -T 2 -O /dev/null 'http://localhost:3100/' 2>&1"
    );
    expect(u).toContain("'http://h/it'\\''s'");
  });
  it('probe sections survive a hung docker and a process that exits mid-pass', () => {
    const s = probeScript('pm2');
    expect(s).toContain('timeout 3 docker ps'); // a wedged docker daemon must not stall the whole probe
    expect(s).toContain(`cat /proc/[0-9]*/stat 2>/dev/null | ${STAT_AWK}`); // mawk/busybox awk abort at the first vanished file of a file list
    expect(s).toContain(`cat /proc/[0-9]*/status 2>/dev/null | ${RSS_AWK}`);
  });
  it('parseProbe carries stats and attributes docker-published ports', () => {
    const d = parseProbe(
      probeOut({
        ps: fx('ps.txt'),
        tcp: `${fx('ss-tcp.txt')}LISTEN 0 4096 0.0.0.0:55321 0.0.0.0:*\n`,
        stat: 'CLK 100\n69265 69253 500\n',
        stat2: 'CLK 100\n69265 69253 550\n',
        rss: '69265 151552\n',
        args: '69265 bun --watch src/index.ts\n',
        docker: 'supabase_kong_zero-memory\t0.0.0.0:55321->8000/tcp\n',
      })
    );
    expect(d.stats.clkTck).toBe(100);
    expect(d.stats.samples).toHaveLength(2);
    expect(d.stats.samples[1].ticks.get(69265)).toBe(550);
    expect(d.stats.rssKb.get(69265)).toBe(151552);
    expect(d.stats.args.get(69265)).toBe('bun --watch src/index.ts');
    expect(d.listeners.find((l) => l.port === 55321)).toMatchObject({
      pid: null,
      container: 'supabase_kong_zero-memory',
    });
    expect(d.listeners.find((l) => l.port === 3000)).toMatchObject({
      pid: 4242,
      pids: [4242, 4243],
      container: null,
    });
  });
  it('a socket shared by several processes is attributed when any of them is in the tree', () => {
    const jlist = JSON.stringify([
      {
        pid: 4243,
        name: 'demo-front',
        pm_id: 2,
        pm2_env: { status: 'online', namespace: 'demo' },
      },
    ]);
    const data = parseProbe(
      probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt') })
    );
    const r = joinPorts(
      { front: app('front', [3000]) },
      parseJlist(data.jlistRaw),
      data,
      'demo'
    );
    expect(r.front.checks).toEqual([{ port: 3000, status: 'listening' }]);
  });
  it('held_by names the container for a docker-published declared port', () => {
    const data = parseProbe(
      probeOut({
        jlist: '[]',
        ps: fx('ps.txt'),
        tcp: 'LISTEN 0 4096 0.0.0.0:55321 0.0.0.0:*\n',
        docker: 'supabase_kong_zero-memory\t0.0.0.0:55321->8000/tcp\n',
      })
    );
    const r = joinPorts({ kong: app('kong', [55321]) }, [], data, 'demo');
    expect(r.kong.checks[0].held_by).toEqual({
      pid: null,
      command: null,
      container: 'supabase_kong_zero-memory',
    });
  });
});

describe('url facts from the host', () => {
  it("every url line carries the code, the tool's exit and the address of its name; the environment comes first, only with urls, in both forms", () => {
    for (const s of [
      probeScript('pm2', { urls: ['http://localhost:3100/'] }),
      probeScript('pm2', { metrics: false, urls: ['http://localhost:3100/'] }),
    ]) {
      expect(s.indexOf(MARK.ENV)).toBeGreaterThan(-1);
      expect(s.indexOf(MARK.ENV)).toBeLessThan(s.indexOf(MARK.URL));
      expect(s).toContain(
        "curl -s -k -o /dev/null --connect-timeout 1 -m 2 -w '%{http_code}' 'http://localhost:3100/'"
      );
      expect(s).toContain(`printf '\\t%s' "$?"`);
      expect(s).toContain(`printf '000\\tw%s:%s'`);
      expect(s).toContain(`getent hosts 'localhost'`);
      expect(s).toContain('echo "container $c"');
    }
    expect(probeScript('pm2')).not.toContain(MARK.ENV);
    expect(probeScript('pm2', { metrics: false })).not.toContain(MARK.ENV);
  });
  it('every name lookup runs under timeout 2 where the host has timeout, and still runs where it has not', () => {
    for (const s of [
      probeScript('pm2', { urls: ['http://ws.local:3100/'] }),
      probeScript('pm2', { metrics: false, urls: ['http://ws.local:3100/'] }),
    ]) {
      const guarded = [
        ...s.matchAll(
          /if command -v timeout >\/dev\/null 2>&1; then timeout 2 ([^;]+); else \1; fi/g
        ),
      ].map((m) => m[1]);
      expect(guarded).toEqual([
        'getent hosts "$h" 2>/dev/null',
        'hostname -i 2>/dev/null',
        "getent hosts 'ws.local' 2>/dev/null",
      ]);
      // no lookup outside its guard: each one appears twice, with timeout and without
      expect(s.match(/getent hosts|hostname -i/g)).toHaveLength(
        2 * guarded.length
      );
    }
  });
  it('an IP literal is its own address, IPv6 without brackets, and never goes to getent', () => {
    const v4 = urlCheck('http://127.0.0.1:3000/');
    expect(v4).toContain(`printf '\\t%s\\n' '127.0.0.1'`);
    expect(v4).not.toContain('getent');
    const v6 = urlCheck('http://[::1]:3000/');
    expect(v6).toContain(`printf '\\t%s\\n' '::1'`);
    expect(v6).not.toContain('getent');
    expect(urlCheck("http://h/it's")).toContain("'http://h/it'\\''s'");
  });
  it('parseUrlChecks reads four fields, and a shorter line still; a line whose code is neither a status nor - is skipped', () => {
    const m = parseUrlChecks(
      [
        'http://a/\t200\t0\t127.0.0.1',
        'http://b/\t000\t7\t::1',
        "http://c/\t000\tw1:wget: can't connect to remote host (10.0.0.9): Connection refused\t10.0.0.9",
        'http://d/\t-\t\t',
        'http://e/\t000',
        'http://f/\tgarbage\t0\t',
        'noise',
      ].join('\n')
    );
    expect(m.get('http://a/')).toEqual({
      code: 200,
      exit: '0',
      addr: '127.0.0.1',
    });
    expect(m.get('http://b/')).toEqual({ code: 0, exit: '7', addr: '::1' });
    expect(m.get('http://c/')).toEqual({
      code: 0,
      exit: "w1:wget: can't connect to remote host (10.0.0.9): Connection refused",
      addr: '10.0.0.9',
    });
    expect(m.get('http://d/')).toEqual({ code: null, exit: null, addr: null });
    expect(m.get('http://e/')).toEqual({ code: 0, exit: null, addr: null });
    expect(m.has('http://f/')).toBe(false);
    expect(m.size).toBe(5);
  });
  it('parseEnv: the container kind, the hostname, each own address once; null when the section is absent', () => {
    expect(
      parseEnv(
        'container docker\nhostname ws-01\nself 172.17.0.2 172.17.0.2 127.0.0.1 ::1\n'
      )
    ).toEqual({
      container: 'docker',
      hostname: 'ws-01',
      self: ['172.17.0.2', '127.0.0.1', '::1'],
    });
    expect(parseEnv('container none\nhostname \nself 127.0.0.1 ::1')).toEqual({
      container: 'none',
      hostname: null,
      self: ['127.0.0.1', '::1'],
    });
    expect(parseEnv('')).toBeNull();
  });
  it('parseProbe and parseUrlProbe carry the environment and the url facts', () => {
    const out = probeOut({
      env: 'container docker\nhostname ws-01\nself 172.17.0.2 127.0.0.1 ::1',
      urls: 'http://localhost:3000/\t000\t7\t::1\n',
    });
    const d = parseProbe(out);
    expect(d.env).toEqual({
      container: 'docker',
      hostname: 'ws-01',
      self: ['172.17.0.2', '127.0.0.1', '::1'],
    });
    expect(d.urls.get('http://localhost:3000/')).toEqual({
      code: 0,
      exit: '7',
      addr: '::1',
    });
    expect(parseUrlProbe(out)).toEqual({ env: d.env, urls: d.urls });
    expect(parseProbe(probeOut({})).env).toBeNull();
    expect(parseProbe(probeOut({})).urls.size).toBe(0);
  });
});

describe('light probe', () => {
  it('without metrics the script has no stat, rss, args or docker passes but still lists sockets and urls', () => {
    const s = probeScript('pm2', { metrics: false, urls: ['http://x/'] });
    expect(s).toContain('jlist');
    expect(s).toContain('ss -ltnp');
    expect(s).toContain(MARK.URL);
    expect(s).not.toContain('/proc/[0-9]*/stat');
    expect(s).not.toContain('/proc/[0-9]*/status');
    expect(s).not.toContain('docker ps');
    expect(s).not.toContain('pid=,args=');
  });
});

describe('joinPorts', () => {
  const jlist = JSON.stringify([
    {
      pid: 69265,
      name: 'demo-api',
      pm_id: 0,
      pm2_env: { status: 'online', namespace: 'demo' },
    },
    {
      pid: 0,
      name: 'demo-web',
      pm_id: 1,
      pm2_env: { status: 'stopped', namespace: 'demo' },
    },
    {
      pid: 4242,
      name: 'demo-front',
      pm_id: 2,
      pm2_env: { status: 'online', namespace: 'demo' },
    },
    {
      pid: 4242,
      name: 'other-api',
      pm_id: 3,
      pm2_env: { status: 'online', namespace: 'other' },
    },
  ]);
  const data = parseProbe(
    probeOut({
      jlist,
      ps: fx('ps.txt'),
      tcp: fx('ss-tcp.txt'),
      udp: fx('ss-udp.txt'),
    })
  );
  const procs = parseJlist(data.jlistRaw);
  const apps = {
    api: app('api', [3310]),
    web: app('web', [3000]),
    front: app('front', [3000]),
    other: app('other', [8222]),
    ghost: app('ghost', [9999]),
  };
  const r = joinPorts(apps, procs, data, 'demo');

  it('attributes listeners through the process tree and reports undeclared ports', () => {
    expect(r.api.checks).toEqual([{ port: 3310, status: 'listening' }]);
    expect(r.api.undeclared).toEqual([41234]);
    expect(r.api.actual.map((l) => l.port).sort()).toEqual([3310, 41234]);
  });
  it('stopped app (pid 0): empty actual, declared port not listening, held_by names the other app', () => {
    expect(r.web.actual).toEqual([]);
    expect(r.web.checks).toEqual([
      {
        port: 3000,
        status: 'declared-not-listening',
        held_by: { pid: 4242, command: 'node', app: 'front' },
      },
    ]);
    expect(r.front.checks).toEqual([{ port: 3000, status: 'listening' }]);
  });
  it('port held by an unknown pid and port nobody holds', () => {
    expect(r.other.checks).toEqual([
      {
        port: 8222,
        status: 'declared-not-listening',
        held_by: { pid: null, command: null },
      },
    ]);
    expect(r.ghost.checks).toEqual([
      { port: 9999, status: 'declared-not-listening' },
    ]);
  });
  it('never attributes a foreign-namespace process', () => {
    expect(r.api.actual.every((l) => l.pid === 69265)).toBe(true);
  });
});

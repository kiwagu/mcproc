import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK, probeScript, STAT_AWK, RSS_AWK } from '../../src/shell/snippets.js';
import { parsePs, parseSs, parseProcNet, parseFdMap, parseProbe, descendants, joinPorts, hexToIp, splitAddr } from '../../src/core/ports.js';
import { parseJlist } from '../../src/core/pm2.js';
import type { App } from '../../src/core/manifest.js';
import { probeOut } from '../helpers/probe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => fs.readFileSync(path.join(here, '..', 'fixtures', 'probe', p), 'utf8');
const app = (name: string, ports: number[] = []): App => ({ name, description: name, kind: 'server', run: 'x', cwd: '.', env: {}, ports, url: null, depends_on: [], autorestart: true, pm2: {}, host: null, errors: null });

describe('probeScript', () => {
  it('contains every marker and the pm2 command', () => {
    const s = probeScript("'/usr/bin/node' '/x/pm2'");
    for (const m of Object.values(MARK)) if (m !== MARK.STAT2) expect(s).toContain(m); // STAT2 only with cpuSample
    expect(s).toContain("'/usr/bin/node' '/x/pm2' jlist");
    expect(s).toContain('ss -ltnp');
    expect(s).toContain('/proc/net/tcp');
  });
});

describe('parsers', () => {
  it('splitAddr handles IPv4, IPv6, wildcard and scoped addresses', () => {
    expect(splitAddr('127.0.0.1:8222')).toEqual({ addr: '127.0.0.1', port: 8222 });
    expect(splitAddr('[::]:3000')).toEqual({ addr: '::', port: 3000 });
    expect(splitAddr('*:3310')).toEqual({ addr: '*', port: 3310 });
    expect(splitAddr('127.0.0.53%lo:53')).toEqual({ addr: '127.0.0.53%lo', port: 53 });
  });
  it('parseSs keeps listeners without a pid and takes the first pid of many', () => {
    const l = parseSs(fx('ss-tcp.txt'), 'tcp');
    expect(l).toHaveLength(5);
    expect(l[0]).toMatchObject({ proto: 'tcp', addr: '127.0.0.1', port: 8222, pid: null, command: null });
    expect(l[1]).toMatchObject({ proto: 'tcp', addr: '*', port: 3310, pid: 69265, command: 'node' });
    expect(l[2]).toMatchObject({ proto: 'tcp', addr: '::', port: 3000, pid: 4242, command: 'node' });
    expect(l[2].pids).toEqual([4242, 4243]);
    expect(parseSs(fx('ss-udp.txt'), 'udp')[1]).toMatchObject({ proto: 'udp', port: 41234, pid: 69265 });
  });
  it('parsePs builds pid→ppid and descendants walks it', () => {
    const tree = parsePs(fx('ps.txt'));
    expect(tree.size).toBe(7);
    expect(tree.get(69300)).toBe(69265);
    expect([...descendants(tree, 69265)]).toEqual([69300]);
    expect([...descendants(tree, 1000)].sort()).toEqual([4242, 4243, 69253, 69265, 69300].sort());
    expect(descendants(tree, 0).size).toBe(0);
  });
  it('parseProcNet decodes LISTEN sockets only and parseFdMap maps inodes', () => {
    expect(hexToIp('0100007F')).toBe('127.0.0.1');
    expect(hexToIp('00000000000000000000000000000000')).toBe('::');
    const l = parseProcNet(fx('proc-net-tcp.txt'), 'tcp');
    expect(l).toEqual([{ addr: '127.0.0.1', port: 8222, inode: 1355235 }, { addr: '0.0.0.0', port: 3310, inode: 2171731 }]);
    expect(parseFdMap(fx('proc-fd.txt')).get(2171731)).toBe(69265);
  });
  it('parseProbe splits sections (ss path) and falls back to /proc', () => {
    const d = parseProbe(probeOut({ jlist: '[]', ps: fx('ps.txt'), tcp: fx('ss-tcp.txt'), udp: fx('ss-udp.txt') }));
    expect(d.jlistRc).toBe(0);
    expect(d.jlistRaw.trim()).toBe('[]');
    expect(d.tree.size).toBe(7);
    expect(d.listeners.filter((l) => l.proto === 'udp')).toHaveLength(2);
    const p = parseProbe(probeOut({ rc: 127, ps: fx('ps.txt'), tcp: `${MARK.PROC}\n${fx('proc-net-tcp.txt')}`, udp: `${MARK.PROC}\n`, fd: fx('proc-fd.txt') }));
    expect(p.jlistRc).toBe(127);
    expect(p.listeners).toHaveLength(2);
    expect(p.listeners[0]).toMatchObject({ proto: 'tcp', addr: '127.0.0.1', port: 8222, pid: 392433, command: null });
    expect(p.listeners[1]).toMatchObject({ proto: 'tcp', addr: '0.0.0.0', port: 3310, pid: 69265, command: null });
  });
});

describe('probe stats, shared sockets and docker ports', () => {
  it('probeScript emits the stat/rss/args/docker sections, the second CPU sample only on request', () => {
    const once = probeScript('pm2');
    for (const m of [MARK.STAT, MARK.RSS, MARK.ARGS, MARK.DOCKER]) expect(once).toContain(m);
    expect(once).not.toContain(MARK.STAT2);
    const two = probeScript('pm2', { cpuSample: true });
    expect(two).toContain(MARK.STAT2);
    expect(two).toContain('sleep 0.5');
    expect(once).toContain(MARK.URL);
    expect(once).not.toContain('curl');
    const u = probeScript('pm2', { urls: ['http://localhost:3100/', "http://h/it's"] });
    expect(u).toContain("curl -s -k -o /dev/null --connect-timeout 1 -m 2 -w '%{http_code}' 'http://localhost:3100/'"); // -k: a liveness check, self-signed dev certs must not read as down
    expect(u).toContain('wget -q --no-check-certificate -T 2');
    expect(u).toContain("'http://h/it'\\''s'");
  });
  it('probe sections survive a hung docker and a process that exits mid-pass', () => {
    const s = probeScript('pm2');
    expect(s).toContain('timeout 3 docker ps');                       // a wedged docker daemon must not stall the whole probe
    expect(s).toContain('cat /proc/[0-9]*/stat 2>/dev/null | ' + STAT_AWK);     // mawk/busybox awk abort at the first vanished file of a file list
    expect(s).toContain('cat /proc/[0-9]*/status 2>/dev/null | ' + RSS_AWK);
  });
  it('parseUrlChecks maps each url to its HTTP code, 0 for no answer, null without curl/wget', () => {
    const d = parseProbe(probeOut({ ps: fx('ps.txt'), tcp: fx('ss-tcp.txt'), urls: 'http://localhost:3100/\t200\nhttp://localhost:3200/\t000\nhttp://localhost:3300/\t-\nnoise\n' }));
    expect(d.urls.get('http://localhost:3100/')).toBe(200);
    expect(d.urls.get('http://localhost:3200/')).toBe(0);
    expect(d.urls.get('http://localhost:3300/')).toBeNull();
    expect(d.urls.size).toBe(3);
    expect(parseProbe(probeOut({})).urls.size).toBe(0);
  });
  it('parseProbe carries stats and attributes docker-published ports', () => {
    const d = parseProbe(probeOut({ ps: fx('ps.txt'), tcp: `${fx('ss-tcp.txt')}LISTEN 0 4096 0.0.0.0:55321 0.0.0.0:*\n`, stat: 'CLK 100\n69265 69253 500\n', stat2: 'CLK 100\n69265 69253 550\n', rss: '69265 151552\n', args: '69265 bun --watch src/index.ts\n', docker: 'supabase_kong_zero-memory\t0.0.0.0:55321->8000/tcp\n' }));
    expect(d.stats.clkTck).toBe(100);
    expect(d.stats.samples).toHaveLength(2);
    expect(d.stats.samples[1].ticks.get(69265)).toBe(550);
    expect(d.stats.rssKb.get(69265)).toBe(151552);
    expect(d.stats.args.get(69265)).toBe('bun --watch src/index.ts');
    expect(d.listeners.find((l) => l.port === 55321)).toMatchObject({ pid: null, container: 'supabase_kong_zero-memory' });
    expect(d.listeners.find((l) => l.port === 3000)).toMatchObject({ pid: 4242, pids: [4242, 4243], container: null });
  });
  it('a socket shared by several processes is attributed when any of them is in the tree', () => {
    const jlist = JSON.stringify([{ pid: 4243, name: 'demo-front', pm_id: 2, pm2_env: { status: 'online', namespace: 'demo' } }]);
    const data = parseProbe(probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt') }));
    const r = joinPorts({ front: app('front', [3000]) }, parseJlist(data.jlistRaw), data, 'demo');
    expect(r.front.checks).toEqual([{ port: 3000, status: 'listening' }]);
  });
  it('held_by names the container for a docker-published declared port', () => {
    const data = parseProbe(probeOut({ jlist: '[]', ps: fx('ps.txt'), tcp: 'LISTEN 0 4096 0.0.0.0:55321 0.0.0.0:*\n', docker: 'supabase_kong_zero-memory\t0.0.0.0:55321->8000/tcp\n' }));
    const r = joinPorts({ kong: app('kong', [55321]) }, [], data, 'demo');
    expect(r.kong.checks[0].held_by).toEqual({ pid: null, command: null, container: 'supabase_kong_zero-memory' });
  });
});

describe('joinPorts', () => {
  const jlist = JSON.stringify([
    { pid: 69265, name: 'demo-api', pm_id: 0, pm2_env: { status: 'online', namespace: 'demo' } },
    { pid: 0, name: 'demo-web', pm_id: 1, pm2_env: { status: 'stopped', namespace: 'demo' } },
    { pid: 4242, name: 'demo-front', pm_id: 2, pm2_env: { status: 'online', namespace: 'demo' } },
    { pid: 4242, name: 'other-api', pm_id: 3, pm2_env: { status: 'online', namespace: 'other' } },
  ]);
  const data = parseProbe(probeOut({ jlist, ps: fx('ps.txt'), tcp: fx('ss-tcp.txt'), udp: fx('ss-udp.txt') }));
  const procs = parseJlist(data.jlistRaw);
  const apps = { api: app('api', [3310]), web: app('web', [3000]), front: app('front', [3000]), other: app('other', [8222]), ghost: app('ghost', [9999]) };
  const r = joinPorts(apps, procs, data, 'demo');

  it('attributes listeners through the process tree and reports undeclared ports', () => {
    expect(r.api.checks).toEqual([{ port: 3310, status: 'listening' }]);
    expect(r.api.undeclared).toEqual([41234]);
    expect(r.api.actual.map((l) => l.port).sort()).toEqual([3310, 41234]);
  });
  it('stopped app (pid 0): empty actual, declared port not listening, held_by names the other app', () => {
    expect(r.web.actual).toEqual([]);
    expect(r.web.checks).toEqual([{ port: 3000, status: 'declared-not-listening', held_by: { pid: 4242, command: 'node', app: 'front' } }]);
    expect(r.front.checks).toEqual([{ port: 3000, status: 'listening' }]);
  });
  it('port held by an unknown pid and port nobody holds', () => {
    expect(r.other.checks).toEqual([{ port: 8222, status: 'declared-not-listening', held_by: { pid: null, command: null } }]);
    expect(r.ghost.checks).toEqual([{ port: 9999, status: 'declared-not-listening' }]);
  });
  it('never attributes a foreign-namespace process', () => {
    expect(r.api.actual.every((l) => l.pid === 69265)).toBe(true);
  });
});

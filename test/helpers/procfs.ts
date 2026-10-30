import type { ProcFs } from '../../src/core/procfs.js';

/** One process of a stand-in /proc. */
export interface FakeProc {
  pid: number;
  ppid: number;
  /** what /proc/<pid>/comm gives (the name ss -p prints); default node */
  comm?: string;
  /** utime + stime */
  ticks?: number;
  /** resident pages: statm's second field */
  rss?: number;
  cmdline?: string;
  /** the socket inodes its fds hold */
  sockets?: number[];
  /** another user's: its fd directory cannot be read */
  foreign?: boolean;
}
export interface FakeSocket {
  port: number;
  inode: number;
  /** IPv4 only: the listening address, default 0.0.0.0 */
  addr?: '0.0.0.0' | '127.0.0.1';
}
export interface FakeWorld {
  procs: FakeProc[];
  tcp?: FakeSocket[];
  tcp6?: FakeSocket[];
  udp?: FakeSocket[];
  udp6?: FakeSocket[];
  /** pids /proc lists whose files are already gone when they are read */
  gone?: number[];
  /** no /proc/net/tcp at all */
  noNet?: boolean;
}

const fail = (code: string, p: string) =>
  Object.assign(new Error(`${code}: ${p}`), { code });
const hexPort = (p: number) => p.toString(16).toUpperCase().padStart(4, '0');
const V4 = { '0.0.0.0': '00000000', '127.0.0.1': '0100007F' } as const;
const ANY6 = '0'.repeat(32);
/** A /proc/net table: its header, then one listening (tcp 0A) or unconnected (udp 07) line per socket. */
const table = (rows: FakeSocket[], state: string, v6: boolean) =>
  `${[
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    ...rows.map(
      (r, i) =>
        `   ${i}: ${v6 ? ANY6 : V4[r.addr ?? '0.0.0.0']}:${hexPort(r.port)} ${v6 ? ANY6 : '00000000'}:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${r.inode} 1 0000000000000000 100 0 0 10 0`
    ),
  ].join('\n')}\n`;

/** A /proc of `w` for a ProcReader; `asked` keeps every path it was asked for, in order. */
export function procWorld(w: FakeWorld): ProcFs & { asked: string[] } {
  const files = new Map<string, string>();
  const links = new Map<string, string>();
  const dirs = new Map<string, string[] | null>(); // null: EACCES
  for (const p of w.procs) {
    const d = `/proc/${p.pid}`;
    const rss = p.rss ?? 0;
    files.set(
      `${d}/stat`,
      `${p.pid} (${p.comm ?? 'node'}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 100 0 0 0 ${p.ticks ?? 0} 0 0 0 20 0 1 0 100 1000 ${rss}`
    );
    files.set(`${d}/statm`, `${rss * 2} ${rss} 0 0 0 0 0`);
    files.set(
      `${d}/cmdline`,
      p.cmdline ? `${p.cmdline.split(' ').join('\0')}\0` : ''
    );
    files.set(`${d}/comm`, `${p.comm ?? 'node'}\n`);
    if (p.foreign) dirs.set(`${d}/fd`, null);
    else {
      const socks = p.sockets ?? [];
      dirs.set(`${d}/fd`, ['0', ...socks.map((_, i) => String(i + 3))]);
      links.set(`${d}/fd/0`, '/dev/null');
      for (const [i, inode] of socks.entries())
        links.set(`${d}/fd/${i + 3}`, `socket:[${inode}]`);
    }
  }
  dirs.set('/proc', [
    ...w.procs.map((p) => String(p.pid)),
    ...(w.gone ?? []).map(String),
    'self',
    'net',
    'meminfo',
  ]);
  files.set(
    '/proc/self/stat',
    '1 (init) S 0 1 1 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 100 1000 0'
  );
  files.set(
    '/proc/meminfo',
    'MemTotal:        8000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB\n'
  );
  if (!w.noNet) files.set('/proc/net/tcp', table(w.tcp ?? [], '0A', false));
  if (w.tcp6) files.set('/proc/net/tcp6', table(w.tcp6, '0A', true));
  if (w.udp) files.set('/proc/net/udp', table(w.udp, '07', false));
  if (w.udp6) files.set('/proc/net/udp6', table(w.udp6, '07', true));
  const asked: string[] = [];
  return {
    asked,
    readdir(d) {
      asked.push(d);
      const v = dirs.get(d);
      if (v === null) throw fail('EACCES', d);
      if (!v) throw fail('ENOENT', d);
      return v;
    },
    read(f) {
      asked.push(f);
      const v = files.get(f);
      if (v === undefined) throw fail('ENOENT', f);
      return v;
    },
    readlink(f) {
      asked.push(f);
      const v = links.get(f);
      if (v === undefined) throw fail('ENOENT', f);
      return v;
    },
  };
}

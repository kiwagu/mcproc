import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { descendants, parseProcNet, type Listener } from './ports.js';
import { parseMeminfo, type HostMemory } from './memory.js';
import type { StatSample } from './stats.js';

/** The few file operations the reader needs, so a test can give it a /proc of its own. */
export interface ProcFs {
  readdir(dir: string): string[];
  read(file: string): string;
  readlink(file: string): string;
}
export const realProcFs: ProcFs = {
  readdir: (d) => fs.readdirSync(d),
  read: (f) => fs.readFileSync(f, 'utf8'),
  readlink: (f) => fs.readlinkSync(f),
};

/** A listening (tcp) or unconnected (udp) socket of /proc/net: its address, port and inode. */
export interface ProcSocket {
  proto: 'tcp' | 'udp';
  addr: string;
  port: number;
  inode: number;
}
/** One sweep of the whole machine: when, every process's parent and CPU ticks, the listening sockets, the memory. */
export interface ProcSweep {
  at: number;
  tree: Map<number, number>;
  sample: StatSample;
  sockets: ProcSocket[];
  memory: HostMemory | null;
}
/** What the trees under pm2's processes add: the listeners with their processes, the trees' RSS and command lines. */
export interface ProcTrees {
  listeners: Listener[];
  rssKb: Map<number, number>;
  args: Map<number, string>;
}

/**
 * A holder of a declared port outside pm2's trees is named from a walk over every process's fds made at most this often,
 * and again at once for a socket the last walk did not see (a new holder).
 */
export const HOLDER_WALK_MS = 30_000;

const NET: [ProcSocket['proto'], string][] = [
  ['tcp', '/proc/net/tcp'],
  ['tcp', '/proc/net/tcp6'],
  ['udp', '/proc/net/udp'],
  ['udp', '/proc/net/udp6'],
];
const PID = /^\d+$/;
const SOCKET = /^socket:\[(\d+)\]$/;

/** `getconf <name>`, or `fallback` where getconf is missing or prints something else. */
function getconf(name: string, fallback: number): number {
  try {
    const v = Number(
      execFileSync('getconf', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    );
    return Number.isInteger(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * This machine's processes read from /proc inside Node, as the probe script would print them: one sweep of every
 * process's stat (the tree and the CPU ticks), /proc/net and meminfo; then, for the trees under pm2's processes only,
 * their RSS, command lines and socket fds. A per-process read that fails (the process exited meanwhile, another
 * user's fds) is skipped; only a /proc that cannot be listed, or a missing /proc/net/tcp, throws.
 */
export class ProcReader {
  private consts: { clkTck: number; pageSize: number } | null;
  /**
   * the last walk over every process's fds: socket inode → the pids that hold it, and every socket of /proc/net it looked
   * for, held or not (another user's stays without an owner, and is no reason to walk again)
   */
  private walked: {
    at: number;
    owners: Map<number, number[]>;
    seen: Set<number>;
  } | null = null;

  constructor(
    private readonly fs: ProcFs = realProcFs,
    private readonly now: () => number = Date.now,
    consts?: { clkTck: number; pageSize: number }
  ) {
    this.consts = consts ?? null;
  }

  /** CLK_TCK and the page size, from getconf once */
  private get c(): { clkTck: number; pageSize: number } {
    this.consts ??= {
      clkTck: getconf('CLK_TCK', 100),
      pageSize: getconf('PAGESIZE', 4096),
    };
    return this.consts;
  }
  get clkTck(): number {
    return this.c.clkTck;
  }

  /** Every process's parent and ticks, the listening sockets and the memory, at one moment. */
  sweep(): ProcSweep {
    const at = this.now();
    const tree = new Map<number, number>();
    const ticks = new Map<number, number>();
    for (const d of this.fs.readdir('/proc')) {
      if (!PID.test(d)) continue;
      let s: string;
      try {
        s = this.fs.read(`/proc/${d}/stat`);
      } catch {
        continue; // gone since the listing
      }
      // "pid (comm) state ppid … utime stime …": comm may hold spaces and parentheses, so cut after the last ")"
      const f = statFields(s);
      const pid = Number(d);
      tree.set(pid, Number(f[1]));
      ticks.set(pid, Number(f[11]) + Number(f[12]));
    }
    return {
      at,
      tree,
      sample: { ticks, ppid: tree },
      sockets: this.sockets(),
      memory: this.memory(),
    };
  }

  /** The ports something listens on, whoever holds them: what a listening wait checks first, with no fd read. */
  ports(): Set<number> {
    return new Set(this.sockets().map((s) => s.port));
  }

  /**
   * The trees of `roots` (pm2's processes, each with its descendants): their listeners with their pids and command, and
   * with `metrics` their RSS and command lines. A listening socket outside the trees has no pid, unless its port is one
   * of `holders` (or holders is 'all'): then a walk over every process's fds names it, at most every HOLDER_WALK_MS
   * unless such a socket is new since the last walk, and every time for 'all'.
   */
  trees(
    sweep: ProcSweep,
    o: { roots: number[]; metrics: boolean; holders: number[] | 'all' }
  ): ProcTrees {
    const pids = new Set<number>();
    for (const r of o.roots) {
      if (r <= 0) continue;
      pids.add(r);
      for (const p of descendants(sweep.tree, r)) pids.add(p);
    }
    const owners = new Map<number, number[]>();
    const rssKb = new Map<number, number>();
    const args = new Map<number, string>();
    for (const pid of pids) {
      this.fds(pid, owners);
      if (!o.metrics) continue;
      try {
        const statm = this.fs.read(`/proc/${pid}/statm`).split(' ');
        rssKb.set(pid, (Number(statm[1]) * this.c.pageSize) / 1024);
      } catch {
        /* gone */
      }
      try {
        const cmd = this.fs
          .read(`/proc/${pid}/cmdline`)
          .replace(/\0+$/, '')
          .replaceAll('\0', ' ');
        if (cmd) args.set(pid, cmd); // a zombie has none
      } catch {
        /* gone */
      }
    }
    const wanted = (port: number) =>
      o.holders === 'all' || o.holders.includes(port);
    const outside = sweep.sockets.flatMap((s) =>
      !owners.has(s.inode) && wanted(s.port) ? [s.inode] : []
    );
    const walk = outside.length
      ? this.walk(sweep, o.holders === 'all', outside)
      : null;
    const comms = new Map<number, string | null>();
    const comm = (pid: number): string | null => {
      if (!comms.has(pid)) {
        let c: string | null = null;
        try {
          c = this.fs.read(`/proc/${pid}/comm`).trim() || null;
        } catch {
          /* gone */
        }
        comms.set(pid, c);
      }
      return comms.get(pid) ?? null;
    };
    // /proc/net cannot tell a dual-stack socket from a v6-only one, nor name the device a socket is bound to: where ss
    // prints `*` and `127.0.0.53%lo`, these read `::` and `127.0.0.53`
    const listeners: Listener[] = sweep.sockets.map((s) => {
      const held =
        owners.get(s.inode) ??
        (walk && wanted(s.port) ? walk.get(s.inode) : undefined) ??
        [];
      const ps = [...held].sort((a, b) => a - b);
      return {
        proto: s.proto,
        addr: s.addr,
        port: s.port,
        pid: ps[0] ?? null,
        pids: ps,
        command: ps.length ? comm(ps[0]) : null,
        container: null,
      };
    });
    return { listeners, rssKb, args };
  }

  private sockets(): ProcSocket[] {
    const out: ProcSocket[] = [];
    for (const [proto, file] of NET) {
      let text: string;
      try {
        text = this.fs.read(file);
      } catch (e) {
        if (file === '/proc/net/tcp') throw e; // no IPv4 table: no /proc to read ports from
        continue; // IPv6 off, or no UDP table: nothing listens there
      }
      for (const e of parseProcNet(text, proto)) out.push({ proto, ...e });
    }
    return out;
  }

  private memory(): HostMemory | null {
    try {
      return parseMeminfo(this.fs.read('/proc/meminfo'));
    } catch {
      return null;
    }
  }

  /** Adds the socket inodes `pid`'s fds hold to `into`; nothing for a process that is gone or another user's. */
  private fds(pid: number, into: Map<number, number[]>): void {
    let fds: string[];
    try {
      fds = this.fs.readdir(`/proc/${pid}/fd`);
    } catch {
      return;
    }
    for (const fd of fds) {
      let l: string;
      try {
        l = this.fs.readlink(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue; // closed meanwhile
      }
      const m = SOCKET.exec(l);
      if (!m) continue;
      const inode = Number(m[1]);
      const list = into.get(inode);
      if (!list) into.set(inode, [pid]);
      else if (!list.includes(pid)) list.push(pid);
    }
  }

  /**
   * inode → pids over every process this user may look into: fresh for `fresh`, else at most every HOLDER_WALK_MS while
   * the last walk saw every socket of `inodes`.
   */
  private walk(
    sweep: ProcSweep,
    fresh: boolean,
    inodes: number[]
  ): Map<number, number[]> {
    const now = this.now();
    const last = this.walked;
    if (
      !fresh &&
      last &&
      now - last.at < HOLDER_WALK_MS &&
      inodes.every((i) => last.seen.has(i))
    )
      return last.owners;
    const owners = new Map<number, number[]>();
    for (const pid of sweep.tree.keys()) this.fds(pid, owners);
    this.walked = {
      at: now,
      owners,
      seen: new Set(sweep.sockets.map((s) => s.inode)),
    };
    return owners;
  }
}

/**
 * The fields of a `/proc/<pid>/stat` line after its comm: index 0 is the state (field 3), 1 the parent, 11 and 12 the
 * CPU ticks, 19 the start time. The comm may hold spaces and parentheses, so the line is cut after its last ")".
 */
export function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

/**
 * When a process started, in clock ticks after boot (field 22 of its stat): with its pid and the boot it tells one
 * process apart from a later one that reuses the pid. Null when the stat cannot be read (gone, no /proc).
 */
export function processStart(
  pid: number,
  f: ProcFs = realProcFs
): number | null {
  try {
    const v = Number(statFields(f.read(`/proc/${pid}/stat`))[19]);
    return Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

/** This boot of the machine, as the kernel names it; null without /proc. */
export function bootId(f: ProcFs = realProcFs): string | null {
  try {
    return f.read('/proc/sys/kernel/random/boot_id').trim() || null;
  } catch {
    return null;
  }
}

/** Whether this machine has a /proc to read processes and ports from (Linux, WSL; not macOS). */
export function procAvailable(f: ProcFs = realProcFs): boolean {
  try {
    return (
      f.read('/proc/self/stat').includes(')') &&
      f.read('/proc/net/tcp').length > 0
    );
  } catch {
    return false;
  }
}

let shared: ProcReader | null | undefined;
/** This machine's reader, one per process (CLK_TCK, the page size and the last walk with it); null without /proc. */
export function localProc(): ProcReader | null {
  if (shared === undefined) shared = procAvailable() ? new ProcReader() : null;
  return shared;
}

/**
 * The UTC offset as `date +%z` prints it ('+0200', '-0330') at `at`: of `tz` when it names a zone Intl knows (a
 * leading ':' as the C library allows), else this process's own.
 */
export function zoneOf(at: Date, tz?: string): string {
  let mins = -at.getTimezoneOffset();
  if (tz) {
    try {
      const name =
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz.replace(/^:/, ''),
          timeZoneName: 'longOffset',
        })
          .formatToParts(at)
          .find((p) => p.type === 'timeZoneName')?.value ?? '';
      const m = /^GMT(?:([+-])(\d{1,2}):(\d{2}))?$/.exec(name);
      if (m)
        mins = m[1]
          ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
          : 0;
    } catch {
      /* a TZ Intl does not know: this process's own offset */
    }
  }
  const a = Math.abs(mins);
  return `${mins < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}

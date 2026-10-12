import { randomBytes } from 'node:crypto';
import { shq } from '../transport/quote.js';
import type { StreamProc, Transport } from '../transport/types.js';
import { hex16 } from '../shell/snippets.js';
import {
  type ChunkRequest,
  HEX,
  HISTORY_BYTES,
  type LogChunk,
  READ_CAP,
} from './logchunk.js';

/**
 * The loop a host runs for its followed files, under a plain POSIX sh. Every 250 ms one `stat` measures them all: size,
 * inode and mtime (`wc -c` per file, size only, where stat has no -c). A file whose size moved is read with the
 * follower's rules (H/R/S/N); one whose size stayed but whose inode or mtime changed has its anchor checked, so a
 * replacement of the same length is seen too. The bytes are copied to a temp file together with up to 16 bytes before
 * them, counted, and sent as a frame: `<nonce> <i> <from> <size> <start> <kind> <got> <anchor>`, the raw bytes,
 * `\n<nonce> end`; the anchor comes from that copy, never from a later read. Its own position becomes start + got.
 *
 * The loop ends with its client either way the client can go: its stdin closes (a killed `docker exec` client leaves
 * the command running and its output still read by the daemon, but closes its stdin), or its output does (a heartbeat
 * line per round meets SIGPIPE). The outer shell waits on stdin with the `read` builtin, so no extra process is left
 * behind in a container whose first process never reaps orphans.
 */
export function loopScript(
  nonce: string,
  files: ChunkRequest[],
  /** the stat format (size, inode, mtime), or null to measure with `wc -c` as on a host without `stat -c` */
  opts: { stat?: string | null } = {}
): string {
  const statFormat = opts.stat === undefined ? '%s %i %.9Y' : opts.stat;
  const vars = files
    .map(
      (f, i) =>
        `p${i}=${shq(f.path)} o${i}=${f.off ?? -1} a${i}=${f.anchor && HEX.test(f.anchor) ? f.anchor : "''"} q${i}= c${i}=0`
    )
    .join('\n');
  return [
    `N=${nonce} K=${files.length} HB=${HISTORY_BYTES} CAP=${READ_CAP}`,
    vars,
    '(',
    `t=$(mktemp 2>/dev/null) || t="\${TMPDIR:-/tmp}/mcproc-follow.$$"`,
    `trap 'rm -f "$t"; kill $$ 2>/dev/null' EXIT`, // gone by itself (SIGPIPE): the waiting shell goes too
    `trap 'exit 1' HUP INT TERM PIPE`,
    statFormat === null
      ? 'gs='
      : `SF=${shq(statFormat)}; gs=; stat -L -c %s / >/dev/null 2>&1 && gs=1`,
    'nap=1; sleep 0.01 2>/dev/null && nap=0.25',
    'one() {',
    '  eval "p=\\$p$1 o=\\$o$1 a=\\$a$1 q=\\$q$1 c=\\$c$1"',
    '  sz=$2',
    // same size: the file was replaced only if the bytes before the position differ. They are checked when the
    // identity moved; a whole-second mtime (busybox) can hide a rewrite within the second of the last change, so a
    // changed file is checked for five rounds after; with no identity at all (`wc`), also every 8th round
    '  if [ "$o" -ge 0 ] && [ "$sz" -eq "$o" ]; then',
    '    if [ "$3" = "$q" ]; then',
    '      case "$3" in *.*.*) return 0 ;; esac', // a nanosecond mtime shows every rewrite
    '      if [ "$c" -gt 0 ]; then eval "c$1=$((c-1))"',
    `      elif [ "$3" != '-.-' ] || [ $((r%8)) -ne 0 ]; then return 0; fi`,
    '    else eval "q$1=\\$3 c$1=5"; fi',
    `    { [ -z "$a" ] || [ "${hex16('"$p"', '$o')}" = "$a" ]; } && return 0`,
    '  fi',
    '  eval "q$1=\\$3 c$1=5"',
    '  if [ "$o" -lt 0 ]; then k=H; st=$((sz>HB?sz-HB:0))',
    `  elif [ "$sz" -lt "$o" ] || { [ -n "$a" ] && [ "${hex16('"$p"', '$o')}" != "$a" ]; }; then k=R; st=$((sz>HB?sz-HB:0))`,
    '  elif [ $((sz-o)) -gt $CAP ]; then k=S; st=$((sz-CAP))',
    '  else k=N; st=$o; fi',
    '  lo=$((sz>16?sz-16:0)); [ "$lo" -gt "$st" ] && lo=$st',
    '  if [ "$sz" -gt "$lo" ]; then tail -c +$((lo+1)) "$p" 2>/dev/null | head -c $((sz-lo)) >"$t"; else : >"$t"; fi',
    '  all=$(wc -c <"$t"); all=$((all+0)); pre=$((st-lo)); got=$((all>pre?all-pre:0))',
    `  if [ "$all" -ge $((sz-lo)) ]; then na=$(tail -c 16 "$t" | od -An -tx1 | tr -d ' \\n'); no=$sz; else na=; no=$((st+got)); fi`,
    `  printf '%s %s %s %s %s %s %s %s\\n' "$N" "$1" "$o" "$sz" "$st" "$k" "$got" "$na"`,
    '  if [ "$pre" -eq 0 ]; then cat "$t"; else tail -c +$((pre+1)) "$t"; fi',
    `  printf '\\n%s end\\n' "$N"`,
    '  eval "o$1=\\$no a$1=\\$na"',
    '}',
    'r=0',
    'while :; do',
    '  r=$((r+1)); set --; e=; i=0; nf=0',
    '  while [ $i -lt $K ]; do',
    '    eval "f=\\$p$i"',
    '    if [ -f "$f" ]; then set -- "$@" "$f"; e="$e 1"; nf=$((nf+1)); else e="$e 0"; fi',
    '    i=$((i+1))',
    '  done',
    '  z=; ok=1',
    '  if [ $# -gt 0 ]; then',
    '    if [ -n "$gs" ]; then z=$(stat -L -c "$SF" -- "$@" 2>/dev/null) || ok=', // busybox: whole-second mtimes
    '    else for f in "$@"; do s=$(wc -c <"$f" 2>/dev/null) || { ok=; break; }; z="$z $((s+0)) - -"; done; fi',
    '  fi',
    '  set -- $z',
    '  [ $# -eq $((nf*3)) ] || ok=', // a file that went away between the test and stat: next round
    '  if [ -n "$ok" ]; then',
    '    i=0',
    '    for x in $e; do',
    '      if [ "$x" = 1 ]; then sz=$1; id="$2.$3"; shift 3; else sz=0; id=; fi',
    '      one $i "$sz" "$id"',
    '      i=$((i+1))',
    '    done',
    '  fi',
    `  printf '%s hb\\n' "$N"`,
    '  sleep $nap',
    'done',
    ') &',
    'm=$!',
    'while read -r _; do :; done', // until the client closes stdin
    `trap '' TERM`,
    'kill $m 2>/dev/null',
    'wait $m',
  ].join('\n');
}

export interface Frame {
  index: number;
  chunk: LogChunk;
}

/** Cuts the loop's output into frames and heartbeats; lines that are neither (a login banner) are skipped. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private readonly head: string;
  private readonly trailer: Buffer;
  constructor(
    nonce: string,
    private readonly on: {
      frame(f: Frame): void;
      beat(): void;
      broken(): void;
    }
  ) {
    this.head = `${nonce} `;
    this.trailer = Buffer.from(`\n${nonce} end\n`);
  }

  push(data: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    let at = 0;
    for (;;) {
      const nl = this.buf.indexOf(10, at);
      if (nl < 0) {
        if (this.buf.length - at > 4096) at = this.buf.length; // a long line of something else: headers are short
        break;
      }
      const line = this.buf.toString('latin1', at, nl);
      if (!line.startsWith(this.head)) {
        at = nl + 1;
        continue;
      }
      const f = line.slice(this.head.length).split(' ');
      if (f[0] === 'hb') {
        this.on.beat();
        at = nl + 1;
        continue;
      }
      const [index, from, size, start, got] = [
        f[0],
        f[1],
        f[2],
        f[3],
        f[5],
      ].map(Number);
      const kind = f[4];
      if (
        ![index, from, size, start, got].every(Number.isInteger) ||
        !/^[HRSN]$/.test(kind) ||
        got < 0
      ) {
        this.fail();
        return;
      }
      const end = nl + 1 + got + this.trailer.length;
      if (this.buf.length < end) break; // the rest of the frame is still on its way
      if (!this.buf.subarray(nl + 1 + got, end).equals(this.trailer)) {
        this.fail();
        return;
      }
      this.on.frame({
        index,
        chunk: {
          from: from < 0 ? null : from,
          size,
          start,
          kind: kind as LogChunk['kind'],
          got,
          anchor: f[6] ?? '',
          body: this.buf.toString('utf8', nl + 1, nl + 1 + got),
        },
      });
      at = end;
    }
    this.buf = this.buf.subarray(at);
  }

  private fail(): void {
    this.buf = Buffer.alloc(0);
    this.on.broken();
  }
}

/** What a host stream follows for: a follower's files and where it stands in them. */
export interface StreamMember {
  requests(): ChunkRequest[];
  /** a read of the member's file `k`; false when it does not continue where the member stands */
  offer(k: number, chunk: LogChunk): boolean;
}
export interface HostStreamOptions {
  /** members joining or leaving within this time restart the loop once */
  debounceMs: number;
  /** waits before reconnecting after a drop, one per failure in a row (the last repeats) */
  backoffMs: number[];
  /** a loop silent this long is taken for dead */
  stallMs: number;
}
const DEFAULTS: HostStreamOptions = {
  debounceMs: 150,
  backoffMs: [1000, 2000, 4000, 5000],
  stallMs: 15_000,
};
/** a loop that lived this long before it dropped starts the backoff over */
const STEADY_MS = 5000;

interface Run {
  proc: StreamProc;
  index: { m: StreamMember; k: number }[];
  members: Set<StreamMember>;
  live: boolean;
  liveAt: number;
  seen: number;
}

/**
 * One loop per host for every followed file there: restarted (from the members' own positions) when the set of
 * members changes or a member falls out of step, reconnected with a backoff when it drops or goes silent.
 */
export class HostStream {
  private members = new Set<StreamMember>();
  private run: Run | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stall: NodeJS.Timeout | null = null;
  private failures = 0;
  private readonly opts: HostStreamOptions;
  constructor(
    private readonly transport: Transport,
    opts: Partial<HostStreamOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  add(m: StreamMember): void {
    this.members.add(m);
    this.schedule(this.opts.debounceMs);
  }

  remove(m: StreamMember): void {
    if (!this.members.delete(m)) return;
    if (this.members.size) this.schedule(this.opts.debounceMs);
    else {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.kill();
      this.failures = 0;
    }
  }

  /** the loop runs, has been heard from, and follows this member */
  covers(m: StreamMember): boolean {
    return !!this.run?.live && this.run.members.has(m);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, ms);
    this.timer.unref?.();
  }

  private kill(): void {
    const r = this.run;
    this.run = null;
    if (this.stall) clearInterval(this.stall);
    this.stall = null;
    if (!r) return;
    running.delete(r.proc);
    r.proc.kill();
  }

  private start(): void {
    this.kill();
    if (!this.members.size || !this.transport.stream) return;
    const index: Run['index'] = [];
    const reqs: ChunkRequest[] = [];
    for (const m of this.members)
      m.requests().forEach((r, k) => {
        index.push({ m, k });
        reqs.push(r);
      });
    const nonce = randomBytes(6).toString('hex');
    const proc = this.transport.stream(loopScript(nonce, reqs));
    const run: Run = {
      proc,
      index,
      members: new Set(this.members),
      live: false,
      liveAt: 0,
      seen: Date.now(),
    };
    this.run = run;
    running.add(proc);
    cleanUpOnExit();
    const heard = () => {
      run.seen = Date.now();
      if (run.live) return;
      run.live = true;
      run.liveAt = run.seen;
    };
    const reader = new FrameReader(nonce, {
      beat: heard,
      frame: ({ index: i, chunk }) => {
        heard();
        const e = run.index[i];
        if (!e || !this.members.has(e.m)) return;
        if (!e.m.offer(e.k, chunk)) this.schedule(this.opts.debounceMs); // out of step: start again from where it stands
      },
      broken: () => {
        if (this.run === run) proc.kill();
      },
    });
    proc.onData((d) => {
      if (this.run === run) reader.push(d);
    });
    proc.onExit(() => {
      running.delete(proc);
      if (this.run !== run) return; // stopped or replaced on purpose
      this.kill();
      if (run.live && Date.now() - run.liveAt > STEADY_MS) this.failures = 0;
      const b = this.opts.backoffMs;
      const wait = b[Math.min(this.failures, b.length - 1)];
      this.failures++;
      if (this.members.size) this.schedule(wait);
    });
    this.stall = setInterval(
      () => {
        if (this.run === run && Date.now() - run.seen > this.opts.stallMs)
          proc.kill();
      },
      Math.min(1000, this.opts.stallMs)
    );
    this.stall.unref?.();
  }
}

/** the loops of this process: stopped when it exits, so none outlives mcproc on a host */
const running = new Set<StreamProc>();
let armed = false;
function cleanUpOnExit(): void {
  if (armed) return;
  armed = true;
  process.once('exit', () => {
    for (const p of running) p.kill();
  });
}

const streams = new WeakMap<Transport, HostStream>();
/** The stream of the host behind this transport; null when the transport cannot stream. */
export function hostStreamFor(t: Transport): HostStream | null {
  if (!t.stream) return null;
  let s = streams.get(t);
  if (!s) {
    s = new HostStream(t);
    streams.set(t, s);
  }
  return s;
}

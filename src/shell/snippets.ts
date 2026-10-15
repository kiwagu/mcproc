import { isIP } from 'node:net';
import { shq } from '../transport/quote.js';

/** The host name of a url, as a host resolves it (IPv6 brackets removed); null when the url does not parse. */
export function urlName(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '') || null;
  } catch {
    return null;
  }
}

export const MARK = {
  JLIST: '__MCPROC_JLIST__',
  JLIST_RC: '__MCPROC_JLIST_RC__',
  CLOCK: '__MCPROC_CLOCK__',
  PS: '__MCPROC_PS__',
  TCP: '__MCPROC_TCP__',
  UDP: '__MCPROC_UDP__',
  FD: '__MCPROC_FD__',
  PROC: '__MCPROC_PROC__',
  STAT: '__MCPROC_STAT__',
  STAT2: '__MCPROC_STAT2__',
  RSS: '__MCPROC_RSS__',
  ARGS: '__MCPROC_ARGS__',
  DOCKER: '__MCPROC_DOCKER__',
  ENV: '__MCPROC_ENV__',
  URL: '__MCPROC_URL__',
} as const;

/* /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces, so cut after the last ")". */
const PS_FALLBACK = `for p in /proc/[0-9]*; do s=$(cat "$p/stat" 2>/dev/null) || continue; r=\${s##*) }; set -- $r; echo "\${p#/proc/} $2"; done`;
/* "<pid> <inode>" for every socket fd; only needed when ss is missing. */
const FD_SCAN = `for p in /proc/[0-9]*; do for f in "$p"/fd/*; do l=$(readlink "$f" 2>/dev/null) || continue; case $l in socket:*) i=\${l#socket:[}; echo "\${p#/proc/} \${i%]}";; esac; done; done`;
/* The /proc scans read stdin fed by `cat`, never a file list: mawk and busybox awk abort the whole pass at the first file that
   vanished between the glob and the open (a process exiting mid-pass), and only gawk carries on; cat just skips it. */
/* "pid ppid utime+stime" per process in ONE awk pass; the comm field may contain spaces, so split after the last ") ". */
export const STAT_AWK = `awk '{ i=index($0,") "); split(substr($0,i+2),f," "); print $1, f[2], f[12]+f[13] }'`;
/* "pid VmRSS_kB" per process (Pid: precedes VmRSS: in /proc/<pid>/status); kernel threads have no VmRSS and drop out. */
export const RSS_AWK = `awk '/^Pid:/{ p=$2 } /^VmRSS:/{ print p, $2 }'`;
/**
 * `cmd` cut after `secs` seconds where the host has `timeout`, and run as it is where it has not: a wedged docker daemon
 * or a dead resolver must not stall the whole probe until the transport timeout.
 */
const bounded = (secs: number, cmd: string): string =>
  `if command -v timeout >/dev/null 2>&1; then timeout ${secs} ${cmd}; else ${cmd}; fi`;

/**
 * The host about itself, next to its url checks: whether it is a container, its hostname, and the addresses its own
 * name resolves to (127.0.0.1 and ::1 always), so a url whose name resolves to one of them reads "the host itself".
 */
export const ENV_SNIPPET = [
  `echo ${MARK.ENV}`,
  `c=none; if [ -f /.dockerenv ]; then c=docker; elif [ -f /run/.containerenv ]; then c=podman; elif grep -qa 'container=lxc' /proc/1/environ 2>/dev/null || grep -q '/lxc' /proc/1/cgroup 2>/dev/null; then c=lxc; elif grep -q '/docker' /proc/1/cgroup 2>/dev/null; then c=docker; fi; echo "container $c"`,
  `h=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null); echo "hostname $h"`,
  `echo "self $(${bounded(2, 'getent hosts "$h" 2>/dev/null')} | awk '{print $1}' | tr '\\n' ' ')$(${bounded(2, 'hostname -i 2>/dev/null')}) 127.0.0.1 ::1"`,
].join('\n');

/**
 * "<url>\t<code>\t<exit>\t<addr>": curl's HTTP status (000 when nothing answered) and its exit status; or wget's 200/000
 * and `w<status>:<its stderr on one line>` (BusyBox wget exits 1 for every failure and says why only there); "-" and an
 * empty exit when the host has neither. addr: the first address the url's name resolves to there (an IP literal is
 * itself), empty when it does not resolve or getent is missing. A liveness check, not a trust check: self-signed dev
 * certificates (-k / --no-check-certificate) must not read as down.
 */
export function urlCheck(url: string): string {
  const q = shq(url);
  const name = urlName(url);
  const addr =
    name === null
      ? "''"
      : isIP(name) !== 0
        ? shq(name)
        : `"$(${bounded(2, `getent hosts ${shq(name)} 2>/dev/null`)} | awk 'NR==1{print $1}')"`;
  return [
    `printf '%s\\t' ${q}`,
    `if command -v curl >/dev/null 2>&1; then curl -s -k -o /dev/null --connect-timeout 1 -m 2 -w '%{http_code}' ${q} 2>/dev/null; printf '\\t%s' "$?"`,
    `elif command -v wget >/dev/null 2>&1; then e=$(wget -q --no-check-certificate -T 2 -O /dev/null ${q} 2>&1); r=$?; if [ "$r" = 0 ]; then printf '200\\tw0'; else printf '000\\tw%s:%s' "$r" "$(printf '%s' "$e" | tr '\\t\\n\\r' '   ' | cut -c1-200)"; fi`,
    `else printf '%s\\t' -; fi`,
    `printf '\\t%s\\n' ${addr}`,
  ].join('; ');
}

/**
 * The url part of a host's answer, which parseUrlProbe reads back: the host's environment (when `env`; by default only
 * with a url to check, where it explains why one does not answer there), the URL marker, one check per url.
 */
export function urlSection(urls: string[], env = urls.length > 0): string[] {
  return [
    ...(env ? [ENV_SNIPPET] : []),
    `echo ${MARK.URL}`,
    ...urls.map(urlCheck),
  ];
}

/** One round trip: pm2 state, the host's UTC offset, process tree, listeners, CPU ticks, RSS, command lines, docker-published ports, and one HTTP
 * request per declared url, with the host's environment (container, hostname, own addresses) when there is one. `metrics: false` is the light form
 * for polling: pm2 state, offset, tree, listeners and urls only, no /proc stat, RSS, args or docker passes. */
export function probeScript(
  pm2Bin: string,
  opts: { cpuSample?: boolean; urls?: string[]; metrics?: boolean } = {}
): string {
  return [
    `echo ${MARK.JLIST}`,
    `${pm2Bin} jlist 2>/dev/null; echo "${MARK.JLIST_RC} $?"`,
    // pm2 keeps start times as epoch ms and stamps log lines in the host's wall time: the offset turns one into the other
    `echo ${MARK.CLOCK}`,
    `date '+%z' 2>/dev/null`,
    `echo ${MARK.PS}`,
    `if command -v ps >/dev/null 2>&1; then ps -eo pid,ppid 2>/dev/null || ps -o pid,ppid 2>/dev/null; else ${PS_FALLBACK}; fi`,
    // F=1 once /proc is used for either protocol: an ss that is missing or fails (old iproute2) must not read as "no listeners"
    `F=0`,
    `echo ${MARK.TCP}`,
    `if command -v ss >/dev/null 2>&1 && T=$(ss -ltnp 2>/dev/null); then printf '%s\\n' "$T"; else F=1; echo ${MARK.PROC}; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; fi`,
    `echo ${MARK.UDP}`,
    `if [ "$F" = 0 ] && U=$(ss -lunp 2>/dev/null); then printf '%s\\n' "$U"; else F=1; echo ${MARK.PROC}; cat /proc/net/udp /proc/net/udp6 2>/dev/null; fi`,
    `echo ${MARK.FD}`,
    `if [ "$F" = 1 ]; then ${FD_SCAN}; fi`,
    ...(opts.metrics === false
      ? []
      : [
          `echo ${MARK.STAT}`,
          `echo "CLK $(getconf CLK_TCK 2>/dev/null || echo 100)"`,
          `cat /proc/[0-9]*/stat 2>/dev/null | ${STAT_AWK}`,
          ...(opts.cpuSample
            ? [
                `sleep 0.5 2>/dev/null || sleep 1`,
                `echo ${MARK.STAT2}`,
                `echo "CLK $(getconf CLK_TCK 2>/dev/null || echo 100)"`,
                `cat /proc/[0-9]*/stat 2>/dev/null | ${STAT_AWK}`,
              ]
            : []),
          `echo ${MARK.RSS}`,
          `cat /proc/[0-9]*/status 2>/dev/null | ${RSS_AWK}`,
          `echo ${MARK.ARGS}`,
          `ps -eo pid=,args= 2>/dev/null || ps -o pid,args 2>/dev/null`,
          `echo ${MARK.DOCKER}`,
          `if command -v docker >/dev/null 2>&1; then ${bounded(3, "docker ps --format '{{.Names}}\\t{{.Ports}}' 2>/dev/null")}; fi`,
        ]),
    ...urlSection(opts.urls ?? []),
  ].join('\n');
}

/**
 * Shell for the hex of the 16 bytes before byte position `end` (a shell expression) of the already quoted file `f`.
 * Comparing them with what they were tells a grown file from a replaced or truncated one that grew back past the
 * old position (pm2-logrotate, a flush outside mcproc): size alone cannot.
 */
export const hex16 = (f: string, end: string): string =>
  `$([ ${end} -gt 0 ] && tail -c +$((${end}>16?${end}-15:1)) ${f} 2>/dev/null | head -c $((${end}>16?16:${end})) | od -An -tx1 | tr -d ' \\n')`;

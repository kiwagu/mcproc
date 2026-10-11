export const MARK = {
  JLIST: '__MCPROC_JLIST__', JLIST_RC: '__MCPROC_JLIST_RC__', PS: '__MCPROC_PS__',
  TCP: '__MCPROC_TCP__', UDP: '__MCPROC_UDP__', FD: '__MCPROC_FD__', PROC: '__MCPROC_PROC__',
} as const;

/* /proc/<pid>/stat: "pid (comm) state ppid …"; comm may contain spaces, so cut after the last ")". */
const PS_FALLBACK = `for p in /proc/[0-9]*; do s=$(cat "$p/stat" 2>/dev/null) || continue; r=\${s##*) }; set -- $r; echo "\${p#/proc/} $2"; done`;
/* "<pid> <inode>" for every socket fd; only needed when ss is missing. */
const FD_SCAN = `for p in /proc/[0-9]*; do for f in "$p"/fd/*; do l=$(readlink "$f" 2>/dev/null) || continue; case $l in socket:*) i=\${l#socket:[}; echo "\${p#/proc/} \${i%]}";; esac; done; done`;

/** One round trip: pm2 state, process tree, TCP and UDP listeners, with /proc fallbacks. */
export function probeScript(pm2Bin: string): string {
  return [
    `echo ${MARK.JLIST}`,
    `${pm2Bin} jlist 2>/dev/null; echo "${MARK.JLIST_RC} $?"`,
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
  ].join('\n');
}

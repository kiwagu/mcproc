import { shq } from '../transport/quote.js';
import { COPY_HEADER, WRAPPER_MARK, type RuntimeLock } from './files.js';

export const UNPACK_MARK = '__MCPROC_UNPACK__';
export const LOCK_MARK = '__MCPROC_LOCK__';

export interface HostFacts {
  unameSm: string;
  musl: boolean;
  node: string | null;
  tar: boolean;
  /** libstdc++ present: every nodejs.org Linux build (glibc and musl alike) is linked against it; a bare alpine lacks it. */
  cxx: boolean;
  /** `<rt>/bin/pm2` or `<rt>/bin/node` exists without a valid mcproc lock.json: files mcproc did not write (a dir such as /usr/local). */
  foreignBin: boolean;
  daemonUp: boolean;
  manifest: 'absent' | 'mcproc-copy' | 'hand-written';
  lock: RuntimeLock | null;
}

/** One round trip in plain POSIX sh (busybox and dash run it; bash is not required). */
export function unpackProbeScript(
  runtimeDir: string,
  manifestPath: string
): string {
  return [
    `echo ${UNPACK_MARK}`,
    'uname -sm',
    'if [ -e /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then echo MUSL; fi',
    'if v=$(node -v 2>/dev/null); then echo "NODE $v"; else echo NODE_NONE; fi',
    'if command -v tar >/dev/null 2>&1; then echo TAR_OK; else echo TAR_NONE; fi',
    // one path at a time: `ls a b` fails when ANY is missing, and musl hosts have no ldconfig
    'C=0; for l in /usr/lib/libstdc++.so.6 /lib/libstdc++.so.6 /usr/lib64/libstdc++.so.6 /usr/lib/*-linux-gnu/libstdc++.so.6; do [ -e "$l" ] && C=1; done; if [ "$C" = 1 ] || ldconfig -p 2>/dev/null | grep -q \'libstdc++\\.so\\.6\'; then echo CXX_OK; else echo CXX_NONE; fi',
    `if [ -e ${shq(`${runtimeDir}/bin/pm2`)} ] || [ -e ${shq(`${runtimeDir}/bin/node`)} ] || [ -L ${shq(`${runtimeDir}/bin/node`)} ]; then echo BIN_PRESENT; fi`,
    `if grep -q ${shq(WRAPPER_MARK)} ${shq(`${runtimeDir}/bin/pm2`)} 2>/dev/null; then echo BIN_OURS; fi`, // an unpack cut off before its lock
    // a live daemon, not just a socket file left behind by a dead one
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, for the host's sh
    'H="${PM2_HOME:-$HOME/.pm2}"; if [ -f "$H/pm2.pid" ] && kill -0 "$(cat "$H/pm2.pid")" 2>/dev/null; then echo DAEMON_UP; fi',
    `if [ -f ${shq(manifestPath)} ]; then printf 'MANIFEST %s\\n' "$(head -n 1 ${shq(manifestPath)})"; else echo MANIFEST_NONE; fi`,
    `echo ${LOCK_MARK}`,
    `cat ${shq(`${runtimeDir}/lock.json`)} 2>/dev/null || true`,
  ].join('\n');
}

/** A lock.json mcproc wrote (its own fields), else null: an empty or foreign file proves nothing about bin/. */
function mcprocLock(v: unknown): RuntimeLock | null {
  const o = v as Partial<RuntimeLock> | null;
  return o &&
    typeof o === 'object' &&
    typeof o.mcproc === 'string' &&
    typeof o.pm2 === 'string' &&
    typeof o.pm2_sha256 === 'string'
    ? (o as RuntimeLock)
    : null;
}

export function parseUnpackProbe(stdout: string): HostFacts {
  const start = stdout.indexOf(UNPACK_MARK);
  const lockAt = stdout.indexOf(LOCK_MARK);
  const head = stdout
    .slice(
      start < 0 ? 0 : start + UNPACK_MARK.length,
      lockAt < 0 ? undefined : lockAt
    )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lockText =
    lockAt < 0 ? '' : stdout.slice(lockAt + LOCK_MARK.length).trim();
  let lock: RuntimeLock | null = null;
  if (lockText) {
    try {
      lock = mcprocLock(JSON.parse(lockText));
    } catch {
      lock = null;
    }
  }
  const nodeLine = head.find((l) => l.startsWith('NODE '));
  const mf = head.find((l) => l.startsWith('MANIFEST'));
  const manifest: HostFacts['manifest'] =
    !mf || mf === 'MANIFEST_NONE'
      ? 'absent'
      : mf.slice('MANIFEST'.length).trim().startsWith(COPY_HEADER)
        ? 'mcproc-copy'
        : 'hand-written';
  // bin/ is ours with a lock mcproc wrote, or with the wrapper it writes (switched before the node link, so an unpack cut off in between still has it)
  return {
    unameSm: head[0] ?? '',
    musl: head.includes('MUSL'),
    node: nodeLine ? nodeLine.slice(5).trim() : null,
    tar: head.includes('TAR_OK'),
    cxx: head.includes('CXX_OK'),
    foreignBin:
      head.includes('BIN_PRESENT') &&
      lock === null &&
      !head.includes('BIN_OURS'),
    daemonUp: head.includes('DAEMON_UP'),
    manifest,
    lock,
  };
}

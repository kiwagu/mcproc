import { MARK } from '../../src/shell/snippets.js';

/** Assemble the stdout of probeScript() from parts, for tests. */
export function probeOut(parts: { jlist?: string; rc?: number; ps?: string; tcp?: string; udp?: string; fd?: string }): string {
  return [MARK.JLIST, parts.jlist ?? '[]', `${MARK.JLIST_RC} ${parts.rc ?? 0}`, MARK.PS, parts.ps ?? '', MARK.TCP, parts.tcp ?? '', MARK.UDP, parts.udp ?? '', MARK.FD, parts.fd ?? ''].join('\n');
}

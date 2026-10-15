import { MARK } from '../../src/shell/snippets.js';

/**
 * Assemble the stdout of probeScript() from parts, for tests. `clock` is the host's `date +%z` (default +0000); `env`
 * is the environment section, written only when given.
 */
export function probeOut(parts: {
  jlist?: string;
  rc?: number;
  clock?: string;
  ps?: string;
  tcp?: string;
  udp?: string;
  fd?: string;
  stat?: string;
  stat2?: string;
  rss?: string;
  args?: string;
  docker?: string;
  env?: string;
  urls?: string;
}): string {
  const out = [
    MARK.JLIST,
    parts.jlist ?? '[]',
    `${MARK.JLIST_RC} ${parts.rc ?? 0}`,
    MARK.CLOCK,
    parts.clock ?? '+0000',
    MARK.PS,
    parts.ps ?? '',
    MARK.TCP,
    parts.tcp ?? '',
    MARK.UDP,
    parts.udp ?? '',
    MARK.FD,
    parts.fd ?? '',
    MARK.STAT,
    parts.stat ?? '',
  ];
  if (parts.stat2 !== undefined) out.push(MARK.STAT2, parts.stat2);
  out.push(
    MARK.RSS,
    parts.rss ?? '',
    MARK.ARGS,
    parts.args ?? '',
    MARK.DOCKER,
    parts.docker ?? ''
  );
  if (parts.env !== undefined) out.push(MARK.ENV, parts.env); // the probe prints it only when it checks a url
  out.push(MARK.URL, parts.urls ?? '');
  return out.join('\n');
}

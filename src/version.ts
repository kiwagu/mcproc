import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string;
};
export const VERSION: string = pkg.version;

const NUM = '0|[1-9]\\d*';
const PRE = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
/** A semver version: x.y.z without leading zeros, optionally a pre-release (`-rc.1`) and build metadata (`+abc`). */
export const VERSION_PATTERN = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}(?:\\.${PRE})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`
);

/** Two digit strings without leading zeros, compared exactly at any length. */
const byDigits = (a: string, b: string): number =>
  a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;

/** Orders two versions like semver: x.y.z numerically, a pre-release before its release, build metadata ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_PATTERN.exec(a);
  const pb = VERSION_PATTERN.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const d = byDigits(pa[i], pb[i]);
    if (d !== 0) return d;
  }
  const [ra, rb] = [pa[4], pb[4]];
  if (ra === rb) return 0;
  if (ra === undefined) return 1;
  if (rb === undefined) return -1;
  const xa = ra.split('.');
  const xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    if (xa[i] === xb[i]) continue;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) return byDigits(xa[i], xb[i]);
    if (na !== nb) return na ? -1 : 1;
    return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

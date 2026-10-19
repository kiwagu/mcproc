import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as {
  version: string;
};
export const VERSION: string = pkg.version;

/** A release version: x.y.z, optionally with a pre-release (`-rc.1`) and build metadata (`+abc`). */
export const VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Orders two versions like semver: x.y.z numerically, a pre-release before its release, build metadata ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION_PATTERN.exec(a);
  const pb = VERSION_PATTERN.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
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
    if (na && nb) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

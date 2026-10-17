/** A size as the manifest writes it (`512M`, `1.5G`, `100K`, a bare number of MiB), in MiB, rounded up; a decimal without a unit is refused so `1.5` cannot mean 1.5 MiB by accident. */
export function parseSizeMib(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgtKMGT])?(?:i?[bB])?\s*$/.exec(s);
  if (!m || (m[1].includes('.') && !m[2]))
    throw new Error(
      `not a size: "${s}" (use <n>K, <n>M, <n>G or a whole number of MiB)`
    );
  const n = Number(m[1]);
  const unit = (m[2] ?? 'M').toUpperCase();
  const mib =
    unit === 'K'
      ? n / 1024
      : unit === 'G'
        ? n * 1024
        : unit === 'T'
          ? n * 1024 * 1024
          : n;
  return Math.max(0, Math.ceil(mib));
}

/** A percent as the manifest writes it (`10%`, `12.5 %`), as a ratio in [0, 1]. */
export function parsePercent(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(s);
  if (!m) throw new Error(`not a percent: "${s}" (use <n>%)`);
  const n = Number(m[1]);
  if (n > 100) throw new Error(`not a percent: "${s}" is above 100%`);
  return n / 100;
}

/** MiB for a human: `512M` under a GiB, `1.5G` from there, one decimal. */
export function fmtMib(mib: number): string {
  if (mib < 1024) return `${Math.round(mib)}M`;
  return `${(mib / 1024).toFixed(1)}G`;
}

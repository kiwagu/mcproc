// @pm2/blessed ships no types; the TUI uses a small, dynamically typed surface of it.
declare module '@pm2/blessed';
declare module '@pm2/blessed/lib/unicode.js' {
  /** columns blessed gives one code point (0 for controls and combining marks, 2 for the wide CJK ranges) */
  export function charWidth(point: number): number;
  /** `wide`: the BMP characters blessed draws with a placeholder cell after them */
  export const chars: { wide: RegExp; all: RegExp };
}

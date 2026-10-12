import { charWidth, chars } from '@pm2/blessed/lib/unicode.js';
import { keepSgr, SGR_RE, stripAnsi } from '../core/logs.js';

/*
 * Text for the monit screen. blessed keeps a model of the cells it has drawn and later redraws only the cells that
 * changed. It cuts a line at the pane width counted in UTF-16 units (plus a placeholder after each wide CJK character)
 * and draws each character as wide as its own table (charWidth) says. Wherever that width differs from the columns a
 * terminal gives the character, the rest of the row lands off by a column and later redraws leave old characters
 * behind. Emoji are where they differ: 🚀 and ✅ are 1 in blessed's table and 2 on a terminal, and for ⚠️, flags or
 * ZWJ families terminals disagree among themselves. So the screen shows text in which every character has the same
 * width in blessed's model as on a terminal: narrow characters, the wide CJK ranges blessed handles consistently, and
 * the combining marks both draw at zero width (Indic, Thai, accents). Characters outside the BMP become ?, wide CJK
 * extensions included: blessed's surrogate handling is not worth the rare name it would keep.
 */

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const REGIONAL = /\p{Regional_Indicator}/u;
const KEYCAP = /^[0-9#*]\uFE0F?\u20E3$/;
const INVISIBLE = /[\p{Cc}\p{Cf}]/u; // controls and zero-width format characters (ZWJ, ZWSP, BOM, selectors are marks)
const LINE_BREAK = /\r\n|[\n\v\f\u0085\u2028\u2029]/g;
const MARK = /\p{M}/u;
const SPACING_MARK = /\p{Mc}/u;
const BLESSED_WIDE = new RegExp(chars.wide.source); // the characters blessed gives a placeholder cell
/** status emoji with a narrow look-alike that keeps their meaning */
const NARROW: Record<string, string> = {
  '✅': '✔',
  '❌': '✖',
  '❎': '✖',
  '❗': '!',
  '❕': '!',
  '❓': '?',
  '❔': '?',
};
const TAB = 8;

/**
 * Width of screen text the way blessed's line cut counts it: one per character, two per wide one, nothing for a
 * color code. A kept zero-width mark counts one here and none on the terminal, so text that fits always fits.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s.includes('\x1b') ? s.replace(SGR_RE, '') : s)
    w += charWidth(ch.codePointAt(0)!) === 2 ? 2 : 1;
  return w;
}

/** Terminal columns of screen text (marks take none): what tab stops are counted in. */
function columns(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** A mark stays when blessed and terminals give it the same width: zero for a combining mark it knows, one for a spacing mark. */
function keepMark(ch: string, cp: number): boolean {
  return cp <= 0xffff && charWidth(cp) === (SPACING_MARK.test(ch) ? 1 : 0);
}

function cluster(c: string): string {
  if (c === '\t') return c;
  const first = String.fromCodePoint(c.codePointAt(0)!);
  if (REGIONAL.test(first))
    return [...c]
      .filter((ch) => REGIONAL.test(ch))
      .map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 65))
      .join(''); // 🇺🇦 → UA
  if (KEYCAP.test(c)) return c[0]; // 1️⃣ → 1
  if (PICTOGRAPH.test(first) || EMOJI_PRESENTATION.test(first)) {
    if (NARROW[first]) return NARROW[first];
    // a symbol drawn as text by default (⚠ ✔ ❤) keeps its narrow form without the emoji selector; anything else is an emoji
    return !EMOJI_PRESENTATION.test(first) && first.length === 1 ? first : '?';
  }
  let out = '';
  for (const ch of c) {
    if (INVISIBLE.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    if (MARK.test(ch)) {
      if (keepMark(ch, cp)) out += ch;
      continue;
    }
    if (cp > 0xffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '?';
      continue;
    }
    // blessed has two tables of wide characters (the placeholder one and charWidth); where they disagree, it draws off by one
    out += (charWidth(cp) === 2) === BLESSED_WIDE.test(ch) ? ch : '?';
  }
  return out;
}

/**
 * blessed reads only `ESC [ digits ; m`; the colon form (`38:2::r:g:b` true color, `38:5:n`, `4:3` curly underline)
 * would show as text. Colors and underline get their semicolon form, any other colon code goes (never an empty code,
 * which would read as a reset).
 */
function blessedSgr(code: string): string {
  if (!code.includes(':')) return code;
  const groups = code
    .slice(2, -1)
    .split(';')
    .flatMap((g) => {
      if (!g.includes(':')) return [g];
      const [kind, mode, ...rest] = g.split(':');
      if (kind === '4') return ['4'];
      if (!['38', '48', '58'].includes(kind)) return [];
      if (mode === '5' && rest[0]) return [`${kind};5;${rest[0]}`];
      if (mode === '2' && rest.length >= 3)
        return [`${kind};2;${rest.slice(-3).join(';')}`];
      return [];
    });
  return groups.length ? `\x1b[${groups.join(';')}m` : '';
}

const SGR_SPLIT = /(\x1b\[[0-9;:]*m)/;
const visible = (t: string) => t.replace(SGR_RE, '');

/**
 * One log line or label as the screen shows it: the part after the last carriage return (what a terminal shows), line
 * breaks as spaces, tabs expanded to 8-column stops, every character as described above. Without `colors` all escapes
 * go; with it an app's color codes stay where they are (one set before a carriage return still applies after it) and
 * every other escape goes.
 */
export function screenText(
  input: string,
  opts: { colors?: boolean } = {}
): string {
  const parts = (opts.colors ? keepSgr(input) : stripAnsi(input))
    .replace(/\r\n/g, '\n')
    .split('\r');
  let last = parts.length - 1;
  while (last > 0 && visible(parts[last]) === '') last--;
  const carried = parts
    .slice(0, last)
    .flatMap((p) => p.match(SGR_RE) ?? [])
    .join('');
  let out = '';
  let col = 0;
  for (const piece of (carried + parts[last]).split(SGR_SPLIT)) {
    if (SGR_SPLIT.test(piece) && piece.startsWith('\x1b')) {
      out += blessedSgr(piece);
      continue;
    }
    for (const { segment } of segmenter.segment(
      piece.replace(LINE_BREAK, ' ').normalize('NFC')
    )) {
      const c = cluster(segment);
      if (c === '\t') {
        const n = TAB - (col % TAB);
        out += ' '.repeat(n);
        col += n;
        continue;
      }
      out += c;
      col += columns(c);
    }
  }
  return out;
}

/** Cut screen text to `width` (as displayWidth counts), with an ellipsis when something was cut. */
export function cutWidth(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

import { charWidth, chars } from '@pm2/blessed/lib/unicode.js';
import { stripAnsi } from '../core/logs.js';

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
const NARROW: Record<string, string> = { '✅': '✔', '❌': '✖', '❎': '✖', '❗': '!', '❕': '!', '❓': '?', '❔': '?' };
const TAB = 8;

/**
 * Width of screen text the way blessed's line cut counts it: one per character, two per wide one. A kept zero-width
 * mark counts one here and none on the terminal, so text that fits this width always fits the columns.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!) === 2 ? 2 : 1;
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
  if (REGIONAL.test(first)) return [...c].filter((ch) => REGIONAL.test(ch)).map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0x1f1e6 + 65)).join(''); // 🇺🇦 → UA
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
    if (MARK.test(ch)) { if (keepMark(ch, cp)) out += ch; continue; }
    if (cp > 0xffff || (cp >= 0xd800 && cp <= 0xdfff)) { out += '?'; continue; }
    // blessed has two tables of wide characters (the placeholder one and charWidth); where they disagree, it draws off by one
    out += (charWidth(cp) === 2) === BLESSED_WIDE.test(ch) ? ch : '?';
  }
  return out;
}

/**
 * One log line or label as the screen shows it: color codes gone, the part after the last carriage return (what a
 * terminal shows), line breaks as spaces, tabs expanded to 8-column stops, every character as described above.
 */
export function screenText(input: string): string {
  const parts = stripAnsi(input).replace(/\r\n/g, '\n').split('\r');
  let text = '';
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== '') { text = parts[i]; break; }
  let out = '';
  let col = 0;
  for (const { segment } of segmenter.segment(text.replace(LINE_BREAK, ' ').normalize('NFC'))) {
    const piece = cluster(segment);
    if (piece === '\t') { const n = TAB - (col % TAB); out += ' '.repeat(n); col += n; continue; }
    out += piece;
    col += columns(piece);
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
  return out + '…';
}

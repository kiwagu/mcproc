import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { screenText, displayWidth } from '../../src/monit/screentext.js';

const require = createRequire(import.meta.url);
const blessedUnicode = require('@pm2/blessed/lib/unicode.js') as { chars: { all: RegExp }; charWidth(cp: number): number };
/** How many units blessed's line cut counts for a string: one per UTF-16 unit, plus a placeholder after each wide char. */
const blessedUnits = (s: string) => s.replace(blessedUnicode.chars.all, '$1\x03').length;

describe('screenText', () => {
  it('emoji, whose width terminals disagree on, become narrow stand-ins; the common status ones keep their meaning', () => {
    expect(screenText('msg=🚀 AI API is running on: http://localhost:23200/api')).toBe('msg=? AI API is running on: http://localhost:23200/api');
    expect(screenText('✅ applied, ❌ failed, ❎ skipped, ❗ note, ❓ unknown')).toBe('✔ applied, ✖ failed, ✖ skipped, ! note, ? unknown');
    expect(screenText('⚠️ deprecated, ✔️ fine, ❤️ thanks')).toBe('⚠ deprecated, ✔ fine, ❤ thanks'); // text-default symbols keep their narrow form
    expect(screenText('family 👨‍👩‍👧 flag 🇺🇦 thumbs 👍🏽 keycap 1️⃣ done')).toBe('family ? flag UA thumbs ? keycap 1 done');
  });
  it('a carriage return overwrites the line on a terminal: only the last segment is shown', () => {
    expect(screenText('progress 10%\rprogress 50%\rprogress 100%')).toBe('progress 100%');
    expect(screenText('done\r')).toBe('done');
  });
  it('tabs expand to the next 8-column stop; control and zero-width format characters go', () => {
    expect(screenText('a\tb')).toBe('a       b');
    expect(screenText('abcdefgh\tx')).toBe('abcdefgh        x');
    expect(screenText('中\tx')).toBe('中      x'); // a wide char takes two columns of the stop
    expect(screenText('a\u0007b\u0000c\u007fde')).toBe('abcde');
    expect(screenText('a​b‍c﻿d⁠e')).toBe('abcde');
  });
  it('combining marks that blessed and terminals both draw at zero width stay, after NFC; scripts built on them stay readable', () => {
    expect(screenText('é й x́')).toBe('é й x́');
    for (const s of ['नमस्ते दुनिया', 'สวัสดีครับ']) expect(screenText(s)).toBe(s); // Hindi, Thai
  });
  it('line breaks inside one line become spaces, and color codes go instead of showing as text', () => {
    expect(screenText('host a: boom\nhost b: boom\u2028c\fd\u000be\u0085f')).toBe('host a: boom host b: boom c d e f');
    expect(screenText('\u001b[31mred\u001b[0m ok')).toBe('red ok');
  });
  it('wide characters blessed is inconsistent about (a placeholder cell but width 1, or width 2 but no placeholder) become ?', () => {
    expect(screenText('令和㋿ ㉈ ䷀ ꥠ')).toBe('令和? ? ? ?');
  });
  it('characters outside the BMP that are not emoji (blessed would measure them as two units) become ?', () => {
    expect(screenText('\u{1D70B} and \u{2000B}')).toBe('? and ?');
    expect(screenText('lone \ud83d surrogate')).toBe('lone ? surrogate');
  });
  it('plain text, Cyrillic and CJK pass unchanged', () => {
    for (const s of ['plain ASCII line: {braces} [brackets] 100%', 'Привет, мир — ёлка', '中文 字符 and 한국어', '· ▶ ✓ ✗ ─ …']) expect(screenText(s)).toBe(s);
  });
  it('whatever comes in, what goes out is measured the way blessed measures it, and every mark kept has the width blessed gives it on a terminal too', () => {
    const corpus = [
      '🚀✅⚠️👨‍👩‍👧🇺🇦👍🏽1️⃣', 'ＡＢＣ fullwidth ！', '한국어 텍스트', '。、「引用」　end', 'ｶﾀｶﾅ halfwidth',
      'नमस्ते สวัสดี ស្វាគមន៍', 'x́̂̃ q\u{1D167}',
      '㋿㉈䷀ꥠ', 'a\tb\tc', '中文\t🚀', 'x́‍🏳️‍🌈', '\u0007\u001b[31mred', 'mixed ⌚ ⏳ ☕ ♻️ ⭐ 🙂 text', '\u{1D70B}\u{1D465} \u{2000B}',
    ];
    for (const s of corpus) {
      const out = screenText(s);
      expect(out, s).not.toMatch(/\p{Emoji_Presentation}|\p{Regional_Indicator}|\p{Cf}|\p{Cc}|[\ud800-\udfff]/u);
      expect(blessedUnits(out), s).toBe(displayWidth(out));
      for (const ch of out.match(/\p{M}/gu) ?? []) expect(blessedUnicode.charWidth(ch.codePointAt(0)!), `${s}: U+${ch.codePointAt(0)!.toString(16)}`).toBe(/\p{Mc}/u.test(ch) ? 1 : 0);
    }
  });
});

describe('displayWidth', () => {
  it('counts what blessed\'s line cut counts: one per character (a zero-width mark too), two per wide one', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('a中b')).toBe(4);
    expect(displayWidth('x́')).toBe(2);
  });
});

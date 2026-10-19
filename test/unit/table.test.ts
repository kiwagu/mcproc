import { describe, it, expect } from 'vitest';
import { table, fitWidths, wrapCell, FLEX_MIN } from '../../src/mcp/render.js';
import { cutStartWidth, displayWidth } from '../../src/monit/screentext.js';

const rows = [
  ['ID', 'NOTE', 'X'],
  ['a1', 'alpha beta gamma delta', 'z'],
];

describe('table', () => {
  it('without a width prints what it printed before: every column at its longest cell', () => {
    expect(table(rows)).toBe(
      'ID  NOTE                    X\na1  alpha beta gamma delta  z'
    );
  });
  it('a table that fits its width is the same as without one', () => {
    expect(table(rows, { width: 80, flex: [1] })).toBe(table(rows));
  });
  it('wrap: the free-text column shrinks to the width and continues on the next lines, the other cells blank', () => {
    expect(table(rows, { width: 20, flex: [1], mode: 'wrap' })).toBe(
      ['ID  NOTE           X', 'a1  alpha beta     z', '    gamma delta'].join(
        '\n'
      )
    );
  });
  it('fit: one line per row, a cut cell ends with an ellipsis; cutStart columns lose their start', () => {
    expect(table(rows, { width: 20, flex: [1], mode: 'fit' })).toBe(
      ['ID  NOTE           X', 'a1  alpha beta g…  z'].join('\n')
    );
    const paths = [['ROOT'], ['/home/u/repos/alpha/demo']];
    expect(
      table(paths, { width: 13, flex: [0], mode: 'fit', cutStart: [0] })
    ).toBe('ROOT\n…s/alpha/demo');
  });
  it('a free-text column never shrinks below FLEX_MIN (or its own width); the rest is left to the terminal', () => {
    const long = [
      ['N', 'K'],
      ['x'.repeat(40), 'k'],
    ];
    const out = table(long, { width: 5, flex: [0], mode: 'wrap' }).split('\n');
    expect(out[0]).toBe(`N${' '.repeat(FLEX_MIN + 1)}K`);
    expect(out.slice(1).map((l) => l.trimEnd())).toEqual([
      `${'x'.repeat(12)}  k`,
      'x'.repeat(12),
      'x'.repeat(12),
      'x'.repeat(4),
    ]);
  });
  it('widths are terminal columns: color codes count nothing, wide characters two', () => {
    const colored = [
      ['A', 'B'],
      ['\x1b[31mred\x1b[0m', 'x'],
    ];
    expect(table(colored, { width: 40 }).split('\n')[1]).toBe(
      '\x1b[31mred\x1b[0m  x'
    );
    const wide = [
      ['A', 'B'],
      ['漢字', 'x'],
    ];
    expect(table(wide, { width: 40 }).split('\n')[0]).toBe('A     B');
  });
});

describe('fitWidths', () => {
  it('shrinks the widest free-text column first, one column at a time, never a fixed one', () => {
    // 63 → 40: the 30 comes down to 20, then the two take turns (a tie shrinks the first)
    expect(fitWidths([2, 30, 20, 5], [1, 2], 40)).toEqual([2, 13, 14, 5]);
    expect(fitWidths([2, 30, 5], [], 10)).toEqual([2, 30, 5]);
  });
});

describe('wrapCell', () => {
  it('breaks after spaces, slashes, commas, colons and dashes; splits a word longer than the width', () => {
    expect(wrapCell('NOT_STARTED: cannot launch the watcher', 14)).toEqual([
      'NOT_STARTED:',
      'cannot launch',
      'the watcher',
    ]);
    expect(wrapCell('/home/u/.local/bin/mcproc', 12)).toEqual([
      '/home/u/',
      '.local/bin/',
      'mcproc',
    ]);
    expect(wrapCell('abcdefghijklmnop', 6)).toEqual([
      'abcdef',
      'ghijkl',
      'mnop',
    ]);
    expect(wrapCell('short', 10)).toEqual(['short']);
  });
});

describe('cutStartWidth', () => {
  it('keeps the end of the text and marks the cut at the start', () => {
    expect(cutStartWidth('/home/u/repos/alpha/demo', 13)).toBe('…s/alpha/demo');
    expect(displayWidth(cutStartWidth('/home/u/repos/alpha/demo', 13))).toBe(
      13
    );
    expect(cutStartWidth('short', 13)).toBe('short');
  });
});

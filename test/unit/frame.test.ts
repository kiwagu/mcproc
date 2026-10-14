import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../../src/monit/state.js';
import {
  renderFrame,
  frameToText,
  paneTitle,
  wrapText,
  logsTitle,
  scrollTo,
} from '../../src/monit/frame.js';
import { displayWidth } from '../../src/monit/screentext.js';
import type { LsRow } from '../../src/core/list.js';

const web: LsRow = {
  app: 'web',
  host: 'local',
  kind: 'server',
  description: 'dashboard (Next dev)',
  status: 'online',
  pm_id: 1,
  pid: 971175,
  uptime_ms: 22 * 60_000,
  started: null,
  restarts: 0,
  cpu: 84.4,
  memory: 2_200_000_000,
  procs: 3,
  runtime:
    'next-server (v16.2.9) with a very long tail of arguments that must be cut',
  pm2_cpu: 0,
  pm2_memory: 9_000_000,
  exit_code: null,
  metrics_source: 'tree',
  url: 'http://localhost:3100/',
  url_status: 'ok',
  url_code: 200,
  ports: {
    actual: [
      {
        proto: 'tcp',
        addr: '*',
        port: 3100,
        pid: 971200,
        pids: [971200],
        command: 'next-server',
        container: null,
      },
    ],
    declared: [3100],
    checks: [{ port: 3100, status: 'listening' }],
    undeclared: [],
  },
};
const docs: LsRow = {
  ...web,
  app: 'docs',
  pid: 1,
  url: 'http://localhost:3200/',
  url_status: 'unchecked',
  url_code: null,
  ports: {
    actual: [],
    declared: [3200],
    checks: [
      {
        port: 3200,
        status: 'declared-not-listening',
        held_by: { pid: null, command: null, container: 'some-container' },
      },
    ],
    undeclared: [],
  },
};
const base = () =>
  reduce(
    initialState({
      project: 'zero-memory',
      host: 'local',
      hosts: ['local'],
      apps: {
        web: {
          description: 'dashboard (Next dev)',
          run: 'bun run dev',
          cwd: 'apps/web',
          pm2Name: 'zero-memory-web',
        },
        docs: {
          description: 'docs',
          run: 'bun run dev',
          cwd: 'apps/docs',
          pm2Name: 'zero-memory-docs',
        },
      },
    }),
    { type: 'rows', rows: [web, docs], at: new Date('2026-10-11T13:41:07') }
  );

describe('renderFrame', () => {
  it('fits an 80-column terminal: no line wider than 80, marker on the selected row, ports visible', () => {
    const f = renderFrame(base(), { width: 80, height: 24 });
    for (const line of [
      f.header,
      ...f.table,
      ...f.logs,
      ...f.details,
      f.footer,
    ])
      expect(line.length).toBeLessThanOrEqual(80);
    expect(f.table[1]).toMatch(
      /^▶web\s+online\s+22m\s+2\.05G\s+84\.4%\s+:3100 ✓/
    );
    expect(f.table[2]).toMatch(/^ docs/);
    expect(f.table[2]).toContain(':3200 ✗');
  });
  it('wide terminal shows the runtime and the details name the RSS sum and the pm2 root value', () => {
    const f = renderFrame(base(), { width: 160, height: 40 });
    expect(f.table[1]).toContain('next-server (v16.2.9)');
    expect(f.details.join('\n')).toContain('RSS sum');
    expect(f.details.join('\n')).toContain('pm2 root: 8.6M');
    expect(f.details.join('\n')).toContain('zero-memory-web');
    expect(f.details.join('\n')).toContain(':3100 ✓ pid 971200 next-server');
    expect(f.table[1]).toContain('http://localhost:3100/ ✓ 200');
    expect(f.table[2]).toContain('http://localhost:3200/');
    expect(f.table[2]).not.toContain('http://localhost:3200/ ✓');
    expect(f.details.join('\n')).toContain('url: http://localhost:3100/ ✓ 200');
  });
  it('footer carries the error or the notice; logs are the tail that fits', () => {
    let s = reduce(base(), {
      type: 'error',
      message: 'TRANSPORT_FAILED: ssh stand: Connection refused',
    });
    expect(renderFrame(s, { width: 120, height: 30 }).footer).toContain(
      'ERROR: TRANSPORT_FAILED'
    );
    expect(renderFrame(s, { width: 80, height: 24 }).footer).toMatch(
      /^ERROR: TRANSPORT_FAILED: ssh stand: Connection refused/
    ); // the error leads: a narrow terminal must not hide it behind the key legend
    expect(renderFrame(base(), { width: 80, height: 24 }).footer).toMatch(
      /^j\/k app/
    );
    s = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: Array.from({ length: 50 }, (_, i) => ({
        stream: 'out' as const,
        text: `2026-10-11T13:00:${String(i).padStart(2, '0')}: line ${i}`,
      })),
    });
    const f = renderFrame(s, { width: 120, height: 24 });
    expect(f.logs.length).toBe(10); // 24 rows − header − 3 table lines − 3 pane titles − 6 details − footer: borderless panes, no frame rows
    expect(f.logs.at(-1)).toContain('line 49');
    expect(frameToText(f)).toContain('line 49');
  });
  it('log lines wrap at the width with indented continuations instead of being cut; the pane shows the last rows that fit', () => {
    expect(wrapText('abcdefghij', 4, 1)).toEqual(['abcd', ' efg', ' hij']);
    expect(wrapText('short', 10, 2)).toEqual(['short']);
    const long = 'x'.repeat(150);
    const s = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: [
        { stream: 'out', text: 'first' },
        { stream: 'err', text: long },
      ],
    });
    const f = renderFrame(s, { width: 60, height: 30 });
    expect(f.logs[0]).toBe('  first');
    expect(f.logs.slice(1)).toEqual([
      `! ${'x'.repeat(58)}`,
      `  ${'x'.repeat(58)}`,
      `  ${'x'.repeat(34)}`,
    ]);
    for (const line of f.logs) expect(line.length).toBeLessThanOrEqual(60);
    const tiny = renderFrame(s, { width: 60, height: 14 }); // 3 rows of logs fit: the tail of the wrapped text, not its head
    expect(tiny.logs.at(-1)).toBe(`  ${'x'.repeat(34)}`);
    expect(tiny.logs).toHaveLength(3);
  });
  it('a scrolled log pane hides that many newest entries and shows the tail of the rest; the footer names the scroll keys', () => {
    let s = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: Array.from({ length: 30 }, (_, i) => ({
        stream: 'out' as const,
        text: `2026-10-11T13:00:${String(i).padStart(2, '0')}: line ${i}`,
      })),
    });
    expect(renderFrame(s, { width: 120, height: 24 }).logs.at(-1)).toContain(
      'line 29'
    );
    s = reduce(s, { type: 'scroll', delta: 5 });
    const f = renderFrame(s, { width: 120, height: 24 });
    expect(f.logs.at(-1)).toContain('line 24');
    expect(f.logs).toHaveLength(10);
    expect(f.footer).toContain('↑↓ scroll');
    expect(f.footer).toContain('j/k app');
    let flat = reduce(reduce(base(), { type: 'view', view: 'flat' }), {
      type: 'logs',
      app: 'web',
      lines: Array.from({ length: 30 }, (_, i) => ({
        stream: 'out' as const,
        text: `line ${i}`,
      })),
    });
    flat = reduce(flat, { type: 'scroll', delta: 3 });
    expect(renderFrame(flat, { width: 120, height: 24 }).logs.at(-1)).toContain(
      'line 26'
    );
  });
  it('scrolling stops at the top with a full pane (the view never shrinks) and the frame reports the ceiling', () => {
    let s = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: Array.from({ length: 30 }, (_, i) => ({
        stream: 'out' as const,
        text: `line ${i}`,
      })),
    });
    s = reduce(s, { type: 'scroll', delta: 100, max: 1000 });
    const f = renderFrame(s, { width: 120, height: 24 }); // 10 log rows
    expect(f.logs).toHaveLength(10);
    expect(f.logs[0]).toBe('  line 0');
    expect(f.logs[9]).toBe('  line 9');
    expect(f.maxScroll).toBe(20);
    expect(f.scroll).toBe(20);
    const long = 'x'.repeat(150); // 3 rows each at width 60
    let w = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: Array.from({ length: 4 }, () => ({
        stream: 'err' as const,
        text: long,
      })),
    });
    w = reduce(w, { type: 'scroll', delta: 50, max: 50 });
    const g = renderFrame(w, { width: 60, height: 14 }); // 3 log rows: one wrapped entry fills the pane
    expect(g.maxScroll).toBe(3);
    expect(g.logs).toEqual([
      `! ${'x'.repeat(58)}`,
      `  ${'x'.repeat(58)}`,
      `  ${'x'.repeat(34)}`,
    ]);
  });
  it('every row of an entry that wraps taller than the pane can be scrolled to, row by row, up to its first', () => {
    const size = { width: 60, height: 14 }; // 3 log rows
    const long = Array.from({ length: 30 }, (_, i) =>
      `c${String(i).padStart(2, '0')}`.padEnd(58, '.')
    ).join(''); // 30 rows at width 60
    let s = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: [
        { stream: 'out', text: 'before' },
        { stream: 'out', text: long },
        { stream: 'out', text: 'after' },
      ],
    });
    const go = (delta: number) => {
      s = reduce(s, { type: 'scroll', delta, to: scrollTo(s, size, delta) });
      return renderFrame(s, size).logs;
    };
    expect(renderFrame(s, size).logs.at(-1)).toBe('  after');
    expect(go(1).map((l) => l.slice(2, 5))).toEqual(['c27', 'c28', 'c29']); // one row up: the end of the long entry
    expect(go(10).map((l) => l.slice(2, 5))).toEqual(['c17', 'c18', 'c19']);
    expect(go(Infinity)).toEqual([
      '  before',
      `  ${'c00'.padEnd(58, '.')}`,
      `  ${'c01'.padEnd(58, '.')}`,
    ]); // Home: the top, the pane still full
    expect(go(1)).toEqual([
      '  before',
      `  ${'c00'.padEnd(58, '.')}`,
      `  ${'c01'.padEnd(58, '.')}`,
    ]); // nothing above it
    expect(go(-Infinity).at(-1)).toBe('  after'); // End: the tail
    const home = scrollTo(s, size, Infinity);
    let stepped = s;
    for (let i = 0; i < 100; i++)
      stepped = reduce(stepped, {
        type: 'scroll',
        delta: 1,
        to: scrollTo(stepped, size, 1),
      });
    expect(home).toEqual({
      entries: stepped.logScroll,
      rows: stepped.logRowShift,
    }); // Home lands where single steps up stop
    const short = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: [{ stream: 'out', text: 'only' }],
    });
    expect(scrollTo(short, size, Infinity)).toEqual({ entries: 0, rows: 0 }); // less than a pane: nothing to scroll
  });
  it("flat view: no table or details, every app's lines labeled and padded, continuations indented under the text, f returns", () => {
    let s = reduce(base(), { type: 'view', view: 'flat' });
    s = reduce(s, {
      type: 'logs',
      app: 'web',
      lines: [{ stream: 'out', text: '2026-10-11T13:00:07: hello' }],
    });
    s = reduce(s, {
      type: 'logs',
      app: 'docs',
      lines: [
        { stream: 'err', text: `2026-10-11T13:00:08: ${'y'.repeat(80)}` },
      ],
    });
    const f = renderFrame(s, { width: 60, height: 20 });
    expect(f.table).toEqual([]);
    expect(f.details).toEqual([]);
    expect(f.logs[0]).toBe('web  | 2026-10-11T13:00:07: hello');
    expect(f.logs[1]).toBe(
      `docs ! 2026-10-11T13:00:08: ${'y'.repeat(60 - 28)}`
    );
    expect(f.logs[2]).toMatch(/^ {7}y+$/);
    expect(f.footer).toContain('f dashboard');
    expect(f.footer).not.toContain('r restart');
    expect(frameToText(f)).toContain('web  | 2026-10-11T13:00:07: hello');
  });
  it('pane titles are one full-width rule with the label inset, so a selection copies text, never a frame', () => {
    expect(paneTitle('apps', 20)).toBe(`── apps ${'─'.repeat(12)}`);
    expect(paneTitle('logs · server · both', 10)).toHaveLength(10);
    expect(paneTitle('logs · server · both', 10)).toMatch(/^── logs/);
  });
  it('rows from more than one host get a HOST column; the details name the host the app runs on', () => {
    const s = reduce(base(), {
      type: 'rows',
      rows: [web, { ...docs, host: 'box' }],
      at: new Date('2026-10-11T13:41:07'),
    });
    const f = renderFrame(s, { width: 160, height: 40 });
    expect(f.table[0]).toMatch(/APP\s+HOST\s+STATUS/);
    expect(f.table[1]).toMatch(/^▶web\s+local\s+online/);
    expect(f.table[2]).toMatch(/^ docs\s+box\s+online/);
    expect(f.details.join('\n')).toContain('zero-memory-web on local');
    expect(
      renderFrame(base(), { width: 160, height: 40 }).table[0]
    ).not.toContain('HOST');
  });
  it("the details put the selected app's reloads next to its restarts: +N, +≥N when partial, as before without a count", () => {
    const pm2Line = (st: ReturnType<typeof base>) =>
      renderFrame(st, { width: 200, height: 40 }).details[2];
    const restarted = reduce(base(), {
      type: 'rows',
      rows: [{ ...web, restarts: 2 }, docs],
      at: new Date('2026-10-11T13:41:07'),
    });
    expect(pm2Line(restarted)).toContain('restarts 2  procs 3');
    const counted = reduce(restarted, {
      type: 'reloads',
      app: 'web',
      info: { count: 3, last: '2026-10-11T12:01:05.120', partial: false },
    });
    expect(pm2Line(counted)).toContain(
      'restarts 2 (+3 reloads, last 12:01:05)  procs 3'
    );
    const partial = reduce(counted, {
      type: 'reloads',
      app: 'web',
      info: { count: 3, last: '2026-10-11T12:01:05', partial: true },
    });
    expect(pm2Line(partial)).toContain(
      'restarts 2 (+≥3 reloads, last 12:01:05)  procs 3'
    );
    const one = reduce(counted, {
      type: 'reloads',
      app: 'web',
      info: { count: 1, last: null, partial: false },
    });
    expect(pm2Line(one)).toContain('restarts 2 (+1 reload)  procs 3');
    const none = reduce(counted, {
      type: 'reloads',
      app: 'web',
      info: { count: 0, last: null, partial: true },
    });
    expect(pm2Line(none)).toContain('restarts 2  procs 3');
    // another app's count is not the selected one's
    const other = reduce(restarted, {
      type: 'reloads',
      app: 'docs',
      info: { count: 4, last: null, partial: false },
    });
    expect(pm2Line(other)).toContain('restarts 2  procs 3');
  });
  it('wraps by terminal columns: a wide character takes two and is never split across rows', () => {
    expect(wrapText('中文中文中', 4, 0)).toEqual(['中文', '中文', '中']);
    expect(wrapText('ab中文', 3, 1)).toEqual(['ab', ' 中', ' 文']);
  });
  it('every row of the screen fits the width in terminal columns and carries no emoji, whatever the logs, descriptions or errors hold', () => {
    const noisy =
      'msg=🚀 AI API ✅ ok ⚠️ warn 👨‍👩‍👧 🇺🇦 中文 字符 ' +
      'x'.repeat(40) +
      '\tend\rlast segment ' +
      '中'.repeat(30);
    const ports = {
      ...web.ports,
      actual: [{ ...web.ports.actual[0], command: 'srv🚀\tx' }],
      checks: [
        {
          port: 3100,
          status: 'declared-not-listening' as const,
          held_by: { pid: 7, command: '🚀holder' },
        },
      ],
    };
    let s = reduce(base(), {
      type: 'rows',
      rows: [
        {
          ...web,
          description: '🚀 dashboard ✅',
          runtime: 'next-server 🚀 中文',
          ports,
        },
        docs,
      ],
      at: new Date('2026-10-11T13:41:07'),
    });
    s = reduce(s, {
      type: 'logs',
      app: 'web',
      lines: [
        { stream: 'out', text: noisy },
        { stream: 'err', text: '✅'.repeat(50) },
      ],
    });
    s = reduce(s, { type: 'error', message: `boom 🚀 ${'中'.repeat(60)}` });
    for (const view of ['dashboard', 'flat'] as const) {
      const f = renderFrame(reduce(s, { type: 'view', view }), {
        width: 60,
        height: 30,
      });
      for (const line of [
        f.header,
        ...f.table,
        ...f.logs,
        ...f.details,
        f.footer,
      ]) {
        expect(displayWidth(line), line).toBeLessThanOrEqual(60);
        expect(line).not.toMatch(/\p{Emoji_Presentation}|[\t\r]/u);
      }
      expect(f.logs.join('')).toContain('last segment');
      expect(f.logs.join('')).not.toContain(`${'x'.repeat(40)} `); // the text before the carriage return is gone
    }
  });
  it('a pm2 line keeps its time stamp when carriage returns overwrote the text after it', () => {
    const s = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: [
        {
          stream: 'out',
          text: '2026-10-11T13:00:07: progress 10%\rprogress 50%\rprogress 100%',
        },
      ],
    });
    expect(renderFrame(s, { width: 120, height: 24 }).logs.at(-1)).toBe(
      '  2026-10-11T13:00:07: progress 100%'
    );
    const flat = reduce(s, { type: 'view', view: 'flat' });
    expect(renderFrame(flat, { width: 120, height: 24 }).logs.at(-1)).toBe(
      'web  | 2026-10-11T13:00:07: progress 100%'
    );
    const ms = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: [
        {
          stream: 'out',
          text: '2026-10-11T13:00:07.123: progress 10%\rprogress 100%',
        },
      ],
    });
    expect(renderFrame(ms, { width: 120, height: 24 }).logs.at(-1)).toBe(
      '  2026-10-11T13:00:07.123: progress 100%'
    ); // a millisecond stamp too
  });
  it('colored text wraps by visible width; every row closes its colors and a continuation row reopens the active one', () => {
    expect(wrapText('\x1b[31mabcdef\x1b[0mgh', 4, 1)).toEqual([
      '\x1b[31mabcd\x1b[0m',
      ' \x1b[31mef\x1b[0mg\x1b[0m',
      ' h',
    ]);
    expect(wrapText('\x1b[32mok', 10, 0)).toEqual(['\x1b[32mok\x1b[0m']);
    expect(wrapText('plain', 10, 0)).toEqual(['plain']);
  });
  it("the log panes show the apps' colors; labels, details and errors stay plain; --once text has no escapes", () => {
    const line =
      '2026-10-11T13:00:07: \x1b[38;5;66mtimestamp=\x1b[0m2026 \x1b[35mlevel=\x1b[0minfo \x1b[?25h' +
      'x'.repeat(80);
    let s = reduce(base(), {
      type: 'logs',
      app: 'web',
      lines: [{ stream: 'out', text: line }],
    });
    s = reduce(s, { type: 'error', message: '\x1b[31mboom\x1b[0m' });
    const f = renderFrame(s, { width: 60, height: 30 });
    expect(f.logs.join('\n')).toContain('\x1b[35mlevel=');
    expect(f.logs.join('\n')).not.toContain('\x1b[?25h');
    for (const row of f.logs) {
      expect(displayWidth(row)).toBeLessThanOrEqual(60);
      if (row.includes('\x1b[')) expect(row.endsWith('\x1b[0m')).toBe(true);
    }
    for (const l of [f.header, ...f.table, ...f.details, f.footer])
      expect(l).not.toContain('\x1b');
    expect(frameToText(f)).not.toContain('\x1b');
    const flat = renderFrame(reduce(s, { type: 'view', view: 'flat' }), {
      width: 60,
      height: 30,
    });
    expect(flat.logs[0]).toMatch(
      /^web {2}\| 2026-10-11T13:00:07: \x1b\[38;5;66mtimestamp=/
    );
  });
});

describe('logsTitle', () => {
  const cleared = (s: ReturnType<typeof base>) =>
    reduce(s, {
      type: 'cleared',
      cleared: { 'local/web': '2026-10-12T15:04:05' },
    });
  it('names the last clear of the apps shown: the time when it was today, the date too otherwise; then the scroll', () => {
    expect(logsTitle(base(), 0)).toBe('logs · web · both');
    expect(logsTitle(cleared(base()), 0, new Date(2026, 9, 12, 16, 0))).toBe(
      'logs · web · both · cleared 15:04'
    );
    expect(logsTitle(cleared(base()), 3, new Date(2026, 9, 13, 9, 0))).toBe(
      'logs · web · both · cleared 2026-10-12 15:04 · ↑3 (End: tail)'
    );
    expect(
      logsTitle(
        reduce(cleared(base()), { type: 'view', view: 'flat' }),
        0,
        new Date(2026, 9, 12, 16, 0)
      )
    ).toBe('logs · all apps · both · cleared 15:04');
  });
  it('the key legends offer the clear', () => {
    expect(renderFrame(base(), { width: 200, height: 30 }).footer).toContain(
      'c clear'
    );
    expect(
      renderFrame(reduce(base(), { type: 'view', view: 'flat' }), {
        width: 200,
        height: 30,
      }).footer
    ).toContain('c clear');
  });
});

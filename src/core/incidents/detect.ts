import vm from 'node:vm';
import type { ErrorSettings } from '../manifest.js';
import { McprocError } from '../errors.js';

export type Stream = 'out' | 'err';
export type IncidentKind = 'error' | 'crashed' | 'restarted';
/** One error occurrence with its context, or a process event; `count` > 1 when the same error repeated within one poll. */
export interface Incident {
  app: string;
  host: string;
  kind: IncidentKind;
  stream: Stream;
  time: string | null;
  first_time: string | null;
  count: number;
  line: string;
  before: string[];
  after: string[];
  fingerprint: string;
}
/** The built-in markers in force, and the app's own patterns as written (they run under a time budget, see ownHits). */
export interface Rules {
  starts: RegExp[];
  match: string[];
  ignore: string[];
  context: [number, number];
  stderr: boolean;
  budgetMs: number;
}
/** The lines of one stream read in one poll; the first `contextOnly` precede the new part and are context, never a start. */
export interface StreamLines {
  stream: Stream;
  lines: string[];
  contextOnly: number;
}

/** The usual ways programs report an error (matched against the text after pm2's stamp). Lowercase "error" alone is not one. */
export const BUILTIN_MARKERS: RegExp[] = [
  /\blevel=(?:error|fatal|crit(?:ical)?)\b/i,
  /"level"\s*:\s*(?:"(?:error|fatal)"|(?:50|60)\b)/i,
  /(?:^|[\s[(])(?:ERROR|FATAL|CRITICAL)(?:[\s\]):]|$)/,
  /\b(?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception)\b(?::|\s+at\b|$)/,
  /^Traceback \(most recent call last\)/,
  /^panic: /,
  /^thread '.*' panicked at/,
  /\bUnhandled(?:PromiseRejection|Rejection)?\b|\buncaughtException\b/,
  /\bE(?:CONNREFUSED|ADDRINUSE|ACCES|NOENT|PIPE|CONNRESET|TIMEDOUT)\b/,
];
/** Lines that continue a stack trace: folded into the incident without using up its after-context. */
const STACK: RegExp[] = [
  /^\s+at\s/,
  /^\s+File "/,
  /^\s{2,}\S/,
  /^Caused by:/,
  /^\s*\.\.\. \d+ more/,
  /^\s*\^+\s*$/,
  /^goroutine \d+/,
];
const PM2_STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?): /; // seconds, or milliseconds
export const MAX_FOLD = 30;
export const MAX_AFTER = 60;
export const MAX_LINE = 2000;

/** How long an app's own patterns may take on one file's lines before the poll of that app stops with an error naming them. */
export const MATCH_BUDGET_MS = 2000;

export function compileRules(
  s: ErrorSettings,
  context?: [number, number],
  budgetMs = MATCH_BUDGET_MS
): Rules {
  return {
    starts: s.defaults ? BUILTIN_MARKERS : [],
    match: s.match,
    ignore: s.ignore,
    context: context ?? s.context,
    stderr: s.stderr,
    budgetMs,
  };
}

// An app's own patterns run in a separate context with a time limit, which interrupts a pattern that backtracks without end.
const OWN = new vm.Script(
  'const m = match.map((p) => new RegExp(p)); const g = ignore.map((p) => new RegExp(p)); out = texts.map((t) => (g.some((re) => re.test(t)) ? 2 : m.some((re) => re.test(t)) ? 1 : 0));'
);

/** Per line: 2 when one of the app's `ignore` patterns matches, 1 when one of its `match` patterns does, 0 otherwise. */
function ownHits(texts: string[], rules: Rules, app: string): number[] | null {
  if (
    texts.length === 0 ||
    (rules.match.length === 0 && rules.ignore.length === 0)
  )
    return null;
  const ctx = vm.createContext({
    texts,
    match: rules.match,
    ignore: rules.ignore,
    out: null,
  });
  try {
    OWN.runInContext(ctx, { timeout: rules.budgetMs });
  } catch (e) {
    if ((e as { code?: string }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT')
      throw e;
    throw new McprocError(
      'TIMEOUT',
      `the errors patterns of ${app} ran over ${rules.budgetMs} ms on its log: one of them backtracks without end on these lines`,
      {
        hint: `Simplify apps.${app}.errors.match/ignore (a repeat inside a repeat, or alternatives that match the same text); this app's incidents wait until then.`,
      }
    );
  }
  return Array.from(ctx.out as number[]);
}

export const stampOf = (line: string): string | null =>
  PM2_STAMP.exec(line)?.[1] ?? null;
/** The line without pm2's leading time stamp (the rest of it is what patterns are matched against). */
export const bodyOf = (line: string): string => line.replace(PM2_STAMP, '');
const cut = (s: string): string =>
  s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s;
/** What patterns are matched against: the line without its stamp, as far as the output shows it (a huge line stays cheap). */
const searched = (line: string): string => bodyOf(line).slice(0, MAX_LINE);

/**
 * A group repeated without bound whose content can end in an unbounded repeat — `(a+)+`, `(\w+\s*)*`, `(a+b?)+`, `(.*)+` —
 * backtracks exponentially on a line that almost matches. Such a pattern is refused when the manifest is loaded, before a
 * poll has to stop it (the time budget of ownHits is the bound for what this check cannot see, like `(a|a)*`).
 * `(\d+\.)+` passes: its repeat ends in a literal.
 */
export function repeatsARepeat(p: string): boolean {
  const stack = [{ ends: false, any: false }]; // per open group: does the current alternative end in an unbounded repeat; did any earlier one
  // a quantifier at j: its length, whether it repeats without bound, whether it may match nothing (then what came before can still end the text)
  const quant = (
    j: number
  ): { len: number; unbounded: boolean; nullable: boolean } => {
    const lazy = p[j + 1] === '?' ? 2 : 1;
    if (p[j] === '*') return { len: lazy, unbounded: true, nullable: true };
    if (p[j] === '+') return { len: lazy, unbounded: true, nullable: false };
    if (p[j] === '?') return { len: lazy, unbounded: false, nullable: true };
    const m = /^\{(\d+)(,(\d*))?\}\??/.exec(p.slice(j));
    return m
      ? {
          len: m[0].length,
          unbounded: m[2] !== undefined && m[3] === '',
          nullable: Number(m[1]) === 0,
        }
      : { len: 0, unbounded: false, nullable: false };
  };
  let i = 0;
  while (i < p.length) {
    const top = stack[stack.length - 1];
    const c = p[i];
    if (c === '(') {
      stack.push({ ends: false, any: false });
      if (p[i + 1] !== '?') i += 1;
      else if (p[i + 2] === '<' && p[i + 3] !== '=' && p[i + 3] !== '!')
        i = p.indexOf('>', i) + 1 || p.length; // (?<name>
      else i += p[i + 2] === '<' ? 4 : 3; // (?: (?= (?! (?<= (?<!
      continue;
    }
    if (c === ')') {
      const g = stack.length > 1 ? stack.pop()! : { ends: false, any: false };
      const q = quant(i + 1);
      const inner = g.any || g.ends;
      if (q.unbounded && inner) return true;
      const parent = stack[stack.length - 1];
      parent.ends = q.nullable
        ? parent.ends || q.unbounded || inner
        : q.unbounded || inner;
      i += 1 + q.len;
      continue;
    }
    if (c === '|') {
      top.any ||= top.ends;
      top.ends = false;
      i++;
      continue;
    }
    if (c === '^' || c === '$') {
      i++;
      continue;
    } // zero width: what came before still ends the text
    let len = 1;
    if (c === '\\') len = 2;
    else if (c === '[') {
      let j = i + 1;
      while (j < p.length && p[j] !== ']') j += p[j] === '\\' ? 2 : 1;
      len = j + 1 - i;
    }
    const q = quant(i + len);
    top.ends = q.nullable ? top.ends || q.unbounded : q.unbounded;
    i += len + q.len;
  }
  return false;
}

function timeAt(lines: string[], i: number): string | null {
  for (let k = i; k >= 0; k--) {
    const t = stampOf(lines[k]);
    if (t) return t;
  }
  return null;
}

/** What makes two occurrences the same error: the text without the stamp, with numbers, ids, hex, paths and quoted strings masked. */
export function fingerprint(line: string): string {
  return bodyOf(line)
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '<id>'
    )
    .replace(/(?:\/[\w.@-]+)+/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .trim();
}

export function detect(
  src: StreamLines,
  rules: Rules,
  who: { app: string; host: string }
): Incident[] {
  const { lines, contextOnly, stream } = src;
  const [nBefore, nAfter] = rules.context;
  const texts = lines.map(searched);
  const first = Math.max(0, contextOnly);
  const own = ownHits(texts.slice(first), rules, who.app); // only lines that may start an incident: context before the new part is never searched

  const isStack = (k: number): boolean => STACK.some((re) => re.test(texts[k]));
  const isStart = (k: number): boolean => {
    if (own?.[k - first] === 2) return false;
    return (
      (rules.stderr && stream === 'err') ||
      own?.[k - first] === 1 ||
      rules.starts.some((re) => re.test(texts[k]))
    );
  };
  const out: Incident[] = [];
  let i = first;
  while (i < lines.length) {
    if (!isStart(i)) {
      i++;
      continue;
    }
    const start = i;
    const after: string[] = [];
    let j = i + 1;
    let tail = 0; // after-context lines since the last start or frame
    let folded = 0; // frames folded since the last start
    let dropped = 0; // frames beyond MAX_FOLD
    const flush = () => {
      if (dropped) {
        after.push(`… ${dropped} more`);
        dropped = 0;
      }
    };
    while (j < lines.length && after.length < MAX_AFTER) {
      const l = lines[j];
      if (isStack(j)) {
        if (folded < MAX_FOLD) {
          after.push(cut(l));
          folded++;
        } else dropped++;
        tail = 0;
        j++;
        continue;
      }
      if (tail >= nAfter) break; // past the after-context: the next error starts its own incident
      if (isStart(j)) {
        flush();
        after.push(cut(l));
        folded = 0;
        tail = 0;
        j++;
        continue;
      } // inside it: one incident
      flush();
      after.push(cut(l));
      tail++;
      j++;
    }
    flush();
    const time = timeAt(lines, start);
    out.push({
      ...who,
      kind: 'error',
      stream,
      time,
      first_time: time,
      count: 1,
      line: cut(lines[start]),
      before: lines.slice(Math.max(0, start - nBefore), start).map(cut),
      after,
      fingerprint: fingerprint(cut(lines[start])), // bounded like the line itself
    });
    i = j;
  }
  return out;
}

/**
 * The same error of one app (same kind and fingerprint) collapses into its last occurrence, counted, with the first time
 * kept. Last and first go by time (stdout and stderr are read one after the other); unstamped incidents count as oldest.
 */
export function collapse(incidents: Incident[]): Incident[] {
  const by = new Map<string, Incident>();
  for (const inc of [...incidents].sort((a, b) =>
    (a.time ?? '').localeCompare(b.time ?? '')
  )) {
    const key = [inc.host, inc.app, inc.kind, inc.fingerprint].join('\u0000');
    const prev = by.get(key);
    if (!prev) {
      by.set(key, inc);
      continue;
    }
    by.delete(key); // re-inserted: the order follows the last occurrence
    by.set(key, {
      ...inc,
      count: prev.count + inc.count,
      first_time: prev.first_time ?? inc.first_time,
    });
  }
  return [...by.values()];
}

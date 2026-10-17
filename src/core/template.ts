export type VarValue = string | number | boolean;

/** A template that cannot be rendered; the manifest wraps it into BAD_TEMPLATE / VAR_CYCLE / UNKNOWN_VAR with the field path. */
export class TemplateError extends Error {
  constructor(
    message: string,
    readonly kind: 'syntax' | 'unknown' | 'cycle' | 'type' = 'syntax'
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '%' | '(' | ')' }
  | { t: 'end' };

function tokenize(expr: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < expr.length && /[0-9]/.test(expr[j])) j++;
      out.push({ t: 'num', v: Number(expr.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      let j = i;
      while (j < expr.length && /[a-z0-9_]/i.test(expr[j])) j++;
      out.push({ t: 'name', v: expr.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%()'.includes(c)) {
      out.push({ t: 'op', v: c as Extract<Tok, { t: 'op' }>['v'] });
      i++;
      continue;
    }
    throw new TemplateError(`unexpected "${c}" in "${expr}"`);
  }
  out.push({ t: 'end' });
  return out;
}

/** Integer arithmetic over var names; a bare name is its value whatever the type, anything else needs numbers. */
export function evaluate(
  expr: string,
  vars: Record<string, VarValue>
): VarValue {
  const toks = tokenize(expr);
  let k = 0;
  const peek = () => toks[k];
  const next = () => toks[k++];
  const num = (v: VarValue, what: string): number => {
    if (typeof v !== 'number')
      throw new TemplateError(
        `${what} is not a number (${JSON.stringify(v)}) in "${expr}"`,
        'type'
      );
    return v;
  };
  const lookup = (name: string): VarValue => {
    if (!Object.hasOwn(vars, name))
      throw new TemplateError(`unknown var "${name}" in "${expr}"`, 'unknown');
    return vars[name];
  };
  const factor = (): VarValue => {
    const t = next();
    if (t.t === 'num') return t.v;
    if (t.t === 'name') return lookup(t.v);
    if (t.t === 'op' && t.v === '-') return -num(factor(), 'operand');
    if (t.t === 'op' && t.v === '(') {
      const v = sum();
      const close = next();
      if (close.t !== 'op' || close.v !== ')')
        throw new TemplateError(`missing ")" in "${expr}"`);
      return v;
    }
    throw new TemplateError(`unexpected end or token in "${expr}"`);
  };
  const term = (): VarValue => {
    let v = factor();
    for (;;) {
      const t = peek();
      if (t.t !== 'op' || !'*/%'.includes(t.v)) return v;
      next();
      const a = num(v, 'operand');
      const b = num(factor(), 'operand');
      if (t.v === '*') v = a * b;
      else {
        if (b === 0) throw new TemplateError(`division by zero in "${expr}"`);
        v = t.v === '/' ? Math.trunc(a / b) : a % b;
      }
    }
  };
  const sum = (): VarValue => {
    let v = term();
    for (;;) {
      const t = peek();
      if (t.t !== 'op' || !'+-'.includes(t.v)) return v;
      next();
      const a = num(v, 'operand');
      const b = num(term(), 'operand');
      v = t.v === '+' ? a + b : a - b;
    }
  };
  const v = sum();
  if (peek().t !== 'end')
    throw new TemplateError(`unexpected trailing input in "${expr}"`);
  return v;
}

const OPEN = /(\\)?\{\{/g;

/** Whether a string holds a template (an escaped `\{{` is not one). */
export function hasTemplate(s: string): boolean {
  for (const m of s.matchAll(OPEN)) if (!m[1]) return true;
  return false;
}

/**
 * The string with every `{{ expr }}` rendered; a template that is the whole string returns the value itself (so a
 * number stays a number); `\{{` becomes a literal `{{`.
 */
export function renderTemplate(
  s: string,
  vars: Record<string, VarValue>
): VarValue {
  const whole = /^\s*\{\{([^}]*)\}\}\s*$/.exec(s);
  if (whole && !s.includes('\\{{')) return evaluate(whole[1], vars);
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('\\{{', i)) {
      out += '{{';
      i += 3;
      continue;
    }
    if (s.startsWith('{{', i)) {
      const end = s.indexOf('}}', i + 2);
      if (end < 0) throw new TemplateError(`unclosed template in "${s}"`);
      out += String(evaluate(s.slice(i + 2, end), vars));
      i = end + 2;
      continue;
    }
    out += s[i++];
  }
  return out;
}

/** The names a template value depends on (its bare identifiers), for ordering the resolution. */
function namesIn(v: VarValue): string[] {
  if (typeof v !== 'string') return [];
  const out = new Set<string>();
  for (const m of v.matchAll(/\{\{([^}]*)\}\}/g))
    for (const n of m[1].matchAll(/[a-z_][a-z0-9_]*/gi)) out.add(n[0]);
  return [...out];
}

/**
 * Declared defaults, overridden per checkout, over the built-ins (`project`, `root`): each var rendered once its
 * dependencies are, so a port can be `{{ 8000 + slot * 100 }}` with `slot` set by the override.
 */
export function resolveVars(
  declared: Record<string, VarValue>,
  overrides: Record<string, VarValue>,
  builtins: Record<string, VarValue>
): Record<string, VarValue> {
  for (const n of Object.keys(declared))
    if (Object.hasOwn(builtins, n))
      throw new TemplateError(
        `"${n}" is a built-in var and cannot be declared`
      );
  for (const n of Object.keys(overrides))
    if (!Object.hasOwn(declared, n))
      throw new TemplateError(
        `undeclared var "${n}" in the override (declared: ${Object.keys(declared).join(', ') || 'none'})`,
        'unknown'
      );
  const raw: Record<string, VarValue> = { ...declared, ...overrides };
  const done: Record<string, VarValue> = { ...builtins };
  const visiting: string[] = [];
  const visit = (n: string): void => {
    if (Object.hasOwn(done, n)) return;
    if (visiting.includes(n))
      throw new TemplateError(
        `cycle: ${[...visiting.slice(visiting.indexOf(n)), n].join(' -> ')}`,
        'cycle'
      );
    visiting.push(n);
    for (const d of namesIn(raw[n])) if (Object.hasOwn(raw, d)) visit(d);
    visiting.pop();
    const v = raw[n];
    done[n] = typeof v === 'string' ? renderTemplate(v, done) : v;
  };
  for (const n of Object.keys(raw)) visit(n);
  return done;
}

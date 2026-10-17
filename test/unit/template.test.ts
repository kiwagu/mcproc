import { describe, it, expect } from 'vitest';
import {
  evaluate,
  hasTemplate,
  renderTemplate,
  resolveVars,
  TemplateError,
} from '../../src/core/template.js';

const vars = { slot: 2, base: 5181, name: 'demo', on: true };

describe('evaluate', () => {
  it('does integer arithmetic with precedence and parentheses', () => {
    expect(evaluate('base + slot * 100', vars)).toBe(5381);
    expect(evaluate('(base + slot) * 100', vars)).toBe(518300);
    expect(evaluate('17 / 5', vars)).toBe(3);
    expect(evaluate('17 % 5', vars)).toBe(2);
    expect(evaluate('-slot + 10', vars)).toBe(8);
    expect(evaluate('2 - 3 - 4', vars)).toBe(-5);
  });
  it('returns a bare name as its value, whatever the type', () => {
    expect(evaluate('name', vars)).toBe('demo');
    expect(evaluate('on', vars)).toBe(true);
    expect(evaluate('slot', vars)).toBe(2);
  });
  it('refuses unknown names, strings in arithmetic, division by zero and junk', () => {
    expect(() => evaluate('nope', vars)).toThrow(TemplateError);
    expect(() => evaluate('nope', vars)).toThrow(/unknown var "nope"/);
    expect(() => evaluate('name + 1', vars)).toThrow(/not a number/);
    expect(() => evaluate('slot / 0', vars)).toThrow(/division by zero/);
    expect(() => evaluate('slot +', vars)).toThrow(TemplateError);
    expect(() => evaluate('slot $ 2', vars)).toThrow(/unexpected/);
    expect(() => evaluate('', vars)).toThrow(TemplateError);
  });
});

describe('renderTemplate', () => {
  it('renders several templates inside a string', () => {
    expect(
      renderTemplate('http://127.0.0.1:{{ base + slot*100 }}/{{name}}', vars)
    ).toBe('http://127.0.0.1:5381/demo');
  });
  it('returns the raw value for a template that is the whole string', () => {
    expect(renderTemplate('{{ slot }}', vars)).toBe(2);
    expect(renderTemplate('{{on}}', vars)).toBe(true);
    expect(renderTemplate('{{ name }}', vars)).toBe('demo');
  });
  it('leaves a string without templates alone and unescapes \\{{', () => {
    expect(renderTemplate('plain', vars)).toBe('plain');
    expect(renderTemplate('literal \\{{ x }}', vars)).toBe('literal {{ x }}');
    expect(hasTemplate('a {{ b }}')).toBe(true);
    expect(hasTemplate('a \\{{ b }}')).toBe(false);
    expect(hasTemplate('a')).toBe(false);
  });
  it('names an unclosed template', () => {
    expect(() => renderTemplate('{{ slot', vars)).toThrow(/unclosed/);
  });
});

describe('resolveVars', () => {
  it('resolves defaults in dependency order with overrides and built-ins', () => {
    const r = resolveVars(
      { slot: 0, port: '{{ 8000 + slot * 100 }}', url: 'http://x:{{ port }}' },
      { slot: 3 },
      { project: 'demo' }
    );
    expect(r).toEqual({
      project: 'demo',
      slot: 3,
      port: 8300,
      url: 'http://x:8300',
    });
  });
  it('names the var whose template failed, keeping the kind', () => {
    expect(() => resolveVars({ p: '{{ 1 +' }, {}, {})).toThrow(/^p: /);
    expect(() => resolveVars({ p: '{{ nope }}' }, {}, {})).toThrowError(
      expect.objectContaining({
        kind: 'unknown',
        message: expect.stringMatching(/^p: /),
      })
    );
  });
  it('refuses a cycle, an override of an undeclared var and a built-in name', () => {
    expect(() => resolveVars({ a: '{{ b }}', b: '{{ a }}' }, {}, {})).toThrow(
      /cycle: a -> b -> a/
    );
    expect(() => resolveVars({ a: 1 }, { b: 2 }, {})).toThrow(
      /undeclared var "b"/
    );
    expect(() => resolveVars({ project: 'x' }, {}, { project: 'y' })).toThrow(
      /built-in/
    );
  });
});

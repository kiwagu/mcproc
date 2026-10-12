import { describe, it, expect } from 'vitest';
import { McprocError, isMcprocError } from '../../src/core/errors.js';

describe('McprocError', () => {
  it('carries code, hint and details and serialises', () => {
    const e = new McprocError('UNKNOWN_APP', 'no app "x"', {
      hint: 'valid: a, b',
      details: ['a', 'b'],
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('McprocError');
    expect(e.code).toBe('UNKNOWN_APP');
    expect(e.hint).toBe('valid: a, b');
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      code: 'UNKNOWN_APP',
      message: 'no app "x"',
      hint: 'valid: a, b',
      details: ['a', 'b'],
    });
    expect(isMcprocError(e)).toBe(true);
    expect(isMcprocError(new Error('x'))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { stripGitVars } from '../helpers/git-env.js';

describe('the git the tests run (test/setup.ts)', () => {
  it('stripGitVars drops every git variable but the two config switches, in place, and keeps the rest', () => {
    const hooksKey = ['core', 'hooksPath'].join('.');
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: '/x/.git',
      GIT_OBJECT_DIRECTORY: '/x/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/y/.git/objects',
      GIT_CONFIG: '/x/config',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: hooksKey,
      GIT_CONFIG_VALUE_0: '/x/hooks',
      GIT_CONFIG_PARAMETERS: `'${hooksKey}'='/x/hooks'`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C',
    };
    expect(stripGitVars(env)).toBe(env);
    expect(env).toEqual({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C',
    });
  });

  it('this file runs without any git variable but the two config switches, whatever the shell or a git hook exported', () => {
    expect(
      Object.keys(process.env)
        .filter((k) => k.startsWith('GIT_'))
        .sort()
    ).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });
});

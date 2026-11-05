import { describe, it, expect } from 'vitest';
import { GIT_REPO_VARS } from '../helpers/git-env.js';

describe('the git the tests run (test/setup.ts)', () => {
  it("this file runs without git's variables for a repository, whatever the shell or a git hook exported", () => {
    for (const k of GIT_REPO_VARS) expect(process.env[k], k).toBeUndefined();
    expect(process.env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe('1');
  });
});

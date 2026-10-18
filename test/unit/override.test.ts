import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadOverride,
  parseOverride,
  writeOverride,
  OVERRIDE_REL,
} from '../../src/core/override.js';
import { McprocError } from '../../src/core/errors.js';

describe('override', () => {
  it('parses project and vars, both optional', () => {
    expect(
      parseOverride('project: demo-w1\nvars: { slot: 1 }', '/p/o')
    ).toEqual({ path: '/p/o', project: 'demo-w1', vars: { slot: 1 } });
    expect(parseOverride('vars: { slot: 1 }', '/p/o')).toEqual({
      path: '/p/o',
      project: undefined,
      vars: { slot: 1 },
    });
    expect(parseOverride('', '/p/o')).toEqual({
      path: '/p/o',
      project: undefined,
      vars: {},
    });
  });
  it('accepts an empty vars: as no vars', () => {
    expect(parseOverride('project: demo-w1\nvars:\n', '/p/o').vars).toEqual({});
  });
  it('refuses unknown keys and a bad project name', () => {
    expect(() => parseOverride('apps: {}', '/p/o')).toThrow(McprocError);
    expect(() => parseOverride('project: Bad Name', '/p/o')).toThrow(/project/);
  });
  it('accepts worktree copy and link extras, and refuses other keys under worktree', () => {
    expect(
      parseOverride(
        'worktree:\n  copy: [.env.local]\n  link: [notes]\n',
        '/p/o'
      )
    ).toEqual({
      path: '/p/o',
      project: undefined,
      vars: {},
      worktree: { copy: ['.env.local'], link: ['notes'] },
    });
    expect(
      parseOverride('worktree:\n  link: [notes]\n', '/p/o').worktree
    ).toEqual({
      copy: [],
      link: ['notes'],
    });
    expect(parseOverride('worktree:\n', '/p/o').worktree).toBeUndefined();
    expect(() => parseOverride('worktree:\n  dir: ../x\n', '/p/o')).toThrow(
      /worktree\.dir|worktree/
    );
  });
  it('loads from .mcproc/mcproc.local.yaml and writes it back', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-ov-'));
    fs.mkdirSync(path.join(root, '.mcproc'));
    expect(loadOverride(root)).toBeNull();
    const p = writeOverride(root, {
      project: 'demo-w3',
      repo: '/w/demo',
      vars: { slot: 3 },
    });
    expect(p).toBe(path.join(root, OVERRIDE_REL));
    expect(fs.readFileSync(p, 'utf8')).toBe(
      "# Written by mcproc worktree add: this checkout's project slug and vars.\nproject: demo-w3\nrepo: /w/demo\nvars:\n  slot: 3\n"
    );
    expect(loadOverride(root)).toEqual({
      path: p,
      project: 'demo-w3',
      repo: '/w/demo',
      vars: { slot: 3 },
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

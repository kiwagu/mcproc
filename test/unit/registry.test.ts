import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  forgetProject,
  listProjects,
  projectFile,
  recordProject,
} from '../../src/core/registry.js';
import { prepare } from '../../src/core/resolve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-reg-'));

function checkout(base: string, name: string): string {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.mcproc'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.mcproc', 'mcproc.yaml'),
    `version: 1\nproject: ${name}\napps: {}\n`
  );
  return root;
}
const entry = (root: string, project: string) => ({
  project,
  root,
  path: path.join(root, '.mcproc', 'mcproc.yaml'),
});

describe('host registry', () => {
  it('records a checkout once; an unchanged record is not written again', () => {
    const dir = tmp();
    const root = checkout(tmp(), 'alpha');
    recordProject(entry(root, 'alpha'), dir);
    const file = projectFile(dir, 'alpha', root);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      project: 'alpha',
      root,
      manifest: path.join(root, '.mcproc', 'mcproc.yaml'),
    });
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(file, past, past);
    recordProject(entry(root, 'alpha'), dir);
    expect(fs.statSync(file).mtime.getTime()).toBe(past.getTime());
  });
  it('a checkout reached through a symlink is the same entry', () => {
    const dir = tmp();
    const base = tmp();
    const root = checkout(base, 'alpha');
    const link = path.join(base, 'link');
    fs.symlinkSync(root, link);
    recordProject(entry(root, 'alpha'), dir);
    recordProject(entry(link, 'alpha'), dir);
    expect(fs.readdirSync(path.join(dir, 'projects'))).toHaveLength(1);
  });
  it('lists the entries whose manifest is still there and drops the others', () => {
    const dir = tmp();
    const base = tmp();
    const a = checkout(base, 'alpha');
    const b = checkout(base, 'beta');
    recordProject(entry(a, 'alpha'), dir);
    recordProject(entry(b, 'beta'), dir);
    fs.rmSync(b, { recursive: true });
    const { entries, error } = listProjects(dir);
    expect(error).toBeNull();
    expect(entries.map((e) => e.project)).toEqual(['alpha']);
    expect(fs.existsSync(projectFile(dir, 'beta', b))).toBe(false);
  });
  it('forgets one checkout; a missing or unwritable directory never throws', () => {
    const dir = tmp();
    const a = checkout(tmp(), 'alpha');
    recordProject(entry(a, 'alpha'), dir);
    forgetProject('alpha', a, dir);
    expect(listProjects(dir).entries).toEqual([]);
    expect(listProjects(path.join(dir, 'nope')).entries).toEqual([]);
    expect(() =>
      recordProject(entry(a, 'alpha'), '/proc/mcproc-nope')
    ).not.toThrow();
  });
  it('prepare() records the checkout it loads (into the suite temp MCPROC_STATE_DIR)', () => {
    prepare({ project: basic });
    expect(
      listProjects().entries.some(
        (e) => fs.realpathSync(e.root) === fs.realpathSync(basic)
      )
    ).toBe(true);
  });
});

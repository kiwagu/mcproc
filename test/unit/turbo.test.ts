import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readTurbo,
  isDistLib,
  loadWorkspace,
  dependsOnDistLib,
  turboBin,
  libsFilters,
  type WsPackage,
} from '../../src/core/turbo.js';

const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-turbo-'));
  made.push(d);
  return d;
};
const write = (root: string, rel: string, data: unknown) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
};
const pkg = (
  name: string,
  dir: string,
  extra: Partial<WsPackage> = {}
): WsPackage => ({
  name,
  dir,
  scripts: {},
  deps: [],
  distLib: false,
  ...extra,
});

describe('readTurbo', () => {
  it('turbo 2 tasks and turbo 1 pipeline, persistent flags; null without a config', () => {
    const r = tmp();
    write(r, 'turbo.json', {
      tasks: {
        build: { dependsOn: ['^build'] },
        dev: { persistent: true, cache: false },
        start: { persistent: true },
        lint: {},
      },
    });
    expect(readTurbo(r)).toEqual({
      version: 2,
      tasks: ['build', 'dev', 'start', 'lint'],
      persistent: ['dev', 'start'],
    });
    write(r, 'turbo.json', {
      pipeline: { dev: { persistent: true }, build: {} },
    });
    expect(readTurbo(r)).toEqual({
      version: 1,
      tasks: ['dev', 'build'],
      persistent: ['dev'],
    });
    write(r, 'turbo.json', { $schema: 'x' });
    expect(readTurbo(r)).toBeNull();
    write(r, 'turbo.json', { tasks: [] });
    expect(readTurbo(r)).toBeNull();
    write(r, 'turbo.json', '{ not json');
    expect(readTurbo(r)).toBeNull();
    expect(readTurbo(tmp())).toBeNull();
  });
});

describe('isDistLib', () => {
  it('reads main, module, types and every string under exports; needs a build script', () => {
    const build = { build: 'tsc -p .' };
    expect(isDistLib({ scripts: build, main: './dist/index.js' })).toBe(true);
    expect(isDistLib({ scripts: build, module: 'dist/index.mjs' })).toBe(true);
    expect(isDistLib({ scripts: build, types: './dist/index.d.ts' })).toBe(
      true
    );
    expect(isDistLib({ scripts: build, exports: './dist/index.js' })).toBe(
      true
    );
    expect(
      isDistLib({
        scripts: build,
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        },
      })
    ).toBe(true);
    expect(
      isDistLib({
        scripts: build,
        exports: {
          '.': './src/index.ts',
          './sub': { default: './dist/sub.js' },
        },
      })
    ).toBe(true);
    expect(
      isDistLib({
        scripts: build,
        exports: { '.': { types: './src/index.ts', import: './src/index.ts' } },
      })
    ).toBe(false);
    expect(isDistLib({ main: './dist/index.js' })).toBe(false); // no build script
    expect(
      isDistLib({
        scripts: build,
        exports: { './globals.css': './src/styles/globals.css' },
      })
    ).toBe(false);
    expect(isDistLib({ scripts: build, main: './lib/dist-tools.js' })).toBe(
      false
    ); // "dist" must be a path segment at the start
  });
});

describe('loadWorkspace / dependsOnDistLib', () => {
  it('loads scripts, workspace deps and the dist flag; reachability is transitive and cycle-safe', () => {
    const r = tmp();
    write(r, 'apps/web/package.json', {
      name: '@t/web',
      scripts: { dev: 'vite' },
      dependencies: { '@t/ui': 'workspace:*', react: '^19' },
    });
    write(r, 'packages/ui/package.json', {
      name: '@t/ui',
      exports: { '.': './src/index.ts' },
      dependencies: { '@t/domain': '*' },
      devDependencies: { '@t/web': '*' },
    });
    write(r, 'packages/domain/package.json', {
      name: '@t/domain',
      scripts: { build: 'tsc -p .' },
      exports: { '.': { import: './dist/index.js' } },
      peerDependencies: { '@t/ui': '*' },
    });
    write(r, 'packages/noname/package.json', {
      scripts: { build: 'x' },
      main: './dist/i.js',
    });
    fs.mkdirSync(path.join(r, 'packages', 'empty'));
    const ws = loadWorkspace(
      r,
      [
        'apps/web',
        'packages/ui',
        'packages/domain',
        'packages/noname',
        'packages/empty',
      ].map((d) => path.join(r, d))
    );
    expect(ws.map((p) => [p.name, p.dir, p.distLib])).toEqual([
      ['@t/web', 'apps/web', false],
      ['@t/ui', 'packages/ui', false],
      ['@t/domain', 'packages/domain', true],
      ['noname', 'packages/noname', true],
    ]);
    expect(ws[0].deps).toEqual(['@t/ui', 'react']);
    expect(ws[1].deps.sort()).toEqual(['@t/domain', '@t/web']);
    const libs = new Set(ws.filter((p) => p.distLib).map((p) => p.name));
    expect(dependsOnDistLib(ws[0], ws, libs)).toEqual(['@t/domain']); // web → ui → domain, through the ui ↔ web ↔ domain cycle
    expect(dependsOnDistLib(ws[2], ws, libs)).toEqual([]); // a library does not depend on itself
    expect(dependsOnDistLib(ws[3], ws, libs)).toEqual([]);
  });
});

describe('turboBin / libsFilters', () => {
  it('binary per package manager', () => {
    expect(turboBin('npm run')).toBe('npx turbo');
    expect(turboBin('yarn')).toBe('yarn turbo');
    expect(turboBin('pnpm')).toBe('pnpm exec turbo');
    expect(turboBin('bun run')).toBe('bunx turbo');
  });
  it('one glob filter per parent folder, a name filter for a library outside the globbed folders', () => {
    const libs = [
      pkg('@t/domain', 'packages/domain'),
      pkg('@t/std', 'packages/std'),
      pkg('@t/x', 'libs/x'),
      pkg('@t/one', 'tools/one'),
    ];
    expect(libsFilters(libs, ['packages', 'libs', 'apps'])).toEqual([
      "--filter='./packages/*'",
      "--filter='./libs/*'",
      '--filter=@t/one',
    ]);
    expect(libsFilters([], ['packages'])).toEqual([]);
  });
  it('a folder that also holds a live library filters its folded libraries by name', () => {
    const libs = [
      pkg('@t/domain', 'packages/domain'),
      pkg('@t/std', 'packages/std'),
      pkg('@t/x', 'libs/x'),
    ];
    const live = [pkg('@t/contracts', 'packages/contracts')];
    expect(libsFilters(libs, ['packages', 'libs'], live)).toEqual([
      '--filter=@t/domain',
      '--filter=@t/std',
      "--filter='./libs/*'",
    ]);
  });
});

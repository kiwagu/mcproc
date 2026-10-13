import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discover,
  guessKind,
  guessPort,
  renderDraft,
  initProject,
  sanitizeName,
} from '../../src/core/init.js';
import { parseManifest } from '../../src/core/manifest.js';

function write(root: string, rel: string, content: string) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-init-'));
  write(
    root,
    'package.json',
    JSON.stringify({
      name: 'mono',
      workspaces: ['packages/*'],
      scripts: {
        dev: 'concurrently "yarn dev:*"',
        test: 'vitest',
        'build:watch': 'tsc -b -w',
        build: 'tsc -p .',
        migrate: 'prisma migrate deploy',
      },
    })
  );
  write(root, 'yarn.lock', '');
  write(root, '.env', 'PORT=7777\n');
  write(
    root,
    'packages/api/package.json',
    JSON.stringify({
      name: '@mono/api',
      scripts: {
        dev: 'nest start --watch',
        'start:worker': 'node dist/worker.js',
      },
    })
  );
  write(root, 'packages/api/.env', 'NODE_ENV=development\nPORT=4100\n');
  write(
    root,
    'apps/web/project.json',
    JSON.stringify({ name: 'web', targets: { serve: {}, build: {} } })
  );
  write(
    root,
    'apps/web/src/main.ts',
    'const app = express();\napp.listen(4200);\n'
  );
  write(root, 'turbo.json', JSON.stringify({ tasks: { dev: {}, lint: {} } }));
  write(
    root,
    'ecosystem.json',
    JSON.stringify({
      apps: [
        { name: 'legacy', script: 'build.server.js', env: { PORT: 8080 } },
      ],
    })
  );
  write(root, 'ecosystem.config.cjs', 'module.exports = {}');
  write(
    root,
    'Procfile',
    'web: node server.js --port 5000\nmigrate: node migrate.js\n'
  );
  write(
    root,
    'node_modules/junk/project.json',
    JSON.stringify({ name: 'junk', targets: { serve: {} } })
  );
});

describe('guesses', () => {
  it('guessKind', () => {
    expect(guessKind('dev', 'nest start --watch')).toBe('server');
    expect(guessKind('build:watch', 'tsc -b -w')).toBe('build');
    expect(guessKind('start:worker', 'node dist/worker.js')).toBe('worker');
    expect(guessKind('lint', 'eslint .')).toBe('unknown');
    expect(guessKind('build', 'tsc -p .')).toBe('task');
    expect(guessKind('build', 'turbo run build')).toBe('task');
    expect(guessKind('migrate', 'prisma migrate deploy')).toBe('task');
    expect(guessKind('seed', 'node seed.js')).toBe('task');
    expect(guessKind('build:watch', 'tsc -b -w')).toBe('build');
    expect(guessKind('libs', 'turbo watch build')).toBe('build');
    expect(guessKind('dev', 'next dev')).toBe('server');
  });
  it('guessPort from command, .env and src', () => {
    expect(guessPort('next dev --port 3005', '/nowhere')).toBe(3005);
    expect(guessPort('PORT=3006 node x', '/nowhere')).toBe(3006);
    expect(guessPort('nest start', path.join(root, 'packages/api'))).toBe(4100);
    expect(guessPort('', path.join(root, 'apps/web'))).toBe(4200);
    expect(guessPort('vitest', '/nowhere')).toBeUndefined();
  });
  it('sanitizeName', () => {
    expect(sanitizeName('build:watch')).toBe('build-watch');
    expect(sanitizeName('@Mono/API dev')).toBe('mono-api-dev');
  });
});

describe('discover', () => {
  it('collects candidates from every source and skips node_modules', () => {
    const d = discover(root);
    const byName = Object.fromEntries(d.candidates.map((c) => [c.name, c]));
    expect(byName.dev).toMatchObject({
      source: 'package.json:dev',
      run: 'yarn dev',
      cwd: '.',
      kind: 'server',
    });
    expect(byName['build-watch']).toMatchObject({ kind: 'build' });
    expect(byName.build).toMatchObject({ kind: 'task', run: 'yarn build' });
    expect(byName.build.port).toBeUndefined();
    expect(byName.migrate).toMatchObject({ kind: 'task' });
    expect(byName.migrate.port).toBeUndefined();
    expect(byName.dev.port).toBe(7777);
    expect(byName.test).toBeUndefined();
    expect(byName['api-dev']).toMatchObject({
      source: 'packages/api/package.json:dev',
      run: 'yarn dev',
      cwd: 'packages/api',
      kind: 'server',
      port: 4100,
    });
    expect(byName['api-start-worker']).toMatchObject({ kind: 'worker' });
    expect(byName['web-serve']).toMatchObject({
      source: 'apps/web/project.json:serve',
      run: 'npx nx run web:serve',
      kind: 'server',
      port: 4200,
    });
    expect(byName['web-build']).toMatchObject({
      run: 'npx nx run web:build --watch',
      kind: 'build',
    });
    expect(byName['turbo-dev']).toBeUndefined();
    expect(byName.legacy).toMatchObject({
      source: 'ecosystem.json:legacy',
      run: 'node build.server.js',
      port: 8080,
      kind: 'server',
    });
    expect(byName.web).toMatchObject({
      source: 'Procfile:web',
      run: 'node server.js --port 5000',
      port: 5000,
    });
    expect(byName['migrate-2']).toMatchObject({
      source: 'Procfile:migrate',
      kind: 'task',
    });
    expect(byName['migrate-2'].port).toBeUndefined();
    expect(d.candidates.some((c) => c.name.startsWith('junk'))).toBe(false);
    expect(d.notes.some((n) => n.includes('ecosystem.config.cjs'))).toBe(true);
  });
});

describe('renderDraft / initProject', () => {
  it('renders a draft whose only error is "at least one app"', () => {
    const draft = renderDraft(root, 'mono', discover(root));
    expect(draft).toContain('version: 1');
    expect(draft).toContain('kind build|server|worker|task');
    expect(draft).toContain('# api-dev:');
    expect(draft).toContain('#   port: 4100');
    expect(draft).toContain('#   url: http://localhost:4100');
    const mlines = draft.split('\n');
    const mstart = mlines.findIndex((l) => l.startsWith('  # migrate-2:'));
    expect(mstart).toBeGreaterThan(-1);
    const mblock = [mlines[mstart]];
    for (
      let i = mstart + 1;
      i < mlines.length && mlines[i].startsWith('  #   ');
      i++
    )
      mblock.push(mlines[i]);
    expect(mblock.join('\n')).not.toContain('url:');
    expect(mblock.join('\n')).not.toContain('port:');
    expect(() => parseManifest(draft, root, 'x')).toThrowError(
      /at least one app/
    );
    // uncomment exactly one candidate block (its header line plus the indented field lines that follow)
    const lines = draft.split('\n');
    const start = lines.findIndex((l) => l.startsWith('  # api-dev:'));
    let end = start + 1;
    while (end < lines.length && lines[end].startsWith('  #   ')) end++;
    const block = lines
      .slice(start, end)
      .map((l, i) =>
        i === 0 ? l.replace('  # ', '  ') : l.replace('  #   ', '    ')
      )
      .join('\n')
      .replace('description: ""', 'description: api');
    const uncommented = [
      ...lines.slice(0, start),
      block,
      ...lines.slice(end),
    ].join('\n');
    const m = parseManifest(uncommented, root, 'x');
    expect(m.apps['api-dev']).toMatchObject({
      run: 'yarn dev',
      cwd: 'packages/api',
      ports: [4100],
      url: 'http://localhost:4100',
    });
  });
  it('force never overwrites a manifest whose local host is readonly, even one that does not validate', () => {
    for (const text of [
      'version: 1\napps:\n  a: { description: d, run: r }\nhosts:\n  local: { readonly: true }\n',
      'version: 1\nhosts:\n  local: { readonly: true }\n',
    ]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-init-ro-'));
      fs.mkdirSync(path.join(root, '.mcproc'));
      fs.writeFileSync(path.join(root, '.mcproc', 'mcproc.yaml'), text);
      expect(() => initProject(root, { force: true })).toThrowError(
        expect.objectContaining({ code: 'READONLY_HOST' })
      );
      expect(
        fs.readFileSync(path.join(root, '.mcproc', 'mcproc.yaml'), 'utf8')
      ).toBe(text);
    }
  });
  it('initProject writes .gitignore, README and draft; refuses to overwrite without force', () => {
    const r = initProject(root);
    expect(
      fs.readFileSync(path.join(root, '.mcproc', '.gitignore'), 'utf8')
    ).toBe('*\n');
    expect(fs.existsSync(path.join(root, '.mcproc', 'README.md'))).toBe(true);
    expect(r.candidates).toBeGreaterThan(5);
    expect(r.by_source['package.json']).toBe(6); // root dev + build:watch + build + migrate, workspace api dev + start:worker
    expect(r.next).toContain('uncomment');
    expect(() => initProject(root)).toThrowError(/already exists/);
    expect(initProject(root, { force: true }).created).toContain(
      path.join(root, '.mcproc', 'mcproc.yaml')
    );
  });
});

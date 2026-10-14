import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discover,
  guessKind,
  guessPort,
  renderDraft,
  initProject,
  sanitizeName,
  LIVE_DESCRIPTION,
} from '../../src/core/init.js';
import { loadManifest, parseManifest } from '../../src/core/manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const turbo = path.join(here, '..', 'fixtures', 'projects', 'turbo');

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
    expect(d.profiles).toEqual([]);
    expect(d.libs).toEqual([]);
    expect(d.candidates.every((c) => !c.live)).toBe(true);
  });
});

describe('discover on a turbo repo', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  });
  /** A throwaway copy of the turbo fixture, removed after the suite. */
  const copy = () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-init-'));
    made.push(r);
    fs.cpSync(turbo, r, { recursive: true });
    return r;
  };
  const byName = (d: ReturnType<typeof discover>) =>
    Object.fromEntries(d.candidates.map((c) => [c.name, c]));
  it('drafts the persistent dev task live, folds dist libraries into libs/libs-watch, wires depends_on', () => {
    const d = discover(turbo);
    const c = byName(d);
    expect(d.candidates.slice(0, 2).map((x) => x.name)).toEqual([
      'libs',
      'libs-watch',
    ]);
    expect(c.libs).toMatchObject({
      live: true,
      kind: 'task',
      cwd: '.',
      source: 'turbo.json:build',
      run: 'bunx turbo run build --filter=@t/domain --ui=stream',
    });
    expect(c.libs.description).toContain('packages');
    expect(c['libs-watch']).toMatchObject({
      live: true,
      kind: 'build',
      run: 'bunx turbo watch build --filter=@t/domain --ui=stream',
      depends_on: [{ app: 'libs', condition: 'completed' }],
    });
    expect(c.api).toMatchObject({
      live: true,
      source: 'apps/api/package.json:dev',
      run: 'bun run dev',
      cwd: 'apps/api',
      kind: 'server',
      port: 3020,
      description: LIVE_DESCRIPTION,
      depends_on: [{ app: 'libs', condition: 'completed' }],
    });
    expect(c.web).toMatchObject({
      live: true,
      cwd: 'apps/web',
      kind: 'server',
      port: 3002,
      depends_on: [{ app: 'libs', condition: 'completed' }],
    });
    expect(c.contracts).toMatchObject({
      live: true,
      cwd: 'packages/contracts',
      kind: 'build',
      source: 'packages/contracts/package.json:dev',
    });
    expect(c.contracts.depends_on).toEqual([
      { app: 'libs', condition: 'completed' },
    ]); // contracts → domain
    expect(c.contracts.port).toBeUndefined();
    expect(c.api.note).toContain("contracts's first build is not awaited"); // api depends on the live library contracts
    expect(c.web.note).toBeUndefined();
    expect(c['domain-build']).toBeUndefined(); // folded into libs
    expect(c['contracts-build']).toMatchObject({ kind: 'task' }); // a live library keeps its one-shot build, commented
    expect(c['contracts-build'].live).toBeUndefined();
    expect(c['web-start']).toMatchObject({ kind: 'server', port: 4173 });
    expect(c['web-build']).toMatchObject({ kind: 'task' });
    expect(c['api-build']).toMatchObject({ kind: 'task' });
    expect(c.dev).toMatchObject({
      source: 'package.json:dev',
      run: 'bun run dev',
      cwd: '.',
    });
    expect(c.dev.live).toBeUndefined();
    expect(c.dev.note).toBe(
      'the dev profile replaces this: turbo would start every package as one process'
    );
    expect(c.build).toMatchObject({ kind: 'task' });
    expect(Object.keys(c).filter((n) => n.startsWith('turbo-'))).toEqual([]);
    expect(d.profiles).toEqual([
      {
        name: 'dev',
        apps: ['libs', 'libs-watch', 'api', 'web', 'contracts'],
        live: true,
      },
      { name: 'start', apps: ['web-start'], live: false },
    ]);
    expect(d.libs).toEqual(['@t/domain']);
    expect(d.notes).toContain(
      '1 library built into dist/ is drafted as libs and libs-watch: @t/domain'
    );
    // workspace packages come in sorted directory order, whatever order readdir returns
    expect([
      ...new Set(d.candidates.filter((x) => x.cwd !== '.').map((x) => x.cwd)),
    ]).toEqual(['apps/api', 'apps/web', 'packages/contracts']);
    expect(d.notes.some((n) => n.includes('turbo.json'))).toBe(false);
  });
  it('a turbo repo without a persistent dev task drafts as before', () => {
    const r = copy();
    write(r, 'turbo.json', JSON.stringify({ tasks: { dev: {}, build: {} } }));
    const d = discover(r);
    expect(d.candidates.some((c) => c.live)).toBe(false);
    expect(d.profiles).toEqual([]);
    expect(d.libs).toEqual([]);
    expect(byName(d)['domain-build']).toMatchObject({ kind: 'task' });
    expect(byName(d)['web-dev']).toMatchObject({ kind: 'server', port: 3002 });
    // only the bare task makes the live stack, not a package-scoped one
    write(
      r,
      'turbo.json',
      JSON.stringify({
        tasks: {
          'web#dev': { persistent: true },
          '//#dev': { persistent: true },
          build: {},
        },
      })
    );
    expect(discover(r).candidates.some((c) => c.live)).toBe(false);
  });
  it('turbo 1 pipeline: no --ui flag, no libs-watch (no turbo watch); npm, yarn and pnpm binaries', () => {
    const r = copy();
    fs.rmSync(path.join(r, 'bun.lock'));
    write(
      r,
      'turbo.json',
      JSON.stringify({ pipeline: { dev: { persistent: true }, build: {} } })
    );
    const d = discover(r);
    const c = byName(d);
    expect(c.libs.run).toBe('npx turbo run build --filter=@t/domain');
    expect(c['libs-watch']).toBeUndefined();
    expect(d.notes).toContain(
      'turbo 1 has no turbo watch: libs-watch is not drafted; run libs again after changing a library, or move to turbo 2'
    );
    expect(c.api.depends_on).toEqual([{ app: 'libs', condition: 'completed' }]);
    expect(d.profiles[0].apps).toEqual(['libs', 'api', 'web', 'contracts']);
    expect(d.notes).toContain(
      '1 library built into dist/ is drafted as libs: @t/domain'
    );
    write(r, 'yarn.lock', '');
    expect(byName(discover(r)).libs.run).toBe(
      'yarn turbo run build --filter=@t/domain'
    );
    fs.rmSync(path.join(r, 'yarn.lock'));
    write(r, 'pnpm-lock.yaml', '');
    expect(byName(discover(r)).libs.run).toBe(
      'pnpm exec turbo run build --filter=@t/domain'
    );
  });
  it('libraries share a folder filter when no live library sits in their folder, ./-prefixed patterns too', () => {
    const r = copy();
    const contracts = JSON.parse(
      fs.readFileSync(
        path.join(r, 'packages', 'contracts', 'package.json'),
        'utf8'
      )
    );
    delete contracts.scripts.dev;
    write(r, 'packages/contracts/package.json', JSON.stringify(contracts));
    const d = discover(r);
    expect(byName(d).libs.run).toBe(
      "bunx turbo run build --filter='./packages/*' --ui=stream"
    );
    expect(d.libs).toEqual(['@t/contracts', '@t/domain']);
    expect(d.notes).toContain(
      '2 libraries built into dist/ are drafted as libs and libs-watch: @t/contracts, @t/domain'
    );
    const pkg = JSON.parse(
      fs.readFileSync(path.join(r, 'package.json'), 'utf8')
    );
    write(
      r,
      'package.json',
      JSON.stringify({ ...pkg, workspaces: ['./apps/*', './packages/*'] })
    );
    expect(byName(discover(r)).libs.run).toBe(
      "bunx turbo run build --filter='./packages/*' --ui=stream"
    );
  });
  it('a persistent dev task no package implements drafts as before: no live apps, no profile, no root note', () => {
    const r = copy();
    for (const dir of ['apps/api', 'apps/web', 'packages/contracts']) {
      const p = JSON.parse(
        fs.readFileSync(path.join(r, dir, 'package.json'), 'utf8')
      );
      delete p.scripts.dev;
      write(r, `${dir}/package.json`, JSON.stringify(p));
    }
    const d = discover(r);
    expect(d.candidates.some((c) => c.live)).toBe(false);
    expect(d.profiles).toEqual([]);
    expect(d.libs).toEqual([]);
    expect(byName(d).dev.note).toBeUndefined();
    expect(byName(d)['domain-build']).toMatchObject({ kind: 'task' });
  });
  it('a turbo task no script implements is drafted as turbo-<task>', () => {
    const r = copy();
    const t = JSON.parse(fs.readFileSync(path.join(r, 'turbo.json'), 'utf8'));
    write(
      r,
      'turbo.json',
      JSON.stringify({ tasks: { ...t.tasks, watch: { cache: false } } })
    );
    expect(byName(discover(r))['turbo-watch']).toMatchObject({
      source: 'turbo.json:watch',
      run: 'npx turbo run watch',
      cwd: '.',
    });
  });
  it('an unparsable turbo.json is noted and drafted the old way; one without tasks is not noted', () => {
    const r = copy();
    write(
      r,
      'turbo.json',
      '{\n  // turbo accepts comments\n  "tasks": { "dev": { "persistent": true }, "build": {} }\n}\n'
    );
    const d = discover(r);
    expect(d.notes).toContain(
      "turbo.json could not be parsed (comments are not read); drafted without turbo's tasks"
    );
    expect(d.candidates.some((c) => c.live)).toBe(false);
    expect(d.profiles).toEqual([]);
    expect(byName(d)['domain-build']).toMatchObject({ kind: 'task' });
    write(
      r,
      'turbo.json',
      JSON.stringify({ $schema: 'https://turbo.build/schema.json' })
    );
    expect(discover(r).notes.some((n) => n.includes('turbo.json'))).toBe(false);
  });
  it('no dist libraries: no libs apps, no depends_on, no note', () => {
    const r = copy();
    fs.rmSync(path.join(r, 'packages', 'domain'), { recursive: true });
    fs.rmSync(path.join(r, 'packages', 'contracts'), { recursive: true });
    const d = discover(r);
    const c = byName(d);
    expect(c.libs).toBeUndefined();
    expect(c.api.depends_on).toBeUndefined();
    expect(d.profiles[0]).toEqual({
      name: 'dev',
      apps: ['api', 'web'],
      live: true,
    });
    expect(d.libs).toEqual([]);
    expect(d.notes.some((n) => n.includes('dist/'))).toBe(false);
  });
  it('a live app named dev makes the profile dev-apps; a package named libs is deduplicated', () => {
    const r = copy();
    write(
      r,
      'apps/dev/package.json',
      JSON.stringify({ name: '@t/dev', scripts: { dev: 'node s.js' } })
    );
    write(
      r,
      'apps/libs/package.json',
      JSON.stringify({ name: 'libs', scripts: { dev: 'node s.js' } })
    );
    const d = discover(r);
    const c = byName(d);
    expect(c.dev.live).toBeUndefined(); // the root script keeps the bare name: it came first
    expect(c['dev-2']).toMatchObject({ live: true, cwd: 'apps/dev' });
    expect(c['libs-2']).toMatchObject({ live: true, cwd: 'apps/libs' });
    expect(c.libs.kind).toBe('task');
    expect(d.profiles[0].name).toBe('dev'); // no LIVE app is named dev
    fs.rmSync(path.join(r, 'package.json'));
    write(
      r,
      'package.json',
      JSON.stringify({ workspaces: ['apps/*', 'packages/*'] })
    ); // no root scripts: the live app takes the name dev
    const d2 = discover(r);
    expect(byName(d2).dev).toMatchObject({ live: true, cwd: 'apps/dev' });
    expect(d2.profiles[0].name).toBe('dev-apps');
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

describe('renderDraft on a turbo repo', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  });
  /** A throwaway copy of the turbo fixture, removed after the suite. */
  const copy = () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-init-'));
    made.push(r);
    fs.cpSync(turbo, r, { recursive: true });
    return r;
  };
  const draftOf = (r: string) => renderDraft(r, 'fx', discover(r));
  /** No root scripts and a workspace app named dev: the live profile becomes dev-apps. */
  const liveAppNamedDev = (r: string) => {
    fs.rmSync(path.join(r, 'package.json'));
    write(
      r,
      'package.json',
      JSON.stringify({ workspaces: ['apps/*', 'packages/*'] })
    );
    write(
      r,
      'apps/dev/package.json',
      JSON.stringify({ name: '@t/dev', scripts: { dev: 'node s.js' } })
    );
  };
  it('writes live apps uncommented, the divider, the dev profile and the start profile; the draft loads', () => {
    const text = draftOf(turbo);
    expect(text).toContain(
      [
        '#',
        "# Live apps below come from turbo's persistent dev task and form the dev profile: start dev runs them.",
        '# The other candidates are commented out. Uncomment the ones your dev stack needs,',
        '# write a description for each app, then run start + ls to confirm the ports; fix; repeat.',
        '',
      ].join('\n')
    );
    expect(text).not.toContain('# Candidates below are commented out.');
    expect(text).toMatch(
      /^ {2}libs: {4}# source: turbo\.json:build; kind\? task\n {4}description: .*\n {4}kind: task\n {4}run: "bunx turbo run build --filter=@t\/domain --ui=stream"\n/m
    );
    expect(text).toContain(
      '  libs-watch:    # source: turbo.json:build; kind? build\n'
    );
    expect(text).toContain(
      '    run: "bunx turbo watch build --filter=@t/domain --ui=stream"\n'
    );
    expect(text).toContain(
      '    depends_on: [{ app: libs, condition: completed }]\n'
    );
    expect(text).toMatch(
      /^ {2}api: {4}# source: apps\/api\/package\.json:dev; kind\? server; port\? 3020\n {4}description: "TODO: what this app does"\n {4}kind: server\n {4}run: bun run dev\n {4}cwd: apps\/api\n {4}port: 3020\n {4}url: http:\/\/localhost:3020\n {4}depends_on: \[\{ app: libs, condition: completed \}\]\n {4}# contracts's first build is not awaited; uncomment contracts-build and add \{ app: contracts-build, condition: completed \} to its depends_on to wait for it\n/m
    );
    expect(text).toContain('  # --- other scripts (commented out) ---\n');
    expect(text).toContain(
      [
        '  # dev:    # source: package.json:dev; kind? server',
        '  #   description: ""',
        '  #   kind: server',
        '  #   run: bun run dev',
        '  #   # the dev profile replaces this: turbo would start every package as one process',
        '',
      ].join('\n')
    );
    expect(text).toContain(
      'profiles:\n  dev: [libs, libs-watch, api, web, contracts]\n  # start: [web-start]\nhosts:\n'
    );
    expect(text).not.toContain('# base: [api-build, api]');
    const m = parseManifest(
      text,
      turbo,
      path.join(turbo, '.mcproc', 'mcproc.yaml')
    );
    expect(Object.keys(m.apps)).toEqual([
      'libs',
      'libs-watch',
      'api',
      'web',
      'contracts',
    ]);
    expect(m.profiles.dev).toEqual([
      'libs',
      'libs-watch',
      'api',
      'web',
      'contracts',
    ]);
    expect(m.apps.api.depends_on).toEqual([
      { app: 'libs', condition: 'completed', timeoutMs: 60_000 },
    ]);
    expect(m.apps.libs.kind).toBe('task');
    expect(m.apps.contracts.kind).toBe('build');
  });
  it('every drafted variant loads', () => {
    const variants: [string, (r: string) => void][] = [
      [
        'no dist libraries',
        (r) => {
          fs.rmSync(path.join(r, 'packages', 'domain'), { recursive: true });
          fs.rmSync(path.join(r, 'packages', 'contracts'), {
            recursive: true,
          });
        },
      ],
      [
        'turbo 1',
        (r) =>
          write(
            r,
            'turbo.json',
            JSON.stringify({
              pipeline: { dev: { persistent: true }, build: {} },
            })
          ),
      ],
      ['a live app named dev', liveAppNamedDev],
      [
        'a live app named all',
        (r) =>
          write(
            r,
            'apps/all/package.json',
            JSON.stringify({ name: '@t/all', scripts: { dev: 'node s.js' } })
          ),
      ],
      [
        'live apps named dev and dev-apps',
        (r) => {
          liveAppNamedDev(r);
          write(
            r,
            'apps/dev-apps/package.json',
            JSON.stringify({
              name: '@t/dev-apps',
              scripts: { dev: 'node s.js' },
            })
          );
        },
      ],
    ];
    for (const [label, mutate] of variants) {
      const r = copy();
      mutate(r);
      const text = draftOf(r);
      expect(
        () => parseManifest(text, r, path.join(r, '.mcproc', 'mcproc.yaml')),
        label
      ).not.toThrow();
    }
  });
  it('the header names the live profile: dev-apps when a live app is named dev', () => {
    const r = copy();
    liveAppNamedDev(r);
    const text = draftOf(r);
    expect(text).toContain(
      'form the dev-apps profile: start dev-apps runs them.'
    );
    expect(text).toContain('\n  dev-apps: [');
  });
  it('a commented profile steps aside from an app of the same name', () => {
    const r = copy();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(r, 'package.json'), 'utf8')
    );
    pkg.scripts.start = 'turbo run start';
    write(r, 'package.json', JSON.stringify(pkg));
    const text = draftOf(r);
    expect(text).toContain('  # start:    # source: package.json:start;');
    expect(text).toContain('  # start-apps: [web-start]\n');
  });
  it('a live cwd is quoted when YAML would cut it', () => {
    const r = copy();
    write(
      r,
      'apps/web #2/package.json',
      JSON.stringify({ name: '@t/hash', scripts: { dev: 'node s.js' } })
    );
    const m = parseManifest(
      draftOf(r),
      r,
      path.join(r, '.mcproc', 'mcproc.yaml')
    );
    expect(m.apps.hash.cwd).toBe('apps/web #2');
  });
  it('a plain repo renders as before: every app commented, the base example profile', () => {
    const text = renderDraft(root, 'mono', discover(root)); // the non-turbo fixture of this file
    expect(text).not.toContain('--- other scripts');
    expect(text).toContain('profiles:\n  # base: [api-build, api]\n');
    expect(text).not.toContain('persistent dev task');
    // the first line carries the date and the temp path
    expect(text.slice(text.indexOf('\n') + 1)).toMatchInlineSnapshot(`
      "#
      # Candidates below are commented out. Uncomment the ones your dev stack needs,
      # write a description for each app, then run start + ls to confirm the ports; fix; repeat.
      # Fields: kind build|server|worker|task (task = runs once, e.g. a build or a migration; ls shows done/failed); run = shell command; cwd relative to the project root;
      # port/ports = declared listening ports; watch = pm2 watch paths (restart a server when its
      # build output changes); depends_on = start order; profiles = named groups of apps;
      # url = the address to open in a browser; ls/describe show it with the HTTP answer, monit shows it;
      # hosts = where this project also runs (ssh alias from ~/.ssh/config and/or docker container);
      # host = the one host an app always runs on (e.g. a dev container); without it the app runs where --host points.
      # note: ecosystem.config.cjs found: JavaScript ecosystem files are not executed by init; port its apps by hand
      version: 1
      project: mono
      apps:
        # dev:    # source: package.json:dev; kind? server; port? 7777
        #   description: ""
        #   kind: server
        #   run: yarn dev
        #   port: 7777
        #   url: http://localhost:7777
        # build-watch:    # source: package.json:build:watch; kind? build
        #   description: ""
        #   kind: build
        #   run: "yarn build:watch"
        # build:    # source: package.json:build; kind? task
        #   description: ""
        #   kind: task
        #   run: yarn build
        # migrate:    # source: package.json:migrate; kind? task
        #   description: ""
        #   kind: task
        #   run: yarn migrate
        # api-dev:    # source: packages/api/package.json:dev; kind? server; port? 4100
        #   description: ""
        #   kind: server
        #   run: yarn dev
        #   cwd: packages/api
        #   port: 4100
        #   url: http://localhost:4100
        # api-start-worker:    # source: packages/api/package.json:start:worker; kind? worker; port? 4100
        #   description: ""
        #   kind: worker
        #   run: "yarn start:worker"
        #   cwd: packages/api
        #   port: 4100
        # web-serve:    # source: apps/web/project.json:serve; kind? server; port? 4200
        #   description: ""
        #   kind: server
        #   run: "npx nx run web:serve"
        #   port: 4200
        #   url: http://localhost:4200
        # web-build:    # source: apps/web/project.json:build; kind? build
        #   description: ""
        #   kind: build
        #   run: "npx nx run web:build --watch"
        # legacy:    # source: ecosystem.json:legacy; kind? server; port? 8080
        #   description: ""
        #   kind: server
        #   run: node build.server.js
        #   port: 8080
        #   url: http://localhost:8080
        # web:    # source: Procfile:web; kind? unknown; port? 5000
        #   description: ""
        #   run: node server.js --port 5000
        #   port: 5000
        #   url: http://localhost:5000
        # migrate-2:    # source: Procfile:migrate; kind? task
        #   description: ""
        #   kind: task
        #   run: node migrate.js
      profiles:
        # base: [api-build, api]
      hosts:
        # stand: { ssh: my-alias, cwd: /srv/project }
        # prod: { ssh: prod-alias, cwd: /srv/project, readonly: true }
      "
    `);
  });
  it('initProject reports live apps, profiles and libs, and points at start dev', () => {
    const r = copy();
    const res = initProject(r);
    expect(res.live).toEqual(['libs', 'libs-watch', 'api', 'web', 'contracts']);
    expect(res.profiles).toEqual(['dev']);
    expect(res.libs).toEqual(['@t/domain']);
    expect(res.next).toContain('start dev');
    expect(res.next).toContain('replace each TODO description');
    expect(() => loadManifest(r)).not.toThrow();
  });
});

describe('guessPort: frameworks and source constants', () => {
  const made: string[] = [];
  const mk = (files: Record<string, string>) => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-port-'));
    made.push(r);
    for (const [f, t] of Object.entries(files)) write(r, f, t);
    return r;
  };
  afterAll(() => {
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  });
  it('next dev/start default to 3000 unless a flag says otherwise', () => {
    const r = mk({});
    expect(guessPort('next dev', r)).toBe(3000);
    expect(
      guessPort('NODE_OPTIONS=--use-system-ca next dev --turbopack', r)
    ).toBe(3000);
    expect(guessPort('next start', r)).toBe(3000);
    expect(guessPort('next dev -p 3001', r)).toBe(3001);
    expect(guessPort('next build', r)).toBeUndefined();
    // a PORT in .env wins over the framework default
    expect(guessPort('next dev', mk({ '.env': 'PORT=4444\n' }))).toBe(4444);
  });
  it('vite reads server.port from its config, with env fallbacks and nested braces; defaults 5173 / 4173', () => {
    expect(guessPort('vite', mk({}))).toBe(5173);
    expect(guessPort('vite preview', mk({}))).toBe(4173);
    expect(guessPort('vite build', mk({}))).toBeUndefined();
    expect(guessPort('vitest --watch', mk({}))).toBeUndefined();
    expect(guessPort('vite-node src/x.ts', mk({}))).toBeUndefined();
    expect(
      guessPort(
        'vite',
        mk({ 'vite.config.ts': 'export default { server: { port: 3002 } }' })
      )
    ).toBe(3002);
    expect(
      guessPort(
        'vite',
        mk({
          'vite.config.mts':
            'export default defineConfig({ server: { host: true, port: Number(process.env.WEB_PORT ?? 3002) } })',
        })
      )
    ).toBe(3002);
    expect(
      guessPort(
        'vite',
        mk({
          'vite.config.js':
            "export default { server: { port: process.env.P || '4100' } }",
        })
      )
    ).toBe(4100);
    expect(
      guessPort(
        'vite',
        mk({
          'vite.config.ts':
            "export default defineConfig({ server: { proxy: { '/api': { target: 'http://localhost:3020', changeOrigin: true } }, port: 3002 } })",
        })
      )
    ).toBe(3002);
    expect(
      guessPort(
        'vite preview',
        mk({
          'vite.config.ts':
            'export default { server: { port: 3002 }, preview: { port: 4300 } }',
        })
      )
    ).toBe(4300);
    expect(
      guessPort(
        'vite preview',
        mk({ 'vite.config.ts': 'export default { server: { port: 3002 } }' })
      )
    ).toBe(4173);
    expect(
      guessPort(
        'vite --port 3333',
        mk({ 'vite.config.ts': 'export default { server: { port: 3002 } }' })
      )
    ).toBe(3333);
    expect(
      guessPort(
        'vite',
        mk({
          'vite.config.ts':
            'export default { server: { port: Number(process.env.WEB_PORT) || 3002 } }',
        })
      )
    ).toBe(3002);
    // the nested hmr port is not the server port
    expect(
      guessPort(
        'vite',
        mk({
          'vite.config.ts':
            'export default { server: { hmr: { port: 24678 } } }',
        })
      )
    ).toBe(5173);
    // vitest's own `test.server` block comes first and holds no port
    expect(
      guessPort(
        'vite',
        mk({
          'vite.config.ts':
            "export default defineConfig({ test: { server: { deps: { inline: ['x'] } } }, server: { port: 3002 } })",
        })
      )
    ).toBe(3002);
    expect(guessPort('vite build && vite preview', mk({}))).toBe(4173);
    expect(guessPort('tsx vite.config.ts', mk({}))).toBeUndefined();
  });
  it('source constants: PORT = N, DEFAULT_PORT = N, process.env.PORT ?? N', () => {
    expect(
      guessPort(
        'tsx watch src/index.ts',
        mk({ 'src/index.ts': 'const DEFAULT_PORT = 3020;\n' })
      )
    ).toBe(3020);
    expect(
      guessPort(
        'node src/main.js',
        mk({ 'src/main.js': 'const PORT: number = 8081;\n' })
      )
    ).toBe(8081);
    expect(
      guessPort(
        'node src/main.js',
        mk({
          'src/main.js': 'const port = Number(process.env.PORT ?? 4010);\n',
        })
      )
    ).toBe(4010);
    expect(
      guessPort(
        'node src/main.js',
        mk({ 'src/main.js': 'app.listen(process.env.PORT || 4020)\n' })
      )
    ).toBe(4020);
    expect(
      guessPort(
        'node src/main.js',
        mk({ 'src/main.js': "const port = process.env.PORT || '4030';\n" })
      )
    ).toBe(4030);
    expect(
      guessPort(
        'node src/main.js',
        mk({
          'src/main.js': 'const port = Number(process.env.PORT) || 4040;\n',
        })
      )
    ).toBe(4040);
    expect(
      guessPort(
        'node src/main.js',
        mk({ 'src/main.js': 'const PORTAL = 12;\n' })
      )
    ).toBeUndefined();
  });
});

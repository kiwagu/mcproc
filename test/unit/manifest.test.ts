import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseManifest,
  loadManifest,
  findManifestPath,
  defaultProject,
  scopeManifest,
} from '../../src/core/manifest.js';
import { McprocError } from '../../src/core/errors.js';
import { pickHost, assertApp } from '../../src/core/resolve.js';
import { resolveTargets } from '../../src/core/actions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const varsProj = path.join(here, '..', 'fixtures', 'projects', 'vars');

function parse(yaml: string) {
  return parseManifest(yaml, '/proj', '/proj/.mcproc/mcproc.yaml');
}
function expectInvalid(yaml: string, fragment: string) {
  try {
    parse(yaml);
  } catch (e) {
    expect(e).toBeInstanceOf(McprocError);
    expect((e as McprocError).code).toBe('MANIFEST_INVALID');
    expect((e as McprocError).message).toContain(fragment);
    return;
  }
  throw new Error('expected MANIFEST_INVALID');
}

describe('loadManifest', () => {
  it('finds the manifest from a subdirectory and resolves defaults', () => {
    const m = loadManifest(path.join(basic, 'apps', 'api'));
    expect(m.root).toBe(basic);
    expect(m.project).toBe('demo');
    expect(Object.keys(m.apps)).toEqual(['api-build', 'api', 'worker']);
    expect(m.apps.api.kind).toBe('server');
    expect(m.apps.api.env).toEqual({ PORT: '3310', DEBUG: 'true' });
    expect(m.apps.api.ports).toEqual([3310]);
    expect(m.apps.api.watch_delay).toBe(1000);
    expect(m.apps['api-build'].ports).toEqual([]);
    expect(m.apps.worker.pm2).toEqual({ kill_timeout: 3000 });
    expect(m.hosts.local).toMatchObject({
      name: 'local',
      local: true,
      cwd: basic,
      readonly: false,
      shell: { bin: '/bin/bash', flags: ['-lc'] },
    });
    expect(m.hosts.stand).toMatchObject({
      ssh: 'stand',
      cwd: '/srv/demo',
      readonly: false,
    });
    expect(m.hosts.prod).toMatchObject({
      ssh: 'prod',
      docker: { container: 'demo-app', user: 'node' },
      readonly: true,
      pm2_home: '/home/node/.pm2',
    });
  });
  it('throws MANIFEST_NOT_FOUND with the init hint outside a project', () => {
    expect(findManifestPath('/')).toBeNull();
    try {
      loadManifest('/');
    } catch (e) {
      expect((e as McprocError).code).toBe('MANIFEST_NOT_FOUND');
      expect((e as McprocError).hint).toContain('init');
      return;
    }
    throw new Error('expected throw');
  });
  it('defaults project to a sanitised basename', () => {
    expect(defaultProject('/x/My Project!')).toBe('my-project');
    const m = parse('version: 1\napps:\n  a: { description: d, run: r }\n');
    expect(m.project).toBe('proj');
  });
});

describe('validation', () => {
  const base = 'version: 1\napps:\n  a: { description: d, run: r }\n';
  it('rejects unknown keys, bad names, empty apps', () => {
    expectInvalid('version: 1\napps: {}\n', 'at least one app');
    expectInvalid(`${base}extra: 1\n`, 'extra');
    expectInvalid(
      'version: 1\napps:\n  Bad_Name: { description: d, run: r }\n',
      'Bad_Name'
    );
    expectInvalid(
      'version: 2\napps:\n  a: { description: d, run: r }\n',
      'version'
    );
  });
  it('rejects port+ports, unknown depends_on, cycles, protected pm2 keys', () => {
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, port: 1, ports: [2] }\n',
      'either port or ports'
    );
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, depends_on: [zz] }\n',
      'unknown app "zz"'
    );
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, depends_on: [b] }\n  b: { description: d, run: r, depends_on: [a] }\n',
      'cycle'
    );
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, pm2: { name: x } }\n',
      'pm2.name'
    );
  });
  it('rejects reserved profile and unknown profile members', () => {
    expectInvalid(`${base}profiles: { all: [a] }\n`, 'profiles.all');
    expectInvalid(`${base}profiles: { p: [nope] }\n`, 'unknown app "nope"');
  });
  it('requires absolute paths for host cwd, runtime and pm2_home ("~" is never expanded)', () => {
    expectInvalid(
      `${base}hosts: { h: { ssh: x, cwd: "~/demo" } }\n`,
      'absolute'
    );
    expectInvalid(`${base}hosts: { h: { ssh: x, cwd: demo } }\n`, 'absolute');
    expectInvalid(
      `${base}hosts: { h: { ssh: x, cwd: /srv/d, runtime: rt } }\n`,
      'absolute'
    );
    expectInvalid(
      `${base}hosts: { h: { ssh: x, cwd: /srv/d, pm2_home: "~/.pm2" } }\n`,
      'absolute'
    );
    expectInvalid(
      `${base}hosts: { local: { pm2_home: "~/.pm2" } }\n`,
      'absolute'
    );
  });
  it('validates hosts', () => {
    expectInvalid(`${base}hosts: { local: { ssh: x } }\n`, 'hosts.local');
    expectInvalid(`${base}hosts: { h: { cwd: /x } }\n`, 'needs ssh or docker');
    expectInvalid(`${base}hosts: { h: { ssh: x } }\n`, 'cwd');
    expectInvalid(
      `${base}hosts: { h: { ssh: "-oProxyCommand=x", cwd: /x } }\n`,
      'must not start with'
    );
    const m = parse(
      `${base}hosts: { local: { shell: "/bin/sh -c", pm2: /opt/pm2 } }\n`
    );
    expect(m.hosts.local.shell).toEqual({ bin: '/bin/sh', flags: ['-c'] });
    expect(m.hosts.local.pm2).toBe('/opt/pm2');
  });
  it('accepts an http(s) url per app and rejects anything else', () => {
    const m = parse(
      'version: 1\napps:\n  web:\n    description: d\n    run: x\n    port: 3100\n    url: http://localhost:3100/\n'
    );
    expect(m.apps.web.url).toBe('http://localhost:3100/');
    expect(
      parse('version: 1\napps:\n  web:\n    description: d\n    run: x\n').apps
        .web.url
    ).toBeNull();
    expect(() =>
      parse(
        'version: 1\napps:\n  web:\n    description: d\n    run: x\n    url: localhost:3100\n'
      )
    ).toThrow(/url/);
    expect(() =>
      parse(
        'version: 1\napps:\n  web:\n    description: d\n    run: x\n    url: ftp://x/\n'
      )
    ).toThrow(/url/);
  });
});

describe('host-bound apps', () => {
  const base = 'version: 1\nhosts:\n  box: { ssh: box, cwd: /srv/p }\napps:\n';
  it('host: binds an app to a declared host or to local; unbound apps carry null', () => {
    const m = parse(
      base +
        '  a: { description: d, run: r, host: box }\n  b: { description: d, run: r, host: local }\n  c: { description: d, run: r }\n'
    );
    expect(m.apps.a.host).toBe('box');
    expect(m.apps.b.host).toBe('local');
    expect(m.apps.c.host).toBeNull();
  });
  it('rejects a host that the manifest does not declare', () => {
    expectInvalid(
      `${base}  a: { description: d, run: r, host: nowhere }\n`,
      'apps.a.host: unknown host "nowhere"'
    );
  });
});

describe('scopeManifest', () => {
  const fleet = loadManifest(
    path.join(here, '..', 'fixtures', 'projects', 'fleet')
  );
  it('keeps the apps that run on the host: bound to it, or unbound when it is the fallback', () => {
    expect(Object.keys(scopeManifest(fleet, 'local', 'local').apps)).toEqual([
      'watch',
      'tool',
    ]);
    expect(Object.keys(scopeManifest(fleet, 'box', 'local').apps)).toEqual([
      'web',
    ]);
    expect(Object.keys(scopeManifest(fleet, 'box', 'box').apps)).toEqual([
      'web',
      'tool',
    ]);
  });
  it('drops dependencies and profile members that run elsewhere, so the view stays self-consistent', () => {
    const box = scopeManifest(fleet, 'box', 'local');
    expect(box.apps.web.depends_on).toEqual([]);
    expect(box.profiles).toEqual({ dev: ['web'], builds: [] });
    expect(fleet.apps.web.depends_on).toEqual([
      { app: 'watch', condition: 'started', timeoutMs: 60_000 },
    ]); // the full manifest is untouched
  });
});

describe('errors settings', () => {
  const app = (extra: string) =>
    parse(`version: 1\napps:\n  a: { description: d, run: r${extra} }\n`).apps
      .a;
  it('defaults: built-in markers on, stderr not an error, 3 lines before and 5 after', () => {
    expect(app('').errors).toEqual({
      match: [],
      ignore: [],
      context: [3, 5],
      stderr: false,
      defaults: true,
    });
  });
  it('per-app settings; errors: false turns detection off', () => {
    expect(
      app(
        `, errors: { match: ['5\\d\\d'], ignore: [healthcheck], context: [1, 2], stderr: true, defaults: false }`
      ).errors
    ).toEqual({
      match: ['5\\d\\d'],
      ignore: ['healthcheck'],
      context: [1, 2],
      stderr: true,
      defaults: false,
    });
    expect(app(', errors: false').errors).toBeNull();
  });
  it('an invalid pattern is MANIFEST_INVALID naming the app and the pattern; context is bounded', () => {
    expectInvalid(
      `version: 1\napps:\n  a: { description: d, run: r, errors: { match: ['(unclosed'] } }\n`,
      'apps.a.errors.match: invalid pattern "(unclosed"'
    );
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, errors: { context: [3, 99] } }\n',
      'errors.context'
    );
  });
  it('a pattern that repeats a repeat (exponential on a near-miss line) is MANIFEST_INVALID with how to fix it', () => {
    expectInvalid(
      `version: 1\napps:\n  a: { description: d, run: r, errors: { ignore: ['(\\w+\\s*)+healthcheck'] } }\n`,
      'apps.a.errors.ignore: pattern "(\\w+\\s*)+healthcheck" repeats a group that ends in a repeat'
    );
  });
  it('names that would widen a stop or delete are refused: an app called all, an app named like a profile', () => {
    expectInvalid(
      'version: 1\napps:\n  all: { description: d, run: r }\n',
      'apps.all: reserved'
    );
    expectInvalid(
      'version: 1\napps:\n  api: { description: d, run: r }\n  worker: { description: d, run: r }\nprofiles:\n  api: [api, worker]\n',
      'profiles.api: an app has this name'
    );
  });
  it('pm2 settings that start several processes of one app are refused: stop and delete act on one process per app', () => {
    for (const v of ['2', 'max', '0', '-1'])
      expectInvalid(
        `version: 1\napps:\n  a: { description: d, run: r, pm2: { instances: ${v} } }\n`,
        'apps.a.pm2.instances'
      );
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, pm2: { exec_mode: cluster } }\n',
      'apps.a.pm2.exec_mode'
    );
    expect(() =>
      parse(
        'version: 1\napps:\n  a: { description: d, run: r, pm2: { instances: 1, exec_mode: fork } }\n'
      )
    ).not.toThrow();
  });
  it('names inherited from JavaScript objects are never apps, hosts or profiles', () => {
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, depends_on: [constructor] }\n',
      'apps.a.depends_on: unknown app "constructor"'
    );
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, host: constructor }\n',
      'apps.a.host: unknown host "constructor"'
    );
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r }\nprofiles:\n  p: [constructor]\n',
      'profiles.p: unknown app "constructor"'
    );
    const m = parse('version: 1\napps:\n  a: { description: d, run: r }\n');
    expect(() => resolveTargets(m, 'constructor')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_APP' })
    );
    expect(() => resolveTargets(m, '__proto__')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_APP' })
    );
    expect(() => pickHost(m, 'constructor')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_HOST' })
    );
    expect(() => assertApp(m, 'hasOwnProperty')).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_APP' })
    );
  });
  it("the log stamp pm2 writes is mcproc's to set: time and log_date_format are protected", () => {
    for (const key of ['time: true', "log_date_format: 'YYYY'"])
      expectInvalid(
        `version: 1\napps:\n  a: { description: d, run: r, pm2: { ${key} } }\n`,
        `apps.a.pm2.${key.split(':')[0]}: managed by mcproc`
      );
  });
});

const readiness = path.join(here, '..', 'fixtures', 'projects', 'readiness');

describe('reloads settings', () => {
  const app = (extra: string) =>
    parse(`version: 1\napps:\n  a: { description: d, run: r${extra} }\n`).apps
      .a;
  it('defaults: built-in markers on, no own patterns; reloads: false turns detection off', () => {
    expect(app('').reloads).toEqual({ match: [], ignore: [], defaults: true });
    expect(app(', reloads: false').reloads).toBeNull();
  });
  it('per-app settings; what is left out keeps its default', () => {
    expect(
      app(`, reloads: { match: ['^x'], defaults: false }`).reloads
    ).toEqual({ match: ['^x'], ignore: [], defaults: false });
  });
  it('an unknown key is MANIFEST_INVALID naming the field', () => {
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, run: r, reloads: { context: [1, 2] } }\n',
      "apps.a.reloads: Unrecognized key(s) in object: 'context'"
    );
  });
  it('patterns are checked like the errors patterns: the same messages, under their own field', () => {
    expectInvalid(
      `version: 1\napps:\n  a: { description: d, run: r, reloads: { match: ['(unclosed'] } }\n`,
      'apps.a.reloads.match: invalid pattern "(unclosed"'
    );
    let details: unknown;
    try {
      parse(
        `version: 1\napps:\n  a: { description: d, run: r, errors: { ignore: ['(\\w+\\s*)+x'] }, reloads: { ignore: ['(\\w+\\s*)+x'] } }\n`
      );
    } catch (e) {
      details = (e as McprocError).details;
    }
    const why =
      'pattern "(\\w+\\s*)+x" repeats a group that ends in a repeat (like (a+)+), which can run for minutes on a log line that almost matches; rewrite it without the nested repeat';
    expect(details).toEqual([
      `apps.a.errors.ignore: ${why}`,
      `apps.a.reloads.ignore: ${why}`,
    ]);
  });
});

describe('kind: task and depends_on conditions', () => {
  it('a task has autorestart off by default; the other kinds keep it on', () => {
    const m = loadManifest(readiness);
    expect(m.apps.libs.kind).toBe('task');
    expect(m.apps.libs.autorestart).toBe(false);
    expect(m.apps.api.autorestart).toBe(true);
    expect(m.apps.logger.autorestart).toBe(true);
  });
  it('autorestart: true on a task is refused', () => {
    expectInvalid(
      'version: 1\napps:\n  t: { description: d, kind: task, run: r, autorestart: true }\n',
      'apps.t.autorestart: a task runs once'
    );
  });
  it('depends_on takes names and objects; names mean started with the default timeout', () => {
    const m = loadManifest(readiness);
    expect(m.apps.api.depends_on).toEqual([
      { app: 'libs', condition: 'completed', timeoutMs: 60_000 },
    ]);
    expect(m.apps.web.depends_on).toEqual([
      { app: 'api', condition: 'ready', timeoutMs: 90_000 },
      { app: 'logger', condition: 'started', timeoutMs: 60_000 },
    ]);
    expect(m.apps.cli.depends_on).toEqual([
      { app: 'libs', condition: 'started', timeoutMs: 60_000 },
    ]);
  });
  it('completed needs a task; ready needs a port or a url', () => {
    expectInvalid(
      'version: 1\napps:\n  s: { description: d, run: r }\n  w: { description: d, run: r, depends_on: [{ app: s, condition: completed }] }\n',
      'apps.w.depends_on: "s" must be kind: task for condition completed (it is server)'
    );
    expectInvalid(
      'version: 1\napps:\n  s: { description: d, run: r }\n  w: { description: d, run: r, depends_on: [{ app: s, condition: ready }] }\n',
      'apps.w.depends_on: "s" declares no port or url, so ready cannot be observed'
    );
  });
  it('depends_on objects are validated', () => {
    expectInvalid(
      'version: 1\napps:\n  t: { description: d, kind: task, run: r }\n  w: { description: d, run: r, depends_on: [{ app: t, condition: completed, timeout: 0 }] }\n',
      'apps.w.depends_on.0.timeout'
    );
    expectInvalid(
      'version: 1\napps:\n  t: { description: d, kind: task, run: r }\n  w: { description: d, run: r, depends_on: [{ app: t, condition: completed, timeout: 601 }] }\n',
      'apps.w.depends_on.0.timeout'
    );
    expectInvalid(
      'version: 1\napps:\n  t: { description: d, kind: task, run: r }\n  w: { description: d, run: r, depends_on: [{ app: t, condition: finished }] }\n',
      'apps.w.depends_on.0.condition'
    );
    expectInvalid(
      'version: 1\napps:\n  w: { description: d, run: r, depends_on: [{ app: nope }] }\n',
      'apps.w.depends_on: unknown app "nope"'
    );
  });
  it('cycles are found through object entries too', () => {
    expectInvalid(
      'version: 1\napps:\n  a: { description: d, kind: task, run: r, depends_on: [{ app: b, condition: ready }] }\n  b: { description: d, run: r, port: 1, depends_on: [a] }\n',
      'depends_on cycle: a -> b -> a'
    );
  });
  it('scopeManifest keeps the conditions of the dependencies that stay', () => {
    const m = loadManifest(readiness);
    const s = scopeManifest(m, 'local', 'local');
    expect(s.apps.web.depends_on.map((d) => d.app)).toEqual(['api', 'logger']);
  });
});

describe('url_check', () => {
  const app = (extra: string) =>
    parse(`version: 1\napps:\n  a: { description: d, run: r${extra} }\n`).apps
      .a;
  it('defaults to auto and takes host or here', () => {
    expect(app(', url: http://localhost:3000/').url_check).toBe('auto');
    expect(
      app(', url: http://localhost:3000/, url_check: host').url_check
    ).toBe('host');
    expect(
      app(', url: http://localhost:3000/, url_check: here').url_check
    ).toBe('here');
    expect(app('').url_check).toBe('auto'); // no url: the default stays, nothing is checked
  });
  it('is refused without a url, and for an unknown value', () => {
    expect(() => app(', url_check: here')).toThrowError(
      expect.objectContaining({
        code: 'MANIFEST_INVALID',
        message: expect.stringContaining(
          'apps.a.url_check: there is no url to check; declare url or drop url_check'
        ),
      })
    );
    expect(() =>
      app(', url: http://localhost:3000/, url_check: browser')
    ).toThrowError(
      expect.objectContaining({
        code: 'MANIFEST_INVALID',
        message: expect.stringContaining('apps.a.url_check'),
      })
    );
  });
});

describe('vars, override and the new sections', () => {
  it('renders the fixture with its override: slot 2, project demo-w2, ports shifted', () => {
    const m = loadManifest(varsProj);
    expect(m.base_project).toBe('demo');
    expect(m.project).toBe('demo-w2');
    expect(m.override).toBe(
      path.join(varsProj, '.mcproc', 'mcproc.local.yaml')
    );
    expect(m.slot).toBe(2);
    expect(m.vars).toEqual([
      { name: 'project', value: 'demo-w2', source: 'built-in' },
      { name: 'root', value: varsProj, source: 'built-in' },
      { name: 'slot', value: 2, source: 'override' },
      { name: 'api_port', value: 3510, source: 'manifest' },
      { name: 'db_port', value: 5632, source: 'manifest' },
    ]);
    expect(m.apps.api.ports).toEqual([3510]);
    expect(m.apps.api.url).toBe('http://127.0.0.1:3510/health');
    expect(m.apps.api.env).toEqual({ PORT: '3510', NAME: 'demo-w2' });
    expect(m.apps.api.memory_mib).toBe(256);
    expect(m.apps.api.containers).toEqual([]);
    expect(m.apps.db.run).toBe(
      'docker run --rm --name demo-w2-db -p 127.0.0.1:5632:5432 pg'
    );
    expect(m.apps.db.description).toBe('database in docker for slot 2');
    expect(m.apps.db.containers).toEqual(['demo-w2-db']);
    expect(m.apps.db.memory_mib).toBe(512);
    expect(m.apps.tool.memory_mib).toBeNull();
    expect(m.resources).toEqual({
      reserve: { kind: 'mib', mib: 1024 },
      margin: 0.2,
      settle: 5,
    });
    expect(m.worktree).toEqual({
      dir: null,
      copy: ['certs', 'snaps/**/*-snapshots'],
      link: ['notes'],
      install: false,
      slots: 9,
    });
    expect(m.exec).toEqual({
      env: { API_URL: 'http://127.0.0.1:3510', DB_PORT: '5632' },
    });
  });
  it('without an override the same manifest is slot 0 with the base slug', () => {
    const text = fs.readFileSync(
      path.join(varsProj, '.mcproc', 'mcproc.yaml'),
      'utf8'
    );
    const m = parseManifest(
      text,
      varsProj,
      path.join(varsProj, '.mcproc', 'mcproc.yaml'),
      null
    );
    expect(m.project).toBe('demo');
    expect(m.override).toBeNull();
    expect(m.slot).toBe(0);
    expect(m.apps.api.ports).toEqual([3310]);
    expect(m.apps.db.containers).toEqual(['demo-db']);
  });
  it('defaults: no vars, 2G reserve, 10% margin, 20 s settle, empty worktree and exec', () => {
    const m = parse('version: 1\napps:\n  a: { description: x, run: y }\n');
    expect(m.vars).toEqual([
      { name: 'project', value: 'proj', source: 'built-in' },
      { name: 'root', value: '/proj', source: 'built-in' },
    ]);
    expect(m.slot).toBeNull();
    expect(m.resources).toEqual({
      reserve: { kind: 'mib', mib: 2048 },
      margin: 0.1,
      settle: 20,
    });
    expect(m.worktree).toEqual({
      dir: null,
      copy: [],
      link: [],
      install: null,
      slots: 9,
    });
    expect(m.exec).toEqual({ env: {} });
    expect(m.apps.a.memory_mib).toBeNull();
    expect(m.apps.a.containers).toEqual([]);
  });
  it('reads a percent reserve', () => {
    const m = parse(
      'version: 1\nresources: { reserve: 15% }\napps:\n  a: { description: x, run: y }\n'
    );
    expect(m.resources.reserve).toEqual({ kind: 'percent', ratio: 0.15 });
  });
  it('refuses an unknown var, a bad template, a cycle, a non-integer port and a template in project', () => {
    const base =
      'version: 1\napps:\n  a: { description: x, run: "{{ nope }}" }\n';
    expect(() => parse(base)).toThrow(/apps\.a\.run: unknown var "nope"/);
    expect(() => parse(base)).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_VAR' })
    );
    expect(() =>
      parse(
        'version: 1\nvars: { p: "{{ 1 +" }\napps:\n  a: { description: x, run: y }\n'
      )
    ).toThrowError(expect.objectContaining({ code: 'BAD_TEMPLATE' }));
    expect(() =>
      parse(
        'version: 1\nvars: { a: "{{ b }}", b: "{{ a }}" }\napps:\n  a: { description: x, run: y }\n'
      )
    ).toThrowError(expect.objectContaining({ code: 'VAR_CYCLE' }));
    expect(() =>
      parse(
        'version: 1\nvars: { p: "{{ 3310 / 7 * 7 + 1 }}" }\napps:\n  a: { description: x, run: y, port: "{{ p }}x" }\n'
      )
    ).toThrow(/apps\.a\.port: must render to an integer/);
    expect(() =>
      parse(
        'version: 1\nproject: "{{ x }}"\napps:\n  a: { description: x, run: y }\n'
      )
    ).toThrow(/project/);
    expect(() =>
      parse(
        'version: 1\nvars: { Bad-Name: 1 }\napps:\n  a: { description: x, run: y }\n'
      )
    ).toThrow(/vars/);
    expect(() =>
      parse(
        'version: 1\napps:\n  a: { description: x, run: y, memory: huge }\n'
      )
    ).toThrow(/apps\.a\.memory/);
  });
  it('refuses an override var the manifest does not declare', () => {
    const text =
      'version: 1\nvars: { slot: 0 }\napps:\n  a: { description: x, run: y }\n';
    expect(() =>
      parseManifest(text, '/proj', '/proj/.mcproc/mcproc.yaml', {
        path: '/proj/.mcproc/mcproc.local.yaml',
        vars: { slut: 1 },
      })
    ).toThrowError(expect.objectContaining({ code: 'UNKNOWN_VAR' }));
  });
});

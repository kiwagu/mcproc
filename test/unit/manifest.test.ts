import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, loadManifest, findManifestPath, defaultProject, scopeManifest } from '../../src/core/manifest.js';
import { McprocError } from '../../src/core/errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

function parse(yaml: string) {
  return parseManifest(yaml, '/proj', '/proj/.mcproc/mcproc.yaml');
}
function expectInvalid(yaml: string, fragment: string) {
  try { parse(yaml); } catch (e) {
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
    expect(m.hosts.local).toMatchObject({ name: 'local', local: true, cwd: basic, readonly: false, shell: { bin: '/bin/bash', flags: ['-lc'] } });
    expect(m.hosts.stand).toMatchObject({ ssh: 'stand', cwd: '/srv/demo', readonly: false });
    expect(m.hosts.prod).toMatchObject({ ssh: 'prod', docker: { container: 'demo-app', user: 'node' }, readonly: true, pm2_home: '/home/node/.pm2' });
  });
  it('throws MANIFEST_NOT_FOUND with the init hint outside a project', () => {
    expect(findManifestPath('/')).toBeNull();
    try { loadManifest('/'); } catch (e) {
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
    expectInvalid(base + 'extra: 1\n', 'extra');
    expectInvalid('version: 1\napps:\n  Bad_Name: { description: d, run: r }\n', 'Bad_Name');
    expectInvalid('version: 2\napps:\n  a: { description: d, run: r }\n', 'version');
  });
  it('rejects port+ports, unknown depends_on, cycles, protected pm2 keys', () => {
    expectInvalid('version: 1\napps:\n  a: { description: d, run: r, port: 1, ports: [2] }\n', 'either port or ports');
    expectInvalid('version: 1\napps:\n  a: { description: d, run: r, depends_on: [zz] }\n', 'unknown app "zz"');
    expectInvalid('version: 1\napps:\n  a: { description: d, run: r, depends_on: [b] }\n  b: { description: d, run: r, depends_on: [a] }\n', 'cycle');
    expectInvalid('version: 1\napps:\n  a: { description: d, run: r, pm2: { name: x } }\n', 'pm2.name');
  });
  it('rejects reserved profile and unknown profile members', () => {
    expectInvalid(base + 'profiles: { all: [a] }\n', 'profiles.all');
    expectInvalid(base + 'profiles: { p: [nope] }\n', 'unknown app "nope"');
  });
  it('requires absolute paths for host cwd, runtime and pm2_home ("~" is never expanded)', () => {
    expectInvalid(base + 'hosts: { h: { ssh: x, cwd: "~/demo" } }\n', 'absolute');
    expectInvalid(base + 'hosts: { h: { ssh: x, cwd: demo } }\n', 'absolute');
    expectInvalid(base + 'hosts: { h: { ssh: x, cwd: /srv/d, runtime: rt } }\n', 'absolute');
    expectInvalid(base + 'hosts: { h: { ssh: x, cwd: /srv/d, pm2_home: "~/.pm2" } }\n', 'absolute');
    expectInvalid(base + 'hosts: { local: { pm2_home: "~/.pm2" } }\n', 'absolute');
  });
  it('validates hosts', () => {
    expectInvalid(base + 'hosts: { local: { ssh: x } }\n', 'hosts.local');
    expectInvalid(base + 'hosts: { h: { cwd: /x } }\n', 'needs ssh or docker');
    expectInvalid(base + 'hosts: { h: { ssh: x } }\n', 'cwd');
    expectInvalid(base + 'hosts: { h: { ssh: "-oProxyCommand=x", cwd: /x } }\n', 'must not start with');
    const m = parse(base + 'hosts: { local: { shell: "/bin/sh -c", pm2: /opt/pm2 } }\n');
    expect(m.hosts.local.shell).toEqual({ bin: '/bin/sh', flags: ['-c'] });
    expect(m.hosts.local.pm2).toBe('/opt/pm2');
  });
  it('accepts an http(s) url per app and rejects anything else', () => {
    const m = parse('version: 1\napps:\n  web:\n    description: d\n    run: x\n    port: 3100\n    url: http://localhost:3100/\n');
    expect(m.apps.web.url).toBe('http://localhost:3100/');
    expect(parse('version: 1\napps:\n  web:\n    description: d\n    run: x\n').apps.web.url).toBeNull();
    expect(() => parse('version: 1\napps:\n  web:\n    description: d\n    run: x\n    url: localhost:3100\n')).toThrow(/url/);
    expect(() => parse('version: 1\napps:\n  web:\n    description: d\n    run: x\n    url: ftp://x/\n')).toThrow(/url/);
  });
});

describe('host-bound apps', () => {
  const base = 'version: 1\nhosts:\n  box: { ssh: box, cwd: /srv/p }\napps:\n';
  it('host: binds an app to a declared host or to local; unbound apps carry null', () => {
    const m = parse(base + '  a: { description: d, run: r, host: box }\n  b: { description: d, run: r, host: local }\n  c: { description: d, run: r }\n');
    expect(m.apps.a.host).toBe('box');
    expect(m.apps.b.host).toBe('local');
    expect(m.apps.c.host).toBeNull();
  });
  it('rejects a host that the manifest does not declare', () => {
    expectInvalid(base + '  a: { description: d, run: r, host: nowhere }\n', 'apps.a.host: unknown host "nowhere"');
  });
});

describe('scopeManifest', () => {
  const fleet = loadManifest(path.join(here, '..', 'fixtures', 'projects', 'fleet'));
  it('keeps the apps that run on the host: bound to it, or unbound when it is the fallback', () => {
    expect(Object.keys(scopeManifest(fleet, 'local', 'local').apps)).toEqual(['watch', 'tool']);
    expect(Object.keys(scopeManifest(fleet, 'box', 'local').apps)).toEqual(['web']);
    expect(Object.keys(scopeManifest(fleet, 'box', 'box').apps)).toEqual(['web', 'tool']);
  });
  it('drops dependencies and profile members that run elsewhere, so the view stays self-consistent', () => {
    const box = scopeManifest(fleet, 'box', 'local');
    expect(box.apps.web.depends_on).toEqual([]);
    expect(box.profiles).toEqual({ dev: ['web'], builds: [] });
    expect(fleet.apps.web.depends_on).toEqual(['watch']); // the full manifest is untouched
  });
});

describe('errors settings', () => {
  const app = (extra: string) => parse(`version: 1\napps:\n  a: { description: d, run: r${extra} }\n`).apps.a;
  it('defaults: built-in markers on, stderr not an error, 3 lines before and 5 after', () => {
    expect(app('').errors).toEqual({ match: [], ignore: [], context: [3, 5], stderr: false, defaults: true });
  });
  it('per-app settings; errors: false turns detection off', () => {
    expect(app(`, errors: { match: ['5\\d\\d'], ignore: [healthcheck], context: [1, 2], stderr: true, defaults: false }`).errors)
      .toEqual({ match: ['5\\d\\d'], ignore: ['healthcheck'], context: [1, 2], stderr: true, defaults: false });
    expect(app(', errors: false').errors).toBeNull();
  });
  it('an invalid pattern is MANIFEST_INVALID naming the app and the pattern; context is bounded', () => {
    expectInvalid(`version: 1\napps:\n  a: { description: d, run: r, errors: { match: ['(unclosed'] } }\n`, 'apps.a.errors.match: invalid pattern "(unclosed"');
    expectInvalid('version: 1\napps:\n  a: { description: d, run: r, errors: { context: [3, 99] } }\n', 'errors.context');
  });
  it('a pattern that repeats a repeat (exponential on a near-miss line) is MANIFEST_INVALID with how to fix it', () => {
    expectInvalid(`version: 1\napps:\n  a: { description: d, run: r, errors: { ignore: ['(\\w+\\s*)+healthcheck'] } }\n`, 'apps.a.errors.ignore: pattern "(\\w+\\s*)+healthcheck" repeats a group that ends in a repeat');
  });
});

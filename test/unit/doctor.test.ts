import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest, type Manifest } from '../../src/core/manifest.js';
import { doctor } from '../../src/core/doctor.js';
import type { HereCheck } from '../../src/core/urlcheck.js';
import { renderDoctor } from '../../src/mcp/render.js';
import type { Spawner } from '../../src/transport/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const neverHere: HereCheck = async (u) => {
  throw new Error(`no check from this machine expected: ${u}`);
};

// The jlist branch must come before the 'bin/pm2' one: the locally bundled pm2 command contains '.../pm2/bin/pm2' too.
const spawner: Spawner = async (argv) => {
  const cmd = argv[argv.length - 1];
  if (argv[0] === 'ssh' && argv.includes('stand'))
    return {
      code: 255,
      stdout: '',
      stderr: 'ssh: connect to host stand port 22: Connection refused',
    };
  if (cmd.includes('__MCPROC_ENV__'))
    return {
      code: 0,
      stdout:
        '__MCPROC_ENV__\ncontainer none\nhostname dev\nself 127.0.1.1 127.0.0.1 ::1\n__MCPROC_URL__\nhttp://localhost:3310/health\t200\t0\t::1\n',
      stderr: '',
    };
  if (argv[0] === 'ssh' && argv.includes('prod')) {
    if (cmd.includes('__MCPROC_DOCTOR__'))
      return {
        code: 0,
        stdout:
          '__MCPROC_DOCTOR__\nv20.1.0\ntool ps yes\ntool ss no\ntool tar yes\npm2home /home/node/.pm2\nRUNTIME no\n',
        stderr: '',
      };
    if (cmd.includes('jlist')) return { code: 0, stdout: '[]', stderr: '' };
    if (cmd.includes('bin/pm2'))
      return { code: 0, stdout: 'PATH_OK\n5.3.0\nv20.1.0\n', stderr: '' };
  }
  if (cmd.includes('__MCPROC_DOCTOR__'))
    return {
      code: 0,
      stdout:
        '__MCPROC_DOCTOR__\nv22.3.0\ntool ps yes\ntool ss yes\ntool tar yes\npm2home \nRUNTIME no\n',
      stderr: '',
    };
  if (cmd.includes('jlist'))
    return {
      code: 0,
      stdout: JSON.stringify([
        {
          pid: 1,
          name: 'demo-api',
          pm_id: 0,
          pm2_env: { status: 'online', namespace: 'demo' },
        },
      ]),
      stderr: '',
    };
  if (cmd.includes('bin/pm2'))
    return { code: 0, stdout: 'PATH_NONE\nv22.3.0\n', stderr: '' };
  return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
};

describe('doctor', () => {
  it('reports every host, continues past an unreachable one, recommends fixes', async () => {
    const m = loadManifest(basic);
    const reps = await doctor(m, undefined, spawner, neverHere);
    expect(reps.map((r) => r.host)).toEqual(['local', 'stand', 'prod']);
    const [local, stand, prod] = reps;
    expect(local).toMatchObject({
      reachable: true,
      node: 'v22.3.0',
      tools: { ps: true, ss: true, tar: true },
      daemon: 'answers',
      processes: 1,
      in_namespace: 1,
    });
    expect(local.pm2?.source).toBe('bundled');
    expect(local.recommendations).toEqual([]);
    expect(stand.reachable).toBe(false);
    expect(stand.error).toContain('Connection refused');
    expect(stand.recommendations[0]).toContain('ssh stand');
    expect(prod).toMatchObject({
      reachable: true,
      node: 'v20.1.0',
      pm2: { source: 'path', version: '5.3.0' },
      pm2_home: '/home/node/.pm2',
      daemon: 'answers',
      processes: 0,
    });
    expect(prod.tools.ss).toBe(false);
    expect(prod.recommendations.join('\n')).toMatch(/pm2_home/);
    expect(prod.recommendations.join('\n')).toMatch(/no ss/);
    expect(local.environment).toEqual({
      container: 'none',
      hostname: 'dev',
      self: ['127.0.1.1', '127.0.0.1', '::1'],
    });
    expect(local.urls).toEqual([
      {
        app: 'api',
        url: 'http://localhost:3310/health',
        name: 'localhost',
        addr: '::1',
        itself: false,
        check: { status: 'ok', code: 200, from: 'host', reason: null },
      },
    ]);
    expect(prod.urls).toEqual([]); // no app runs there
    expect(stand).toMatchObject({ environment: null, urls: [] }); // unreachable: no url step
    expect(stand.recommendations).toHaveLength(1); // the ssh one; no failed url step
  });
  it('limits to one host when asked', async () => {
    const reps = await doctor(loadManifest(basic), 'prod', spawner, neverHere);
    expect(reps.map((r) => r.host)).toEqual(['prod']);
  });
  it('recommends unpack when a host lacks pm2, Node or tar, and reports the unpacked runtime versions', async () => {
    const sp: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (argv.includes('stand')) {
        if (cmd.includes('__MCPROC_DOCTOR__'))
          return {
            code: 0,
            stdout:
              '__MCPROC_DOCTOR__\nNODE_NONE\ntool ps yes\ntool ss yes\ntool tar no\npm2home \nRUNTIME no\n__MCPROC_LOCK__\n',
            stderr: '',
          };
        if (cmd.includes('bin/pm2'))
          return { code: 0, stdout: 'PATH_NONE\nNODE_NONE\n', stderr: '' };
      }
      if (argv.includes('prod')) {
        if (cmd.includes('__MCPROC_DOCTOR__'))
          return {
            code: 0,
            stdout: `__MCPROC_DOCTOR__\nv20.1.0\ntool ps yes\ntool ss yes\ntool tar yes\npm2home /home/node/.pm2\nRUNTIME yes\n__MCPROC_LOCK__\n${JSON.stringify({ pm2: '7.0.4', node: 'v24.21.0' })}\n`,
            stderr: '',
          };
        if (cmd.includes('jlist')) return { code: 0, stdout: '[]', stderr: '' };
        if (cmd.includes('bin/pm2'))
          return {
            code: 0,
            stdout: 'RUNTIME\nPATH_NONE\nv20.1.0\n',
            stderr: '',
          };
      }
      return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
    };
    const m = loadManifest(basic);
    const [stand] = await doctor(m, 'stand', sp, neverHere);
    const recs = stand.recommendations.join('\n');
    expect(recs).toMatch(/Run unpack for this host/);
    expect(recs).toMatch(/with_node/);
    expect(recs).toMatch(/no tar: unpack cannot/);
    const [prod] = await doctor(m, 'prod', sp, neverHere);
    expect(prod).toMatchObject({
      runtime_present: true,
      runtime_pm2: '7.0.4',
      runtime_node: 'v24.21.0',
      pm2: { source: 'runtime' },
    });
  });
});

const fleetDir = path.join(here, '..', 'fixtures', 'projects', 'fleet');
describe('doctor: environment and urls', () => {
  const boxSpawner =
    (
      urlLines: string,
      step: { code?: number; stdout?: string; stderr?: string } = {}
    ): Spawner =>
    async (argv) => {
      const cmd = argv[argv.length - 1];
      if (!argv.includes('box'))
        return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
      if (cmd.includes('__MCPROC_ENV__'))
        return {
          code: step.code ?? 0,
          stdout:
            step.stdout ??
            `__MCPROC_ENV__\ncontainer docker\nhostname ws-01\nself 172.17.0.2 127.0.0.1 ::1\n__MCPROC_URL__\n${urlLines}`,
          stderr: step.stderr ?? '',
        };
      if (cmd.includes('__MCPROC_DOCTOR__'))
        return {
          code: 0,
          stdout:
            '__MCPROC_DOCTOR__\nv22.3.0\ntool ps yes\ntool ss yes\ntool tar yes\npm2home \nRUNTIME no\n',
          stderr: '',
        };
      if (cmd.includes('jlist')) return { code: 0, stdout: '[]', stderr: '' };
      if (cmd.includes('bin/pm2'))
        return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
    };
  const failed = (recs: string[]) =>
    recs.filter((x) => x.startsWith('the environment and url checks failed'));
  it('reports the environment, where each url of the host answers, and recommends auto for an app with url_check: host whose url answers only from here', async () => {
    const base = loadManifest(fleetDir);
    const m: Manifest = {
      ...base,
      apps: {
        ...base.apps,
        web: { ...base.apps.web, url_check: 'host' },
        site: {
          ...base.apps.web,
          name: 'site',
          url: 'https://site.test/',
          url_check: 'auto',
          depends_on: [],
        },
      },
    };
    const asked: string[] = [];
    const [box] = await doctor(
      m,
      'box',
      boxSpawner(
        'http://localhost:3000/\t000\t7\t::1\nhttps://site.test/\t000\t7\t127.0.1.1\n'
      ),
      async (u) => {
        asked.push(u);
        return { answered: true, code: 200 };
      }
    );
    expect(box.environment).toEqual({
      container: 'docker',
      hostname: 'ws-01',
      self: ['172.17.0.2', '127.0.0.1', '::1'],
    });
    expect(box.urls).toEqual([
      {
        app: 'web',
        url: 'http://localhost:3000/',
        name: 'localhost',
        addr: '::1',
        itself: false,
        check: {
          status: 'ok',
          code: 200,
          from: 'here',
          reason: 'on box: refused',
        },
      },
      {
        app: 'site',
        url: 'https://site.test/',
        name: 'site.test',
        addr: '127.0.1.1',
        itself: true,
        check: {
          status: 'ok',
          code: 200,
          from: 'here',
          reason: 'on box site.test resolves to 127.0.1.1, the host itself',
        },
      },
    ]);
    expect(asked.sort()).toEqual([
      'http://localhost:3000/',
      'https://site.test/',
    ]);
    expect(box.recommendations.filter((x) => x.includes('url_check'))).toEqual([
      'apps.web.url_check is host, but its url answers only from this machine: set url_check: auto (or drop the line)',
    ]);
    const t = renderDoctor([box]);
    expect(t).toContain('  environment: container (docker), hostname ws-01');
    expect(t).toContain(
      '  url site: site.test → 127.0.1.1 on box, the host itself; answers from this machine (200)'
    );
    expect(t).toContain(
      '  url web: localhost → ::1 on box; answers from this machine (200); on box: refused\n'
    );
  });
  it('a url whose name resolves to the host itself and answers nowhere: the host\'s own failure, and "the host itself" once', async () => {
    const base = loadManifest(fleetDir);
    const m: Manifest = {
      ...base,
      apps: {
        ...base.apps,
        web: { ...base.apps.web, url: 'http://devbox:3000/' },
      },
    };
    const [box] = await doctor(
      m,
      'box',
      boxSpawner('http://devbox:3000/\t000\t7\t127.0.1.1\n'),
      async () => ({ answered: false, fail: 'refused' })
    );
    expect(box.urls).toMatchObject([
      {
        app: 'web',
        itself: true,
        check: {
          status: 'down',
          from: 'here',
          reason:
            'on box: refused (devbox resolves to 127.0.1.1, the host itself); here: refused',
        },
      },
    ]);
    const line = renderDoctor([box])
      .split('\n')
      .find((l) => l.startsWith('  url web:'))!;
    expect(line).toBe(
      '  url web: devbox → 127.0.1.1 on box, the host itself; answers nowhere (on box: refused; here: refused)'
    );
  });
  it('a url the host answers is not asked from here', async () => {
    const [box] = await doctor(
      loadManifest(fleetDir),
      'box',
      boxSpawner('http://localhost:3000/\t200\t0\t::1\n'),
      neverHere
    );
    expect(box.urls).toEqual([
      {
        app: 'web',
        url: 'http://localhost:3000/',
        name: 'localhost',
        addr: '::1',
        itself: false,
        check: { status: 'ok', code: 200, from: 'host', reason: null },
      },
    ]);
    expect(box.recommendations.join('\n')).not.toContain('url_check');
  });
  it('reads past the "Terminated" BusyBox timeout prints on stderr when it cuts a hung lookup: the exit status and the markers decide', async () => {
    const [box] = await doctor(
      loadManifest(fleetDir),
      'box',
      boxSpawner('http://localhost:3000/\t200\t0\t\n', {
        stderr: 'Terminated\nTerminated\n',
      }),
      neverHere
    );
    expect(failed(box.recommendations)).toEqual([]);
    expect(box.environment).toMatchObject({ container: 'docker' });
    expect(box.urls).toMatchObject([
      { app: 'web', addr: null, check: { status: 'ok', from: 'host' } },
    ]);
  });
  it('a url step that fails, exits non-zero or prints no markers is a recommendation, not a url result', async () => {
    const m = loadManifest(fleetDir);
    for (const step of [
      {
        code: 255,
        stdout: '',
        stderr: 'ssh: connect to host box: Connection reset',
      },
      { code: 127, stdout: '', stderr: 'bash: not found' },
      { code: 0, stdout: 'Welcome to box\n', stderr: '' },
    ]) {
      const [box] = await doctor(m, 'box', boxSpawner('', step), neverHere);
      expect(box).toMatchObject({
        reachable: true,
        node: 'v22.3.0',
        pm2: { source: 'path', version: '7.0.4' },
        daemon: 'answers',
        environment: null,
        urls: [],
      });
      expect(failed(box.recommendations)).toHaveLength(1);
    }
  });
  it('a host without pm2 still reports its environment and urls', async () => {
    const withPm2 = boxSpawner('http://localhost:3000/\t200\t0\t::1\n');
    const noPm2: Spawner = async (argv, o) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes('bin/pm2') && !cmd.includes('__MCPROC_DOCTOR__'))
        return { code: 0, stdout: 'PATH_NONE\nNODE_NONE\n', stderr: '' };
      return withPm2(argv, o);
    };
    const [box] = await doctor(loadManifest(fleetDir), 'box', noPm2, neverHere);
    expect(box).toMatchObject({
      reachable: true,
      pm2: null,
      daemon: 'unknown',
    });
    expect(box.recommendations.join('\n')).toMatch(/Run unpack for this host/);
    expect(failed(box.recommendations)).toEqual([]);
    expect(box.environment).toMatchObject({
      container: 'docker',
      hostname: 'ws-01',
    });
    expect(box.urls).toMatchObject([
      { app: 'web', check: { status: 'ok', code: 200, from: 'host' } },
    ]);
  });
  it('an app with url_check: here gets no recommendation, though its url answers only from here', async () => {
    const base = loadManifest(fleetDir);
    const m: Manifest = {
      ...base,
      apps: { ...base.apps, web: { ...base.apps.web, url_check: 'here' } },
    };
    const [box] = await doctor(
      m,
      'box',
      boxSpawner('http://localhost:3000/\t000\t7\t::1\n'),
      async () => ({ answered: true, code: 200 })
    );
    expect(box.urls).toMatchObject([
      {
        app: 'web',
        check: { status: 'ok', from: 'here', reason: 'on box: refused' },
      },
    ]);
    expect(box.recommendations.join('\n')).not.toContain('url_check');
  });
  it('a host with no curl or wget: the recommendation says the host cannot check the url, and the line says why', async () => {
    const base = loadManifest(fleetDir);
    const m: Manifest = {
      ...base,
      apps: { ...base.apps, web: { ...base.apps.web, url_check: 'host' } },
    };
    const [box] = await doctor(
      m,
      'box',
      boxSpawner('http://localhost:3000/\t-\t\t::1\n'),
      async () => ({ answered: true, code: 200 })
    );
    expect(box.urls).toMatchObject([
      {
        app: 'web',
        check: {
          status: 'ok',
          code: 200,
          from: 'here',
          reason: 'on box: no curl or wget',
        },
      },
    ]);
    expect(box.recommendations.filter((x) => x.includes('url_check'))).toEqual([
      'apps.web.url_check is host, but box cannot check its url (no curl or wget) and it answers from this machine: set url_check: auto (or drop the line)',
    ]);
    expect(renderDoctor([box])).toContain(
      '  url web: localhost → ::1 on box; answers from this machine (200); on box: no curl or wget'
    );
  });
});

import { describe, it, expect } from 'vitest';
import {
  startNote,
  waitNote,
  renderWait,
  renderLs,
  renderPorts,
  renderDoctor,
  renderUnpack,
  renderHosts,
  renderProject,
  renderIncidents,
  renderFlushed,
  renderMutation,
  fmtCpu,
  fmtUrl,
  fmtEnv,
  urlNote,
  fmtDeps,
  renderLogsSince,
  sinceNotes,
  renderAdopted,
} from '../../src/mcp/render.js';
import type { LsRow } from '../../src/core/list.js';
import type { PortCheck } from '../../src/core/ports.js';
import type { SinceAnswer } from '../../src/core/logsince.js';

const row = (status: string, checks: PortCheck[]): LsRow => ({
  app: 'web',
  host: 'local',
  kind: 'server',
  description: '',
  status,
  pm_id: 0,
  pid: 1,
  uptime_ms: 0,
  started: null,
  restarts: 0,
  exit_code: null,
  cpu: 0,
  memory: 0,
  procs: 1,
  runtime: null,
  pm2_memory: 0,
  pm2_cpu: 0,
  metrics_source: 'tree',
  url: null,
  url_status: 'unchecked',
  url_code: null,
  url_from: null,
  url_reason: null,
  ports: {
    actual: [],
    declared: checks.map((c) => c.port),
    checks,
    undeclared: [],
  },
});

describe('startNote', () => {
  it('points the reader at wait, not at polling ls, when an online app does not listen on its declared port yet', () => {
    expect(
      startNote([
        row('online', [{ port: 3000, status: 'declared-not-listening' }]),
      ])
    ).toContain('call wait until listening instead of polling ls');
  });
  it('stays silent when every port listens, when someone else holds the port, or when the app is not online', () => {
    expect(
      startNote([row('online', [{ port: 3000, status: 'listening' }])])
    ).toBe('');
    expect(
      startNote([
        row('online', [
          {
            port: 3000,
            status: 'declared-not-listening',
            held_by: { pid: 9, command: 'x' },
          },
        ]),
      ])
    ).toBe('');
    expect(
      startNote([
        row('errored', [{ port: 3000, status: 'declared-not-listening' }]),
      ])
    ).toBe('');
  });
});

describe('renderLs with tree metrics', () => {
  const base = row('online', [{ port: 3000, status: 'listening' }]);
  it('shows tree memory, cpu, runtime and a truncated description; cpu "-" when unknown', () => {
    const r = {
      ...base,
      memory: 2_200_000_000,
      cpu: 84.4,
      procs: 3,
      runtime: 'next-server (v16.2.9)',
      pm2_memory: 9_000_000,
      pm2_cpu: 0,
      metrics_source: 'tree' as const,
      description: 'a'.repeat(60),
    };
    const t = renderLs([r], 'local');
    expect(t).toMatch(
      /APP\s+KIND\s+STATUS\s+PID\s+UPTIME\s+RESTARTS\s+MEM\s+CPU\s+PORTS\s+URL\s+RUNTIME\s+DESCRIPTION/
    );
    expect(t).toContain('2.05G');
    expect(t).toContain('84.4%');
    expect(t).toContain('next-server (v16.2.9)');
    expect(t).toContain(`${'a'.repeat(39)}…`);
    expect(fmtCpu(null)).toBe('-');
    expect(renderLs([{ ...r, cpu: null }], 'local')).toMatch(/84\.4%|\s-\s/);
  });
  it('fmtUrl shows the url alone when unchecked and with its HTTP answer when checked', () => {
    const u = { ...base, url: 'http://localhost:3000/' };
    expect(fmtUrl(base)).toBe('-');
    expect(fmtUrl(u)).toBe('http://localhost:3000/');
    expect(fmtUrl({ ...u, url_status: 'ok', url_code: 200 })).toBe(
      'http://localhost:3000/ ✓ 200'
    );
    expect(fmtUrl({ ...u, url_status: 'error', url_code: 503 })).toBe(
      'http://localhost:3000/ ✗ 503'
    );
    expect(fmtUrl({ ...u, url_status: 'down' })).toBe(
      'http://localhost:3000/ ✗ down'
    );
    expect(
      renderLs([{ ...u, url_status: 'ok', url_code: 200 }], 'local')
    ).toContain('http://localhost:3000/ ✓ 200');
  });
  it('fmtUrl: (here) for an answer from this machine, the reason word for a url that is down', () => {
    const u = { ...base, url: 'http://localhost:3000/' };
    expect(
      fmtUrl({
        ...u,
        url_status: 'ok',
        url_code: 200,
        url_from: 'here',
        url_reason: 'on box: refused',
      })
    ).toBe('http://localhost:3000/ ✓ 200 (here)');
    expect(
      fmtUrl({
        ...u,
        url_status: 'error',
        url_code: 503,
        url_from: 'here',
        url_reason: 'on box: refused',
      })
    ).toBe('http://localhost:3000/ ✗ 503 (here)');
    expect(
      fmtUrl({
        ...u,
        url_status: 'error',
        url_code: null,
        url_from: 'host',
        url_reason: null,
      })
    ).toBe('http://localhost:3000/ ✗ error');
    for (const [reason, word] of [
      ['on box: refused', 'refused'],
      ['on box site.test does not resolve', 'not resolved'],
      ['on box: timeout', 'timeout'],
      ['on box: tls', 'tls'],
      ['on box: reset', 'reset'],
      ['on box: refused; here: no answer', 'no answer'],
      ['on box site.test resolves to 127.0.1.1, the host itself', 'itself'],
      [
        'on box site.test resolves to 127.0.1.1, the host itself; here: not resolved',
        'not resolved',
      ],
    ])
      expect(
        fmtUrl({
          ...u,
          url_status: 'down',
          url_from: 'host',
          url_reason: reason,
        })
      ).toBe(`http://localhost:3000/ ✗ down (${word})`);
    expect(
      renderLs(
        [
          {
            ...u,
            url_status: 'ok',
            url_code: 200,
            url_from: 'here',
            url_reason: 'on box: refused',
          },
        ],
        'local'
      )
    ).toContain('http://localhost:3000/ ✓ 200 (here)');
  });
  it('urlNote: describe says where the url answered and why, only when there is a reason', () => {
    const u = { ...base, url: 'http://localhost:3000/' };
    expect(
      urlNote({
        ...u,
        url_status: 'ok',
        url_code: 200,
        url_from: 'host',
        url_reason: null,
      })
    ).toBe('');
    expect(urlNote(base)).toBe('');
    expect(
      urlNote({
        ...u,
        url_status: 'ok',
        url_code: 200,
        url_from: 'here',
        url_reason: 'on box: refused',
      })
    ).toBe('url: answered from this machine (on box: refused)');
    expect(
      urlNote({
        ...u,
        url_status: 'down',
        url_from: 'here',
        url_reason: 'on box: refused; here: refused',
      })
    ).toBe('url: down (on box: refused; here: refused)');
    expect(
      urlNote({
        ...u,
        url_status: 'unchecked',
        url_from: null,
        url_reason: 'on box: no curl or wget',
      })
    ).toBe('url: unchecked (on box: no curl or wget)');
  });
  it('fmtPorts names the container holding a declared port', () => {
    const r = row('online', [
      {
        port: 55321,
        status: 'declared-not-listening',
        held_by: {
          pid: null,
          command: null,
          container: 'supabase_kong_zero-memory',
        },
      },
    ]);
    expect(renderLs([r], 'local')).toContain(
      ':55321 ✗ held by container supabase_kong_zero-memory'
    );
  });
  it('renderPorts shows the container of a docker-published port', () => {
    const t = renderPorts(
      {
        port: null,
        listeners: [
          {
            proto: 'tcp',
            addr: '0.0.0.0',
            port: 55321,
            pid: null,
            pids: [],
            command: null,
            container: 'supabase_kong_zero-memory',
            app: null,
          },
        ],
      },
      'local'
    );
    expect(t).toMatch(/CONTAINER/);
    expect(t).toContain('supabase_kong_zero-memory');
  });
});

describe('renderLs RESTARTS with reloads (ls --reloads)', () => {
  const base = row('online', []);
  const line = (r: Partial<LsRow>) =>
    renderLs([{ ...base, ...r }], 'local').split('\n')[2];
  const counted = (count: number, partial: boolean): LsRow['reloads'] => ({
    count,
    last: count ? '2026-10-12T11:00:30' : null,
    partial,
  });
  it("adds the reloads since the start to pm2's restarts: (+N), (+≥N) when the logs read did not reach back to the start", () => {
    expect(line({ reloads: counted(3, false) })).toMatch(/\s0 \(\+3\)\s/);
    expect(line({ reloads: counted(3, true) })).toMatch(/\s0 \(\+≥3\)\s/);
    expect(line({ restarts: 2, reloads: counted(7, false) })).toMatch(
      /\s2 \(\+7\)\s/
    );
  });
  it('shows nothing more when no reload was counted, partial or not, and nothing changes without the field', () => {
    const plain = renderLs([base], 'local');
    expect(plain).toMatch(/UPTIME\s+RESTARTS\s+MEM/);
    expect(plain.split('\n')[2]).toMatch(/\s0s\s+0\s+-\s/);
    expect(renderLs([{ ...base, reloads: counted(0, true) }], 'local')).toBe(
      plain
    );
    expect(renderLs([{ ...base, reloads: counted(0, false) }], 'local')).toBe(
      plain
    );
  });
  it('a host whose logs could not be read for the count gets one line after the table', () => {
    const t = renderLs([base], 'local', [
      {
        host: 'box',
        apps: ['web'],
        message: 'reloads not counted: TRANSPORT_FAILED: ssh to box failed',
      },
    ]);
    expect(t.split('\n').at(-1)).toBe(
      'box: reloads not counted: TRANSPORT_FAILED: ssh to box failed'
    );
  });
});

describe('several hosts', () => {
  const local = row('online', []);
  const box = {
    ...row('unreachable', []),
    app: 'dev-all',
    host: 'box',
    pid: null,
    error: 'TRANSPORT_FAILED: ssh box: Connection refused',
  };
  it('renderLs adds a HOST column and names every host only when the rows span more than one, plus one line per unreachable host', () => {
    const t = renderLs([local, box], 'local');
    expect(t.split('\n')[0]).toBe('hosts: local, box');
    expect(t).toMatch(/APP\s+HOST\s+KIND\s+STATUS/);
    expect(t).toMatch(/dev-all\s+box\s+server\s+unreachable/);
    expect(t.split('\n').at(-1)).toBe(
      'box: TRANSPORT_FAILED: ssh box: Connection refused'
    );
    expect(renderLs([local], 'local')).not.toContain('HOST');
    expect(renderLs([local], 'local').split('\n')[0]).toBe('host: local');
  });
  it('renderHosts shows the apps bound to each host; renderProject marks a bound app with its host', () => {
    expect(
      renderHosts([
        {
          name: 'box',
          transport: 'ssh box',
          readonly: false,
          cwd: '/w',
          runtime: '/w/.mcproc/runtime',
          pm2: null,
          pm2_home: null,
          apps: ['web', 'api'],
        },
      ])
    ).toMatch(/box\s+ssh box\s+\/w\s+no\s+-\s+web, api/);
    const d = {
      project: 'p',
      root: '/r',
      apps: [
        {
          name: 'web',
          kind: 'server',
          description: 'd',
          ports: [],
          url: null,
          depends_on: [],
          host: 'box',
        },
        {
          name: 'tool',
          kind: 'worker',
          description: 'd',
          ports: [],
          url: null,
          depends_on: [],
          host: null,
        },
      ],
      profiles: {},
      hosts: [],
      readme: null,
    };
    expect(renderProject(d)).toContain('  web [server] on box: d');
    expect(renderProject(d)).toContain('  tool [worker]: d');
  });
});

describe('renderDoctor', () => {
  it('prints the monit command when a runtime is unpacked on the host', () => {
    const t = renderDoctor([
      {
        host: 'stand',
        transport: 'ssh stand',
        reachable: true,
        error: null,
        node: 'v22.1.0',
        pm2: { source: 'runtime', bin: 'x', version: null, reason: 'r' },
        tools: { ps: true, ss: true, tar: true },
        pm2_home: '/h',
        runtime_dir: '/opt/rt',
        runtime_present: true,
        runtime_pm2: '7.0.4',
        runtime_node: null,
        daemon: 'answers',
        processes: 0,
        in_namespace: 0,
        recommendations: [],
        environment: null,
        urls: [],
      },
    ]);
    expect(t).toContain('/opt/rt (pm2 7.0.4)');
    expect(t).toContain("PM2_HOME='/h' '/opt/rt/bin/pm2' monit");
  });
  it('prints the environment line and where each url answers', () => {
    const rep = {
      host: 'box',
      transport: 'ssh box',
      reachable: true,
      error: null,
      node: 'v22.1.0',
      pm2: null,
      tools: { ps: true, ss: true, tar: true },
      pm2_home: null,
      runtime_dir: '/opt/rt',
      runtime_present: false,
      runtime_pm2: null,
      runtime_node: null,
      daemon: 'answers' as const,
      processes: 0,
      in_namespace: 0,
      recommendations: [],
      environment: {
        container: 'docker' as const,
        hostname: 'ws-01',
        self: ['172.17.0.2'],
      },
      urls: [
        {
          app: 'web',
          url: 'http://localhost:3000/',
          name: 'localhost',
          addr: '::1',
          itself: false,
          check: {
            status: 'ok' as const,
            code: 200,
            from: 'here' as const,
            reason: 'on box: refused',
          },
        },
        {
          app: 'api',
          url: 'http://localhost:3100/',
          name: 'localhost',
          addr: '::1',
          itself: false,
          check: {
            status: 'ok' as const,
            code: 200,
            from: 'host' as const,
            reason: null,
          },
        },
        {
          app: 'gone',
          url: 'http://gone.test/',
          name: 'gone.test',
          addr: null,
          itself: false,
          check: {
            status: 'down' as const,
            code: null,
            from: 'here' as const,
            reason: 'on box gone.test does not resolve; here: not resolved',
          },
        },
        {
          app: 'bare',
          url: 'http://localhost:3200/',
          name: 'localhost',
          addr: '::1',
          itself: false,
          check: {
            status: 'unchecked' as const,
            code: null,
            from: null,
            reason: 'on box: no curl or wget',
          },
        },
      ],
    };
    const t = renderDoctor([rep]);
    expect(t).toContain('  environment: container (docker), hostname ws-01');
    expect(t).toContain(
      '  url web: localhost → ::1 on box; answers from this machine (200)'
    );
    expect(t).toContain(
      '  url web: localhost → ::1 on box; answers from this machine (200); on box: refused\n'
    );
    expect(t).toContain(
      '  url api: localhost → ::1 on box; answers on box (200)\n'
    );
    expect(t).toContain(
      '  url gone: gone.test → no address on box; answers nowhere (on box gone.test does not resolve; here: not resolved)'
    );
    expect(t).toContain(
      '  url bare: localhost → ::1 on box; not checked (on box: no curl or wget)'
    );
    expect(fmtEnv({ container: 'none', hostname: null, self: [] })).toBe(
      'no container'
    );
    expect(fmtEnv({ container: 'none', hostname: 'dev', self: [] })).toBe(
      'no container, hostname dev'
    );
  });
  it('a url that resolves to the host itself and answers from this machine says "the host itself" once', () => {
    const site = (app: string, reason: string) => ({
      app,
      url: 'http://site.test/',
      name: 'site.test',
      addr: '127.0.1.1',
      itself: true,
      check: {
        status: 'ok' as const,
        code: 200,
        from: 'here' as const,
        reason,
      },
    });
    const t = renderDoctor([
      {
        host: 'box',
        transport: 'ssh box',
        reachable: true,
        error: null,
        node: 'v22.1.0',
        pm2: null,
        tools: { ps: true, ss: true, tar: true },
        pm2_home: null,
        runtime_dir: '/opt/rt',
        runtime_present: false,
        runtime_pm2: null,
        runtime_node: null,
        daemon: 'answers',
        processes: 0,
        in_namespace: 0,
        recommendations: [],
        environment: null,
        urls: [
          site(
            'web',
            'on box site.test resolves to 127.0.1.1, the host itself'
          ),
          site('bare', 'on box: no curl or wget'),
        ],
      },
    ]);
    const lines = t.split('\n');
    expect(lines).toContain(
      '  url web: site.test → 127.0.1.1 on box, the host itself; answers from this machine (200)'
    );
    // another reason the host had no answer is still said
    expect(lines).toContain(
      '  url bare: site.test → 127.0.1.1 on box, the host itself; answers from this machine (200); on box: no curl or wget'
    );
  });
});

describe('renderUnpack', () => {
  it('tells what was unpacked, the line to add, the monit command and the update hint', () => {
    const t = renderUnpack({
      host: 'stand',
      runtime_dir: '/opt/rt',
      noop: false,
      pm2: { version: '7.0.4', written: true },
      node: { version: 'v24.21.0', platform: 'linux-x64-musl', written: true },
      manifest_copy: 'kept-hand-written',
      runtime_line: 'hosts.stand.runtime: /opt/rt',
      monit: "'/opt/rt/bin/pm2' monit",
      update_hint: 'a pm2 daemon is already running there; …',
    });
    expect(t).toContain('pm2 7.0.4 unpacked');
    expect(t).toContain('node v24.21.0 (linux-x64-musl) unpacked');
    expect(t).toContain('hosts.stand.runtime: /opt/rt');
    expect(t).toContain("'/opt/rt/bin/pm2' monit");
    expect(t).toContain('kept-hand-written');
    expect(t).toContain('daemon is already running');
  });
});

describe('renderIncidents', () => {
  const inc = {
    app: 'web',
    host: 'local',
    kind: 'error' as const,
    stream: 'out' as const,
    time: '2026-10-12T11:24:55',
    first_time: '2026-10-12T11:20:01',
    count: 3,
    line: 'TypeError: x',
    before: ['b1'],
    after: ['    at f (/a.js:1:1)'],
    fingerprint: 'f',
  };
  const base = {
    skipped: [],
    errors: [],
    more: 0,
    apps: 3,
    hosts: 2,
    latest: '2026-10-12T11:24:55',
    taken: true,
    cleared_at: null,
  };
  it('one header per incident, the marker line between its context; then how to go on', () => {
    const t = renderIncidents({ ...base, incidents: [inc] });
    expect(t.split('\n').slice(0, 4)).toEqual([
      'web@local 2026-10-12T11:24:55 error ×3 (first 2026-10-12T11:20:01, out)',
      '  │ b1',
      '  ▶ TypeError: x',
      '  │     at f (/a.js:1:1)',
    ]);
    expect(t).toContain(
      'next: call incidents again later (these are taken now); full logs with logs app=web'
    );
    expect(
      renderIncidents({ ...base, taken: false, incidents: [inc] })
    ).toContain('(peeked: nothing taken)');
  });
  it('nothing new is one short line, with the last clear; skipped bytes, unreachable hosts and more are one line each', () => {
    expect(renderIncidents({ ...base, incidents: [] })).toBe(
      'no new incidents since 2026-10-12T11:24:55 (3 apps on 2 hosts)'
    );
    expect(renderIncidents({ ...base, incidents: [], apps: 1, hosts: 1 })).toBe(
      'no new incidents since 2026-10-12T11:24:55 (1 app on 1 host)'
    );
    expect(
      renderIncidents({
        ...base,
        incidents: [],
        cleared_at: '2026-10-12T15:04:05',
      })
    ).toBe(
      'no new incidents since 2026-10-12T11:24:55 (3 apps on 2 hosts; logs cleared 2026-10-12T15:04:05)'
    );
    const t = renderIncidents({
      ...base,
      incidents: [inc],
      more: 4,
      skipped: [
        { app: 'web', host: 'local', stream: 'out', bytes: 3 * 1048576 },
      ],
      errors: [
        { host: 'box', apps: ['api'], message: 'TRANSPORT_FAILED: down' },
      ],
    });
    expect(t).toContain(
      '+4 older incidents not shown, taken with these (read logs for them)'
    );
    expect(t).toContain('skipped 3.0M of web out on local');
    expect(t).toContain('box: TRANSPORT_FAILED: down');
    expect(
      renderIncidents({ ...base, taken: false, incidents: [inc], more: 4 })
    ).toContain('+4 more incidents (raise max)');
  });
  it('colors the marker line on request', () => {
    expect(
      renderIncidents({ ...base, incidents: [inc] }, { color: true })
    ).toContain('\x1b[31m');
  });
  it("a reloaded incident is one line: how many reloads, the first one when several, the last one's line; not colored as an error", () => {
    const reloaded = {
      ...inc,
      kind: 'reloaded' as const,
      time: '2026-10-12T11:24:50.120',
      first_time: '2026-10-12T11:20:01.000',
      count: 2,
      line: '2026-10-12T11:24:50.120: [vite] hmr update /src/a.ts',
      before: [],
      after: [],
      fingerprint: 'reloaded',
    };
    const t = renderIncidents(
      { ...base, incidents: [inc, reloaded] },
      { color: true }
    );
    expect(t.split('\n')).toContain(
      'web@local 2026-10-12T11:24:50.120 reloaded ×2 (first 2026-10-12T11:20:01.000): 2026-10-12T11:24:50.120: [vite] hmr update /src/a.ts'
    );
    expect(
      renderIncidents({
        ...base,
        incidents: [{ ...reloaded, count: 1, first_time: reloaded.time }],
      }).split('\n')[0]
    ).toBe(
      'web@local 2026-10-12T11:24:50.120 reloaded: 2026-10-12T11:24:50.120: [vite] hmr update /src/a.ts'
    );
  });
});

describe('renderFlushed', () => {
  it('one line per app, the host when several answered, the files that could not be truncated named', () => {
    const r = [
      { app: 'web', host: 'local', out_bytes: 100, err_bytes: 20 },
      {
        app: 'api',
        host: 'box',
        out_bytes: 5,
        err_bytes: 0,
        failed: ['/l/api-err'],
      },
    ];
    expect(renderFlushed(r, true)).toBe(
      'web (local): freed 120 bytes\napi (box): freed 5 bytes; could not truncate /l/api-err'
    );
    expect(renderFlushed([r[0]], false)).toBe('web: freed 120 bytes');
    expect(renderFlushed([], false)).toBe(
      'nothing to flush (no pm2 processes for this project there)'
    );
  });
});

describe('renderMutation', () => {
  it('a fleet mutation where a host failed says so first, and is marked failed; a clean one is not', () => {
    const ok = { ...row('online', []), app: 'watch', host: 'local' };
    const bad = {
      ...row('failed', []),
      app: 'web',
      host: 'box',
      error: 'TRANSPORT_FAILED: ssh box: down',
    };
    const r = renderMutation([ok, bad], 'local', 'start');
    expect(r.failed).toBe(true);
    expect(r.text.split('\n')[0]).toBe(
      'start partly failed: web (box): TRANSPORT_FAILED: ssh box: down'
    );
    expect(renderMutation([ok], 'local', 'stop')).toMatchObject({
      failed: false,
      text: expect.not.stringContaining('failed'),
    });
  });
  it('waitNote lists successful waits; renderMutation appends it', () => {
    const waits = [
      {
        app: 'api',
        dep: 'libs',
        condition: 'completed' as const,
        ms: 4210,
        ok: true,
      },
      {
        app: 'web',
        dep: 'api',
        condition: 'ready' as const,
        ms: 1100,
        ok: true,
      },
      {
        app: 'x',
        dep: 'y',
        condition: 'ready' as const,
        ms: 9,
        ok: false,
        reason: 'timeout',
      },
    ];
    expect(waitNote(waits)).toBe(
      'waited 4.2 s for libs (completed), 1.1 s for api (ready)'
    );
    expect(waitNote([])).toBe('');
    const r = renderMutation([row('online', [])], 'local', 'start', waits);
    expect(r.text).toContain('waited 4.2 s for libs (completed)');
  });
  it('renderWait: one line per outcome', () => {
    const base = { until: 'listening', waited_ms: 1300, status: 'online' };
    expect(renderWait('web', { ...base, ok: true, observed: ':3000 ✓' })).toBe(
      'web: listening after 1.3 s (:3000 ✓)'
    );
    expect(
      renderWait('libs', {
        until: 'exited',
        waited_ms: 12_400,
        ok: true,
        status: 'done',
        exit_code: 0,
      })
    ).toBe('libs: done after 12.4 s (exit 0)');
    expect(
      renderWait('api', {
        until: 'log:listening',
        waited_ms: 800,
        ok: true,
        status: 'online',
        matched_line: '2026-10-13T20:00:00.123: listening on 3010',
      })
    ).toBe(
      'api: log matched after 0.8 s: 2026-10-13T20:00:00.123: listening on 3010'
    );
    expect(
      renderWait('libs', {
        until: 'idle:5',
        waited_ms: 20_100,
        ok: true,
        status: 'online',
      })
    ).toBe('libs: idle:5 after 20.1 s');
    expect(
      renderWait('web', {
        ...base,
        ok: false,
        reason: 'timeout',
        waited_ms: 60_000,
        observed: 'status online, :3000 ✗ nothing listens',
      })
    ).toBe(
      'web: listening not reached after 60.0 s (status online, :3000 ✗ nothing listens)'
    );
    expect(
      renderWait('web', {
        ...base,
        ok: false,
        reason: 'exited',
        waited_ms: 3100,
        status: 'failed (exit 2)',
        exit_code: 2,
      })
    ).toBe(
      'web: exited (failed (exit 2)) after 3.1 s while waiting for listening'
    );
    expect(
      renderWait('web', {
        ...base,
        ok: false,
        reason: 'crashed',
        status: 'errored',
      })
    ).toBe('web: crashed (errored) after 1.3 s while waiting for listening');
    expect(renderWait('web', { ...base, ok: false, reason: 'aborted' })).toBe(
      'web: aborted after 1.3 s while waiting for listening'
    );
  });
  it('renderWait: a reload names when it began, its line count and its first line (without the stamp shown twice)', () => {
    const ok = {
      until: 'reloaded',
      waited_ms: 3000,
      ok: true,
      status: 'online',
    };
    expect(
      renderWait('web', {
        ...ok,
        reloaded: {
          time: '2026-10-14T12:00:01.000',
          lines: 3,
          line: '2026-10-14T12:00:01: [vite] (client) page reload /src/a.ts',
        },
      })
    ).toBe(
      'web: reloaded after 3.0 s (3 lines from 2026-10-14T12:00:01.000): [vite] (client) page reload /src/a.ts'
    );
    expect(
      renderWait('web', {
        ...ok,
        reloaded: {
          time: null,
          lines: 1,
          line: '[tsx] change in x Restarting...',
        },
      })
    ).toBe(
      'web: reloaded after 3.0 s (1 line): [tsx] change in x Restarting...'
    );
    expect(
      renderWait('web', {
        ...ok,
        ok: false,
        reason: 'timeout',
        observed: 'no new output',
      })
    ).toBe('web: reloaded not reached after 3.0 s (no new output)');
  });
  it('renderWait: an exited wait names the exit code once, and not at all when there is none', () => {
    const exited = { until: 'exited', waited_ms: 3100, ok: true };
    expect(
      renderWait('libs', {
        ...exited,
        status: 'failed (exit 2)',
        exit_code: 2,
      })
    ).toBe('libs: failed (exit 2) after 3.1 s');
    expect(
      renderWait('libs', { ...exited, status: 'stopped', exit_code: null })
    ).toBe('libs: stopped after 3.1 s');
    expect(renderWait('libs', { ...exited, status: 'stopped' })).toBe(
      'libs: stopped after 3.1 s'
    );
    expect(
      renderWait('libs', {
        ...exited,
        waited_ms: 500,
        status: 'stopped',
        exit_code: 143,
      })
    ).toBe('libs: stopped after 0.5 s (exit 143)'); // a stop by signal: the code is news, the status does not carry it
  });
  it('a skipped dependent is a failed row', () => {
    const r = renderMutation(
      [{ ...row('skipped', []), error: 'libs failed (exit 2)' }],
      'local',
      'start'
    );
    expect(r.failed).toBe(true);
    expect(r.text).toContain(
      'start partly failed: web (local): libs failed (exit 2)'
    );
  });
});

describe('fmtDeps', () => {
  it('names a started dependency bare and any other with its condition', () => {
    expect(
      fmtDeps([
        { app: 'libs', condition: 'completed' },
        { app: 'api', condition: 'ready' },
        { app: 'logger', condition: 'started' },
      ])
    ).toBe('libs (completed), api (ready), logger');
    expect(fmtDeps([])).toBe('');
  });
});

describe('ls shows the status word', () => {
  it('a finished task reads done, a failed one reads failed (exit N)', () => {
    expect(renderLs([{ ...row('done', []), kind: 'task' }], 'local')).toContain(
      'done'
    );
    expect(renderLs([{ ...row('failed (exit 2)', []) }], 'local')).toContain(
      'failed (exit 2)'
    );
  });
});

describe('renderLogsSince', () => {
  const a: SinceAnswer = {
    mode: 'relative',
    since: { local: '2026-10-14T09:28:30.000' },
    apps: 2,
    hosts: 1,
    truncated: 3,
    lines: [
      {
        app: 'api',
        host: 'local',
        stream: 'out',
        time: '2026-10-14T09:28:30.000',
        text: '2026-10-14T09:28:30.000: listening 3010',
      },
      {
        app: 'web',
        host: 'local',
        stream: 'err',
        time: '2026-10-14T09:28:31.000',
        text: '2026-10-14T09:28:31.000: warn',
      },
    ],
    skipped: [{ app: 'api', host: 'local', stream: 'out', bytes: 2048 }],
    not_started: ['logger'],
    unzoned: [],
    errors: [
      {
        host: 'box',
        apps: ['tool'],
        message: 'TRANSPORT_FAILED: ssh box: Connection refused',
      },
    ],
  };
  it('header, compose lines, notes', () => {
    const t = renderLogsSince(a);
    expect(t.split('\n')[0]).toBe(
      'since 2026-10-14T09:28:30.000 (local time) · 2 apps on 1 host · 2 lines'
    );
    expect(t).toContain('\napi | 2026-10-14T09:28:30.000: listening 3010\n');
    expect(t).toContain('\nweb ! 2026-10-14T09:28:31.000: warn\n');
    expect(sinceNotes(a)).toEqual([
      'truncated 3 older lines',
      'skipped 2K of api out on local (more than the 1 MB read before the window)',
      'not started: logger',
      'box not read (tool): TRANSPORT_FAILED: ssh box: Connection refused',
    ]);
    expect(t.endsWith(sinceNotes(a).join('\n'))).toBe(true);
  });
  it('a host that answered without a readable clock is "not read" too, not "unreachable"', () => {
    const notes = sinceNotes({
      ...a,
      errors: [
        {
          host: 'box',
          apps: ['web'],
          message:
            'TRANSPORT_FAILED: the host did not report a readable clock and zone',
        },
      ],
    });
    expect(notes.at(-1)).toBe(
      'box not read (web): TRANSPORT_FAILED: the host did not report a readable clock and zone'
    );
  });
  it('hosts whose zone could not be read are one note: their lines may be out of place among the other hosts', () => {
    expect(sinceNotes({ ...a, unzoned: ['box'] })).toContain(
      "zone unknown on box: its lines are placed by their stamps as if in UTC, so they may be out of place among the other hosts' lines"
    );
    expect(sinceNotes({ ...a, unzoned: ['box', 'ro'] })).toContain(
      "zone unknown on box, ro: their lines are placed by their stamps as if in UTC, so they may be out of place among the other hosts' lines"
    );
    expect(sinceNotes(a).some((n) => n.startsWith('zone unknown'))).toBe(false);
  });
  it('a last read names the bytes it jumped over since the previous call', () => {
    expect(
      sinceNotes({ ...a, mode: 'last', since: { local: null } })
    ).toContain(
      'skipped 2K of api out on local (more than 1 MB new since the previous call; the most recent 1 MB was read)'
    );
  });
  it('several hosts list each cutoff; last and tail have their own phrase', () => {
    const two = renderLogsSince({
      ...a,
      since: {
        local: '2026-10-14T09:28:30.000',
        box: '2026-10-14T07:28:30.000',
      },
      hosts: 2,
    });
    expect(two.split('\n')[0]).toBe(
      "since local 2026-10-14T09:28:30.000, box 2026-10-14T07:28:30.000 (each host's time) · 2 apps on 2 hosts · 2 lines"
    );
    expect(
      renderLogsSince({ ...a, mode: 'last', since: { local: null } }).split(
        '\n'
      )[0]
    ).toBe('since the previous logs call · 2 apps on 1 host · 2 lines');
    expect(
      renderLogsSince({ ...a, mode: 'tail', since: { local: null } }).split(
        '\n'
      )[0]
    ).toBe('latest lines · 2 apps on 1 host · 2 lines');
  });
  it('nothing in the window is one line plus the notes', () => {
    const empty = {
      ...a,
      lines: [],
      truncated: 0,
      skipped: [],
      not_started: [],
      errors: [],
    };
    expect(renderLogsSince(empty)).toBe(
      'no log lines since 2026-10-14T09:28:30.000 (local time) (2 apps on 1 host)'
    );
    expect(
      renderLogsSince({ ...empty, mode: 'last', since: { local: null } })
    ).toBe('no new log lines since the previous logs call (2 apps on 1 host)');
    expect(
      renderLogsSince({ ...empty, mode: 'tail', since: { local: null } })
    ).toBe('no log lines (2 apps on 1 host)');
    expect(renderLogsSince({ ...empty, not_started: ['api', 'web'] })).toBe(
      'no log lines since 2026-10-14T09:28:30.000 (local time) (2 apps on 1 host)\nnot started: api, web'
    );
  });
});

describe('renderAdopted', () => {
  const r = {
    path: '/p/.mcproc/mcproc.yaml',
    written: true,
    adopted: [
      { app: 'web', host: 'local', ports: [3001] },
      { app: 'remote', host: 'box', ports: [9000, 9001] },
    ],
    skipped: [
      { app: 'api', host: 'local', ports: [45000], reason: 'ephemeral' },
      { app: 'tool', host: 'local', ports: [3000], reason: 'declared by web' },
      { app: 'far', host: 'box', ports: [40000], reason: 'ephemeral' },
    ],
    errors: [
      {
        host: 'stand',
        apps: ['svc'],
        message: 'TRANSPORT_FAILED: ssh stand: Connection refused',
      },
    ],
    diff: [' apps:', '-    port: 3000', '+    ports: [3000, 3001]', '   api:'],
  };
  it('adopted and skipped lines, host errors, then the diff', () => {
    const { text, failed } = renderAdopted(r);
    expect(text.split('\n')).toEqual([
      'web: adopted 3001',
      'remote: adopted 9000, 9001 (box)',
      'api: skipped 45000 (ephemeral)',
      'tool: skipped 3000 (declared by web)',
      'far: skipped 40000 (ephemeral) (box)',
      'stand not read (svc): TRANSPORT_FAILED: ssh stand: Connection refused',
      'written /p/.mcproc/mcproc.yaml:',
      ' apps:',
      '-    port: 3000',
      '+    ports: [3000, 3001]',
      '   api:',
    ]);
    expect(failed).toBe(true);
  });
  it('nothing written: the skipped lines and host errors alone; the nothing-to-adopt line only when there is nothing at all', () => {
    const none = { ...r, written: false, adopted: [], diff: [] };
    expect(renderAdopted({ ...none, errors: [] })).toEqual({
      text: [
        'api: skipped 45000 (ephemeral)',
        'tool: skipped 3000 (declared by web)',
        'far: skipped 40000 (ephemeral) (box)',
      ].join('\n'),
      failed: false,
    });
    expect(renderAdopted({ ...none, skipped: [] })).toEqual({
      text: 'stand not read (svc): TRANSPORT_FAILED: ssh stand: Connection refused',
      failed: true,
    });
    expect(renderAdopted({ ...none, skipped: [], errors: [] })).toEqual({
      text: 'nothing to adopt: every port the running apps hold is declared',
      failed: false,
    });
  });
});

import { describe, it, expect } from 'vitest';
import { startNote, renderLs, renderPorts, renderDoctor, renderUnpack, fmtCpu, fmtUrl } from '../../src/mcp/render.js';
import type { LsRow } from '../../src/core/list.js';
import type { PortCheck } from '../../src/core/ports.js';

const row = (status: string, checks: PortCheck[]): LsRow => ({
  app: 'web', kind: 'server', description: '', status, pm_id: 0, pid: 1, uptime_ms: 0, restarts: 0, cpu: 0, memory: 0,
  procs: 1, runtime: null, pm2_memory: 0, pm2_cpu: 0, metrics_source: 'tree', url: null, url_status: 'unchecked', url_code: null,
  ports: { actual: [], declared: checks.map((c) => c.port), checks, undeclared: [] },
});

describe('startNote', () => {
  it('tells the reader to look again when an online app does not listen on its declared port yet', () => {
    expect(startNote([row('online', [{ port: 3000, status: 'declared-not-listening' }])])).toContain('call ls again');
  });
  it('stays silent when every port listens, when someone else holds the port, or when the app is not online', () => {
    expect(startNote([row('online', [{ port: 3000, status: 'listening' }])])).toBe('');
    expect(startNote([row('online', [{ port: 3000, status: 'declared-not-listening', held_by: { pid: 9, command: 'x' } }])])).toBe('');
    expect(startNote([row('errored', [{ port: 3000, status: 'declared-not-listening' }])])).toBe('');
  });
});

describe('renderLs with tree metrics', () => {
  const base = row('online', [{ port: 3000, status: 'listening' }]);
  it('shows tree memory, cpu, runtime and a truncated description; cpu "-" when unknown', () => {
    const r = { ...base, memory: 2_200_000_000, cpu: 84.4, procs: 3, runtime: 'next-server (v16.2.9)', pm2_memory: 9_000_000, pm2_cpu: 0, metrics_source: 'tree' as const, description: 'a'.repeat(60) };
    const t = renderLs([r], 'local');
    expect(t).toMatch(/APP\s+KIND\s+STATUS\s+PID\s+UPTIME\s+RESTARTS\s+MEM\s+CPU\s+PORTS\s+URL\s+RUNTIME\s+DESCRIPTION/);
    expect(t).toContain('2.05G');
    expect(t).toContain('84.4%');
    expect(t).toContain('next-server (v16.2.9)');
    expect(t).toContain('a'.repeat(39) + '…');
    expect(fmtCpu(null)).toBe('-');
    expect(renderLs([{ ...r, cpu: null }], 'local')).toMatch(/84\.4%|\s-\s/);
  });
  it('fmtUrl shows the url alone when unchecked and with its HTTP answer when checked', () => {
    const u = { ...base, url: 'http://localhost:3000/' };
    expect(fmtUrl(base)).toBe('-');
    expect(fmtUrl(u)).toBe('http://localhost:3000/');
    expect(fmtUrl({ ...u, url_status: 'ok', url_code: 200 })).toBe('http://localhost:3000/ ✓ 200');
    expect(fmtUrl({ ...u, url_status: 'error', url_code: 503 })).toBe('http://localhost:3000/ ✗ 503');
    expect(fmtUrl({ ...u, url_status: 'down' })).toBe('http://localhost:3000/ ✗ down');
    expect(renderLs([{ ...u, url_status: 'ok', url_code: 200 }], 'local')).toContain('http://localhost:3000/ ✓ 200');
  });
  it('fmtPorts names the container holding a declared port', () => {
    const r = row('online', [{ port: 55321, status: 'declared-not-listening', held_by: { pid: null, command: null, container: 'supabase_kong_zero-memory' } }]);
    expect(renderLs([r], 'local')).toContain(':55321 ✗ held by container supabase_kong_zero-memory');
  });
  it('renderPorts shows the container of a docker-published port', () => {
    const t = renderPorts({ port: null, listeners: [{ proto: 'tcp', addr: '0.0.0.0', port: 55321, pid: null, pids: [], command: null, container: 'supabase_kong_zero-memory', app: null }] }, 'local');
    expect(t).toMatch(/CONTAINER/);
    expect(t).toContain('supabase_kong_zero-memory');
  });
});

describe('renderDoctor', () => {
  it('prints the monit command when a runtime is unpacked on the host', () => {
    const t = renderDoctor([{ host: 'stand', transport: 'ssh stand', reachable: true, error: null, node: 'v22.1.0', pm2: { source: 'runtime', bin: 'x', version: null, reason: 'r' }, tools: { ps: true, ss: true, tar: true }, pm2_home: '/h', runtime_dir: '/opt/rt', runtime_present: true, runtime_pm2: '7.0.4', runtime_node: null, daemon: 'answers', processes: 0, in_namespace: 0, recommendations: [] }]);
    expect(t).toContain('/opt/rt (pm2 7.0.4)');
    expect(t).toContain("PM2_HOME='/h' '/opt/rt/bin/pm2' monit");
  });
});

describe('renderUnpack', () => {
  it('tells what was unpacked, the line to add, the monit command and the update hint', () => {
    const t = renderUnpack({
      host: 'stand', runtime_dir: '/opt/rt', noop: false, pm2: { version: '7.0.4', written: true },
      node: { version: 'v24.21.0', platform: 'linux-x64-musl', written: true }, manifest_copy: 'kept-hand-written',
      runtime_line: 'hosts.stand.runtime: /opt/rt', monit: "'/opt/rt/bin/pm2' monit", update_hint: 'a pm2 daemon is already running there; …',
    });
    expect(t).toContain('pm2 7.0.4 unpacked');
    expect(t).toContain('node v24.21.0 (linux-x64-musl) unpacked');
    expect(t).toContain('hosts.stand.runtime: /opt/rt');
    expect(t).toContain("'/opt/rt/bin/pm2' monit");
    expect(t).toContain('kept-hand-written');
    expect(t).toContain('daemon is already running');
  });
});

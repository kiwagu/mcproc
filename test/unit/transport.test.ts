import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildArgv, withEnv, describeHost, createTransport, ensureOk } from '../../src/transport/index.js';
import type { Host } from '../../src/core/manifest.js';
import type { Spawner } from '../../src/transport/types.js';
import { McprocError } from '../../src/core/errors.js';

const local: Host = { name: 'local', local: true, ssh_args: [], cwd: '/p', readonly: false, shell: { bin: '/bin/bash', flags: ['-lc'] }, env: {} };
const ssh: Host = { ...local, name: 'stand', local: false, ssh: 'stand', ssh_args: ['-J', 'bastion'], cwd: '/srv/p' };
const docker: Host = { ...local, name: 'box', local: false, docker: { container: 'app-1', user: 'node' } };
const both: Host = { ...ssh, docker: { container: 'app-1', user: 'node' } };

describe('buildArgv', () => {
  it('local: shell + flags + command', () => {
    expect(buildArgv(local, 'pm2 jlist')).toEqual(['/bin/bash', '-lc', 'pm2 jlist']);
  });
  it('docker: docker exec -u user -i container shell flags cmd', () => {
    expect(buildArgv(docker, 'pm2 jlist')).toEqual(['docker', 'exec', '-u', 'node', '-i', 'app-1', '/bin/bash', '-lc', 'pm2 jlist']);
  });
  it('ssh: BatchMode, ssh_args, a connect timeout, destination, one quoted remote command', () => {
    expect(buildArgv(ssh, `echo 'hi there'`)).toEqual([
      'ssh', '-o', 'BatchMode=yes', '-J', 'bastion', '-o', 'ConnectTimeout=10', 'stand', `'/bin/bash' '-lc' 'echo '\\''hi there'\\'''`,
    ]);
  });
  it('ssh: the connect timeout comes after ssh_args, so a ConnectTimeout there wins (ssh keeps the first value)', () => {
    const argv = buildArgv({ ...ssh, ssh_args: ['-o', 'ConnectTimeout=3'] }, 'true');
    expect(argv.indexOf('ConnectTimeout=3')).toBeLessThan(argv.indexOf('ConnectTimeout=10'));
  });
  it('ssh + docker composes', () => {
    const argv = buildArgv(both, 'pm2 jlist');
    expect(argv.slice(0, 8)).toEqual(['ssh', '-o', 'BatchMode=yes', '-J', 'bastion', '-o', 'ConnectTimeout=10', 'stand']);
    expect(argv[8]).toBe(`'docker' 'exec' '-u' 'node' '-i' 'app-1' '/bin/bash' '-lc' 'pm2 jlist'`);
  });
  it('withEnv prefixes exports', () => {
    expect(withEnv('pm2 jlist', { PM2_HOME: "/h/it's" })).toBe(`export PM2_HOME='/h/it'\\''s'; pm2 jlist`);
    expect(withEnv('x', {})).toBe('x');
  });
  it('describeHost', () => {
    expect(describeHost(local)).toBe('local');
    expect(describeHost(both)).toBe('ssh stand → docker app-1 (node)');
  });
});

describe('createTransport with nodeSpawner', () => {
  it('runs a local command with stdin and captures stdout/stderr/code', async () => {
    const t = createTransport(local);
    const r = await t.exec('cat; echo err >&2; exit 3', { stdin: 'in-data' });
    expect(r).toEqual({ code: 3, stdout: 'in-data', stderr: 'err\n' });
  });
  it('applies env through the command prefix', async () => {
    const t = createTransport(local);
    const r = await t.exec('printf %s "$PM2_HOME"', { env: { PM2_HOME: '/tmp/x y' } });
    expect(r.stdout).toBe('/tmp/x y');
  });
  it('decodes UTF-8 characters split across chunk boundaries', async () => {
    const t = createTransport(local);
    // one write of 1 + 2*70000 bytes: the pipe hands it over in 64 KiB chunks, so a 2-byte character straddles a boundary
    const r = await t.exec(`node -e "process.stdout.write('a' + 'ж'.repeat(70000))"`);
    expect(r.stdout.includes('\uFFFD')).toBe(false);
    expect(r.stdout.length).toBe(70001);
  });
  it('times out and reports TIMEOUT', async () => {
    const t = createTransport(local);
    await expect(t.exec('sleep 5', { timeoutMs: 200 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('passes argv to an injected spawner', async () => {
    const calls: string[][] = [];
    const fake: Spawner = async (argv) => { calls.push(argv); return { code: 0, stdout: 'ok', stderr: '' }; };
    const t = createTransport(ssh, fake);
    await t.exec('true');
    expect(calls[0][0]).toBe('ssh');
  });
  it('passes binary stdin through unchanged', async () => {
    const t = createTransport(local);
    const data = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 256));
    const r = await t.exec("sha256sum | cut -d' ' -f1", { stdin: data });
    expect(r.stdout.trim()).toBe(createHash('sha256').update(data).digest('hex'));
  });
});

describe('ensureOk', () => {
  it('maps ssh 255 to TRANSPORT_FAILED with stderr, passes other codes through', () => {
    expect(() => ensureOk({ code: 255, stdout: '', stderr: 'ssh: connect to host stand port 22: Connection refused' }, ssh, 'pm2 jlist'))
      .toThrowError(McprocError);
    try { ensureOk({ code: 255, stdout: '', stderr: 'Connection refused' }, ssh, 'pm2 jlist'); } catch (e) {
      expect((e as McprocError).code).toBe('TRANSPORT_FAILED');
      expect((e as McprocError).message).toContain('Connection refused');
    }
    expect(ensureOk({ code: 1, stdout: '', stderr: 'pm2 err' }, ssh, 'x').code).toBe(1);
    expect(() => ensureOk({ code: 1, stdout: '', stderr: 'Error: No such container: app-1' }, docker, 'x')).toThrowError(/No such container/);
  });
  it('maps docker exec failures (missing shell, unknown user) to TRANSPORT_FAILED', () => {
    const noShell = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/bash": stat /bin/bash: no such file or directory: unknown';
    expect(() => ensureOk({ code: 126, stdout: '', stderr: noShell }, docker, 'pm2 jlist')).toThrowError(/OCI runtime exec failed/);
    expect(() => ensureOk({ code: 126, stdout: '', stderr: 'unable to find user node: no matching entries in passwd file' }, docker, 'x')).toThrowError(/unable to find user/);
  });
});

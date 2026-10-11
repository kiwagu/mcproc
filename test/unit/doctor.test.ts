import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../src/core/manifest.js';
import { doctor } from '../../src/core/doctor.js';
import type { Spawner } from '../../src/transport/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

// The jlist branch must come before the 'bin/pm2' one: the locally bundled pm2 command contains '.../pm2/bin/pm2' too.
const spawner: Spawner = async (argv) => {
  const cmd = argv[argv.length - 1];
  if (argv[0] === 'ssh' && argv.includes('stand')) return { code: 255, stdout: '', stderr: 'ssh: connect to host stand port 22: Connection refused' };
  if (argv[0] === 'ssh' && argv.includes('prod')) {
    if (cmd.includes('__MCPROC_DOCTOR__')) return { code: 0, stdout: '__MCPROC_DOCTOR__\nv20.1.0\ntool ps yes\ntool ss no\ntool tar yes\npm2home /home/node/.pm2\nRUNTIME no\n', stderr: '' };
    if (cmd.includes('jlist')) return { code: 0, stdout: '[]', stderr: '' };
    if (cmd.includes('bin/pm2')) return { code: 0, stdout: 'PATH_OK\n5.3.0\nv20.1.0\n', stderr: '' };
  }
  if (cmd.includes('__MCPROC_DOCTOR__')) return { code: 0, stdout: '__MCPROC_DOCTOR__\nv22.3.0\ntool ps yes\ntool ss yes\ntool tar yes\npm2home \nRUNTIME no\n', stderr: '' };
  if (cmd.includes('jlist')) return { code: 0, stdout: JSON.stringify([{ pid: 1, name: 'demo-api', pm_id: 0, pm2_env: { status: 'online', namespace: 'demo' } }]), stderr: '' };
  if (cmd.includes('bin/pm2')) return { code: 0, stdout: 'PATH_NONE\nv22.3.0\n', stderr: '' };
  return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
};

describe('doctor', () => {
  it('reports every host, continues past an unreachable one, recommends fixes', async () => {
    const m = loadManifest(basic);
    const reps = await doctor(m, undefined, spawner);
    expect(reps.map((r) => r.host)).toEqual(['local', 'stand', 'prod']);
    const [local, stand, prod] = reps;
    expect(local).toMatchObject({ reachable: true, node: 'v22.3.0', tools: { ps: true, ss: true, tar: true }, daemon: 'answers', processes: 1, in_namespace: 1 });
    expect(local.pm2?.source).toBe('bundled');
    expect(local.recommendations).toEqual([]);
    expect(stand.reachable).toBe(false);
    expect(stand.error).toContain('Connection refused');
    expect(stand.recommendations[0]).toContain('ssh stand');
    expect(prod).toMatchObject({ reachable: true, node: 'v20.1.0', pm2: { source: 'path', version: '5.3.0' }, pm2_home: '/home/node/.pm2', daemon: 'answers', processes: 0 });
    expect(prod.tools.ss).toBe(false);
    expect(prod.recommendations.join('\n')).toMatch(/pm2_home/);
    expect(prod.recommendations.join('\n')).toMatch(/no ss/);
  });
  it('limits to one host when asked', async () => {
    const reps = await doctor(loadManifest(basic), 'prod', spawner);
    expect(reps.map((r) => r.host)).toEqual(['prod']);
  });
});

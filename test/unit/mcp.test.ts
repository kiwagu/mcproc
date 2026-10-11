import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, INSTRUCTIONS } from '../../src/mcp/server.js';
import { MARK } from '../../src/shell/snippets.js';
import { probeOut } from '../helpers/probe.js';
import type { Spawner } from '../../src/transport/types.js';
import type { UnpackDeps } from '../../src/runtime/unpack.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

async function client(spawner?: Spawner, unpackDeps?: UnpackDeps) {
  const server = createServer({ spawner, unpack: unpackDeps });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const cl = new Client({ name: 'test', version: '0.0.0' });
  await cl.connect(c);
  return cl;
}
const neverSpawn: Spawner = async (argv) => { throw new Error(`spawner must not be called: ${argv.join(' ')}`); };
const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('mcp server', () => {
  it('registers the 13 tools with annotations and short instructions', async () => {
    const cl = await client();
    const tools = await cl.listTools();
    const byName = Object.fromEntries(tools.tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['delete', 'describe', 'doctor', 'flush', 'hosts', 'init', 'logs', 'ls', 'ports', 'restart', 'start', 'stop', 'unpack']);
    for (const n of ['hosts', 'doctor', 'ls', 'describe', 'logs', 'ports']) expect(byName[n].annotations?.readOnlyHint).toBe(true);
    for (const n of ['stop', 'delete', 'flush']) expect(byName[n].annotations?.destructiveHint).toBe(true);
    expect(byName.start.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.unpack.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(byName.unpack.description).toMatch(/npm/); // pm2 is assembled with npm from the shipped lockfile, never inside the package
    expect(byName.unpack.description).not.toMatch(/bundled with mcproc|ships inside/);
    expect(INSTRUCTIONS.length).toBeLessThan(2000);
    expect(cl.getInstructions()).toBe(INSTRUCTIONS);
  });
  it('returns MANIFEST_NOT_FOUND with the init hint as an isError result', async () => {
    const cl = await client(neverSpawn);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-empty-'));
    const r = await cl.callTool({ name: 'ls', arguments: { project: dir } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('MANIFEST_NOT_FOUND');
    expect(text(r)).toContain('Hint: Run init');
  });
  it('hosts and describe (project) work without touching a transport', async () => {
    const cl = await client(neverSpawn);
    const h: any = await cl.callTool({ name: 'hosts', arguments: { project: basic } });
    expect(h.structuredContent.hosts.map((x: any) => x.name)).toEqual(['local', 'stand', 'prod']);
    const d: any = await cl.callTool({ name: 'describe', arguments: { project: basic } });
    expect(d.structuredContent.project).toBe('demo');
    expect(text(d)).toContain('api-build');
  });
  it('refuses mutations on readonly hosts and unknown targets before any transport call', async () => {
    const cl = await client(neverSpawn);
    const ro = await cl.callTool({ name: 'stop', arguments: { project: basic, host: 'prod', target: 'api' } });
    expect(ro.isError).toBe(true);
    expect(text(ro)).toContain('READONLY_HOST');
    const un = await cl.callTool({ name: 'start', arguments: { project: basic, target: 'nope' } });
    expect(text(un)).toContain('UNKNOWN_APP');
  });
  it('ls renders rows from a fake host', async () => {
    const jlist = JSON.stringify([{ pid: 4242, name: 'demo-api', pm_id: 0, pm2_env: { status: 'online', namespace: 'demo' } }]);
    const spawner: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes(MARK.JLIST)) return { code: 0, stdout: probeOut({ jlist, ps: '4242 1\n', tcp: 'LISTEN 0 1 *:3310 *:* users:(("node",pid=4242,fd=1))\n' }), stderr: '' };
      if (cmd.includes('bin/pm2')) return { code: 0, stdout: 'PATH_OK\n7.0.4\nv22.0.0\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const cl = await client(spawner);
    const r: any = await cl.callTool({ name: 'ls', arguments: { project: basic } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.rows).toHaveLength(3);
    expect(text(r)).toMatch(/api\s+server\s+online\s+4242/);
    expect(text(r)).toContain(':3310 ✓');
  });
  it('init creates the draft', async () => {
    const cl = await client(neverSpawn);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-init-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    const r: any = await cl.callTool({ name: 'init', arguments: { project: dir } });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, '.mcproc', '.gitignore'), 'utf8')).toBe('*\n');
    expect(r.structuredContent.candidates).toBe(1);
  });
  it('unpack refuses readonly hosts first and runs end to end over a fake ssh host', async () => {
    const ro = await (await client(neverSpawn)).callTool({ name: 'unpack', arguments: { project: basic, host: 'prod' } });
    expect(text(ro)).toContain('READONLY_HOST');
    const sp: Spawner = async (argv) => {
      const cmd = argv[argv.length - 1];
      if (cmd.includes('__MCPROC_UNPACK__')) return { code: 0, stdout: '__MCPROC_UNPACK__\nLinux x86_64\nNODE v22.11.0\nTAR_OK\nMANIFEST_NONE\n__MCPROC_LOCK__\n', stderr: '' };
      if (cmd.includes('require(process.argv[1]).version')) return { code: 0, stdout: '7.0.4\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const fakeDeps: UnpackDeps = {
      pm2Bundle: async () => ({ version: '7.0.4', sha256: 'x', data: Buffer.from('t'), path: '/tmp/x.tgz' }),
      nodeVersion: async () => 'v24.21.0', nodeTarball: async () => ({ data: Buffer.from('n'), sha256: 'y' }),
      hostname: () => 'agent', now: () => new Date(0),
    };
    const r: any = await (await client(sp, fakeDeps)).callTool({ name: 'unpack', arguments: { project: basic, host: 'stand' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ host: 'stand', pm2: { version: '7.0.4', written: true }, manifest_copy: 'written' });
    expect(text(r)).toContain("'/srv/demo/.mcproc/runtime/bin/pm2' monit");
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProgram } from '../../src/cli/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

function capture() {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (s: string) => { out.push(s); }, err: (s: string) => { err.push(s); } } };
}
afterEach(() => { process.exitCode = 0; });

describe('cli', () => {
  it('hosts --json prints the hosts', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(['hosts', '--project', basic, '--json'], { from: 'user' });
    expect(JSON.parse(c.out.join('')).map((h: { name: string }) => h.name)).toEqual(['local', 'stand', 'prod']);
  });
  it('describe prints the project summary as text', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(['describe', '--project', basic], { from: 'user' });
    expect(c.out.join('\n')).toContain('api-build [build]');
  });
  it('errors go to stderr with code and hint, exit code 1', async () => {
    const c = capture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'));
    await buildProgram(c.io).parseAsync(['ls', '--project', dir], { from: 'user' });
    expect(c.err[0]).toContain('MANIFEST_NOT_FOUND');
    expect(c.err[0]).toContain('Hint:');
    expect(process.exitCode).toBe(1);
  });
  it('init creates a draft and start refuses readonly hosts before connecting', async () => {
    const c = capture();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node s.js' } }));
    await buildProgram(c.io).parseAsync(['init', '--project', dir], { from: 'user' });
    expect(fs.existsSync(path.join(dir, '.mcproc', 'mcproc.yaml'))).toBe(true);
    const c2 = capture();
    await buildProgram(c2.io).parseAsync(['start', 'api', '--project', basic, '--host', 'prod'], { from: 'user' });
    expect(c2.err[0]).toContain('READONLY_HOST');
  });
  it('lists every command in --help', () => {
    const help = buildProgram(capture().io).helpInformation();
    for (const cmd of ['init', 'hosts', 'doctor', 'ls', 'describe', 'logs', 'ports', 'start', 'restart', 'stop', 'delete', 'flush', 'monit', 'mcp']) expect(help).toContain(cmd);
  });
  it('monit --once reports MANIFEST_NOT_FOUND cleanly outside a project', async () => {
    const c = capture();
    await buildProgram(c.io).parseAsync(['monit', '--once', '--project', fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-cli-'))], { from: 'user' });
    expect(c.err[0]).toContain('MANIFEST_NOT_FOUND');
  });
});

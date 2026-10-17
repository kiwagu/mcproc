import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const basic = path.join(root, 'test', 'fixtures', 'projects', 'basic');
/** The bundle under test: dist/cli.js, or another build of this tree (a branch built elsewhere, so dist keeps serving the installed mcproc). */
const cli = process.env.MCPROC_CLI ?? path.join(root, 'dist', 'cli.js');

describe('mcproc mcp over stdio (built dist)', () => {
  it('lists tools and answers hosts', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'mcp'],
      env: { ...process.env, MCPROC_PROJECT: basic } as Record<string, string>,
    });
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(21);
    expect(tools.tools.map((t) => t.name)).toContain('incidents');
    const r: any = await client.callTool({ name: 'hosts', arguments: {} });
    expect(r.structuredContent.hosts).toHaveLength(3);
    await client.close();
  }, 30_000);
});

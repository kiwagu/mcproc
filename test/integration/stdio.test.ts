import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const basic = path.join(root, 'test', 'fixtures', 'projects', 'basic');

describe('mcproc mcp over stdio (built dist)', () => {
  it('lists tools and answers hosts', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'cli.js'), 'mcp'], env: { ...process.env, MCPROC_PROJECT: basic } as Record<string, string> });
    const client = new Client({ name: 'smoke', version: '0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(12);
    const r: any = await client.callTool({ name: 'hosts', arguments: {} });
    expect(r.structuredContent.hosts).toHaveLength(3);
    await client.close();
  }, 30_000);
});

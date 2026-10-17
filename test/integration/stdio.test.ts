import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const basic = path.join(root, 'test', 'fixtures', 'projects', 'basic');
const vars = path.join(root, 'test', 'fixtures', 'projects', 'vars');
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
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'incidents',
        'exec',
        'leases',
        'lease_cancel',
        'worktree_add',
        'worktree_ls',
        'worktree_remove',
      ])
    );
    const r: any = await client.callTool({ name: 'hosts', arguments: {} });
    expect(r.structuredContent.hosts).toHaveLength(3);
    // the vars fixture's override sets slot 2, rendered into its apps
    const d: any = await client.callTool({
      name: 'describe',
      arguments: { project: vars },
    });
    expect(d.content[0].text).toContain('slot 2');
    // the queue of this file's state directory; a folder without a manifest never reaches a pm2 daemon
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-stdio-'));
    try {
      const l: any = await client.callTool({
        name: 'leases',
        arguments: { project: none },
      });
      expect(l.content[0].text).toMatch(/^state: /);
      expect(l.structuredContent.state_dir).toBe(process.env.MCPROC_STATE_DIR);
    } finally {
      fs.rmSync(none, { recursive: true, force: true });
    }
    await client.close();
  }, 30_000);
});

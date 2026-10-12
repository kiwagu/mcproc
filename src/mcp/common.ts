import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isMcprocError, McprocError } from '../core/errors.js';
import type { Spawner } from '../transport/types.js';
import type { UnpackDeps } from '../runtime/unpack.js';

export const commonInput = {
  project: z.string().optional().describe('Project root. Default: MCPROC_PROJECT, then CLAUDE_PROJECT_DIR, then the client roots, then the server cwd; the manifest is searched upward from there.'),
  host: z.string().optional().describe('Host name from the manifest hosts: section. Omitted: every app is reached on the host it runs on (its `host:` in the manifest, local for apps without one). Given: only the apps that run on that host (bound to it, or without a `host:`); naming an app bound elsewhere is refused.'),
};
export interface ToolDeps { roots: () => Promise<string[]>; spawner?: Spawner; unpack?: UnpackDeps }

export const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const MUT = (destructive: boolean, idempotent: boolean) => ({ readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });

export async function runTool(fn: () => Promise<{ text: string; data: Record<string, unknown> }>): Promise<CallToolResult> {
  try {
    const { text, data } = await fn();
    return { content: [{ type: 'text', text }], structuredContent: data };
  } catch (e) {
    const err = isMcprocError(e) ? e : new McprocError('PM2_FAILED', e instanceof Error ? e.message : String(e));
    return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}${err.hint ? `\nHint: ${err.hint}` : ''}` }], structuredContent: { error: err.toJSON() } };
  }
}

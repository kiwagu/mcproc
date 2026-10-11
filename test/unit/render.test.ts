import { describe, it, expect } from 'vitest';
import { startNote } from '../../src/mcp/render.js';
import type { LsRow } from '../../src/core/list.js';
import type { PortCheck } from '../../src/core/ports.js';

const row = (status: string, checks: PortCheck[]): LsRow => ({
  app: 'web', kind: 'server', description: '', status, pm_id: 0, pid: 1, uptime_ms: 0, restarts: 0, cpu: 0, memory: 0,
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

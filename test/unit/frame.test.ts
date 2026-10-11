import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../../src/monit/state.js';
import { renderFrame, frameToText } from '../../src/monit/frame.js';
import type { LsRow } from '../../src/core/list.js';

const web: LsRow = { app: 'web', kind: 'server', description: 'dashboard (Next dev)', status: 'online', pm_id: 1, pid: 971175, uptime_ms: 22 * 60_000, restarts: 0, cpu: 84.4, memory: 2_200_000_000, procs: 3, runtime: 'next-server (v16.2.9) with a very long tail of arguments that must be cut', pm2_cpu: 0, pm2_memory: 9_000_000, metrics_source: 'tree', url: 'http://localhost:3100/', url_status: 'ok', url_code: 200,
  ports: { actual: [{ proto: 'tcp', addr: '*', port: 3100, pid: 971200, pids: [971200], command: 'next-server', container: null }], declared: [3100], checks: [{ port: 3100, status: 'listening' }], undeclared: [] } };
const docs: LsRow = { ...web, app: 'docs', pid: 1, url: 'http://localhost:3200/', url_status: 'unchecked', url_code: null, ports: { actual: [], declared: [3200], checks: [{ port: 3200, status: 'declared-not-listening', held_by: { pid: null, command: null, container: 'some-container' } }], undeclared: [] } };
const base = () => reduce(initialState({ project: 'zero-memory', host: 'local', hosts: ['local'], apps: { web: { description: 'dashboard (Next dev)', run: 'bun run dev', cwd: 'apps/web', pm2Name: 'zero-memory-web' }, docs: { description: 'docs', run: 'bun run dev', cwd: 'apps/docs', pm2Name: 'zero-memory-docs' } } }), { type: 'rows', rows: [web, docs], at: new Date('2026-10-11T13:41:07') });

describe('renderFrame', () => {
  it('fits an 80-column terminal: no line wider than 80, marker on the selected row, ports visible', () => {
    const f = renderFrame(base(), { width: 80, height: 24 });
    for (const line of [f.header, ...f.table, ...f.logs, ...f.details, f.footer]) expect(line.length).toBeLessThanOrEqual(80);
    expect(f.table[1]).toMatch(/^▶web\s+online\s+22m\s+2\.05G\s+84\.4%\s+:3100 ✓/);
    expect(f.table[2]).toMatch(/^ docs/);
    expect(f.table[2]).toContain(':3200 ✗');
  });
  it('wide terminal shows the runtime and the details name the RSS sum and the pm2 root value', () => {
    const f = renderFrame(base(), { width: 160, height: 40 });
    expect(f.table[1]).toContain('next-server (v16.2.9)');
    expect(f.details.join('\n')).toContain('RSS sum');
    expect(f.details.join('\n')).toContain('pm2 root: 8.6M');
    expect(f.details.join('\n')).toContain('zero-memory-web');
    expect(f.details.join('\n')).toContain(':3100 ✓ pid 971200 next-server');
    expect(f.table[1]).toContain('http://localhost:3100/ ✓ 200');
    expect(f.table[2]).toContain('http://localhost:3200/');
    expect(f.table[2]).not.toContain('http://localhost:3200/ ✓');
    expect(f.details.join('\n')).toContain('url: http://localhost:3100/ ✓ 200');
  });
  it('footer carries the error or the notice; logs are the tail that fits', () => {
    let s = reduce(base(), { type: 'error', message: 'TRANSPORT_FAILED: ssh stand: Connection refused' });
    expect(renderFrame(s, { width: 120, height: 30 }).footer).toContain('ERROR: TRANSPORT_FAILED');
    expect(renderFrame(s, { width: 80, height: 24 }).footer).toMatch(/^ERROR: TRANSPORT_FAILED: ssh stand: Connection refused/); // the error leads: a narrow terminal must not hide it behind the key legend
    expect(renderFrame(base(), { width: 80, height: 24 }).footer).toMatch(/^↑↓ app/);
    s = reduce(base(), { type: 'logs', lines: Array.from({ length: 50 }, (_, i) => ({ stream: 'out' as const, text: `2026-10-11T13:00:${String(i).padStart(2, '0')}: line ${i}` })) });
    const f = renderFrame(s, { width: 120, height: 24 });
    expect(f.logs.length).toBeLessThan(50);
    expect(f.logs.at(-1)).toContain('line 49');
    expect(frameToText(f)).toContain('line 49');
  });
});

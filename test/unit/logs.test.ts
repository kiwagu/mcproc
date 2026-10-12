import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeCtx } from '../helpers/ctx.js';
import { keepSgr, readLogs, flushLogs, stripAnsi } from '../../src/core/logs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const jlist = JSON.stringify([
  { pid: 0, name: 'demo-worker', pm_id: 2, pm2_env: { status: 'stopped', namespace: 'demo', pm_out_log_path: '/h/logs/worker-out.log', pm_err_log_path: '/h/logs/worker-error.log' } },
  { pid: 9, name: 'other-api', pm_id: 7, pm2_env: { status: 'online', namespace: 'other', pm_out_log_path: '/h/logs/api-out.log', pm_err_log_path: '/h/logs/api-error.log' } },
]);
const tailOut = '__MCPROC_OUT__\n\x1b[32mlistening\x1b[39m 3310\nsecond\n__MCPROC_ERR__\nboom\n';

describe('stripAnsi', () => {
  it('removes colour and cursor sequences', () => {
    expect(stripAnsi('\x1b[32m[PM2] \x1b[39mok \x1b[2K\x1b[1Gx')).toBe('[PM2] ok x');
  });
});

describe('readLogs', () => {
  it('tails both streams by pm2-reported paths, strips ANSI, clamps lines', async () => {
    const ctx = fakeCtx(basic, 'local', [{ match: 'jlist', result: { stdout: jlist } }, { match: 'tail -n', result: { stdout: tailOut } }]);
    const r = await readLogs(ctx, 'worker', { lines: 5000 });
    expect(r).toEqual({ app: 'worker', lines: 2000, paths: { out: '/h/logs/worker-out.log', err: '/h/logs/worker-error.log' }, out: 'listening 3310\nsecond', err: 'boom' });
    expect(ctx.fake.calls[1].cmd).toBe(`echo __MCPROC_OUT__; tail -n 2000 '/h/logs/worker-out.log' 2>/dev/null; echo __MCPROC_ERR__; tail -n 2000 '/h/logs/worker-error.log' 2>/dev/null`);
  });
  it('an escape an app never terminated stops at its line: the rest of the output and the err section survive', async () => {
    const out = '__MCPROC_OUT__\na \x1b]0;title\nline2\n__MCPROC_ERR__\nerr1\n';
    const ctx = fakeCtx(basic, 'local', [{ match: 'jlist', result: { stdout: jlist } }, { match: 'tail -n', result: { stdout: out } }]);
    const r = await readLogs(ctx, 'worker', { lines: 10 });
    expect(r.out).toBe('a \nline2');
    expect(r.err).toBe('err1');
  });
  it('stream=err tails only the error file', async () => {
    const ctx = fakeCtx(basic, 'local', [{ match: 'jlist', result: { stdout: jlist } }, { match: 'tail -n', result: { stdout: '__MCPROC_ERR__\nboom\n' } }]);
    const r = await readLogs(ctx, 'worker', { lines: 10, stream: 'err' });
    expect(r.out).toBeUndefined();
    expect(r.err).toBe('boom');
    expect(ctx.fake.calls[1].cmd).not.toContain('worker-out');
  });
  it('NOT_STARTED when the app has no process in this namespace (foreign same-name ignored)', async () => {
    const ctx = fakeCtx(basic, 'local', [{ match: 'jlist', result: { stdout: jlist } }]);
    await expect(readLogs(ctx, 'api')).rejects.toMatchObject({ code: 'NOT_STARTED' });
  });
});

describe('flushLogs', () => {
  it('truncates out/err of each existing process and reports freed bytes', async () => {
    const ctx = fakeCtx(basic, 'local', [{ match: 'jlist', result: { stdout: jlist } }, { match: 'wc -c', result: { stdout: '120\n7\n' } }]);
    const r = await flushLogs(ctx);
    expect(r).toEqual([{ app: 'worker', out_bytes: 120, err_bytes: 7 }]);
    expect(ctx.fake.calls[1].cmd).toContain(`: > '/h/logs/worker-out.log'`);
    expect(ctx.fake.calls[1].cmd).not.toContain('api-out');
  });
});

describe('keepSgr', () => {
  it('keeps color and style codes (16, 256 and true color), drops every other escape: cursor, erase, titles, charsets', () => {
    expect(keepSgr('\x1b[32mready\x1b[39m')).toBe('\x1b[32mready\x1b[39m');
    expect(keepSgr('\x1b[38;5;66mtimestamp=\x1b[0m2026 \x1b[38:2::255:0:0mX\x1b[m')).toBe('\x1b[38;5;66mtimestamp=\x1b[0m2026 \x1b[38:2::255:0:0mX\x1b[m');
    expect(keepSgr('\x1b[?25h\x1b[2Kline\x1b]0;title\x07 end\x1b(B\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\')).toBe('line endlink');
    expect(keepSgr('stray \x1b')).toBe('stray ');
  });
});

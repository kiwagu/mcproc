import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDaemons, listDaemon, pm2Rpc } from '../../src/core/pm2socket.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const homes: string[] = [];
const home = () => {
  const h = fs.mkdtempSync('/tmp/mcproc-sk-'); // short: unix socket paths are capped at 108 bytes
  homes.push(h);
  return h;
};
/** A stand-in daemon: an rpc server on <home>/rpc.sock that answers getMonitorData; counts the connections it saw. */
function daemon(
  h: string,
  answer: (cb: (e: Error | null, r?: unknown) => void) => void
) {
  const { axon, rpc } = pm2Rpc();
  const rep = axon.socket('rep');
  const server = new rpc.Server(rep);
  server.expose(
    'getMonitorData',
    (_o: unknown, cb: (e: Error | null, r?: unknown) => void) => answer(cb)
  );
  let connections = 0;
  let open = 0;
  rep.on('connect', () => {
    connections++;
    open++;
  });
  rep.on('disconnect', () => open--);
  const ready = new Promise<void>((r) => rep.once('bind', () => r()));
  rep.bind(path.join(h, 'rpc.sock'));
  return {
    ready,
    close: () => rep.close(),
    connections: () => connections,
    open: () => open,
  };
}
const PROC = {
  pm_id: 0,
  name: 'p-web',
  pid: 7,
  pm2_env: { status: 'online', namespace: 'p' },
};

afterEach(() => {
  closeDaemons();
  for (const h of homes.splice(0))
    fs.rmSync(h, { recursive: true, force: true });
});

describe('listDaemon', () => {
  it('lists the daemon over its socket', async () => {
    const h = home();
    const d = daemon(h, (cb) => cb(null, [PROC]));
    await d.ready;
    expect(await listDaemon(h)).toEqual([PROC]);
    d.close();
  });
  it('keeps one connection for many calls', async () => {
    const h = home();
    const d = daemon(h, (cb) => cb(null, []));
    await d.ready;
    for (let i = 0; i < 5; i++) await listDaemon(h);
    expect(d.connections()).toBe(1);
    d.close();
  });
  it('no socket: null, at once', async () => {
    const t = Date.now();
    expect(await listDaemon(home())).toBeNull();
    expect(Date.now() - t).toBeLessThan(100);
  });
  it('a socket file nothing listens on: null', async () => {
    const h = home();
    fs.writeFileSync(path.join(h, 'rpc.sock'), '');
    expect(await listDaemon(h, 1000)).toBeNull();
  });
  it('a daemon that does not answer: throws within the bound, and the next call connects afresh', async () => {
    const h = home();
    const d = daemon(h, () => {});
    await d.ready;
    await expect(listDaemon(h, 200)).rejects.toThrow(/200 ms/);
    await expect(listDaemon(h, 200)).rejects.toThrow(/200 ms/);
    expect(d.connections()).toBe(2);
    d.close();
  });
  it('a daemon that errs: throws', async () => {
    const h = home();
    const d = daemon(h, (cb) => cb(new Error('boom')));
    await d.ready;
    await expect(listDaemon(h)).rejects.toThrow(/boom/);
    d.close();
  });
  it('a daemon that answers no list: throws', async () => {
    const h = home();
    const d = daemon(h, (cb) => cb(null, { pm_id: 0 }));
    await d.ready;
    await expect(listDaemon(h)).rejects.toThrow(/no list/);
    d.close();
  });
  it('a dropped connection reconnects on the next call, to the daemon that answers now', async () => {
    const h = home();
    const d1 = daemon(h, (cb) => cb(null, [PROC]));
    await d1.ready;
    expect(await listDaemon(h)).toEqual([PROC]);
    d1.close();
    await sleep(200);
    fs.rmSync(path.join(h, 'rpc.sock'), { force: true });
    const d2 = daemon(h, (cb) => cb(null, []));
    await d2.ready;
    expect(await listDaemon(h)).toEqual([]);
    d2.close();
  });
  it('a daemon back within the retry window keeps no connection open from the dropped one', async () => {
    const h = home();
    const d1 = daemon(h, (cb) => cb(null, [PROC]));
    await d1.ready;
    expect(await listDaemon(h)).toEqual([PROC]);
    d1.close();
    const d2 = daemon(h, (cb) => cb(null, [])); // back before axon's own retry, 100 ms after the drop
    await d2.ready;
    await sleep(300);
    expect(d2.open()).toBe(0);
    d2.close();
  });
  it('a call right after a drop goes to a fresh connection, never to the dropped one', async () => {
    const h = home();
    const d1 = daemon(h, (cb) => cb(null, [PROC]));
    await d1.ready;
    expect(await listDaemon(h)).toEqual([PROC]);
    d1.close();
    const d2 = daemon(h, (cb) => cb(null, []));
    await d2.ready;
    await sleep(20); // the drop is seen; axon's retry has not run yet
    expect(await listDaemon(h, 1000)).toEqual([]);
    expect(await listDaemon(h, 1000)).toEqual([]);
    await sleep(300);
    expect(d2.open()).toBe(1); // the pooled connection, and nothing else
    d2.close();
  });
  it('a one-shot process waits for a slow answer, then exits with its connection still pooled', async () => {
    const h = home();
    const d = daemon(h, (cb) => setTimeout(() => cb(null, [PROC]), 300));
    await d.ready;
    const src = fileURLToPath(
      new URL('../../src/core/pm2socket.ts', import.meta.url)
    );
    const script = path.join(h, 'once.mts');
    fs.writeFileSync(
      script,
      [
        `import { listDaemon } from ${JSON.stringify(src)};`,
        `console.log(JSON.stringify(await listDaemon(${JSON.stringify(h)})));`,
      ].join('\n')
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString();
    });
    let bound: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      new Promise<number | null>((r) => child.on('exit', r)),
      new Promise<string>((r) => {
        bound = setTimeout(() => r('still running'), 10_000);
      }),
    ]);
    clearTimeout(bound);
    if (code === 'still running') child.kill('SIGKILL');
    expect({ code, out: out.trim() }).toEqual({
      code: 0,
      out: JSON.stringify([PROC]),
    });
    d.close();
  }, 30_000);
});

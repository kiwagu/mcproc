import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import {
  clearLogs,
  lockAddress,
  countedClearKey,
  fileClearKey,
  isAppClearKey,
  parseFileClearKey,
  readStore,
  storePath,
  takeIncidents,
  withStore,
} from '../../src/core/incidents/store.js';
import { fakeHosts, proc, S } from '../helpers/incidents.js';

let file: string;
beforeEach(() => {
  file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-store-')),
    'incidents.json'
  );
});

describe('the pick-up point', () => {
  it('lives next to the manifest', () => {
    expect(storePath('/p/.mcproc/mcproc.yaml')).toBe(
      '/p/.mcproc/incidents.json'
    );
  });
  it('taking moves it for every caller; peeking leaves it', async () => {
    const state = {
      files: {
        '/l/watch-out': `${S(1)}ok\n${S(2)}TypeError: x is undefined\n`,
      },
      procs: { local: [proc('watch', 0)] },
    };
    const h = fakeHosts(state);
    const peek = await takeIncidents(h.fleet, ['watch'], { peek: true }, file);
    expect(peek.answer).toMatchObject({
      taken: false,
      incidents: [{ line: `${S(2)}TypeError: x is undefined` }],
    });
    expect(fs.existsSync(file)).toBe(false); // a peek writes nothing
    const taken = await takeIncidents(h.fleet, ['watch'], {}, file);
    expect(taken.answer).toMatchObject({
      taken: true,
      incidents: [{ line: `${S(2)}TypeError: x is undefined` }],
    });
    expect(
      (await takeIncidents(h.fleet, ['watch'], {}, file)).answer.incidents
    ).toEqual([]); // any later caller: nothing
    expect(
      (await takeIncidents(h.fleet, ['watch'], { peek: true }, file)).answer
        .incidents
    ).toEqual([]);
    state.files['/l/watch-out'] += `${S(9)}level=error msg=db down\n`;
    expect(
      (await takeIncidents(h.fleet, ['watch'], {}, file)).answer.incidents.map(
        (i) => i.line
      )
    ).toEqual([`${S(9)}level=error msg=db down`]);
  });
  it('a peeking follower goes on from its own position; the stored point stays', async () => {
    const state = {
      files: { '/l/watch-out': `${S(2)}TypeError: a\n` },
      procs: { local: [proc('watch', 0)] },
    };
    const h = fakeHosts(state);
    const first = await takeIncidents(h.fleet, ['watch'], { peek: true }, file);
    expect(first.answer.incidents).toHaveLength(1);
    expect(
      (
        await takeIncidents(
          h.fleet,
          ['watch'],
          { peek: true, cursor: first.next },
          file
        )
      ).answer.incidents
    ).toEqual([]);
    expect(
      (await takeIncidents(h.fleet, ['watch'], {}, file)).answer.incidents
    ).toHaveLength(1);
  });
  it('two callers at the same moment: each incident goes to one of them', async () => {
    const state = {
      files: { '/l/watch-out': `${S(2)}TypeError: once\n` },
      procs: { local: [proc('watch', 0)] },
    };
    const h = fakeHosts(state);
    const both = await Promise.all([
      takeIncidents(h.fleet, ['watch'], {}, file),
      takeIncidents(h.fleet, ['watch'], {}, file),
    ]);
    expect(both.map((r) => r.answer.incidents.length).sort()).toEqual([0, 1]);
  });
  it('a live holder makes the caller wait, then TIMEOUT; once it is done the lock is free again', async () => {
    let release!: () => void;
    const holding = withStore(
      file,
      (s) =>
        new Promise<{ result: string; next: typeof s }>((r) => {
          release = () => r({ result: 'first', next: s });
        })
    );
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      withStore(file, async (s) => ({ result: 'second', next: s }), 300)
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    release();
    expect(await holding).toBe('first');
    expect(
      await withStore(file, async (s) => ({ result: 'third', next: s }), 300)
    ).toBe('third');
  });
  it('the same store reached through a symlinked project path is the same lock', async () => {
    const alias = `${path.dirname(file)}-alias`;
    fs.symlinkSync(path.dirname(file), alias);
    let release!: () => void;
    const holding = withStore(
      file,
      (s) =>
        new Promise<{ result: string; next: typeof s }>((r) => {
          release = () => r({ result: 'first', next: s });
        })
    );
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      withStore(
        path.join(alias, 'incidents.json'),
        async (s) => ({ result: 'alias', next: s }),
        300
      )
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    release();
    await holding;
  });
  it('a program that connects to the lock cannot keep the call from finishing', async () => {
    let release!: () => void;
    const holding = withStore(
      file,
      (s) =>
        new Promise<{ result: string; next: typeof s }>((r) => {
          release = () => r({ result: 'done', next: s });
        })
    );
    await new Promise((r) => setTimeout(r, 50));
    const client = net.connect(lockAddress(file) as net.NetConnectOpts); // a path or a host and port: the same shape for connecting
    client.on('error', () => {});
    await new Promise((r) => setTimeout(r, 100));
    release();
    expect(
      await Promise.race([
        holding,
        new Promise((r) => setTimeout(() => r('still waiting'), 2000)),
      ])
    ).toBe('done');
    client.destroy();
  });
  const store = fileURLToPath(
    new URL('../../src/core/incidents/store.ts', import.meta.url)
  );
  /** A process that takes the lock and keeps it until it is killed. */
  function holder(): Promise<ChildProcess> {
    const script = path.join(path.dirname(file), 'holder.mts');
    fs.writeFileSync(
      script,
      [
        `import { withStore } from ${JSON.stringify(store)};`,
        'setInterval(() => {}, 1000);',
        `await withStore(${JSON.stringify(file)}, async (s) => { console.log('holding'); await new Promise(() => {}); return { result: null, next: s }; });`,
      ].join('\n')
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Promise((resolve) =>
      child.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('holding')) resolve(child);
      })
    );
  }
  it('a suspended holder keeps the lock however old it looks; the lock goes with its process however it ends', async () => {
    const child = await holder();
    child.kill('SIGSTOP');
    const old = new Date(Date.now() - 600_000);
    for (const f of fs.readdirSync(path.dirname(file)))
      if (f.endsWith('.lock'))
        fs.utimesSync(path.join(path.dirname(file), f), old, old);
    await expect(
      withStore(file, async (s) => ({ result: 'taken over', next: s }), 500)
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    const gone = new Promise((r) => child.on('exit', r));
    child.kill('SIGKILL');
    await gone;
    expect(
      await withStore(file, async (s) => ({ result: 'after', next: s }), 2000)
    ).toBe('after');
  }, 30_000);
  it('processes taking the lock at the same moment never work at the same time', async () => {
    const dir = path.dirname(file);
    const marker = path.join(dir, 'inside');
    const overlap = path.join(dir, 'overlap');
    const script = path.join(dir, 'taker.mts');
    fs.writeFileSync(
      script,
      [
        `import fs from 'node:fs';`,
        `import { withStore } from ${JSON.stringify(store)};`,
        `for (let k = 0; k < 5; k++) await withStore(${JSON.stringify(file)}, async (s) => {`,
        `  if (fs.existsSync(${JSON.stringify(marker)})) fs.appendFileSync(${JSON.stringify(overlap)}, 'x');`,
        `  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
        `  await new Promise((r) => setTimeout(r, 15));`,
        `  fs.rmSync(${JSON.stringify(marker)}, { force: true });`,
        `  return { result: null, next: s };`,
        `});`,
      ].join('\n')
    );
    const codes = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<number | null>((resolve) => {
            spawn(process.execPath, ['--import', 'tsx', script], {
              cwd: process.cwd(),
              stdio: 'ignore',
            }).on('exit', resolve);
          })
      )
    );
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(fs.existsSync(overlap)).toBe(false);
  }, 30_000);
  it('an unreadable store is a fresh start', () => {
    fs.writeFileSync(file, '{not json');
    expect(readStore(file)).toEqual({
      v: 1,
      apps: {},
      cleared: {},
      clears: {},
    });
  });
});

describe('fileClearKey', () => {
  it('reads back what it wrote, a path with odd characters included; an app key is not one', () => {
    const k = fileClearKey('box/web', 'err', '/home/a b/web|err.log');
    expect(parseFileClearKey(k)).toEqual({
      key: 'box/web',
      stream: 'err',
      path: '/home/a b/web|err.log',
    });
    expect(parseFileClearKey('box/web')).toBeNull();
    expect(parseFileClearKey(countedClearKey('box/web'))).toBeNull();
    expect(isAppClearKey('box/web')).toBe(true);
    expect(isAppClearKey(countedClearKey('box/web'))).toBe(false);
    expect(isAppClearKey(k)).toBe(false);
  });
});

describe('clearLogs', () => {
  it('empties the logs, records when, and starts incidents there: nothing from before comes back', async () => {
    const before = `${S(1)}ERROR: before the clear\n`;
    const state = {
      files: { '/l/watch-out': before, '/l/watch-err': 'x\n' },
      procs: { local: [proc('watch', 0, { restart_time: 2 })] },
    };
    const h = fakeHosts(state);
    const r = await clearLogs(
      h.fleet,
      ['watch'],
      file,
      new Date(2026, 9, 12, 15, 4, 5)
    );
    expect(r).toEqual([
      {
        app: 'watch',
        host: 'local',
        out_bytes: Buffer.byteLength(before),
        err_bytes: 2,
      },
    ]);
    expect(state.files['/l/watch-out']).toBe('');
    expect(readStore(file).cleared).toEqual({
      'local/watch': '2026-10-12T15:04:05',
    });
    state.files['/l/watch-out'] = `${S(30)}ERROR: after the clear\n`;
    const next = await takeIncidents(h.fleet, ['watch'], {}, file);
    expect(next.answer.incidents.map((i) => i.line)).toEqual([
      `${S(30)}ERROR: after the clear`,
    ]); // and no restart event: counted at the clear
    expect(next.answer.cleared_at).toBe('2026-10-12T15:04:05');
  });
  it('every clear counts a new generation per app, even two within one second, and taking keeps them', async () => {
    const state = {
      files: { '/l/watch-out': `${S(1)}x\n` },
      procs: { local: [proc('watch', 0)] },
    };
    const h = fakeHosts(state);
    const at = new Date(2026, 9, 12, 15, 4, 5);
    await clearLogs(h.fleet, ['watch'], file, at);
    await takeIncidents(h.fleet, ['watch'], {}, file);
    await clearLogs(h.fleet, ['watch'], file, at);
    expect(readStore(file)).toMatchObject({
      cleared: { 'local/watch': '2026-10-12T15:04:05' },
      clears: {
        'local/watch': 2,
        [countedClearKey('local/watch')]: 2,
        [fileClearKey('local/watch', 'out', '/l/watch-out')]: 2,
        [fileClearKey('local/watch', 'err', '/l/watch-err')]: 2,
      }, // per app, the clears that counted their files, and per file; kept by the take between the clears
    });
  });
  it('a file that could not be truncated keeps its point and is named; the app is not marked cleared', async () => {
    const state: {
      files: Record<string, string>;
      procs: Record<string, object[]>;
      unwritable?: string[];
    } = {
      files: {
        '/l/watch-out': `${S(1)}ok\n`,
        '/l/watch-err': `${S(2)}ERROR: old in err\n`,
      },
      procs: { local: [proc('watch', 0)] },
    };
    const h = fakeHosts(state);
    expect(
      (await takeIncidents(h.fleet, ['watch'], {}, file)).answer.incidents.map(
        (i) => i.line
      )
    ).toEqual([`${S(2)}ERROR: old in err`]);
    state.unwritable = ['/l/watch-err'];
    const r = await clearLogs(h.fleet, ['watch'], file);
    expect(r).toMatchObject([
      { app: 'watch', err_bytes: 0, failed: ['/l/watch-err'] },
    ]); // what stayed is not counted as freed
    expect(readStore(file).cleared).toEqual({});
    expect(readStore(file).clears).toEqual({
      'local/watch': 1,
      [countedClearKey('local/watch')]: 1,
      [fileClearKey('local/watch', 'out', '/l/watch-out')]: 1,
    }); // out was emptied: a screen showing it starts over; err, which was not, is not counted
    state.files['/l/watch-out'] = `${S(30)}ERROR: after the clear\n`;
    expect(
      (await takeIncidents(h.fleet, ['watch'], {}, file)).answer.incidents.map(
        (i) => i.line
      )
    ).toEqual([`${S(30)}ERROR: after the clear`]); // the old err error does not come back
  });
  it("a clear keeps each run's boot state, so the first re-listen after it is a reload; a point without one gets none", async () => {
    const state = {
      now: '2026-10-12T11:01:00',
      zone: '+0000',
      files: { '/l/watch-out': '' },
      procs: {
        local: [
          proc('watch', 0, { pm_uptime: Date.parse('2026-10-12T11:00:00Z') }),
        ],
      },
    };
    const h = fakeHosts(state);
    await clearLogs(h.fleet, ['watch'], file);
    expect(readStore(file).apps['local/watch']).not.toHaveProperty('start');
    expect(readStore(file).apps['local/watch']).not.toHaveProperty('boot');
    state.files['/l/watch-out'] = `${S(2)}listening on :3000\n`;
    const boot = await takeIncidents(
      h.fleet,
      ['watch'],
      { includeReloads: true },
      file
    );
    expect(boot.answer.incidents).toEqual([]);
    await clearLogs(h.fleet, ['watch'], file);
    expect(readStore(file).apps['local/watch']).toMatchObject({
      start: '2026-10-12T11:00:00.000',
      boot: false,
      out: { offset: 0 },
    });
    state.files['/l/watch-out'] = `${S(30)}listening on :3000\n`;
    const r = await takeIncidents(
      h.fleet,
      ['watch'],
      { includeReloads: true },
      file
    );
    expect(r.answer.incidents).toMatchObject([
      { kind: 'reloaded', count: 1, time: '2026-10-12T11:00:30' },
    ]);
  });
  it('a readonly host is refused before any log or the store is touched', async () => {
    const state = {
      files: { '/l/audit-out': `${S(1)}ERROR: keep\n` },
      procs: { ro: [proc('audit', 0)] },
    };
    await expect(
      clearLogs(fakeHosts(state).fleet, ['audit'], file)
    ).rejects.toMatchObject({ code: 'READONLY_HOST' });
    expect(state.files['/l/audit-out']).toBe(`${S(1)}ERROR: keep\n`);
    expect(fs.existsSync(file)).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../src/core/init.js';
import { adoptPorts } from '../../src/core/adopt.js';
import { Fleet, actOn, listFleet } from '../../src/core/fleet.js';
import { loadManifest } from '../../src/core/manifest.js';
import { clearResolutionCache } from '../../src/core/resolve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
/** The bundle under test: dist/cli.js, or another build of this tree (a branch built elsewhere, so dist keeps serving the installed mcproc). */
const cli = process.env.MCPROC_CLI ?? path.join(root, 'dist', 'cli.js');

/** Below the ephemeral range (32768+), which adoption reports instead of writing. */
const PORT = 28412;
/** The port comes from a JSON file: neither the command, .env, a framework default nor a source constant gives it away. */
const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(require('./port.json').port, () => console.log('up'));`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stops the daemon of a PM2_HOME with the bundled pm2, for a setup that failed before a fleet existed. */
function killDaemon(home: string) {
  if (!fs.existsSync(path.join(home, 'pm2.pid'))) return;
  const pm2 = createRequire(import.meta.url).resolve('pm2/bin/pm2');
  execFileSync(process.execPath, [pm2, 'kill'], {
    env: { ...process.env, PM2_HOME: home },
    stdio: 'ignore',
  });
}

describe.skipIf(process.env.MCPROC_IT !== '1')(
  'init on a turbo repo and port adoption on real pm2',
  () => {
    let base: string | undefined;
    let home: string | undefined;
    let dir = '';
    let file = '';
    let fleet: Fleet | undefined;
    /** the manifest after the hand edits, before any adoption */
    let handEdited = '';
    /** the manifest as adoptPorts wrote it */
    let adoptedText = '';
    const children: ChildProcess[] = [];
    const write = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    beforeAll(() => {
      base = fs.mkdtempSync('/tmp/mcproc-im-'); // short: unix socket paths are capped at 108 bytes
      home = path.join(base, 'home');
      dir = path.join(base, 'p');
      file = path.join(dir, '.mcproc', 'mcproc.yaml');
      // no lockfile: the draft runs `npm run`
      write(
        'turbo.json',
        JSON.stringify({
          tasks: { dev: { persistent: true, cache: false }, build: {} },
        })
      );
      write(
        'package.json',
        JSON.stringify({
          name: 'im',
          private: true,
          workspaces: ['apps/*'],
          scripts: { dev: 'turbo run dev' },
        })
      );
      write(
        'apps/a/package.json',
        JSON.stringify({ name: 'a', scripts: { dev: 'node server.js' } })
      );
      write('apps/a/port.json', JSON.stringify({ port: PORT }));
      write('apps/a/server.js', SERVER);
    });
    afterAll(async () => {
      for (const c of children)
        if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      try {
        if (fleet) {
          await actOn(fleet, 'all', 'delete').catch(() => {}); // best effort: the kill below ends the apps too
          await (await fleet.ctx('local')).pm2.run(['kill']);
        } else if (home) killDaemon(home); // setup failed before a fleet existed: the daemon may still be there
      } catch {
        try {
          if (home) killDaemon(home);
        } catch {
          /* daemon already gone */
        }
      }
      if (base) fs.rmSync(base, { recursive: true, force: true });
    }, 30_000);

    it('init drafts the package of the dev task live in the dev profile, without a port it cannot guess', () => {
      const res = initProject(dir);
      expect(res.live).toEqual(['a']);
      expect(res.profiles).toEqual(['dev']);
      expect(res.libs).toEqual([]);
      const draft = fs.readFileSync(file, 'utf8');
      expect(draft).toContain(
        '\n  a:    # source: apps/a/package.json:dev; kind? server\n'
      );
      expect(draft).toMatch(/^ {2}dev: \[a\]$/m);
      expect(draft).not.toMatch(/^[\s#]*port:/m);
      expect(draft).not.toContain('port?');
    });

    it('the hand-edited draft loads, with no port declared for a', () => {
      const draft = fs.readFileSync(file, 'utf8');
      // the draft ends with the commented host examples under hosts:
      expect(
        draft.endsWith(
          '# prod: { ssh: prod-alias, cwd: /srv/project, readonly: true }\n'
        )
      ).toBe(true);
      handEdited = `${draft.replace('\nversion: 1\n', '\nversion: 1\n# hand note\n')}  local:\n    pm2_home: ${home}\n`;
      expect(handEdited).toContain('\nversion: 1\n# hand note\n');
      fs.writeFileSync(file, handEdited);
      const m = loadManifest(dir);
      expect(m.apps.a.ports).toEqual([]);
      expect(m.hosts.local.pm2_home).toBe(home);
    });

    it('start dev brings a online, and ls finds its port undeclared', async () => {
      clearResolutionCache();
      const f = new Fleet(loadManifest(dir), undefined);
      fleet = f;
      const rows = await actOn(f, 'dev', 'start');
      expect(rows.find((r) => r.app === 'a')?.status).toBe('online');
      // online comes before the server listens: poll ls until the port shows up
      const undeclared = async () =>
        (await listFleet(f, ['a'])).rows[0].ports.undeclared;
      let seen = await undeclared();
      const t0 = Date.now();
      while (!seen.includes(PORT) && Date.now() - t0 < 15_000) {
        await sleep(500);
        seen = await undeclared();
      }
      expect(seen).toContain(PORT);
    }, 30_000);

    it('adoptPorts writes the port under the last field of a, every other byte kept', async () => {
      const r = await adoptPorts(fleet!);
      expect(r.written).toBe(true);
      expect(r.adopted).toEqual([{ app: 'a', host: 'local', ports: [PORT] }]);
      expect(r.skipped).toEqual([]);
      expect(r.errors).toEqual([]);
      expect(r.diff).toContain(`+    port: ${PORT}`);
      adoptedText = fs.readFileSync(file, 'utf8');
      expect(adoptedText).toContain('\n# hand note\n');
      expect(adoptedText).toContain(
        '\n  a:    # source: apps/a/package.json:dev; kind? server\n'
      );
      // a's last drafted field is its cwd; the new line is the only change to the file
      expect(adoptedText).toBe(
        handEdited.replace(
          '\n    cwd: apps/a\n',
          `\n    cwd: apps/a\n    port: ${PORT}\n`
        )
      );
      expect(loadManifest(dir).apps.a.ports).toEqual([PORT]);
    });

    it('a second adoption finds nothing and writes nothing', async () => {
      const r = await adoptPorts(new Fleet(loadManifest(dir), undefined));
      expect(r).toEqual({
        path: file,
        written: false,
        adopted: [],
        skipped: [],
        errors: [],
        diff: [],
      });
      expect(fs.readFileSync(file, 'utf8')).toBe(adoptedText);
    });

    it('CLI init --adopt-ports writes the port back and prints the diff', async () => {
      fs.writeFileSync(file, handEdited); // the adopted line deleted again
      const child = spawn(
        process.execPath,
        [cli, 'init', '--adopt-ports', '--project', dir],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      children.push(child);
      let out = '';
      let err = '';
      child.stdout!.on('data', (d) => {
        out += String(d);
      });
      child.stderr!.on('data', (d) => {
        err += String(d);
      });
      // 'close', not 'exit': stdio may still deliver data after the process exited
      const code = await Promise.race([
        new Promise<number | null>((resolve) =>
          child.on('close', (c) => resolve(c))
        ),
        sleep(20_000).then(() => 'hung'),
      ]);
      expect(code, `stdout:\n${out}\nstderr:\n${err}`).toBe(0);
      expect(err).toBe('');
      expect(out).toContain(`a: adopted ${PORT}`);
      expect(out).toContain(`+    port: ${PORT}`);
      expect(fs.readFileSync(file, 'utf8')).toBe(adoptedText);
    }, 30_000);
  }
);

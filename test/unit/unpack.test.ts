import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from '../../src/core/resolve.js';
import { McprocError } from '../../src/core/errors.js';
import { unpack, type UnpackDeps } from '../../src/runtime/unpack.js';
import { FakeTransport } from '../helpers/fake-transport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');
const bundle = {
  version: '7.0.4',
  sha256: 'b'.repeat(64),
  data: Buffer.from('PM2-TGZ'),
  path: '/tmp/pm2.tgz',
};
const nodeData = Buffer.from('NODE-TGZ');
const RT = '/srv/demo/.mcproc/runtime';

function deps(over: Partial<UnpackDeps> = {}) {
  const nodeCalls: string[] = [];
  const d: UnpackDeps = {
    pm2Bundle: async () => bundle,
    nodeVersion: async (req) =>
      req ? `v${req.replace(/^v/, '')}` : 'v24.21.0',
    nodeTarball: async (v, p) => {
      nodeCalls.push(`${v} ${p}`);
      return { data: nodeData, sha256: 'n'.repeat(64) };
    },
    hostname: () => 'agent-box',
    now: () => new Date('2026-10-11T12:00:00Z'),
    ...over,
  };
  return { d, nodeCalls };
}
/** A probe answer; a lock is what mcproc writes (its own fields always there), with the given fields on top. */
const probe = (lines: string[], lock?: object) =>
  `motd\n__MCPROC_UNPACK__\n${lines.join('\n')}\n__MCPROC_LOCK__\n${lock ? JSON.stringify({ mcproc: '0.3.0', pm2_sha256: 'x', ...lock }) : ''}`;
const glibc22 = [
  'Linux x86_64',
  'NODE v22.11.0',
  'TAR_OK',
  'CXX_OK',
  'MANIFEST_NONE',
];
const alpine = [
  'Linux x86_64',
  'MUSL',
  'NODE_NONE',
  'TAR_OK',
  'CXX_OK',
  'MANIFEST_NONE',
]; // alpine with `apk add libstdc++`, which the nodejs.org musl build is linked against

function target(hostName: string, probeOut: string, verified = '7.0.4') {
  const prep = prepare({ project: basic, host: hostName });
  const fake = new FakeTransport(
    [
      { match: '__MCPROC_UNPACK__', result: { stdout: probeOut } },
      {
        match: "-p 'require(process.argv[1]).version'",
        result: { stdout: `${verified}\n` },
      },
      { match: /tar -xzf|cat >|\[ -e |\bmv |rm -rf|for d in/, result: {} }, // extraction, writes, tree swaps, cleanup, heal
    ],
    hostName
  );
  return {
    t: { manifest: prep.manifest, host: prep.host, transport: fake },
    fake,
  };
}
const cmds = (f: FakeTransport) => f.calls.map((c) => c.cmd);
const call = (f: FakeTransport, needle: string) =>
  f.calls.find((c) => c.cmd.includes(needle));

describe('unpack', () => {
  it('fresh glibc host with Node 22: pm2 only, wrapper, lock, manifest copy, verify last', async () => {
    const { t, fake } = target('stand', probe(glibc22));
    const { d, nodeCalls } = deps();
    const r = await unpack(t, {}, d);
    expect(r).toMatchObject({
      host: 'stand',
      runtime_dir: RT,
      noop: false,
      pm2: { version: '7.0.4', written: true },
      node: null,
      manifest_copy: 'written',
      runtime_line: null,
      update_hint: null,
    });
    expect(r.monit).toBe(`'${RT}/bin/pm2' monit`);
    expect(cmds(fake)[0]).toContain('__MCPROC_UNPACK__');
    expect(
      call(fake, `tar -xzf - -C '${RT}/pm2/7.0.4.part'`)!.opts.stdin
    ).toEqual(bundle.data);
    expect(cmds(fake).some((c) => c.includes('--strip-components'))).toBe(
      false
    );
    expect(nodeCalls).toEqual([]);
    expect(
      String(call(fake, `cat > '${RT}/bin/pm2.next'`)!.opts.stdin)
    ).toContain('exec "$NODE" "$RT/pm2/7.0.4/node_modules/pm2/bin/pm2" "$@"');
    const lock = JSON.parse(
      String(call(fake, `cat > '${RT}/lock.json.next'`)!.opts.stdin)
    );
    expect(lock).toMatchObject({
      pm2: '7.0.4',
      pm2_sha256: bundle.sha256,
      node: null,
      by: 'agent-box',
      written_at: '2026-10-11T12:00:00.000Z',
    });
    const copy = String(
      call(fake, "cat > '/srv/demo/.mcproc/mcproc.yaml'")!.opts.stdin
    );
    expect(copy).toMatch(
      /^# copied by mcproc unpack from agent-box on 2026-10-11T12:00:00.000Z/
    );
    expect(copy).toContain('project: demo');
    expect(cmds(fake).at(-1)).toContain(
      "-p 'require(process.argv[1]).version'"
    );
    expect(cmds(fake).some((c) => /pm2' -v/.test(c))).toBe(false);
  });

  it('nothing in use changes before the new runtime answers; every switch (trees, wrapper, node link, lock) is a rename', async () => {
    const { t, fake } = target('stand', probe(alpine));
    await unpack(t, {}, deps().d);
    const c = cmds(fake);
    const staged = c.findIndex((x) =>
      x.includes("-p 'require(process.argv[1]).version'")
    );
    const wrapper = c.findIndex((x) => x.includes('bin/pm2.next'));
    expect(staged).toBeGreaterThan(0);
    expect(staged).toBeLessThan(wrapper); // checked before the switch
    expect(c[staged]).toContain(`NODE='${RT}/node/v24.21.0.part/bin/node'`); // the staged copies, with the Node they will run under
    expect(c[staged]).toContain(
      `'${RT}/pm2/7.0.4.part'/node_modules/pm2/package.json`
    );
    const promote = c.findIndex((x) =>
      x.includes(`mv '${RT}/pm2/7.0.4.part' '${RT}/pm2/7.0.4'`)
    );
    expect(promote).toBeGreaterThan(staged); // a tree takes its place only after the check
    expect(c[wrapper]).toContain(`mv -f '${RT}/bin/pm2.next' '${RT}/bin/pm2'`);
    expect(c[wrapper].indexOf(`mv -f '${RT}/bin/pm2.next'`)).toBeLessThan(
      c[wrapper].indexOf('ln -sfn')
    ); // the wrapper (mcproc's mark) before the node link
    expect(c.find((x) => x.includes('lock.json.next'))).toContain(
      `mv -f '${RT}/lock.json.next' '${RT}/lock.json'`
    );
  });
  it('a forced reinstall of the version in use is checked from its staged copy; the tree in use is swapped only then, and kept until the switch is done', async () => {
    const { t, fake } = target(
      'stand',
      probe(glibc22, { pm2: '7.0.4', node: null })
    );
    await unpack(t, { force: true }, deps().d);
    const c = cmds(fake);
    const staged = c.findIndex((x) =>
      x.includes("-p 'require(process.argv[1]).version'")
    );
    expect(c[staged]).toContain(`'${RT}/pm2/7.0.4.part'`);
    const swap = c.findIndex((x) =>
      x.includes(`mv '${RT}/pm2/7.0.4' '${RT}/pm2/7.0.4.old'`)
    );
    expect(swap).toBeGreaterThan(staged);
    expect(
      c.findIndex(
        (x) => x.includes(`rm -rf '${RT}/pm2/7.0.4.old'`) && !x.includes('mv ')
      )
    ).toBeGreaterThan(c.findIndex((x) => x.includes('lock.json.next')));
  });
  it('a tree swap cut off between its two renames is healed by the next unpack, before anything else', async () => {
    const { t, fake } = target(
      'stand',
      probe(glibc22, { pm2: '7.0.4', node: null })
    );
    await unpack(t, {}, deps().d);
    const heal = cmds(fake)[1];
    expect(heal).toContain(`for d in '${RT}'/pm2/*.old '${RT}'/node/*.old; do`);
    expect(heal).toContain('[ -e "$t" ] || mv "$d" "$t"');
  });
  it('a new runtime that does not answer leaves the one in use as it was', async () => {
    const { t, fake } = target('stand', probe(glibc22), '0.0.0');
    await expect(unpack(t, {}, deps().d)).rejects.toMatchObject({
      code: 'PM2_FAILED',
      message: expect.stringContaining('left as it was'),
    });
    expect(
      cmds(fake)
        .slice(1)
        .some(
          (x) =>
            x.includes('bin/pm2.next') ||
            x.includes('lock.json') ||
            x.includes('ln -sfn') ||
            x.includes(`mv '${RT}/pm2/7.0.4.part'`)
        )
    ).toBe(false); // after the probe: no tree swapped, no switch, no lock
  });
  it('same versions already there: no extraction, no wrapper rewrite (noop), the copy is refreshed', async () => {
    const { t, fake } = target(
      'stand',
      probe(
        [
          'Linux x86_64',
          'NODE v22.11.0',
          'TAR_OK',
          'MANIFEST # copied by mcproc unpack from x on y',
        ],
        { pm2: '7.0.4', node: null }
      )
    );
    const r = await unpack(t, {}, deps().d);
    expect(r).toMatchObject({
      noop: true,
      pm2: { written: false },
      manifest_copy: 'written',
    });
    expect(cmds(fake).filter((c) => c.includes('tar -xzf'))).toEqual([]);
    expect(call(fake, `cat > '${RT}/bin/pm2.next'`)).toBeUndefined();
  });

  it('alpine (musl, no node): brings linux-x64-musl Node, strips its top dir, links bin/node', async () => {
    const { t, fake } = target('stand', probe(alpine));
    const { d, nodeCalls } = deps();
    const r = await unpack(t, {}, d);
    expect(nodeCalls).toEqual(['v24.21.0 linux-x64-musl']);
    expect(r.node).toEqual({
      version: 'v24.21.0',
      platform: 'linux-x64-musl',
      written: true,
    });
    expect(
      call(
        fake,
        `tar -xzf - -C '${RT}/node/v24.21.0.part' --strip-components=1`
      )!.opts.stdin
    ).toEqual(nodeData);
    expect(call(fake, 'ln -sfn')!.cmd).toContain(
      `ln -sfn '${RT}/node/v24.21.0/bin/node' '${RT}/bin/node.next' && mv -f '${RT}/bin/node.next' '${RT}/bin/node'`
    );
    expect(
      JSON.parse(String(call(fake, `cat > '${RT}/lock.json.next'`)!.opts.stdin))
    ).toMatchObject({ node: 'v24.21.0', platform: 'linux-x64-musl' });
  });

  it('refusals before any write: never without node, no tar, relative or ~ dir, download failure', async () => {
    let x = target('stand', probe(alpine));
    await expect(
      unpack(x.t, { withNode: 'never' }, deps().d)
    ).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
    expect(x.fake.calls).toHaveLength(1);
    x = target(
      'stand',
      probe(['Linux x86_64', 'NODE v22.11.0', 'TAR_NONE', 'MANIFEST_NONE'])
    );
    await expect(unpack(x.t, {}, deps().d)).rejects.toMatchObject({
      code: 'TAR_NOT_FOUND',
    });
    expect(x.fake.calls).toHaveLength(1);
    for (const dir of ['rt', '~/rt']) {
      x = target('stand', probe(glibc22));
      await expect(unpack(x.t, { dir }, deps().d)).rejects.toMatchObject({
        code: 'BAD_ARGUMENT',
      });
      expect(x.fake.calls).toHaveLength(0);
    }
    x = target('stand', probe(alpine));
    const offline = deps({
      nodeTarball: async () => {
        throw new McprocError('DOWNLOAD_FAILED', 'offline');
      },
    }).d;
    await expect(unpack(x.t, {}, offline)).rejects.toMatchObject({
      code: 'DOWNLOAD_FAILED',
    });
    expect(x.fake.calls).toHaveLength(1);
    x = target(
      'stand',
      probe([
        'Linux x86_64',
        'MUSL',
        'NODE_NONE',
        'TAR_OK',
        'CXX_NONE',
        'MANIFEST_NONE',
      ])
    ); // bare alpine: no libstdc++, so the Node build could not even start
    const bare = deps();
    await expect(unpack(x.t, {}, bare.d)).rejects.toMatchObject({
      code: 'NODE_NOT_FOUND',
      message: expect.stringContaining('libstdc++'),
    });
    expect(bare.nodeCalls).toEqual([]); // refused before the 60 MB download, not after
    expect(x.fake.calls).toHaveLength(1);
  });

  it('refuses to overwrite a bin/pm2 or bin/node it did not write (a dir such as /usr/local) unless force', async () => {
    const foreign = [...glibc22, 'BIN_PRESENT'];
    let x = target('stand', probe(foreign));
    await expect(
      unpack(x.t, { dir: '/usr/local' }, deps().d)
    ).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
      message: expect.stringContaining('/usr/local/bin'),
    });
    expect(x.fake.calls).toHaveLength(1);
    x = target('stand', probe(foreign));
    expect(
      (await unpack(x.t, { dir: '/usr/local', force: true }, deps().d)).pm2
        .written
    ).toBe(true);
  });

  it('keeps the locked Node unless a version is requested; a Node-only change under a live daemon prints the update hint', async () => {
    const locked = {
      pm2: '7.0.4',
      node: 'v24.21.0',
      node_sha256: 'n',
      platform: 'linux-x64-musl',
    };
    let x = target('stand', probe(alpine, locked));
    let d = deps();
    const r = await unpack(x.t, {}, d.d);
    expect(r).toMatchObject({
      noop: true,
      node: { version: 'v24.21.0', written: false },
    });
    expect(d.nodeCalls).toEqual([]); // no download: the newest LTS is not re-resolved behind the user's back
    x = target('stand', probe([...alpine, 'DAEMON_UP'], locked));
    d = deps();
    const up = await unpack(x.t, { nodeVersion: '24.22.0' }, d.d);
    expect(up).toMatchObject({
      noop: false,
      pm2: { written: false },
      node: { version: 'v24.22.0', written: true },
    });
    expect(d.nodeCalls).toEqual(['v24.22.0 linux-x64-musl']);
    expect(up.update_hint).toContain('update'); // the daemon still runs the old runtime
  });

  it('keeps a hand-written remote manifest unless force', async () => {
    const hand = probe([
      'Linux x86_64',
      'NODE v22.11.0',
      'TAR_OK',
      'MANIFEST version: 1',
    ]);
    let x = target('stand', hand);
    expect((await unpack(x.t, {}, deps().d)).manifest_copy).toBe(
      'kept-hand-written'
    );
    expect(
      call(x.fake, "cat > '/srv/demo/.mcproc/mcproc.yaml'")
    ).toBeUndefined();
    x = target('stand', hand);
    expect((await unpack(x.t, { force: true }, deps().d)).manifest_copy).toBe(
      'written'
    );
  });

  it('new pm2 over a running daemon: side by side, prints the update command, never runs it', async () => {
    const { t, fake } = target(
      'stand',
      probe(
        [
          'Linux x86_64',
          'NODE v22.11.0',
          'TAR_OK',
          'DAEMON_UP',
          'MANIFEST_NONE',
        ],
        { pm2: '7.0.3', node: null }
      )
    );
    const r = await unpack(t, {}, deps().d);
    expect(r.update_hint).toContain('7.0.3');
    expect(r.update_hint).toContain(`'${RT}/bin/pm2' update`);
    expect(cmds(fake).some((c) => / update$/.test(c))).toBe(false);
  });

  it('verify mismatch → PM2_FAILED; a shell that never ran the probe → TRANSPORT_FAILED', async () => {
    const x = target('stand', probe(glibc22), '6.0.0');
    await expect(unpack(x.t, {}, deps().d)).rejects.toMatchObject({
      code: 'PM2_FAILED',
    });
    const prep = prepare({ project: basic, host: 'stand' });
    const fake = new FakeTransport([
      {
        match: '__MCPROC_UNPACK__',
        result: {
          code: 127,
          stdout: '',
          stderr: 'sh: 1: /bin/bash: not found',
        },
      },
    ]);
    await expect(
      unpack(
        { manifest: prep.manifest, host: prep.host, transport: fake },
        {},
        deps().d
      )
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILED' });
  });

  it('local host: no manifest copy; a non-default dir yields the hosts.<h>.runtime line', async () => {
    const { t, fake } = target('local', probe(glibc22));
    const r = await unpack(t, { dir: '/opt/mcproc/runtime' }, deps().d);
    expect(r).toMatchObject({
      manifest_copy: 'not-needed-local',
      runtime_dir: '/opt/mcproc/runtime',
      runtime_line: 'hosts.local.runtime: /opt/mcproc/runtime',
    });
    expect(
      cmds(fake).some((c) => c.includes('mcproc.yaml') && c.includes('cat >'))
    ).toBe(false);
  });
});

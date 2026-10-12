import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COPY_HEADER,
  renderWrapper,
  renderLock,
  manifestCopy,
  verifyScript,
  type RuntimeLock,
} from '../../src/runtime/files.js';
import {
  unpackProbeScript,
  parseUnpackProbe,
  UNPACK_MARK,
  LOCK_MARK,
} from '../../src/runtime/probe.js';
import { needsNode, plannedWrites } from '../../src/runtime/decide.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-rt-'));
const out = (lines: string[], lock = '') =>
  `profile noise\n${UNPACK_MARK}\n${lines.join('\n')}\n${LOCK_MARK}\n${lock}`;
const lock7 = (over: Partial<RuntimeLock> = {}): RuntimeLock => ({
  mcproc: '0.1.0',
  pm2: '7.0.4',
  pm2_sha256: 'a',
  node: null,
  node_sha256: null,
  platform: null,
  written_at: 't',
  by: 'h',
  ...over,
});

describe('probe', () => {
  it('runs under plain /bin/sh on this host and parses into facts', () => {
    const rt = tmp();
    const proj = tmp();
    fs.writeFileSync(path.join(rt, 'lock.json'), renderLock(lock7()));
    fs.mkdirSync(path.join(proj, '.mcproc'));
    fs.writeFileSync(
      path.join(proj, '.mcproc', 'mcproc.yaml'),
      manifestCopy('version: 1\n', 'box', new Date(0))
    );
    const stdout = execFileSync(
      '/bin/sh',
      ['-c', unpackProbeScript(rt, path.join(proj, '.mcproc', 'mcproc.yaml'))],
      { encoding: 'utf8' }
    );
    const f = parseUnpackProbe(stdout);
    expect(f.unameSm).toMatch(/^Linux /);
    expect(f.tar).toBe(true);
    expect(f.cxx).toBe(true); // this glibc host has libstdc++, which every nodejs.org build needs
    expect(f.manifest).toBe('mcproc-copy');
    expect(f.lock).toMatchObject({ pm2: '7.0.4' });
    expect(f.foreignBin).toBe(false); // the lock says bin/ is ours
    const foreign = tmp(); // a directory with a bin/pm2 that mcproc did not write (no lock.json): e.g. --dir /usr/local
    fs.mkdirSync(path.join(foreign, 'bin'));
    fs.writeFileSync(path.join(foreign, 'bin', 'pm2'), '#!/bin/sh\n');
    expect(
      parseUnpackProbe(
        execFileSync(
          '/bin/sh',
          ['-c', unpackProbeScript(foreign, '/nowhere')],
          { encoding: 'utf8' }
        )
      ).foreignBin
    ).toBe(true);
  });
  it('a wrapper mcproc wrote is its own even without a lock (an unpack cut off before writing it)', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'pm2'), renderWrapper(dir, '7.0.4'));
    expect(
      parseUnpackProbe(
        execFileSync('/bin/sh', ['-c', unpackProbeScript(dir, '/nowhere')], {
          encoding: 'utf8',
        })
      ).foreignBin
    ).toBe(false);
  });
  it("a bin/node link without mcproc's wrapper or lock is foreign, wherever it points (no path text can vouch for it)", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.mkdirSync(path.join(dir, 'node', 'v24.1.0', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'node', 'v24.1.0', 'bin', 'node'),
      '#!/bin/sh\n',
      { mode: 0o755 }
    );
    for (const target of [
      path.join(dir, 'node', 'v24.1.0', 'bin', 'node'),
      `${dir}/node/../../bin/sh`,
    ]) {
      fs.rmSync(path.join(dir, 'bin', 'node'), { force: true });
      fs.symlinkSync(target, path.join(dir, 'bin', 'node'));
      expect(
        parseUnpackProbe(
          execFileSync('/bin/sh', ['-c', unpackProbeScript(dir, '/nowhere')], {
            encoding: 'utf8',
          })
        ).foreignBin,
        target
      ).toBe(true);
    }
  });
  it("a lock.json that is not mcproc's (empty, broken, someone else's) does not make a foreign bin/ ours", () => {
    for (const junk of ['{}', '{broken', '{"version": 3}', '']) {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'pm2'), '#!/bin/sh\n');
      fs.writeFileSync(path.join(dir, 'lock.json'), junk);
      const f = parseUnpackProbe(
        execFileSync('/bin/sh', ['-c', unpackProbeScript(dir, '/nowhere')], {
          encoding: 'utf8',
        })
      );
      expect(f.foreignBin, JSON.stringify(junk)).toBe(true);
      expect(f.lock).toBeNull();
    }
  });
  it('parses an alpine host: musl, no node, no daemon, no manifest, no lock', () => {
    expect(
      parseUnpackProbe(
        out([
          'Linux x86_64',
          'MUSL',
          'NODE_NONE',
          'TAR_OK',
          'CXX_NONE',
          'MANIFEST_NONE',
        ])
      )
    ).toEqual({
      unameSm: 'Linux x86_64',
      musl: true,
      node: null,
      tar: true,
      cxx: false,
      foreignBin: false,
      daemonUp: false,
      manifest: 'absent',
      lock: null,
    });
  });
  it('parses node, daemon socket, a foreign bin, a hand-written manifest and ignores a broken lock', () => {
    const f = parseUnpackProbe(
      out(
        [
          'Linux x86_64',
          'NODE v22.11.0',
          'TAR_NONE',
          'CXX_OK',
          'BIN_PRESENT',
          'DAEMON_UP',
          'MANIFEST version: 1',
        ],
        '{broken'
      )
    );
    expect(f).toMatchObject({
      node: 'v22.11.0',
      tar: false,
      cxx: true,
      foreignBin: true,
      daemonUp: true,
      manifest: 'hand-written',
      lock: null,
    });
  });
});

describe('decisions', () => {
  const glibc = (node: string | null, cxx = 'CXX_OK') =>
    parseUnpackProbe(
      out([
        'Linux x86_64',
        node ? `NODE ${node}` : 'NODE_NONE',
        'TAR_OK',
        cxx,
        'MANIFEST_NONE',
      ])
    );
  it('needsNode: auto brings Node only when the host has none >= 18', () => {
    expect(needsNode(glibc('v22.11.0'), {})).toEqual({
      need: false,
      platform: null,
    });
    expect(needsNode(glibc('v16.20.0'), {})).toEqual({
      need: true,
      platform: 'linux-x64',
    });
    expect(needsNode(glibc('v22.11.0'), { withNode: 'always' })).toEqual({
      need: true,
      platform: 'linux-x64',
    });
    expect(() => needsNode(glibc(null), { withNode: 'never' })).toThrowError(
      /with_node is never/
    );
    const armMusl = parseUnpackProbe(
      out([
        'Linux aarch64',
        'MUSL',
        'NODE_NONE',
        'TAR_OK',
        'CXX_OK',
        'MANIFEST_NONE',
      ])
    );
    try {
      needsNode(armMusl, {});
    } catch (e: any) {
      expect(e.code).toBe('NODE_NOT_FOUND');
      return;
    }
    throw new Error('expected NODE_NOT_FOUND');
  });
  it('needsNode: an explicit node_version, or a Node the runtime already carries, is honoured even when the host has its own', () => {
    expect(needsNode(glibc('v22.11.0'), { nodeVersion: '24.1.0' })).toEqual({
      need: true,
      platform: 'linux-x64',
    });
    const carried = {
      ...glibc('v22.11.0'),
      lock: {
        mcproc: '0.3.0',
        pm2: '7.0.4',
        pm2_sha256: 'x',
        node: '24.1.0',
        node_sha256: 'y',
        platform: 'linux-x64' as const,
        written_at: '',
        by: '',
      },
    };
    expect(needsNode(carried, {})).toEqual({
      need: true,
      platform: 'linux-x64',
    }); // the wrapper runs that Node: it stays managed
    expect(() =>
      needsNode(glibc('v22.11.0'), { withNode: 'never', nodeVersion: '24.1.0' })
    ).toThrowError(expect.objectContaining({ code: 'BAD_ARGUMENT' }));
    expect(() =>
      needsNode(glibc(null), { nodeVersion: '16.20.2' })
    ).toThrowError(
      expect.objectContaining({
        code: 'BAD_ARGUMENT',
        message: expect.stringContaining('18'),
      })
    );
  });
  it('needsNode refuses to bring Node to a host without the C++ runtime it is linked against, naming the package', () => {
    expect(needsNode(glibc('v22.11.0', 'CXX_NONE'), {})).toEqual({
      need: false,
      platform: null,
    }); // the host's own Node is used: nothing to check
    const bareAlpine = parseUnpackProbe(
      out([
        'Linux x86_64',
        'MUSL',
        'NODE_NONE',
        'TAR_OK',
        'CXX_NONE',
        'MANIFEST_NONE',
      ])
    );
    expect(() => needsNode(bareAlpine, {})).toThrowError(/libstdc\+\+/);
    try {
      needsNode(bareAlpine, {});
    } catch (e: any) {
      expect(e.code).toBe('NODE_NOT_FOUND');
      expect(e.hint).toMatch(/apk add libstdc\+\+/);
    }
    try {
      needsNode(glibc(null, 'CXX_NONE'), {});
    } catch (e: any) {
      expect(e.code).toBe('NODE_NOT_FOUND');
      expect(e.hint).toMatch(/libstdc\+\+6/);
      return;
    }
    throw new Error('expected NODE_NOT_FOUND');
  });
  it('needsNode: macOS has no libstdc++ (the darwin builds link the system libc++), so the check is Linux-only', () => {
    const mac = parseUnpackProbe(
      out(['Darwin arm64', 'NODE_NONE', 'TAR_OK', 'CXX_NONE', 'MANIFEST_NONE'])
    );
    expect(needsNode(mac, {})).toEqual({
      need: true,
      platform: 'darwin-arm64',
    });
  });
  it('plannedWrites: lock equality means nothing to do; force rewrites', () => {
    const none = glibc('v22.11.0');
    expect(plannedWrites(none, {}, '7.0.4', null)).toEqual({
      writePm2: true,
      writeNode: false,
    });
    const same = { ...none, lock: lock7({ node: 'v24.21.0' }) };
    expect(plannedWrites(same, {}, '7.0.4', 'v24.21.0')).toEqual({
      writePm2: false,
      writeNode: false,
    });
    expect(plannedWrites(same, {}, '7.0.5', 'v24.21.0')).toEqual({
      writePm2: true,
      writeNode: false,
    });
    expect(plannedWrites(same, {}, '7.0.4', 'v24.22.0')).toEqual({
      writePm2: false,
      writeNode: true,
    });
    expect(plannedWrites(same, { force: true }, '7.0.4', 'v24.21.0')).toEqual({
      writePm2: true,
      writeNode: true,
    });
  });
});

describe('files', () => {
  it('wrapper prefers the bundled node and execs the unpacked pm2', () => {
    const rt = tmp();
    const pm2 = path.join(rt, 'pm2', '7.0.4', 'node_modules', 'pm2', 'bin');
    fs.mkdirSync(pm2, { recursive: true });
    fs.writeFileSync(
      path.join(pm2, 'pm2'),
      "console.log('pm2 got', process.argv.slice(2).join(' '))\n"
    );
    fs.mkdirSync(path.join(rt, 'bin'));
    fs.writeFileSync(path.join(rt, 'bin', 'pm2'), renderWrapper(rt, '7.0.4'), {
      mode: 0o755,
    });
    execFileSync('/bin/sh', ['-n', path.join(rt, 'bin', 'pm2')]);
    expect(
      execFileSync(path.join(rt, 'bin', 'pm2'), ['jlist', 'x y'], {
        encoding: 'utf8',
      })
    ).toBe('pm2 got jlist x y\n');
    fs.writeFileSync(
      path.join(rt, 'bin', 'node'),
      '#!/bin/sh\necho "bundled node $1"\n',
      { mode: 0o755 }
    );
    expect(
      execFileSync(path.join(rt, 'bin', 'pm2'), ['-v'], { encoding: 'utf8' })
    ).toContain('bundled node ');
    expect(() => renderWrapper(rt, '7.0.4; rm -rf /')).toThrowError(/version/);
  });
  it('verifyScript reads the unpacked pm2 version without starting pm2', () => {
    const rt = tmp();
    const pkg = path.join(rt, 'pm2', '7.0.4', 'node_modules', 'pm2');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ version: '7.0.4' })
    );
    fs.mkdirSync(path.join(rt, 'bin'));
    fs.writeFileSync(path.join(rt, 'bin', 'pm2'), renderWrapper(rt, '7.0.4'), {
      mode: 0o755,
    });
    expect(
      execFileSync('/bin/sh', ['-c', verifyScript(rt, '7.0.4')], {
        encoding: 'utf8',
      }).trim()
    ).toBe('7.0.4');
  });
  it('lock and manifest copy', () => {
    expect(JSON.parse(renderLock(lock7()))).toEqual(lock7());
    const c = manifestCopy(
      'version: 1\n',
      'agent-box',
      new Date('2026-10-11T12:00:00Z')
    );
    expect(
      c.startsWith(`${COPY_HEADER} from agent-box on 2026-10-11T12:00:00.000Z`)
    ).toBe(true);
    expect(c.endsWith('version: 1\n')).toBe(true);
  });
});

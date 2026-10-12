import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installShortcut, LAUNCHER_MARK } from '../../src/cli/install.js';

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-home-'));
  const cli = path.join(home, 'pkg', 'dist', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "console.log('cli', process.argv.slice(2).join(' '))\n");
  return { home, cli, bin: path.join(home, '.local', 'bin') };
}

describe('mcproc install', () => {
  it('writes an executable launcher that execs node on the real cli, and adds the bin dir to the zsh rc once', () => {
    const { home, cli, bin } = sandbox();
    const r = installShortcut({ home, shell: '/usr/bin/zsh', pathEnv: '/usr/bin:/bin', cliPath: cli });
    expect(r).toMatchObject({ launcher: path.join(bin, 'mcproc'), written: true, onPath: false, rcFile: path.join(home, '.zshrc'), rcUpdated: true });
    expect(fs.statSync(r.launcher).mode & 0o111).toBe(0o111);
    expect(fs.readFileSync(r.launcher, 'utf8')).toContain(LAUNCHER_MARK);
    expect(execFileSync(r.launcher, ['--version'], { encoding: 'utf8' })).toBe('cli --version\n');
    const rc = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    expect(rc).toContain('export PATH="$HOME/.local/bin:$PATH"');
    expect(r.next.join('\n')).toMatch(/new shell/);
    expect(r.next.join('\n')).toContain('claude mcp add -s user mcproc -- mcproc mcp');
    const again = installShortcut({ home, shell: '/usr/bin/zsh', pathEnv: '/usr/bin:/bin', cliPath: cli });
    expect(again.rcUpdated).toBe(false);
    expect(fs.readFileSync(path.join(home, '.zshrc'), 'utf8').split('mcproc install').length).toBe(2); // one marker, not two
  });
  it('leaves the rc alone when the bin dir is already on PATH; bash gets .bashrc; a custom --bin-dir is honoured', () => {
    const { home, cli, bin } = sandbox();
    const r = installShortcut({ home, shell: '/bin/bash', pathEnv: `/usr/bin:${bin}`, cliPath: cli });
    expect(r).toMatchObject({ onPath: true, rcFile: null, rcUpdated: false });
    expect(fs.existsSync(path.join(home, '.bashrc'))).toBe(false);
    const custom = installShortcut({ home, shell: '/bin/bash', pathEnv: '/usr/bin', cliPath: cli, binDir: path.join(home, 'tools') });
    expect(custom.launcher).toBe(path.join(home, 'tools', 'mcproc'));
    expect(fs.readFileSync(path.join(home, '.bashrc'), 'utf8')).toContain(`export PATH="$HOME/tools:$PATH"`);
  });
  it('refuses to write over a symlink or a file it did not write (another mcproc, a user wrapper), and never follows the link', () => {
    const { home, cli, bin } = sandbox();
    fs.mkdirSync(bin, { recursive: true });
    const target = path.join(home, 'other-cli.js');
    fs.writeFileSync(target, 'other');
    fs.symlinkSync(target, path.join(bin, 'mcproc'));
    expect(() => installShortcut({ home, shell: '/usr/bin/zsh', pathEnv: bin, cliPath: cli })).toThrowError(/symlink/);
    expect(fs.readFileSync(target, 'utf8')).toBe('other'); // the link target is untouched
    fs.unlinkSync(path.join(bin, 'mcproc'));
    fs.writeFileSync(path.join(bin, 'mcproc'), '#!/bin/sh\necho mine\n');
    expect(() => installShortcut({ home, shell: '/usr/bin/zsh', pathEnv: bin, cliPath: cli })).toThrowError(/not written by mcproc install/);
    expect(fs.readFileSync(path.join(bin, 'mcproc'), 'utf8')).toContain('echo mine');
  });
  it('uninstall removes only a launcher it wrote', () => {
    const { home, cli, bin } = sandbox();
    installShortcut({ home, shell: '/usr/bin/zsh', pathEnv: bin, cliPath: cli });
    expect(installShortcut({ home, shell: '/usr/bin/zsh', pathEnv: bin, cliPath: cli, uninstall: true })).toMatchObject({ removed: true });
    expect(fs.existsSync(path.join(bin, 'mcproc'))).toBe(false);
    fs.writeFileSync(path.join(bin, 'mcproc'), '#!/bin/sh\necho someone elses\n');
    expect(installShortcut({ home, shell: '/usr/bin/zsh', pathEnv: bin, cliPath: cli, uninstall: true })).toMatchObject({ removed: false });
    expect(fs.existsSync(path.join(bin, 'mcproc'))).toBe(true);
  });
});

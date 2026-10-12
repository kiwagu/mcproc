import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McprocError } from '../core/errors.js';
import { findPackageRoot } from '../runtime/bundle.js';
import { shq } from '../transport/quote.js';

export const LAUNCHER_MARK = '# written by mcproc install';

export interface InstallOptions { binDir?: string; home?: string; shell?: string; pathEnv?: string; cliPath?: string; uninstall?: boolean }
export interface InstallResult {
  launcher: string; binDir: string; cli: string; written: boolean; removed: boolean;
  onPath: boolean; rcFile: string | null; rcUpdated: boolean; next: string[];
}

function rcFor(home: string, shell: string): string {
  const name = path.basename(shell || '');
  return path.join(home, name === 'zsh' ? '.zshrc' : name === 'bash' ? '.bashrc' : '.profile');
}

/**
 * Puts a `mcproc` shortcut on the shell PATH for a checkout (an `npm i -g` install needs none): a tiny sh launcher
 * that execs node on this package's dist/cli.js, plus one marked PATH line in the shell rc when the bin dir is not on PATH yet.
 * Idempotent; `uninstall` removes only a launcher it wrote and never edits the rc.
 */
export function installShortcut(o: InstallOptions = {}): InstallResult {
  const home = o.home ?? os.homedir();
  const binDir = path.resolve(o.binDir ?? path.join(home, '.local', 'bin'));
  const cli = path.resolve(o.cliPath ?? path.join(findPackageRoot(), 'dist', 'cli.js'));
  const launcher = path.join(binDir, 'mcproc');
  const pathEnv = o.pathEnv ?? process.env.PATH ?? '';
  const onPath = pathEnv.split(':').some((p) => p && path.resolve(p.replace(/^~(?=\/|$)/, home)) === binDir);
  const next: string[] = [];
  if (o.uninstall) {
    const exists = fs.existsSync(launcher);
    const ours = exists && fs.readFileSync(launcher, 'utf8').includes(LAUNCHER_MARK);
    if (ours) fs.unlinkSync(launcher);
    else if (exists) next.push(`${launcher} was not written by mcproc install; left in place`);
    else next.push(`nothing at ${launcher}`);
    return { launcher, binDir, cli, written: false, removed: ours, onPath, rcFile: null, rcUpdated: false, next };
  }
  fs.mkdirSync(binDir, { recursive: true });
  // never write through a symlink (an `npm i -g` layout links bin/mcproc to the package) or over a file that is not ours
  let existing: fs.Stats | null = null;
  try { existing = fs.lstatSync(launcher); } catch { /* absent */ }
  if (existing?.isSymbolicLink()) {
    throw new McprocError('BAD_ARGUMENT', `${launcher} is a symlink (to ${fs.readlinkSync(launcher)}); refusing to write through it`, { hint: 'Remove it yourself, or pass another --bin-dir.' });
  }
  if (existing && !fs.readFileSync(launcher, 'utf8').includes(LAUNCHER_MARK)) {
    throw new McprocError('BAD_ARGUMENT', `${launcher} exists and was not written by mcproc install; refusing to overwrite it`, { hint: 'Remove it yourself, or pass another --bin-dir.' });
  }
  fs.writeFileSync(launcher, `#!/bin/sh\n${LAUNCHER_MARK}: runs the mcproc at ${path.dirname(path.dirname(cli))}\nexec node ${shq(cli)} "$@"\n`);
  fs.chmodSync(launcher, 0o755);
  let rcFile: string | null = null;
  let rcUpdated = false;
  if (!onPath) {
    rcFile = rcFor(home, o.shell ?? process.env.SHELL ?? '');
    const shown = binDir.startsWith(home + path.sep) ? `$HOME/${path.relative(home, binDir)}` : binDir;
    const line = `export PATH="${shown}:$PATH"`;
    const current = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, 'utf8') : '';
    if (!current.includes(line)) {
      fs.appendFileSync(rcFile, `${current === '' || current.endsWith('\n') ? '' : '\n'}\n# mcproc install: the shortcut lives in ${shown}\n${line}\n`);
      rcUpdated = true;
    }
    next.push(`open a new shell (or run: ${line}) so that \`mcproc\` is found`);
  }
  next.push('register the MCP server once: claude mcp add -s user mcproc -- mcproc mcp');
  return { launcher, binDir, cli, written: true, removed: false, onPath, rcFile, rcUpdated, next };
}

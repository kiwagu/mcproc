import { spawn, spawnSync } from 'node:child_process';
import { McprocError } from '../core/errors.js';
import type { Spawner, Streamer } from './types.js';

/**
 * The pids under `root` (its children, their children, …) from one `ps` listing. A timeout must take the whole command
 * down, not only its shell: a child left running would keep the pipes, and the caller's process, alive.
 */
function descendants(root: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const kids = new Map<number, number[]>();
  for (const line of r.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && ppid >= 0) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length)
    for (const c of kids.get(stack.pop()!) ?? []) {
      out.push(c);
      stack.push(c);
    }
  return out;
}

export const nodeSpawner: Spawner = (argv, { stdin, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '',
      err = '',
      done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      for (const pid of child.pid ? descendants(child.pid) : []) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone already */
        }
      }
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      reject(
        new McprocError(
          'TIMEOUT',
          `Command timed out after ${timeoutMs} ms: ${argv.slice(0, 4).join(' ')}`,
          { details: { stderr: err.slice(-2000) } }
        )
      );
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); // decode across chunk boundaries: a multi-byte character may be split between reads
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(
        new McprocError(
          'TRANSPORT_FAILED',
          `Cannot spawn ${argv[0]}: ${e.message}`
        )
      );
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
    child.stdin.on('error', () => {
      /* EPIPE when the command exits before reading stdin */
    });
    child.stdin.end(stdin ?? '');
  });

/**
 * Starts a long-running command; stderr is dropped. Its stdin stays open and silent while it runs: when this process
 * kills it or goes away, the stdin closes, and that is how the command on the far side learns it is no longer read.
 */
export const nodeStreamer: Streamer = (argv) => {
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdin.on('error', () => {
    /* EPIPE: the command ended first */
  });
  let exited = false;
  const exits: ((code: number | null) => void)[] = [];
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const cb of exits) cb(code);
  };
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code));
  return {
    onData: (cb) => void child.stdout.on('data', cb),
    onExit: (cb) => void exits.push(cb),
    kill: () => {
      child.kill('SIGTERM');
      child.stdin.destroy();
      child.stdout.destroy();
    },
  };
};

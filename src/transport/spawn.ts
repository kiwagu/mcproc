import { spawn } from 'node:child_process';
import { McprocError } from '../core/errors.js';
import type { Spawner } from './types.js';

export const nodeSpawner: Spawner = (argv, { stdin, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new McprocError('TIMEOUT', `Command timed out after ${timeoutMs} ms: ${argv.slice(0, 4).join(' ')}`, { details: { stderr: err.slice(-2000) } }));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');  // decode across chunk boundaries: a multi-byte character may be split between reads
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      reject(new McprocError('TRANSPORT_FAILED', `Cannot spawn ${argv[0]}: ${e.message}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: out, stderr: err });
    });
    child.stdin.on('error', () => { /* EPIPE when the command exits before reading stdin */ });
    child.stdin.end(stdin ?? '');
  });

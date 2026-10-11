import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { probeScript } from '../../src/shell/snippets.js';
import { parseProbe } from '../../src/core/ports.js';
import { createTransport } from '../../src/transport/index.js';
import type { Host } from '../../src/core/manifest.js';

describe('probe script executed on this host', () => {
  it('falls back to /proc when ss exists but fails (old iproute2), and still finds our own listener with its pid', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-fakess-'));
    fs.writeFileSync(path.join(bin, 'ss'), '#!/bin/sh\necho "ss: invalid option -- H" >&2\nexit 255\n', { mode: 0o755 });
    const server = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const host: Host = { name: 'local', local: true, ssh_args: [], cwd: '/', readonly: false, shell: { bin: '/bin/sh', flags: ['-c'] }, env: {} };
      const res = await createTransport(host).exec(`PATH=${bin}:$PATH; export PATH; ${probeScript("echo '[]'")}`, { timeoutMs: 60_000 });
      const mine = parseProbe(res.stdout).listeners.find((l) => l.port === port);
      expect(mine).toMatchObject({ proto: 'tcp', pid: process.pid });
    } finally {
      server.close();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }, 70_000);
});

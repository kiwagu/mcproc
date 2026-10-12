import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../src/core/manifest.js';
import {
  buildEcosystem,
  ecosystemPath,
  appCwd,
} from '../../src/core/ecosystem.js';
import { pm2Name } from '../../src/core/pm2.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const basic = path.join(here, '..', 'fixtures', 'projects', 'basic');

describe('pm2Name', () => {
  it('prefixes the app with the project, because pm2 matches processes by name only', () => {
    expect(pm2Name('demo', 'api')).toBe('demo-api');
  });
});

describe('buildEcosystem', () => {
  const m = loadManifest(basic);
  it('maps apps to pm2 config for the local host', () => {
    const eco = buildEcosystem(m, m.hosts.local);
    const api = eco.apps.find((a) => a.name === 'demo-api')!;
    expect(api).toMatchObject({
      name: 'demo-api',
      namespace: 'demo',
      cwd: basic,
      script: '/bin/bash',
      args: ['-lc', 'node dist/apps/api/main.js'],
      interpreter: 'none',
      env: { PORT: '3310', DEBUG: 'true' },
      autorestart: true,
      treekill: true,
      log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSS',
      watch: ['dist/apps/api'],
      watch_delay: 1000,
    });
    expect(api).not.toHaveProperty('ignore_watch');
    expect(api).not.toHaveProperty('time'); // pm2 would overwrite log_date_format with its seconds-only stamp
    const worker = eco.apps.find((a) => a.name === 'demo-worker')!;
    expect(worker.kill_timeout).toBe(3000);
    expect(worker).not.toHaveProperty('watch');
  });
  it('uses the remote cwd and host env overrides, keeps run verbatim', () => {
    const m2 = structuredClone(m);
    m2.hosts.stand.env = { PORT: '4000' };
    m2.apps.api.run = `sh -c 'echo "$HOME" && node x.js'`;
    const eco = buildEcosystem(m2, m2.hosts.stand);
    const api = eco.apps.find((a) => a.name === 'demo-api')!;
    expect(api.cwd).toBe('/srv/demo');
    expect(api.env.PORT).toBe('4000');
    expect(api.args).toEqual(['-lc', `sh -c 'echo "$HOME" && node x.js'`]);
    expect(ecosystemPath(m2.hosts.stand)).toBe(
      '/srv/demo/.mcproc/.generated/ecosystem.json'
    );
    expect(appCwd(m2.hosts.stand, { ...m2.apps.api, cwd: 'apps/api' })).toBe(
      '/srv/demo/apps/api'
    );
  });
});

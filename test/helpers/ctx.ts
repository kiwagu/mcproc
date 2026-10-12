import { prepare } from '../../src/core/resolve.js';
import type { Context } from '../../src/core/resolve.js';
import { scopeManifest } from '../../src/core/manifest.js';
import { Pm2Client } from '../../src/core/pm2.js';
import { FakeTransport, type Rule } from './fake-transport.js';

/** A context on a fake transport, scoped to the host like connect() does (fallback: where unbound apps run, default the host). */
export function fakeCtx(
  project: string,
  host: string,
  rules: Rule[],
  fallback = host
): Context & { fake: FakeTransport } {
  const prep = prepare({ project, host });
  const fake = new FakeTransport(rules, host);
  const pm2 = new Pm2Client(fake, prep.host, 'pm2', prep.host.pm2_home);
  return {
    manifest: scopeManifest(prep.manifest, host, fallback),
    host: prep.host,
    transport: fake,
    pm2,
    resolution: {
      bin: 'pm2',
      source: 'path',
      node: 'v22.0.0',
      pm2Version: '7.0.4',
      reason: 'test',
    },
    fake,
  };
}

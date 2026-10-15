import { prepare } from '../../src/core/resolve.js';
import type { Context } from '../../src/core/resolve.js';
import { scopeManifest } from '../../src/core/manifest.js';
import { Pm2Client } from '../../src/core/pm2.js';
import type { HereCheck } from '../../src/core/urlcheck.js';
import { FakeTransport, type Rule } from './fake-transport.js';

/** The default check from here fails the test: a test that expects one passes its own. */
const noHere: HereCheck = async (url) => {
  throw new Error(`unexpected check from this machine of ${url}`);
};

/**
 * A context on a fake transport, scoped to the host like connect() does (fallback: where unbound apps run, default the
 * host). `hereCheck` is the check of a url from this machine; by default any such check fails the test.
 */
export function fakeCtx(
  project: string,
  host: string,
  rules: Rule[],
  fallback = host,
  hereCheck: HereCheck = noHere
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
    hereCheck,
    fake,
  };
}

import { prepare } from '../../src/core/resolve.js';
import type { Context } from '../../src/core/resolve.js';
import { Pm2Client } from '../../src/core/pm2.js';
import { FakeTransport, type Rule } from './fake-transport.js';

export function fakeCtx(project: string, host: string, rules: Rule[]): Context & { fake: FakeTransport } {
  const prep = prepare({ project, host });
  const fake = new FakeTransport(rules, host);
  const pm2 = new Pm2Client(fake, prep.host, 'pm2', prep.host.pm2_home);
  return { ...prep, transport: fake, pm2, resolution: { bin: 'pm2', source: 'path', node: 'v22.0.0', pm2Version: '7.0.4', reason: 'test' }, fake };
}

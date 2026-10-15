import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  checkHere,
  decideUrl,
  hereFail,
  hostAttempt,
  isItself,
  needsHere,
  reasonWord,
  settleUrls,
  type Attempt,
  type HereCheck,
  type HostEnv,
  type HostUrl,
  type UrlInput,
} from '../../src/core/urlcheck.js';
import { urlName } from '../../src/shell/snippets.js';

const listen = async (s: net.Server): Promise<number> => {
  s.listen(0); // every interface: localhost may resolve to ::1 or to 127.0.0.1
  await new Promise((r) => s.once('listening', r));
  return (s.address() as net.AddressInfo).port;
};
const H = (
  code: number | null,
  exit: string | null = null,
  addr: string | null = null
): HostUrl => ({ code, exit, addr });
const no = (fail: string) => ({ answered: false, fail });
const ok200: Attempt = { answered: true, code: 200 };
const refused: Attempt = { answered: false, fail: 'refused' };
const env: HostEnv = {
  container: 'docker',
  hostname: 'ws-01',
  self: ['172.17.0.2', '127.0.0.1', '::1'],
};
const openssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
/* A box with IPv6 off cannot listen on ::1: the IPv6-literal test skips there instead of failing. */
const ipv6 = await new Promise<boolean>((r) => {
  const s = net.createServer();
  s.once('error', () => r(false));
  s.listen(0, '::1', () => s.close(() => r(true)));
});

describe('urlName', () => {
  it('is the host name the host resolves, IPv6 without brackets; null for a url that does not parse', () => {
    expect(urlName('https://site.test/x?y')).toBe('site.test');
    expect(urlName('http://localhost:3000/')).toBe('localhost');
    expect(urlName('http://[::1]:3000/')).toBe('::1');
    expect(urlName('http://[bad')).toBeNull();
  });
});

describe('checkHere against servers on this machine', () => {
  const servers: net.Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });
  const serve = async (h: http.RequestListener) => {
    const s = http.createServer(h);
    servers.push(s);
    return listen(s);
  };
  it('an answer is its status: a redirect is not followed, an error status is still an answer', async () => {
    const okPort = await serve((_q, s) => s.end('ok'));
    const moved = await serve((_q, s) => {
      s.writeHead(302, { location: 'http://127.0.0.1:1/' });
      s.end();
    });
    const failing = await serve((_q, s) => {
      s.writeHead(503);
      s.end();
    });
    expect(await checkHere(`http://localhost:${okPort}/`)).toEqual({
      answered: true,
      code: 200,
    });
    expect(await checkHere(`http://127.0.0.1:${moved}/`)).toEqual({
      answered: true,
      code: 302,
    });
    expect(await checkHere(`http://127.0.0.1:${failing}/`)).toEqual({
      answered: true,
      code: 503,
    });
  });
  it.skipIf(!ipv6)('an IPv6 literal answers', async () => {
    const p = await serve((_q, s) => s.end('ok'));
    expect(await checkHere(`http://[::1]:${p}/`)).toEqual({
      answered: true,
      code: 200,
    });
  });
  it('a closed port is refused, an .invalid name does not resolve, a url that does not parse is no answer', async () => {
    const s = net.createServer();
    const p = await listen(s);
    await new Promise((r) => s.close(r)); // free a moment ago, closed now
    expect(await checkHere(`http://127.0.0.1:${p}/`)).toEqual(no('refused'));
    expect(await checkHere('http://nothing-here.invalid/')).toEqual(
      no('not resolved')
    );
    expect(await checkHere('http://[bad')).toEqual(no('no answer'));
  });
  it('a url the request refuses outright is no answer: it resolves, never rejects', async () => {
    // a port out of range fails in the URL parser; another protocol makes http.request throw synchronously
    await expect(checkHere('http://127.0.0.1:99999/')).resolves.toEqual(
      no('no answer')
    );
    await expect(checkHere('ftp://127.0.0.1/')).resolves.toEqual(
      no('no answer')
    );
  });
  it('a server that accepts but never answers is a timeout, within the total time', async () => {
    const s = net.createServer(() => {});
    servers.push(s);
    const p = await listen(s);
    const t0 = Date.now();
    expect(await checkHere(`http://127.0.0.1:${p}/`, { totalMs: 300 })).toEqual(
      no('timeout')
    );
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it('a TLS handshake that never completes ends on the connect timer, long before the total one', async () => {
    const s = net.createServer(() => {}); // accepts the TCP connection, never answers the ClientHello
    servers.push(s);
    const p = await listen(s);
    const t0 = Date.now();
    expect(
      await checkHere(`https://127.0.0.1:${p}/`, {
        connectMs: 200,
        totalMs: 5000,
      })
    ).toEqual(no('timeout'));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('https to a port that speaks plain http is tls', async () => {
    const p = await serve((_q, s) => s.end('ok'));
    expect(await checkHere(`https://127.0.0.1:${p}/`)).toEqual(no('tls'));
  });
  it.skipIf(!openssl)(
    'a self-signed certificate is accepted: it asks "does it answer", not "can I trust it"',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcproc-tls-'));
      try {
        const key = path.join(dir, 'k.pem');
        const cert = path.join(dir, 'c.pem');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            key,
            '-out',
            cert,
            '-days',
            '1',
            '-subj',
            '/CN=localhost',
          ],
          { stdio: 'ignore' }
        );
        const s = https.createServer(
          { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
          (_q, r) => r.end('ok')
        );
        servers.push(s);
        const p = await listen(s);
        expect(await checkHere(`https://localhost:${p}/`)).toEqual({
          answered: true,
          code: 200,
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('hereFail', () => {
  it('maps Node errors to the words the host checks use', () => {
    const e = (code?: string, message = 'x') =>
      Object.assign(new Error(message), code ? { code } : {});
    expect(hereFail(e('EAI_AGAIN'))).toBe('not resolved');
    expect(hereFail(e('ENOTFOUND'))).toBe('not resolved');
    expect(hereFail(e('ECONNREFUSED'))).toBe('refused');
    expect(hereFail(e('ECONNRESET'))).toBe('reset');
    expect(hereFail(e('ETIMEDOUT'))).toBe('timeout');
    expect(hereFail(e('ERR_SSL_WRONG_VERSION_NUMBER'))).toBe('tls');
    expect(hereFail(e('EPROTO'))).toBe('tls');
    expect(hereFail(e('ENETUNREACH'))).toBe('no answer');
    expect(hereFail(e())).toBe('no answer');
  });
});

describe('hostAttempt', () => {
  it('curl: an HTTP code is an answer, whatever it is; 000 is read from the exit status', () => {
    expect(hostAttempt(H(200, '0'))).toEqual({ answered: true, code: 200 });
    expect(hostAttempt(H(404, '0'))).toEqual({ answered: true, code: 404 });
    expect(hostAttempt(H(null))).toEqual(no('no curl or wget'));
    for (const [exit, fail] of [
      ['6', 'not resolved'],
      ['7', 'refused'],
      ['28', 'timeout'],
      ['35', 'tls'],
      ['51', 'tls'],
      ['58', 'tls'],
      ['60', 'tls'],
      ['52', 'reset'],
      ['56', 'reset'],
      ['3', 'no answer'],
      [null, 'no answer'], // an older two-field line
    ] as const)
      expect(hostAttempt(H(0, exit))).toEqual(no(fail));
  });
  it("wget: BusyBox's messages and GNU's statuses", () => {
    expect(hostAttempt(H(200, 'w0'))).toEqual({ answered: true, code: 200 });
    expect(
      hostAttempt(
        H(
          0,
          "w1:wget: can't connect to remote host (127.0.0.1): Connection refused"
        )
      )
    ).toEqual(no('refused'));
    expect(hostAttempt(H(0, "w1:wget: bad address 'nope.invalid'"))).toEqual(
      no('not resolved')
    );
    // a name with ssl or tls in it is still a name that did not resolve
    expect(hostAttempt(H(0, "w1:wget: bad address 'ssl.site.test'"))).toEqual(
      no('not resolved')
    );
    expect(
      hostAttempt(H(0, "w1:wget: bad address 'tls.example.test'"))
    ).toEqual(no('not resolved'));
    expect(hostAttempt(H(0, 'w1:wget: download timed out'))).toEqual(
      no('timeout')
    );
    // cut as a whole by `timeout 3`: coreutils exits 124; BusyBox's timeout execs wget in place, so it dies by SIGTERM
    // (143, measured on alpine: `w143:`, the shell's "Terminated" going to the probe's stderr), whatever it said before
    expect(hostAttempt(H(0, 'w124:'))).toEqual(no('timeout'));
    expect(hostAttempt(H(0, 'w124'))).toEqual(no('timeout'));
    expect(hostAttempt(H(0, 'w143:'))).toEqual(no('timeout'));
    expect(hostAttempt(H(0, 'w143:Terminated'))).toEqual(no('timeout'));
    expect(
      hostAttempt(
        H(0, 'w1:wget: server returned error: HTTP/1.0 404 Not Found')
      )
    ).toEqual({ answered: true, code: 404 });
    expect(
      hostAttempt(
        H(
          0,
          'w1:280B…:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:… ssl_client: SSL_connect wget: error getting response: Connection reset by peer'
        )
      )
    ).toEqual(no('tls')); // a failed handshake ends in a reset too: tls first
    expect(hostAttempt(H(0, 'w1:wget: error getting response'))).toEqual(
      no('reset')
    );
    expect(
      hostAttempt(
        H(
          0,
          "w1:wget: can't connect to remote host (10.255.255.1): Network unreachable"
        )
      )
    ).toEqual(no('no answer'));
    expect(hostAttempt(H(0, 'w4'))).toEqual(no('no answer')); // GNU wget is silent under -q
    expect(hostAttempt(H(0, 'w5'))).toEqual(no('tls'));
    expect(hostAttempt(H(0, 'w6'))).toEqual({ answered: true, code: null }); // 401/407: an answer whose code GNU wget does not print
    expect(hostAttempt(H(0, 'w8'))).toEqual({ answered: true, code: null });
  });
});

describe('isItself', () => {
  it('a real name that resolves to the host itself: a loopback address or one of its own', () => {
    expect(isItself('site.test', '127.0.1.1', env)).toBe(true); // a hostname line in /etc/hosts
    expect(isItself('site.test', '172.17.0.2', env)).toBe(true);
    expect(isItself('site.test', '::1', null)).toBe(true);
    expect(isItself('site.test', '10.0.0.9', env)).toBe(false);
    expect(isItself('site.test', null, env)).toBe(false);
    expect(isItself('site.test', '172.17.0.2', null)).toBe(false);
  });
  it('never for localhost or an IP literal: those name the host on purpose', () => {
    expect(isItself('localhost', '127.0.0.1', env)).toBe(false);
    expect(isItself('app.localhost', '::1', env)).toBe(false);
    expect(isItself('127.0.0.1', '127.0.0.1', env)).toBe(false);
    expect(isItself('172.17.0.2', '172.17.0.2', env)).toBe(false);
  });
});

describe('decideUrl (url_check)', () => {
  const base: UrlInput = {
    host: 'box',
    local: false,
    mode: 'auto',
    url: 'http://localhost:3000/',
    env: null,
  };
  it('not asked: unchecked', () => {
    expect(decideUrl(base)).toEqual({
      status: 'unchecked',
      code: null,
      from: null,
      reason: null,
    });
  });
  it('auto: the host answering wins, whatever the code', () => {
    expect(decideUrl({ ...base, onHost: H(200, '0', '::1') })).toEqual({
      status: 'ok',
      code: 200,
      from: 'host',
      reason: null,
    });
    expect(
      decideUrl({ ...base, onHost: H(503, '0', '::1'), here: ok200 })
    ).toEqual({ status: 'error', code: 503, from: 'host', reason: null });
  });
  it('auto: no answer on the host, an answer here: from here, saying why the host could not', () => {
    expect(
      decideUrl({ ...base, onHost: H(0, '7', '::1'), here: ok200 })
    ).toEqual({
      status: 'ok',
      code: 200,
      from: 'here',
      reason: 'on box: refused',
    });
    const site = { ...base, url: 'https://site.test/', here: ok200 };
    expect(decideUrl({ ...site, onHost: H(0, '6', null) }).reason).toBe(
      'on box site.test does not resolve'
    );
    expect(
      decideUrl({ ...site, onHost: H(0, '7', '127.0.1.1'), env }).reason
    ).toBe('on box site.test resolves to 127.0.1.1, the host itself');
    expect(
      decideUrl({ ...base, onHost: H(0, '28', '::1'), here: ok200 }).reason
    ).toBe('on box: timeout');
    expect(decideUrl({ ...base, onHost: H(null), here: ok200 }).reason).toBe(
      'on box: no curl or wget'
    );
    expect(
      decideUrl({
        ...base,
        onHost: H(0, '7', '::1'),
        here: { answered: true, code: 401 },
      })
    ).toEqual({
      status: 'error',
      code: 401,
      from: 'here',
      reason: 'on box: refused',
    });
  });
  it('auto: neither answers: down from here, with both reasons', () => {
    expect(
      decideUrl({ ...base, onHost: H(0, '7', '::1'), here: refused })
    ).toEqual({
      status: 'down',
      code: null,
      from: 'here',
      reason: 'on box: refused; here: refused',
    });
  });
  it("a name that resolves to the host itself is the reason only when the url answered from here; otherwise the host's own failure, the address as a note", () => {
    // a box whose own name is in its /etc/hosts (Debian: 127.0.1.1 devbox), its app dead
    const devbox = {
      ...base,
      url: 'http://devbox:3000/',
      onHost: H(0, '7', '127.0.1.1'),
      env,
    };
    const note = '(devbox resolves to 127.0.1.1, the host itself)';
    const auto = decideUrl({ ...devbox, here: refused });
    expect(auto).toEqual({
      status: 'down',
      code: null,
      from: 'here',
      reason: `on box: refused ${note}; here: refused`,
    });
    expect(reasonWord(auto.reason!)).toBe('refused');
    const host = decideUrl({ ...devbox, mode: 'host' });
    expect(host).toEqual({
      status: 'down',
      code: null,
      from: 'host',
      reason: `on box: refused ${note}`,
    });
    expect(reasonWord(host.reason!)).toBe('refused');
    expect(
      reasonWord(
        decideUrl({ ...devbox, onHost: H(0, '28', '127.0.1.1'), mode: 'host' })
          .reason!
      )
    ).toBe('timeout');
    // the dev-container case: a gateway name that means another machine, and the url answers from here
    expect(decideUrl({ ...devbox, here: ok200 })).toEqual({
      status: 'ok',
      code: 200,
      from: 'here',
      reason: 'on box devbox resolves to 127.0.1.1, the host itself',
    });
  });
  it("host: only the host's line, now with a reason", () => {
    expect(
      decideUrl({ ...base, mode: 'host', onHost: H(0, '7', '::1') })
    ).toEqual({
      status: 'down',
      code: null,
      from: 'host',
      reason: 'on box: refused',
    });
    expect(decideUrl({ ...base, mode: 'host', onHost: H(null) })).toEqual({
      status: 'unchecked',
      code: null,
      from: null,
      reason: 'on box: no curl or wget',
    });
    expect(decideUrl({ ...base, mode: 'host', onHost: H(200, '0') })).toEqual({
      status: 'ok',
      code: 200,
      from: 'host',
      reason: null,
    });
  });
  it('here: only the check from here', () => {
    expect(decideUrl({ ...base, mode: 'here', here: ok200 })).toEqual({
      status: 'ok',
      code: 200,
      from: 'here',
      reason: 'url_check: here',
    });
    expect(decideUrl({ ...base, mode: 'here', here: refused })).toEqual({
      status: 'down',
      code: null,
      from: 'here',
      reason: 'here: refused',
    });
    expect(decideUrl({ ...base, mode: 'here' })).toEqual({
      status: 'unchecked',
      code: null,
      from: null,
      reason: null,
    });
  });
  it("a host that is this machine: one check, its probe's, whatever url_check says; never itself", () => {
    const local = { ...base, host: 'local', local: true };
    expect(
      decideUrl({ ...local, mode: 'here', onHost: H(0, '7', '127.0.0.1') })
    ).toEqual({
      status: 'down',
      code: null,
      from: 'host',
      reason: 'on local: refused',
    });
    expect(
      decideUrl({
        ...local,
        url: 'https://site.test/',
        onHost: H(0, '7', '127.0.1.1'),
        env,
      }).reason
    ).toBe('on local: refused');
    expect(decideUrl({ ...local, onHost: H(200, '0') })).toEqual({
      status: 'ok',
      code: 200,
      from: 'host',
      reason: null,
    });
  });
});

describe('needsHere', () => {
  it('only for a host that is not this machine: always for here, for auto when the host got no answer', () => {
    expect(needsHere(true, 'here', H(0, '7'))).toBe(false);
    expect(needsHere(false, 'host', H(0, '7'))).toBe(false);
    expect(needsHere(false, 'here', undefined)).toBe(true);
    expect(needsHere(false, 'auto', H(200, '0'))).toBe(false);
    expect(needsHere(false, 'auto', H(0, '7'))).toBe(true);
    expect(needsHere(false, 'auto', H(null))).toBe(true);
    expect(needsHere(false, 'auto', undefined)).toBe(false); // the line is missing: nothing to go on
    expect(
      needsHere(
        false,
        'auto',
        H(0, 'w1:wget: server returned error: HTTP/1.1 404 Not Found')
      )
    ).toBe(false); // an answer
  });
});

describe('reasonWord', () => {
  it('reads back the word of the last place tried, for every reason decideUrl writes', () => {
    expect(reasonWord('on box: refused')).toBe('refused');
    expect(reasonWord('on box site.test does not resolve')).toBe(
      'not resolved'
    );
    expect(
      reasonWord('on box site.test resolves to 127.0.1.1, the host itself')
    ).toBe('itself');
    expect(
      reasonWord(
        'on box: refused (site.test resolves to 127.0.1.1, the host itself); here: not resolved'
      )
    ).toBe('not resolved');
    expect(
      reasonWord(
        'on box: timeout (site.test resolves to 127.0.1.1, the host itself)'
      )
    ).toBe('timeout');
    expect(reasonWord('here: tls')).toBe('tls');
    const base: UrlInput = {
      host: 'box',
      local: false,
      mode: 'host',
      url: 'http://localhost:3000/',
      env: null,
    };
    for (const [exit, word] of [
      ['7', 'refused'],
      ['28', 'timeout'],
      ['35', 'tls'],
      ['52', 'reset'],
      ['3', 'no answer'],
      ['6', 'not resolved'],
    ] as const)
      expect(
        reasonWord(
          decideUrl({ ...base, onHost: H(0, exit, null) }).reason as string
        )
      ).toBe(word);
  });
});

describe('settleUrls', () => {
  it('checks from here once per distinct url, only where the rules ask, never for this machine', async () => {
    const asked: string[] = [];
    const here: HereCheck = async (u) => {
      asked.push(u);
      return ok200;
    };
    const apps = [
      { name: 'a', url: 'http://localhost:3000/', url_check: 'auto' as const },
      { name: 'b', url: 'http://localhost:3000/', url_check: 'auto' as const },
      { name: 'c', url: 'http://localhost:3100/', url_check: 'host' as const },
      { name: 'd', url: 'http://localhost:3200/', url_check: 'here' as const },
      { name: 'e', url: 'http://localhost:3300/', url_check: 'auto' as const },
    ];
    const urls = new Map<string, HostUrl>([
      ['http://localhost:3000/', H(0, '7', '::1')],
      ['http://localhost:3100/', H(0, '7', '::1')],
      ['http://localhost:3300/', H(200, '0', '::1')],
    ]);
    const r = await settleUrls(
      apps,
      { host: 'box', local: false },
      { urls, env: null },
      here
    );
    expect(asked.sort()).toEqual([
      'http://localhost:3000/',
      'http://localhost:3200/',
    ]);
    expect(r.a).toEqual({
      status: 'ok',
      code: 200,
      from: 'here',
      reason: 'on box: refused',
    });
    expect(r.b).toEqual(r.a);
    expect(r.c).toEqual({
      status: 'down',
      code: null,
      from: 'host',
      reason: 'on box: refused',
    });
    expect(r.d).toEqual({
      status: 'ok',
      code: 200,
      from: 'here',
      reason: 'url_check: here',
    });
    expect(r.e).toEqual({
      status: 'ok',
      code: 200,
      from: 'host',
      reason: null,
    });
    asked.length = 0;
    await settleUrls(
      apps,
      { host: 'local', local: true },
      { urls, env: null },
      here
    );
    expect(asked).toEqual([]);
  });
  it('checks from here run in parallel: two slow urls cost one wait, not two', async () => {
    let calls = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => {
      release = r;
    });
    const here: HereCheck = async () => {
      if (++calls === 2) release();
      await both; // answers only once both checks have begun
      return ok200;
    };
    const urls = new Map<string, HostUrl>([
      ['http://a.test/', H(0, '7')],
      ['http://b.test/', H(0, '7')],
    ]);
    const run = settleUrls(
      [
        { name: 'a', url: 'http://a.test/', url_check: 'auto' },
        { name: 'b', url: 'http://b.test/', url_check: 'auto' },
      ],
      { host: 'box', local: false },
      { urls, env: null },
      here
    );
    const first = await Promise.race([
      run,
      new Promise<'one after another'>((r) =>
        setTimeout(() => r('one after another'), 1000)
      ),
    ]);
    expect(first).not.toBe('one after another');
  });
});

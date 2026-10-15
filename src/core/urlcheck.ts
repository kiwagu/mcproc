import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { UrlCheckMode } from './manifest.js';
import { urlName } from '../shell/snippets.js';

/** Why nothing answered a url: the short word `ls` shows after `✗ down`. */
export type UrlFail =
  | 'refused'
  | 'not resolved'
  | 'timeout'
  | 'tls'
  | 'reset'
  | 'no answer'
  | 'no curl or wget';
/** One request's outcome: an HTTP answer (its status; null when the tool cannot tell which error it was), or why there was none. */
export type Attempt =
  | { answered: true; code: number | null }
  | { answered: false; fail: UrlFail };
/**
 * The host's facts about one url, as its probe line gives them: the HTTP code (0 = nothing answered, null = neither
 * curl nor wget there), the tool's exit token (curl's status, or `w<status>[:<stderr>]` for wget), the first address
 * the url's name resolves to there. null for a field the line did not carry.
 */
export interface HostUrl {
  code: number | null;
  exit: string | null;
  addr: string | null;
}
/** The host as it describes itself in the probe's environment section. */
export interface HostEnv {
  container: 'docker' | 'podman' | 'lxc' | 'none';
  hostname: string | null;
  /** the addresses the host's own name resolves to, plus 127.0.0.1 and ::1 */
  self: string[];
}
/** One app's url as decided: the answer, where it came from, and why it is down or was taken from this machine. */
export interface UrlResult {
  status: 'ok' | 'error' | 'down' | 'unchecked';
  code: number | null;
  from: 'host' | 'here' | null;
  reason: string | null;
}
/**
 * The check made on the machine mcproc runs on; a dependency, so tests never open sockets they do not mean to. It never
 * rejects: a failure is an Attempt without an answer (settleUrls still reads a rejection as no answer).
 */
export type HereCheck = (url: string) => Promise<Attempt>;
/** What the decision needs of an app. */
export interface UrlApp {
  name: string;
  url: string;
  url_check: UrlCheckMode;
}
export interface UrlInput {
  host: string;
  /** the host is this machine: its probe's check is the only one */
  local: boolean;
  mode: UrlCheckMode;
  url: string;
  /** the probe's line for the url; absent when the host did not request it */
  onHost?: HostUrl;
  /** the check from this machine; absent when none was made */
  here?: Attempt;
  env: HostEnv | null;
}

export const HERE_CONNECT_MS = 1000;
export const HERE_TOTAL_MS = 2000;

/**
 * One GET from this machine, as the host's curl makes it: connected within 1 s, answered within 2 s, any certificate
 * accepted (it asks "does it answer", not "can I trust it"), redirects not followed (a 3xx is an answer). node:http
 * rather than fetch: fetch cannot turn certificate checks off for one request without the undici package. A fresh
 * socket per check (no agent), so the connect timer measures this connection. Never rejects: a url that does not
 * parse, or one the request refuses at once (another protocol), resolves as no answer.
 */
export function checkHere(
  url: string,
  opts: { connectMs?: number; totalMs?: number } = {}
): Promise<Attempt> {
  return new Promise((resolve) => {
    let settled = false;
    let total: NodeJS.Timeout | undefined;
    let connect: NodeJS.Timeout | undefined;
    const settle = (a: Attempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      clearTimeout(connect);
      resolve(a);
    };
    try {
      const u = new URL(url);
      const tls = u.protocol === 'https:';
      const onAnswer = (res: http.IncomingMessage) => {
        settle({ answered: true, code: res.statusCode ?? null });
        res.resume();
        req.destroy(); // the status is all it asks; the body is not waited for
      };
      const base = {
        method: 'GET',
        agent: false,
        headers: { 'user-agent': 'mcproc' },
      };
      const req = tls
        ? https.request(u, { ...base, rejectUnauthorized: false }, onAnswer)
        : http.request(u, base, onAnswer);
      // a timer settles the check itself, then drops the request: the bound holds whether or not an error follows
      const timeout = () => {
        settle({ answered: false, fail: 'timeout' });
        req.destroy();
      };
      total = setTimeout(timeout, opts.totalMs ?? HERE_TOTAL_MS);
      req.on('socket', (s) => {
        if (settled) return;
        connect = setTimeout(timeout, opts.connectMs ?? HERE_CONNECT_MS);
        // TLS counts as connecting, as for curl's --connect-timeout
        s.once(tls ? 'secureConnect' : 'connect', () => clearTimeout(connect));
      });
      req.on('error', (e) => settle({ answered: false, fail: hereFail(e) }));
      req.end();
    } catch (e) {
      // the URL parser or the request itself threw before anything was sent
      settle({ answered: false, fail: hereFail(e) });
    }
  });
}

/** What a failed request from here means, in the words the host's checks use. */
export function hereFail(e: unknown): UrlFail {
  const err = e as { code?: unknown; message?: unknown } | null | undefined;
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '');
  if (code === 'ETIMEDOUT') return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL'].includes(code))
    return 'not resolved';
  if (code === 'ECONNREFUSED') return 'refused';
  if (
    code === 'EPROTO' ||
    code.startsWith('ERR_SSL') ||
    code.startsWith('ERR_TLS') ||
    /\bSSL\b|\bTLS\b|certificate/i.test(msg)
  )
    return 'tls';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  return 'no answer';
}

/** curl's exit statuses that say why nothing answered (its `-w %{http_code}` is 000 for every one of them). */
const CURL_FAILS: Record<string, UrlFail> = {
  '6': 'not resolved',
  '7': 'refused',
  '28': 'timeout',
  '35': 'tls',
  '51': 'tls',
  '58': 'tls',
  '60': 'tls',
  '52': 'reset',
  '56': 'reset',
};

/**
 * wget prints 000 for every failure; its token `w<status>[:<stderr>]` says more. BusyBox wget (alpine) exits 1 for
 * everything and says why on stderr, even under -q ("Connection refused", "bad address", "download timed out",
 * "server returned error: HTTP/1.1 404 Not Found"); GNU wget is silent under -q and its status says it: 4 network,
 * 5 TLS, 6 authentication and 8 an error answer (both HTTP answers whose code it does not print).
 */
function wgetAttempt(x: string): Attempt {
  const m = /^w(\d+)(?::(.*))?$/s.exec(x);
  const status = m ? Number(m[1]) : -1;
  const msg = m?.[2] ?? '';
  const no = (fail: UrlFail): Attempt => ({ answered: false, fail });
  const answer = /HTTP\/[\d.]+ (\d{3})\b/.exec(msg);
  if (answer) return { answered: true, code: Number(answer[1]) };
  // refused and resolve failures before tls: a resolve failure quotes the name, which may itself contain ssl or tls
  if (/refused/i.test(msg)) return no('refused');
  if (/bad address|resolve|not known|name resolution/i.test(msg))
    return no('not resolved');
  if (/ssl|tls|certificate/i.test(msg)) return no('tls'); // a failed handshake ends in a reset too: TLS first
  if (/timed out/i.test(msg)) return no('timeout');
  if (/reset|error getting response|closed/i.test(msg)) return no('reset');
  if (status === 5) return no('tls');
  if (status === 6 || status === 8) return { answered: true, code: null };
  return no('no answer');
}

/** What the host's check found, from its probe line. */
export function hostAttempt(h: HostUrl): Attempt {
  if (h.code === null) return { answered: false, fail: 'no curl or wget' };
  if (h.code > 0) return { answered: true, code: h.code };
  const x = h.exit ?? '';
  if (x.startsWith('w')) return wgetAttempt(x);
  return { answered: false, fail: CURL_FAILS[x] ?? 'no answer' };
}

/**
 * The url's name resolved on its host to the host itself (a hostname line in /etc/hosts, a loopback address, one of
 * its own addresses): the name means another machine where the url is opened. Never for localhost or an IP literal:
 * those name the host on purpose.
 */
export function isItself(
  name: string | null,
  addr: string | null,
  env: HostEnv | null
): boolean {
  if (
    !name ||
    !addr ||
    isIP(name) !== 0 ||
    name === 'localhost' ||
    name.endsWith('.localhost')
  )
    return false;
  return (
    addr.startsWith('127.') ||
    addr === '::1' ||
    (env?.self.includes(addr) ?? false)
  );
}

/** Why the host got no answer, as url_reason says it. */
function hostReason(i: UrlInput, h: HostUrl, fail: UrlFail): string {
  const name = urlName(i.url);
  if (fail === 'not resolved' && name)
    return `on ${i.host} ${name} does not resolve`;
  if (!i.local && fail !== 'no curl or wget' && isItself(name, h.addr, i.env))
    return `on ${i.host} ${name} resolves to ${h.addr}, the host itself`;
  return `on ${i.host}: ${fail}`;
}

const UNCHECKED: UrlResult = {
  status: 'unchecked',
  code: null,
  from: null,
  reason: null,
};
const answered = (
  code: number | null,
  from: 'host' | 'here',
  reason: string | null
): UrlResult => ({
  status: code !== null && code < 400 ? 'ok' : 'error',
  code,
  from,
  reason,
});
const down = (from: 'host' | 'here', reason: string): UrlResult => ({
  status: 'down',
  code: null,
  from,
  reason,
});

/** Whether a url is also checked from here: never for a host that is this machine; always for here; for auto only when the host got no answer. */
export function needsHere(
  local: boolean,
  mode: UrlCheckMode,
  onHost: HostUrl | undefined
): boolean {
  if (local || mode === 'host') return false;
  if (mode === 'here') return true;
  return onHost !== undefined && !hostAttempt(onHost).answered;
}

/**
 * Where an app's url answers (the rules of url_check). auto: an HTTP answer on the host wins; with none, the answer
 * from here, the reason saying why the host could not; with neither, down from here with both reasons. host: only the
 * host's line (no curl or wget there leaves it unchecked, with that reason). here: only the check from here. A host that
 * is this machine makes one check, its probe's, whatever url_check says.
 */
export function decideUrl(i: UrlInput): UrlResult {
  const here = i.here;
  if (!i.local && i.mode === 'here') {
    if (!here) return UNCHECKED;
    return here.answered
      ? answered(here.code, 'here', 'url_check: here')
      : down('here', `here: ${here.fail}`);
  }
  if (!i.onHost) return UNCHECKED;
  const a = hostAttempt(i.onHost);
  if (a.answered) return answered(a.code, 'host', null);
  const why = hostReason(i, i.onHost, a.fail);
  if (i.local || i.mode === 'host' || !here)
    return a.fail === 'no curl or wget'
      ? { ...UNCHECKED, reason: why }
      : down('host', why);
  if (here.answered) return answered(here.code, 'here', why);
  return down('here', `${why}; here: ${here.fail}`);
}

/**
 * Every asked app's url decided on one host. The checks from here the rules need run in parallel, one per distinct
 * url, after the probe: a url the host answered costs nothing more. Keyed by app name.
 */
export async function settleUrls(
  apps: UrlApp[],
  where: { host: string; local: boolean },
  probe: { urls: Map<string, HostUrl>; env: HostEnv | null },
  here: HereCheck
): Promise<Record<string, UrlResult>> {
  const want = [
    ...new Set(
      apps
        .filter((a) =>
          needsHere(where.local, a.url_check, probe.urls.get(a.url))
        )
        .map((a) => a.url)
    ),
  ];
  // a check that breaks its contract and rejects (or throws) is no answer for its url, not a failed snapshot
  const ask = async (u: string): Promise<Attempt> => {
    try {
      return await here(u);
    } catch {
      return { answered: false, fail: 'no answer' };
    }
  };
  const answers = new Map(
    await Promise.all(want.map(async (u) => [u, await ask(u)] as const))
  );
  return Object.fromEntries(
    apps.map((a) => [
      a.name,
      decideUrl({
        host: where.host,
        local: where.local,
        mode: a.url_check,
        url: a.url,
        onHost: probe.urls.get(a.url),
        here: answers.get(a.url),
        env: probe.env,
      }),
    ])
  );
}

/** The short word of a reason, for `✗ down (…)`: that of the last place tried (this machine, after the host). */
export function reasonWord(reason: string): string {
  const last = reason.split('; ').at(-1) ?? reason;
  if (last.endsWith(', the host itself')) return 'itself';
  if (last.endsWith(' does not resolve')) return 'not resolved';
  const i = last.lastIndexOf(': ');
  return i < 0 ? last : last.slice(i + 2);
}

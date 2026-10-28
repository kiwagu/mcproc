import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The longest a connect or one list may take before the connection is dropped and the caller falls back to `pm2 jlist`. */
export const SOCKET_CALL_MS = 5_000;

type Listener = (...args: unknown[]) => void;
export interface AxonSocket {
  connect(target: string): unknown;
  bind(target: string): unknown;
  close(): void;
  on(event: string, fn: Listener): void;
  once(event: string, fn: Listener): void;
  socks?: { unref(): void }[];
  /** Set by a connect, cleared the moment the connection drops (axon's retry comes 100 ms later). */
  connected?: boolean;
}
type Reply = (err: Error | null, res?: unknown) => void;
interface RpcClient {
  call(method: string, arg: unknown, cb: Reply): void;
}
export interface Axon {
  socket(kind: 'req' | 'rep'): AxonSocket;
}
export interface Rpc {
  Client: new (sock: AxonSocket) => RpcClient;
  Server: new (
    sock: AxonSocket
  ) => { expose(name: string, fn: (arg: unknown, reply: Reply) => void): void };
}

let vendored: { axon: Axon; rpc: Rpc } | null = null;
/** pm2's own RPC client: pm2 7 keeps it inside its package (modules/), not as packages of their own. */
export function pm2Rpc(): { axon: Axon; rpc: Rpc } {
  if (!vendored) {
    const req = createRequire(import.meta.url);
    const dir = path.dirname(req.resolve('pm2/package.json'));
    vendored = {
      axon: req(path.join(dir, 'modules', 'pm2-axon')) as Axon,
      rpc: req(path.join(dir, 'modules', 'pm2-axon-rpc')) as Rpc,
    };
  }
  return vendored;
}

// The timer stays ref'd: the connection is unref'd, so while a call waits for its answer the timer is what keeps a
// one-shot process from exiting before the answer comes. It goes with the answer, so it never holds a process longer.
const bounded = <T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onLate: () => void
): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      onLate();
      reject(new Error(`${what} took longer than ${ms} ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });

/** One connection to a daemon's rpc socket; `up` is false when nothing listens there. */
class Conn {
  private readonly sock: AxonSocket;
  private readonly client: RpcClient;
  readonly up: Promise<boolean>;
  closed = false;
  constructor(file: string) {
    const { axon, rpc } = pm2Rpc();
    this.sock = axon.socket('req');
    this.client = new rpc.Client(this.sock);
    this.up = new Promise((resolve) => {
      this.sock.on('connect', () => {
        // axon reconnects right after the retry that closed this connection: a daemon back by then gets it closed again
        if (this.closed) {
          this.sock.close();
          return;
        }
        for (const s of this.sock.socks ?? []) s.unref(); // an open connection never keeps a one-shot command alive
        resolve(true);
      });
      // axon retries a refused or dropped connection for ever: the first retry means no daemon answers there now
      this.sock.on('reconnect attempt', () => {
        this.close();
        resolve(false);
      });
      this.sock.on('error', () => {
        /* a refused connect or a dropped daemon: the retry above follows */
      });
    });
    this.sock.connect(file);
  }
  /** Not closed and not dropped: a call on a dropped connection would only wait in axon's queue. */
  get usable(): boolean {
    return !this.closed && this.sock.connected !== false;
  }
  call(method: string, ms: number): Promise<unknown> {
    return bounded(
      new Promise((resolve, reject) =>
        this.client.call(method, {}, (err, res) =>
          err ? reject(err) : resolve(res)
        )
      ),
      ms,
      method,
      () => this.close()
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sock.close();
  }
}

const pool = new Map<string, Conn>();
/** Drops `c` from the pool unless a newer connection already took its place. */
const forget = (file: string, c: Conn) => {
  if (pool.get(file) === c) pool.delete(file);
};

/**
 * pm2's process list from the daemon at `home`, over its rpc socket: `getMonitorData`, what `pm2 jlist` calls and
 * prints. null when no daemon answers there (no socket, or nothing listening on it); nothing is ever started. Throws
 * when the daemon errs or does not answer within `ms`: the caller falls back to the CLI.
 */
export async function listDaemon(
  home: string,
  ms = SOCKET_CALL_MS
): Promise<unknown[] | null> {
  const file = path.join(home, 'rpc.sock');
  let conn = pool.get(file);
  if (!conn?.usable) {
    conn?.close();
    if (!fs.existsSync(file)) {
      pool.delete(file);
      return null;
    }
    conn = new Conn(file);
    pool.set(file, conn);
  }
  const c = conn;
  try {
    if (!(await bounded(c.up, ms, 'connecting to pm2', () => c.close()))) {
      forget(file, c);
      return null;
    }
    const list = await c.call('getMonitorData', ms);
    if (!Array.isArray(list))
      throw new Error('getMonitorData answered no list');
    return list;
  } catch (e) {
    c.close();
    forget(file, c);
    throw e;
  }
}

/** Closes every open daemon connection. */
export function closeDaemons(): void {
  for (const c of pool.values()) c.close();
  pool.clear();
}

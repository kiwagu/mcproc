import { spawn } from 'node:child_process';
import { describeError, McprocError } from './errors.js';
import { admit, needOf, rampingMib, reserveMib } from './leases/admission.js';
import { ensureWatcher } from './leases/ensure.js';
import {
  aheadOf,
  assertGroupName,
  groupBusy,
  groupReason,
  groupWait,
} from './leases/queue.js';
import { LeaseStore, type Lease, type NewLease } from './leases/store.js';
import type { Host } from './manifest.js';
import { readHostMemory, type HostMemory } from './memory.js';
import { bootId, processStart } from './procfs.js';
import type { Context } from './resolve.js';
import { stateDir } from './state.js';
import { abortableSleep } from './wait.js';

/** How long an exec waits in the queue when the caller names no timeout, in milliseconds: ten minutes. */
export const EXEC_TIMEOUT_DEFAULT_MS = 600_000;
/** The longest an exec may wait in the queue, in milliseconds: an hour. */
export const EXEC_TIMEOUT_MAX_MS = 3_600_000;
/** How long an exec of an exclusive group waits when the caller names no timeout: an hour, for a line of full runs. */
export const EXEC_EXCLUSIVE_TIMEOUT_DEFAULT_MS = 3_600_000;
const POLL_MS = 1000;
const OUTPUT_LINES = 200;
/** How long the captured pipes are read after the command exited, in milliseconds: something it left behind may hold them. */
const DRAIN_MS = 1000;

/** What an exec reads and runs: the lease store, the host's memory, the watcher, the command itself, its sleep and clock. */
export interface ExecDeps {
  store: LeaseStore;
  /** the host's memory reading, or null where it has none */
  memory(ctx: Context): Promise<HostMemory | null>;
  /** makes sure the watcher runs once the exec's lease is pending */
  ensureWatcher(ctx: Context): Promise<unknown>;
  /** runs the command to its end and answers its exit code and, when captured, its last lines */
  run(
    command: string[],
    opts: {
      cwd: string;
      env: Record<string, string>;
      capture: boolean;
      signal?: AbortSignal;
      /** called once with the command's pid, as soon as it runs */
      onSpawn?: (pid: number) => void;
    }
  ): Promise<{ code: number; output: string }>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** the requester's pid kept on the lease; default this process */
  pid?: number;
  /** told once, with one line, that the exec waits for its group (the CLI prints it to stderr) */
  notice?(line: string): void;
  /** when a process started (see processStart), kept on the lease with its pid; absent, nothing is kept */
  startOf?(pid: number): number | null;
  /** this boot of the machine (see bootId), kept on the lease; absent, nothing is kept */
  bootId?(): string | null;
}
/** One exec: the command as argv, what it needs in memory (no lease without it), a note, the queue timeout and the abort. */
export interface ExecOptions {
  command: string[];
  memoryMib?: number;
  note?: string;
  /** the host-wide group it runs in, one at a time (see the queue rules); without memoryMib it waits for its group alone */
  exclusive?: string;
  timeoutMs?: number;
  /** capture the last lines for the answer (MCP); false inherits the terminal (CLI) */
  capture: boolean;
  signal?: AbortSignal;
}
/** What an exec ended with: the exit code, the captured tail, its lease as it ended, how long it queued and the env it added. */
export interface ExecResult {
  code: number;
  output: string;
  lease: Lease | null;
  waited_ms: number;
  env: Record<string, string>;
}

/** Refuses a host exec cannot run on: another machine (BAD_ARGUMENT), or a local host marked readonly (READONLY_HOST). */
export function assertExecHost(host: Host): void {
  if (!host.local)
    throw new McprocError(
      'BAD_ARGUMENT',
      `exec runs on the local host only, not on ${host.name}`,
      { hint: 'Drop --host; the command runs where mcproc runs.' }
    );
  if (host.readonly)
    throw new McprocError(
      'READONLY_HOST',
      'the local host is marked readonly: exec is refused'
    );
}

/** Keeps the last OUTPUT_LINES whole lines of a child's streams, each stream's unfinished line held apart until it ends. */
class Tail {
  private readonly lines: string[] = [];
  private readonly open = new Map<string, string>();
  /** Takes a chunk of one stream: its finished lines join the tail, its unfinished end waits for the next chunk. */
  take(stream: string, chunk: Buffer): void {
    const parts = ((this.open.get(stream) ?? '') + chunk.toString()).split(
      '\n'
    );
    this.open.set(stream, parts.pop() ?? '');
    this.lines.push(...parts);
    if (this.lines.length > OUTPUT_LINES * 2)
      this.lines.splice(0, this.lines.length - OUTPUT_LINES);
  }
  /** The last lines, the unfinished end of each stream counted as a line of its own. */
  text(): string {
    const ends = [...this.open.values()].filter((s) => s !== '');
    return [...this.lines, ...ends].slice(-OUTPUT_LINES).join('\n');
  }
}

/**
 * The command as a child with the shell left out: argv as given, cwd the project root; captured output keeps its last
 * lines. Not captured, it inherits the terminal; `stdoutToStderr` puts its stdout on the terminal's stderr too. It
 * answers once the command exited and its pipes closed, or DRAIN_MS after the exit when a process it left behind (a
 * server in the background) still holds them: the pipes are then closed and the tail is what was read by then.
 */
export function spawnRun(
  command: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    capture: boolean;
    stdoutToStderr?: boolean;
    signal?: AbortSignal;
    onSpawn?: (pid: number) => void;
  }
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: opts.capture
        ? ['ignore', 'pipe', 'pipe']
        : opts.stdoutToStderr
          ? ['inherit', 2, 2]
          : 'inherit',
    });
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    const tail = new Tail();
    child.stdout?.on('data', (c: Buffer) => tail.take('out', c));
    child.stderr?.on('data', (c: Buffer) => tail.take('err', c));
    const onAbort = () => child.kill('SIGTERM');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    let drain: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = () => {
      settled = true;
      clearTimeout(drain);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled || !exit) return;
      settle();
      // stop reading: whatever still holds the pipes keeps them without us
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        code: exit.code ?? (exit.signal ? 128 : 1),
        output: tail.text(),
      });
    };
    child.on('error', (e) => {
      if (settled) return;
      settle();
      reject(
        new McprocError(
          'BAD_ARGUMENT',
          `exec cannot run ${command[0]}: ${e.message}`,
          {
            hint: 'The command is run as argv without a shell: name a program on PATH or give its path.',
          }
        )
      );
    });
    // the exit, then the pipes read to their end (close), for at most DRAIN_MS
    child.on('exit', (code, signal) => {
      if (settled) return;
      exit = { code, signal };
      drain = setTimeout(finish, DRAIN_MS);
    });
    child.on('close', finish);
  });
}

/** The real deps: the host state directory's leases, the host's meminfo, the pm2 watcher, a child without a shell, the real clock. */
export function defaultExecDeps(dir = stateDir()): ExecDeps {
  return {
    store: new LeaseStore(dir),
    memory: (ctx) => readHostMemory(ctx.transport, ctx.host),
    ensureWatcher: (ctx) => ensureWatcher(ctx, dir),
    run: spawnRun,
    sleep: abortableSleep,
    now: () => Date.now(),
    startOf: (pid) => processStart(pid),
    bootId: () => bootId(),
  };
}

/** Under the lock, cancels the lease while it still waits (pending or starting); one that ended meanwhile is left as it is. */
async function cancelWaiting(
  store: LeaseStore,
  id: string,
  error: string
): Promise<void> {
  await store
    .withLock(async () => {
      const cur = store.get(id);
      if (cur?.state === 'pending' || cur?.state === 'starting')
        await store.transition(id, 'cancelled', { error });
    })
    .catch(() => undefined);
}

/**
 * Polls the queued lease until the watcher marks it starting, then takes it to running; a lease that was cancelled or
 * failed meanwhile ends the exec (NOT_STARTED), as do the deadline (TIMEOUT) and the signal (NOT_STARTED).
 */
async function waitTurn(
  id: string,
  t0: number,
  opts: ExecOptions,
  deps: ExecDeps
): Promise<Lease> {
  const timeoutMs = Math.min(
    opts.timeoutMs ??
      (opts.exclusive !== undefined
        ? EXEC_EXCLUSIVE_TIMEOUT_DEFAULT_MS
        : EXEC_TIMEOUT_DEFAULT_MS),
    EXEC_TIMEOUT_MAX_MS
  );
  const deadline = t0 + timeoutMs;
  for (;;) {
    const cur = deps.store.get(id);
    if (!cur || cur.state === 'cancelled' || cur.state === 'failed')
      throw new McprocError(
        'NOT_STARTED',
        `exec: the lease was ${cur?.state ?? 'removed'}${cur?.error ? ` (${cur.error})` : ''}`
      );
    if (cur.state === 'starting')
      return deps.store.withLock(() => deps.store.transition(id, 'running'));
    if (deps.now() >= deadline) {
      // what it waits for now, read again: its group may have freed and its memory not, or the other way round
      const group = groupWait(deps.store.list(), cur);
      throw new McprocError(
        'TIMEOUT',
        group
          ? `exec waited ${timeoutMs / 1000} s for ${groupReason(group, deps.now())}`
          : `exec waited ${timeoutMs / 1000} s in the queue (${cur.waiting_for ?? 'pending'})`,
        {
          hint: group
            ? 'leases shows who holds the group; raise --timeout, or end the holding run.'
            : 'leases shows the queue; raise --timeout, or free memory by stopping a stand.',
        }
      );
    }
    if (opts.signal?.aborted)
      throw new McprocError('NOT_STARTED', 'exec aborted while queued');
    await deps.sleep(POLL_MS, opts.signal);
  }
}

/**
 * One-off work in the stand's environment (`exec.env`, interpolated, plus MCPROC_PROJECT) from the project root, on
 * the local host only. With a memory size it is a lease like a start: run at once when the queue is empty and the
 * host has room (the running leases that have not settled yet charged on top of the reading), else queued behind the
 * others until the watcher marks it starting; the lease is freed with the exit code. With an exclusive group it also
 * takes its turn in that group, one run at a time host-wide: queued while the group has a holder or older waiters (it
 * says so once through `notice`), and without a memory size it waits for its group alone. A wait that ends without a
 * turn (the timeout, the signal, a watcher that cannot be launched) cancels the lease and fails.
 */
export async function runExec(
  ctx: Context,
  opts: ExecOptions,
  deps: ExecDeps
): Promise<ExecResult> {
  const m = ctx.manifest;
  const group = opts.exclusive ?? null;
  // a bad request is refused before any host is touched
  if (group !== null) assertGroupName(group);
  assertExecHost(ctx.host);
  if (opts.command.length === 0)
    throw new McprocError('BAD_ARGUMENT', 'exec needs a command after --');
  const env = { ...m.exec.env, MCPROC_PROJECT: m.root };
  const t0 = deps.now();
  let lease: Lease | null = null;
  if (opts.memoryMib !== undefined || group !== null) {
    const estimate_mib = opts.memoryMib ?? 0;
    // a lease of its group alone reads no memory: nothing of it is judged by memory
    const memory = opts.memoryMib !== undefined ? await deps.memory(ctx) : null;
    const need_mib = needOf(estimate_mib, m.resources.margin);
    const reserve_mib = reserveMib(m.resources.reserve, memory);
    const pid = deps.pid ?? process.pid;
    const input: NewLease = {
      kind: 'exec',
      project: m.project,
      root: m.root,
      slot: m.slot,
      repo: m.repo,
      target: opts.command.join(' '),
      host: null,
      apps: [],
      reload: false,
      estimate_mib,
      need_mib,
      margin: m.resources.margin,
      reserve_mib,
      sources: {},
      note: opts.note ?? null,
      requester_pid: pid,
      exclusive: group,
      boot_id: deps.bootId?.() ?? null,
      requester_start: deps.startOf?.(pid) ?? null,
    };
    let notice: string | null = null;
    const taken = await deps.store.withLock(async () => {
      const all = deps.store.list();
      // a stand admitted seconds ago is not in the reading yet: an exec must not be admitted on what it will take
      const ramping_mib = rampingMib(
        all,
        deps.now(),
        m.resources.settle * 1000
      );
      const d = admit({
        ahead: aheadOf(all),
        memory,
        need_mib,
        reserve_mib,
        ramping_mib,
      });
      if (need_mib > 0 && !d.ok && d.reason === 'never')
        throw new McprocError('NEVER_FITS', `exec: ${d.waiting_for}`, {
          hint: 'Lower --memory or the resources.reserve.',
        });
      if (group !== null && groupBusy(all, group)) {
        // its group is held, or others wait for it first: it waits, whatever the memory says
        const l = await deps.store.create(input, 'pending');
        const queued = await deps.store.patch(l.id, {
          waiting_for: `group ${group}`,
        });
        const w = groupWait(deps.store.list(), queued);
        if (w) notice = `exec: waiting for ${groupReason(w, deps.now())}`;
        return queued;
      }
      // the exec process itself is the requester: no child pid, the watcher's stuck rule reads requester_pid
      if ((group !== null && need_mib === 0) || d.ok)
        return deps.store.create(input, 'running');
      const l = await deps.store.create(input, 'pending');
      return deps.store.patch(l.id, { waiting_for: d.waiting_for });
    });
    lease = taken;
    if (notice !== null) deps.notice?.(notice);
    if (taken.state === 'pending') {
      // outside the lock: the launch takes the lock itself
      try {
        await deps.ensureWatcher(ctx);
        lease = await waitTurn(taken.id, t0, opts, deps);
      } catch (e) {
        await cancelWaiting(deps.store, taken.id, describeError(e));
        throw e;
      }
    }
  }
  const waited_ms = deps.now() - t0;
  const id = lease?.id;
  // the command's pid and start, kept on the lease as soon as it runs: the lease is held while it lives
  let recorded: Promise<unknown> = Promise.resolve();
  const onSpawn = id
    ? (pid: number) => {
        recorded = deps.store
          .withLock(() =>
            deps.store.patch(
              id,
              { command_pid: pid, command_start: deps.startOf?.(pid) ?? null },
              { expect: 'running' }
            )
          )
          // the command runs on without it: said once, since a killed mcproc would then free the lease under it
          .catch((e) =>
            deps.notice?.(
              `exec: the command's pid is not on lease ${id} (${describeError(e)}): if this mcproc is killed, the lease is freed while the command still runs`
            )
          );
      }
    : undefined;
  const free = async (fields: Partial<Lease>) => {
    if (!id) return;
    await recorded;
    await deps.store
      .withLock(() => deps.store.transition(id, 'freed', fields))
      .catch(() => undefined);
  };
  try {
    const r = await deps.run(opts.command, {
      cwd: m.root,
      env,
      capture: opts.capture,
      signal: opts.signal,
      onSpawn,
    });
    await free({ exit_code: r.code });
    return {
      ...r,
      lease: id ? deps.store.get(id) : null,
      waited_ms,
      env,
    };
  } catch (e) {
    await free({ error: describeError(e) });
    throw e;
  }
}

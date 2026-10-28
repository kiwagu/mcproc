export interface ExecOptions {
  stdin?: string | Buffer;
  timeoutMs?: number;
  env?: Record<string, string>;
}
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** A long-running command: its output as it comes, its end, and a way to stop it. */
export interface StreamProc {
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export interface ReadOptions extends ExecOptions {
  /** an answer that means the plain shell could not do it; default: exit 127 (command not found) */
  retryIf?: (r: ExecResult) => boolean;
}
export interface ReadMode {
  shell: 'plain' | 'host';
  at: number | null;
  reason: string | null;
}
export interface Transport {
  describe(): string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  read(cmd: string, opts?: ReadOptions): Promise<ExecResult>;
  /** the login environment reads use (the `login` side); null when reads use the host shell */
  loginEnv(): Promise<Record<string, string> | null>;
  /** how reads run now; null before the first read */
  readMode(): ReadMode | null;
  /** runs `cmd` under a plain `sh -c` on the host (no login profile) and streams its output */
  stream?(cmd: string): StreamProc;
}
export type Spawner = (
  argv: string[],
  opts: {
    stdin?: string | Buffer;
    timeoutMs: number;
    env?: Record<string, string>;
  }
) => Promise<ExecResult>;
export type Streamer = (argv: string[]) => StreamProc;

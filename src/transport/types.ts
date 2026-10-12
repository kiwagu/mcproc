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
export interface Transport {
  describe(): string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** runs `cmd` under a plain `sh -c` on the host (no login profile) and streams its output */
  stream?(cmd: string): StreamProc;
}
export type Spawner = (
  argv: string[],
  opts: { stdin?: string | Buffer; timeoutMs: number }
) => Promise<ExecResult>;
export type Streamer = (argv: string[]) => StreamProc;

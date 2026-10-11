export interface ExecOptions { stdin?: string | Buffer; timeoutMs?: number; env?: Record<string, string> }
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface Transport {
  describe(): string;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
}
export type Spawner = (argv: string[], opts: { stdin?: string | Buffer; timeoutMs: number }) => Promise<ExecResult>;

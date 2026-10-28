import type {
  ExecOptions,
  ExecResult,
  ReadOptions,
  Transport,
} from '../../src/transport/types.js';

export type Rule = {
  match: RegExp | string;
  result:
    | Partial<ExecResult>
    | ((cmd: string, opts: ExecOptions) => Partial<ExecResult>);
};

export class FakeTransport implements Transport {
  calls: { cmd: string; opts: ExecOptions; read?: boolean }[] = [];
  constructor(
    private rules: Rule[] = [],
    private name = 'fake'
  ) {}
  describe() {
    return this.name;
  }
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.answer(cmd, opts, false);
  }
  /** a read answers from the same rules; the call is marked so a test can tell a read from an exec */
  async read(cmd: string, opts: ReadOptions = {}): Promise<ExecResult> {
    return this.answer(cmd, opts, true);
  }
  async loginEnv() {
    return null;
  }
  readMode() {
    return null;
  }
  private async answer(
    cmd: string,
    opts: ExecOptions,
    read: boolean
  ): Promise<ExecResult> {
    this.calls.push(read ? { cmd, opts, read } : { cmd, opts });
    for (const r of this.rules) {
      const hit =
        typeof r.match === 'string' ? cmd.includes(r.match) : r.match.test(cmd);
      if (hit) {
        const res =
          typeof r.result === 'function' ? r.result(cmd, opts) : r.result;
        return { code: 0, stdout: '', stderr: '', ...res };
      }
    }
    throw new Error(`FakeTransport: no rule for command: ${cmd}`);
  }
}

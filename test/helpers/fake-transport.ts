import type {
  ExecOptions,
  ExecResult,
  Transport,
} from '../../src/transport/types.js';

export type Rule = {
  match: RegExp | string;
  result:
    | Partial<ExecResult>
    | ((cmd: string, opts: ExecOptions) => Partial<ExecResult>);
};

export class FakeTransport implements Transport {
  calls: { cmd: string; opts: ExecOptions }[] = [];
  constructor(
    private rules: Rule[] = [],
    private name = 'fake'
  ) {}
  describe() {
    return this.name;
  }
  async exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    this.calls.push({ cmd, opts });
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

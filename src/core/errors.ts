export const ERROR_CODES = [
  'MANIFEST_NOT_FOUND', 'MANIFEST_INVALID', 'UNKNOWN_APP', 'UNKNOWN_HOST', 'READONLY_HOST',
  'PM2_NOT_FOUND', 'NODE_NOT_FOUND', 'TAR_NOT_FOUND', 'PM2_HOME_TOO_LONG', 'DOWNLOAD_FAILED',
  'TRANSPORT_FAILED', 'TIMEOUT', 'PM2_FAILED', 'NOT_STARTED', 'ALREADY_EXISTS', 'NAME_COLLISION',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class McprocError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'McprocError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }
  toJSON(): { code: ErrorCode; message: string; hint?: string; details?: unknown } {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export function isMcprocError(e: unknown): e is McprocError {
  return e instanceof McprocError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'McprocError');
}

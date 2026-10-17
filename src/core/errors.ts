export const ERROR_CODES = [
  'MANIFEST_NOT_FOUND',
  'MANIFEST_INVALID',
  'UNKNOWN_APP',
  'UNKNOWN_HOST',
  'READONLY_HOST',
  'PM2_NOT_FOUND',
  'NODE_NOT_FOUND',
  'TAR_NOT_FOUND',
  'PM2_HOME_TOO_LONG',
  'DOWNLOAD_FAILED',
  'TRANSPORT_FAILED',
  'TIMEOUT',
  'PM2_FAILED',
  'NOT_STARTED',
  'ALREADY_EXISTS',
  'NAME_COLLISION',
  'BAD_ARGUMENT',
  'BUNDLE_INVALID',
  'WRONG_HOST',
  'UNKNOWN_VAR',
  'BAD_TEMPLATE',
  'VAR_CYCLE',
  'NEVER_FITS',
  'LEASE_UNSUPPORTED_HOST',
  'LEASE_NOT_PENDING',
  'NO_FREE_SLOT',
  'SLOT_TAKEN',
  'WORKTREE_EXISTS',
  'WORKTREE_DIRTY',
  'NOT_A_WORKTREE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class McprocError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; details?: unknown } = {}
  ) {
    super(message);
    this.name = 'McprocError';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }
  toJSON(): {
    code: ErrorCode;
    message: string;
    hint?: string;
    details?: unknown;
  } {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      details: this.details,
    };
  }
}

export function isMcprocError(e: unknown): e is McprocError {
  return (
    e instanceof McprocError ||
    (typeof e === 'object' &&
      e !== null &&
      (e as { name?: string }).name === 'McprocError')
  );
}

/** `CODE: message` for mcproc errors, the bare message for anything else: the one-line form screens and partial results show. */
export const describeError = (e: unknown): string =>
  isMcprocError(e)
    ? `${e.code}: ${e.message}`
    : e instanceof Error
      ? e.message
      : String(e);

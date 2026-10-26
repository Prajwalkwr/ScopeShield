/**
 * Typed application errors. Every error crossing the HTTP boundary carries a stable
 * machine-readable code so the frontend never has to parse prose.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'IMMUTABLE_RECORD'
  | 'INVALID_STATE_TRANSITION'
  | 'PRECONDITION_FAILED'
  | 'UNSUPPORTED_MEDIA'
  | 'PAYLOAD_TOO_LARGE'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REVOKED'
  | 'TOKEN_CONSUMED'
  | 'PROPOSAL_SUPERSEDED'
  | 'AI_UNAVAILABLE'
  | 'AI_INVALID_OUTPUT'
  | 'EXTRACTION_FAILED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  IMMUTABLE_RECORD: 409,
  INVALID_STATE_TRANSITION: 409,
  PRECONDITION_FAILED: 412,
  UNSUPPORTED_MEDIA: 415,
  PAYLOAD_TOO_LARGE: 413,
  TOKEN_EXPIRED: 410,
  TOKEN_REVOKED: 410,
  TOKEN_CONSUMED: 409,
  PROPOSAL_SUPERSEDED: 409,
  AI_UNAVAILABLE: 503,
  AI_INVALID_OUTPUT: 502,
  EXTRACTION_FAILED: 422,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** True when the message is safe to show to an end user verbatim. */
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, opts: { details?: unknown; expose?: boolean } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = opts.details;
    this.expose = opts.expose ?? true;
  }
}

export const badRequest = (m = 'The request could not be processed.', d?: unknown) =>
  new AppError('VALIDATION_FAILED', m, { details: d });
export const unauthenticated = (m = 'You need to sign in to continue.') =>
  new AppError('UNAUTHENTICATED', m);
/**
 * Deliberately used for both "does not exist" and "exists in another organization":
 * returning 404 in both cases avoids leaking the existence of other tenants' records.
 */
export const notFound = (m = 'The requested record could not be found.') => new AppError('NOT_FOUND', m);
export const forbidden = (m = 'You do not have permission to perform this action.') =>
  new AppError('PERMISSION_DENIED', m);
export const conflict = (m: string, d?: unknown) => new AppError('CONFLICT', m, { details: d });
export const immutable = (m = 'This record is immutable and cannot be changed.') =>
  new AppError('IMMUTABLE_RECORD', m);
export const invalidTransition = (m: string) => new AppError('INVALID_STATE_TRANSITION', m);
export const precondition = (m: string, d?: unknown) =>
  new AppError('PRECONDITION_FAILED', m, { details: d });
export const unsupportedMedia = (m: string) => new AppError('UNSUPPORTED_MEDIA', m);
export const internal = (m = 'Something went wrong on our side.') => new AppError('INTERNAL', m, { expose: false });
export const tokenExpired = (m = 'This link has expired.') => new AppError('TOKEN_EXPIRED', m);
export const tokenRevoked = (m = 'This link is no longer valid.') => new AppError('TOKEN_REVOKED', m);
export const tokenConsumed = (m = 'A decision has already been recorded for this document.') =>
  new AppError('TOKEN_CONSUMED', m);
export const proposalSuperseded = (m = 'This proposal has been replaced by a newer version.') =>
  new AppError('PROPOSAL_SUPERSEDED', m);
export const aiUnavailable = (m = 'The AI service is unavailable; the deterministic result is shown instead.') =>
  new AppError('AI_UNAVAILABLE', m);

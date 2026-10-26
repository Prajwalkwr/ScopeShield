import { AppError } from '../../platform/errors';

/** 413 with a stable code, so the client can render a specific message instead of a generic error. */
export function payloadTooLarge(message = 'The uploaded file is too large.') {
  return new AppError('PAYLOAD_TOO_LARGE', message);
}

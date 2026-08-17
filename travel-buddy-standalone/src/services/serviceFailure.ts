/**
 * serviceFailure / thrownFailure — the service-layer half of "no machine string
 * reaches a user".
 *
 * The screen-level wraps (errorCopy / bookingErrorCopy at each Alert) fix the
 * call sites a survey happened to find. These two fix the source: a service
 * that never writes `res.statusText`, `HTTP ${status}` or `String(err)` into
 * its `error` field cannot leak one to a future caller that nobody has written
 * yet.
 *
 * Both layers are kept deliberately. The screen wraps are cheap defence in
 * depth against a service regressing, and they are what the guard test
 * enforces — if the screens stopped calling the helper because "the service is
 * clean now", the guard would have nothing left to check and the next
 * unwrapped call site would be invisible again.
 *
 * Diagnostics are not discarded, only relocated: every path here logs the
 * status, statusText and original value through logServiceError before
 * returning copy.
 */
import { errorCopy } from '../lib/errorCopy.ts';
import { logServiceError } from '../lib/serviceErrorLog.ts';

/**
 * Failure copy for a non-OK response.
 *
 * `serverMessage` is whatever the body offered (usually `body.message`). It is
 * used only if it reads as real copy; a code or status text falls back to
 * `fallback`. The status and statusText always reach the log.
 */
export function serviceFailure(
  service: string,
  res: { status?: number; statusText?: string },
  serverMessage: unknown,
  fallback: string,
): string {
  logServiceError(`${service}.request`, {
    status: res?.status,
    statusText: res?.statusText,
    raw: serverMessage,
  });
  return errorCopy(typeof serverMessage === 'string' ? serverMessage : null, fallback);
}

/** Failure copy for a thrown error (network loss, JSON parse, aborted fetch). */
export function thrownFailure(
  service: string,
  err: unknown,
  fallback = 'Could not reach the server. Please check your connection and try again.',
): string {
  logServiceError(`${service}.threw`, { raw: err });
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : null;
  return errorCopy(message, fallback);
}

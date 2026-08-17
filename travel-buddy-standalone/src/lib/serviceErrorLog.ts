/**
 * serviceErrorLog — keep the diagnostic, stop shipping it to the user.
 *
 * Services used to put `res.statusText`, `HTTP ${res.status}` or `String(err)`
 * into the `error` string a screen renders. That is two problems wearing one
 * coat: a user reads "Forbidden", AND the status code is the only place the
 * failure was ever recorded. Removing the machine string from `error` without
 * recording it somewhere would fix the first by making the second permanent —
 * an opaque failure nobody can debug is a different bug, not a fix.
 *
 * So the rule is: the diagnostic keeps its full fidelity (status, statusText,
 * the original string, the operation name) and moves to the log/Sentry, while
 * the user gets a sentence written for them.
 */
import { getSentry } from './sentry.ts';

export interface ServiceErrorDetail {
  /** HTTP status, when the failure came from a response rather than a throw. */
  status?: number;
  /** `res.statusText`, preserved verbatim. */
  statusText?: string;
  /** The original value: a caught error, a response body, a raw string. */
  raw?: unknown;
}

function describe(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return `${raw.name}: ${raw.message}`;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * Record a service failure.
 *
 * `operation` is the call site in `service.function` form, so a log line points
 * at code rather than at a screen.
 */
export function logServiceError(operation: string, detail: ServiceErrorDetail = {}): void {
  const payload = {
    operation,
    status: detail.status,
    statusText: detail.statusText,
    raw: describe(detail.raw),
  };

  // Device log stream — present in dev and in production device logs.
  console.warn('[service-error]', JSON.stringify(payload));

  // Sentry breadcrumb rather than an exception: these are handled failures, and
  // a breadcrumb attaches the status to whatever the user does next (including
  // a crash) without inventing an alert-worthy event for every 403.
  try {
    getSentry()?.addBreadcrumb?.({
      category: 'service-error',
      level: 'error',
      message: operation,
      data: payload,
    });
  } catch {
    /* logging must never be the thing that breaks a request path */
  }
}

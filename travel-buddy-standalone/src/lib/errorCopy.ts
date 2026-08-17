/**
 * errorCopy — never show a user a string that was not written for them.
 *
 * Domain-NEUTRAL on purpose. bookingErrorCopy() carries Rent-a-Buddy's copy map
 * and delegates here for the general case; this module must stay free of any
 * domain's wording, because reusing a domain map across features is how a user
 * blocking someone ends up reading "Rent a Buddy isn't open yet."
 *
 * ## What actually leaks
 *
 * Services in this app build their `error` string in several ways, and only
 * some of them are human copy:
 *
 *   - `(body as any).message ?? 'Failed to block user'`  → human. Fine.
 *   - `(body as any).message ?? \`HTTP ${res.status}\``   → "HTTP 403"
 *   - `(body as any)?.message ?? res.statusText`         → "Forbidden", "Not Found"
 *   - `String(err)`                                      → "TypeError: Network request failed"
 *   - a bare server code (Rent-a-Buddy's apiFetch)       → "verification_unavailable"
 *
 * The last four are machine strings. This function replaces them with the
 * caller's own sentence and passes real copy through untouched. It decides
 * what NOT to show; the caller decides what to show instead.
 */

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * HTTP status texts, which arrive via `res.statusText` and read as English
 * while telling a user nothing. Listed explicitly rather than guessed at by
 * shape — "Not Found" is two capitalised words and so is a lot of real copy.
 */
const HTTP_STATUS_TEXTS = new Set([
  'bad request', 'unauthorized', 'payment required', 'forbidden', 'not found',
  'method not allowed', 'not acceptable', 'request timeout', 'conflict', 'gone',
  'payload too large', 'unsupported media type', 'unprocessable entity',
  'too many requests', 'internal server error', 'not implemented',
  'bad gateway', 'service unavailable', 'gateway timeout',
]);

/** True when `value` is a machine string rather than something written for a user. */
export function isMachineString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  // A bare code: `db_error`, `forbidden`, `verification_unavailable`.
  if (!/\s/.test(trimmed)) return true;
  // `HTTP 404` from a fetch wrapper with no body to read.
  if (/^HTTP \d+$/.test(trimmed)) return true;
  // `String(err)` on an Error keeps the constructor name.
  if (/^[A-Za-z]*Error:/.test(trimmed)) return true;
  if (HTTP_STATUS_TEXTS.has(trimmed.toLowerCase())) return true;
  return false;
}

/**
 * Human copy for an arbitrary service error string.
 *
 * `fallback` is the caller's own sentence for "nothing usable came back". Call
 * sites that already have one keep it — this function's job is only to ensure a
 * machine string is never what a user reads, not to decide the wording.
 */
export function errorCopy(
  value: string | null | undefined,
  fallback?: string,
): string {
  const generic = fallback ?? GENERIC_ERROR;
  if (!value) return generic;
  return isMachineString(value) ? generic : value.trim();
}

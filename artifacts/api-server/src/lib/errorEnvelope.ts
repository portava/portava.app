import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";
import { isRetryableErrorCode } from "./http";

/**
 * The global Express error handler — ONE error envelope for the whole API.
 *
 * WHY IT LIVES HERE RATHER THAN INLINE IN app.ts
 * ----------------------------------------------
 * It is the only response writer in the system that is NOT `sendError`, so it
 * is the one place the envelope can drift, and it was drifting. Importing
 * `app.ts` to test it means booting every router; the handler that guards the
 * contract was therefore covered by a hand-copied REPLICA in
 * `src/test/appHardening.test.ts` commented "verbatim copy of the app.ts
 * handler" — a copy that could not fail when the original changed. Exporting the
 * real function lets the test bind to the real thing.
 *
 * THE DEFECT THIS FIXES (A2 in `12` §3.2, `11` §"The envelope")
 * ------------------------------------------------------------
 * `sendError` (lib/http.ts) writes `{ error: "<code>", message }` — a FLAT
 * string code — at 4159 call sites across 134 route files, and the 407
 * hand-rolled `res.status(n).json({ error: … })` sites use the same flat shape.
 * This handler wrote `{ error: { code, message } }`. So a client that reads
 * `body.error` as a code got a string everywhere except on an unhandled throw,
 * where it silently got an OBJECT — `11` calls it "an unreconciled
 * inconsistency, not a documented tier", and says it cannot stay undecided.
 *
 * It is decided in the direction of the 4159 sites, not the one: the flat shape
 * is what every documented code path emits and what clients already parse.
 *
 * `retryable` is carried through for the codes `sendError` marks retryable
 * (today: `degraded_unavailable`), so a guard that REFUSES by throwing — see
 * `TripAccessUnavailableError` in lib/http.ts — reaches the client as exactly
 * the response the route would have sent by hand. Express 5 forwards a rejected
 * async handler here automatically, which is what makes that composition work
 * without editing a single route.
 *
 * `status` / `statusCode` and `code` are read off the error object, unchanged
 * from the previous behaviour.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const status: number =
    typeof err?.status     === "number" ? err.status :
    typeof err?.statusCode === "number" ? err.statusCode :
    500;

  // Log at error level; skip 4xx noise in production if desired
  if (status >= 500) {
    logger.error({ err }, "unhandled error");
  } else {
    logger.warn({ err }, "request error");
  }

  const code: string =
    typeof err?.code === "string" && err.code.length > 0 ? err.code : "INTERNAL_ERROR";

  // Do not leak stack traces to the client. In production, additionally
  // suppress internal error messages (DB errors, stack-adjacent details) for
  // 5xx responses — the original error is already logged above. Dev keeps the
  // real message for debuggability.
  const isProd = process.env.NODE_ENV === "production";
  const clientMessage: string =
    status >= 500 && isProd
      ? "An unexpected error occurred."
      : (err?.message ?? "An unexpected error occurred.");

  const retryable = isRetryableErrorCode(code) ? { retryable: true } : {};

  res.status(status).json({ error: code, message: clientMessage, ...retryable });
}

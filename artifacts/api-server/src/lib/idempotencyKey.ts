/**
 * The `Idempotency-Key` request header — `09` §7 part 1, PAY-046.
 *
 * "Every money-moving request carries a caller-supplied idempotency_key derived
 * from the EVENT, not the attempt." A client that retries a tip, a capture or a
 * payout request must send the SAME key, so the ledger's UNIQUE (scope,
 * idempotency_key) index (migration 3821) makes the retry a replay instead of a
 * second movement of money.
 *
 * This module is the pure half: it reads one header value and answers with a
 * tagged result. It imports nothing, so it runs without a server. The half that
 * writes the 400 is `requireIdempotencyKey` in `lib/http.ts`.
 *
 * WHAT A KEY MAY LOOK LIKE. 8 to 255 characters from `A-Z a-z 0-9 . _ : -`,
 * starting with a letter or digit. No spaces and no commas: Node joins a header
 * sent twice with ", ", so a comma or space means two keys arrived and the
 * request did not say which one it meant.
 *
 * WHAT IT MUST NOT CARRY. A key is stored on an append-only row. Derive it from
 * the commercial event (`booking:<booking id>:tip:<n>`), never from a person:
 * a profile id inside a key is an identifier erasure could not remove.
 *
 * WHAT THIS CANNOT CHECK. Whether the key really was derived from the event. A
 * client that mints a fresh key per attempt passes this and gets no protection;
 * that is a property of the client (PAY-T20), stated here so nobody reads a
 * present header as proof of a safe retry.
 */

/** The header's name as a client sends it. Node lower-cases it on `req.headers`. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type IdempotencyKeyRefusal = "idempotency_key_required" | "idempotency_key_malformed";

export type IdempotencyKeyRead =
  | { ok: true; key: string }
  | { ok: false; reason: IdempotencyKeyRefusal; message: string };

/**
 * Read the value of the `Idempotency-Key` header (`req.headers["idempotency-key"]`).
 * Absent or empty is `idempotency_key_required`; anything else that is not one
 * well-formed key is `idempotency_key_malformed`. The value is never trimmed or
 * repaired: a key that differs by whitespace between two attempts is two keys.
 */
export function readIdempotencyKey(headerValue: unknown): IdempotencyKeyRead {
  if (headerValue === undefined || headerValue === null || headerValue === "") {
    return {
      ok: false,
      reason: "idempotency_key_required",
      message: `${IDEMPOTENCY_KEY_HEADER} header is required on a request that moves money. Send the same key when retrying the same action.`,
    };
  }
  if (typeof headerValue !== "string") {
    return {
      ok: false,
      reason: "idempotency_key_malformed",
      message: `${IDEMPOTENCY_KEY_HEADER} must be sent exactly once.`,
    };
  }
  if (
    headerValue.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    headerValue.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_RE.test(headerValue)
  ) {
    return {
      ok: false,
      reason: "idempotency_key_malformed",
      message:
        `${IDEMPOTENCY_KEY_HEADER} must be ${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters of ` +
        "letters, digits, '.', '_', ':' or '-', starting with a letter or digit.",
    };
  }
  return { ok: true, key: headerValue };
}

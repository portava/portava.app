/**
 * Identity-verification webhook signature verification.
 *
 * Privacy invariant 5 of `docs/trust/verified-foundation-plan.md`:
 *
 *   "Webhooks are signature-verified in every real adapter; an unverified
 *    webhook throws, never silently accepts."
 *
 * `POST /api/verification/webhook` is an unauthenticated public endpoint whose
 * body is written straight into `identity_verifications` and, on success, lifts
 * `profiles.verification_level`. The signature is therefore the ONLY thing
 * standing between an anonymous HTTP caller and a self-granted verified badge.
 *
 * ── WHY ONE MODULE FOR TWO VENDORS ───────────────────────────────────────────
 * Stripe Identity and Persona sign webhooks the same way, and it is worth
 * saying exactly how so the next reader does not have to trust a comment:
 *
 *   header:          `t=<unix-seconds>,v1=<hex>[,v1=<hex>…]`
 *   signed payload:  `${t}.${rawBody}`   (the EXACT bytes as delivered)
 *   algorithm:       HMAC-SHA256, hex-encoded, keyed by the endpoint's
 *                    signing secret
 *
 * Only the header NAME differs (`Stripe-Signature` / `Persona-Signature`).
 * Multiple `v1` values appear during secret rotation and any one matching is
 * acceptance. This file is the scheme; `providers.ts` binds the header name.
 *
 * ── THE FOUR WAYS THIS IS USUALLY GOT WRONG, AND WHAT IS DONE HERE ───────────
 *
 * 1. Verifying a re-serialized body. `JSON.parse` then `JSON.stringify` changes
 *    key order and whitespace and the HMAC no longer matches — or, worse,
 *    someone "fixes" that by verifying the re-serialized form, at which point
 *    the signature no longer covers what was actually delivered. The route
 *    mounts `express.raw()` before the global JSON parser for this reason
 *    (`routes/verification.ts`), and this function takes `rawBody` as a string
 *    and never parses it.
 *
 * 2. Skipping the check when no secret is configured. That is the failure mode
 *    that matters most, because it looks like a harmless guard clause and it is
 *    reached in exactly the deployment where it is most dangerous — a fresh
 *    environment where the secret was not set yet. `secret_not_configured` is
 *    a THROW, never a pass.
 *
 * 3. `===` on the digest. String comparison short-circuits on the first
 *    differing byte, which leaks the correct prefix to a caller who can time
 *    the endpoint. `crypto.timingSafeEqual` on equal-length buffers.
 *
 * 4. No timestamp tolerance. Without it a delivery captured once is replayable
 *    forever, and every replay is another idempotent-but-real webhook. Both
 *    vendors document a tolerance; 300 s is Stripe's default and is used for
 *    both.
 *
 * Errors carry a `code` and never embed the secret, the digest or the body —
 * the route logs the error server-side and answers 400 with a generic message,
 * so anything put in here reaches whoever hit the endpoint via the logs.
 */

import crypto from "node:crypto";

/** Providers whose adapter is a real vendor integration (i.e. not the mock). */
export const REAL_PROVIDER_NAMES = ["stripe", "persona"] as const;
export type RealProviderName = (typeof REAL_PROVIDER_NAMES)[number];

export type WebhookSignatureFailure =
  | "secret_not_configured"
  | "signature_header_missing"
  | "signature_header_malformed"
  | "signature_mismatch"
  | "signature_timestamp_out_of_tolerance";

/**
 * Raised by every real adapter when a webhook cannot be proven to come from the
 * provider. `routes/verification.ts` turns any throw out of `handleWebhook`
 * into `400 invalid_signature`, which is a retryable answer for both vendors.
 */
export class WebhookSignatureError extends Error {
  readonly code: WebhookSignatureFailure;
  readonly provider: string;

  constructor(code: WebhookSignatureFailure, provider: string, detail?: string) {
    // Message is deliberately short and free of payload/secret material.
    super(`${provider} webhook signature rejected: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "WebhookSignatureError";
    this.code = code;
    this.provider = provider;
  }
}

/** Default replay window, in seconds. Stripe's documented default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookSignatureInput {
  /** Raw request headers as delivered. Looked up case-insensitively. */
  headers: Record<string, string | string[] | undefined>;
  /** Header carrying the signature, e.g. `stripe-signature`. */
  headerName: string;
  /** The body EXACTLY as delivered. Never a re-serialized object. */
  rawBody: string;
  /** The endpoint signing secret. `undefined`/empty is a refusal, not a bypass. */
  secret: string | undefined;
  /** Provider name, for the error only. */
  provider: string;
  toleranceSeconds?: number;
  /** Injectable clock; tests pin the replay window without sleeping. */
  nowMs?: number;
}

/**
 * Read a header regardless of case, returning the first value if the framework
 * gave us an array. Express lowercases incoming header names, but `WebhookEvent`
 * is a plain record and nothing in the type enforces that, so an adapter that
 * matched one spelling only would reject real deliveries from a different
 * transport.
 */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw === "string" && raw.length > 0) return raw;
  }
  return undefined;
}

/** Parse `t=…,v1=…,v1=…` into its timestamp and every offered digest. */
function parseSignatureHeader(header: string): { t: string | null; v1: string[] } {
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && t === null) t = value;
    else if (key === "v1" && value.length > 0) v1.push(value);
  }
  return { t, v1 };
}

/** Constant-time hex digest comparison; length mismatch is a miss, not a throw. */
function digestsMatch(expectedHex: string, offeredHex: string): boolean {
  if (offeredHex.length !== expectedHex.length) return false;
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expectedHex, "hex");
    b = Buffer.from(offeredHex, "hex");
  } catch {
    return false;
  }
  // Buffer.from(hex) silently truncates at the first non-hex character, so an
  // attacker-supplied "zz…" decodes to a SHORT buffer. Re-check the byte length
  // before timingSafeEqual, which throws on unequal lengths.
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verify a `t=…,v1=…` webhook signature. Returns the signed timestamp on
 * success; throws `WebhookSignatureError` on every failure path.
 *
 * There is no boolean return and no `{ ok: false }`: a caller that forgets to
 * check a boolean silently accepts, which is the exact thing invariant 5
 * forbids. Throwing is the only shape where forgetting fails closed.
 */
export function verifyTimestampedHmacSignature(input: VerifyWebhookSignatureInput): {
  timestampSeconds: number;
} {
  const { headers, headerName, rawBody, secret, provider } = input;
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowMs = input.nowMs ?? Date.now();

  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new WebhookSignatureError(
      "secret_not_configured",
      provider,
      "IDENTITY_WEBHOOK_SECRET is unset",
    );
  }

  const header = headerValue(headers, headerName);
  if (!header) {
    throw new WebhookSignatureError("signature_header_missing", provider, headerName);
  }

  const { t, v1 } = parseSignatureHeader(header);
  if (t === null || v1.length === 0) {
    throw new WebhookSignatureError("signature_header_malformed", provider);
  }

  const timestampSeconds = Number(t);
  if (!Number.isFinite(timestampSeconds)) {
    throw new WebhookSignatureError("signature_header_malformed", provider);
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");

  // Signature BEFORE freshness: answering "too old" to a body we cannot
  // authenticate would tell an anonymous caller which timestamps are in range.
  if (!v1.some((offered) => digestsMatch(expected, offered))) {
    throw new WebhookSignatureError("signature_mismatch", provider);
  }

  const skewSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  if (skewSeconds > tolerance) {
    throw new WebhookSignatureError(
      "signature_timestamp_out_of_tolerance",
      provider,
      `${Math.round(skewSeconds)}s > ${tolerance}s`,
    );
  }

  return { timestampSeconds };
}

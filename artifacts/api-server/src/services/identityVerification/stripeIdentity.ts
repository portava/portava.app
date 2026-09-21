/**
 * Stripe Identity adapter internals.
 *
 * ── WHAT IS AND IS NOT CERTIFIED HERE ────────────────────────────────────────
 * The SIGNATURE half of this file is exercised end to end by
 * `test/verificationWebhookSignature.test.ts` against real HMAC material and
 * needs no Stripe account to be correct — the scheme is a documented, stable
 * construction over bytes we control.
 *
 * The PAYLOAD half (which JSON fields carry the session id, the status, the
 * failure code, the country) is written from Stripe's documented shapes and has
 * NEVER been run against Stripe, sandbox or live. census-trust TV-6b stays
 * BUILT-BUT-WRONG for exactly that reason and will stay there until a sandbox
 * transcript exists. Nothing in this file adds `stripe` to
 * `readiness.IMPLEMENTED_PROVIDERS`, so the Rent-a-Buddy booking gate stays
 * closed and `identityProviderStatus()` still reports Stripe non-operational.
 * That switch is a deliberate, separate act that needs the sandbox evidence.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 * Privacy invariants 1 and 2 (`docs/trust/verified-foundation-plan.md`) are
 * structural here, not aspirational: `normalizeStripeSession` returns a
 * `VerificationResult`, whose type has no field capable of holding a document
 * image, a document number or a date of birth. The DOB Stripe returns in
 * `verified_outputs.dob` is read, reduced to a boolean by `deriveIsOver18`, and
 * goes out of scope in the same expression. Nothing on this path is logged.
 *
 * Mapping (from the TODOs previously written in providers.ts):
 *   createSession            -> POST /v1/identity/verification_sessions
 *   handleWebhook            -> verify Stripe-Signature, then normalize
 *                               identity.verification_session.{verified,
 *                               requires_input,canceled,processing,created}
 *   getSessionStatus         -> GET  /v1/identity/verification_sessions/:id
 *   requestProviderDeletion  -> POST /v1/identity/verification_sessions/:id/redact
 */

import type {
  NormalizedFailureReason,
  NormalizedVerificationStatus,
  VerificationRequest,
  VerificationResult,
  VerificationSession,
} from "./types.js";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const REQUEST_TIMEOUT_MS = 10_000;

// ── privacy-preserving age derivation ────────────────────────────────────────

/**
 * Reduce a date of birth to the ONLY fact Portava is permitted to keep.
 *
 * Takes the DOB as an argument and returns a boolean. There is deliberately no
 * variant that returns the age, the DOB, or a formatted string: invariant 2
 * says the derived boolean is the stored artefact, and a function that can only
 * produce a boolean cannot be misused into storing more.
 *
 * `undefined` (rather than `false`) when the provider gave us no usable DOB —
 * "we do not know" must not be written into `is_over_18` as "not an adult",
 * because a null column reads as unknown and `false` reads as a finding.
 */
export function deriveIsOver18(
  dob: { day?: unknown; month?: unknown; year?: unknown } | null | undefined,
  nowMs: number = Date.now(),
): boolean | undefined {
  if (!dob) return undefined;
  const y = Number(dob.year);
  const m = Number(dob.month);
  const d = Number(dob.day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return undefined;
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  // Compare in UTC against the 18th birthday rather than dividing elapsed
  // milliseconds by 365.25 days, which is wrong by a day for anyone whose
  // birthday is near the boundary in a leap year.
  const eighteenth = Date.UTC(y + 18, m - 1, d);
  return nowMs >= eighteenth;
}

/** Same reduction from an ISO `YYYY-MM-DD` string (Persona's shape). */
export function deriveIsOver18FromIso(
  iso: unknown,
  nowMs: number = Date.now(),
): boolean | undefined {
  if (typeof iso !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  return deriveIsOver18({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, nowMs);
}

// ── normalization ────────────────────────────────────────────────────────────

/**
 * Stripe `last_error.code` → `NormalizedFailureReason`.
 *
 * Prefix matching rather than an exhaustive list, because Stripe adds codes.
 * The order matters: `selfie_document_missing_photo` starts with `selfie_` and
 * is a selfie problem, so selfie is tested before document.
 */
export function mapStripeFailureCode(code: unknown): NormalizedFailureReason {
  if (typeof code !== "string" || code.length === 0) return "other";
  const c = code.toLowerCase();
  if (c.includes("under_supported_age") || c.includes("underage")) return "underage";
  if (c.startsWith("selfie_")) return "selfie_mismatch";
  if (c.startsWith("document_")) return "document_invalid";
  if (c === "abandoned" || c === "consent_declined") return "abandoned";
  if (c.startsWith("country_not_supported") || c.startsWith("device_not_supported")) return "other";
  return "other";
}

function mapStripeStatus(status: unknown): NormalizedVerificationStatus {
  switch (status) {
    case "verified":
      return "verified";
    case "processing":
      return "processing";
    case "requires_input":
      // Stripe uses requires_input BOTH for "we could not verify this" and for
      // "the user has not finished yet". The discriminator is last_error: a
      // session that has never been attempted has none. Resolved by the caller
      // (normalizeStripeSession) because only it can see last_error.
      return "failed";
    case "canceled":
      return "canceled";
    case "created":
      return "created";
    default:
      return "pending";
  }
}

interface StripeSessionObject {
  id?: unknown;
  status?: unknown;
  last_error?: { code?: unknown } | null;
  last_verification_report?: unknown;
  options?: { document?: { require_matching_selfie?: unknown } | null } | null;
  verified_outputs?: {
    dob?: { day?: unknown; month?: unknown; year?: unknown } | null;
    address?: { country?: unknown } | null;
  } | null;
}

/**
 * Normalize one Stripe VerificationSession object into the only shape the rest
 * of the app consumes. Pure — no I/O, no clock except the injectable one.
 */
export function normalizeStripeSession(
  session: StripeSessionObject,
  nowMs: number = Date.now(),
): VerificationResult | null {
  const id = typeof session.id === "string" ? session.id : "";
  if (!id) return null;

  const rawStatus = session.status;
  let status = mapStripeStatus(rawStatus);

  // requires_input with no last_error is the user still working, not a failure.
  const errorCode = session.last_error?.code;
  if (rawStatus === "requires_input" && (errorCode === undefined || errorCode === null)) {
    status = "pending";
  }

  const result: VerificationResult = {
    provider: "stripe",
    providerSessionId: id,
    status,
  };

  if (status === "failed") {
    result.failureReason = mapStripeFailureCode(errorCode);
    // `underage` is the one failure that carries a positive age finding: the
    // provider read a DOB and it was under 18. Recording it is what lets an age
    // gate refuse without a second check.
    if (result.failureReason === "underage") result.isOver18 = false;
  }

  // The redaction handle, not the report id. Stripe's GDPR primitive is
  // POST /identity/verification_sessions/:id/redact — it takes the SESSION id
  // and redacts the report along with it. Storing `last_verification_report`
  // here would have left `requestProviderDeletionForUser` holding a `vr_…` it
  // cannot redact, and a `vr_…` is a pointer at the document images themselves,
  // which invariant 1 is about not keeping handles to. Set for every state a
  // session can be in, because a FAILED session also left documents at Stripe.
  result.providerVerificationRef = id;

  if (status === "verified") {
    // A verified session that REQUIRED a matching selfie verified the selfie —
    // Stripe does not reach `verified` with a failing required check. When the
    // selfie was not requested, selfieMatch stays undefined (not false), so
    // toVerificationLevel() yields id_verified rather than claiming a mismatch.
    if (session.options?.document?.require_matching_selfie === true) {
      result.selfieMatch = true;
    }
    const over18 = deriveIsOver18(session.verified_outputs?.dob ?? null, nowMs);
    if (over18 !== undefined) result.isOver18 = over18;
    const country = session.verified_outputs?.address?.country;
    if (typeof country === "string" && /^[A-Za-z]{2}$/.test(country)) {
      result.documentCountry = country.toUpperCase();
    }
    result.verifiedAt = new Date(nowMs).toISOString();
  }

  return result;
}

/** Event types that carry a session we act on. Anything else normalizes to null. */
const ACTIONABLE_EVENT_TYPES = new Set([
  "identity.verification_session.verified",
  "identity.verification_session.requires_input",
  "identity.verification_session.processing",
  "identity.verification_session.canceled",
  "identity.verification_session.created",
]);

/**
 * Normalize an already-SIGNATURE-VERIFIED Stripe webhook body.
 *
 * Takes the parsed envelope, not the raw string, so that no caller can reach
 * normalization without having gone through signature verification first — the
 * parse happens in providers.ts after the verify call returns.
 */
export function normalizeStripeWebhook(
  parsed: unknown,
  nowMs: number = Date.now(),
): VerificationResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const envelope = parsed as { type?: unknown; data?: { object?: unknown } | null };
  if (typeof envelope.type !== "string" || !ACTIONABLE_EVENT_TYPES.has(envelope.type)) return null;
  const object = envelope.data?.object;
  if (!object || typeof object !== "object") return null;
  return normalizeStripeSession(object as StripeSessionObject, nowMs);
}

// ── REST calls ───────────────────────────────────────────────────────────────

function secretKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env["STRIPE_IDENTITY_SECRET_KEY"];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error(
      "Stripe Identity is selected (IDENTITY_PROVIDER=stripe) but STRIPE_IDENTITY_SECRET_KEY is not set.",
    );
  }
  return key;
}

async function stripeCall(
  path: string,
  form: Record<string, string> | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: form === null ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${secretKey(env)}`,
      ...(form === null ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    ...(form === null ? {} : { body: new URLSearchParams(form).toString() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    // The response body is Stripe's error envelope, which may name the request
    // and the key prefix. Only the status and the documented error code are
    // surfaced; the body is not embedded in the message.
    let code = "";
    try {
      code = String((JSON.parse(text) as any)?.error?.code ?? "");
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Stripe Identity API ${res.status}${code ? ` (${code})` : ""} on ${path}`);
  }
  return JSON.parse(text);
}

export async function stripeCreateSession(
  req: VerificationRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerificationSession> {
  const form: Record<string, string> = {
    type: "document",
    return_url: req.returnUrl,
    "metadata[portava_user_id]": req.userId,
    // Ask for the derived age check. `deriveIsOver18` is what turns the DOB it
    // returns into the single boolean Portava is allowed to keep.
    "options[document][require_matching_selfie]": req.level === "id_selfie" ? "true" : "false",
  };
  const body = (await stripeCall("/identity/verification_sessions", form, env)) as {
    id?: unknown;
    url?: unknown;
  };
  const id = typeof body.id === "string" ? body.id : "";
  const url = typeof body.url === "string" ? body.url : "";
  if (!id || !url) {
    throw new Error("Stripe Identity returned a session without an id or a hosted url");
  }
  return {
    provider: "stripe",
    providerSessionId: id,
    redirectUrl: url,
    // Stripe hosted links are valid for 24h; the row's own expiry is what the
    // client polls against, so a conservative value is the safe one.
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  };
}

export async function stripeGetSessionStatus(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerificationResult> {
  const body = await stripeCall(
    `/identity/verification_sessions/${encodeURIComponent(providerSessionId)}`,
    null,
    env,
  );
  const normalized = normalizeStripeSession(body as StripeSessionObject);
  if (!normalized) {
    throw new Error("Stripe Identity returned an unreadable verification session");
  }
  return normalized;
}

export async function stripeRequestDeletion(
  /** The `vs_…` session id stored in identity_verifications.provider_verification_ref. */
  redactionHandle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // `redact` is Stripe's GDPR erasure primitive: it permanently removes the
  // collected data and leaves the session object in a `redacted` state.
  await stripeCall(
    `/identity/verification_sessions/${encodeURIComponent(redactionHandle)}/redact`,
    {},
    env,
  );
}

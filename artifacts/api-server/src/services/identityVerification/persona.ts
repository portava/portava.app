/**
 * Persona adapter internals.
 *
 * ── WHAT IS AND IS NOT CERTIFIED HERE ────────────────────────────────────────
 * Identical footing to `stripeIdentity.ts`: the SIGNATURE half is proven by
 * `test/verificationWebhookSignature.test.ts` against real HMAC material and is
 * correct without an account; the PAYLOAD half is written from Persona's
 * documented JSON:API shapes and has never been run against Persona. That is
 * why census-trust TV-6b stays BUILT-BUT-WRONG and why `persona` is NOT added
 * to `readiness.IMPLEMENTED_PROVIDERS` — the Rent-a-Buddy booking gate stays
 * closed until a sandbox transcript exists.
 *
 * Mapping (from the TODOs previously written in providers.ts):
 *   createSession            -> POST /api/v1/inquiries   (+ one-time link)
 *   handleWebhook            -> verify Persona-Signature, then normalize
 *                               inquiry.{created,started,completed,approved,
 *                               declined,failed,expired,marked-for-review}
 *   getSessionStatus         -> GET  /api/v1/inquiries/:id
 *   requestProviderDeletion  -> POST /api/v1/inquiries/:id/redact
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 * Persona returns the parsed government-ID fields on the inquiry itself —
 * `attributes.birthdate`, `attributes.name-first`, `attributes.identification-
 * number`. Only `birthdate` is touched, and only through `deriveIsOver18FromIso`
 * which can return nothing but a boolean. Every other field is left unread:
 * `normalizePersonaInquiry` has no branch that can copy one into the result,
 * and `VerificationResult` has no field that could hold one.
 */

import type {
  NormalizedFailureReason,
  NormalizedVerificationStatus,
  VerificationRequest,
  VerificationResult,
  VerificationSession,
} from "./types.js";
import { deriveIsOver18FromIso } from "./stripeIdentity.js";

const PERSONA_API_BASE = "https://api.withpersona.com/api/v1";
const PERSONA_API_VERSION = "2023-01-05";
const REQUEST_TIMEOUT_MS = 10_000;

// ── normalization ────────────────────────────────────────────────────────────

/**
 * Persona inquiry status → normalized status.
 *
 * Persona's documented terminal statuses are `completed` (every required
 * verification passed), `failed` (one did not), `expired`, and — where manual
 * review is configured — `approved` / `declined`. `needs_review` and
 * `marked-for-review` are NOT terminal and must not read as a pass: an inquiry
 * sitting in a human queue would otherwise hand out a verified badge the
 * moment it was filed.
 *
 * The DEFAULT is `pending`, not `verified`. An unrecognised status — a new one
 * Persona adds later — must never fall through to standing the user has not
 * been granted; `pending` leaves the row where it was and the poll fallback
 * picks it up.
 *
 * NOT YET EXERCISED AGAINST PERSONA. This mapping is read off Persona's
 * documented status list; TV-6b stays BUILT-BUT-WRONG until a sandbox
 * transcript shows which of these a real template actually emits.
 */
export function mapPersonaStatus(status: unknown): NormalizedVerificationStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "completed":
    case "approved":
    case "passed":
      return "verified";
    case "declined":
    case "failed":
      return "failed";
    case "expired":
      return "expired";
    case "needs_review":
    case "marked-for-review":
    case "pending":
      return "processing";
    case "created":
      return "created";
    default:
      return "pending";
  }
}

/** Failed Persona check name → normalized failure reason. */
export function mapPersonaCheckName(name: unknown): NormalizedFailureReason {
  const n = String(name ?? "").toLowerCase();
  if (!n) return "other";
  if (n.includes("age") || n.includes("birthdate")) return "underage";
  if (n.includes("selfie") || n.includes("face") || n.includes("liveness")) return "selfie_mismatch";
  if (n.includes("document") || n.includes("id_") || n.includes("id-")) return "document_invalid";
  return "other";
}

interface PersonaInquiry {
  id?: unknown;
  attributes?: Record<string, unknown> | null;
}

/**
 * Normalize one Persona inquiry resource. Pure.
 *
 * `failedCheckNames` comes from the webhook's `included[]` array, which the
 * caller flattens — the inquiry resource itself does not carry the checks.
 */
export function normalizePersonaInquiry(
  inquiry: PersonaInquiry,
  failedCheckNames: readonly string[] = [],
  nowMs: number = Date.now(),
): VerificationResult | null {
  const id = typeof inquiry.id === "string" ? inquiry.id : "";
  if (!id) return null;

  const attrs = inquiry.attributes ?? {};
  const status = mapPersonaStatus(attrs["status"]);

  const result: VerificationResult = {
    provider: "persona",
    providerSessionId: id,
    // Persona's redaction primitive takes the inquiry id, so the inquiry id is
    // the handle `requestProviderDeletionForUser` needs. Set for every state,
    // because a DECLINED inquiry still left a government ID at Persona.
    providerVerificationRef: id,
    status,
  };

  if (status === "failed") {
    // First named failing check wins. An inquiry that failed on both the
    // document and the selfie is reported as a document failure, which is the
    // one the user must fix first.
    const reasons = failedCheckNames.map(mapPersonaCheckName).filter((r) => r !== "other");
    result.failureReason = reasons[0] ?? "other";
    if (result.failureReason === "underage") result.isOver18 = false;
  }

  if (status === "verified") {
    const over18 = deriveIsOver18FromIso(attrs["birthdate"], nowMs);
    if (over18 !== undefined) result.isOver18 = over18;

    // A selfie verdict only exists when the template ran a selfie check. Absent
    // means "not asked", which must stay undefined rather than become false —
    // toVerificationLevel() reads false as "asked and did not match".
    const selfie = attrs["selfie-status"] ?? attrs["selfie_status"];
    if (typeof selfie === "string") {
      result.selfieMatch = ["passed", "approved", "matched"].includes(selfie.toLowerCase());
    }

    const country = attrs["country-code"] ?? attrs["country_code"];
    if (typeof country === "string" && /^[A-Za-z]{2}$/.test(country)) {
      result.documentCountry = country.toUpperCase();
    }
    result.verifiedAt = new Date(nowMs).toISOString();
  }

  return result;
}

/** Persona event names that carry an inquiry we act on. */
const ACTIONABLE_EVENT_PREFIX = "inquiry.";
const IGNORED_EVENT_NAMES = new Set(["inquiry.created", "inquiry.started", "inquiry.transitioned"]);

/**
 * Normalize an already-SIGNATURE-VERIFIED Persona webhook body.
 *
 * Persona's envelope is JSON:API:
 *   data.attributes.name                        — the event name
 *   data.attributes.payload.data                — the inquiry resource
 *   data.attributes.payload.included[]          — verifications/reports
 *
 * Takes the parsed envelope rather than the raw string so that nothing can
 * reach normalization without passing signature verification first.
 */
export function normalizePersonaWebhook(
  parsed: unknown,
  nowMs: number = Date.now(),
): VerificationResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const attrs = (parsed as any)?.data?.attributes;
  if (!attrs || typeof attrs !== "object") return null;

  const name = typeof attrs.name === "string" ? attrs.name : "";
  if (!name.startsWith(ACTIONABLE_EVENT_PREFIX) || IGNORED_EVENT_NAMES.has(name)) return null;

  const inquiry = attrs.payload?.data;
  if (!inquiry || typeof inquiry !== "object") return null;

  const included: unknown[] = Array.isArray(attrs.payload?.included) ? attrs.payload.included : [];
  const failedCheckNames: string[] = [];
  for (const item of included) {
    const a = (item as any)?.attributes;
    if (!a || typeof a !== "object") continue;
    const st = String(a.status ?? "").toLowerCase();
    if (st !== "failed" && st !== "declined") continue;
    const label = (item as any)?.type ?? a["name"];
    if (typeof label === "string") failedCheckNames.push(label);
    const checks: unknown[] = Array.isArray(a.checks) ? a.checks : [];
    for (const c of checks) {
      const cs = String((c as any)?.status ?? "").toLowerCase();
      const cn = (c as any)?.name;
      if (cs === "failed" && typeof cn === "string") failedCheckNames.push(cn);
    }
  }

  // The event name is authoritative where the inquiry's own status is
  // ambiguous: `inquiry.failed` on an inquiry whose attributes say `completed`
  // is a failure, and `completed` alone must never read as a pass.
  const base = normalizePersonaInquiry(inquiry as PersonaInquiry, failedCheckNames, nowMs);
  if (!base) return null;
  if (name === "inquiry.failed" || name === "inquiry.declined") {
    if (base.status !== "failed") {
      base.status = "failed";
      base.failureReason = failedCheckNames.map(mapPersonaCheckName).find((r) => r !== "other") ?? "other";
      delete base.verifiedAt;
      delete base.documentCountry;
    }
  } else if (name === "inquiry.expired") {
    base.status = "expired";
  }
  return base;
}

// ── REST calls ───────────────────────────────────────────────────────────────

function apiKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env["PERSONA_API_KEY"];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error(
      "Persona is selected (IDENTITY_PROVIDER=persona) but PERSONA_API_KEY is not set.",
    );
  }
  return key;
}

async function personaCall(
  path: string,
  body: unknown | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const res = await fetch(`${PERSONA_API_BASE}${path}`, {
    method: body === null ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${apiKey(env)}`,
      "Persona-Version": PERSONA_API_VERSION,
      Accept: "application/json",
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Persona API ${res.status} on ${path}`);
  }
  return JSON.parse(text);
}

export async function personaCreateSession(
  req: VerificationRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerificationSession> {
  const templateId = env["PERSONA_TEMPLATE_ID"];
  if (typeof templateId !== "string" || templateId.trim().length === 0) {
    throw new Error("Persona is selected but PERSONA_TEMPLATE_ID is not set.");
  }
  const payload = {
    data: {
      attributes: {
        "inquiry-template-id": templateId,
        // reference-id is Persona's own idempotency/correlation handle. The
        // Portava user id goes here and NOT into any attribute Persona treats
        // as collected PII.
        "reference-id": req.userId,
        "redirect-uri": req.returnUrl,
      },
    },
  };
  const body = (await personaCall("/inquiries", payload, env)) as any;
  const id = typeof body?.data?.id === "string" ? body.data.id : "";
  // Persona returns a one-time link for the hosted flow.
  const link =
    body?.data?.attributes?.["one-time-link"] ??
    body?.meta?.["one-time-link"] ??
    "";
  if (!id || typeof link !== "string" || !link) {
    throw new Error("Persona returned an inquiry without an id or a one-time link");
  }
  return {
    provider: "persona",
    providerSessionId: id,
    redirectUrl: link,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

export async function personaGetSessionStatus(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerificationResult> {
  const body = (await personaCall(
    `/inquiries/${encodeURIComponent(providerSessionId)}`,
    null,
    env,
  )) as any;
  const normalized = normalizePersonaInquiry(body?.data ?? {}, [], Date.now());
  if (!normalized) throw new Error("Persona returned an unreadable inquiry");
  return normalized;
}

export async function personaRequestDeletion(
  /** The `inq_…` id stored in identity_verifications.provider_verification_ref. */
  redactionHandle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await personaCall(`/inquiries/${encodeURIComponent(redactionHandle)}/redact`, {}, env);
}

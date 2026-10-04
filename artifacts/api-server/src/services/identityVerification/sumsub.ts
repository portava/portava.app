/**
 * Sumsub adapter internals — the owner's PRIMARY identity provider.
 *
 * ── THE OWNER DECISION ───────────────────────────────────────────────────────
 *   "Use Sumsub as the primary identity provider behind the provider interface.
 *    Verify market coverage; fail closed and keep bookings unavailable where
 *    suitable verification is unsupported."
 *
 * "Behind the provider interface" is literal: this file exports the same four
 * internals `stripeIdentity.ts` and `persona.ts` export (create / normalize /
 * poll / redact) and `providers.ts` binds them to the SAME
 * `IdentityVerificationProvider` in types.ts. Nothing in that interface was
 * widened to suit Sumsub, and no second interface was introduced. The one
 * vocabulary addition is `NormalizedFailureReason = … | 'coverage_unsupported'`,
 * which is provider-agnostic and is argued for in types.ts.
 *
 * ── WHAT IS AND IS NOT CERTIFIED HERE ────────────────────────────────────────
 * Identical footing to the other two adapters, and said plainly because the
 * distinction is the reason the booking gate is still shut:
 *
 *   PROVEN WITHOUT AN ACCOUNT — the signature half. Sumsub's webhook scheme is
 *   a keyed digest over bytes we control, verified by
 *   `verifyPayloadDigestSignature` (webhookSignature.ts) and exercised in
 *   `test/sumsubIdentityProvider.test.ts` against real HMAC material.
 *
 *   NOT PROVEN — the payload half. Which JSON fields carry the applicant id,
 *   the review status, the reject labels and the document country is read off
 *   Sumsub's published shapes and has NEVER been run against Sumsub, sandbox or
 *   live. No credential was added and no request was sent by this change.
 *
 * Nothing here adds `sumsub` to `readiness.IMPLEMENTED_PROVIDERS`, so this
 * adapter is UNREACHABLE: `identityProviderStatus()` reports it non-operational
 * and `lib/rentBuddyKycGate.ts` refuses every booking path with 503. The single
 * change that would activate it is named in readiness.ts.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 * Invariants 1 and 2 of `docs/trust/verified-foundation-plan.md` are structural
 * here as in the other adapters: normalization returns a `VerificationResult`,
 * which has no field able to hold a document image, a document number or a date
 * of birth. Sumsub's applicant payload carries `info.dob`, `info.idDocs[]`,
 * names and document numbers; `normalizeSumsubApplicant` reads `info.dob`
 * ONLY through `deriveIsOver18FromIso`, which can return nothing but a boolean,
 * and has no branch that can copy any other field out. Nothing on this path is
 * logged.
 *
 * Mapping (vendor-documented shapes, unverified against the vendor):
 *   createSession            -> POST /resources/applicants?levelName=…
 *                               then POST /resources/sdkIntegrations/levels/
 *                                        {levelName}/websdkLink
 *   handleWebhook            -> verify X-Payload-Digest, then normalize
 *                               applicantReviewed / applicantPending /
 *                               applicantOnHold / applicantCreated /
 *                               applicantReset / applicantDeleted
 *   getSessionStatus         -> GET  /resources/applicants/{id}/status
 *   requestProviderDeletion  -> DELETE /resources/applicants/{id}/one
 */

import crypto from "node:crypto";
import type {
  NormalizedFailureReason,
  NormalizedVerificationStatus,
  VerificationRequest,
  VerificationResult,
  VerificationSession,
} from "./types.js";
import { deriveIsOver18FromIso } from "./stripeIdentity.js";
import { assertProviderKeyAllowed, assertWebhookLivemodeAllowed } from "../../lib/paymentsMode.js";

const SUMSUB_API_BASE = "https://api.sumsub.com";
const REQUEST_TIMEOUT_MS = 10_000;

/** Header names Sumsub signs its webhooks with. Bound here, scheme lives in webhookSignature.ts. */
export const SUMSUB_DIGEST_HEADER = "x-payload-digest";
export const SUMSUB_DIGEST_ALG_HEADER = "x-payload-digest-alg";

/** Env vars naming the dashboard-configured verification level for each of our two levels. */
export const SUMSUB_LEVEL_ENV: Record<VerificationRequest["level"], string> = {
  id: "SUMSUB_LEVEL_NAME_ID",
  id_selfie: "SUMSUB_LEVEL_NAME_ID_SELFIE",
};

// ── status normalization ─────────────────────────────────────────────────────

/**
 * Sumsub `reviewStatus` → normalized status, for every status that is NOT
 * `completed`.
 *
 * `completed` is absent on purpose: it is not an outcome on its own, it means
 * "a moderator or the automation has finished", and the outcome is in
 * `reviewResult.reviewAnswer`. Returning `verified` for `completed` would hand
 * a government-ID badge to every applicant Sumsub finished REJECTING. The
 * discriminator is resolved by `normalizeSumsubReview`, which is the only
 * function that can see both fields.
 *
 * THE DEFAULT IS `pending`. A status Sumsub invents later must cost a poll, not
 * grant standing.
 */
export function mapSumsubReviewStatus(status: unknown): NormalizedVerificationStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "init":
      return "created";
    case "pending":
    case "queued":
    case "prechecked":
    case "awaitinguser":
    case "onhold":
      return "processing";
    case "completed":
      // Unresolvable here — see above. `pending` is the safe placeholder and
      // `normalizeSumsubReview` always overrides it when it has the answer.
      return "pending";
    default:
      return "pending";
  }
}

/**
 * Reject labels that mean "we do not cover this market", as distinct from
 * "this check failed".
 *
 * ── WHY THIS IS A PATTERN AND NOT A LIST ─────────────────────────────────────
 * Sumsub's reject-label vocabulary is long, is extended, and the exact spelling
 * of its coverage labels is part of the payload half this change could not
 * verify. A transcribed list would be a guess that silently stops matching; a
 * pattern over the three words that can only mean a place — COUNTRY, REGION,
 * JURISDICTION — matches the family without pretending to know its members.
 *
 * It is deliberately NARROW. `DOCUMENT_TYPE_NOT_SUPPORTED` is not here: it is
 * genuinely ambiguous between "no document type we accept exists in this
 * market" (coverage) and "you photographed a library card" (user-fixable), and
 * the user-fixable reading is the one that costs nothing if wrong. An
 * unrecognised label maps to `other`, never to a coverage refusal and never to
 * a pass — guessing coverage from an unknown label would tell a person their
 * country is unsupported on no evidence.
 *
 * Matched on WHOLE UNDERSCORE-SEPARATED TOKENS rather than with `\b`: `_` is a
 * word character in JavaScript regexes, so `/\bCOUNTRY\b/` does NOT match
 * `COUNTRY_NOT_SUPPORTED` — which is the one label the family is named after.
 * Tokenising also stops `COUNTRY` matching inside some future
 * `CROSS_COUNTRYSIDE_FOO`.
 */
const COVERAGE_LABEL_TOKENS = new Set([
  "COUNTRY",
  "COUNTRIES",
  "REGION",
  "REGIONS",
  "JURISDICTION",
  "JURISDICTIONS",
]);

function namesAMarket(label: string): boolean {
  for (const token of label.split(/[^A-Z0-9]+/)) {
    if (COVERAGE_LABEL_TOKENS.has(token)) return true;
  }
  return false;
}

/**
 * Sumsub reject labels → `NormalizedFailureReason`.
 *
 * COVERAGE IS TESTED FIRST and it wins outright. A refusal that is partly
 * "we do not operate there" is a coverage refusal: the person cannot fix it by
 * retaking a photo, and telling them to try again in better light would be a
 * lie about why they were turned away. This ordering is the whole substance of
 * "stop flattening country_not_supported" — see types.ts.
 */
export function mapSumsubRejectLabels(labels: readonly unknown[]): NormalizedFailureReason {
  const names = labels
    .filter((l): l is string => typeof l === "string" && l.length > 0)
    .map((l) => l.toUpperCase());
  if (names.length === 0) return "other";

  if (names.some(namesAMarket)) return "coverage_unsupported";
  // Age before selfie before document: the order the person must act on them.
  if (names.some((n) => n.includes("AGE") || n.includes("UNDERAGE") || n.includes("BIRTH"))) {
    return "underage";
  }
  if (names.some((n) => n.includes("SELFIE") || n.includes("FACE") || n.includes("LIVENESS"))) {
    return "selfie_mismatch";
  }
  if (names.some((n) => n.includes("DOCUMENT") || n.includes("ID_") || n.includes("FORGERY"))) {
    return "document_invalid";
  }
  if (names.some((n) => n.includes("APPLICANT_INTERRUPTED") || n.includes("INCOMPLETE"))) {
    return "abandoned";
  }
  return "other";
}

/**
 * Sumsub country codes are ISO 3166-1 **alpha-3**; `VerificationResult.
 * documentCountry` is documented alpha-2. This returns a code only when the
 * payload already gave us alpha-2, and `null` otherwise.
 *
 * ── WHY ALPHA-3 IS DROPPED RATHER THAN TRUNCATED ─────────────────────────────
 * Taking the first two letters works for PHL→PH and DEU→DE and is CATASTROPHIC
 * for AUT: Austria becomes AU, Australia. `document_country` is a compliance
 * field and the market-coverage list is keyed on it, so a wrong value is worse
 * than a missing one in both directions — it can make an unsupported market
 * look supported.
 *
 * A real alpha-3 → alpha-2 mapping is a 250-row ISO table and therefore a DATA
 * INPUT, like the coverage manifest beside it (marketCoverage.ts). Until one is
 * mounted, `documentCountry` stays unset for Sumsub, which reads as "not known"
 * everywhere it is consumed — `routes/verification.ts` writes
 * `document_country: null`, and null is unknown. This is named in the PR as an
 * open seam rather than papered over.
 */
export function normalizeSumsubCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

interface SumsubReviewResult {
  reviewAnswer?: unknown;
  reviewRejectType?: unknown;
  rejectLabels?: unknown;
}

export interface SumsubApplicantReview {
  /** Sumsub applicant id — the handle for both the session and the redaction. */
  applicantId?: unknown;
  reviewStatus?: unknown;
  reviewResult?: SumsubReviewResult | null;
  /** The dashboard level the applicant was created under. */
  levelName?: unknown;
  /** Present on the applicant resource, absent on most webhooks. */
  info?: { dob?: unknown; country?: unknown } | null;
}

export interface NormalizeSumsubOptions {
  /**
   * The dashboard level name configured for `id_selfie`. Supplied by the
   * provider binding from env so this function stays pure; when it is absent
   * `selfieMatch` stays UNDEFINED rather than becoming `false` —
   * `toVerificationLevel()` reads `false` as "asked and did not match".
   */
  selfieLevelName?: string | undefined;
  nowMs?: number;
}

/**
 * Normalize one Sumsub review into the only shape the rest of the app consumes.
 * Pure — no I/O, no env, no clock except the injected one.
 */
export function normalizeSumsubReview(
  review: SumsubApplicantReview,
  options: NormalizeSumsubOptions = {},
): VerificationResult | null {
  const id = typeof review.applicantId === "string" ? review.applicantId.trim() : "";
  if (!id) return null;

  const nowMs = options.nowMs ?? Date.now();
  const rawStatus = String(review.reviewStatus ?? "").toLowerCase();
  let status = mapSumsubReviewStatus(review.reviewStatus);

  const answer = String(review.reviewResult?.reviewAnswer ?? "").toUpperCase();
  if (rawStatus === "completed") {
    if (answer === "GREEN") status = "verified";
    else if (answer === "RED") status = "failed";
    // else: completed with no readable answer. Stays `pending` — an
    // UNREADABLE verdict is not a verdict, and certainly not a pass.
  } else if (answer === "RED") {
    // A RED answer on a non-completed status (Sumsub can attach one to a
    // retry-able state) is still a refusal, never standing.
    status = "failed";
  }

  const result: VerificationResult = {
    provider: "sumsub",
    providerSessionId: id,
    // Sumsub's deletion primitive takes the APPLICANT id, so the applicant id
    // is the handle `providerErasure.ts` needs. Set for EVERY state, because a
    // rejected applicant uploaded the same government ID as an approved one and
    // a null ref is reported as "nothing to redact".
    providerVerificationRef: id,
    status,
  };

  if (status === "failed") {
    const labels = Array.isArray(review.reviewResult?.rejectLabels)
      ? (review.reviewResult?.rejectLabels as unknown[])
      : [];
    result.failureReason = mapSumsubRejectLabels(labels);
    // `underage` is the one failure that carries a positive age finding.
    // `coverage_unsupported` carries NO finding about the person at all, which
    // is exactly why it is a separate reason.
    if (result.failureReason === "underage") result.isOver18 = false;
  }

  if (status === "verified") {
    const over18 = deriveIsOver18FromIso(review.info?.dob, nowMs);
    if (over18 !== undefined) result.isOver18 = over18;

    // A GREEN on the selfie level verified the selfie; Sumsub does not return
    // GREEN with a failing required step. On any other level it stays
    // undefined, so `toVerificationLevel()` yields `id_verified`.
    const selfieLevel = options.selfieLevelName;
    if (
      typeof selfieLevel === "string" &&
      selfieLevel.length > 0 &&
      typeof review.levelName === "string" &&
      review.levelName === selfieLevel
    ) {
      result.selfieMatch = true;
    }

    const country = normalizeSumsubCountry(review.info?.country);
    if (country !== null) result.documentCountry = country;
    result.verifiedAt = new Date(nowMs).toISOString();
  }

  return result;
}

/** Webhook event types that carry a review we act on. Anything else is null. */
const ACTIONABLE_EVENT_TYPES = new Set([
  "applicantCreated",
  "applicantPending",
  "applicantOnHold",
  "applicantReviewed",
  "applicantReset",
  "applicantDeleted",
]);

/**
 * Normalize an already-SIGNATURE-VERIFIED Sumsub webhook body.
 *
 * Takes the PARSED envelope, not the raw string, so that no caller can reach
 * normalization without having gone through signature verification first — the
 * parse happens in providers.ts after the verify call returns.
 *
 * Sumsub's envelope is flat:
 *   applicantId, externalUserId, levelName, type, reviewStatus,
 *   reviewResult: { reviewAnswer, reviewRejectType, rejectLabels },
 *   sandboxMode
 */
export function normalizeSumsubWebhook(
  parsed: unknown,
  options: NormalizeSumsubOptions = {},
): VerificationResult | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const envelope = parsed as Record<string, unknown> & { sandboxMode?: unknown; type?: unknown };

  // `sandboxMode: false` is Sumsub's statement that this is a PRODUCTION
  // applicant. Refused unless live is explicitly allowed, by the same guard
  // the Stripe normaliser applies to `livemode: true` — a live event processes
  // a real person's government ID and bills for it. An ABSENT flag is not a
  // live claim (invariant: only the explicit boolean counts).
  assertWebhookLivemodeAllowed("sumsub", envelope.sandboxMode === false ? true : undefined);

  if (typeof envelope.type !== "string" || !ACTIONABLE_EVENT_TYPES.has(envelope.type)) return null;

  const base = normalizeSumsubReview(envelope as SumsubApplicantReview, options);
  if (!base) return null;

  // `applicantReset` wipes the applicant's checks at Sumsub, so whatever
  // standing the row held is no longer evidenced. Map it to `canceled` rather
  // than leaving a stale `verified` in place. `applicantDeleted` is the same
  // in kind and the ref must still be persisted, which the result already does.
  if (envelope.type === "applicantReset") base.status = "canceled";
  if (envelope.type === "applicantDeleted") base.status = "canceled";
  if (base.status === "canceled") {
    delete base.verifiedAt;
    delete base.documentCountry;
    delete base.selfieMatch;
  }
  return base;
}

// ── REST calls ───────────────────────────────────────────────────────────────

/**
 * ── NO CREDENTIAL IS CARRIED BY THIS REPOSITORY ──────────────────────────────
 * `SUMSUB_APP_TOKEN` and `SUMSUB_SECRET_KEY` are read from the environment and
 * are not written to `.env.example`, to any fixture, or to any default. Every
 * function below throws before it builds a request when either is missing, and
 * `assertProviderKeyAllowed` refuses a token whose prefix is not a documented
 * SANDBOX prefix unless live is explicitly permitted (lib/paymentsMode.ts). The
 * whole adapter is therefore testable with no network: the normalizers above
 * are pure and the calls below cannot be reached without a key.
 */
function appToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env["SUMSUB_APP_TOKEN"];
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Sumsub is selected (IDENTITY_PROVIDER=sumsub) but SUMSUB_APP_TOKEN is not set.");
  }
  // live/unknown-prefix refused BEFORE any fetch
  assertProviderKeyAllowed("sumsub", token, env);
  return token;
}

function secretKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env["SUMSUB_SECRET_KEY"];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Sumsub is selected (IDENTITY_PROVIDER=sumsub) but SUMSUB_SECRET_KEY is not set.");
  }
  return key;
}

/**
 * Sumsub request signature: hex HMAC-SHA256 over
 * `${unixSeconds}${METHOD}${pathWithQuery}${body}`, keyed by the secret key.
 *
 * Exported so the construction is testable without a network call or a real
 * credential — the inputs are all supplied by the caller.
 */
export function signSumsubRequest(input: {
  secret: string;
  timestampSeconds: number;
  method: string;
  pathWithQuery: string;
  body: string;
}): string {
  return crypto
    .createHmac("sha256", input.secret)
    .update(
      `${input.timestampSeconds}${input.method.toUpperCase()}${input.pathWithQuery}${input.body}`,
      "utf8",
    )
    .digest("hex");
}

async function sumsubCall(
  method: "GET" | "POST" | "DELETE",
  pathWithQuery: string,
  body: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const token = appToken(env);
  const secret = secretKey(env);
  const ts = Math.floor(Date.now() / 1000);
  const payload = body ?? "";
  const signature = signSumsubRequest({
    secret,
    timestampSeconds: ts,
    method,
    pathWithQuery,
    body: payload,
  });

  const res = await fetch(`${SUMSUB_API_BASE}${pathWithQuery}`, {
    method,
    headers: {
      "X-App-Token": token,
      "X-App-Access-Ts": String(ts),
      "X-App-Access-Sig": signature,
      Accept: "application/json",
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === null ? {} : { body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    // Sumsub's error envelope can echo the request. Only the status and the
    // documented numeric code are surfaced; the body is never embedded, and
    // neither the token nor the signature appears in the message.
    let code = "";
    try {
      code = String((JSON.parse(text) as { code?: unknown } | null)?.code ?? "");
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Sumsub API ${res.status}${code ? ` (${code})` : ""} on ${method} ${pathWithQuery}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Sumsub API returned an unreadable body on ${method} ${pathWithQuery}`);
  }
}

/** The dashboard level name for one of our two levels. Unset is a refusal, not a default. */
export function sumsubLevelName(
  level: VerificationRequest["level"],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envVar = SUMSUB_LEVEL_ENV[level];
  const name = env[envVar];
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`Sumsub is selected but ${envVar} is not set, so level "${level}" cannot be requested.`);
  }
  return name.trim();
}

export async function sumsubCreateSession(
  req: VerificationRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerificationSession> {
  const levelName = sumsubLevelName(req.level, env);

  // `externalUserId` is Sumsub's correlation handle. The Portava user id goes
  // there and NOWHERE that Sumsub treats as collected applicant data.
  const applicant = (await sumsubCall(
    "POST",
    `/resources/applicants?levelName=${encodeURIComponent(levelName)}`,
    JSON.stringify({ externalUserId: req.userId }),
    env,
  )) as { id?: unknown };
  const applicantId = typeof applicant.id === "string" ? applicant.id : "";
  if (!applicantId) {
    throw new Error("Sumsub returned an applicant without an id");
  }

  const link = (await sumsubCall(
    "POST",
    `/resources/sdkIntegrations/levels/${encodeURIComponent(levelName)}/websdkLink` +
      `?externalUserId=${encodeURIComponent(req.userId)}`,
    JSON.stringify({ ttlInSecs: 3600 }),
    env,
  )) as { url?: unknown };
  const url = typeof link.url === "string" ? link.url : "";
  if (!url) {
    throw new Error("Sumsub returned no hosted verification link");
  }

  return {
    provider: "sumsub",
    providerSessionId: applicantId,
    redirectUrl: url,
    // The link was requested with a 1 h TTL; the row's own expiry is what the
    // client polls against, so the conservative value is the safe one.
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

/**
 * Turn a status-resource body into a result, or THROW.
 *
 * Split out of `sumsubGetSessionStatus` so the refusal is reachable from a test
 * with no network and no credential — the throw is the load-bearing half and a
 * branch only a live vendor could exercise is a branch nothing guards.
 *
 * AN UNREADABLE STATUS THROWS. It must never resolve to a neutral `pending`, an
 * absent row, an empty object, or anything a caller could read as "no problem":
 * `refreshPendingFromProvider` in routes/verification.ts degrades a THROW to the
 * stored row, which is the last state actually evidenced, whereas a soft
 * `pending` would be WRITTEN over whatever the row already held.
 */
export function sumsubStatusResultOrThrow(
  providerSessionId: string,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): VerificationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Sumsub returned an unreadable applicant status");
  }
  // A status resource with NO `reviewStatus` is unreadable, and the distinction
  // from an unrecognised one is deliberate:
  //
  //   missing / not a string -> UNREADABLE -> throw. `{}` is the dangerous case:
  //     the applicant id is supplied by us, so the normalizer would happily
  //     produce a well-formed `pending` result out of an empty body, and
  //     `refreshPendingFromProvider` would WRITE that over a row that already
  //     said `processing`. A failed read must never overwrite a real state.
  //   a string we do not recognise -> READABLE but unknown -> `pending`, which
  //     is the documented safe default for a status the vendor adds later.
  const reviewStatus = (body as Record<string, unknown>)["reviewStatus"];
  if (typeof reviewStatus !== "string" || reviewStatus.trim().length === 0) {
    throw new Error("Sumsub returned an unreadable applicant status");
  }
  // The status resource does not echo the applicant id, so it is carried over
  // from the id we asked about. Without this the normalizer would see no id and
  // return null, and a null poll result is the "unreadable status read as
  // nothing happened" failure this gate cannot have.
  const selfieLevelName = env[SUMSUB_LEVEL_ENV.id_selfie];
  const normalized = normalizeSumsubReview(
    { ...(body as Record<string, unknown>), applicantId: providerSessionId } as SumsubApplicantReview,
    { selfieLevelName: typeof selfieLevelName === "string" ? selfieLevelName : undefined },
  );
  if (!normalized) {
    throw new Error("Sumsub returned an unreadable applicant status");
  }
  return normalized;
}

export async function sumsubGetSessionStatus(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerificationResult> {
  const body = await sumsubCall(
    "GET",
    `/resources/applicants/${encodeURIComponent(providerSessionId)}/status`,
    null,
    env,
  );
  return sumsubStatusResultOrThrow(providerSessionId, body, env);
}

export async function sumsubRequestDeletion(
  /** The applicant id stored in identity_verifications.provider_verification_ref. */
  redactionHandle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Sumsub's GDPR primitive permanently deletes the applicant profile and the
  // documents attached to it. It THROWS on failure, which is what lets
  // providerErasure.ts record a named failed step instead of a silent success.
  await sumsubCall(
    "DELETE",
    `/resources/applicants/${encodeURIComponent(redactionHandle)}/one`,
    null,
    env,
  );
}

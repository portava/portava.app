/**
 * sensingIngest — §4.3's Signal Ingest API. The transport the anonymous sensing
 * store has never had.
 *
 *   POST /v1/sensing/contributions
 *     Accepts ONE privacy-reduced device reading under an OPAQUE SHORT-LIVED
 *     CREDENTIAL. No user session, no account, no device handle, no coordinate.
 *
 * ── WHY THIS FILE EXISTS NOW AND NOT BEFORE ──────────────────────────────────
 * The store (2315), its replay key and time bounds (2340), the contribution
 * session (2480), the policy, the eligibility ladder and the aggregation have
 * all existed and been inert, because a transport forces a privacy decision
 * nobody had taken: WHO may obtain a credential. `SENSING_AUTH_POSTURE` read
 * `undecided` and `sensingEligibility` refused every caller with
 * `posture_undecided`.
 *
 * On 2026-09-16 the owner took it — `anonymous_capable`, Option B STAGED
 * (lib/sensingAuthPosture.ts:82) — and applied 2315 + 2340 + 2480 to production
 * the same day (src/lib/capability/production-applied-migrations.json, version
 * 20260916174227; the table and its exact 2315 column list are visible in
 * src/lib/capability/snapshots/20260922-production-schema.json). With the
 * posture decided, eligibility returning true still admits nobody while nothing
 * calls it. This route is the thing that calls it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT MAKES THIS ANONYMOUS, STATED AS PROPERTIES RATHER THAN INTENT
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 1. IT AUTHENTICATES A BEARER, NOT A PERSON. There is no `requireUser` and no
 *    `optionalUser` in this file. The only credential is an opaque bearer issued
 *    by lib/sensingContributionSession, presented as `Authorization: Bearer` or
 *    `X-Sensing-Credential`. The server stores only its HMAC
 *    (deriveSensingCredentialHash), so a leaked session table cannot mint one.
 *
 * 2. IT NEVER READS OR WRITES AN IDENTITY. `actor_id` appears nowhere in this
 *    file, `location_snapshots` is never queried, and the two tables it touches
 *    have no identity column to consult: 2315's postconditions refuse eleven
 *    identity-shaped column names outright, and 2480's session row carries none
 *    either. The contrast with routes/intel.ts is the point — that surface is
 *    `requireUser`-bound human-claim capture whose actor id IS the storage key.
 *    Nothing here can be joined to it.
 *
 * 3. ELIGIBILITY AND INGEST ARE SEPARATE, WHICH IS §3'S OWN REQUIREMENT:
 *    "eligibility proves an authorized participating device; ingest receives an
 *    opaque short-lived credential." So this route does NOT re-run
 *    `sensingEligibility` against the requester — doing so would require an
 *    identity at ingest and defeat the separation. It enforces the part of the
 *    posture that survives into ingest: the STAGE. A session whose issuance
 *    class is `unattested_device` is refused while
 *    SENSING_ALLOW_UNATTESTED_DEVICES is false, so "staged" is a property of
 *    the ingest path and not only of the issuer.
 *
 * 4. THE LADDER IS THE EXISTING ONE, WALKED IN ORDER, NOT REIMPLEMENTED.
 *
 *      pepper posture      lib/sensingAnonService.sensingPepperPosture
 *      posture decided     lib/sensingAuthPosture.SENSING_AUTH_POSTURE
 *      credential present  this file (transport concern only)
 *      schema validation   zod, then the store's own named refusals
 *      session validity    lib/sensingContributionSession.admitWithSensingSession
 *        └ existence, credential match, revoked, not_started, expired, budget
 *      issuance stage      lib/sensingAuthPosture.SENSING_ALLOW_UNATTESTED_DEVICES
 *      purpose scopes      the SESSION's own scopes, never the caller's claim
 *      admission policy    lib/sensingContributionPolicy.admitSensingContribution
 *        └ precision ceiling, retention, reduction version, credential epoch
 *      time bounds         2340's CHECK, mirrored before the round trip
 *      write               lib/sensingAnonService.recordAnonSensingContribution
 *      replay              2340's UNIQUE (cohort_key, contributor_token) ⇒ 23505
 *      budget              sensing_session_consume, AFTER a non-duplicate write
 *
 *    There is no second copy of any threshold, scope list or time bound here.
 *
 * 5. IT FAILS CLOSED ON THE PEPPER, BY NAME. SENSING_CONTRIBUTOR_PEPPER is an
 *    operator secret and is set in no environment in this repository. Without
 *    it, `sensingPepper()` would fall back to INTEL_GROUP_KEY_SECRET and then
 *    SESSION_SECRET — and a contributor token keyed on the session-signing
 *    secret becomes unrevokable the moment that secret is rotated for an
 *    unrelated reason. So this route refuses 503 before it touches a client or
 *    derives anything, and the refusal NAMES the variable. It never falls back.
 *
 * 6. REPLAY COSTS NOTHING AND CHANGES NOTHING. A duplicate is 2340's unique
 *    violation, which the store reports as a SUCCESS that wrote no row. The
 *    response says `duplicate: true` and NO budget is consumed — a replay must
 *    not be a way to drain a device's own budget, and it must not be an error
 *    either, because an honest retry is indistinguishable from it.
 *
 * ── WHAT THIS ROUTE DOES NOT DO ──────────────────────────────────────────────
 * It does not read, compute or return an aggregate, a count, a cohort size or a
 * publish decision. §3's verbs are distinct permissions and
 * SENSING_ANON_POLICY_V1 grants this path collect / retain / aggregate and NOT
 * infer / personalize / surface / share. Handing a contributing device any
 * number about its cohort would be `surface`, which nobody has granted. The
 * response carries back only what the caller already sent, reduced.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  SENSING_AUTH_POSTURE,
  SENSING_ALLOW_UNATTESTED_DEVICES,
} from "../lib/sensingAuthPosture.js";
import {
  SENSING_PEPPER_ENV,
  sensingPepperPosture,
  recordAnonSensingContribution,
} from "../lib/sensingAnonService.js";
import {
  SENSING_BUCKET_MAX,
  SENSING_BUCKET_MIN,
  SENSING_MAX_TTL_SECONDS,
  deriveSensingCredentialHash,
} from "../lib/sensingAnonStore.js";
import {
  SENSING_SESSIONS_TABLE,
  admitWithSensingSession,
  consumeSensingSessionRpc,
  type SensingContributionSessionRow,
} from "../lib/sensingContributionSession.js";

const router = Router();

/**
 * The session table is spelled as a LITERAL at the `.from()` below, not as
 * `SENSING_SESSIONS_TABLE`, and this tie is why that is safe.
 *
 * `check:write-path-columns` and `check:schema-references` resolve table names
 * out of the TypeScript AST. Both read `.from(<string literal>)`; neither
 * follows an imported const, and `src/scripts/lib/schemaReferenceExtract.ts`
 * says why in its own words — a builder or a name that lives in another module
 * "is a genuine blind spot rather than one this pass can honestly close".
 * Passing the imported const made this route's nine-column select invisible to
 * both checks: the columns below could have been renamed out from under it and
 * nothing would have gone red.
 *
 * The literal restores the checks. The assignment restores the single source of
 * truth: `SENSING_SESSIONS_TABLE` has the literal type
 * `"sensing_contribution_sessions"`, so if 2480's table is ever renamed there
 * and not here, THIS LINE stops compiling. A drift is a type error, not a
 * runtime 42P01 in production.
 */
const _sensingSessionsTableTie: typeof SENSING_SESSIONS_TABLE =
  "sensing_contribution_sessions";
void _sensingSessionsTableTie;

/**
 * What a device may send. Every field is either already reduced or is reduced
 * before storage; there is deliberately no field an account, device id,
 * installation id, session id or coordinate pair could occupy. `zoneId` is the
 * one free-text field and lib/sensingContributionPolicy refuses a
 * coordinate-shaped one.
 */
/**
 * The device's reduced features (3312), spelled as the wire contract spells
 * them — docs/contracts/sensing-contribution-wire-v1.json, which
 * sensingIngestWireContract.test.ts holds this schema to. Bands are the
 * store's (lib/sensingAnonStore.normalizeSensingFeatures re-checks them and
 * 3312's CHECKs make anything outside them unrepresentable). `.strict()` at
 * both levels: a key this schema does not name is refused, so a coordinate
 * cannot ride in under a new name.
 */
const acousticFeaturesSchema = z
  .object({
    energyBucket: z.number().int().min(0).max(4),
    rhythmBucket: z.enum(["none", "irregular", "steady", "strong"]),
    confidenceCenti: z.number().int().min(0).max(100),
  })
  .strict();

export const contributionFeaturesSchema = z
  .object({
    zonePrecision: z.number().int().min(1).max(12),
    placeCandidate: z.string().min(1).max(128).nullable(),
    movementState: z.enum(["stationary", "pedestrian", "vehicular", "unknown"]),
    motionEnergyCenti: z.number().int().min(0).max(100).nullable(),
    periodicityCenti: z.number().int().min(0).max(100).nullable(),
    dwellBucket: z.number().int().min(0).max(4).nullable(),
    transition: z.enum(["arrival", "departure", "none", "unknown"]),
    transportMode: z.enum(["stationary", "pedestrian", "cycling", "vehicular"]).nullable(),
    transportModeCenti: z.number().int().min(0).max(100).nullable(),
    density: z.enum(["unknown", "sparse", "moderate", "busy", "packed"]),
    boundedMovement: z.boolean().nullable(),
    sensorHealthCenti: z.number().int().min(0).max(100),
    acoustic: acousticFeaturesSchema.optional(),
  })
  .strict();

export const contributionSchema = z
  .object({
    commitment: z.string().min(16).max(128),
    rotationEpoch: z.number().int().nonnegative(),
    zoneId: z.string().min(1).max(128),
    observedAtMs: z.number().int(),
    signalBucket: z.number().int().min(SENSING_BUCKET_MIN).max(SENSING_BUCKET_MAX),
    groupTag: z.string().min(1).max(128).nullish(),
    ttlSeconds: z.number().int().positive().max(SENSING_MAX_TTL_SECONDS).optional(),
    reductionVersion: z.number().int().positive().optional(),
    purposeScopes: z.array(z.string()).max(8).optional(),
    features: contributionFeaturesSchema.optional(),
  })
  .strict();

/**
 * The bearer, from either header. `.strict()` above refuses a body field, and
 * the credential is deliberately NOT accepted in the body: a bearer in a JSON
 * payload is a bearer in every request log that records payloads.
 */
export function readSensingCredential(req: Request): string | null {
  const auth = req.get("authorization");
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  const header = req.get("x-sensing-credential");
  if (typeof header === "string" && header.trim().length > 0) return header.trim();
  return null;
}

/**
 * Read the session row for a presented credential.
 *
 * SELECTS 2480's columns BY NAME — never `*`. If a later migration ever added
 * an identity column to the session table (2481 would add
 * `issued_to_profile_id`, and lib/sensingAuthPosture records why it must not be
 * applied under this posture), this route would still not read it. The lookup
 * is by the credential's HMAC; the bearer itself is never stored and never
 * logged.
 */
async function readSensingSession(
  db: any,
  credential: string,
): Promise<{ ok: true; row: SensingContributionSessionRow | null } | { ok: false; error: string }> {
  try {
    const { data, error } = await db
      .from("sensing_contribution_sessions")
      .select(
        "credential_hash, policy_version, purpose_scopes, reduction_version, issuance_class, budget_cohorts_remaining, starts_at, expires_at, revoked_at",
      )
      .eq("credential_hash", deriveSensingCredentialHash(credential))
      .limit(1);
    if (error) return { ok: false, error: error.message ?? "session_read_failed" };
    const rows = (data ?? []) as SensingContributionSessionRow[];
    return { ok: true, row: rows.length > 0 ? rows[0]! : null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "session_read_threw" };
  }
}

/**
 * Refusals that are about the CREDENTIAL rather than the payload. They are
 * answered 401 so a device knows to re-issue rather than to fix its body, and
 * they are returned by their own names (`session_expired`, `session_revoked`,
 * `session_not_started`, `session_unknown`, `session_credential_mismatch`)
 * because §4.3 requires stale credentials to be rejected and a client that
 * cannot tell "expired" from "malformed" cannot recover.
 */
const CREDENTIAL_REFUSALS = new Set([
  "session_unknown",
  "session_credential_mismatch",
  "session_revoked",
  "session_not_started",
  "session_expired",
]);

router.post(
  "/v1/sensing/contributions",
  asyncHandler(async (req, res) => {
    // ── 1. The pepper. Before a client, before a derivation, before anything.
    // Fail CLOSED and BY NAME: the fallback chain would otherwise key every
    // contributor token on SESSION_SECRET, and rotating that — a routine
    // security action taken for unrelated reasons — silently destroys every
    // contributor's ability to withdraw until their rows expire.
    const pepper = sensingPepperPosture();
    if (!pepper.ok) {
      logger.warn({ reason: pepper.reason }, "sensing ingest refused: dedicated pepper is not configured");
      return sendError(
        res,
        "server_not_configured",
        `${SENSING_PEPPER_ENV} is not configured (${pepper.reason}); sensing ingest refuses rather than deriving a contributor token under a fallback secret.`,
      );
    }

    // ── 2. The posture. Seeded `undecided` refused every caller by design; a
    // regression to it must close this route, not open it.
    if (SENSING_AUTH_POSTURE === "undecided") {
      return sendError(res, "feature_disabled", "sensing contribution is not available");
    }

    // ── 3. The bearer.
    const credential = readSensingCredential(req);
    if (!credential) {
      return sendError(res, "unauthenticated", "a sensing contribution credential is required");
    }

    // ── 4. Schema validation (§4.3).
    const parsed = contributionSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid contribution");
    }
    const body = parsed.data;

    const db = getServiceClient();
    if (!db) return sendError(res, "server_not_configured", "service client unavailable");

    // ── 5. The session. A read that FAILED is not a session that is missing:
    // §4.3 — "Ingest must fail explicitly on schema/permission/infrastructure
    // failure; never return a plausible empty world."
    const session = await readSensingSession(db, credential);
    if (!session.ok) {
      logger.warn({ error: session.error }, "sensing ingest could not read the contribution session");
      return sendError(res, "db_error", "contribution session could not be read");
    }

    const nowMs = Date.now();

    // ── 6. Option B is STAGED, and the stage is enforced here too. An
    // unattested-device session is refused while the owner has not accepted
    // that exposure, even though 2480 can represent one and production accepts
    // all three issuance classes.
    // Widened deliberately: the constant is a `false` LITERAL today, so a direct
    // comparison is narrowed away at compile time and the branch would read as
    // dead code. The branch is not dead — it is the switch the owner flips when
    // the unattested-device exposure is accepted — so the value is read as a
    // boolean and the check stays a real one.
    const allowUnattested: boolean = SENSING_ALLOW_UNATTESTED_DEVICES;
    if (session.row && session.row.issuance_class === "unattested_device" && !allowUnattested) {
      return sendError(res, "forbidden", "session_issuance_class_not_admitted");
    }

    // ── 7. The full admission ladder, in the module that owns it. Session
    // validity, then the session's OWN purpose scopes (never the caller's
    // claim about them), then the policy's precision / retention / capability /
    // credential-epoch rules, then the store's own validation — whose refusals
    // (epoch_does_not_match_observation, observed_at_in_future,
    // observed_at_too_old, ...) mirror 2340's CHECK before the round trip.
    const admission = admitWithSensingSession(
      session.row,
      credential,
      {
        commitment: body.commitment,
        rotationEpoch: body.rotationEpoch,
        groupTag: body.groupTag ?? null,
        zoneId: body.zoneId,
        observedAtMs: body.observedAtMs,
        signalBucket: body.signalBucket,
        ttlSeconds: body.ttlSeconds,
        reductionVersion: body.reductionVersion,
        purposeScopes: body.purposeScopes,
      },
      nowMs,
    );

    if (admission.admitted !== true) {
      const reason = String(admission.reason);
      if (reason === "session_budget_exhausted") {
        return sendError(res, "rate_limited", "session_budget_exhausted");
      }
      if (CREDENTIAL_REFUSALS.has(reason)) {
        return sendError(res, "unauthenticated", reason);
      }
      return sendError(res, "invalid_payload", reason);
    }

    // ── 8. The write. The input type has no field an identity could occupy, so
    // there is nothing to strip; the service adds the store-present probe and
    // its own named refusals on top of the store's writer.
    const written = await recordAnonSensingContribution(
      {
        commitment: body.commitment,
        rotationEpoch: body.rotationEpoch,
        groupTag: body.groupTag ?? null,
        zoneId: body.zoneId,
        observedAtMs: body.observedAtMs,
        signalBucket: body.signalBucket,
        ttlSeconds: body.ttlSeconds,
        reductionVersion: body.reductionVersion,
        features: body.features ?? null,
        // 3315: shown to others only if this contribution was ADMITTED with
        // `surface` — the scopes it asked for, already proven ⊆ the session's
        // consented scopes ⊆ the policy in force by the ladder above.
        surfacePermitted: (body.purposeScopes ?? session.row?.purpose_scopes ?? []).includes("surface"),
      },
      { client: db, nowMs },
    );

    if (!written.ok) {
      if (written.reason === "invalid_input") {
        return sendError(res, "invalid_payload", written.error ?? "invalid contribution");
      }
      logger.warn({ reason: written.reason }, "sensing contribution was not written");
      return sendError(res, "db_error", "contribution could not be stored");
    }

    // ── 9. Budget, and only now. A duplicate wrote no row (2340's replay key),
    // so it spends nothing: a replay must not drain the budget of the device
    // that is replaying, and an honest retry is indistinguishable from one.
    let budgetConsumed = false;
    if (!written.duplicate) {
      const consumed = await consumeSensingSessionRpc(db, credential, new Date(nowMs).toISOString());
      if (!consumed.ok) {
        // The contribution IS stored and the row is idempotent, so the honest
        // answer is that the write succeeded and the budget did not move.
        // Reporting a failure here would make a client retry a write that
        // already landed, which the replay key would absorb but which would
        // teach the client the wrong thing.
        logger.warn({ error: consumed.error }, "sensing session budget was not consumed after a write");
      } else {
        budgetConsumed = consumed.value === "ok";
        if (!budgetConsumed) logger.info({ reason: consumed.value }, "sensing session budget refused after a write");
      }
    }

    // Nothing about the cohort, the crowd or anybody else is in this response.
    return res.status(202).json({
      stored: !written.duplicate,
      duplicate: written.duplicate,
      budgetConsumed,
    });
  }),
);

export default router;

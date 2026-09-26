/**
 * sensingSession — §3's ELIGIBILITY call: the one request in the sensing path
 * that carries an identity, and the place CONSENT is checked.
 *
 *   POST /v1/sensing/session        (Authorization: Bearer <account token>)
 *     → 201 { credential, rotationEpoch, expiresAt, purposeScopes }
 *
 * ── WHAT WAS MISSING ─────────────────────────────────────────────────────────
 * The device transport (travel-buddy-standalone/src/services/sensing/
 * sensingTransport.ts) asks this path for an opaque short-lived credential and
 * then presents it to the ingest (routes/sensingIngest.ts), which authenticates
 * nothing else. Nothing on the server answered it: 2480's session table, the
 * session contract (lib/sensingContributionSession) and the eligibility ladder
 * (lib/sensingAuthPosture) existed, and no route issued a session — so the
 * ingest could never receive a contribution, pepper or no pepper.
 *
 * ── THE LADDER, IN ORDER ─────────────────────────────────────────────────────
 *   pepper posture   a session hash is derived under the store's pepper; the
 *                    same fail-closed refusal the ingest gives, by name
 *   posture decided  lib/sensingAuthPosture — `undecided` refuses everyone
 *   the account      requireUser; the profile id is used for the three checks
 *                    below and then put down — it is NEVER stored (Option B,
 *                    staged: 2481's issuer column is not applied and must not be)
 *   eligibility      sensingEligibility → `authenticated_profile` today
 *                    (attestation does not exist yet; unattested is refused)
 *   abuse budget     one limiter keyed on the profile, in memory / Redis only
 *   CONSENT          the person's recorded disclosure version decides which
 *                    scopes they agreed to (lib/sensingConsentScopes), and the
 *                    session carries the intersection with the policy in force.
 *                    The v1 disclosure describes Quick Signals only, so it
 *                    covers NO passive-sensing scope and is refused here.
 *   requested ⊆ consented   a device may ask for fewer scopes, never more
 *   write            the session row: the credential's HMAC, the scopes, the
 *                    budget, the window — no identity column exists to write
 *
 * The response is the bearer itself, once. The server keeps only its HMAC.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { getIntelConsentState } from "../lib/intelConsent.js";
import { SENSING_AUTH_POSTURE, sensingEligibility } from "../lib/sensingAuthPosture.js";
import { SENSING_PEPPER_ENV, sensingPepperPosture } from "../lib/sensingAnonService.js";
import { rotationEpochFor } from "../lib/sensingAnonStore.js";
import { SENSING_ANON_POLICY_V1 } from "../lib/sensingContributionPolicy.js";
import { buildSensingSessionRow, generateSensingCredential, SENSING_SESSIONS_TABLE } from "../lib/sensingContributionSession.js";
import { sensingScopesForConsent } from "../lib/sensingConsentScopes.js";

const router = Router();

/** Sessions last a day; a device re-issues on expiry. A dozen a day is generous and bounded. */
export const SENSING_SESSION_ISSUE_DAILY_LIMIT = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

const bodySchema = z
  .object({ purposeScopes: z.array(z.string().min(1).max(32)).max(7).optional() })
  .strict();

router.post(
  "/v1/sensing/session",
  asyncHandler(async (req, res) => {
    // 1. The pepper — before a client, before an identity.
    const pepper = sensingPepperPosture();
    if (!pepper.ok) {
      logger.warn({ reason: pepper.reason }, "sensing session refused: dedicated pepper is not configured");
      return sendError(res, "server_not_configured", `${SENSING_PEPPER_ENV} is not configured (${pepper.reason}); no sensing credential is issued.`);
    }
    // 2. The posture.
    if (SENSING_AUTH_POSTURE === "undecided") {
      return sendError(res, "feature_disabled", "sensing contribution is not available");
    }
    // 3. The account — the ONLY identity in the sensing path, and it stops here.
    const auth = await requireUser(req, res);
    if (!auth) return;
    const profileId = auth.user.id;

    // 4. Eligibility under the decided, staged posture.
    const eligibility = sensingEligibility({ profileId, deviceAttested: false });
    if (!eligibility.eligible) return sendError(res, "forbidden", eligibility.reason);

    // 5. The abuse budget, keyed on the profile and held nowhere durable.
    const limited = checkRateLimit("sensing_session_issue", profileId, SENSING_SESSION_ISSUE_DAILY_LIMIT, DAY_MS);
    if (!limited.allowed) return sendError(res, "rate_limited", "sensing_session_issue_limit");

    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "invalid body");

    const db = getServiceClient();
    if (!db) return sendError(res, "server_not_configured", "service client unavailable");

    // 6. CONSENT — what this person agreed to, not what the policy permits.
    const consent = await getIntelConsentState(db, profileId);
    if (!consent.ok) return sendError(res, "db_error", "consent could not be read");
    const covered = sensingScopesForConsent(consent.state, SENSING_ANON_POLICY_V1);
    if (!covered.covered) return sendError(res, "forbidden", covered.reason);
    const requested = parsed.data.purposeScopes ?? covered.scopes;
    for (const s of requested) {
      if (!(covered.scopes as readonly string[]).includes(s)) return sendError(res, "forbidden", "scope_not_consented");
    }

    // 7. The session. The credential is returned once and stored only as an HMAC.
    const nowMs = Date.now();
    const credential = generateSensingCredential();
    const built = buildSensingSessionRow({
      credential,
      issuanceClass: eligibility.issuanceClass,
      nowMs,
      purposeScopes: requested,
    });
    if (!built.ok) return sendError(res, "invalid_payload", built.error);
    const { error } = await db.from("sensing_contribution_sessions").insert(built.row);
    if (error) {
      logger.warn({ code: (error as any)?.code }, "sensing session was not written");
      return sendError(res, "db_error", "sensing session could not be issued");
    }

    // Nothing here names the account; the log line carries counts only.
    logger.info({ scopes: built.row.purpose_scopes.length, issuanceClass: built.row.issuance_class }, "sensing session issued");
    return res.status(201).json({
      credential,
      rotationEpoch: rotationEpochFor(nowMs),
      expiresAt: built.row.expires_at,
      purposeScopes: built.row.purpose_scopes,
    });
  }),
);

/** Compile-time tie for the literal table name above (check:write-path-columns reads literals). */
const _sessionsTableTie: typeof SENSING_SESSIONS_TABLE = "sensing_contribution_sessions";
void _sessionsTableTie;

export default router;

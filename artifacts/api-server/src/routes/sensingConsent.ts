/**
 * sensingConsent — OD-MAP-6's three passive-sensing consents, read and set by
 * the person they belong to (lib/sensingConsentGrants; migration 3703).
 *
 *   GET /v1/sensing/consent
 *     → 200 { available, consents: [{ scope, granted, current, effective,
 *             disclosureVersion, currentVersion, grantedAt, withdrawnAt }] }
 *   PUT /v1/sensing/consent/:scope     body { granted: boolean, displayedVersion?: string }
 *     → 200 the same shape, after the change
 *
 * Each consent is its own switch and is OFF until the person turns it on.
 * Rules this route holds:
 *   - GRANTING needs `sensing_consent_split_enabled` ON (seeded FALSE; the
 *     wording is pending legal review). An unreadable flag is a retryable 503,
 *     never a grant.
 *   - WITHDRAWING is always accepted, flag or no flag: revocable means
 *     revocable, including after the feature is switched off.
 *   - A grant names the disclosure version the client DISPLAYED; the server
 *     records the version in force and refuses a mismatch, so a recorded
 *     consent can never point at words the person was not shown.
 *   - A failed read is a 503, never "everything off" — the client would
 *     otherwise show a person who consented that they have not.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { readFlagState } from "../lib/capability/schemaCapability.js";
import {
  SENSING_CONSENT_DISCLOSURE_VERSIONS,
  SENSING_CONSENT_SCOPES,
  SENSING_CONSENT_SPLIT_FLAG,
  effectiveSensingConsent,
  isSensingConsentScope,
  readSensingConsent,
  setSensingConsent,
  type SensingConsentGrants,
} from "../lib/sensingConsentGrants.js";

const router = Router();

export function sensingConsentBody(available: boolean, grants: SensingConsentGrants) {
  const eff = effectiveSensingConsent(grants);
  return {
    available,
    consents: SENSING_CONSENT_SCOPES.map((scope) => ({
      scope,
      granted: grants[scope].granted,
      current: grants[scope].current,
      effective: eff[scope],
      disclosureVersion: grants[scope].disclosureVersion,
      currentVersion: SENSING_CONSENT_DISCLOSURE_VERSIONS[scope],
      grantedAt: grants[scope].grantedAt,
      withdrawnAt: grants[scope].withdrawnAt,
    })),
  };
}

router.get(
  "/v1/sensing/consent",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const db = getServiceClient();
    if (!db) return sendError(res, "server_not_configured", "service client unavailable");
    const flag = await readFlagState(db, SENSING_CONSENT_SPLIT_FLAG);
    if (flag === "unreadable") return sendError(res, "degraded_unavailable", "Sensing consent could not be read right now. Please try again.");
    const read = await readSensingConsent(db, auth.user.id);
    if (!read.ok) return sendError(res, "degraded_unavailable", "Sensing consent could not be read right now. Please try again.");
    return res.json(sensingConsentBody(flag === "on", read.grants));
  }),
);

const putSchema = z.object({ granted: z.boolean(), displayedVersion: z.string().min(1).max(64).optional() }).strict();

router.put(
  "/v1/sensing/consent/:scope",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const scope = req.params.scope;
    if (!isSensingConsentScope(scope)) {
      return sendError(res, "invalid_payload", `Unknown consent '${String(scope)}'. One of: ${SENSING_CONSENT_SCOPES.join(", ")}`);
    }
    const parsed = putSchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(res, "invalid_payload", "granted (boolean) is required");
    const db = getServiceClient();
    if (!db) return sendError(res, "server_not_configured", "service client unavailable");

    const flag = await readFlagState(db, SENSING_CONSENT_SPLIT_FLAG);
    if (parsed.data.granted) {
      if (flag === "unreadable") return sendError(res, "degraded_unavailable", "Nothing was changed: sensing consent could not be checked right now. Please try again.");
      if (flag !== "on") return sendError(res, "feature_disabled", "Sensing contributions are not available yet, so this consent cannot be turned on.");
    }

    const out = await setSensingConsent(db, auth.user.id, scope, parsed.data.granted, parsed.data.displayedVersion);
    if (!out.ok) {
      if (out.reason === "disclosure_version_mismatch") {
        return sendError(res, "conflict", "disclosure_version_mismatch: the wording changed; review the current text");
      }
      return sendError(res, "degraded_unavailable", "Nothing was changed: sensing consent could not be saved right now. Please try again.");
    }
    if (!out.grants) {
      // Saved, but the read-back failed: say so rather than show a default.
      return res.status(202).json({ saved: true, available: flag === "on", consents: null });
    }
    return res.json(sensingConsentBody(flag === "on", out.grants));
  }),
);

export default router;

/**
 * Intelligence Contributions consent — the server-authoritative D4 gate.
 *
 * lib/locationPurposes.ts declares the `intel_claim` purpose with
 * lawfulBasis:"consent" + requiresSeparateControl:true. The owner ruling
 * (2026-08-27): contributions require explicit informed consent PLUS a persistent
 * separate control, enforced SERVER-SIDE; client UI alone is insufficient and
 * client state cannot override server state.
 *
 * The authoritative state lives in `intel_contribution_consent` (migration 2172),
 * one row per user, written ONLY by service_role. The client may ask to enable or
 * disable, but the consent VERSION and the consent/withdrawal TIMESTAMPS are
 * stamped here, server-side — a client cannot forge them.
 *
 * FAIL-CLOSED: absence of a row, a disabled row, a withdrawn row, or any read
 * error all read as "no valid consent". writeObservation() refuses capture unless
 * this returns true.
 */

/**
 * The disclosure version a grant is recorded under. Bump this string when the
 * disclosure copy changes materially; the recorded version is the evidence of
 * WHICH disclosure a user agreed to. (This gate treats any enabled, non-withdrawn
 * consent as valid; a future policy may additionally require the current version.)
 */
export const INTEL_CONSENT_DISCLOSURE_VERSION = "intel_contributions_v1";

export interface IntelConsentState {
  enabled: boolean;
  consentVersion: string | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
  /** The version a NEW grant would be recorded under (for the client's disclosure). */
  currentDisclosureVersion: string;
}

/**
 * True iff the actor currently has valid Intelligence Contributions consent:
 * enabled AND not withdrawn. Fail-closed on every other outcome (no row, disabled,
 * withdrawn, missing client/actor, or a read error).
 */
export async function hasValidIntelConsent(sc: any, actorId: string | null | undefined): Promise<boolean> {
  if (!sc || !actorId) return false;
  try {
    const { data, error } = await sc
      .from("intel_contribution_consent")
      .select("enabled, withdrawn_at")
      .eq("user_id", actorId)
      .maybeSingle();
    if (error || !data) return false;
    return data.enabled === true && (data.withdrawn_at === null || data.withdrawn_at === undefined);
  } catch {
    return false;
  }
}

export type IntelConsentStateResult =
  | { ok: true; state: IntelConsentState }
  | { ok: false; reason: "db_error" | "no_client_or_actor" };

/**
 * Read the full consent state for the SETTINGS surface.
 *
 * WHY THIS IS NOT FAIL-SOFT, WHILE `hasValidIntelConsent` ABOVE IS. They answer
 * different questions and a failed read means opposite things to each.
 *
 *   the GATE asks "may we capture?"  — an unreadable row must answer NO. It does,
 *                                      and must keep doing so: rendering "could
 *                                      not read" as "consented" is the one
 *                                      outcome that is never acceptable.
 *   the SCREEN asks "what did I agree to?" — an unreadable row used to answer
 *                                      { enabled:false, consentedAt:null,
 *                                        withdrawnAt:null }, i.e. "you have
 *                                        never consented", to a person who had.
 *
 * That second one is not harmless, and it is not merely cosmetic. supabase-js
 * resolves on a database error, so the old code could not tell the two apart —
 * and the screen it feeds has a toggle. A consenting user shown "off" who
 * switches it on reaches PUT /v1/intel/consent, whose upsert stamps a NEW
 * consent_version and a NEW consented_at and clears withdrawn_at. The
 * evidentiary record of WHICH disclosure they agreed to and WHEN — the whole
 * reason those columns are server-stamped and service-role-only — is silently
 * rewritten by a transient read failure.
 *
 * So the read now reports its failure and the route answers db_error. The user
 * sees "we could not load this", which is true, instead of a false history of
 * their own consent.
 */
export async function getIntelConsentState(sc: any, actorId: string): Promise<IntelConsentStateResult> {
  const base: IntelConsentState = {
    enabled: false,
    consentVersion: null,
    consentedAt: null,
    withdrawnAt: null,
    currentDisclosureVersion: INTEL_CONSENT_DISCLOSURE_VERSION,
  };
  if (!sc || !actorId) return { ok: false, reason: "no_client_or_actor" };
  try {
    const { data, error } = await sc
      .from("intel_contribution_consent")
      .select("enabled, consent_version, consented_at, withdrawn_at")
      .eq("user_id", actorId)
      .maybeSingle();
    if (error) return { ok: false, reason: "db_error" };
    // NO ROW is a real, readable answer: this person has never granted consent.
    // That is the only case the default-off state may be returned for.
    if (!data) return { ok: true, state: base };
    return {
      ok: true,
      state: {
        enabled: data.enabled === true,
        consentVersion: data.consent_version ?? null,
        consentedAt: data.consented_at ?? null,
        withdrawnAt: data.withdrawn_at ?? null,
        currentDisclosureVersion: INTEL_CONSENT_DISCLOSURE_VERSION,
      },
    };
  } catch {
    return { ok: false, reason: "db_error" };
  }
}

/**
 * Grant or withdraw consent, authoritatively. The caller supplies only `enabled`;
 * the version and timestamps are set here. A grant stamps the current disclosure
 * version + consented_at and clears withdrawn_at. A withdrawal sets withdrawn_at
 * and flips enabled off WITHOUT erasing the prior consent_version/consented_at
 * (that is the audit trail of what was once agreed).
 */
export async function setIntelConsent(
  sc: any,
  actorId: string,
  enabled: boolean,
): Promise<{ ok: boolean; state?: IntelConsentState; reason?: string }> {
  if (!sc || !actorId) return { ok: false, reason: "no_client_or_actor" };
  const now = new Date().toISOString();
  const row = enabled
    ? {
        user_id: actorId,
        enabled: true,
        consent_version: INTEL_CONSENT_DISCLOSURE_VERSION,
        consented_at: now,
        withdrawn_at: null,
        updated_at: now,
      }
    : {
        // Withdrawal: only these columns change; consent_version/consented_at are
        // preserved by the ON CONFLICT update (they are not in the patch).
        user_id: actorId,
        enabled: false,
        withdrawn_at: now,
        updated_at: now,
      };
  try {
    const { error } = await sc
      .from("intel_contribution_consent")
      .upsert(row, { onConflict: "user_id" });
    if (error) return { ok: false, reason: "db_error" };
    // The write landed. If the read-back fails we must NOT hand the client a
    // default-off state — that would show a user who just granted consent that
    // they have none. Report the write's success without a state.
    const readBack = await getIntelConsentState(sc, actorId);
    return readBack.ok ? { ok: true, state: readBack.state } : { ok: true };
  } catch {
    return { ok: false, reason: "db_error" };
  }
}

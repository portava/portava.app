/**
 * sensingConsentScopes — WHICH purpose scopes a person's recorded consent
 * actually covers for the ANONYMOUS sensing store, read from the disclosure
 * they agreed to rather than from a policy constant.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `lib/sensingContributionPolicy.SENSING_ANON_GRANTED_SCOPES` is a POLICY: what
 * the owner ruled this store may do at all. It is not CONSENT: what a given
 * person agreed to. Editing the constant to add `surface` would let every
 * contribution already stored be shown to other people under a disclosure none
 * of those contributors saw. Consent lives in `intel_contribution_consent`
 * (2172), whose server-stamped `consent_version` records WHICH disclosure a
 * person agreed to; this module turns that version into the scopes it covers.
 * The session issuer takes the INTERSECTION with the policy in force, stamps it
 * on the session (2480's `purpose_scopes`), and the ingest carries `surface`
 * onto each contribution (3315's `surface_permitted`) — so a contribution may
 * be surfaced only if BOTH the owner's policy AND its own contributor's consent
 * permit it.
 *
 * ── WHAT EACH DISCLOSURE SAYS, QUOTED FROM THE SHIPPED CLIENT ───────────────
 * `intel_contributions_v1` (travel-buddy-standalone/src/components/intel/
 * IntelConsentGate.tsx): "Your Quick Signals can be combined with reports from
 * other travelers to show what a place is like right now. Your identity and
 * exact location aren't shown publicly with the signal." That text describes
 * QUICK SIGNALS — explicit taps — and nothing about passive motion or location
 * sensing. So it covers NO scope of the passive store: not collect, and
 * certainly not surface. A person who agreed to it has agreed to nothing this
 * store does.
 *
 * `sensing_contributions_v2` (docs/contracts/sensing-consent-disclosure-v2.md)
 * is the disclosure written for this store: passive, coarse, on-device-reduced
 * motion and area signals; aggregated only above a crowd threshold; and — the
 * `surface` scope — shown to other people only as "people are here / not
 * known", never a count, never a person. It is NOT IN FORCE: the server stamps
 * `INTEL_CONSENT_DISCLOSURE_VERSION` on every grant, that constant still reads
 * v1, and no code path can record v2 until the owner approves the text and
 * ships the client copy with the constant in one release. Nothing here
 * manufactures a v2 consent; tests inject one.
 *
 * PURE. No I/O, no clock.
 */
import {
  CONTRIBUTION_PURPOSE_SCOPES,
  type ContributionPurposeScope,
  type IntelligenceContributionPolicy,
} from "./sensingContributionPolicy.js";

/** The disclosure v1 grants are stamped with today (lib/intelConsent.INTEL_CONSENT_DISCLOSURE_VERSION). */
export const SENSING_CONSENT_V1 = "intel_contributions_v1";
/** The passive-sensing disclosure. Defined; NOT in force until the owner ships it. */
export const SENSING_CONSENT_V2 = "sensing_contributions_v2";

/**
 * What each recorded disclosure covers, for the ANONYMOUS store. An unknown
 * version covers nothing: a version this table has never seen is a disclosure
 * nobody has classified.
 */
export const SENSING_CONSENT_SCOPES: Readonly<Record<string, readonly ContributionPurposeScope[]>> = Object.freeze({
  [SENSING_CONSENT_V1]: Object.freeze([]) as readonly ContributionPurposeScope[],
  [SENSING_CONSENT_V2]: Object.freeze(["collect", "retain", "aggregate", "surface"]) as readonly ContributionPurposeScope[],
});

export interface RecordedConsent {
  enabled: boolean;
  consentVersion: string | null;
  withdrawnAt: string | null;
}

export type SensingConsentAnswer =
  | { covered: true; scopes: ContributionPurposeScope[]; consentVersion: string }
  | { covered: false; reason: "no_consent" | "withdrawn" | "disclosure_does_not_cover_passive_sensing" };

/**
 * The scopes this person's consent covers AND the policy in force grants,
 * in `CONTRIBUTION_PURPOSE_SCOPES` order. `collect` is the floor: consent that
 * does not cover collection covers nothing this store does.
 */
export function sensingScopesForConsent(
  consent: RecordedConsent | null | undefined,
  policy: IntelligenceContributionPolicy,
): SensingConsentAnswer {
  if (!consent || consent.enabled !== true) return { covered: false, reason: "no_consent" };
  if (consent.withdrawnAt !== null && consent.withdrawnAt !== undefined) return { covered: false, reason: "withdrawn" };
  const version = consent.consentVersion ?? "";
  const byConsent = new Set(SENSING_CONSENT_SCOPES[version] ?? []);
  const byPolicy = new Set(policy?.purposeScopes ?? []);
  const scopes = CONTRIBUTION_PURPOSE_SCOPES.filter((s) => byConsent.has(s) && byPolicy.has(s));
  if (!scopes.includes("collect")) return { covered: false, reason: "disclosure_does_not_cover_passive_sensing" };
  return { covered: true, scopes, consentVersion: version };
}

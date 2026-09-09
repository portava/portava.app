/**
 * sensingAuthPosture — WHO may obtain a sensing contribution credential.
 *
 * This is the owner decision the tripwire waits on (docs/architecture/
 * sensing-auth-posture-decision.md). It is encoded as a constant that reads
 * `undecided` and a pure eligibility function that FAILS CLOSED while it does:
 * no posture, no eligibility, no credential, no contribution. Changing the
 * constant is the owner's act; nothing here reads a flag or the database.
 *
 * ── THE REFRAMING THIS RESTS ON ──────────────────────────────────────────────
 * The structural cap on Sensing is intel_observations.actor_id NOT NULL
 * REFERENCES profiles(id) (2130:142). It caps Sensing ONLY if passive
 * contributions must enter that table. They need not: sensing_anon_contributions
 * (2315) is the contribution store, holds no identity, and its aggregates are
 * consumed as a projection (lib/sensingPresenceState), never promoted into the
 * canonical lifecycle. So the blocker is not the FK — it is that nobody has
 * decided who is ELIGIBLE to contribute. §3: "Separate contribution eligibility
 * / authentication from signal ingest where practical: eligibility proves an
 * authorized participating device; ingest receives an opaque short-lived
 * credential." Eligibility is this module. Ingest is lib/sensingContributionSession
 * + lib/sensingContributionPolicy + lib/sensingAnonService. The identity used
 * to prove eligibility is discarded before ingest under EVERY posture: the
 * contribution row has no column it could occupy (2315's postconditions).
 *
 * ── THE TWO POSTURES ─────────────────────────────────────────────────────────
 *   authenticated_only   eligibility = an authenticated profile (lib/http
 *                        requireUser). The abuse budget is keyed on the profile
 *                        (existing lib/rateLimit shape) and, if 2481 is applied,
 *                        an issuance ledger lets an operator revoke every session
 *                        an account obtained. Cost: the contributor population is
 *                        the signed-in, consenting user base — 58 profiles in
 *                        production on 2026-09-07, 4 active in 30 days, 0 with
 *                        intel consent — so k = 15 / 5 groups per zone-bucket is
 *                        not reachable from it today.
 *   anonymous_capable    eligibility = an attested device (App Attest / Play
 *                        Integrity — NO such primitive exists in this repo yet),
 *                        OR a profile. Unattested devices are refused unless the
 *                        owner sets SENSING_ALLOW_UNATTESTED_DEVICES, and then
 *                        get the tightest budget. The abuse budget is keyed on
 *                        the credential hash, never an identity.
 *
 * PURE. No I/O, no clock.
 */

export const SENSING_AUTH_POSTURES = ["undecided", "authenticated_only", "anonymous_capable"] as const;
export type SensingAuthPosture = (typeof SENSING_AUTH_POSTURES)[number];

/**
 * OWNER DECISION — SENSING_AUTH_POSTURE. Seeded `undecided`, which makes every
 * eligibility check refuse. Set by the owner, in a reviewed diff, to one of the
 * other two values; there is deliberately no environment variable or flag that
 * can flip it at runtime.
 */
export const SENSING_AUTH_POSTURE: SensingAuthPosture = "undecided";

/**
 * Under `anonymous_capable`, whether a device that cannot present an integrity
 * attestation may still obtain a (tightly budgeted) credential. Seeded false:
 * fail closed until the owner accepts the abuse exposure.
 */
export const SENSING_ALLOW_UNATTESTED_DEVICES = false;

/** How a credential was issued. Stored on the session row (2480), never on a contribution. */
export const SENSING_ISSUANCE_CLASSES = ["attested_device", "unattested_device", "authenticated_profile"] as const;
export type SensingIssuanceClass = (typeof SENSING_ISSUANCE_CLASSES)[number];

export interface EligibilityContext {
  /** The authenticated profile, if the request carried a valid session. */
  profileId: string | null;
  /** True only when a platform integrity attestation was verified server-side. */
  deviceAttested: boolean;
}

export type EligibilityRefusal = "posture_undecided" | "profile_required" | "device_attestation_required";

export type Eligibility =
  | {
      eligible: true;
      issuanceClass: SensingIssuanceClass;
      /**
       * What the abuse budget is keyed on. `profile:<id>` under Option A —
       * this string lives in the rate limiter and (optionally) the 2481
       * issuance ledger, and is discarded before ingest. `credential` under
       * Option B means "the credential hash, once issued".
       */
      budgetKey: string;
    }
  | { eligible: false; reason: EligibilityRefusal };

export function sensingEligibility(
  ctx: EligibilityContext,
  posture: SensingAuthPosture = SENSING_AUTH_POSTURE,
  allowUnattested: boolean = SENSING_ALLOW_UNATTESTED_DEVICES,
): Eligibility {
  if (posture === "undecided" || !SENSING_AUTH_POSTURES.includes(posture)) {
    return { eligible: false, reason: "posture_undecided" };
  }
  const profileId = typeof ctx?.profileId === "string" && ctx.profileId.length > 0 ? ctx.profileId : null;

  if (posture === "authenticated_only") {
    if (!profileId) return { eligible: false, reason: "profile_required" };
    return { eligible: true, issuanceClass: "authenticated_profile", budgetKey: `profile:${profileId}` };
  }

  // anonymous_capable
  if (profileId) return { eligible: true, issuanceClass: "authenticated_profile", budgetKey: `profile:${profileId}` };
  if (ctx?.deviceAttested === true) return { eligible: true, issuanceClass: "attested_device", budgetKey: "credential" };
  if (allowUnattested === true) return { eligible: true, issuanceClass: "unattested_device", budgetKey: "credential" };
  return { eligible: false, reason: "device_attestation_required" };
}

/** True when this posture can ever issue a credential to a caller with no profile. */
export function postureAdmitsAnonymous(posture: SensingAuthPosture): boolean {
  return posture === "anonymous_capable";
}

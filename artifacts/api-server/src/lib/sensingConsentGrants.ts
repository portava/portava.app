/**
 * sensingConsentGrants — OD-MAP-6's three separate, revocable passive-sensing
 * consents (migration 3703), and what they let the sensing session issuer do.
 *
 * THE RULING (docs/ops/owner-decisions-20261004.md, OD-MAP-6): "Separate
 * consent for on-device capture, contribution upload, and each secondary use.
 * Make it revocable; don't bundle it with general app consent."
 *
 *   capture   the phone works out coarse motion and area signals ON THE DEVICE.
 *             Nothing leaves the phone under this consent alone.
 *   upload    the phone sends those reduced signals, under a short-lived
 *             credential that does not name the person, to Portava's sensing
 *             store, where they are combined with other people's.
 *   surface   combined results that include the person's signals may be shown
 *             to other travellers ("people are here / not known", never a
 *             count, never a person) — the one secondary use the store has.
 *
 * Each is its own row, its own disclosure version and its own switch; each is
 * OFF until granted. They are also ORDERED in effect, because each is about
 * what the one before produces: upload has nothing to send without capture,
 * and surface has nothing to show without upload. So a recorded grant counts
 * only when the grants before it count too — a withdrawn capture switches the
 * upload off in effect while the upload grant itself stays as recorded.
 *
 * A grant counts only under the disclosure version IN FORCE for its scope: a
 * person who agreed to older words has not agreed to the current ones.
 *
 * Wording: the lead's approved draft, PENDING LEGAL REVIEW
 * (docs/contracts/sensing-consent-split-v1.md; docs/ops/lead-rulings-20261006.md).
 * The versions below name it; the client renders the words for the version the
 * server reports and sends that version back with a grant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONTRIBUTION_PURPOSE_SCOPES,
  type ContributionPurposeScope,
  type IntelligenceContributionPolicy,
} from "./sensingContributionPolicy.js";

export const SENSING_CONSENT_SCOPES = ["capture", "upload", "surface"] as const;
export type SensingConsentScope = (typeof SENSING_CONSENT_SCOPES)[number];

/** The disclosure in force for each consent. A grant records the one the person was shown. */
export const SENSING_CONSENT_DISCLOSURE_VERSIONS: Readonly<Record<SensingConsentScope, string>> = Object.freeze({
  capture: "sensing_capture_v1",
  upload: "sensing_upload_v1",
  surface: "sensing_surface_v1",
});

/** Seeded FALSE by 3703. Off: no grant can be recorded (withdrawals always can) and no session is issued. */
export const SENSING_CONSENT_SPLIT_FLAG = "sensing_consent_split_enabled";

export const SENSING_CONSENT_TABLE = "sensing_consent_grants";

export function isSensingConsentScope(v: unknown): v is SensingConsentScope {
  return typeof v === "string" && (SENSING_CONSENT_SCOPES as readonly string[]).includes(v);
}

export interface SensingConsentGrant {
  scope: SensingConsentScope;
  /** A row exists and is not withdrawn. */
  granted: boolean;
  /** The version the person agreed to, or null when there is no row. */
  disclosureVersion: string | null;
  /** The recorded version is the one in force. */
  current: boolean;
  grantedAt: string | null;
  withdrawnAt: string | null;
}

export type SensingConsentGrants = Readonly<Record<SensingConsentScope, SensingConsentGrant>>;

export type SensingConsentRead =
  | { ok: true; grants: SensingConsentGrants }
  | { ok: false; reason: "no_client" | "db_error" };

function emptyGrant(scope: SensingConsentScope): SensingConsentGrant {
  return { scope, granted: false, disclosureVersion: null, current: false, grantedAt: null, withdrawnAt: null };
}

type Row = { scope?: unknown; disclosure_version?: unknown; granted_at?: unknown; withdrawn_at?: unknown };

/** Pure: rows → the three grants. A row with an unknown scope is ignored; a missing scope is OFF. */
export function grantsFromRows(rows: readonly Row[]): SensingConsentGrants {
  const out = {} as Record<SensingConsentScope, SensingConsentGrant>;
  for (const s of SENSING_CONSENT_SCOPES) out[s] = emptyGrant(s);
  for (const r of rows) {
    if (!isSensingConsentScope(r.scope)) continue;
    const version = typeof r.disclosure_version === "string" ? r.disclosure_version : null;
    const withdrawnAt = typeof r.withdrawn_at === "string" ? r.withdrawn_at : null;
    out[r.scope] = {
      scope: r.scope,
      granted: withdrawnAt === null && typeof r.granted_at === "string",
      disclosureVersion: version,
      current: version !== null && version === SENSING_CONSENT_DISCLOSURE_VERSIONS[r.scope],
      grantedAt: typeof r.granted_at === "string" ? r.granted_at : null,
      withdrawnAt,
    };
  }
  return out;
}

/** The person's three grants. A failed read is a failure — never "everything off". */
export async function readSensingConsent(db: SupabaseClient | null | undefined, userId: string): Promise<SensingConsentRead> {
  if (!db) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await db
      .from("sensing_consent_grants")
      .select("scope, disclosure_version, granted_at, withdrawn_at")
      .eq("user_id", userId);
    if (error) return { ok: false, reason: "db_error" };
    return { ok: true, grants: grantsFromRows((data ?? []) as Row[]) };
  } catch {
    return { ok: false, reason: "db_error" };
  }
}

export interface EffectiveSensingConsent {
  capture: boolean;
  upload: boolean;
  surface: boolean;
}

/** What the grants permit right now: each must be granted under the current words, and so must the ones before it. */
export function effectiveSensingConsent(grants: SensingConsentGrants): EffectiveSensingConsent {
  const counts = (s: SensingConsentScope) => grants[s].granted && grants[s].current;
  const capture = counts("capture");
  const upload = capture && counts("upload");
  const surface = upload && counts("surface");
  return { capture, upload, surface };
}

export type SessionScopesAnswer =
  | { covered: true; scopes: ContributionPurposeScope[] }
  | { covered: false; reason: "capture_not_granted" | "upload_not_granted" };

/**
 * The purpose scopes a sensing session may carry for this person: collect /
 * retain / aggregate need capture AND upload; surface needs the surface consent
 * too. Always intersected with the policy in force — a consent is not a policy,
 * and a policy is not a consent.
 */
export function sessionScopesForGrants(
  grants: SensingConsentGrants,
  policy: IntelligenceContributionPolicy,
): SessionScopesAnswer {
  const eff = effectiveSensingConsent(grants);
  if (!eff.capture) return { covered: false, reason: "capture_not_granted" };
  if (!eff.upload) return { covered: false, reason: "upload_not_granted" };
  const byConsent = new Set<ContributionPurposeScope>(["collect", "retain", "aggregate", ...(eff.surface ? (["surface"] as const) : [])]);
  const byPolicy = new Set(policy?.purposeScopes ?? []);
  const scopes = CONTRIBUTION_PURPOSE_SCOPES.filter((s) => byConsent.has(s) && byPolicy.has(s));
  if (!scopes.includes("collect")) return { covered: false, reason: "upload_not_granted" };
  return { covered: true, scopes };
}

export type SetSensingConsentResult =
  | { ok: true; grants?: SensingConsentGrants }
  | { ok: false; reason: "no_client" | "disclosure_version_mismatch" | "db_error" };

/**
 * Grant or withdraw ONE consent. A grant stamps the version in force and is
 * refused unless the client says it displayed exactly that version (the
 * recorded words can never be words the person did not see). A withdrawal
 * keeps the row and stamps withdrawn_at; withdrawing what was never granted is
 * a no-op success. The other two consents are never touched.
 */
export async function setSensingConsent(
  db: SupabaseClient | null | undefined,
  userId: string,
  scope: SensingConsentScope,
  granted: boolean,
  displayedVersion: string | undefined,
  now: Date = new Date(),
): Promise<SetSensingConsentResult> {
  if (!db) return { ok: false, reason: "no_client" };
  const version = SENSING_CONSENT_DISCLOSURE_VERSIONS[scope];
  if (granted && displayedVersion !== version) return { ok: false, reason: "disclosure_version_mismatch" };
  const at = now.toISOString();
  try {
    if (granted) {
      const { error } = await db.from("sensing_consent_grants").upsert(
        { user_id: userId, scope, disclosure_version: version, granted_at: at, withdrawn_at: null, updated_at: at },
        { onConflict: "user_id,scope" },
      );
      if (error) return { ok: false, reason: "db_error" };
    } else {
      const { error } = await db
        .from("sensing_consent_grants")
        .update({ withdrawn_at: at, updated_at: at })
        .eq("user_id", userId)
        .eq("scope", scope)
        .is("withdrawn_at", null);
      if (error) return { ok: false, reason: "db_error" };
    }
  } catch {
    return { ok: false, reason: "db_error" };
  }
  // The write landed. A failed read-back must not hand the client "all off".
  const back = await readSensingConsent(db, userId);
  return back.ok ? { ok: true, grants: back.grants } : { ok: true };
}

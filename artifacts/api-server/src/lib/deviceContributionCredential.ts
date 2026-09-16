/**
 * Privacy-reduced sensing credential boundary.
 *
 * Credentials are opaque, short-lived capability tokens.  The bearer value is
 * never persisted: only its SHA-256 digest is stored, scoped to a purpose and
 * capability version.  A nonce is consumed separately from observation
 * idempotency, so replaying a valid request cannot be confused with a harmless
 * client retry.
 */
import { createHash, randomBytes } from "node:crypto";

export const SENSING_CAPABILITY_VERSION = "sensing-v1";
export const SENSING_PURPOSE = "intel_claim";
export const SENSING_CREDENTIAL_TTL_SECONDS = 15 * 60;
export const SENSING_PRECISION_CEILING = "place_level" as const;

export type SensingCredentialFailure =
  | "credential_required"
  | "credential_malformed"
  | "credential_expired"
  | "credential_revoked"
  | "credential_purpose_mismatch"
  | "credential_version_mismatch"
  | "credential_replay"
  | "credential_unauthorized"
  | "credential_infrastructure_error";

export interface IssuedSensingCredential {
  credential: string;
  nonce: string;
  deviceId: string;
  expiresAt: string;
  capabilityVersion: string;
  purpose: string;
  precisionCeiling: typeof SENSING_PRECISION_CEILING;
}

export interface AuthorizedSensingCredential {
  ok: true;
  actorId: string;
  credentialId: string;
  nonce: string;
  expiresAt: string;
  capabilityVersion: string;
  precisionCeiling: typeof SENSING_PRECISION_CEILING;
}

export interface CredentialFailure {
  ok: false;
  reason: SensingCredentialFailure;
  detail?: string;
}

export type CredentialAuthorization = AuthorizedSensingCredential | CredentialFailure;

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const malformed = (value: unknown): boolean =>
  typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value);

/**
 * Issue a credential for a consented actor. The actor id is retained only in
 * the server-side capability row; clients receive no stable sensing identity.
 */
export async function issueSensingCredential(
  sc: any,
  actorId: string,
  opts: { purpose?: string; capabilityVersion?: string; ttlSeconds?: number; deviceId?: string } = {},
): Promise<{ ok: true; credential: IssuedSensingCredential } | CredentialFailure> {
  if (!sc || !actorId || !opts.deviceId || malformed(opts.deviceId)) return { ok: false, reason: "credential_infrastructure_error" };
  const purpose = opts.purpose ?? SENSING_PURPOSE;
  const capabilityVersion = opts.capabilityVersion ?? SENSING_CAPABILITY_VERSION;
  if (purpose !== SENSING_PURPOSE) return { ok: false, reason: "credential_purpose_mismatch" };
  if (capabilityVersion !== SENSING_CAPABILITY_VERSION) return { ok: false, reason: "credential_version_mismatch" };
  const ttl = Math.max(60, Math.min(opts.ttlSeconds ?? SENSING_CREDENTIAL_TTL_SECONDS, SENSING_CREDENTIAL_TTL_SECONDS));
  const credential = randomBytes(32).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  try {
    const { data, error } = await sc.from("intel_sensing_credentials").insert({
      actor_id: actorId,
      device_id: opts.deviceId,
      token_digest: digest(credential),
      nonce_digest: digest(nonce),
      purpose,
      capability_version: capabilityVersion,
      precision_ceiling: SENSING_PRECISION_CEILING,
      expires_at: expiresAt,
    }).select("id").single();
    if (error || !data?.id) return { ok: false, reason: "credential_infrastructure_error", detail: error?.message };
    return { ok: true, credential: { credential, nonce, deviceId: opts.deviceId, expiresAt, capabilityVersion, purpose, precisionCeiling: SENSING_PRECISION_CEILING } };
  } catch {
    return { ok: false, reason: "credential_infrastructure_error" };
  }
}

/**
 * Validate and atomically consume a nonce. The database RPC is intentionally
 * the replay boundary; a read followed by an update would permit two races.
 */
export async function authorizeSensingCredential(
  sc: any,
  credential: unknown,
  nonce: unknown,
  opts: { purpose?: string; capabilityVersion?: string; now?: Date; actorId?: string; deviceId?: string } = {},
): Promise<CredentialAuthorization> {
  if (malformed(credential) || malformed(nonce)) return { ok: false, reason: "credential_malformed" };
  const purpose = opts.purpose ?? SENSING_PURPOSE;
  const version = opts.capabilityVersion ?? SENSING_CAPABILITY_VERSION;
  if (purpose !== SENSING_PURPOSE) return { ok: false, reason: "credential_purpose_mismatch" };
  if (version !== SENSING_CAPABILITY_VERSION) return { ok: false, reason: "credential_version_mismatch" };
  try {
    const { data, error } = await sc.rpc("consume_intel_sensing_credential", {
      p_token_digest: digest(credential as string),
      p_nonce_digest: digest(nonce as string),
      p_actor_id: opts.actorId ?? null,
      p_device_id: opts.deviceId ?? null,
      p_purpose: purpose,
      p_capability_version: version,
      p_now: (opts.now ?? new Date()).toISOString(),
    });
    if (error) return { ok: false, reason: "credential_infrastructure_error", detail: error.message };
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { ok: false, reason: "credential_expired" };
    if (row.outcome === "unauthorized") return { ok: false, reason: "credential_unauthorized" };
    if (row.outcome === "expired") return { ok: false, reason: "credential_expired" };
    if (row.outcome === "revoked") return { ok: false, reason: "credential_revoked" };
    if (row.outcome === "replay") return { ok: false, reason: "credential_replay" };
    if (row.outcome === "scope_mismatch") return { ok: false, reason: "credential_purpose_mismatch" };
    if (row.outcome !== "authorized") return { ok: false, reason: "credential_unauthorized" };
    if (row.revoked_at) return { ok: false, reason: "credential_revoked" };
    if (opts.actorId && row.actor_id !== opts.actorId) return { ok: false, reason: "credential_unauthorized" };
    if (opts.deviceId && row.device_id !== opts.deviceId) return { ok: false, reason: "credential_unauthorized" };
    const nowMs = (opts.now ?? new Date()).getTime();
    if (row.expires_at && new Date(row.expires_at).getTime() <= nowMs) return { ok: false, reason: "credential_expired" };
    return {
      ok: true,
      actorId: row.actor_id,
      credentialId: row.id,
      nonce: nonce as string,
      expiresAt: row.expires_at,
      capabilityVersion: row.capability_version,
      precisionCeiling: SENSING_PRECISION_CEILING,
    };
  } catch {
    return { ok: false, reason: "credential_infrastructure_error" };
  }
}
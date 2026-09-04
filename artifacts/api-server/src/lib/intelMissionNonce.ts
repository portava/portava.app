/**
 * intelMissionNonce (IG unit I3 / P4 "assigned" presence).
 *
 * Spec §7 Table 13: P4 = P2/P3 plus MISSION NONCE and contract. The nonce is the
 * proof that the capture is the one an accepted mission commissioned — not a
 * stray report that happens to name the mission's subject.
 *
 * SHAPE (the lib/intelGroupKey.ts pattern, same secret, same fail-closed rule):
 *
 *   accept:  token  = 16 random bytes (hex)          → handed to the contributor ONCE
 *            digest = HMAC-SHA256(secret,
 *                       "intel-mission-nonce/v1|<missionId>|<actorId>|<token>")
 *                                                    → stored in intel_mission_candidates.nonce
 *   capture: recompute the digest from (missionId, CAPTURING actor, presented
 *            token) and compare CONSTANT-TIME to the stored digest.
 *
 * WHY A DIGEST AND NOT THE TOKEN: the table is service_role-only, but "only the
 * server can read it" is not the same as "a read cannot forge a capture". With a
 * digest at rest, nothing that reads the row can present a valid nonce; only the
 * holder of the plaintext can. WHY THE ACTOR IS FOLDED IN: a nonce issued to one
 * contributor verifies ONLY for captures by that contributor — passing the token
 * on does not pass the mission on. WHY THE MISSION ID IS FOLDED IN: a token
 * cannot be replayed against a different mission.
 *
 * Single-use is NOT enforced here (this module is pure): the capture path claims
 * the nonce with a compare-and-set on nonce_consumed_at (see PresenceVerifier).
 *
 * Secret: INTEL_GROUP_KEY_SECRET when set, else SESSION_SECRET (required at boot
 * — lib/envValidation). No constant fallback: a guessable key would make every
 * nonce forgeable. Fail-closed by throwing; callers treat a throw as "no P4".
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const NONCE_CONTEXT = "intel-mission-nonce/v1";

/** Hex chars in a freshly minted plaintext token (16 random bytes). */
export const MISSION_NONCE_TOKEN_HEX_LENGTH = 32;

function nonceSecret(): string {
  const secret = process.env.INTEL_GROUP_KEY_SECRET ?? process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("INTEL_GROUP_KEY_SECRET or SESSION_SECRET is required to derive intel mission nonces (integrity-critical, no fallback).");
  }
  return secret;
}

/** Same canonicalisation as the group key: uuid case variants must not split. */
function canon(id: string): string {
  return String(id ?? "").trim().toLowerCase();
}

/** A well-formed plaintext token: exactly MISSION_NONCE_TOKEN_HEX_LENGTH lowercase hex chars. */
export function isWellFormedMissionNonceToken(token: unknown): token is string {
  return typeof token === "string" && new RegExp(`^[0-9a-f]{${MISSION_NONCE_TOKEN_HEX_LENGTH}}$`).test(token);
}

/**
 * Derive the digest stored for (missionId, actorId, token). Pure; throws only
 * when no secret is configured.
 */
export function deriveMissionNonceDigest(missionId: string, actorId: string, token: string): string {
  const canonical = `${NONCE_CONTEXT}|${canon(missionId)}|${canon(actorId)}|${canon(token)}`;
  return createHmac("sha256", nonceSecret()).update(canonical).digest("hex");
}

export interface MintedMissionNonce {
  /** Plaintext — return to the contributor once; never store. */
  token: string;
  /** HMAC digest — store in intel_mission_candidates.nonce. */
  digest: string;
}

/** Mint a fresh single-use nonce for a mission accepted by `actorId`. */
export function mintMissionNonce(missionId: string, actorId: string): MintedMissionNonce {
  const token = randomBytes(MISSION_NONCE_TOKEN_HEX_LENGTH / 2).toString("hex");
  return { token, digest: deriveMissionNonceDigest(missionId, actorId, token) };
}

/**
 * Constant-time check that `presentedToken` is the nonce minted for
 * (missionId, actorId) whose digest is `storedDigest`. False for any malformed
 * input, a missing stored digest, or a mismatch; never throws on shape.
 */
export function verifyMissionNonce(
  missionId: string,
  actorId: string,
  presentedToken: unknown,
  storedDigest: unknown,
): boolean {
  if (!isWellFormedMissionNonceToken(presentedToken)) return false;
  if (typeof storedDigest !== "string" || storedDigest.length === 0) return false;
  const expected = Buffer.from(deriveMissionNonceDigest(missionId, actorId, presentedToken), "utf8");
  const stored = Buffer.from(storedDigest, "utf8");
  if (expected.length !== stored.length) return false;
  return timingSafeEqual(expected, stored);
}

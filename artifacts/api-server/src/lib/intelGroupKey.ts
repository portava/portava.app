/**
 * intelGroupKey (IG-04 / V1 independent-group signal).
 *
 * Derives the ephemeral, non-reversible `group_key` the privacy gate counts as an
 * "independent group". The gate (lib/privacyGate) publishes a crowd aggregate only
 * when >=5 DISTINCT groups contributed and no single group is >20% of them — the
 * defense against one organized party reading as broad independent corroboration.
 *
 * THE ONE PROPERTY THAT MAKES IT SAFE: the key is SHARED across members of the
 * same party/crew and DISTINCT across independent groups, WITHOUT ever storing a
 * name or a membership list. It is HMAC-SHA256 of a server secret over a canonical
 * `context | subjectId | identityToken` string:
 *
 *   - crew   -> token `crew:<tripId>`   — every member of the trip collapses to ONE
 *              group (this is what stops "15 people from one organized group" from
 *              reading as 15 parties).
 *   - solo   -> token `solo:<actorId>`  — a lone visitor is its OWN independent
 *              group (per the ruling: "solo counts as a group"); per-actor, so one
 *              person can never become many groups.
 *   - null   -> NO KEY. A non-crew "with others" attestation, or an unknown/
 *              pre-signal capture, yields null: it contributes to distinctActors and
 *              confidence but earns ZERO credit toward the >=5-group requirement.
 *              This is the ruling's fail-closed rule — we never INFER separate
 *              groups from separate actors.
 *
 * WHY HMAC + a server secret (not a plain salted hash): with a server-only key the
 * digest cannot be inverted or correlated by anyone who lacks the secret, so the
 * stored token exposes nothing. subjectId is folded INSIDE the HMAC, so the same
 * crew at two different venues produces two unlinkable keys — no cross-venue party
 * graph is ever built. Temporal bounding is handled upstream by the freshness
 * window the aggregator applies, NOT by this key, so a crew never SPLITS across a
 * time boundary (splitting would inflate the group count — the wrong direction).
 *
 * TWO SPLIT HAZARDS, BOTH CLOSED HERE:
 *   1. Representation. Membership validation treats a uuid case-insensitively
 *      (Postgres uuid equality; zod .uuid() accepts mixed case), so a client could
 *      send its ONE real tripId in many case-variants and, if we hashed the raw
 *      string, get a DISTINCT key per variant — one crew read as many groups. We
 *      CANONICALISE every identity component (lowercase) before hashing, so all
 *      representations of the same id collapse to one key.
 *   2. Key stability. The token is only stable while its HMAC key is. It is keyed
 *      from a dedicated INTEL_GROUP_KEY_SECRET when set, else SESSION_SECRET; either
 *      MUST be constant across instances and over time — rotating it re-keys every
 *      group and would transiently split live crews. Prefer the dedicated secret so
 *      group stability is decoupled from session-secret rotation.
 */
import { createHmac } from "node:crypto";

/** Versioned context prefix (house idiom: telegraphBroadcast HMAC_CONTEXT). */
const GROUP_KEY_CONTEXT = "intel-group-key/v1";

/**
 * The resolved identity of an observation's independent group. `null` (no identity)
 * is handled by the caller / deriveGroupKey and yields a null key — never a group.
 */
export type GroupIdentity =
  | { kind: "crew"; crewId: string }   // shared Trip Crew / party token (strongest)
  | { kind: "solo"; actorId: string }; // a lone "Just me" observer is its own group

/**
 * The HMAC key. Prefer a dedicated INTEL_GROUP_KEY_SECRET (so group stability is
 * decoupled from session-secret rotation); fall back to SESSION_SECRET, a
 * REQUIRED env var (the server exits at boot without it — lib/envValidation), so
 * one is always present in a valid run. We do NOT fall back to a constant the way
 * Compass's token signer does: a guessable key would make the token reversible,
 * defeating the whole point. Fail-closed instead.
 */
function groupKeySecret(): string {
  const secret = process.env.INTEL_GROUP_KEY_SECRET ?? process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("INTEL_GROUP_KEY_SECRET or SESSION_SECRET is required to derive intel group_key (privacy-critical, no fallback).");
  }
  return secret;
}

/** Canonicalise an identity component so representations the validators treat as
 *  equal (uuid case variants) hash to the SAME key — else one crew splits into many. */
function canon(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Derive the group_key for one observation. Returns null when there is no
 * verifiable independent-group identity (fail-closed): such an observation still
 * counts as a person (distinctActors) but never as a group.
 *
 * @param subjectId the place the observation is about — scopes the key so parties
 *                  are unlinkable across venues.
 * @param identity  the resolved group identity, or null for unknown / non-crew party.
 */
export function deriveGroupKey(subjectId: string, identity: GroupIdentity | null): string | null {
  if (!identity || !subjectId) return null;
  const token =
    identity.kind === "crew"
      ? `crew:${canon(identity.crewId)}`
      : `solo:${canon(identity.actorId)}`;
  // subjectId is a uuid and token is kind-prefixed, so '|' is an unambiguous
  // separator (no field can contain it in a way that collides with another).
  const canonical = `${GROUP_KEY_CONTEXT}|${canon(subjectId)}|${token}`;
  return createHmac("sha256", groupKeySecret()).update(canonical).digest("hex");
}

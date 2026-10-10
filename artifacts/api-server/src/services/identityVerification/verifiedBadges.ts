/**
 * The PUBLIC verified badge (census-trust TV-0e / TV-2c) — what other people
 * are shown beside a person's name, computed with the ONE definition the
 * booking gate and the owner's own status already use
 * (currentVerification.ts `readCurrentIdentityVerification`), batched.
 *
 * ── THE OWNER'S RULING (OD-TRUST-3, 2026-10-04) ─────────────────────────────
 *   "Verified badge: Yes, for a defined, current verification state only. Make
 *    criteria visible; don't sell the badge or present it as an endorsement."
 *
 * So the badge is NOT `profiles.verified` (a legacy admin boolean the identity
 * pipeline never writes) and NOT `profiles.verification_level` on its own (a
 * sandbox-key approval writes it too). It is exactly "the person's most recent
 * finished identity check was approved, on a mode that counts, and has not been
 * withdrawn" — the three criteria below, in third person for a viewer.
 *
 * ── WHAT A VIEWER RECEIVES ───────────────────────────────────────────────────
 *   `{ tier: 'id' | 'id_selfie' }` or nothing. The tier is the level the flow
 *   wrote (`id_verified` → teal, `id_selfie_verified` → gold). Never the date,
 *   the provider, the document country, the adult fact or a reason: those are
 *   the owner's, and the badge is a fact about a check, not a profile.
 *
 * ── FAIL-CLOSED, IN THE DIRECTION THAT IS SAFE FOR A BADGE ───────────────────
 *   A badge is a claim. Any read error, an unknown mode, a missing row → NO
 *   badge. (The opposite of the booking gate's 503: there a failed read must not
 *   look like "not verified"; here a failed read must not look like "verified",
 *   and showing nothing claims nothing.)
 *
 * ── FLAG ─────────────────────────────────────────────────────────────────────
 *   `identity_verified_badge_enabled` (migration 3706, seeded FALSE). OFF /
 *   absent / unreadable: no badge is computed and no identity row is read.
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  FINISHED_ATTEMPT_STATUSES,
  providerModeCounts,
} from "./currentVerification.js";

export const IDENTITY_VERIFIED_BADGE_FLAG = "identity_verified_badge_enabled";

export type VerifiedBadgeTier = "id" | "id_selfie";
export interface PublicVerifiedBadge { tier: VerifiedBadgeTier }

/** The criteria a VIEWER is shown when they open a badge (OD-TRUST-3: "make criteria visible"). */
export const VERIFIED_BADGE_PUBLIC_CRITERIA: readonly string[] = Object.freeze([
  "Their most recent identity check with our verification provider was approved.",
  "The check used a government-issued ID, and was not a test or practice check.",
  "Their verification has not been withdrawn.",
]);

/** Travels with every badge a viewer opens. A fact about a check, not an endorsement. */
export const VERIFIED_BADGE_PUBLIC_STATEMENT =
  "Verified means this person passed an identity check. It is not an endorsement, and it cannot be bought.";

/** Most people any one response may badge (bounded batch read). */
export const VERIFIED_BADGE_BATCH_MAX = 100;

/** The two identity levels (IDENTITY_VERIFIED_LEVELS) and nothing else. */
function tierOf(level: unknown): VerifiedBadgeTier | null {
  if (level === "id_selfie_verified") return "id_selfie";
  if (level === "id_verified") return "id";
  return null;
}

/**
 * The public badges for up to {@link VERIFIED_BADGE_BATCH_MAX} people. A person
 * absent from the map has no badge. Never throws.
 */
export async function readVerifiedBadges(
  db: any,
  userIds: readonly (string | null | undefined)[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, PublicVerifiedBadge>> {
  const out = new Map<string, PublicVerifiedBadge>();
  const ids = [...new Set(userIds.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, VERIFIED_BADGE_BATCH_MAX);
  if (ids.length === 0) return out;
  if (!(await isFlagEnabled(db, IDENTITY_VERIFIED_BADGE_FLAG))) return out;
  try {
    const [attemptRead, profileRead] = await Promise.all([
      db
        .from("identity_verifications")
        .select("user_id, status, provider_mode, created_at")
        .in("user_id", ids)
        .in("status", FINISHED_ATTEMPT_STATUSES as string[])
        .order("created_at", { ascending: false })
        .limit(ids.length * 20),
      db.from("profiles").select("id, verification_level").in("id", ids),
    ]);
    if (attemptRead?.error || profileRead?.error) return out;
    const latest = new Map<string, Record<string, any>>();
    for (const a of (attemptRead?.data ?? []) as Array<Record<string, any>>) {
      const uid = a["user_id"];
      if (typeof uid !== "string" || latest.has(uid)) continue; // newest first: the first row per person is their latest
      latest.set(uid, a);
    }
    const level = new Map<string, unknown>();
    for (const p of (profileRead?.data ?? []) as Array<Record<string, any>>) level.set(String(p["id"]), p["verification_level"]);
    for (const uid of ids) {
      const a = latest.get(uid);
      if (!a || a["status"] !== "verified") continue; // criterion 1
      if (!providerModeCounts(a["provider_mode"], env)) continue; // criterion 2 (test / unrecorded never count)
      const tier = tierOf(level.get(uid)); // criterion 3: one of IDENTITY_VERIFIED_LEVELS (a withdrawal clears it)
      if (tier) out.set(uid, { tier });
    }
  } catch {
    return new Map();
  }
  return out;
}

/** One person's badge (or null). */
export async function readVerifiedBadge(db: any, userId: string, env: NodeJS.ProcessEnv = process.env): Promise<PublicVerifiedBadge | null> {
  return (await readVerifiedBadges(db, [userId], env)).get(userId) ?? null;
}

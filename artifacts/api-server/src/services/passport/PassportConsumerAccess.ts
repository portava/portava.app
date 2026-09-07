/**
 * PassportConsumerAccess — the SURFACE-ENTRY half of §21 / §35.
 *
 * `PassportConsumerProjections` answers "what may this viewer SEE of this
 * person?" — blocking (§24), the TABLE 24 location opt-outs, per-stamp and
 * per-memory visibility, the §30 capability projection. That is the same answer
 * for every consumer, which is exactly why it lives in one assembler.
 *
 * It does NOT answer the other question a consumer surface has to ask first:
 * "may this viewer ASK this surface about this person at all?" That gate is
 * surface-specific — a Telegraph header is warranted by a shared conversation, a
 * Safety card by a safe-return relationship, a Discovery/Compass person card by
 * the subject being discoverable — and before this module each surface would
 * have had to answer it inline. Four inline answers is four places the rule can
 * drift, which is the same failure §35's canonical architecture rule exists to
 * prevent, one layer up.
 *
 * So the gates live here, ONCE, beside the projection they gate (§30: "the
 * server owns viewer-specific action eligibility" — the client is never asked
 * to know any of this). Every gate is FAIL-CLOSED: a read it cannot complete
 * denies, because "we could not check" and "you may" must never render alike.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Why a consumer surface refused to project a person. */
export type ConsumerAccessReason =
  | "not_discoverable"
  | "not_in_thread"
  | "no_safety_relationship"
  | "check_failed";

export type ConsumerAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: ConsumerAccessReason };

const ALLOW: ConsumerAccessDecision = { allowed: true };
function deny(reason: ConsumerAccessReason): ConsumerAccessDecision {
  return { allowed: false, reason };
}

/**
 * Discovery + Compass person card (TABLE 22 rows 1 and 6 — §8 pairs them, and
 * so does the discovery_card variant).
 *
 * The two opt-outs are exactly the ones the Discovery *list* already applies
 * (`routes/discoverySearch.ts` → `allow_profile_discovery`, and the fail-closed
 * `age_restriction_enabled` set): a person the list must not show must not be
 * reachable by naming their id either, or the list filter is decoration. The
 * age gate is fail-closed for the same reason it is fail-closed in the list —
 * the viewer's age is not resolvable at this surface, so an age-restricted
 * subject is withheld rather than guessed at.
 *
 * Blocking and account status are NOT re-checked here: the assembler already
 * owns them (§24) and returns the variant's restricted shape, which is a
 * different and deliberate outcome from refusing the request.
 */
export async function allowDiscoveryPersonCard(
  sc: SupabaseClient,
  ownerId: string,
): Promise<ConsumerAccessDecision> {
  try {
    const [discQ, ageQ] = await Promise.all([
      sc.from("profile_privacy_settings")
        .select("allow_profile_discovery")
        .eq("user_id", ownerId)
        .maybeSingle(),
      sc.from("user_privacy_settings")
        .select("age_restriction_enabled")
        .eq("user_id", ownerId)
        .maybeSingle(),
    ]);
    if (discQ.error || ageQ.error) return deny("check_failed");
    // An absent row is the product default (discoverable, unrestricted) — the
    // same reading the list query makes, where "no row" simply fails to match
    // the `allow_profile_discovery = false` / `age_restriction_enabled = true`
    // exclusion filters.
    if ((discQ.data as any)?.allow_profile_discovery === false) return deny("not_discoverable");
    if ((ageQ.data as any)?.age_restriction_enabled === true) return deny("not_discoverable");
    return ALLOW;
  } catch {
    return deny("check_failed");
  }
}

/**
 * Telegraph conversation header (TABLE 22: "identity + relevant shared context
 * in conversation header").
 *
 * The header is warranted by the conversation, so BOTH people must be present
 * members of THIS thread — a member who left (`left_at` set) is not a present
 * member, matching how the rest of the messaging surface reads that column.
 * Naming a thread you are not in, or a person who is not in it, is refused
 * before any projection is built.
 */
export async function allowTelegraphHeader(
  sc: SupabaseClient,
  threadId: string,
  viewerId: string,
  ownerId: string,
): Promise<ConsumerAccessDecision> {
  if (viewerId === ownerId) return deny("not_in_thread");
  try {
    const { data, error } = await sc
      .from("message_thread_members")
      .select("user_id, left_at")
      .eq("thread_id", threadId)
      .in("user_id", [viewerId, ownerId]);
    if (error) return deny("check_failed");
    const present = new Set<string>(
      ((data as any[]) ?? [])
        .filter((r: any) => r.left_at == null)
        .map((r: any) => r.user_id as string),
    );
    if (!present.has(viewerId) || !present.has(ownerId)) return deny("not_in_thread");
    return ALLOW;
  } catch {
    return deny("check_failed");
  }
}

/** How many of a user's safe-return sessions are considered when matching. */
const SAFETY_SESSION_SCAN = 200;

/**
 * Safety (TABLE 22: "restricted purpose-specific context only").
 *
 * The PURPOSE is a safe-return relationship, in either direction: the subject
 * is an attached trusted contact on one of the viewer's sessions, or the viewer
 * is an attached trusted contact on one of the subject's. Absent that, there is
 * no safety purpose and nothing — not even the restricted safety shape — is
 * projected.
 */
export async function allowSafetyContext(
  sc: SupabaseClient,
  viewerId: string,
  subjectId: string,
): Promise<ConsumerAccessDecision> {
  if (viewerId === subjectId) return deny("no_safety_relationship");
  try {
    const [viewerSessions, subjectSessions] = await Promise.all([
      sc.from("safe_return_sessions").select("id").eq("user_id", viewerId).limit(SAFETY_SESSION_SCAN),
      sc.from("safe_return_sessions").select("id").eq("user_id", subjectId).limit(SAFETY_SESSION_SCAN),
    ]);
    if (viewerSessions.error || subjectSessions.error) return deny("check_failed");

    const viewerSessionIds = ((viewerSessions.data as any[]) ?? []).map((r: any) => r.id as string);
    const subjectSessionIds = ((subjectSessions.data as any[]) ?? []).map((r: any) => r.id as string);

    const [subjectIsMyContact, iAmSubjectsContact] = await Promise.all([
      viewerSessionIds.length
        ? sc.from("safe_return_contacts")
            .select("id")
            .in("session_id", viewerSessionIds)
            .eq("contact_user_id", subjectId)
            .limit(1)
        : Promise.resolve({ data: [], error: null } as any),
      subjectSessionIds.length
        ? sc.from("safe_return_contacts")
            .select("id")
            .in("session_id", subjectSessionIds)
            .eq("contact_user_id", viewerId)
            .limit(1)
        : Promise.resolve({ data: [], error: null } as any),
    ]);
    if (subjectIsMyContact.error || iAmSubjectsContact.error) return deny("check_failed");

    const linked =
      (((subjectIsMyContact.data as any[]) ?? []).length > 0) ||
      (((iAmSubjectsContact.data as any[]) ?? []).length > 0);
    return linked ? ALLOW : deny("no_safety_relationship");
  } catch {
    return deny("check_failed");
  }
}

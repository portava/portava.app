/**
 * trailAttachIntegrity — the leg of `11` §10 "every mutation is authorized"
 * that needs no owner rule (census-discovery DC-20, §61).
 *
 * `content_trails.source_id` is a bare uuid with no foreign key (2910: it is
 * polymorphic), and `attachContentToTrail` used to check neither that the id
 * exists nor that it exists in the table its declared type names (§51.6). Any
 * uuid could be attached as a post, a place or an event, spend a real
 * content's §4 budget in its name, and sit in the Trail as a member nothing
 * could ever serve or revoke.
 *
 * WHAT IS CHECKED, and where each rule comes from — none is new:
 *
 *   post, event, route  The row must exist and be one the ACTOR could be
 *                       served, by `servableMembers` — the Trail read path's one
 *                       "may this viewer see this content" helper: post
 *                       visibility, an event's public-read rule or its host, a
 *                       route's owner or trip crew (§64), standing and blocks.
 *   place               The id must name a `discovery_places` row OR a
 *                       canonical `places` row. BOTH, because existing Trail code
 *                       already treats both as place members:
 *                       `servableMembers` serves a place absent from
 *                       `discovery_places` as an authorless venue fact (a
 *                       canonical `places` row), `servedIdsForMember` folds the
 *                       `db/<uuid>` id `GET /discovery` serves for either table,
 *                       and a post's cluster place is its canonical
 *                       `places` id. Picking one table would be a product
 *                       answer to §51.10 question 5; accepting both is what the
 *                       code already does. A place with a submitter the actor
 *                       blocked (or who blocked the actor) is refused by the
 *                       same helper.
 *   itinerary           REFUSED as unverifiable. `02` §3 names itineraries and
 *                       2910 admits the type, but no table holds one, so an id
 *                       can be neither verified nor ever revoked. What an
 *                       itinerary IS remains §51.10 question 5.
 *
 * UNKNOWN AND UNSEEN ARE ONE ANSWER (`unknown_content`). An existence check
 * that answered differently for "no such post" and "a private post you may not
 * see" would be an oracle for other people's private content, so the helper's
 * visibility rule is not an extra policy layered on top: it is what makes the
 * existence check safe to have. `detachContentFromTrail` answers "unknown" and
 * "not yours" identically for the same reason.
 *
 * FAIL CLOSED. A source that cannot be read admits NOTHING in the request: the
 * caller is told `source_unreadable` (503, retryable) rather than having an
 * unverified id admitted or a readable one refused as unknown.
 *
 * WHO MAY ATTACH is decided by the caller (census-discovery §86, D-W10T-9:
 * TrailService.routeLabelsByOwnership), from the owner this verdict reports per
 * label (`ownerIds`): only the content's owner attaches; anyone else's suggestion
 * waits for that owner (3488) and spends none of the content's §4 budget.
 */
import type { MemberRow, ServableMember } from "./TrailService.js";

/** The `02` §3 components whose ids this repository can verify. */
export const VERIFIABLE_TRAIL_SOURCE_TYPES = ["post", "place", "event", "route"] as const;

export type AttachSourceRefusalReason = "unknown_content" | "unverifiable_source_type" | "not_content_owner" | "invalid_label"; // §86: the last two are the caller's

export interface AttachSourceRefusal {
  sourceType: string;
  sourceId: string;
  relationship: string;
  signal: string | null;
  reason: AttachSourceRefusalReason;
}

export interface AttachSourceVerdict {
  /** Names of the sources that could not be read; non-null means NOTHING is admitted. */
  unreadable: string[] | null;
  /** Per label, in request order: null = verified, else why it is refused. */
  reasons: Array<AttachSourceRefusalReason | null>;
  refusals: AttachSourceRefusal[]; /** §86 (DC-20): per label, the content's owner as `servableMembers` resolved it (author, host, route owner, submitter); `null` = authorless; absent for a refused label. */ ownerIds?: Array<string | null | undefined>;
}

type AttachLabel = { sourceType: string; sourceId: string; relationship: string; signal?: string | null };

/** `servableMembers`, passed in so this module never imports TrailService at runtime. */
export type ResolveServable = (
  sc: any, members: readonly MemberRow[], viewerId: string | null, nowMs?: number, unread?: Set<string>,
) => Promise<ServableMember[]>;

export async function verifyAttachSources(
  sc: any,
  labels: ReadonlyArray<AttachLabel>,
  actorId: string | null,
  resolveServable: ResolveServable,
  nowMs: number = Date.now(),
): Promise<AttachSourceVerdict> {
  const reasons: Array<AttachSourceRefusalReason | null> = labels.map((l) =>
    (VERIFIABLE_TRAIL_SOURCE_TYPES as readonly string[]).includes(l?.sourceType) ? null : "unverifiable_source_type");
  const unread = new Set<string>(); const ownerIds: Array<string | null | undefined> = labels.map(() => undefined);

  // ── place: a row in either place table ────────────────────────────────────
  const placeIds = [...new Set(labels.filter((l, i) => reasons[i] === null && l.sourceType === "place").map((l) => l.sourceId))];
  const placesFound = new Set<string>();
  if (placeIds.length > 0) {
    try {
      const [community, canonical] = await Promise.all([
        sc.from("discovery_places").select("id").in("id", placeIds),
        sc.from("places").select("id").in("id", placeIds),
      ]);
      if (community?.error || !Array.isArray(community?.data)) unread.add("discovery_places");
      else for (const r of community.data as any[]) placesFound.add(String(r?.id));
      if (canonical?.error || !Array.isArray(canonical?.data)) unread.add("places");
      else for (const r of canonical.data as any[]) placesFound.add(String(r?.id));
    } catch {
      unread.add("places");
    }
    if (unread.size > 0) return { unreadable: [...unread].sort(), reasons, refusals: [] };
    labels.forEach((l, i) => {
      if (reasons[i] === null && l.sourceType === "place" && !placesFound.has(l.sourceId)) reasons[i] = "unknown_content";
    });
  }

  // ── existence of posts, events and routes, and what the actor may see ─────
  const at = new Date(nowMs).toISOString();
  const candidates: MemberRow[] = [];
  labels.forEach((l, i) => {
    if (reasons[i] !== null) return;
    candidates.push({
      id: `attach-candidate-${i}`, trail_id: "", source_type: l.sourceType, source_id: l.sourceId,
      relationship: l.relationship as MemberRow["relationship"], signal: null, source: "user", confidence: 0,
      contributor_id: actorId, content_state: "just_arrived", created_at: at,
    });
  });
  if (candidates.length > 0) {
    let servable: ServableMember[];
    try {
      servable = await resolveServable(sc, candidates, actorId, nowMs, unread);
    } catch {
      unread.add("sources");
      servable = [];
    }
    if (unread.size > 0) return { unreadable: [...unread].sort(), reasons, refusals: [] };
    const kept = new Set(servable.map((m) => m.id)); for (const m of servable) ownerIds[Number(m.id.slice("attach-candidate-".length))] = m.creatorId;
    for (const c of candidates) {
      if (!kept.has(c.id)) reasons[Number(c.id.slice("attach-candidate-".length))] = "unknown_content";
    }
  }

  const refusals: AttachSourceRefusal[] = [];
  labels.forEach((l, i) => {
    const reason = reasons[i];
    if (reason) refusals.push({ sourceType: l.sourceType, sourceId: l.sourceId, relationship: l.relationship, signal: l.signal ?? null, reason });
  });
  return { unreadable: null, reasons, refusals, ownerIds };
}

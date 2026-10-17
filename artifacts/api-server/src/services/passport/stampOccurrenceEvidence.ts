/**
 * The occurrence evidence a PRESENCE stamp rests on — read the same way by the
 * award endpoints that accept a place and by every reader that shows one.
 *
 * census-highlights-memories H4: "Planned/saved/nearby never represented as
 * 'experienced' without occurrence evidence or user confirmation."
 *
 * The thirteen presence slugs (`PRESENCE_STAMP_SLUGS`, 2970's presence-TRUE
 * block) are minted in this tree from exactly two kinds of evidence, and the
 * evidence is named by the stamp row's own SOURCE:
 *
 *   source_type 'trips', source_id = the trip
 *       a check-in on THAT trip by THAT person — a `plan_checkins` arrival or a
 *       verified (`checkin` / `gps`) `passport_stamps` row for the trip. This is
 *       `tripCompletionPresence.ts`, which the completion writer already uses
 *       (routes/trips.ts#awardTripCompletionStamps).
 *
 *   source_type 'posts', source_id = the post
 *       a GPS stamp-eligible postcard for THAT post by THAT person, whose stamp
 *       was not revoked: `passport_postcards.stamp_eligible = true AND
 *       stamp_revoked = false`. routes/posts.ts awards city_explorer /
 *       world_citizen (and the criteria engine globe_trotter_5/10) only inside
 *       `if (verdict.stampEligible && locationCity)`, and that verdict is what
 *       `stamp_eligible` stores.
 *
 * Any other source (admin, system, criteria, a backfill) names no evidence a
 * reader can re-check. Nothing here reads a calendar, a destination, a
 * membership, an RSVP or a save: those are intent.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readTripPresenceEvidenceForPairs, EVIDENCE_CHUNK, EVIDENCE_PAGE_CEILING } from "./tripCompletionPresence.js";

/** The two sources whose row id names re-checkable occurrence evidence. */
export type EvidenceSource = "trips" | "posts";

export interface EvidencePair {
  userId: string;
  source: EvidenceSource;
  sourceId: string;
}

export const evidenceKey = (p: EvidencePair): string => `${p.userId}|${p.source}|${p.sourceId}`;

type Row = Record<string, unknown>;

/** A postcard whose GPS verdict made it stamp-eligible and whose stamp stands. */
export function postcardIsStampEvidence(row: Row | null | undefined): boolean {
  return !!row && row.stamp_eligible === true && row.stamp_revoked !== true;
}

/**
 * Which `(person, post)` pairs have a stamp-eligible, unrevoked postcard. A
 * post has at most one postcard (unique post_id), so the read is by post id in
 * chunks of EVIDENCE_CHUNK and the person is matched here. An unreadable chunk
 * (an error, a throw, a page at the ceiling) is reported, never read as "no
 * postcard".
 */
export async function readPostcardEvidenceForPairs(
  sc: SupabaseClient,
  pairs: ReadonlyArray<{ userId: string; postId: string }>,
): Promise<{ present: ReadonlySet<string>; unreadable: string[] }> {
  const present = new Set<string>();
  const wanted = new Set<string>();
  for (const p of pairs) if (p.userId && p.postId) wanted.add(`${p.userId}|${p.postId}`);
  if (wanted.size === 0) return { present, unreadable: [] };
  const posts = [...new Set([...wanted].map((k) => k.split("|")[1]))];
  let unreadable = false;
  for (let i = 0; i < posts.length; i += EVIDENCE_CHUNK) {
    const chunk = posts.slice(i, i + EVIDENCE_CHUNK);
    const res = await Promise.resolve(
      sc.from("passport_postcards").select("user_id, post_id, stamp_eligible, stamp_revoked").in("post_id", chunk),
    ).catch((err: unknown) => ({ data: null, error: { message: String(err) } }));
    if (res.error || !Array.isArray(res.data) || res.data.length >= EVIDENCE_PAGE_CEILING) { unreadable = true; continue; }
    for (const r of res.data as Row[]) {
      const key = `${String(r.user_id)}|${String(r.post_id)}`;
      if (wanted.has(key) && postcardIsStampEvidence(r)) present.add(key);
    }
  }
  return { present, unreadable: unreadable ? ["passport_postcards"] : [] };
}

export interface OccurrenceEvidence {
  /** Pairs with evidence, as `evidenceKey`. */
  present: ReadonlySet<string>;
  /** Pairs whose evidence source could not be read, as `evidenceKey`. */
  unverifiable: ReadonlySet<string>;
  /** The tables that could not be read. */
  unreadable: string[];
}

/**
 * Evidence for many pairs across both sources: at most three reads, and none
 * when no pair is asked for. A pair is `present`, `unverifiable` (its source
 * could not be read and nothing readable shows it), or neither (absent).
 */
export async function readOccurrenceEvidence(
  sc: SupabaseClient,
  pairs: ReadonlyArray<EvidencePair>,
): Promise<OccurrenceEvidence> {
  const tripPairs = pairs.filter((p) => p.source === "trips").map((p) => ({ userId: p.userId, tripId: p.sourceId }));
  const postPairs = pairs.filter((p) => p.source === "posts").map((p) => ({ userId: p.userId, postId: p.sourceId }));
  const [trips, posts] = await Promise.all([
    tripPairs.length ? readTripPresenceEvidenceForPairs(sc, tripPairs) : Promise.resolve({ present: new Set<string>(), unreadable: [] as string[] }),
    postPairs.length ? readPostcardEvidenceForPairs(sc, postPairs) : Promise.resolve({ present: new Set<string>(), unreadable: [] as string[] }),
  ]);
  const present = new Set<string>();
  const unverifiable = new Set<string>();
  for (const p of pairs) {
    const inner = `${p.userId}|${p.sourceId}`;
    const side = p.source === "trips" ? trips : posts;
    if (side.present.has(inner)) present.add(evidenceKey(p));
    // A trip pair is decided by EITHER of two tables; one readable table that
    // shows it is enough, and one that failed leaves an unshown pair unknown.
    else if (side.unreadable.length > 0) unverifiable.add(evidenceKey(p));
  }
  return { present, unverifiable, unreadable: [...trips.unreadable, ...posts.unreadable] };
}

/** The evidence a stamp row's source names, or null when it names none. */
export function evidencePairOf(row: { user_id?: unknown; source_type?: unknown; source_id?: unknown }): EvidencePair | null {
  const userId = typeof row.user_id === "string" ? row.user_id : "";
  const source = typeof row.source_type === "string" ? row.source_type.trim().toLowerCase() : "";
  const sourceId = typeof row.source_id === "string" ? row.source_id : "";
  if (!userId || !sourceId) return null;
  if (source === "trips" || source === "posts") return { userId, source, sourceId };
  return null;
}

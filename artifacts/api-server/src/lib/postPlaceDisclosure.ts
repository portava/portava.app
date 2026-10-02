/**
 * postPlaceDisclosure — mapPublicPost's place decision, carried to the post
 * readers census-media §42.6 left open (census-media §43).
 *
 * THERE IS NO NEW RULE HERE. The decision is `postPlaceWithheld` (lib/postSchemas),
 * which is itself defined as "mapPublicPost does not hand back the row it was
 * given". This module adds only the two things every remaining reader needs
 * around that one predicate:
 *
 *   1. THE OWNER BYPASS, written once. An author always sees their own post in
 *      full; every other viewer — a stranger, a follower, an anonymous caller,
 *      a viewer the caller could not identify — gets the rule.
 *
 *   2. AN INTERNAL MARK for readers whose place is still needed INSIDE the
 *      server after the decision is known (Compass's live constraints and
 *      place-affinity boost, the Wall's discovery explanation, intent steer,
 *      Live strip assembly and context threads). The mark is a SYMBOL-keyed
 *      property: `JSON.stringify` skips symbol keys, so it can never reach a
 *      response, a cache row or a log line; object spread copies it, so it
 *      survives the pipelines' shallow copies. It is set ONLY on a row the rule
 *      withholds, so a `none`-mode object is byte-for-byte what it was — not
 *      even an extra symbol key.
 *
 * The serialisation boundary of each reader then strips the place from a
 * marked object unless the viewer is the mark's author. Order, membership and
 * scoring upstream of that boundary read the same place they always read.
 *
 * Like mapPublicPost, a row whose `location_privacy_mode` was not SELECTed
 * reads as `none`. Every caller must SELECT it (and `post_status`, so a
 * released delayed post is not mistaken for an unreleased one — that mistake
 * fails closed, never open).
 */
import { postPlaceWithheld } from "./postSchemas.js";

/** The row shape the rule reads. */
export interface PostPlaceRow {
  author_id?: unknown;
  location_privacy_mode?: unknown;
  post_status?: unknown;
}

/**
 * Is this post's place withheld from THIS viewer? False for the author (the
 * owner bypass), otherwise exactly `postPlaceWithheld(row)`. A viewer that is
 * absent (anonymous) or empty is never the author.
 */
export function postPlaceWithheldFrom(row: PostPlaceRow, viewerId: string | null | undefined): boolean {
  if (typeof viewerId === "string" && viewerId.length > 0 && row.author_id != null && String(row.author_id) === viewerId) {
    return false;
  }
  return postPlaceWithheld(row);
}

/** The internal mark's key. Never serialised (symbol keys are skipped by JSON). */
export const POST_PLACE_WITHHELD: unique symbol = Symbol("census-media §43: post place withheld");

/** What the mark records: whose post it is, so the boundary can apply the owner bypass. */
export interface PostPlaceWithheldMark {
  authorId: string;
}

/**
 * The mark for a post row, to spread into the object that carries its place:
 * `{ [POST_PLACE_WITHHELD]: { authorId } }` when the rule withholds the place,
 * `{}` otherwise — so spreading it into a `none`-mode object changes nothing.
 */
export function postPlaceMark(row: PostPlaceRow): { [POST_PLACE_WITHHELD]?: PostPlaceWithheldMark } {
  if (!postPlaceWithheld(row)) return {};
  return { [POST_PLACE_WITHHELD]: { authorId: row.author_id == null ? "" : String(row.author_id) } };
}

/**
 * `ref` with the mark added when the rule withholds `row`'s place, else `ref`
 * itself (the same object). Null stays null.
 */
export function withPostPlaceMark<T extends object>(ref: T | null, row: PostPlaceRow): T | null {
  if (ref == null || !postPlaceWithheld(row)) return ref;
  return { ...ref, ...postPlaceMark(row) };
}

/**
 * Does a marked object's place have to be withheld from this viewer? False for
 * an unmarked object (the rule did not withhold it) and for the mark's author.
 * A mark with no known author is withheld from everyone.
 */
export function postPlaceMarkedWithheldFrom(obj: unknown, viewerId: string | null | undefined): boolean {
  if (obj == null || typeof obj !== "object") return false;
  const mark = (obj as { [POST_PLACE_WITHHELD]?: PostPlaceWithheldMark })[POST_PLACE_WITHHELD];
  if (!mark) return false;
  if (typeof viewerId === "string" && viewerId.length > 0 && mark.authorId === viewerId) return false;
  return true;
}

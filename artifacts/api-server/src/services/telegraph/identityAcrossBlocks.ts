/**
 * A person's IDENTITY never crosses a block on Telegraph's lists either.
 *
 * census-telegraph §45d.3 (re-verification 4) made the conversation header
 * withhold the other person's handle, name and avatar across a block in either
 * direction, failing closed on an unreadable block read — the rule
 * `profiles_select` applies to a client that reads `profiles` itself. It then
 * RECORDED, not fixed, that the same identity reached the same blocked viewer
 * on two other surfaces, both built with the service client (which bypasses
 * that rule):
 *
 *   GET /me/threads                     every member's handle, name, avatar
 *   GET /threads/:threadId/messages     every row's senderHandle / senderName /
 *                                       senderAvatarUrl, and each quoted
 *                                       reply's sender name
 *
 * so inside the very DM whose header hid the blocker, every message row and
 * the inbox row still carried their handle and current avatar. Both now ask
 * this module which ids' identity to withhold.
 *
 * ── WHAT IS WITHHELD, AND WHAT IS NOT ───────────────────────────────────────
 * The identity — handle, name, avatar. NOT the user id, which every message row
 * already carries as `senderId` and every send door needs; NOT the messages
 * themselves, whose existence the thread already established. The viewer's own
 * identity is never withheld from them.
 *
 * ── FAIL DIRECTION ──────────────────────────────────────────────────────────
 * `lib/exclusionSet.ts` shape 2: the block set scopes ONE part of a response
 * whose other parts are not block-scoped, so an unreadable block read withholds
 * EVERY other person's identity and leaves the rest of the response intact.
 * "Could not check" is never "no block".
 *
 * ── SIZE ────────────────────────────────────────────────────────────────────
 * The inbox's roster spans every member of every thread a person is in. The
 * ids are asked in chunks so no `.in()` list grows past a URL PostgREST
 * accepts; one unreadable chunk makes the whole answer unreadable.
 */
import { isExcluded, readBlockExclusions, type ExclusionSet } from "../../lib/exclusionSet.js";

/** Ids per `.in()` read. Well under PostgREST's URL limit and db-max-rows. */
export const IDENTITY_BLOCK_CHUNK = 150;

export interface IdentityWithholding {
  /** True when this id's identity must not be shown to the viewer. */
  readonly withhold: (id: string | null | undefined) => boolean;
  /** True when the block state could not be read (every other identity is withheld). */
  readonly unreadable: boolean;
}

export async function identityWithheldAcrossBlocks(
  sc: unknown,
  viewerId: string,
  ids: readonly (string | null | undefined)[],
): Promise<IdentityWithholding> {
  const others = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id !== viewerId))];
  const blocked = new Set<string>();
  let unreadable = false;
  for (let i = 0; i < others.length && !unreadable; i += IDENTITY_BLOCK_CHUNK) {
    let set: ExclusionSet;
    try {
      set = await readBlockExclusions(sc, viewerId, { among: others.slice(i, i + IDENTITY_BLOCK_CHUNK) });
    } catch (err) {
      set = { ok: false, reason: String((err as Error)?.message ?? err) };
    }
    if (!set.ok) unreadable = true;
    else for (const id of set.ids) blocked.add(id);
  }
  const answer: ExclusionSet = unreadable ? { ok: false, reason: "blocks unreadable" } : { ok: true, ids: blocked };
  return {
    unreadable,
    withhold: (id) => typeof id === "string" && id !== viewerId && isExcluded(answer, id),
  };
}

/**
 * Reader FACES for the receipt chips (census-telegraph T295). The app used to
 * read `profiles.avatar_url` itself for the ids a receipt named
 * (`useReaderAvatars`), the one raw read left on the conversation surface. The
 * receipts route now answers the faces with the receipt, under the rule the
 * app's read got from `profiles_select`, applied here because the route reads
 * with the service client: no face across a block either way; a PRIVATE
 * profile's face only to a friend; the viewer's own face always.
 *
 * DECORATIVE, and the failure says so: an unreadable profile read answers no
 * faces and `degraded: true`; an unreadable block read withholds every other
 * face; an unreadable friendship read withholds the private ones. None of it
 * changes what the receipt claims — the count and the ids are the receipt's.
 */
export async function readerFacesFor(
  sc: any,
  viewerId: string,
  ids: readonly string[],
): Promise<{ faces: Record<string, string | null>; degraded: boolean }> {
  const want = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const faces: Record<string, string | null> = {};
  if (want.length === 0) return { faces, degraded: false };
  const { data: rows, error } = await sc.from("profiles").select("id, avatar_url, is_private").in("id", want);
  if (error) return { faces, degraded: true };
  const blocks = await identityWithheldAcrossBlocks(sc, viewerId, want);
  const byId = new Map<string, { avatar_url?: unknown; is_private?: unknown }>();
  for (const r of (rows ?? []) as Array<{ id?: unknown; avatar_url?: unknown; is_private?: unknown }>) byId.set(String(r.id), r);
  const privateIds = want.filter((id) => id !== viewerId && byId.get(id)?.is_private === true && !blocks.withhold(id));
  let friends: Set<string> | null = new Set<string>();
  if (privateIds.length > 0) {
    const [asA, asB] = await Promise.all([
      sc.from("user_friendships").select("user_b").eq("user_a", viewerId).in("user_b", privateIds),
      sc.from("user_friendships").select("user_a").eq("user_b", viewerId).in("user_a", privateIds),
    ]);
    friends = asA?.error || asB?.error ? null : new Set<string>([
      ...((asA?.data ?? []) as Array<{ user_b?: unknown }>).map((r) => String(r.user_b)),
      ...((asB?.data ?? []) as Array<{ user_a?: unknown }>).map((r) => String(r.user_a)),
    ]);
  }
  for (const id of want) {
    const row = byId.get(id);
    const url = row && typeof row.avatar_url === "string" ? row.avatar_url : null;
    if (id === viewerId) { faces[id] = url; continue; }
    if (blocks.withhold(id)) { faces[id] = null; continue; }
    if (row?.is_private === true && !(friends?.has(id) ?? false)) { faces[id] = null; continue; }
    faces[id] = url;
  }
  return { faces, degraded: blocks.unreadable || friends === null };
}

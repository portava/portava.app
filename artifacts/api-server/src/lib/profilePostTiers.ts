/**
 * profilePostTiers — which `posts.visibility` tiers a viewer may read on a
 * PROFILE tab (GET /users/:username/posts).
 *
 * The profile tab lists one author's posts. It must answer the same question
 * `decidePostReadable` (lib/postVisibility.ts) answers for a single post, for
 * a whole page at once, so the filter can run in the database and pagination
 * stays honest:
 *
 *   owner             → every tier (their own tab)
 *   follower          → public + followers_only
 *   anyone else       → public
 *
 * `trip_only` is never on another person's profile tab: it is readable by the
 * trip's accepted members, and the tab does no per-trip membership check, so
 * the only safe answer here is "not on this surface" (the post stays readable
 * in its trip). `private` is the author's alone.
 *
 * The follow edge is read with its error bound. supabase-js RESOLVES on a
 * database error, so an unbound read would turn an outage into "not a
 * follower" and silently shorten a follower's view of the tab. `null` means
 * "could not be decided" and the route answers 503 instead (DV-83).
 */
export type PostTier = "public" | "followers_only" | "trip_only" | "private";

export async function profilePostTiers(
  sc: any,
  viewerId: string | null,
  authorId: string,
  isOwner: boolean,
): Promise<PostTier[] | null> {
  if (isOwner) return ["public", "followers_only", "trip_only", "private"];
  if (!viewerId) return ["public"];
  const { data, error } = await sc
    .from("user_follows")
    .select("follower_id")
    .eq("follower_id", viewerId)
    .eq("following_id", authorId)
    .maybeSingle();
  if (error) return null;
  return data ? ["public", "followers_only"] : ["public"];
}

/**
 * privacyFilter — shared guard for post-fetch privacy enforcement.
 *
 * Excludes posts from private-account authors that the viewer is not an
 * approved follower of.  Must be applied after block filtering so the
 * two guards compose correctly.
 *
 * Fail-open:  if the profiles query fails, rows pass through unchanged
 *             (avoids breaking the feed on a transient DB hiccup).
 * Fail-closed: if the follows query fails, all private authors are treated
 *             as non-followed (privacy takes precedence over availability).
 */

/**
 * excludePrivateAuthorPosts
 *
 * Removes rows authored by private accounts the viewer does not follow.
 * The viewer's own posts always pass through regardless of account privacy.
 *
 * @param rows        Post/item rows with an author ID field (snake_case).
 * @param viewerId    Authenticated viewer's user ID.
 * @param sc          Service-role Supabase client.
 * @param opts.authorKey
 *   Field name holding the author UUID (default: "author_id").
 * @param opts.profilesKey
 *   When the fetch query already joined profile data, pass the key that
 *   holds the joined profile object (e.g. "profiles"). The function reads
 *   `row[profilesKey].is_private` to determine privacy without an extra
 *   round-trip.  Leave undefined when profiles were not joined.
 */
export async function excludePrivateAuthorPosts<T extends Record<string, any>>(
  rows: T[],
  viewerId: string,
  sc: any,
  opts?: {
    authorKey?: string;
    profilesKey?: string;
  },
): Promise<T[]> {
  if (rows.length === 0) return rows;

  const authorKey  = opts?.authorKey  ?? "author_id";
  const profilesKey = opts?.profilesKey;

  // Build the set of unique author IDs, excluding the viewer themselves
  // (a user's own posts always pass regardless of their privacy setting).
  const uniqueOtherAuthorIds = [
    ...new Set(
      rows
        .map((r) => r[authorKey] as string | undefined)
        .filter((id): id is string => typeof id === "string" && id !== viewerId),
    ),
  ];
  if (uniqueOtherAuthorIds.length === 0) return rows;

  // ── Step 1: Identify private authors ────────────────────────────────────
  let privateAuthorIds: string[];

  if (profilesKey) {
    // Read is_private directly from already-joined profile data — no extra query.
    const seen = new Set<string>();
    privateAuthorIds = [];
    for (const r of rows) {
      const authorId = r[authorKey] as string | undefined;
      if (!authorId || authorId === viewerId || seen.has(authorId)) continue;
      seen.add(authorId);
      const rawProfile = r[profilesKey];
      const profile = Array.isArray(rawProfile) ? rawProfile[0] : rawProfile;
      if (profile?.is_private === true) {
        privateAuthorIds.push(authorId);
      }
    }
  } else {
    // Query profiles table for is_private status.
    try {
      const { data } = await sc
        .from("profiles")
        .select("id")
        .in("id", uniqueOtherAuthorIds)
        .eq("is_private", true);
      privateAuthorIds = ((data as any[]) ?? []).map((r: any) => r.id as string);
    } catch {
      // Fail-open: cannot determine privacy → let rows through unchanged.
      return rows;
    }
  }

  if (privateAuthorIds.length === 0) return rows; // no private authors

  // ── Step 2: Find which private authors the viewer follows ────────────────
  let approvedSet = new Set<string>();
  try {
    const { data } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId)
      .in("following_id", privateAuthorIds);
    for (const r of (data as any[]) ?? []) approvedSet.add(r.following_id as string);
  } catch {
    // Fail-closed: unknown follows → treat all private authors as non-followed.
    approvedSet = new Set();
  }

  // Build the exclusion set: private authors the viewer does NOT follow.
  const excludeSet = new Set(privateAuthorIds.filter((id) => !approvedSet.has(id)));
  if (excludeSet.size === 0) return rows;

  return rows.filter((r) => {
    const authorId = r[authorKey] as string | undefined;
    return !authorId || authorId === viewerId || !excludeSet.has(authorId);
  });
}

/**
 * privacyFilter — shared guard for post-fetch privacy enforcement.
 *
 * Excludes posts from private-account authors that the viewer is not an
 * approved follower of.  Must be applied after block filtering so the
 * two guards compose correctly.
 *
 * Fail-closed (BOTH reads).  An unreadable privacy input is never read as
 * "no restriction":
 *   • profiles read fails  → every other author is treated as private AND
 *     non-followed, so only the viewer's own rows survive.  (This used to be
 *     documented as "fail-open" and, worse, did not even reach the documented
 *     path: supabase-js RESOLVES `{data: null, error}` rather than throwing, so
 *     `data ?? []` silently produced an EMPTY private-author list and published
 *     every private account's rows to the viewer.)
 *   • follows read fails   → all private authors are treated as non-followed.
 * A transient DB hiccup therefore degrades the feed, it does not widen it.
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
    //
    // PostgREST reports failures in `error` and RESOLVES the promise, so the
    // catch below only fires for transport-level rejections. Both paths must be
    // handled, and both fail CLOSED: an unreadable `is_private` means we cannot
    // prove any author is public, so every non-viewer author is withheld.
    let privacyReadFailed = false;
    try {
      const { data, error } = await sc
        .from("profiles")
        .select("id")
        .in("id", uniqueOtherAuthorIds)
        .eq("is_private", true);
      if (error || !Array.isArray(data)) {
        privacyReadFailed = true;
        privateAuthorIds = [];
      } else {
        privateAuthorIds = (data as any[]).map((r: any) => r.id as string);
      }
    } catch {
      privacyReadFailed = true;
      privateAuthorIds = [];
    }
    if (privacyReadFailed) {
      // Fail-CLOSED: treat every other author as private and non-followed.
      return rows.filter((r) => {
        const authorId = r[authorKey] as string | undefined;
        return !authorId || authorId === viewerId;
      });
    }
  }

  if (privateAuthorIds.length === 0) return rows; // no private authors

  // ── Step 2: Find which private authors the viewer follows ────────────────
  let approvedSet = new Set<string>();
  try {
    const { data, error } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId)
      .in("following_id", privateAuthorIds);
    // Explicit: a resolved `{data: null, error}` must not read as "follows none
    // of them" by accident — it is the same fail-closed answer, stated on purpose.
    if (error || !Array.isArray(data)) approvedSet = new Set();
    else for (const r of data as any[]) approvedSet.add(r.following_id as string);
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

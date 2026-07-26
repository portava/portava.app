/**
 * mediaEligibility — content eligibility filter for the Watch mode media feed.
 *
 * filterEligibleMediaCandidates enforces ALL eligibility gates BEFORE any
 * scoring occurs. Gates (in order):
 *   1. Processing state — only ready media
 *   2. Moderation state — not flagged or rejected
 *   3. Visibility — public only (for_you) or followed-creator (following)
 *   4. Post status — only active/published posts
 *   5. Blocks — bidirectional fail-closed
 *   6. Mutes — viewer muted the creator
 *   7. Creator account status — suspended creators excluded
 *   8. Story expiration — expired stories excluded
 *   9. Creator suspension from DB profile
 *
 * Fail-closed: if blocks cannot be fetched, return empty (never risk surfacing
 * content from blocked users).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type FeedType = "for_you" | "following";

export interface ViewerCtx {
  viewerUserId: string;
  feedType: FeedType;
  /** IDs the viewer follows — required when feedType='following'. */
  followedCreatorIds: Set<string>;
}

export interface EligibilityResult {
  eligible: MediaCandidate[];
  /** True if block fetch failed — caller should treat as empty feed. */
  blockFetchFailed: boolean;
}

/** Minimal shape of a candidate row from the DB. */
export interface MediaCandidate {
  id: string;
  author_id: string;
  status?: string;
  post_status?: string;
  visibility?: string;
  moderation_status?: string;
  expires_at?: string | null;
  created_at: string;
  /** post_media child rows (pre-fetched). */
  post_media?: any[];
  /** Creator profile row (pre-fetched). */
  profiles?: any;
  /** Raw tags array. */
  tags?: string[];
  [key: string]: unknown;
}

/**
 * Filter a raw list of candidates down to eligible items.
 *
 * @param candidates — raw DB rows to filter
 * @param viewerCtx — viewer context including feedType and followed ids
 * @param sc — Supabase service client (for blocks + mutes lookup)
 * @param mutedCreatorIds — optional pre-fetched muted set (pass null to load from DB)
 */
export async function filterEligibleMediaCandidates(
  candidates: MediaCandidate[],
  viewerCtx: ViewerCtx,
  sc: SupabaseClient,
  mutedCreatorIds?: Set<string> | null,
): Promise<EligibilityResult> {
  if (candidates.length === 0) {
    return { eligible: [], blockFetchFailed: false };
  }

  // ── Step 1: Blocks (fail-closed) ───────────────────────────────────────────
  let blockFetchFailed = false;
  const blockedSet = new Set<string>();
  try {
    const [blockedRes, blockerRes] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", viewerCtx.viewerUserId),
      sc.from("blocks").select("blocker_id").eq("blocked_id", viewerCtx.viewerUserId),
    ]);
    if (blockedRes.error || blockerRes.error) {
      blockFetchFailed = true;
    } else {
      for (const r of (blockedRes.data as any[]) ?? []) blockedSet.add(r.blocked_id as string);
      for (const r of (blockerRes.data as any[]) ?? []) blockedSet.add(r.blocker_id as string);
    }
  } catch {
    blockFetchFailed = true;
  }

  if (blockFetchFailed) {
    return { eligible: [], blockFetchFailed: true };
  }

  // ── Step 2: Mutes ──────────────────────────────────────────────────────────
  let muteSet = mutedCreatorIds ?? new Set<string>();
  if (mutedCreatorIds === null || mutedCreatorIds === undefined) {
    try {
      const { data: muteRows } = await sc
        .from("user_mutes")
        .select("muted_id")
        .eq("muter_id", viewerCtx.viewerUserId);
      for (const r of (muteRows as any[]) ?? []) muteSet.add(r.muted_id as string);
    } catch { /* best-effort: mutes contribute empty set on failure */ }
  }

  // ── Step 3: Collect unique creator ids to check account status ────────────
  const creatorIds = [...new Set(candidates.map((c) => c.author_id))];
  const suspendedCreatorIds = new Set<string>();
  if (creatorIds.length > 0) {
    try {
      const { data: profileRows } = await sc
        .from("profiles")
        .select("id, account_status")
        .in("id", creatorIds)
        .in("account_status", ["suspended", "banned"]);
      for (const r of (profileRows as any[]) ?? []) {
        suspendedCreatorIds.add(r.id as string);
      }
    } catch { /* best-effort: suspended set stays empty on failure */ }
  }

  // ── Step 4: Per-item eligibility gates ────────────────────────────────────
  const now = Date.now();
  const eligible = candidates.filter((c) => {
    const authorId = c.author_id;

    // Block gate
    if (blockedSet.has(authorId)) return false;

    // Mute gate
    if (muteSet.has(authorId)) return false;

    // Creator suspension gate
    if (suspendedCreatorIds.has(authorId)) return false;

    // Post/story status gate
    const status = c.status ?? "active";
    if (status !== "active") return false;

    // Delayed-publish gate: post_status must be published (or null for non-delayed posts)
    const postStatus = c.post_status;
    if (postStatus && postStatus !== "published") return false;

    // Visibility gate
    const visibility = c.visibility ?? "public";
    if (viewerCtx.feedType === "following") {
      // Following feed: creator must be followed OR be the viewer themselves
      if (authorId !== viewerCtx.viewerUserId && !viewerCtx.followedCreatorIds.has(authorId)) {
        return false;
      }
    } else {
      // For-you feed: only public items
      if (visibility !== "public") return false;
    }

    // Moderation gate
    const modStatus = c.moderation_status;
    if (modStatus === "rejected" || modStatus === "flagged" || modStatus === "removed") {
      return false;
    }

    // Expiration gate (for stories)
    if (c.expires_at) {
      const expiresAt = new Date(c.expires_at).getTime();
      if (expiresAt <= now) return false;
    }

    // Media readiness gate: item must have at least one ready, unrejected media row
    const rawMedia = c.post_media ?? [];
    if (rawMedia.length === 0) {
      // No media attached — skip (Watch mode requires media)
      return false;
    }
    const readyMedia = rawMedia.filter(
      (m: any) =>
        m.processing_status === "ready" &&
        m.moderation_status !== "rejected" &&
        m.moderation_status !== "flagged",
    );
    if (readyMedia.length === 0) return false;

    return true;
  });

  return { eligible, blockFetchFailed: false };
}

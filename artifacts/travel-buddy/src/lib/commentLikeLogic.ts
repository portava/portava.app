/**
 * Pure helpers for comment like / unlike interactions.
 * Extracted so they can be unit-tested without React or RN dependencies.
 */

export interface OptimisticLikeResult {
  likedByMe: boolean;
  likeCount: number;
}

/**
 * Compute the optimistic UI state for a like/unlike toggle.
 * Call this before the API request so the UI updates immediately.
 * The count never goes below 0 when unliking.
 */
export function computeOptimisticLike(
  likedByMe: boolean,
  likeCount: number,
): OptimisticLikeResult {
  return {
    likedByMe: !likedByMe,
    likeCount: likedByMe ? Math.max(0, likeCount - 1) : likeCount + 1,
  };
}

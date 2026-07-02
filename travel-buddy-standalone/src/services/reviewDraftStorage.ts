/**
 * Pure helper — AsyncStorage read/write for review drafts.
 *
 * Extracted from the ReviewComposer screen so the persistence logic is
 * testable without a native runtime or React.
 *
 * Draft key is deterministic: `review_draft__{entityType}__{entityId}`.
 * One draft per entity is kept; a successful submission clears it.
 */

export interface ReviewDraft {
  rating: number;
  body: string;
  tags: string[];
  anonymous: boolean;
  savedAt: string;
}

/** Minimal subset of AsyncStorage needed by these helpers. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function reviewDraftKey(entityType: string, entityId: string): string {
  return `review_draft__${entityType}__${entityId}`;
}

function isValidDraft(v: unknown): v is ReviewDraft {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.rating === 'number' &&
    d.rating >= 1 &&
    d.rating <= 5 &&
    typeof d.body === 'string' &&
    Array.isArray(d.tags) &&
    (d.tags as unknown[]).every((t) => typeof t === 'string') &&
    typeof d.anonymous === 'boolean' &&
    typeof d.savedAt === 'string'
  );
}

/**
 * Read a saved draft for the given entity.
 * Returns null when no draft exists, the stored value is invalid, or storage fails.
 */
export async function loadReviewDraft(
  storage: StorageLike,
  entityType: string,
  entityId: string,
): Promise<ReviewDraft | null> {
  try {
    const stored = await storage.getItem(reviewDraftKey(entityType, entityId));
    if (!stored) return null;
    const parsed: unknown = JSON.parse(stored);
    return isValidDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist a draft for the given entity.
 * Adds the current timestamp as `savedAt`.
 * Errors are swallowed — this is fire-and-forget.
 */
export function saveReviewDraft(
  storage: StorageLike,
  entityType: string,
  entityId: string,
  draft: Omit<ReviewDraft, 'savedAt'>,
): void {
  const full: ReviewDraft = { ...draft, savedAt: new Date().toISOString() };
  storage
    .setItem(reviewDraftKey(entityType, entityId), JSON.stringify(full))
    .catch(() => {});
}

/**
 * Remove the draft for the given entity.
 * Call this after a successful submission.
 * Errors are swallowed — fire-and-forget.
 */
export function clearReviewDraft(
  storage: StorageLike,
  entityType: string,
  entityId: string,
): void {
  storage.removeItem(reviewDraftKey(entityType, entityId)).catch(() => {});
}

/**
 * Returns true when the fetch error is a network-layer failure rather than
 * a server-returned error response.  Covers React Native's "Network request
 * failed" TypeError and browser-equivalent messages.
 */
export function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('network request failed') ||
    m.includes('failed to fetch') ||
    m.includes('err_address_unreachable') ||
    m.includes('networkerror')
  );
}

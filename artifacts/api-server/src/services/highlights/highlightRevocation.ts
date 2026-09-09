/**
 * highlightRevocation — §21 "Deletion, Forgetting, and Revocation" for the
 * Highlights surface.
 *
 * Highlights/Memories Development Architecture Spec v1 §21:
 *
 *   "Delete, archive, do-not-resurface, and 'keep but do not personalize' are
 *    different operations and must remain separate in both data model and UX."
 *
 *   Archive             Retain canonical Memory; remove from normal browsing
 *                       unless explicitly requested.
 *   Do not resurface    Retain and search privately; suppress proactive
 *                       resurfacing.
 *   Do not personalize  Retain Memory but exclude from preference/recommendation
 *                       inference.
 *   Make private        Revoke public derivatives and public indexing while
 *                       retaining private Memory.
 *   Delete Memory       Revoke derivatives, remove indexes/embeddings, then
 *                       purge canonical/eligible evidence per policy.
 *   Delete media asset  Remove asset and derivatives; Memory may survive if
 *                       other evidence remains.
 *
 *   "Revocation propagation must cover public projection, search index, semantic
 *    embedding, profile Highlight, Trip story derivative, Passport reference,
 *    cached narrative, and any share link. Deletion should be observable,
 *    retryable, and dead-lettered if a downstream cleanup repeatedly fails."
 *
 * And §5's deletion lifecycle, which is NOT the §5 Highlight lifecycle:
 *   ACTIVE -> DELETION_REQUESTED -> PUBLIC_REVOKED -> DERIVATIVES_PURGED
 *          -> RAW_EVIDENCE_PURGED (where policy allows) -> DELETED
 *
 * Census ids: H186 (archive), H187 (do-not-resurface), H188 (do-not-personalize),
 * H189 (make private), H190 (delete), H191 (delete media), H192 (propagation),
 * H193 (observable / retryable / dead-lettered).
 *
 * ── THE ONE THING THIS FILE MUST NEVER DO ───────────────────────────────────
 * Report a destination as revoked that it did not reach. A revocation report
 * whose every entry says "done" because the code never tried is worse than no
 * report: it is an auditable claim that a user's data was removed from places it
 * is still in. So every destination carries an explicit status, `not_implemented`
 * is a first-class outcome that is REPORTED rather than omitted, and
 * `RevocationReport.complete` is true only when every applicable destination
 * reached `revoked`.
 *
 * ── MEASURED FACTS BEHIND THE DESTINATION TABLE (2026-09-08) ───────────────
 * Every `implementedBy` below was checked, not assumed:
 *
 *   • Compass cache — `compass/CompassCacheEngine.js` `invalidate(sc, userId,
 *     reason)` exists and IS called by routes/highlights.ts, but ONLY from
 *     POST /highlights/:id/report. DELETE /highlights/:id did not call it, so a
 *     deleted Highlight could survive in a cached Compass feed. That is a real
 *     destination that exists and was simply not wired to deletion; it is wired
 *     now, and it is the only entry in this table with a working handler.
 *
 *   • Search index / semantic embedding — grep for an embeddings or search-index
 *     table fed by `highlights` returns nothing. There is no destination.
 *     `not_applicable`, with the reason recorded, is the honest status; calling
 *     it `revoked` would be a fabrication and calling it `failed` would imply a
 *     retry could help.
 *
 *   • Media bytes — the Highlight's `media_url` object is NOT removed by
 *     anything. `lib/deletionDispositions.ts` places `highlights`,
 *     `highlight_likes`, `highlight_reports` and `highlight_views` in
 *     UNCLASSIFIED_BACKLOG, whose own header states the meaning: "the data
 *     survives deletion and no one has said whether it should". Their fate is
 *     owner decision D6 and is NOT decided here.
 *
 *   • ACCOUNT DELETION DOES NOT REACH THIS SURFACE AT ALL, and this contradicts
 *     the census. `AccountDeletionService.ts` issues no read or write against
 *     any `highlight*` table (grepped), and its header records why the FK could
 *     not do it either: "public.profiles has NO foreign key to auth.users … the
 *     tombstone survives, none of those 163 cascades fire on their own — every
 *     content table below has to be handled here by hand." `highlights.owner_id
 *     REFERENCES profiles(id) ON DELETE CASCADE` (migrations/0026_highlights.sql:9)
 *     therefore never fires, because the `profiles` row is never deleted.
 *     The census's H84 cites `deletionDispositions.ts:352` as evidence that
 *     deletion "reaches … every highlight table"; line 352 is inside
 *     UNCLASSIFIED_BACKLOG, not ERASED_BY_CASCADE. H84's blocking half stands;
 *     its deletion half does not. Not fixed here — `deletionDispositions.ts` and
 *     `AccountDeletionService.ts` belong to another lane and D6 is an owner
 *     decision — but it is stated where a reader of the revocation code will
 *     see it.
 */

// ── §21 operations ───────────────────────────────────────────────────────────

export const HIGHLIGHT_LIFECYCLE_OPERATIONS = [
  "ARCHIVE",
  "DO_NOT_RESURFACE",
  "DO_NOT_PERSONALIZE",
  "MAKE_PRIVATE",
  "DELETE_HIGHLIGHT",
  "DELETE_MEDIA_ASSET",
] as const;
export type HighlightLifecycleOperation = (typeof HIGHLIGHT_LIFECYCLE_OPERATIONS)[number];

/**
 * §21's table as data, with the two properties that make the operations
 * SEPARATE rather than degrees of one slider:
 *
 *   retainsRecord  — does the Highlight row survive?
 *   reversible     — can the user undo it?
 *
 * Read the two columns together and the spec's insistence becomes checkable:
 * ARCHIVE and DELETE_HIGHLIGHT both remove a Highlight from browsing, and they
 * differ on BOTH properties. A data model that stores them in one column cannot
 * be right.
 */
export const OPERATION_SEMANTICS: Readonly<
  Record<
    HighlightLifecycleOperation,
    {
      readonly retainsRecord: boolean;
      readonly reversible: boolean;
      readonly removesFromBrowsing: boolean;
      readonly effect: string;
      readonly storedIn: string;
    }
  >
> = Object.freeze({
  ARCHIVE: {
    retainsRecord: true,
    reversible: true,
    removesFromBrowsing: true,
    effect: "Retain the Highlight; remove from normal browsing unless explicitly requested.",
    storedIn: "highlights.archived_at (exists since migration 0026; unreferenced by any TypeScript before 2026-09-08)",
  },
  DO_NOT_RESURFACE: {
    retainsRecord: true,
    reversible: true,
    removesFromBrowsing: false,
    effect: "Retain and search privately; suppress proactive resurfacing. Explicit retrieval still works.",
    storedIn: "highlight_resurfacing_preferences (migration 2720, NOT applied)",
  },
  DO_NOT_PERSONALIZE: {
    retainsRecord: true,
    reversible: true,
    removesFromBrowsing: false,
    effect: "Retain the Highlight but exclude it from preference/recommendation inference. It stays visible.",
    storedIn: "highlight_resurfacing_preferences, control RETAIN_BUT_DO_NOT_PERSONALIZE (migration 2720, NOT applied)",
  },
  MAKE_PRIVATE: {
    retainsRecord: true,
    reversible: true,
    removesFromBrowsing: false,
    effect: "Revoke public derivatives and public indexing; the Highlight itself survives, visible to its owner.",
    storedIn: "highlights.visibility = 'private' (exists today; no route currently updates it)",
  },
  DELETE_HIGHLIGHT: {
    retainsRecord: false,
    reversible: false,
    removesFromBrowsing: true,
    effect: "Revoke derivatives, remove indexes/embeddings, then purge canonical evidence per policy.",
    storedIn: "highlights.deleted_at — a SOFT delete; the row and its media bytes survive (owner decision D6)",
  },
  DELETE_MEDIA_ASSET: {
    retainsRecord: true,
    reversible: false,
    removesFromBrowsing: false,
    effect: "Remove the asset and its derivatives; the Highlight may survive if other evidence remains.",
    storedIn: "NOT IMPLEMENTED on this surface — a Highlight is its media, so there is no other evidence to survive on",
  },
});

// ── §21 revocation destinations ──────────────────────────────────────────────

/** The eight destinations §21 names, verbatim and in the spec's order. */
export const REVOCATION_DESTINATIONS = [
  "public_projection",
  "search_index",
  "semantic_embedding",
  "profile_highlight",
  "trip_story_derivative",
  "passport_reference",
  "cached_narrative",
  "share_link",
] as const;
export type RevocationDestination = (typeof REVOCATION_DESTINATIONS)[number];

export type DestinationStatus =
  /** Reached, and it reported success. */
  | "revoked"
  /** Attempted and it failed. Retryable. */
  | "failed"
  /** No such destination exists in this repository to propagate to. */
  | "not_applicable"
  /** The destination exists but nothing here reaches it yet. NOT a success. */
  | "not_implemented";

export interface DestinationOutcome {
  readonly destination: RevocationDestination;
  readonly status: DestinationStatus;
  readonly detail: string;
}

/**
 * What each destination MEANS on this surface, and — measured — whether
 * anything in this repository can reach it. The `detail` strings are the
 * evidence, and they are what a report shows an operator.
 */
const DESTINATION_PLAN: Readonly<
  Record<RevocationDestination, { readonly status: Exclude<DestinationStatus, "revoked" | "failed">; readonly detail: string }>
> = Object.freeze({
  public_projection: {
    status: "not_implemented",
    detail:
      "the Highlight row itself IS the public projection; the soft delete removes it from every read on this surface, but the media object at media_url stays publicly served (owner decision D6)",
  },
  search_index: {
    status: "not_applicable",
    detail: "no search index is fed from `highlights`; there is no destination to revoke from",
  },
  semantic_embedding: {
    status: "not_applicable",
    detail: "no embedding table is fed from `highlights`",
  },
  profile_highlight: {
    status: "not_implemented",
    detail:
      "GET /users/:id/highlights filters deleted_at, so the profile stops serving it — but that is the read filtering, not a revocation the deleter performed",
  },
  trip_story_derivative: {
    status: "not_implemented",
    detail:
      "stories.saved_to_highlight_id points at this row; deleting the Highlight does not clear it. routes/stories.ts is another lane's surface",
  },
  passport_reference: {
    status: "not_applicable",
    detail: "no passport_* table references a highlight id",
  },
  cached_narrative: {
    status: "not_implemented",
    detail: "the Compass cache is the only cache; it is handled as a real destination, see planRevocation",
  },
  share_link: {
    status: "not_applicable",
    detail: "no share-link table exists for Highlights; there is no token to invalidate",
  },
});

export interface RevocationReport {
  readonly operation: HighlightLifecycleOperation;
  readonly subjectId: string;
  readonly outcomes: readonly DestinationOutcome[];
  /** True ONLY when every destination that is not `not_applicable` is `revoked`. */
  readonly complete: boolean;
  /** Destinations that must be retried, or escalated to a dead letter. */
  readonly retryable: readonly RevocationDestination[];
}

/**
 * The plan for one operation, before anything is attempted.
 *
 * `cached_narrative` is upgraded from the static table when a cache
 * invalidator is available, because it is the one destination this surface can
 * actually reach; every other entry keeps its measured status.
 */
export function planRevocation(
  operation: HighlightLifecycleOperation,
  opts: { readonly cacheInvalidatorAvailable?: boolean } = {},
): DestinationOutcome[] {
  return REVOCATION_DESTINATIONS.map((destination) => {
    const base = DESTINATION_PLAN[destination];
    if (destination === "cached_narrative" && opts.cacheInvalidatorAvailable) {
      return {
        destination,
        status: "not_implemented" as DestinationStatus,
        detail: "Compass cache invalidation pending",
      };
    }
    return { destination, status: base.status as DestinationStatus, detail: base.detail };
  });
}

/** Fold a set of outcomes into a report. Pure; the caller supplies the outcomes. */
export function summariseRevocation(
  operation: HighlightLifecycleOperation,
  subjectId: string,
  outcomes: readonly DestinationOutcome[],
): RevocationReport {
  const applicable = outcomes.filter((o) => o.status !== "not_applicable");
  return {
    operation,
    subjectId,
    outcomes,
    complete: applicable.length > 0 && applicable.every((o) => o.status === "revoked"),
    retryable: outcomes.filter((o) => o.status === "failed").map((o) => o.destination),
  };
}

/**
 * Run the revocation for one Highlight.
 *
 * `invalidateCache` is injected rather than imported so this module has no
 * dependency on the Compass subsystem and so a test can drive both the success
 * and the failure branch without a network.
 *
 * §21 "observable, retryable, and dead-lettered": the report IS the
 * observability, `retryable` names what to retry, and a caller that sees the
 * same destination fail repeatedly has the destination name to dead-letter on.
 * There is no retry loop here on purpose — a route handler is the wrong place
 * for one, and a silent in-request retry would hide exactly the repeated failure
 * the spec wants escalated.
 */
export async function executeRevocation(
  operation: HighlightLifecycleOperation,
  subjectId: string,
  deps: {
    readonly invalidateCache?: () => Promise<void>;
  } = {},
): Promise<RevocationReport> {
  const outcomes: DestinationOutcome[] = planRevocation(operation, {
    cacheInvalidatorAvailable: typeof deps.invalidateCache === "function",
  });

  if (typeof deps.invalidateCache === "function") {
    const idx = outcomes.findIndex((o) => o.destination === "cached_narrative");
    try {
      await deps.invalidateCache();
      outcomes[idx] = {
        destination: "cached_narrative",
        status: "revoked",
        detail:
          "Compass cache invalidation invoked and returned. NOTE, and this is a real limit on how much this outcome is worth: CompassCacheEngine.invalidate evicts its in-process L1 synchronously and unconditionally, but wraps the persisted compass_feed_cache delete and the audit insert in `try { … } catch { /* non-fatal */ }` and returns void either way. So `revoked` here is guaranteed for L1 and BEST-EFFORT for the persisted rows, and this outcome cannot tell a complete purge from an L1-only one. Making it distinguishable means changing CompassCacheEngine to report, which is another surface's file.",
      };
    } catch (err) {
      outcomes[idx] = {
        destination: "cached_narrative",
        status: "failed",
        detail: `Compass cache invalidation failed: ${String((err as any)?.message ?? err)}`,
      };
    }
  }

  return summariseRevocation(operation, subjectId, outcomes);
}

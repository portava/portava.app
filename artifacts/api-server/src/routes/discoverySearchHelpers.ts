/**
 * routes/discoverySearchHelpers.ts — a re-export, and nothing else.
 *
 * census-discovery §80 (lane W10-S1, row A08): the pure search helpers (the
 * alias table, match tiers, the combined rank, nearby and time intent, and the
 * `SearchQueryContext` type) are the shared input platform's, so they live in
 * `lib/inputAssistance/searchQueryHelpers.ts` with the candidate generator §70
 * moved there. This path is kept so no Discovery caller has to change an import.
 * searchPlatformBoundary.test.ts B6 fails if code is written here again.
 */
export * from "../lib/inputAssistance/searchQueryHelpers.js";

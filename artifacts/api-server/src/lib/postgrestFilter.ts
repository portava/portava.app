/**
 * postgrestFilter — making user input safe to put inside a PostgREST filter.
 *
 * TWO DIFFERENT HAZARDS, TWO DIFFERENT FUNCTIONS. They are not interchangeable
 * and using the wrong one leaves the original bug in place.
 *
 * 1. STRUCTURE — `.or()` takes a filter EXPRESSION, comma-separated. Any comma
 *    in an interpolated value ends the current predicate and starts a new one,
 *    so `q` becomes a query the caller wrote rather than a value the query
 *    matched. `escapeOrValue` neutralises the characters that carry structural
 *    meaning there.
 *
 * 2. PATTERN — `%` and `_` are LIKE wildcards. They do not escape a query, but
 *    a single `%` turns a bounded prefix search into a full table scan, so they
 *    must be escaped wherever a value is spliced into an ilike pattern —
 *    including in `.ilike()` calls, which are structurally safe and still
 *    accept wildcards from the caller. `escapeLikePattern` handles that.
 *
 * A value going into an ilike pattern inside `.or()` needs BOTH, pattern first.
 */

/**
 * Escape LIKE/ILIKE wildcards so the value matches literally.
 *
 * Backslash first — escaping it after the others would double-escape the
 * backslashes this function just introduced. PostgREST passes the pattern to
 * SQL LIKE, whose default escape character is the backslash.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Characters with structural meaning inside a PostgREST filter expression:
 * `,` separates predicates, `.` separates column/operator/value, `()` delimits
 * value lists and and()/or() groups, `"` quotes a value, `\` escapes.
 *
 * Dropped rather than quoted. Quoting would preserve them as searchable text,
 * but the only caller is a name/handle prefix search — none of these characters
 * appear in a handle (`[A-Za-z0-9_]`), and a search that silently matches
 * nothing is a better failure than one that runs an injected predicate.
 */
const OR_STRUCTURAL_CHARS = /[,.()"\\]/g;

/** Strip the characters that would let a value break out of an `.or()` expression. */
export function escapeOrValue(value: string): string {
  return value.replace(OR_STRUCTURAL_CHARS, '');
}

/**
 * The combination for a value spliced into an ilike pattern inside `.or()`:
 * wildcards escaped, then structural characters removed.
 *
 * Order matters. escapeLikePattern introduces backslashes, and those are
 * themselves structural inside an .or() expression, so the structural pass has
 * to run second or it would leave them behind.
 */
export function safeOrIlikeValue(value: string): string {
  return escapeOrValue(escapeLikePattern(value));
}

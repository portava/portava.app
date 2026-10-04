/**
 * isAbsentTableError — the ONE question a fail-OPEN branch may ask of a read
 * error: does the TABLE ITSELF not exist?
 *
 * ── WHY THIS IS ITS OWN, NARROW FUNCTION ─────────────────────────────────────
 * Several safety reads keep a deliberate fail-open for a table that may not be
 * migrated yet ("Phase 2" tables, `trust_restrictions`): if the table is
 * absent, no row in it can exist, so "no restriction" is a TRUE statement and
 * not a guess. That reasoning holds for an absent TABLE and for nothing else.
 *
 * The classifiers those reads used answered a much wider question. Measured on
 * 2026-10-03 (census-trust §31):
 *
 *   services/trust/TrustRestrictionService.ts   42P01 · PGRST204 · any message
 *                                               containing "does not exist"
 *   services/interactionPermissions.ts          42P01 · any "does not exist"
 *   routes/interactionContext.ts                42P01 · PGRST204 · any "does not exist"
 *
 * PGRST204 is PostgREST's COLUMN-not-found code. Postgres reports a dropped or
 * renamed column as `column trust_restrictions.lifted_at does not exist`
 * (42703), a type drift in a filter as `operator does not exist: …` (42883),
 * and a missing function as `function … does not exist` (42883). Every one of
 * those is a table that EXISTS and could not be read — an unread restriction,
 * ban, age or opt-out state — and every one was answered as "never migrated":
 * fail-OPEN, logged at warn, for as long as the drift lasted.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *   code 42P01 (undefined_table)            → absent
 *   code PGRST205 (table not in the cache)  → absent
 *   any OTHER code, including 42703,
 *     PGRST204, 42883, 42501, 57014 …       → NOT absent (the caller fails closed)
 *   no code at all                          → absent only for the exact wording
 *     `relation "<name>" does not exist` or
 *     `Could not find the table '<name>' in the schema cache`
 *
 * A code-less error is what supabase-js produces for a transport failure
 * (`TypeError: fetch failed`, status 0), so the message rule is anchored at
 * both ends: a wording that merely CONTAINS "does not exist" is not enough.
 *
 * PURE. Never throws, whatever it is handed.
 */
export function isAbsentTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as { code?: unknown }).code ?? "").trim();
  if (code === "42P01" || code === "PGRST205") return true;
  if (code !== "") return false;
  const message = String((error as { message?: unknown }).message ?? "").trim();
  return (
    /^relation "[^"]+" does not exist$/i.test(message) ||
    /^could not find the table '[^']+' in the schema cache$/i.test(message)
  );
}

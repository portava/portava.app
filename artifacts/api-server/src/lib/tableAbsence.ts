/**
 * isTableAbsentError — does the TABLE ITSELF not exist? Nothing wider.
 *
 * A read may keep a deliberate fail-open for a table that is not migrated yet:
 * if the table is absent, no row in it can exist, so "no mute", "nothing to
 * purge", "no recurrence" is a TRUE statement. That holds for an absent TABLE
 * and for nothing else. A missing column (42703 / PGRST204), a missing
 * function or operator (42883 `… does not exist`), a missing relationship
 * (PGRST200), a permission denial (42501) or a transport fault is a table
 * that EXISTS and could not be read, and must never be answered as "never
 * migrated".
 *
 * THE RULE
 *   code 42P01 (undefined_table)            → absent
 *   code PGRST205 (table not in the cache)  → absent
 *   any OTHER code                          → NOT absent
 *   no code at all                          → absent only for the exact wording
 *     `relation "<name>" does not exist` or
 *     `Could not find the table '<name>' in the schema cache`
 * A code, when present, decides: Postgres words a DML column error
 * `column "c" of relation "t" does not exist` (42703), which a substring test
 * for "relation" + "does not exist" reads as a missing table.
 *
 * ── RELATION TO PR #574 ─────────────────────────────────────────────────────
 * This is the rule `lib/absentTableError.ts` (`isAbsentTableError`, PR #574,
 * census-trust §31) states, written independently because #574 is not merged
 * and may not be imported from here. The two should be unified when both land:
 * keep one file and re-export the other name. Their behaviour is identical;
 * `tableAbsenceClassifiers.test.ts` pins this one.
 *
 * PURE. Never throws, whatever it is handed.
 */
export function isTableAbsentError(error: unknown): boolean {
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

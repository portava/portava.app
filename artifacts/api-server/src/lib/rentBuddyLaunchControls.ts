/**
 * rent_buddy_launch_controls — the NULL-safe read and write primitives.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The table's identity is `UNIQUE (country_code, city, category)`
 * (baseline/20260819_baseline_structure.sql:14336, from
 * migrations/0050_rent_a_buddy.sql). All three columns are NULLABLE, and every
 * row that matters carries at least one NULL: the GLOBAL control — the one the
 * kill switch writes and the one `enforceBookingCreationGates` falls back to —
 * is `(NULL, NULL, NULL)`, and every category-level control is
 * `(NULL, NULL, '<category>')`.
 *
 * A plain PostgreSQL UNIQUE constraint is NULLS DISTINCT. Two rows of
 * `(NULL, NULL, NULL)` do not conflict with each other, so:
 *
 *   * `ON CONFLICT (country_code, city, category) DO UPDATE` — what
 *     `.upsert(..., { onConflict: "country_code,city,category" })` compiles to —
 *     NEVER fires for any of these rows. Each admin press INSERTs a duplicate
 *     instead of updating. The kill switch was therefore one-way: pressing it
 *     added a second global row, and "lifting" it added a third rather than
 *     flipping anything.
 *
 *   * A `.maybeSingle()` read of that key then fails with PGRST116 ("multiple
 *     rows returned"), the caller sees `data === null`, and the global control
 *     becomes unreadable — which routes every booking that falls through to it
 *     into `enforceBookingCreationGates`' deny-by-default branch.
 *
 * Four admin endpoints in rentABuddySpec.ts carried that upsert (kill-switch,
 * and three category-status writers). The admin launch-control creator in
 * rentABuddy.ts had already been fixed by hand with a select-then-write; this
 * module is that fix, extracted so the five sites cannot drift again and so the
 * read side is duplicate-tolerant rather than duplicate-poisoned.
 *
 * Migration 2304 additionally converts the constraint to
 * `UNIQUE NULLS NOT DISTINCT` (precedent: 2064_shared_moments_foundation.sql:47)
 * after de-duplicating, so the database itself refuses a second global row. The
 * code here stays correct with or without that migration applied.
 */

export interface LaunchControlKey {
  country_code: string | null;
  city: string | null;
  category: string | null;
}

/** The three columns that make up a launch control's identity. */
export const LAUNCH_CONTROL_KEY_COLUMNS = ["country_code", "city", "category"] as const;

/**
 * Normalise a key: `undefined`, `null` and the empty/whitespace string all mean
 * "this axis is unconstrained" and must be stored and matched as SQL NULL.
 * Anything else is trimmed and kept verbatim (the lane matches country/city by
 * exact string equality throughout — see deriveServiceCountry).
 */
export function normalizeLaunchControlKey(
  key: { countryCode?: string | null; city?: string | null; category?: string | null },
): LaunchControlKey {
  const norm = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t.length > 0 ? t : null;
  };
  return {
    country_code: norm(key.countryCode),
    city: norm(key.city),
    category: norm(key.category),
  };
}

/**
 * Apply the three key predicates to a PostgREST query builder NULL-safely:
 * `.is(col, null)` for a NULL axis, `.eq(col, value)` otherwise. `.eq(col, null)`
 * would emit `col = NULL`, which is never true.
 */
export function applyLaunchControlKey<T extends { eq: (c: string, v: any) => T; is: (c: string, v: any) => T }>(
  query: T,
  key: LaunchControlKey,
): T {
  let q = query;
  for (const col of LAUNCH_CONTROL_KEY_COLUMNS) {
    const val = key[col];
    q = val === null ? q.is(col, null) : q.eq(col, val);
  }
  return q;
}

/**
 * Read the launch control for an EXACT key.
 *
 * Deliberately NOT `.maybeSingle()`: duplicates already exist in any database
 * where an admin pressed one of the four upsert endpoints before this fix, and
 * a `.maybeSingle()` there returns an error plus `data: null` — i.e. it turns a
 * duplicated row into a MISSING row, which is the worst possible reading of it.
 * A list read takes the first match, matching `resolveLaunchControlFromRows`'s
 * `.find()` semantics exactly, so the DB-backed and in-memory resolvers agree
 * under duplicates instead of diverging.
 */
export async function findLaunchControlRow(
  client: any,
  key: LaunchControlKey,
): Promise<{ row: any | null; error: unknown }> {
  let query = client.from("rent_buddy_launch_controls").select("*");
  query = applyLaunchControlKey(query, key);
  const res: any = await query.limit(2);
  if (res?.error) return { row: null, error: res.error };
  const rows: any[] = Array.isArray(res?.data) ? res.data : res?.data ? [res.data] : [];
  return { row: rows[0] ?? null, error: null };
}

/**
 * NULL-safe "upsert" of a launch control: find the row for this key, UPDATE it
 * by primary key when it exists, INSERT it otherwise.
 *
 * Returns the same `{ data, error }` shape the callers already branch on, so a
 * call site swaps in without changing its error handling.
 */
export async function upsertLaunchControlRow(
  client: any,
  key: LaunchControlKey,
  payload: Record<string, unknown>,
  createdBy?: string | null,
): Promise<{ data: any | null; error: unknown }> {
  const found = await findLaunchControlRow(client, key);
  if (found.error) return { data: null, error: found.error };

  if (found.row) {
    const res: any = await client
      .from("rent_buddy_launch_controls")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", (found.row as any).id)
      .select()
      .maybeSingle();
    return { data: res?.data ?? null, error: res?.error ?? null };
  }

  const insertRow: Record<string, unknown> = { ...payload, ...key };
  if (createdBy !== undefined) insertRow.created_by = createdBy;
  const res: any = await client
    .from("rent_buddy_launch_controls")
    .insert(insertRow)
    .select()
    .maybeSingle();
  return { data: res?.data ?? null, error: res?.error ?? null };
}

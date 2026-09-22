/**
 * Telegraph §7.5 / §12 — version history for text edits (census T80, T142).
 *
 *   §7.5 "Text edits retain an Edited marker and version history."
 *
 * The Edited marker has always been real: `PATCH /api/threads/:t/messages/:m`
 * writes `edited_at` and every reader surfaces it. What was missing was the
 * second noun. The edit overwrote `messages.body` in place, so the text a
 * recipient had already read was gone with no record that it had ever been
 * different.
 *
 * `public.message_edits` (migration 2811) is the place for that record:
 *
 *     message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE
 *     editor_id  uuid NOT NULL
 *     version    integer NOT NULL CHECK (version >= 1)
 *     previous_body text                       -- NULLABLE, see below
 *     edited_at  timestamptz NOT NULL DEFAULT now()
 *     UNIQUE (message_id, version)
 *
 * VERSION 1 IS THE FIRST EDIT, NOT THE ORIGINAL — the migration says so in a
 * comment and the numbering here obeys it. The original text is not a row; it
 * is `previous_body` on version 1.
 *
 * ── THE DEPLOYMENT FACT ─────────────────────────────────────────────────────
 * Migration 2811 IS NOT APPLIED TO PRODUCTION. The manual runbook's D2
 * rehearsal executed it on portava-ci inside `BEGIN; … ROLLBACK;` — it passed
 * and deliberately left nothing behind — and the runbook's absent-object tables
 * still list `message_edits` among the objects that are "all absent".
 *
 * So every caller of this module has to cope with its table not being there,
 * and the shape of that coping is the whole design:
 *
 *   - The edit STILL SUCCEEDS. Refusing every edit on production because a side
 *     table is unapplied would take away a capability travellers have today, to
 *     buy a record nobody can read yet. That is a worse trade than the gap.
 *   - The edit DOES NOT CLAIM a version was kept. The response carries
 *     `recorded: false` and `EDIT_HISTORY_UNAVAILABLE`, so a client cannot show
 *     a "view edit history" affordance that leads nowhere.
 *   - The READ refuses. `GET …/edits` answers 503 with a reason and NEVER
 *     `{ versions: [] }`. supabase-js RESOLVES a PostgREST refusal as
 *     `{data: null, error}`, so `?? []` would quietly convert "I cannot see the
 *     history" into the much stronger, unearned claim "this message has never
 *     been edited". That is the silent-zero pattern, and this is the one place
 *     in the edit path where it could bite.
 *
 * ── WHY `isEditHistorySchemaAbsent` IS NARROW ───────────────────────────────
 * Only a genuinely absent relation or column earns the degraded path. A
 * deadlock (40P01), a permission denial (42501), a unique violation (23505) or
 * an unclassified server error (XX000) are NOT "2811 is unapplied": they are
 * failures that a retry might survive, and treating them as the schema gap
 * would let `messages.body` be overwritten with the previous text unrecorded
 * and unrecoverable. Widening this set is how the guarantee gets lost, so it is
 * an explicit allowlist rather than a substring match on a message.
 */

/** PostgREST / Postgres codes that mean "this relation or column is not here". */
export const EDIT_HISTORY_SCHEMA_CODES: ReadonlySet<string> = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "PGRST204", // column not found in schema cache
  "PGRST205", // relation not found in schema cache
]);

export const EDIT_HISTORY_UNAVAILABLE =
  "Version history is not available on this deployment: public.message_edits " +
  "is absent because migration 2811 has not been applied, so no earlier " +
  "version of this message was recorded.";

/** One stored version, as the table holds it. */
export interface StoredEdit {
  version: number;
  previous_body?: string | null;
  editor_id?: string | null;
  edited_at?: string | null;
}

/** One stored version, as the API returns it. */
export interface EditVersion {
  version: number;
  previousBody: string | null;
  editorId: string | null;
  editedAt: string | null;
}

/**
 * Is this error the absent table, rather than a failure worth refusing over?
 *
 * Deliberately code-only. An error whose code is missing is NOT treated as the
 * schema gap: an unrecognised failure must take the safe branch (refuse), never
 * the lenient one.
 */
export function isEditHistorySchemaAbsent(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && EDIT_HISTORY_SCHEMA_CODES.has(code);
}

/**
 * The version number the next edit takes.
 *
 * MAX + 1, not `rows.length + 1`. They differ the moment a version is missing —
 * a compensated insert, a manual deletion — and the count would hand back a
 * number already present, which `UNIQUE (message_id, version)` rejects with
 * 23505. The edit would then fail for a reason that has nothing to do with the
 * edit, on a message that had been edited before.
 */
export function nextEditVersion(existing: ReadonlyArray<{ version: number }>): number {
  let max = 0;
  for (const row of existing) {
    const v = Number(row?.version);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max + 1;
}

/** The row an edit writes. */
export function editHistoryRow(input: {
  messageId: string;
  editorId: string;
  version: number;
  previousBody: string | null;
  editedAt: string;
}): Record<string, unknown> {
  return {
    message_id: input.messageId,
    editor_id: input.editorId,
    version: input.version,
    previous_body: input.previousBody,
    edited_at: input.editedAt,
  };
}

/** Newest version first — the order a history sheet reads in. */
export function orderEditsNewestFirst(rows: ReadonlyArray<StoredEdit>): EditVersion[] {
  return rows
    .map((r) => ({
      version: Number(r.version),
      previousBody: (r.previous_body ?? null) as string | null,
      editorId: (r.editor_id ?? null) as string | null,
      editedAt: (r.edited_at ?? null) as string | null,
    }))
    .sort((a, b) => b.version - a.version);
}

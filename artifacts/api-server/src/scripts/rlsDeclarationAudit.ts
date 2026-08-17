/**
 * rlsDeclarationAudit — a public table with NO RLS declaration is an error,
 * not a silence.
 *
 * ## The hole this closes
 *
 * auditMigrationsVsLive.ts verifies CLAIMS: it parses each migration for the
 * objects that file says it creates, then checks the live schema contains them.
 * `alter table X enable row level security` produces an `rls:X` claim, and the
 * auditor confirms X really has relrowsecurity set live. That is a good check
 * and it catches an ENABLE that silently did not take effect.
 *
 * What it structurally cannot catch is a table that never declares RLS at all.
 * No declaration means no claim, no claim means nothing to verify, and the
 * auditor reports success. The absence is invisible by construction — the
 * check is driven by what the migration says, so a migration that says nothing
 * is unfalsifiable.
 *
 * public.compass_memories (20260724_compass_memories.sql) is exactly that: no
 * ENABLE ROW LEVEL SECURITY, no policy, no REVOKE anywhere in the repository.
 * Every sibling Compass table enables RLS in its own creating migration, so it
 * reads as an omission rather than a decision — and the audit passed anyway.
 *
 * ## What this check is, precisely
 *
 * STATIC. It reads the canonical migration tree and asks "does the SQL declare
 * RLS for every table it creates". It is not a live check and does not prove
 * anything about the database — a declaration can still fail to apply, which
 * is what the existing `rls:` claim verification is for. The two are
 * complementary: this one makes the claim exist, that one proves it landed.
 * Reported live state, where the auditor has it, is an ANNOTATION on the
 * finding, never the thing being asserted.
 *
 * ## The allowlist
 *
 * Some tables legitimately have no RLS — a table only ever reached by the
 * service role, or one that is genuinely public. Those go in
 * RLS_DECLARATION_ALLOWLIST, and an entry is a table name AND a written reason.
 * A bare name would let the list grow by reflex; a sentence forces someone to
 * state why, and leaves the next reader something to disagree with.
 *
 * Stale entries are errors too: if a table later declares RLS, its allowlist
 * entry must go, or the list slowly becomes a record of what used to be true.
 */

export interface TableCreation {
  /** Unqualified, lower-cased table name. */
  table: string;
  /** Migration file that creates it. */
  file: string;
}

export interface RlsScan {
  /** table → the file that created it (first creator wins). */
  created: Map<string, string>;
  /** Tables with at least one ENABLE ROW LEVEL SECURITY anywhere in the tree. */
  rlsDeclared: Set<string>;
}

export interface UndeclaredTable extends TableCreation {
  /** Live state when the auditor has it: true/false, or null when unknown. */
  liveRlsEnabled?: boolean | null;
  /** Whether the table exists on the live schema at all, when known. */
  existsLive?: boolean | null;
}

/**
 * Tables that may exist without RLS. Key: table name. Value: WHY — a sentence,
 * not a label.
 *
 * The bar, set by the owner and applied table by table: a table is listed here
 * only if NO ROW IN IT IS ABOUT A PERSON. Operational thresholds and work
 * queues qualify. Anything carrying a user id, a post or media id, location,
 * contact details, content, moderation state or booking data does not — and
 * neither does an aggregate that leaks a fact about a person indirectly.
 *
 * Ten tables in the canonical tree currently fail this check and are
 * deliberately NOT listed, including public.compass_memories. Adding a table
 * here to turn the check green would be worse than having no check, because it
 * looks like a decision was made.
 *
 * public.place_coverage_buckets was CONSIDERED AND REFUSED. It holds only
 * aggregates — canonical_place_id, bucket, post_count — but also last_post_at,
 * and a timestamp of the most recent post at one specific place is an
 * observation about a person as soon as the contributor set is small, which is
 * the normal case rather than the edge case: most places are not busy. This
 * codebase already treats location as sensitive (a dedicated map-privacy
 * migration, trip_only and private post visibility), so recency at place
 * granularity does not clear the bar. If enabling RLS there is trivially safe
 * because only the service role reads it, that is an argument for fixing it,
 * not for exempting it.
 */
export const RLS_DECLARATION_ALLOWLIST: Record<string, string> = {
  geofence_admin_settings:
    'Single-row geofence configuration (CHECK id = 1): default_radius, min_radius and ' +
    'max_radius in metres, plus updated_at. It holds operational thresholds for the ' +
    'geofencing feature and nothing else — no user, post, media, place or booking ' +
    'identifier appears in the table, and the single row describes the system, not a person.',
  place_cache_invalidation_queue:
    'Work queue of canonical place ids whose living-page cache is stale: place_id and ' +
    'queued_at only. A row says "this place needs regenerating", so it is about a place ' +
    'and a background job, not a person — no user id, post id, media id or contact detail ' +
    'is stored, and a place id identifies a venue that exists independently of any user.',
};

/** Minimum length for an allowlist reason to count as written rather than token. */
export const MIN_REASON_LENGTH = 25;

/** Strip SQL comments so a commented-out statement never counts as a declaration. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

const CREATE_TABLE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;

const ENABLE_RLS =
  /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:"?public"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi;

/**
 * Accumulate creations and RLS declarations across the whole tree.
 *
 * Cross-file on purpose: a table created in one migration is often given RLS by
 * a later one, and treating that as a violation would report churn rather than
 * risk.
 */
export function scanMigrations(
  files: Array<{ file: string; sql: string }>,
): RlsScan {
  const created = new Map<string, string>();
  const rlsDeclared = new Set<string>();

  for (const { file, sql } of files) {
    const src = stripSqlComments(sql);
    for (const m of src.matchAll(CREATE_TABLE)) {
      const table = m[1]!.toLowerCase();
      if (!created.has(table)) created.set(table, file);
    }
    for (const m of src.matchAll(ENABLE_RLS)) {
      rlsDeclared.add(m[1]!.toLowerCase());
    }
  }

  return { created, rlsDeclared };
}

/** Tables created by the tree that never declare RLS and are not allowlisted. */
export function findUndeclaredRlsTables(
  scan: RlsScan,
  allowlist: Record<string, string> = RLS_DECLARATION_ALLOWLIST,
): UndeclaredTable[] {
  const out: UndeclaredTable[] = [];
  for (const [table, file] of scan.created) {
    if (scan.rlsDeclared.has(table)) continue;
    if (Object.prototype.hasOwnProperty.call(allowlist, table)) continue;
    out.push({ table, file });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

/**
 * Allowlist entries whose table now declares RLS. Kept as an error so the list
 * cannot drift into a record of what used to be true.
 */
export function findStaleAllowlistEntries(
  scan: RlsScan,
  allowlist: Record<string, string> = RLS_DECLARATION_ALLOWLIST,
): string[] {
  return Object.keys(allowlist)
    .filter((table) => scan.rlsDeclared.has(table.toLowerCase()))
    .sort();
}

/** Allowlist entries whose reason is missing, blank, or too short to be a reason. */
export function findUnreasonedAllowlistEntries(
  allowlist: Record<string, string> = RLS_DECLARATION_ALLOWLIST,
): string[] {
  return Object.entries(allowlist)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH)
    .map(([table]) => table)
    .sort();
}

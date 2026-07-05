/**
 * verify-db-engagement-indexes.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the ENGAGEMENT_INDEX_RESPONSE environment variable and verifies
 * that all ten engagement indexes are present in pg_indexes:
 *
 *   • Five post-perspective indexes from migration 0106 — support cursor-based
 *     pagination in GET /api/engagement/likes (ordered by post/comment/etc. ID).
 *   • Five user-perspective indexes from migration 0123 — support the reverse
 *     lookup "which posts/comments/highlights/memories has a given user liked?"
 *     used by profile pages and the 'liked by me' feed indicator.
 *
 * Called by scripts/check-engagement-indexes.sh.
 *
 * Exit codes:
 *   0  all ten indexes confirmed present
 *   1  one or more indexes missing or response is malformed
 */

const MIGRATION_0106 =
  "artifacts/api-server/src/migrations/0106_engagement_indexes.sql";
const MIGRATION_0123 =
  "artifacts/api-server/migrations/0123_engagement_user_indexes.sql";

const REQUIRED = [
  // ── migration 0106: post-perspective (cursor-based pagination) ───────────
  { name: "idx_posts_likes_post_created",           table: "posts_likes",     migration: MIGRATION_0106 },
  { name: "idx_post_reactions_post_emoji_created",  table: "post_reactions",  migration: MIGRATION_0106 },
  { name: "idx_comment_likes_comment_created",      table: "comment_likes",   migration: MIGRATION_0106 },
  { name: "idx_highlight_likes_highlight_created",  table: "highlight_likes", migration: MIGRATION_0106 },
  { name: "idx_memory_likes_memory_created",        table: "memory_likes",    migration: MIGRATION_0106 },
  // ── migration 0123: user-perspective (profile pages + liked-by-me feed) ──
  { name: "idx_posts_likes_user_created",           table: "posts_likes",     migration: MIGRATION_0123 },
  { name: "idx_post_reactions_user_created",        table: "post_reactions",  migration: MIGRATION_0123 },
  { name: "idx_comment_likes_user_created",         table: "comment_likes",   migration: MIGRATION_0123 },
  { name: "idx_highlight_likes_user_created",       table: "highlight_likes", migration: MIGRATION_0123 },
  { name: "idx_memory_likes_user_created",          table: "memory_likes",    migration: MIGRATION_0123 },
];

const raw = process.env.ENGAGEMENT_INDEX_RESPONSE ?? "";

let rows;
try {
  rows = JSON.parse(raw);
} catch {
  console.error("  \u2718  Could not parse engagement index check response as JSON:");
  console.error("     " + raw.slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error("  \u2718  Unexpected response shape from engagement index check:");
  console.error("     " + JSON.stringify(rows).slice(0, 200));
  process.exit(1);
}

const found = new Set(rows.map((r) => r.indexname ?? r.index_name ?? r.name));

let allPresent = true;
const missingByMigration = new Map();

for (const { name, table, migration } of REQUIRED) {
  if (found.has(name)) {
    console.log("  \u2714  index " + name + " on " + table);
  } else {
    console.error("  \u2718  MISSING index: " + name + " (expected on " + table + ")");
    allPresent = false;
    if (!missingByMigration.has(migration)) missingByMigration.set(migration, []);
    missingByMigration.get(migration).push(name);
  }
}

if (!allPresent) {
  console.error("");
  console.error(
    "     One or more engagement indexes are absent from production."
  );
  console.error(
    "     Without post-perspective indexes (0106) GET /api/engagement/likes"
  );
  console.error(
    "     degrades to sequential scans under cursor-based pagination."
  );
  console.error(
    "     Without user-perspective indexes (0123) profile-page and 'liked by me'"
  );
  console.error(
    "     feed queries degrade to sequential scans as like tables grow."
  );
  console.error(
    "     Apply the missing migration(s) via the Supabase SQL editor or psql:"
  );
  for (const [migration] of missingByMigration) {
    console.error("       " + migration);
  }
  process.exit(1);
}

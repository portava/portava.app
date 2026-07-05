/**
 * verify-db-engagement-indexes.mjs
 *
 * Reads the JSON response from the Supabase Management API database/query
 * endpoint via the ENGAGEMENT_INDEX_RESPONSE environment variable and verifies
 * that all five engagement indexes introduced in migration 0106 are present
 * in pg_indexes.
 *
 * Called by scripts/check-engagement-indexes.sh.
 *
 * Exit codes:
 *   0  all five indexes confirmed present
 *   1  one or more indexes missing or response is malformed
 */

const MIGRATION =
  "artifacts/api-server/src/migrations/0106_engagement_indexes.sql";

const REQUIRED = [
  { name: "idx_posts_likes_post_created",           table: "posts_likes" },
  { name: "idx_post_reactions_post_emoji_created",  table: "post_reactions" },
  { name: "idx_comment_likes_comment_created",      table: "comment_likes" },
  { name: "idx_highlight_likes_highlight_created",  table: "highlight_likes" },
  { name: "idx_memory_likes_memory_created",        table: "memory_likes" },
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
for (const { name, table } of REQUIRED) {
  if (found.has(name)) {
    console.log("  \u2714  index " + name + " on " + table);
  } else {
    console.error("  \u2718  MISSING index: " + name + " (expected on " + table + ")");
    allPresent = false;
  }
}

if (!allPresent) {
  console.error("");
  console.error(
    "     One or more engagement indexes are absent from production."
  );
  console.error(
    "     Without them the GET /api/engagement/likes endpoint degrades to"
  );
  console.error(
    "     sequential scans on large like tables under cursor-based pagination."
  );
  console.error(
    "     Apply the missing migration via the Supabase SQL editor or psql:"
  );
  console.error("       " + MIGRATION);
  process.exit(1);
}

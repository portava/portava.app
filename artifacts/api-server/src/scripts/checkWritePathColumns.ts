/**
 * Write-path + read-path column drift check
 *
 * Extracts every column written by `.insert()` / `.upsert()` / `.update()`
 * calls AND every column read by string-literal `.select("col_a, col_b")`
 * lists in src/routes and src/services (via the TypeScript AST — not regex,
 * so chained calls and multi-line payloads are handled correctly) and diffs
 * the referenced columns against the LIVE Supabase schema through the
 * Supabase Management API.
 *
 * The read side matters just as much as the write side: a missing column in
 * a select list fails the WHOLE query (PGRST100) and breaks reads silently.
 *
 * This is the maintained version of the ad-hoc task-1925 wizard-write-path
 * audit (2026-07-20), which found three live drifts (posts filter columns,
 * rent_buddy_bookings.country_code, rent_buddy_policy_flags.updated_at)
 * using a greedy perl extraction that bled across chained calls.  Running
 * this script catches the whole failure class: any route that starts
 * writing a column before its migration is applied live.
 *
 * What counts as a write site:
 *   - a call chain that contains `.from("<string literal>")` followed
 *     (anywhere later in the chain) by `.insert(...)`, `.upsert(...)` or
 *     `.update(...)`
 *   - payload columns are collected from object-literal arguments, arrays
 *     of object literals, and (one level deep) same-file `const x = {...}`
 *     variables passed by identifier
 *
 * What counts as a read site:
 *   - a call chain that contains `.from("<string literal>")` followed by
 *     `.select("<string literal>")`
 *   - the select list is parsed PostgREST-style: aliases (`alias:col`),
 *     casts (`col::text`), JSON paths (`col->x`, `col->>x`) all resolve to
 *     the base column; `*`, `count`, and embedded resources
 *     (`rel(...)`, including `rel!hint(...)`) are skipped — embedded
 *     resources reference OTHER tables and are out of scope here
 *
 * Skipped-but-TRACKED (the blind spot must not grow silently):
 *   - dynamic table names (`.from(tableVar)`)
 *   - payloads that cannot be statically resolved (function results,
 *     imported values, spreads — spread keys that ARE statically visible
 *     are still collected)
 *   - non-literal select lists (template strings with substitutions,
 *     variables)
 *   Every such site is counted against UNRESOLVED_ALLOWLIST below, keyed by
 *   `file|method|reason` (line numbers churn, so counts per key are used).
 *   A NEW unresolvable site — a new key, or more sites under an existing
 *   key — turns the check red: either rewrite the site so it is statically
 *   resolvable, or consciously bump the allowlist entry.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:write-path-columns          # diff against live schema
 *   pnpm run check:write-path-columns -- --verbose
 *   pnpm run check:write-path-columns -- --print-unresolved-allowlist
 *       # emit the UNRESOLVED_ALLOWLIST block matching the current tree
 *
 * Exit code 0 → every extracted column exists live (or is allowlisted)
 * Exit code 1 → at least one written column is missing from the live schema
 * Exit code 2 → environment / API error
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const SCAN_DIRS = [resolve(__dir, "../routes"), resolve(__dir, "../services")];
const VERBOSE = process.argv.includes("--verbose");
const PRINT_UNRESOLVED_ALLOWLIST = process.argv.includes(
  "--print-unresolved-allowlist",
);

// ── Allowlist ─────────────────────────────────────────────────────────────────
//
// "table.column" pairs that are known-good despite not existing in the live
// public schema (or that are intentionally written pre-migration).  Keep this
// list SHORT and annotated — every entry is a hole in the check.
const ALLOWLIST = new Set<string>([
  // E2EE columns on existing tables — migration pending live apply.
  // Remove once the columns are present in the live DB schema.
  "message_threads.is_e2ee",
  "messages.ciphertext",
  // Header-image privacy columns — migration 20260806_header_image_privacy.sql
  // pending live apply. Remove once the columns are present in the live DB schema.
  "events.show_header_publicly",
  "trips.show_header_publicly",
  "profiles.show_profile_picture_publicly", // column pending live DB migration — allowlisted until applied
  // Featured by Portava — migration 0106_portava_featured.sql
  // pending live apply. Remove once the column exists in the live DB schema.
  "profiles.featured_count",
  // Place-image accuracy/provenance columns — Task 1 migration (20260809_place_image_accuracy.sql)
  // pending live apply. Remove once the columns are present in the live DB schema.
  "generated_visuals.accuracy_status",
  "generated_visuals.canonical_place_id",
  "generated_visuals.disclaimer_required",
  "generated_visuals.disclaimer_text",
  "generated_visuals.generated_with_ai",
  "generated_visuals.image_source_type",
  "generated_visuals.last_accuracy_reviewed_at",
  "generated_visuals.provider_place_id",
  "generated_visuals.source_url",
  "generated_visuals.verification_status",
  "generated_visuals.verified_at",
  "generated_visuals.verified_by",
  "places.header_image_generated_id",
  // viewer_creator_fatigue.expires_at — added by migration
  // 20260804_creator_fatigue_expires.sql, pending live apply.
  // Remove once the column is present in the live DB schema.
  "viewer_creator_fatigue.expires_at",
  // Add-a-Gem creation flow columns — migration pending live apply.
  // Remove once the columns exist in the live hidden_gems table.
  "hidden_gems.accessibility",
  "hidden_gems.crowd_level",
  "hidden_gems.source_confirmation",
  "hidden_gems.visibility",
  "hidden_gems.trip_id",
]);

// Tables that are not real live relations and should be skipped entirely
// (e.g. test doubles or tables owned by another system).
const SKIP_TABLES = new Set<string>([
  // E2EE device management tables — migration pending live apply.
  // Remove these entries once the migration is applied to the live DB.
  "devices",
  "key_packages",
  // Admin access audit log — migration 2035 pending live apply.
  // Remove once migration 2035_admin_access_log.sql is applied to the live DB.
  "admin_access_log",
  // DiscoveryRankingService tables — migrations pending live apply (Task 2653).
  // Remove once the tables exist in the live DB schema.
  "content_distribution_stats",
  "ranking_debug_samples",
  // Place image reports table — Task 1 migration (20260809_place_image_accuracy.sql)
  // pending live apply. Remove once the table exists in the live DB schema.
  "place_image_reports",
  // Ranking config audit log — migration pending live apply (Task 2735).
  // Remove once the table exists in the live DB schema.
  "ranking_config_audit_log",
  // Stamp-it reactions on media posts — migration 20260814_media_stamp_reactions.sql
  // pending live apply. Remove once the table exists in the live DB schema.
  "media_stamp_reactions",
  // Event agenda items (places attached to an event) — migration 2043_event_agenda_items.sql
  // pending live apply. Remove once the table exists in the live DB schema.
  "event_agenda_items",
  // Worth-It / Skip-It votes for places and gems — migration 20260808_place_votes.sql
  // pending live apply. Remove once the table exists in the live DB schema.
  "place_votes",
  // Featured by Portava — migration 0106_portava_featured.sql
  // pending live apply. Remove once the table exists in the live DB schema.
  "portava_featured",
]);

// ── Unresolvable-site allowlist ───────────────────────────────────────────────
//
// Every write/read site the AST extraction CANNOT statically resolve is a
// blind spot where a phantom column can still sneak through.  Each is
// tracked here as `file|method|reason` → expected count (line numbers churn
// too much to key on).  If a NEW unresolvable site appears — a new key, or
// more sites under an existing key — the check FAILS: rewrite the site so
// the payload/select list is statically resolvable, or consciously bump the
// entry here.  If a count DROPS, the check also fails so the entry gets
// trimmed (keeping the ledger honest).
//
// Regenerate the whole block with:
//   pnpm run check:write-path-columns -- --print-unresolved-allowlist
//
// Burn this list down — every entry is a hole in the check.
const UNRESOLVED_ALLOWLIST = new Map<string, number>([
  ["src/routes/admin.ts|select|select list not statically resolvable", 2],
  ["src/routes/adminGeocode.ts|select|dynamic table name", 2],
  ["src/routes/adminGeocode.ts|update|dynamic table name", 2],
  ["src/routes/adminGeocode.ts|upsert|dynamic table name", 2],
  ["src/routes/airport.ts|select|select list not statically resolvable", 2],
  ["src/routes/circle.ts|upsert|payload not statically resolvable", 1],
  ["src/routes/compass.ts|select|select list not statically resolvable", 4],
  // 3 sites: feed-section registration + the two /compass/ask uiBlock
  // registration upserts (chat recommendation tokens) — row arrays are built
  // dynamically from RecommendationRow, columns verified by the feed paths.
  ["src/routes/compass.ts|upsert|payload not statically resolvable", 3],
  ["src/routes/compass.ts|upsert|payload partially resolvable", 2],
  ["src/routes/events.ts|select|select list not statically resolvable", 2],
  ["src/routes/follows.ts|select|select list not statically resolvable", 4],
  ["src/routes/friends.ts|select|select list not statically resolvable", 4],
  ["src/routes/geofence.ts|select|select list not statically resolvable", 1],
  ["src/routes/groupChat.ts|select|select list not statically resolvable", 1],
  ["src/routes/meetups.ts|insert|payload not statically resolvable", 2],
  ["src/routes/memories.ts|insert|payload not statically resolvable", 2],
  ["src/routes/memories.ts|select|select list not statically resolvable", 5],
  ["src/routes/messaging.ts|select|dynamic table name", 1],
  ["src/routes/messaging.ts|select|select list not statically resolvable", 2],
  ["src/routes/messaging.ts|update|payload partially resolvable", 1],
  ["src/routes/messaging.ts|upsert|payload partially resolvable", 1],
  ["src/routes/passport.ts|select|select list not statically resolvable", 10],
  // post_event_links is a new join table (migration 20260731_post_event_links.sql);
  // the insert uses `as any` cast to avoid database.types.ts drift until types are regenerated.
  ["src/routes/postcards.ts|insert|dynamic table name", 2],
  ["src/routes/postcards.ts|select|select list not statically resolvable", 3],
  ["src/routes/posts.ts|select|select list not statically resolvable", 14],
  ["src/routes/profile.ts|select|select list not statically resolvable", 4],
  ["src/routes/profile.ts|upsert|payload partially resolvable", 1],
  ["src/routes/pulse.ts|select|select list not statically resolvable", 1],
  // Dynamic array built from AI extraction output — columns verified by the surrounding route logic.
  ["src/routes/tripReservations.ts|insert|payload not statically resolvable", 1],
  ["src/routes/rentABuddy.ts|insert|payload not statically resolvable", 1],
  ["src/routes/rentABuddy.ts|select|select list not statically resolvable", 4],
  ["src/routes/rentABuddy.ts|update|payload partially resolvable", 1],
  ["src/routes/rentABuddyMarketplace.ts|insert|payload not statically resolvable", 1],
  ["src/routes/rentABuddyMarketplace.ts|upsert|payload not statically resolvable", 1],
  ["src/routes/rentABuddySpec.ts|select|select list not statically resolvable", 2],
  ["src/routes/rentABuddySpec.ts|upsert|payload not statically resolvable", 2],
  ["src/routes/requests.ts|select|select list not statically resolvable", 1],
  ["src/routes/routePlan.ts|insert|payload not statically resolvable", 2],
  // PENDING_SELECT and HISTORY_SELECT are const string variables — the script cannot
  // follow variable references. All columns are verified against the generated_visuals
  // migration (0194_generated_visuals.sql).
  // adminFeatured: two multi-line string-concatenation selects (posts shortlist
  // query + portava_featured join). Columns verified against live schema / migration.
  ["src/routes/adminFeatured.ts|select|select list not statically resolvable", 2],
  ["src/routes/adminVisuals.ts|select|select list not statically resolvable", 2],
  ["src/routes/stampCatalog.ts|select|select list not statically resolvable", 4],
  ["src/routes/stampShowcase.ts|insert|payload not statically resolvable", 1],
  ["src/routes/stampShowcase.ts|select|select list not statically resolvable", 1],
  ["src/routes/stamps.ts|select|select list not statically resolvable", 11],
  ["src/services/passport/UnifiedStampService.ts|select|select list not statically resolvable", 1],
  ["src/routes/stories.ts|select|select list not statically resolvable", 3],
  ["src/routes/telegraphChat.ts|insert|payload not statically resolvable", 1],
  ["src/routes/telegraphChat.ts|update|payload not statically resolvable", 1],
  ["src/routes/trips-expansion.ts|insert|payload not statically resolvable", 1],
  ["src/routes/trips.ts|insert|payload not statically resolvable", 1],
  ["src/routes/trips.ts|select|select list not statically resolvable", 3],
  ["src/routes/trust-admin.ts|update|payload partially resolvable", 1],
  ["src/services/groupChatSync.ts|upsert|payload not statically resolvable", 2],
  ["src/services/hiddenGems/HiddenGemService.ts|select|select list not statically resolvable", 6],
  ["src/services/hiddenGems/HiddenGemService.ts|update|payload not statically resolvable", 2],
  ["src/services/notifications/NotificationPreferenceService.ts|upsert|payload partially resolvable", 1],
  ["src/services/rentBuddy/ReliabilityCounters.ts|select|select list not statically resolvable", 1],
  ["src/services/rentBuddy/ReliabilityCounters.ts|update|payload partially resolvable", 1],
  ["src/services/safeReturn/SafeReturnService.ts|insert|payload not statically resolvable", 1],
  ["src/services/trust/TrustAdminService.ts|upsert|payload partially resolvable", 1],
  ["src/services/trust/TrustEventService.ts|select|select list not statically resolvable", 1],
  // E2EE key-package upload — payload built from a dynamic array of base64 strings.
  ["src/routes/keyPackages.ts|insert|payload not statically resolvable", 1],
  // mediaFeed: three select sites compose column-constant strings (FEED_POST_COLUMNS /
  // POST_MEDIA_COLUMNS / PROFILE_COLUMNS for Watch, GRID_POST_COLUMNS / GRID_MEDIA_COLUMNS
  // for Grid); insert payload in impression logging is an array built at runtime.
  // All columns verified against live schema.
  ["src/routes/mediaFeed.ts|insert|payload not statically resolvable", 1],
  ["src/routes/mediaFeed.ts|select|select list not statically resolvable", 7],
  // MediaFeedRankingService: storeRankingSnapshots builds the upsert row array dynamically
  // (rows array built at call time with a variable-length ranked list).
  // Columns: viewer_id, item_id, surface, session_id, position, final_score, reason_codes, served_at.
  ["src/services/ranking/MediaFeedRankingService.ts|upsert|payload not statically resolvable", 1],
]);

// ── Read-path baseline ────────────────────────────────────────────────────────
//
// Pre-existing read-side drift found when select-list checking was added
// (2026-07-21).  These "table.column" pairs are selected by routes but absent
// live — each is a latent PGRST100 failure on that query.  They are
// BASELINED (not allowlisted-as-good) so the checker stays green while
// guarding against NEW read drift.  Burn this list down: either apply the
// missing migration or fix the select list, then delete the entry.
// Applies to `select` sites only — never to writes.
const READ_BASELINE = new Set<string>([
  // (none currently — the 2026-07-21 baseline was fully burned down)
]);

// Tables read via `.select()` that do not exist live at all (same baseline
// semantics as READ_BASELINE).
const READ_BASELINE_TABLES = new Set<string>([
  // (none currently)
]);

// ── Environment ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer SUPABASE_PROJECT_TOKEN (project-scoped, safe for CI) over the
// personal SUPABASE_ACCESS_TOKEN — mirrors auditMigrationsVsLive.ts.
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(
  query: string,
): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

// ── AST extraction ────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(["insert", "upsert", "update"]);

interface WriteSite {
  file: string; // relative to artifacts/api-server
  line: number; // 1-based
  table: string;
  method: string;
  columns: string[]; // statically resolved payload keys
  unresolved: boolean; // payload (or part of it) could not be resolved
}

interface SkippedSite {
  file: string;
  line: number;
  method: string;
  reason: string;
}

const sites: WriteSite[] = [];
const skipped: SkippedSite[] = [];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walk DOWN a call chain expression (`a.from("t").eq(...).update({...})`
 * seen from the `.update` call) looking for a `.from("<literal>")` call.
 * Returns the table name, "<dynamic>" if `.from()` was called with a
 * non-literal, or null if no `.from()` appears in the chain.
 */
function findTableInChain(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  while (true) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "from") {
          const arg = cur.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) return arg.text;
          return "<dynamic>";
        }
        cur = callee.expression; // step past this chained call
        continue;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    return null;
  }
}

/** Collect statically visible keys from an object literal. Returns whether
 * anything non-static (spread of unresolvable value, computed key) was hit. */
function keysFromObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  usePos: number,
  depth: number,
): { keys: string[]; unresolved: boolean } {
  const keys: string[] = [];
  let unresolved = false;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name;
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
        keys.push(name.text);
      } else {
        unresolved = true; // computed key
      }
    } else if (ts.isSpreadAssignment(prop)) {
      const inner = resolvePayload(prop.expression, sf, usePos, depth + 1);
      if (inner) {
        keys.push(...inner.keys);
        unresolved = unresolved || inner.unresolved;
      } else {
        unresolved = true;
      }
    } else {
      unresolved = true; // method/accessor — not a column write anyway
    }
  }
  return { keys, unresolved };
}

/**
 * Resolve a payload expression to its column keys.
 * Handles object literals, arrays of object literals, conditional
 * expressions (union of both branches), and — one level deep — identifiers
 * whose same-file `const` initializer is an object literal.
 */
function resolvePayload(
  expr: ts.Expression,
  sf: ts.SourceFile,
  usePos: number,
  depth = 0,
): { keys: string[]; unresolved: boolean } | null {
  if (depth > 3) return null;
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    (ts.isSatisfiesExpression?.(expr) ?? false)
  ) {
    return resolvePayload(
      (expr as ts.ParenthesizedExpression).expression,
      sf,
      usePos,
      depth,
    );
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return keysFromObjectLiteral(expr, sf, usePos, depth);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const keys: string[] = [];
    let unresolved = false;
    for (const el of expr.elements) {
      const inner = resolvePayload(el, sf, usePos, depth + 1);
      if (inner) {
        keys.push(...inner.keys);
        unresolved = unresolved || inner.unresolved;
      } else {
        unresolved = true;
      }
    }
    return { keys, unresolved };
  }
  if (ts.isConditionalExpression(expr)) {
    const a = resolvePayload(expr.whenTrue, sf, usePos, depth + 1);
    const b = resolvePayload(expr.whenFalse, sf, usePos, depth + 1);
    if (!a && !b) return null;
    return {
      keys: [...(a?.keys ?? []), ...(b?.keys ?? [])],
      unresolved: !a || !b || a.unresolved || b.unresolved,
    };
  }
  if (ts.isIdentifier(expr)) {
    // Same-file const/let with a statically resolvable initializer.
    const init = findInitializer(expr.text, sf, usePos);
    if (init) return resolvePayload(init, sf, usePos, depth + 1);
    return null;
  }
  return null;
}

// Per-file map of variable name → declarations (position + initializer),
// so identifier payloads resolve against the NEAREST declaration BEFORE the
// call site (files legally reuse names like `payload` in separate handlers).
const initializerCache = new Map<
  ts.SourceFile,
  Map<string, { pos: number; init: ts.Expression }[]>
>();

function findInitializer(
  name: string,
  sf: ts.SourceFile,
  usePos: number,
): ts.Expression | undefined {
  let map = initializerCache.get(sf);
  if (!map) {
    map = new Map();
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const list = map!.get(node.name.text) ?? [];
        list.push({ pos: node.getStart(sf), init: node.initializer });
        map!.set(node.name.text, list);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    initializerCache.set(sf, map);
  }
  const decls = map.get(name);
  if (!decls) return undefined;
  let best: { pos: number; init: ts.Expression } | undefined;
  for (const d of decls) {
    if (d.pos < usePos && (!best || d.pos > best.pos)) best = d;
  }
  // Fall back to the sole declaration when the variable is declared after
  // the call site textually (e.g. hoisted helpers) — only safe when unique.
  if (!best && decls.length === 1) best = decls[0];
  return best?.init;
}

/**
 * Parse a PostgREST select list into base column names.
 *
 * Splits on TOP-LEVEL commas (respecting parentheses so embedded resources
 * stay intact), then per item:
 *   - items containing `(` are embedded resources (`rel(...)`, `rel!hint(...)`)
 *     → skipped (their columns belong to another table)
 *   - `*` and bare `count` → skipped
 *   - `alias:col` → col;  `col::cast` → col;  `col->x` / `col->>x` → col
 *   - quoted identifiers keep their inner text
 */
function parseSelectList(list: string): { columns: string[]; skippedEmbedded: number } {
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur);

  const columns: string[] = [];
  let skippedEmbedded = 0;
  for (const raw of items) {
    const item = raw.replace(/\s+/g, "");
    if (item === "") continue;
    if (item.includes("(")) {
      skippedEmbedded++;
      continue; // embedded resource — another table's columns
    }
    // alias:column — keep the part AFTER the colon (but not `::` casts)
    let col = item;
    const aliasIdx = col.indexOf(":");
    if (aliasIdx !== -1 && col[aliasIdx + 1] !== ":") {
      col = col.slice(aliasIdx + 1);
    }
    // strip cast and JSON path operators
    col = col.split("::")[0].split("->")[0];
    // strip surrounding quotes on quoted identifiers
    col = col.replace(/^"(.*)"$/, "$1");
    if (col === "" || col === "*" || col === "count") continue;
    columns.push(col);
  }
  return { columns, skippedEmbedded };
}

function scanFile(path: string): void {
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const rel = relative(API_ROOT, path);

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text;
      const table = findTableInChain(node.expression.expression);
      const line =
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (table === null) {
        // Not a supabase chain (e.g. Map#insert) — ignore silently.
      } else if (table === "<dynamic>") {
        skipped.push({ file: rel, line, method, reason: "dynamic table name" });
      } else {
        const arg = node.arguments[0];
        const payload = arg ? resolvePayload(arg, sf, node.getStart(sf)) : null;
        if (!payload) {
          skipped.push({
            file: rel,
            line,
            method,
            reason: "payload not statically resolvable",
          });
        } else {
          sites.push({
            file: rel,
            line,
            table,
            method,
            columns: [...new Set(payload.keys)],
            unresolved: payload.unresolved,
          });
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "select"
    ) {
      const table = findTableInChain(node.expression.expression);
      const line =
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (table === null) {
        // Not a supabase chain — ignore silently.
      } else if (table === "<dynamic>") {
        skipped.push({ file: rel, line, method: "select", reason: "dynamic table name" });
      } else {
        const arg = node.arguments[0];
        if (arg === undefined) {
          // `.select()` → `*` — nothing to check.
        } else if (
          ts.isStringLiteralLike(arg) ||
          ts.isNoSubstitutionTemplateLiteral(arg)
        ) {
          const { columns } = parseSelectList(arg.text);
          if (columns.length > 0) {
            sites.push({
              file: rel,
              line,
              table,
              method: "select",
              columns: [...new Set(columns)],
              unresolved: false,
            });
          }
        } else {
          skipped.push({
            file: rel,
            line,
            method: "select",
            reason: "select list not statically resolvable",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ── Main ──────────────────────────────────────────────────────────────────────

for (const dir of SCAN_DIRS) {
  for (const file of listTsFiles(dir)) scanFile(file);
}

const referencedTables = [
  ...new Set(sites.map((s) => s.table).filter((t) => !SKIP_TABLES.has(t))),
].sort();

console.log(
  `Extracted ${sites.length} statically-resolvable write/read sites across ` +
    `${referencedTables.length} tables (${skipped.length} sites skipped as unresolvable).`,
);

interface LiveCol {
  t: string;
  c: string;
}

console.log(`Fetching live schema (project ${projectRef}) …`);
let liveCols: LiveCol[];
let liveRels: { name: string }[];
try {
  [liveCols, liveRels] = await Promise.all([
    liveQuery<LiveCol>(
      `select table_name as t, column_name as c
       from information_schema.columns where table_schema = 'public'`,
    ),
    liveQuery<{ name: string }>(
      `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m')`,
    ),
  ]);
} catch (err) {
  console.error("ERROR: failed to fetch live schema:", err);
  process.exit(2);
}

const liveColumnSet = new Set(liveCols.map((r) => `${r.t}.${r.c}`));
const liveRelationSet = new Set(liveRels.map((r) => r.name));

// ── Diff ──────────────────────────────────────────────────────────────────────

interface Finding {
  table: string;
  column: string;
  where: string[]; // "file:line (method)"
}

const missingByKey = new Map<string, Finding>();
const missingTables = new Map<string, string[]>();

let baselined = 0;

for (const site of sites) {
  if (SKIP_TABLES.has(site.table)) continue;
  const isRead = site.method === "select";
  const where = `${site.file}:${site.line} (${site.method})`;
  if (!liveRelationSet.has(site.table)) {
    if (isRead && READ_BASELINE_TABLES.has(site.table)) {
      baselined++;
      if (VERBOSE) console.log(`  baselined (read): table ${site.table} — ${where}`);
      continue;
    }
    const list = missingTables.get(site.table) ?? [];
    list.push(where);
    missingTables.set(site.table, list);
    continue;
  }
  for (const col of site.columns) {
    const key = `${site.table}.${col}`;
    if (liveColumnSet.has(key) || ALLOWLIST.has(key)) continue;
    if (isRead && READ_BASELINE.has(key)) {
      baselined++;
      if (VERBOSE) console.log(`  baselined (read): ${key} — ${where}`);
      continue;
    }
    const f = missingByKey.get(key) ?? {
      table: site.table,
      column: col,
      where: [],
    };
    f.where.push(where);
    missingByKey.set(key, f);
  }
}

if (VERBOSE && skipped.length > 0) {
  console.log("\nSkipped (unresolvable) write sites:");
  for (const s of skipped) {
    console.log(`  ${s.file}:${s.line} (${s.method}) — ${s.reason}`);
  }
}

// ── Unresolvable-site ledger ──────────────────────────────────────────────────
//
// Fully-unresolvable sites (skipped) AND partially-unresolved payloads
// (statically visible keys plus a spread/computed part we can't see) are
// both blind spots.  Count them per `file|method|reason` key and diff
// against UNRESOLVED_ALLOWLIST.

const unresolvedCounts = new Map<string, number>();
const unresolvedWhere = new Map<string, string[]>();
function trackUnresolved(file: string, line: number, method: string, reason: string) {
  const key = `${file}|${method}|${reason}`;
  unresolvedCounts.set(key, (unresolvedCounts.get(key) ?? 0) + 1);
  const list = unresolvedWhere.get(key) ?? [];
  list.push(`${file}:${line}`);
  unresolvedWhere.set(key, list);
}
for (const s of skipped) trackUnresolved(s.file, s.line, s.method, s.reason);
for (const s of sites) {
  if (s.unresolved) {
    trackUnresolved(s.file, s.line, s.method, "payload partially resolvable");
  }
}

if (PRINT_UNRESOLVED_ALLOWLIST) {
  console.log("\nconst UNRESOLVED_ALLOWLIST = new Map<string, number>([");
  for (const [key, count] of [...unresolvedCounts].sort()) {
    console.log(`  ["${key}", ${count}],`);
  }
  console.log("]);");
  process.exit(0);
}

let failed = false;

const newUnresolved: string[] = [];
const staleUnresolved: string[] = [];
for (const [key, count] of [...unresolvedCounts].sort()) {
  const allowed = UNRESOLVED_ALLOWLIST.get(key) ?? 0;
  if (count > allowed) {
    newUnresolved.push(
      `  ${key} — ${count} site(s), allowlisted ${allowed}\n` +
        unresolvedWhere
          .get(key)!
          .map((w) => `      ${w}`)
          .join("\n"),
    );
  } else if (count < allowed) {
    staleUnresolved.push(`  ${key} — allowlisted ${allowed}, found ${count}`);
  }
}
for (const [key, allowed] of [...UNRESOLVED_ALLOWLIST].sort()) {
  if (!unresolvedCounts.has(key)) {
    staleUnresolved.push(`  ${key} — allowlisted ${allowed}, found 0`);
  }
}

if (newUnresolved.length > 0) {
  failed = true;
  console.error(
    "\n✗ NEW unresolvable write/read sites (not in UNRESOLVED_ALLOWLIST):",
  );
  for (const entry of newUnresolved) console.error(entry);
  console.error(
    "\nThese sites are blind spots — the column check cannot verify them " +
      "against the live schema. Prefer rewriting the site so the payload/" +
      "select list is statically resolvable. If that is genuinely not " +
      "possible, regenerate the ledger with\n" +
      "  pnpm run check:write-path-columns -- --print-unresolved-allowlist\n" +
      "and update UNRESOLVED_ALLOWLIST in this script.",
  );
}

if (newUnresolved.length === 0 && staleUnresolved.length === 0) {
  const total = [...unresolvedCounts.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\n⚠ ${total} unresolvable write/read sites tracked in UNRESOLVED_ALLOWLIST ` +
      "(blind spots — burn the list down; run with --verbose for locations).",
  );
}

if (staleUnresolved.length > 0) {
  failed = true;
  console.error(
    "\n✗ Stale UNRESOLVED_ALLOWLIST entries (fewer sites than allowlisted — trim the ledger):",
  );
  for (const entry of staleUnresolved) console.error(entry);
  console.error(
    "\nRegenerate with: pnpm run check:write-path-columns -- --print-unresolved-allowlist",
  );
}

if (baselined > 0) {
  console.log(
    `\n⚠ ${baselined} read-site references matched the READ_BASELINE ` +
      "(pre-existing read drift — see the annotated list in this script; " +
      "burn it down, don't grow it).",
  );
}

if (missingTables.size > 0) {
  failed = true;
  console.error("\n✗ Referenced TABLES missing from the live schema:");
  for (const [table, where] of [...missingTables].sort()) {
    console.error(`  ${table}`);
    for (const w of [...new Set(where)]) console.error(`      ${w}`);
  }
}

if (missingByKey.size > 0) {
  failed = true;
  console.error("\n✗ Referenced COLUMNS missing from the live schema:");
  for (const [key, f] of [...missingByKey].sort()) {
    console.error(`  ${key}`);
    for (const w of [...new Set(f.where)]) console.error(`      ${w}`);
  }
  console.error(
    "\nEach of these fails the WHOLE query: writes are rejected even when " +
      "the value is null, and a missing select-list column fails the read " +
      "with PGRST100. Apply the migration that adds the column via the " +
      "Management API and record it in docs/migrations.md, or add a " +
      "justified ALLOWLIST entry in this script.",
  );
}

if (!failed) {
  console.log(
    `✓ All ${referencedTables.length} referenced tables and every extracted ` +
      "written/selected column exist in the live schema (or are baselined).",
  );
  process.exit(0);
}
process.exit(1);

/**
 * creatorActivityEnumLiterals.test.ts
 *
 * Guards CreatorActivityScoreService against the "plausible-but-nonexistent
 * enum label" defect class.
 *
 * Background — the defect this file was written for:
 *   `posts` carries TWO similarly-named status columns typed by TWO different
 *   enums:
 *     posts.status       public.post_status
 *                        ('active','hidden','reported','deleted')
 *     posts.post_status  public.delayed_post_status
 *                        ('draft','private','pending_location_exit',
 *                         'pending_delay','pending_safety_review','published',
 *                         'canceled','expired')
 *   The contributions lane sent `.eq("status", "published")`. 'published' is a
 *   `delayed_post_status` label, not a `post_status` one, so PostgREST rejected
 *   the request with 22P02 (invalid input value for enum). The surrounding
 *   Promise.all / try-catch swallowed the rejection and every creator's post
 *   contribution count (24h / 7d / 30d / 90d) was silently zero.
 *
 * Two independent proofs live here:
 *   A. BEHAVIOURAL — drive CreatorSignalAggregator through a fake Supabase
 *      client holding realistically-shaped `posts` rows and assert the lane
 *      actually counts them. Goes RED if the predicate is wrong.
 *   B. MECHANICAL — parse the committed baseline schema for every enum type and
 *      every enum-typed column, then statically scan the service source for
 *      `.eq(col, "literal")` / `.in(col, [...])` filters and assert each literal
 *      is a real label of that column's enum. Catches the NEXT instance of this
 *      class without anyone having to notice it by inspection.
 *
 * Pattern: node:test + tsx/esm, no vitest. DB-free.
 * Run: node --import tsx/esm --test src/test/creatorActivityEnumLiterals.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CreatorSignalAggregator } from "../services/ranking/CreatorActivityScoreService.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const BASELINE = resolve(API_ROOT, "baseline/20260819_baseline_structure.sql");
const SERVICE = resolve(
  API_ROOT,
  "src/services/ranking/CreatorActivityScoreService.ts",
);

// ─── Baseline schema parsing ──────────────────────────────────────────────────

/**
 * Parse every `CREATE TYPE public.<name> AS ENUM ( 'a', 'b', ... );` block.
 * Returns enum type name -> set of labels.
 */
function parseEnums(sql: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /CREATE TYPE public\.([A-Za-z0-9_]+) AS ENUM \(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const labels = new Set<string>();
    for (const lm of m[2].matchAll(/'((?:[^']|'')*)'/g)) {
      labels.add(lm[1].replace(/''/g, "'"));
    }
    out.set(m[1], labels);
  }
  return out;
}

/**
 * Parse every `CREATE TABLE public.<name> ( ... );` block for columns whose
 * declared type is a `public.<enum>`. Returns "table.column" -> enum type name.
 */
function parseEnumColumns(
  sql: string,
  enums: Map<string, Set<string>>,
): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE TABLE public\.([A-Za-z0-9_]+) \(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1];
    for (const rawLine of m[2].split("\n")) {
      const line = rawLine.trim();
      const col = /^([A-Za-z0-9_]+) public\.([A-Za-z0-9_]+)\b/.exec(line);
      if (!col) continue;
      if (!enums.has(col[2])) continue; // public.<domain/composite>, not an enum
      out.set(`${table}.${col[1]}`, col[2]);
    }
  }
  return out;
}

const BASELINE_SQL = readFileSync(BASELINE, "utf8");
const ENUMS = parseEnums(BASELINE_SQL);
const ENUM_COLUMNS = parseEnumColumns(BASELINE_SQL, ENUMS);

// ─── The facts this whole file rests on ───────────────────────────────────────
//
// If the schema ever changes these, the assertions below fail loudly rather
// than letting the rest of the file silently assert nothing.

describe("baseline enum facts (posts.status vs posts.post_status)", () => {
  it("parses a plausible number of enums and enum columns", () => {
    assert.ok(ENUMS.size > 20, `expected many enums, parsed ${ENUMS.size}`);
    assert.ok(
      ENUM_COLUMNS.size > 20,
      `expected many enum columns, parsed ${ENUM_COLUMNS.size}`,
    );
  });

  it("post_status is ('active','hidden','reported','deleted')", () => {
    assert.deepStrictEqual(
      [...(ENUMS.get("post_status") ?? [])].sort(),
      ["active", "deleted", "hidden", "reported"],
    );
  });

  it("'published' is NOT a post_status label", () => {
    assert.ok(
      !ENUMS.get("post_status")?.has("published"),
      "post_status must not contain 'published' — the whole defect turns on this",
    );
  });

  it("'published' IS a delayed_post_status label", () => {
    assert.ok(
      ENUMS.get("delayed_post_status")?.has("published"),
      "delayed_post_status must contain 'published'",
    );
  });

  it("posts.status is post_status and posts.post_status is delayed_post_status", () => {
    assert.strictEqual(ENUM_COLUMNS.get("posts.status"), "post_status");
    assert.strictEqual(
      ENUM_COLUMNS.get("posts.post_status"),
      "delayed_post_status",
    );
  });

  it("reviews.state is review_state and 'published' is one of its labels", () => {
    assert.strictEqual(ENUM_COLUMNS.get("reviews.state"), "review_state");
    assert.ok(ENUMS.get("review_state")?.has("published"));
  });
});

// ─── B. MECHANICAL GUARD — every enum literal the service sends is real ───────

interface FilterSite {
  table: string;
  column: string;
  literal: string;
  line: number;
}

/**
 * Attribute each `.eq("col", "lit")` / `.in("col", ["lit", ...])` to the table
 * of the most recent preceding `.from("table")`. The service builds each query
 * as one uninterrupted chain starting at `.from(...)`, so nearest-preceding
 * attribution is exact here; the assertion below re-verifies that by requiring
 * the known posts/reviews sites to be found on the right tables.
 */
function extractFilterSites(source: string): FilterSite[] {
  const lines = source.split("\n");
  const sites: FilterSite[] = [];
  let table: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Ignore comment lines — the service documents enum labels in prose.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;

    const from = /\.from\(\s*"([A-Za-z0-9_]+)"\s*\)/.exec(line);
    if (from) {
      table = from[1];
      continue;
    }
    if (!table) continue;

    const eq = /\.eq\(\s*"([A-Za-z0-9_]+)"\s*,\s*"([^"]*)"\s*\)/.exec(line);
    if (eq) {
      sites.push({ table, column: eq[1], literal: eq[2], line: i + 1 });
      continue;
    }
    const inCall = /\.in\(\s*"([A-Za-z0-9_]+)"\s*,\s*\[([^\]]*)\]\s*\)/.exec(line);
    if (inCall) {
      for (const lm of inCall[2].matchAll(/"([^"]*)"/g)) {
        sites.push({ table, column: inCall[1], literal: lm[1], line: i + 1 });
      }
    }
  }
  return sites;
}

const SERVICE_SRC = readFileSync(SERVICE, "utf8");
const FILTER_SITES = extractFilterSites(SERVICE_SRC);

describe("CreatorActivityScoreService — enum literal guard", () => {
  it("the extractor actually found the posts contribution filters", () => {
    // A silently-empty extraction would make the guard below vacuous.
    // Deliberately independent of the fix: this stays green whatever literal
    // the posts lane sends, so it can only fail if the extractor itself broke
    // (which would make the guard below assert nothing at all).
    const postsSites = FILTER_SITES.filter((s) => s.table === "posts");
    assert.ok(
      postsSites.some((s) => s.column === "status"),
      "expected a posts.status filter to be extracted — extractor is broken/vacuous",
    );
    assert.ok(
      FILTER_SITES.some((s) => s.table === "reviews" && s.column === "state"),
      "expected the reviews.state filter to be extracted — extractor is broken/vacuous",
    );
  });

  it("every enum-column literal sent by this service is a real label", () => {
    const bad: string[] = [];
    for (const site of FILTER_SITES) {
      const enumType = ENUM_COLUMNS.get(`${site.table}.${site.column}`);
      if (!enumType) continue; // not an enum column — out of scope for this guard
      const labels = ENUMS.get(enumType)!;
      if (!labels.has(site.literal)) {
        bad.push(
          `line ${site.line}: .eq("${site.column}", "${site.literal}") on ` +
            `${site.table} — ${site.table}.${site.column} is public.${enumType} ` +
            `whose labels are {${[...labels].sort().join(", ")}}. ` +
            `PostgREST rejects this with 22P02 and the query returns nothing.`,
        );
      }
    }
    assert.deepStrictEqual(
      bad,
      [],
      `dead enum literal(s) in CreatorActivityScoreService:\n  ${bad.join("\n  ")}`,
    );
  });

  it("the posts contribution lane uses the canonical live-post predicate", () => {
    const posts = FILTER_SITES.filter((s) => s.table === "posts");
    assert.ok(
      posts.some((s) => s.column === "status" && s.literal === "active"),
      'posts lane must filter status="active" (post_status enum)',
    );
    assert.ok(
      posts.some((s) => s.column === "post_status" && s.literal === "published"),
      'posts lane must filter post_status="published" (delayed_post_status enum)',
    );
  });
});

// ─── A. BEHAVIOURAL PROOF — the lane actually counts published posts ─────────

const CREATOR_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function isoAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

/**
 * Minimal fake Supabase builder. Filters are applied in JS against the supplied
 * rows, exactly as the existing creatorActivityScore.test.ts harness does — so
 * a predicate naming a value no row carries yields zero rows, which is the same
 * observable outcome as PostgREST's 22P02 rejection.
 */
function makeFakeDb(tableData: Record<string, any[]>) {
  function buildChain(table: string) {
    let single = false;
    const filters: Array<(r: any) => boolean> = [];
    const chain: any = {
      select() { return chain; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return chain; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return chain; },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      maybeSingle() { single = true; return chain; },
      single() { single = true; return chain; },
      then(resolveFn: any, rejectFn: any) {
        return Promise.resolve().then(() => {
          const rows = (tableData[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return resolveFn({ data: single ? (rows[0] ?? null) : rows, error: null });
        }).catch(rejectFn);
      },
    };
    return chain;
  }
  return { from: (t: string) => buildChain(t) };
}

/** A post row shaped like the real table: both status columns present. */
function postRow(overrides: Record<string, any> = {}) {
  return {
    author_id: CREATOR_ID,
    status: "active",
    post_status: "published",
    created_at: isoAgo(0.5),
    ...overrides,
  };
}

const EMPTY_TABLES = {
  blocks: [], events: [], trips: [], reviews: [], discovery_places: [],
  activity_events: [], trust_profiles: [],
};

describe("CreatorSignalAggregator — posts contribution lane", () => {
  it("counts a live post (status=active, post_status=published) in every window", async () => {
    const db = makeFakeDb({ ...EMPTY_TABLES, posts: [postRow()] });
    const signals = await new CreatorSignalAggregator(db as any).aggregate(CREATOR_ID);

    // This is the assertion that goes RED when the predicate is
    // .eq("status","published"): no row carries status='published', so the lane
    // returns zero — exactly as the live 22P02 rejection did.
    assert.strictEqual(signals.contributions24h, 1, "24h window must count the post");
    assert.strictEqual(signals.contributions7d, 1, "7d window must count the post");
    assert.strictEqual(signals.contributions30d, 1, "30d window must count the post");
    assert.strictEqual(signals.contributions90d, 1, "90d window must count the post");
  });

  it("counts several live posts across the 90-day windows", async () => {
    const db = makeFakeDb({
      ...EMPTY_TABLES,
      posts: [
        postRow({ created_at: isoAgo(0.5) }),
        postRow({ created_at: isoAgo(3) }),
        postRow({ created_at: isoAgo(20) }),
        postRow({ created_at: isoAgo(60) }),
      ],
    });
    const signals = await new CreatorSignalAggregator(db as any).aggregate(CREATOR_ID);

    assert.strictEqual(signals.contributions24h, 1);
    assert.strictEqual(signals.contributions7d, 2);
    assert.strictEqual(signals.contributions30d, 3);
    assert.strictEqual(signals.contributions90d, 4);
  });

  it("excludes hidden, reported and deleted posts from the contribution count", async () => {
    const db = makeFakeDb({
      ...EMPTY_TABLES,
      posts: [
        postRow({ status: "hidden" }),
        postRow({ status: "reported" }),
        postRow({ status: "deleted" }),
      ],
    });
    const signals = await new CreatorSignalAggregator(db as any).aggregate(CREATOR_ID);
    assert.strictEqual(
      signals.contributions90d, 0,
      "content the community cannot see is not a contribution",
    );
  });

  it("excludes posts that have not actually published yet", async () => {
    const db = makeFakeDb({
      ...EMPTY_TABLES,
      posts: [
        postRow({ post_status: "draft" }),
        postRow({ post_status: "private" }),
        postRow({ post_status: "pending_delay" }),
        postRow({ post_status: "pending_safety_review" }),
        postRow({ post_status: "canceled" }),
        postRow({ post_status: "expired" }),
      ],
    });
    const signals = await new CreatorSignalAggregator(db as any).aggregate(CREATOR_ID);
    assert.strictEqual(signals.contributions90d, 0);
  });

  it("counts another author's posts against that author, not this creator", async () => {
    const db = makeFakeDb({
      ...EMPTY_TABLES,
      posts: [postRow({ author_id: "bbbbbbbb-0000-4000-8000-000000000002" })],
    });
    const signals = await new CreatorSignalAggregator(db as any).aggregate(CREATOR_ID);
    assert.strictEqual(signals.contributions90d, 0);
  });
});

describe("CreatorSignalAggregator — sibling contribution lanes", () => {
  it("reviews lane counts state='published' rows (review_state, a real label)", async () => {
    const db = makeFakeDb({
      ...EMPTY_TABLES,
      posts: [],
      reviews: [
        { reviewer_id: CREATOR_ID, state: "published", created_at: isoAgo(2) },
        { reviewer_id: CREATOR_ID, state: "hidden", created_at: isoAgo(2) },
        { reviewer_id: CREATOR_ID, state: "removed", created_at: isoAgo(2) },
      ],
    });
    const signals = await new CreatorSignalAggregator(db as any).aggregate(CREATOR_ID);
    assert.strictEqual(signals.contributions90d, 1);
  });

  it("events / trips / discovery_places lanes count with no status filter", async () => {
    const db = makeFakeDb({
      ...EMPTY_TABLES,
      posts: [],
      events: [{ host_id: CREATOR_ID, created_at: isoAgo(2) }],
      trips: [{ owner_id: CREATOR_ID, created_at: isoAgo(2) }],
      discovery_places: [{ submitted_by: CREATOR_ID, created_at: isoAgo(2) }],
    });
    const signals = await new CreatorSignalAggregator(db as any).aggregate(CREATOR_ID);
    assert.strictEqual(signals.contributions90d, 3);
  });
});

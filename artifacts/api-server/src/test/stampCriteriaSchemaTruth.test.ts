/**
 * Criteria metric registry vs. SCHEMA TRUTH — Stamps lane.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `stampCriteria.test.ts` drives the metric resolvers through a fake whose
 * head-count branch is `resolve({ count: counts[table] ?? 0 })` — it never looks
 * at which columns were selected or filtered on. Under that fake every metric
 * "works". In production PostgREST validates the select list AND the filter
 * columns against the real table, even for a `head: true` count, and answers a
 * reference to a column that does not exist with 42703 — failing the WHOLE
 * query. `countRows` then turns that into `return 0`.
 *
 * Three registry metrics were permanently zero for every user because of that:
 *
 *   following_count / followers_count  `select("id")` on `user_follows`
 *   events_joined                      `select("id")` on `event_rsvps`
 *   posts_count                        `.eq("user_id", …)` on `posts`
 *
 * `user_follows` (follower_id, following_id, created_at) and `event_rsvps`
 * (event_id, user_id, status, created_at) are composite-key tables with NO `id`
 * column; `posts` carries `author_id`, never `user_id`. `user_follows.id` is
 * independently recorded as verified-missing-in-production on the repo's own
 * dead-reference ratchet (`checkSchemaReferences.ts`).
 *
 * The consequence is not academic. Migration 0179 gives `community_connector`,
 * `popular_traveler` and `travel_influencer` follower criteria, and 0180
 * activates four event-category stamps whose criteria require
 * `events_joined >= 1`. `criteriaGate` is ADDITIVE inside `checkEligibility`, so
 * with `stamp_criteria_engine_enabled` ON those stamps were not merely
 * un-awardable by the data-driven path — their hard-coded triggers in
 * `follows.ts` / `events.ts` were BLOCKED too, on a criterion that could only
 * ever evaluate to 0.
 *
 * WHAT THIS FILE DOES DIFFERENTLY
 * -------------------------------
 * The fake here is built from the canonical schema (baseline dump + every
 * migration, via the same `buildCanonicalSchema` the repo's static
 * schema-reference check uses), and raises 42703 for any select-list or filter
 * column the real table does not declare. No column name is hard-coded in a
 * fixture: the truth comes from the SQL.
 *
 * Run: node --import tsx/esm --test src/test/stampCriteriaSchemaTruth.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCanonicalSchema,
  isModelled,
  type CanonicalSchema,
} from "../scripts/lib/canonicalSchema.js";
import { resolveMetric, knownMetricNames, CONTEXT_ONLY_METRICS } from "../lib/stamps/criteria/metrics.js";
import { evaluateCriteria } from "../lib/stamps/criteria/evaluator.js";
import { evaluateAndAwardCriteria } from "../lib/stamps/criteria/index.js";
import { eventCategoryContext, EVENT_CATEGORY_STAMP_SLUGS } from "../lib/stamps/criteria/eventContext.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const BASELINE = resolve(API_ROOT, "baseline/20260819_baseline_structure.sql");
const MIGRATIONS = [resolve(API_ROOT, "migrations"), resolve(API_ROOT, "src/migrations")];

let cached: CanonicalSchema | null = null;
const schema = () => (cached ??= buildCanonicalSchema(BASELINE, MIGRATIONS));

const USER = "aaaaaaaa-0000-0000-0000-0000000000aa";

// ── Schema-aware fake Supabase client ────────────────────────────────────────

interface Violation { table: string; column: string; where: "select" | "filter" }

/**
 * Split a PostgREST select list into the top-level column names it references,
 * dropping embedded-resource groups (`rel(a,b)`) — only the plain columns are
 * validated against the parent table.
 */
function topLevelSelectColumns(select: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let curIsEmbed = false;
  const flush = () => { if (!curIsEmbed) out.push(cur); cur = ""; curIsEmbed = false; };
  for (const ch of select) {
    // A token followed by "(" names an embedded RELATION, not a column of the
    // parent table — dropping it keeps the check from flagging the relation
    // name as a missing column.
    if (ch === "(") { depth++; if (depth === 1) curIsEmbed = true; continue; }
    if (ch === ")") { depth--; continue; }
    if (ch === "," && depth === 0) { flush(); continue; }
    if (depth === 0) cur += ch;
  }
  flush();
  return out
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c !== "*")
    // `alias:col` and `rel!hint` forms — take the bare column half.
    .map((c) => (c.includes(":") ? c.split(":").pop()!.trim() : c))
    .filter((c) => !c.includes("!"));
}

/**
 * Rows are plain objects; a query resolves them by applying the recorded
 * filters. Any select-list or filter column the canonical schema does not
 * declare for that table produces the PostgREST 42703 that production produces.
 */
function makeSchemaAwareSc(
  tables: Record<string, any[]>,
  opts: { flagOn?: boolean; defs?: any[] } = {},
) {
  const violations: Violation[] = [];
  const s = schema();

  const known = (table: string, column: string): boolean => {
    if (!isModelled(s, table)) return true; // decline to judge unmodelled tables
    return s.columns.get(table)!.has(column);
  };

  const client = {
    from(table: string) {
      const b: any = {
        _filters: [] as Array<[string, any]>,
        _head: false,
        _select: "*",
        select(f: string, o?: any) { b._select = f ?? "*"; b._head = o?.head === true; return b; },
        eq(k: string, v: any) { b._filters.push([k, v]); return b; },
        is(k: string, v: any) { b._filters.push([k, v]); return b; },
        in(k: string, v: any[]) { b._in = [k, v]; if (!known(table, k)) violations.push({ table, column: k, where: "filter" }); return b; },
        not(_k: string, _op: string, _v: any) { return b; },
        _resolve() {
          for (const c of topLevelSelectColumns(b._select)) {
            if (!known(table, c)) violations.push({ table, column: c, where: "select" });
          }
          for (const [k] of b._filters) {
            if (!known(table, k)) violations.push({ table, column: k, where: "filter" });
          }
          const bad = violations.find((v) => v.table === table);
          if (bad) {
            return {
              data: null,
              count: null,
              error: {
                code: "42703",
                message: `column ${bad.table}.${bad.column} does not exist`,
              },
            };
          }
          let rows = (tables[table] ?? []).slice();
          for (const [k, v] of b._filters) rows = rows.filter((r) => r[k] === v);
          if (b._in) {
            const [k, vals] = b._in as [string, any[]];
            rows = rows.filter((r) => vals.includes(r[k]));
          }
          return { data: rows, count: rows.length, error: null };
        },
        maybeSingle: async () => {
          if (table === "feature_flags") return { data: { enabled: opts.flagOn === true }, error: null };
          if (table === "stamp_definitions") {
            const slug = b._filters.find((f: any) => f[0] === "slug")?.[1];
            return { data: (opts.defs ?? []).find((d) => d.slug === slug) ?? null, error: null };
          }
          const r = b._resolve();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        then(res: any) {
          if (table === "feature_flags") { res({ data: [{ enabled: opts.flagOn === true }], error: null }); return; }
          if (table === "stamp_definitions") { res({ data: opts.defs ?? [], error: null }); return; }
          const r = b._resolve();
          if (b._head) { res({ count: r.error ? null : r.count, error: r.error }); return; }
          res({ data: r.data, error: r.error });
        },
      };
      return b;
    },
  } as any;

  return { client, violations };
}

// ── The registry contract ────────────────────────────────────────────────────

describe("criteria metric registry — every column it touches exists", () => {
  it("the canonical schema parsed (guard against a vacuous run)", () => {
    assert.ok(schema().columns.size > 300, `only ${schema().columns.size} tables modelled — the parse broke`);
    // The two composite-key tables this defect turned on: no `id` column.
    assert.equal(schema().columns.get("user_follows")!.has("id"), false);
    assert.equal(schema().columns.get("event_rsvps")!.has("id"), false);
    assert.equal(schema().columns.get("posts")!.has("user_id"), false);
    assert.equal(schema().columns.get("posts")!.has("author_id"), true);
  });

  it("no DB metric resolver references a column its table does not have", async () => {
    const dbMetrics = knownMetricNames().filter((m) => !CONTEXT_ONLY_METRICS.has(m));
    assert.ok(dbMetrics.length >= 10, `expected the full DB registry, got ${dbMetrics.length}`);

    const { client, violations } = makeSchemaAwareSc({});
    for (const name of dbMetrics) await resolveMetric(client, USER, name, {});

    assert.deepEqual(
      violations, [],
      "criteria metric resolvers reference columns that do not exist — each one " +
      "fails its whole PostgREST query (42703) and countRows returns a silent 0:\n" +
      violations.map((v) => `  ${v.table}.${v.column} (${v.where})`).join("\n"),
    );
  });
});

// ── Per-metric behaviour against real-shaped rows ────────────────────────────

describe("criteria metrics resolve real counts against real-shaped rows", () => {
  it("following_count / followers_count count user_follows rows", async () => {
    const { client } = makeSchemaAwareSc({
      user_follows: [
        { follower_id: USER, following_id: "u2", created_at: "t" },
        { follower_id: USER, following_id: "u3", created_at: "t" },
        { follower_id: "u4", following_id: USER, created_at: "t" },
      ],
    });
    assert.equal(await resolveMetric(client, USER, "following_count", {}), 2);
    assert.equal(await resolveMetric(client, USER, "followers_count", {}), 1);
  });

  it("events_joined counts event_rsvps rows with status 'going'", async () => {
    const { client } = makeSchemaAwareSc({
      event_rsvps: [
        { event_id: "e1", user_id: USER, status: "going",  created_at: "t" },
        { event_id: "e2", user_id: USER, status: "going",  created_at: "t" },
        { event_id: "e3", user_id: USER, status: "maybe",  created_at: "t" },
        { event_id: "e4", user_id: "other", status: "going", created_at: "t" },
      ],
    });
    assert.equal(await resolveMetric(client, USER, "events_joined", {}), 2);
  });

  it("posts_count counts the user's posts by author_id", async () => {
    const { client } = makeSchemaAwareSc({
      posts: [
        { id: "p1", author_id: USER, status: "active" },
        { id: "p2", author_id: USER, status: "active" },
        { id: "p3", author_id: "other", status: "active" },
      ],
    });
    assert.equal(await resolveMetric(client, USER, "posts_count", {}), 2);
  });

  it("the already-sound metrics stay sound (positive controls)", async () => {
    const { client } = makeSchemaAwareSc({
      trips: [
        { id: "t1", owner_id: USER, status: "completed" },
        { id: "t2", owner_id: USER, status: "planning" },
      ],
      events: [{ id: "e1", host_id: USER }],
      user_stamps: [
        { id: "s1", user_id: USER, is_revoked: false, city: "Da Nang", country: "Vietnam" },
        { id: "s2", user_id: USER, is_revoked: false, city: "Tokyo",   country: "Japan" },
        { id: "s3", user_id: USER, is_revoked: false, city: "tokyo",   country: "japan" },
      ],
    });
    assert.equal(await resolveMetric(client, USER, "trips_created", {}), 2);
    assert.equal(await resolveMetric(client, USER, "trips_completed", {}), 1);
    assert.equal(await resolveMetric(client, USER, "events_hosted", {}), 1);
    assert.equal(await resolveMetric(client, USER, "stamps_earned", {}), 3);
    assert.equal(await resolveMetric(client, USER, "cities_visited", {}), 2);
    assert.equal(await resolveMetric(client, USER, "countries_visited", {}), 2);
  });
});

// ── The stamps that were unawardable ─────────────────────────────────────────

/** The criteria exactly as migration 0179 writes them onto stamp_definitions. */
const CRITERIA_0179 = {
  community_connector: { version: 1, all: [{ metric: "following_count", gte: 10 }] },
  popular_traveler:    { version: 1, all: [{ metric: "followers_count", gte: 50 }] },
  travel_influencer:   { version: 1, all: [{ metric: "followers_count", gte: 500 }] },
} as const;

describe("the follower-milestone stamps of migration 0179 can be met", () => {
  it("community_connector is met at exactly its authored threshold", async () => {
    const threshold = CRITERIA_0179.community_connector.all[0].gte;
    const { client } = makeSchemaAwareSc({
      user_follows: Array.from({ length: threshold }, (_, i) => ({
        follower_id: USER, following_id: `u${i}`, created_at: "t",
      })),
    });
    const r = await evaluateCriteria(client, USER, CRITERIA_0179.community_connector);
    assert.equal(r.met, true, `criteria not met with exactly ${threshold} follows: ${r.reason}`);
  });

  it("popular_traveler is NOT met one below its threshold (negative control)", async () => {
    const threshold = CRITERIA_0179.popular_traveler.all[0].gte;
    const { client } = makeSchemaAwareSc({
      user_follows: Array.from({ length: threshold - 1 }, (_, i) => ({
        follower_id: `u${i}`, following_id: USER, created_at: "t",
      })),
    });
    assert.equal((await evaluateCriteria(client, USER, CRITERIA_0179.popular_traveler)).met, false);
  });

  it("popular_traveler is met at its threshold", async () => {
    const threshold = CRITERIA_0179.popular_traveler.all[0].gte;
    const { client } = makeSchemaAwareSc({
      user_follows: Array.from({ length: threshold }, (_, i) => ({
        follower_id: `u${i}`, following_id: USER, created_at: "t",
      })),
    });
    assert.equal((await evaluateCriteria(client, USER, CRITERIA_0179.popular_traveler)).met, true);
  });
});

describe("the event-category stamps of migration 0180 can be awarded", () => {
  /** Criteria exactly as 0179/0180 write them for the four RSVP-triggered slugs. */
  const DEFS = [
    { slug: "foodie_explorer",     is_active: true, criteria_type: "automatic",
      criteria: { version: 1, all: [{ metric: "event_category_food", is: true }, { metric: "events_joined", gte: 1 }] } },
    { slug: "music_lover",         is_active: true, criteria_type: "automatic",
      criteria: { version: 1, all: [{ metric: "event_category_music", is: true }, { metric: "events_joined", gte: 1 }] } },
    { slug: "outdoor_adventurer",  is_active: true, criteria_type: "automatic",
      criteria: { version: 1, all: [{ metric: "event_category_outdoor", is: true }, { metric: "events_joined", gte: 1 }] } },
    { slug: "event_regular",       is_active: true, criteria_type: "automatic",
      criteria: { version: 1, all: [{ metric: "events_joined", gte: 5 }] } },
  ];

  it("the fixture slugs are exactly the trigger's scoping list", () => {
    assert.deepEqual(DEFS.map((d) => d.slug).sort(), [...EVENT_CATEGORY_STAMP_SLUGS].sort());
  });

  it("a food RSVP awards foodie_explorer — the RSVP trigger supplies only the category booleans", async () => {
    // routes/events.ts passes `{ context: eventCategoryContext(ev) }` and nothing
    // else, so `events_joined` MUST come from the DB resolver.
    const ctx = eventCategoryContext({ category: "Street food crawl", tags: ["food"] }) as unknown as Record<string, boolean>;
    assert.equal(ctx.event_category_food, true);
    assert.equal((ctx as any).events_joined, undefined, "the trigger must not supply events_joined via context");

    const { client } = makeSchemaAwareSc(
      { event_rsvps: [{ event_id: "e1", user_id: USER, status: "going", created_at: "t" }] },
      { flagOn: true, defs: DEFS },
    );

    const awarded: string[] = [];
    const outcomes = await evaluateAndAwardCriteria(client, USER, {
      ctx: { context: ctx },
      sourceType: "events",
      sourceId: "e1",
      onlySlugs: [...EVENT_CATEGORY_STAMP_SLUGS],
      awardFn: async (i) => { awarded.push(i.definitionSlug); return { awarded: true, reason: "awarded", userStampId: "s1" }; },
    });

    assert.deepEqual(awarded, ["foodie_explorer"],
      `expected foodie_explorer to be awarded, got [${awarded.join(", ")}]; outcomes: ` +
      outcomes.map((o) => `${o.slug}:${o.met}/${o.reason}`).join(" "));
  });

  it("event_regular is awarded at 5 'going' RSVPs and not at 4", async () => {
    const rsvps = (n: number) => Array.from({ length: n }, (_, i) => ({
      event_id: `e${i}`, user_id: USER, status: "going", created_at: "t",
    }));
    const run = async (n: number) => {
      const { client } = makeSchemaAwareSc({ event_rsvps: rsvps(n) }, { flagOn: true, defs: DEFS });
      const awarded: string[] = [];
      await evaluateAndAwardCriteria(client, USER, {
        ctx: { context: {} },
        onlySlugs: ["event_regular"],
        awardFn: async (i) => { awarded.push(i.definitionSlug); return { awarded: true, reason: "awarded" }; },
      });
      return awarded;
    };
    assert.deepEqual(await run(4), [], "event_regular must not fire below its threshold");
    assert.deepEqual(await run(5), ["event_regular"]);
  });
});

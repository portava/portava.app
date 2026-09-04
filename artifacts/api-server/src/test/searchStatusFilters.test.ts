/**
 * GET /api/discovery/search — enum-typed status filters on trips, plans and posts.
 *
 * Run: node --import tsx/esm --test src/test/searchStatusFilters.test.ts
 * (the npm `test` script supplies the dummy Supabase env this needs; naming
 *  those variables here — even in a comment — trips check-guard-coverage.)
 *
 * WHAT THIS FILE IS FOR
 * =====================
 * Three emitters returned an empty list for EVERY query in production:
 *
 *   searchTrips                .neq("status","deleted") / .neq("status","banned")
 *   searchPlans' trips lookup  the same two
 *   searchPosts                .neq("status","banned")
 *
 * None of those literals is a label of the enum it was compared against
 * (`trip_status`, `post_status`). Postgres rejects an unknown enum literal with
 * 22P02 — a HARD ERROR, not a non-match — PostgREST turns that into a 400, and
 * each emitter's `if (error || !data) return []` swallowed it. The search did
 * not fail; it silently returned nothing.
 *
 * Verified by executing the equivalent SQL against PRODUCTION on 2026-09-03:
 * `... where status <> 'deleted'::trip_status` and `... <> 'banned'::post_status`
 * both raise 22P02. The repaired predicates run clean on the same database and
 * reach 12 trips, 9 posts and 8 plan items that no search could return before.
 *
 * WHAT IS *NOT* CURRENTLY LEAKING — stated so nobody reads more into this
 * -----------------------------------------------------------------------
 * Both fixes are strictly tighter than a bare label substitution would be, and
 * that extra tightness is load-bearing but presently inert: production today has
 * NO draft/cancelled/archived trips and NO hidden/reported/deleted posts. So
 * `.neq("status","deleted")` on posts would return the same 9 rows right now.
 * The moderation-bypass argument below is about what the predicate PERMITS, not
 * about rows that are escaping today — which is exactly why it needs a test
 * rather than a look at the data.
 *
 * This is the SIXTH and SEVENTH instance of the class in this repo (the gem and
 * event emitters were the fifth and sixth, fixed in 51402fe99). Every one of
 * them survived the same way: THE FIXTURE INVENTED THE LABEL. `status:
 * "approved"` on gems, `status: "published"` on events, `status: "deleted"` on
 * trips — values no row in either database can hold, asserted on for months by
 * tests that were green the whole time.
 *
 * WHY THE FIXTURES LOOK LIKE THIS
 * ===============================
 * Following src/test/searchResultPlacement.test.ts: the mock projects EVERY
 * table down to the columns the emitter's own `select()` asked for, and every
 * fixture key, select column and enum literal is checked against REAL_COLUMNS /
 * REAL_ENUM_LABELS — the live schema, read rather than remembered. A test
 * cannot assert on a column the emitter never requested, and cannot assert on a
 * status the database does not have.
 *
 * WHY ONLY *ENUM-TYPED* COLUMNS ARE FATAL
 * =======================================
 * `trip_plan_items.status` and `.visibility` are `text` columns, not enums, so
 * a wrong literal there is an ordinary non-match — wrong results, but not a
 * 400 that empties the whole emitter. That distinction is the reason this class
 * is invisible: the same typo is harmless on one column and total on another.
 * REAL_ENUM_LABELS therefore lists ONLY the genuinely enum-typed columns, and
 * the guard at the bottom holds it against the generated schema types.
 *
 * SCHEMA FACTS, AND HOW FAR EACH SOURCE CAN BE TRUSTED
 * ====================================================
 * The ENUM LABELS were read from production on 2026-09-03, and the pg_dump
 * baseline (baseline/20260819_baseline_structure.sql) and the generated
 * Supabase types (src/lib/database.types.ts) agree with that read label for
 * label on every enum used here. The types file is machine-checked against
 * these constants below rather than trusted by eye.
 *
 * The COLUMN LISTS come from the baseline, NOT from the generated types. The
 * types file is stale in the "missing recently-added columns" direction —
 * `post_media.feed_url` / `feed_storage_path` (migration 0208, read by live
 * code) and `profiles.phone_e164` are absent from it but present in both the
 * baseline and production. It has never been observed to name a column that
 * does NOT exist, which is why it is still safe as the enum cross-check: its
 * failure mode produces loud false positives, never a silent pass.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import discoverySearchRouter, {
  TRIP_UNSEARCHABLE_STATUSES,
  TRIP_RETIRED_STATUSES,
  POST_SEARCHABLE_STATUSES,
} from "../routes/discoverySearch.js";
import { Constants } from "../lib/database.types.js";

// ── The live schema, as facts ─────────────────────────────────────────────────

/** Real `public.*` column names for every table these emitters touch. */
const REAL_COLUMNS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    blocks: "blocked_id blocker_id created_at id",
    post_media:
      "canonical_place_id created_at dedup_processed duration_seconds feed_storage_path " +
      "feed_url file_size_bytes height id media_type mime_type moderation_status phash " +
      "post_id processing_status public_url sort_order stamp_overlay storage_bucket " +
      "storage_path thumbnail_storage_path thumbnail_url updated_at user_id width",
    posts:
      "add_to_passport age_max age_min age_restriction_enabled author_id bucket_classified " +
      "canonical_location_id canonical_place_id category comment_count comments_setting " +
      "content created_at created_by delayed_location_reason deleted_at exited_geofence_at " +
      "filter_id filter_intensity geo_restriction geofence_radius_meters geog " +
      "geotag_credit_awarded geotag_verified has_video id like_count likes_hidden " +
      "location_city location_country location_distance_meters location_lat location_lng " +
      "location_name location_place_id location_privacy_mode location_sensitivity_level " +
      "location_source location_verified location_verified_at media_count " +
      "media_duration_seconds media_thumbnail_url media_type media_urls original_language " +
      "original_lat original_lng post_buckets post_status primary_media_type public_lat " +
      "public_location_label public_lng publish_after_exit publish_after_time publish_at " +
      "publish_eligible_at published_at reposting_disabled save_count share_count " +
      "sharing_disabled source status trip_id updated_at updated_by user_gps_lat " +
      "user_gps_lng venue_id venue_name visibility",
    profile_privacy_settings:
      "allow_follow allow_friend_requests allow_messages_from allow_profile_discovery " +
      "allow_tagging delayed_posting_default precise_location_visible profile_visibility " +
      "show_current_city show_followers show_friends show_home_country show_past_trips " +
      "show_posts show_real_name show_stamps show_upcoming_trips show_visited_places " +
      "updated_at user_id",
    profiles:
      "account_status auto_translate_messages availability_tags avatar_image_height " +
      "avatar_image_width avatar_url bio bio_original_language buddy_verified_at budget_style " +
      "city comfort_level country country_code cover_image_height cover_image_width " +
      "cover_photo_url created_at current_city date_of_birth default_language display_name " +
      "dob_verified expo_push_token featured_count flag_emoji full_name handle " +
      "highlights_last_viewed_at home_city home_country home_country_verified_at " +
      "host_verified_at id id_verified_at interests is_official is_private location_city " +
      "location_country location_verified looking_for name notifications_inbox_viewed_at " +
      "open_to_meet passport_hidden_sections passport_section_order passport_tab_order " +
      "passport_visibility phone_e164 phone_verified_at planning_style preferred_language " +
      "preferred_message_language public_social_links role safety_flags_count " +
      "selfie_verified_at show_original_messages show_profile_picture_publicly " +
      "show_telegraph_circle show_telegraph_dm show_telegraph_trip spoken_languages " +
      "tag_permission tagline translation_updated_at travel_group_style travel_pace " +
      "travel_style travel_styles trust_label trust_score updated_at username " +
      "username_updated_at verification_expires_at verification_level verification_method " +
      "verification_status verified verified_at verified_since",
    trip_plan_items:
      "added_by category city country created_at creator_id day_date description ends_at id " +
      "lat lng location_is_private location_name lock_type notes removed_at route_stop_id " +
      "sort_order source_id source_type starts_at status title trip_id updated_at visibility",
    trips:
      "allow_friend_suggestions allow_join_requests allow_trip_crew_invites " +
      "cover_image_height cover_image_width cover_media_type cover_url created_at " +
      "delayed_posting_default destination_city destination_country destination_lat " +
      "destination_lng destination_place_id end_date id max_members neighborhoods " +
      "open_to_meet original_language owner_id plan_edit_permission precise_location_visible " +
      "progress reminder_delivered_at reminder_retry_count reminder_sent_at " +
      "show_destination_city show_exact_dates show_header_publicly show_in_discovery " +
      "show_on_profile start_date status timezone title travel_style trip_notes trip_type " +
      "updated_at visibility",
    user_privacy_settings:
      "age_restriction_enabled allow_location_sharing id profile_visibility " +
      "show_online_status updated_at user_id who_can_tag",
  }).map(([t, cols]) => [t, new Set(cols.split(/\s+/))]),
);

/**
 * Real enum labels, keyed `table.column`.
 *
 * ONLY genuinely enum-typed columns belong here — those are the ones where a
 * wrong literal is a 400 instead of a non-match. `trip_plan_items.status` and
 * `trip_plan_items.visibility` are `text` and are deliberately absent.
 */
const REAL_ENUM_LABELS: Record<string, ReadonlySet<string>> = {
  "posts.status": new Set(["active", "hidden", "reported", "deleted"]),
  "posts.visibility": new Set(["public", "trip_only", "private", "followers_only"]),
  "trips.status": new Set([
    "draft", "planning", "upcoming", "active", "completed", "cancelled", "archived",
  ]),
  "trips.visibility": new Set(["public", "buddies", "private", "invite"]),
};

/**
 * The generated-types enum each `table.column` above is declared as, so the
 * hardcoded labels can be held against a second in-repo source. Read off the
 * `Row` annotations in src/lib/database.types.ts.
 */
const ENUM_TYPE_OF_COLUMN: Record<string, keyof typeof Constants.public.Enums> = {
  "posts.status": "post_status",
  "posts.visibility": "post_visibility",
  "trips.status": "trip_status",
  "trips.visibility": "trip_visibility",
};

// ── Stable test UUIDs ─────────────────────────────────────────────────────────

const ME = "aa000000-0000-4000-a000-000000000001";
const ALICE = "bb000000-0000-4000-a000-000000000002";
const ME_TOK = "tok-me";

const TRIP_ID = "cc000000-0000-4000-a000-000000000010";
const TRIP_B = "cc000000-0000-4000-a000-000000000011";
const PLAN_ID = "dd000000-0000-4000-a000-000000000020";
const PLAN_B = "dd000000-0000-4000-a000-000000000021";
const POST_ID = "ff000000-0000-4000-a000-000000000030";
const POST_B = "ff000000-0000-4000-a000-000000000031";

// ── Recording, projecting fake Supabase client ────────────────────────────────

interface Recorded {
  /** table -> every column list the emitters asked that table for. */
  selects: Map<string, Set<string>>;
  /** `table.column` -> every literal fed to an equality/set filter on it. */
  filterValues: Map<string, Set<string>>;
  /**
   * `table.column` -> the RAW `.not(…, "in", …)` string, before parsing.
   *
   * Recorded separately because the parser below is deliberately lenient about
   * quoting, so a malformed literal can still yield the right value set here
   * while PostgREST rejects it outright. The shape has to be asserted on its
   * own or it is not asserted at all.
   */
  notInLiterals: Map<string, Set<string>>;
}

let recorded: Recorded;

function record(map: Map<string, Set<string>>, key: string, value: string) {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(value);
}

/**
 * Projects EVERY table down to the emitter's own select list, so a fixture
 * column the emitter never asked for cannot reach an assertion.
 *
 * `.not()` models BOTH the `is` and `in` operators. That matters more than it
 * looks: the sibling suite's fake modelled only `is`, which made a
 * `.not(…, "in", …)` clause a silent no-op in tests while it filtered rows in
 * production — a mock that cannot see the fix is no better than one that cannot
 * see the bug. Anything else throws rather than passing silently.
 */
function makeFakeClient(state: Record<string, any[]>) {
  return {
    auth: {
      getUser: async (tok: string) =>
        tok === ME_TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => {
      const sourceRows: any[] = [...(state[table] ?? [])];
      const filters: Array<(r: any) => boolean> = [];
      let cols: string[] | null = null;
      let rangeStart = 0;
      let rangeEnd = Infinity;
      let limitN = Infinity;

      const project = (rows: any[]) =>
        cols === null
          ? rows
          : rows.map((r) =>
              Object.fromEntries(cols!.filter((c) => c in r).map((c) => [c, r[c]])));

      const noteFilter = (col: string, val: any) => {
        if (typeof val === "string") record(recorded.filterValues, `${table}.${col}`, val);
      };

      const builder: any = {
        select(c?: string) {
          if (typeof c === "string" && c !== "*") {
            cols = c.split(",").map((x) => x.trim()).filter(Boolean);
            record(recorded.selects, table, c);
          }
          return builder;
        },
        eq(col: string, val: any) { noteFilter(col, val); filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { noteFilter(col, val); filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) {
          for (const v of vals ?? []) noteFilter(col, v);
          filters.push((r) => Array.from(vals ?? []).includes(r[col]));
          return builder;
        },
        not(col: string, op: string, val: any) {
          if (op === "is") { filters.push((r) => r[col] !== val && r[col] != null); return builder; }
          if (op === "in") {
            record(recorded.notInLiterals, `${table}.${col}`, String(val));
            const set = new Set(
              String(val).replace(/^\(|\)$/g, "").split(",")
                .map((v) => v.trim().replace(/^"|"$/g, "")),
            );
            for (const v of set) noteFilter(col, v);
            filters.push((r) => !set.has(String(r[col] ?? "")));
            return builder;
          }
          throw new Error(`fake client: unmodelled .not(${col}, "${op}", …)`);
        },
        is(col: string, val: any) {
          filters.push((r) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        ilike(col: string, pat: string) {
          const re = new RegExp(
            "^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
          filters.push((r) => re.test(String(r[col] ?? "")));
          return builder;
        },
        or(expr: string) {
          const parts = expr.split(",").map((p) => {
            const m = p.trim().match(/^(\w+)\.([\w]+)\.(.+)$/);
            return m ? { col: m[1]!, op: m[2]!.toLowerCase(), val: m[3]! } : null;
          }).filter(Boolean) as { col: string; op: string; val: string }[];
          filters.push((r) => parts.some(({ col, op, val }) => {
            const cell = String(r[col] ?? "");
            if (op === "ilike") {
              const re = new RegExp(
                "^" + val.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
              return re.test(cell);
            }
            return op === "eq" ? cell === val : false;
          }));
          return builder;
        },
        gte(col: string, val: any) { filters.push((r) => r[col] != null && r[col] >= val); return builder; },
        lt(col: string, val: any) { filters.push((r) => r[col] != null && r[col] < val); return builder; },
        order() { return builder; },
        limit(n: number) { limitN = n; return builder; },
        range(s: number, e: number) { rangeStart = s; rangeEnd = e; return builder; },
        maybeSingle() {
          const matched = project(sourceRows.filter((r) => filters.every((f) => f(r))));
          return Promise.resolve({ data: matched[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          const matched = project(
            sourceRows.filter((r) => filters.every((f) => f(r))).slice(
              rangeStart,
              rangeEnd < Infinity ? rangeEnd + 1 : limitN < Infinity ? limitN : undefined,
            ),
          );
          return Promise.resolve({ data: matched, error: null }).then(onF, onR);
        },
      };
      return builder;
    },
  };
}

// ── Fixtures, validated against the real schema ───────────────────────────────

/** Assert every key of every fixture row is a real column, with a real enum value. */
function assertFixtureIsSchemaReal(state: Record<string, any[]>) {
  for (const [table, rows] of Object.entries(state)) {
    const real = REAL_COLUMNS[table];
    assert.ok(real, `fixture uses table "${table}" with no recorded schema — add it to REAL_COLUMNS`);
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        assert.ok(real!.has(key), `fixture column ${table}.${key} does not exist in the live schema`);
      }
      for (const col of ["status", "state", "visibility"]) {
        const labels = REAL_ENUM_LABELS[`${table}.${col}`];
        if (labels && col in row && row[col] != null) {
          assert.ok(
            labels.has(String(row[col])),
            `fixture ${table}.${col} = "${row[col]}" is not a label of that enum — ` +
            "Postgres would reject it with 22P02, so no row could ever hold it",
          );
        }
      }
    }
  }
}

function tripRow(over: Record<string, any> = {}) {
  return {
    id: TRIP_ID,
    title: "Tokyo Spring Trip",
    destination_city: "Tokyo",
    destination_country: "Japan",
    owner_id: ALICE,
    cover_url: null,
    start_date: "2026-11-01",
    status: "planning",
    visibility: "public",
    show_in_discovery: true,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function planRow(over: Record<string, any> = {}) {
  return {
    id: PLAN_ID,
    title: "Tokyo Tower at sunset",
    trip_id: TRIP_ID,
    creator_id: ALICE,
    removed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function postRow(over: Record<string, any> = {}) {
  return {
    id: POST_ID,
    content: "Tokyo was unreal this spring",
    author_id: ALICE,
    media_urls: null,
    like_count: 4,
    status: "active",
    visibility: "public",
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function profileRow(over: Record<string, any> = {}) {
  return {
    id: ALICE,
    handle: "alice",
    username: "alice",
    name: "Alice",
    avatar_url: null,
    is_private: false,
    home_city: null,
    home_country: null,
    account_status: "active",
    verified: false,
    is_official: false,
    ...over,
  };
}

const BASE_TABLES = [
  "blocks", "profiles", "profile_privacy_settings", "user_privacy_settings",
  "trips", "trip_plan_items", "posts", "post_media",
] as const;

let base: string;
let server: Server;

function setup(state: Record<string, any[]>) {
  const full: Record<string, any[]> = Object.fromEntries(BASE_TABLES.map((t) => [t, []]));
  Object.assign(full, state);
  assertFixtureIsSchemaReal(full);
  recorded = { selects: new Map(), filterValues: new Map(), notInLiterals: new Map() };
  _setTestClient(makeFakeClient(full) as any, true);
}

function get(path: string, tok = ME_TOK) {
  return fetch(`${base}${path}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
}

async function idsFor(query: string): Promise<string[]> {
  const r = await get(query);
  assert.equal(r.status, 200, `${query}: HTTP ${r.status}`);
  const body = await r.json() as any;
  return (body.results as any[]).map((x) => x.id as string);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", discoverySearchRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(() => server.close());

beforeEach(() => {
  _resetRateLimit();
  setup({});
});

// ── The schema facts themselves ───────────────────────────────────────────────
//
// Everything below rests on REAL_ENUM_LABELS being right. Hold it against the
// generated Supabase types so it is not one person's transcription.

describe("discovery search — the enum facts this suite asserts against", () => {
  it("matches the generated schema types label for label", () => {
    for (const [column, labels] of Object.entries(REAL_ENUM_LABELS)) {
      const enumName = ENUM_TYPE_OF_COLUMN[column];
      assert.ok(enumName, `${column} has no declared enum type — add it to ENUM_TYPE_OF_COLUMN`);
      const generated = Constants.public.Enums[enumName!] as readonly string[];
      assert.ok(generated, `database.types.ts has no enum "${enumName}"`);
      assert.deepEqual(
        [...labels].sort(), [...generated].sort(),
        `${column}: this suite's labels disagree with database.types.ts (${enumName}). ` +
        "One of the two is stale — re-read the live enum before trusting either.",
      );
    }
  });

  it("names only columns that really exist", () => {
    for (const column of Object.keys(REAL_ENUM_LABELS)) {
      const [table, col] = column.split(".") as [string, string];
      assert.ok(REAL_COLUMNS[table], `REAL_ENUM_LABELS names table "${table}" absent from REAL_COLUMNS`);
      assert.ok(REAL_COLUMNS[table]!.has(col), `${column} is not a real column`);
    }
  });

  it("does not claim trip_plan_items.status is an enum", () => {
    // It is a `text` column (DEFAULT 'tentative'). Listing it here would assert
    // a 22P02 risk that does not exist and would reject valid fixtures.
    assert.equal(REAL_ENUM_LABELS["trip_plan_items.status"], undefined);
    assert.equal(REAL_ENUM_LABELS["trip_plan_items.visibility"], undefined);
  });
});

// ── The exported predicates ───────────────────────────────────────────────────

describe("discovery search — status predicates name only real enum labels", () => {
  it("TRIP_UNSEARCHABLE_STATUSES holds only real trip_status labels", () => {
    assert.ok(TRIP_UNSEARCHABLE_STATUSES.length > 0, "an empty exclusion list excludes nothing");
    for (const s of TRIP_UNSEARCHABLE_STATUSES) {
      assert.ok(
        REAL_ENUM_LABELS["trips.status"]!.has(s),
        `"${s}" is not a trip_status label — Postgres rejects it with 22P02 and the ` +
        "whole emitter returns []",
      );
    }
  });

  it("POST_SEARCHABLE_STATUSES holds only real post_status labels", () => {
    assert.ok(POST_SEARCHABLE_STATUSES.length > 0, "an empty status filter would match nothing");
    for (const s of POST_SEARCHABLE_STATUSES) {
      assert.ok(
        REAL_ENUM_LABELS["posts.status"]!.has(s),
        `"${s}" is not a post_status label — Postgres rejects it with 22P02`,
      );
    }
  });

  it("TRIP_RETIRED_STATUSES holds only real trip_status labels", () => {
    assert.ok(TRIP_RETIRED_STATUSES.length > 0, "an empty exclusion list excludes nothing");
    for (const s of TRIP_RETIRED_STATUSES) {
      assert.ok(REAL_ENUM_LABELS["trips.status"]!.has(s), `"${s}" is not a trip_status label`);
    }
  });

  it("the public gate is the owner gate plus exactly `draft`", () => {
    // The two predicates answer two questions, but they are not independent:
    // public = retired + draft. Pinned so a change to one cannot silently make
    // the public surface LOOSER than the owner surface.
    assert.deepEqual(
      [...TRIP_UNSEARCHABLE_STATUSES].sort(),
      [...new Set([...TRIP_RETIRED_STATUSES, "draft"])].sort(),
    );
    for (const s of TRIP_RETIRED_STATUSES) {
      assert.ok(
        (TRIP_UNSEARCHABLE_STATUSES as readonly string[]).includes(s),
        `"${s}" is hidden from the owner but not from the public — that is backwards`,
      );
    }
  });

  it("leaves at least one trip status searchable", () => {
    // A denylist that happened to name every label would be a different way of
    // writing the same dead search.
    const remaining = [...REAL_ENUM_LABELS["trips.status"]!]
      .filter((s) => !(TRIP_UNSEARCHABLE_STATUSES as readonly string[]).includes(s));
    assert.ok(remaining.length > 0, "every trip_status label is excluded — the search is still dead");
  });
});

// ── What actually reaches the wire ────────────────────────────────────────────
//
// The exported constants above are only half the story: an emitter could bypass
// them. These drive the real endpoint and inspect every literal the client
// received, so a hardcoded filter added later is caught too.

describe("discovery search — no emitter filters on a literal its enum lacks", () => {
  const cases: Array<{ type: string; query: string; column: string; state: () => Record<string, any[]> }> = [
    {
      type: "trips", query: "/discovery/search?q=tokyo&type=trips", column: "trips.status",
      state: () => ({ profiles: [profileRow()], trips: [tripRow()] }),
    },
    {
      type: "plans", query: "/discovery/search?q=tokyo&type=plans", column: "trips.status",
      state: () => ({ profiles: [profileRow()], trips: [tripRow()], trip_plan_items: [planRow()] }),
    },
    {
      type: "posts", query: "/discovery/search?q=tokyo&type=posts", column: "posts.status",
      state: () => ({ profiles: [profileRow()], posts: [postRow()] }),
    },
  ];

  for (const { type, query, column, state } of cases) {
    it(`${type}: every ${column} literal is a real label`, async () => {
      setup(state());
      await get(query);
      const seen = recorded.filterValues.get(column);
      assert.ok(seen && seen.size > 0, `no ${column} filter recorded — the check would be vacuous`);
      const labels = REAL_ENUM_LABELS[column]!;
      for (const v of seen!) {
        assert.ok(
          labels.has(v),
          `${type} filters ${column} on "${v}", which Postgres rejects with 22P02 — ` +
          "PostgREST returns 400 and the emitter's `if (error || !data) return []` " +
          "turns it into an empty search",
        );
      }
    });
  }

  it("every column these emitters SELECT exists in the live schema", async () => {
    setup({
      profiles: [profileRow()],
      trips: [tripRow()],
      trip_plan_items: [planRow()],
      posts: [postRow()],
    });
    const r = await get("/discovery/search?q=tokyo&type=all");
    assert.equal(r.status, 200);

    assert.ok(recorded.selects.size > 0, "no SELECT was recorded — the sweep would be vacuous");
    const unknown: string[] = [];
    for (const [table, lists] of recorded.selects) {
      const real = REAL_COLUMNS[table];
      if (!real) continue; // tables outside this lane's fixtures
      for (const list of lists) {
        for (const col of list.split(",").map((c) => c.trim()).filter(Boolean)) {
          if (!real.has(col)) unknown.push(`${table}.${col}`);
        }
      }
    }
    assert.deepEqual(unknown, [], `emitter SELECTed columns that do not exist: ${unknown.join(", ")}`);
  });
});

// ── The searches are alive ────────────────────────────────────────────────────
//
// The class's whole signature is "returns [] for every query, forever". A test
// that only checks the FILTER can still be green against an emitter that is
// dead for some other reason, so drive each one end to end and require a row.

describe("discovery search — trips, plans and posts return results at all", () => {
  it("trips: a public discoverable trip is findable", async () => {
    setup({ profiles: [profileRow()], trips: [tripRow()] });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=trips"), [TRIP_ID]);
  });

  it("plans: a plan item on a public trip is findable", async () => {
    setup({ profiles: [profileRow()], trips: [tripRow()], trip_plan_items: [planRow()] });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=plans"), [PLAN_ID]);
  });

  it("posts: a public active post is findable", async () => {
    setup({ profiles: [profileRow()], posts: [postRow()] });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=posts"), [POST_ID]);
  });
});

// ── Trips: what the predicate actually excludes ───────────────────────────────

describe("discovery search — trips status exclusion", () => {
  for (const status of ["planning", "upcoming", "active", "completed"]) {
    it(`returns a ${status} trip`, async () => {
      setup({ profiles: [profileRow()], trips: [tripRow({ status })] });
      assert.deepEqual(
        await idsFor("/discovery/search?q=tokyo&type=trips"), [TRIP_ID],
        `a ${status} trip is public content and must remain searchable`,
      );
    });
  }

  for (const status of TRIP_UNSEARCHABLE_STATUSES) {
    it(`excludes a ${status} trip`, async () => {
      setup({ profiles: [profileRow()], trips: [tripRow({ status })] });
      assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=trips"), []);
    });
  }

  it("drops the draft and archived trips the old filter would have surfaced", async () => {
    // The broken predicate excluded only `cancelled` among real labels. Had its
    // two bogus literals ever been valid, it would have listed unpublished
    // drafts and archived trips in public search.
    setup({
      profiles: [profileRow()],
      trips: [
        tripRow({ id: TRIP_ID, status: "upcoming" }),
        tripRow({ id: TRIP_B, status: "draft" }),
      ],
    });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=trips"), [TRIP_ID]);
  });

  it("still honours visibility and the discovery opt-out", async () => {
    setup({
      profiles: [profileRow()],
      trips: [
        tripRow({ id: TRIP_ID, visibility: "private" }),
        tripRow({ id: TRIP_B, show_in_discovery: false }),
      ],
    });
    assert.deepEqual(
      await idsFor("/discovery/search?q=tokyo&type=trips"), [],
      "the status fix must not have widened the visibility gate",
    );
  });
});

// ── Plans: the parent trip's status decides ───────────────────────────────────

describe("discovery search — plans inherit their trip's status exclusion", () => {
  for (const status of TRIP_UNSEARCHABLE_STATUSES) {
    it(`excludes a plan item on someone else's ${status} public trip`, async () => {
      setup({
        profiles: [profileRow()],
        trips: [tripRow({ status })],
        trip_plan_items: [planRow()],
      });
      assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=plans"), []);
    });
  }

  it("keeps a plan item whose trip is live and drops its sibling on an archived trip", async () => {
    setup({
      profiles: [profileRow()],
      trips: [
        tripRow({ id: TRIP_ID, status: "upcoming" }),
        tripRow({ id: TRIP_B, status: "archived" }),
      ],
      trip_plan_items: [
        planRow({ id: PLAN_ID, trip_id: TRIP_ID }),
        planRow({ id: PLAN_B, trip_id: TRIP_B }),
      ],
    });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=plans"), [PLAN_ID]);
  });

  it("still returns the caller's own plan item on a private trip", async () => {
    // The owner branch is why this emitter reads trips at all — the status fix
    // must not collapse it into the public-only path.
    setup({
      profiles: [profileRow({ id: ME, handle: "me", username: "me", name: "Me" })],
      trips: [tripRow({ owner_id: ME, visibility: "private", show_in_discovery: false })],
      trip_plan_items: [planRow({ creator_id: ME })],
    });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=plans"), [PLAN_ID]);
  });

  it("returns the caller's own plan item on their DRAFT trip", async () => {
    // The two-predicate split, pinned. `draft` is excluded from the PUBLIC
    // branch only: an unpublished trip is not public content, but it is still
    // the owner's, and this emitter reads trips precisely so the owner branch
    // can exist. Matches CompassTripContext and PassportRemembersService, both
    // of which include `draft` on owner-scoped trip reads.
    setup({
      profiles: [profileRow({ id: ME, handle: "me", username: "me", name: "Me" })],
      trips: [tripRow({ owner_id: ME, visibility: "private", status: "draft" })],
      trip_plan_items: [planRow({ creator_id: ME })],
    });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=plans"), [PLAN_ID]);
  });

  for (const status of TRIP_RETIRED_STATUSES) {
    it(`excludes the caller's own plan item when their trip is ${status}`, async () => {
      // Retired means retired for everyone — the owner branch does not reopen it.
      setup({
        profiles: [profileRow({ id: ME, handle: "me", username: "me", name: "Me" })],
        trips: [tripRow({ owner_id: ME, visibility: "private", status })],
        trip_plan_items: [planRow({ creator_id: ME })],
      });
      assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=plans"), []);
    });
  }

  it("excludes a DRAFT public trip's plan item from a stranger", async () => {
    setup({
      profiles: [profileRow()],
      trips: [tripRow({ owner_id: ALICE, visibility: "public", status: "draft" })],
      trip_plan_items: [planRow()],
    });
    assert.deepEqual(
      await idsFor("/discovery/search?q=tokyo&type=plans"), [],
      "an unpublished trip is not public content, whatever its visibility says",
    );
  });

  it("still excludes a plan item on someone else's private trip", async () => {
    setup({
      profiles: [profileRow()],
      trips: [tripRow({ owner_id: ALICE, visibility: "private" })],
      trip_plan_items: [planRow()],
    });
    assert.deepEqual(
      await idsFor("/discovery/search?q=tokyo&type=plans"), [],
      "the status fix must not have widened the trip-visibility gate",
    );
  });
});

// ── Posts: an allowlist, not a denylist ───────────────────────────────────────

describe("discovery search — posts status allowlist", () => {
  it("returns an active public post", async () => {
    setup({ profiles: [profileRow()], posts: [postRow({ status: "active" })] });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=posts"), [POST_ID]);
  });

  for (const status of ["hidden", "reported", "deleted"]) {
    it(`excludes a ${status} post`, async () => {
      setup({ profiles: [profileRow()], posts: [postRow({ status })] });
      assert.deepEqual(
        await idsFor("/discovery/search?q=tokyo&type=posts"), [],
        `a ${status} post must not reach public search`,
      );
    });
  }

  it("excludes hidden and reported posts a bare .neq(status,'deleted') would have surfaced", async () => {
    // This is the test that separates the real fix from the tempting one.
    // `deleted` was a genuine post_status label, so dropping only the bogus
    // "banned" literal compiles, runs, and quietly publishes the moderation
    // queue. posts_select_policy would have caught it — but this emitter runs
    // on the service-role client, which bypasses RLS entirely.
    setup({
      profiles: [profileRow()],
      posts: [
        postRow({ id: POST_ID, status: "active" }),
        postRow({ id: POST_B, status: "reported" }),
      ],
    });
    assert.deepEqual(await idsFor("/discovery/search?q=tokyo&type=posts"), [POST_ID]);
  });

  it("still excludes non-public posts", async () => {
    setup({
      profiles: [profileRow()],
      posts: [postRow({ visibility: "followers_only" })],
    });
    assert.deepEqual(
      await idsFor("/discovery/search?q=tokyo&type=posts"), [],
      "the status fix must not have widened the visibility gate",
    );
  });
});

// ── The mock models the operators the route uses ──────────────────────────────
//
// A fake that no-ops an operator the route depends on is how the class hides:
// the fix filters rows in production and nothing at all in the test.

describe("discovery search — the fake client models .not(…, \"in\", …) faithfully", () => {
  /** Drive the REAL builder the emitters get, not a re-implementation of it. */
  function probe(rows: any[]) {
    recorded = { selects: new Map(), filterValues: new Map(), notInLiterals: new Map() };
    return (makeFakeClient({ probe: rows }) as any).from("probe");
  }

  const STATUSES = [
    { id: "a", status: "draft" },
    { id: "b", status: "planning" },
    { id: "c", status: "cancelled" },
    { id: "d", status: "archived" },
    { id: "e", status: null },
  ];

  it("excludes exactly the listed values and nothing else", async () => {
    const { data } = await probe(STATUSES)
      .select("id, status")
      .not("status", "in", '("draft","cancelled","archived")');
    assert.deepEqual((data as any[]).map((r) => r.id), ["b", "e"]);
  });

  it("is not a no-op — the unfiltered set is strictly larger", async () => {
    // The exact failure the sibling suite's fake had: `.not(…, "in", …)` fell
    // through and returned the builder unchanged, so every fixture passed.
    const { data } = await probe(STATUSES).select("id, status");
    assert.equal((data as any[]).length, STATUSES.length);
  });

  it("records every value inside the literal, so the 22P02 sweep can see them", async () => {
    await probe(STATUSES).select("id, status").not("status", "in", '("draft","cancelled")');
    assert.deepEqual(
      [...(recorded.filterValues.get("probe.status") ?? [])].sort(),
      ["cancelled", "draft"],
    );
  });

  it("still models .not(…, \"is\", null)", async () => {
    const { data } = await probe(STATUSES).select("id, status").not("status", "is", null);
    assert.deepEqual((data as any[]).map((r) => r.id), ["a", "b", "c", "d"]);
  });

  it("throws rather than silently passing an operator it does not model", () => {
    assert.throws(
      () => probe(STATUSES).select("id, status").not("status", "gt", "b"),
      /unmodelled \.not/,
    );
  });
});

// ── The route's literal says what the exported constant says ─────────────────
//
// `notInList` is private to the route, so nothing above proves the string it
// builds carries the constant the tests check. This closes that gap from the
// outside: drive the real endpoint and compare the values the client received
// against the exported array. A formatter that dropped a value, mangled the
// quoting, or hardcoded a different set is caught here rather than in
// production.

describe("discovery search — the wire literal matches the exported constant", () => {
  it("trips: the recorded exclusion set is exactly TRIP_UNSEARCHABLE_STATUSES", async () => {
    setup({ profiles: [profileRow()], trips: [tripRow()] });
    await get("/discovery/search?q=tokyo&type=trips");
    assert.deepEqual(
      [...(recorded.filterValues.get("trips.status") ?? [])].sort(),
      [...TRIP_UNSEARCHABLE_STATUSES].sort(),
    );
  });

  it("plans: the trips sub-query sends the RETIRED set, not the public one", async () => {
    setup({ profiles: [profileRow()], trips: [tripRow()], trip_plan_items: [planRow()] });
    await get("/discovery/search?q=tokyo&type=plans");
    assert.deepEqual(
      [...(recorded.filterValues.get("trips.status") ?? [])].sort(),
      [...TRIP_RETIRED_STATUSES].sort(),
      "the DB filter carries only the everyone-branch exclusion; `draft` is per-branch in code",
    );
  });

  it("posts: the recorded allowlist is exactly POST_SEARCHABLE_STATUSES", async () => {
    setup({ profiles: [profileRow()], posts: [postRow()] });
    await get("/discovery/search?q=tokyo&type=posts");
    assert.deepEqual(
      [...(recorded.filterValues.get("posts.status") ?? [])].sort(),
      [...POST_SEARCHABLE_STATUSES].sort(),
    );
  });

  it("sends a well-formed PostgREST set literal, not just parseable-by-our-mock", async () => {
    // The mock's parser strips optional quoting, so a mangled literal can still
    // decode to the right values above while PostgREST rejects the request.
    // Pin the exact string the route builds.
    setup({ profiles: [profileRow()], trips: [tripRow()] });
    await get("/discovery/search?q=tokyo&type=trips");
    const literals = [...(recorded.notInLiterals.get("trips.status") ?? [])];
    assert.equal(literals.length, 1, "expected exactly one .not(status,'in',…) literal");
    assert.equal(literals[0], '("draft","cancelled","archived")');
    assert.match(
      literals[0]!, /^\("[a-z_]+"(,"[a-z_]+")*\)$/,
      "a set literal must be parenthesised, comma-separated and double-quoted",
    );
  });
});

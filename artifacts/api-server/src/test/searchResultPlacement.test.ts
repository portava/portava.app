/**
 * GET /api/discovery/search — §27 map placement and §24 protected location.
 *
 * Run: node --import tsx/esm --test src/test/searchResultPlacement.test.ts
 * (the npm `test` script supplies the dummy Supabase env this needs; naming
 *  those variables here — even in a comment — trips check-guard-coverage.)
 *
 * WHAT THIS FILE IS FOR
 * =====================
 * §27 ends with "Geographic results should center or frame the relevant map
 * object". The client's search adapter reads a result's coordinates out of the
 * untyped `metadata` bag and DROPS any result whose map type needs a point and
 * whose metadata has none. So a search type can be recognised end to end,
 * listed, tappable — and still be structurally unplaceable, with nothing
 * anywhere going red. Five emitters were in exactly that state.
 *
 * The asymmetry suite at the bottom is the one that catches the class:
 * it drives the real endpoint once per map-placeable type and fails if any of
 * them comes back without a usable position.
 *
 * WHY THE FIXTURES LOOK LIKE THIS
 * ===============================
 * The mock below projects EVERY table down to the columns the emitter's own
 * `select()` asked for, and every fixture key and select column is checked
 * against REAL_COLUMNS — the live schema, read out of Supabase rather than
 * remembered. Without that, a test asserting on `metadata.lat` passes whether
 * or not the emitter ever selected `lat`, which is the trap that let this bug
 * live: the sibling suite had fixtures carrying `status: "approved"` and
 * `status: "published"`, values no row in either database can hold, and both
 * were green for months.
 *
 * Schema facts below were read on 2026-09-03 from the CI project
 * (hwokxgbmezheskbzskfr) and cross-checked against production.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import discoverySearchRouter, {
  gemSearchPosition,
  GEM_SEARCHABLE_STATUSES,
} from "../routes/discoverySearch.js";
import { resolveGemCoords } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import type { SensitivityLevel } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";

// ── The live schema, as facts ─────────────────────────────────────────────────

/** Real `public.*` column names for every table these emitters touch. */
const REAL_COLUMNS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    blocks: "blocked_id blocker_id created_at id",
    canonical_locations:
      "aliases city country country_code created_at display_name id kind lat lng name " +
      "normalized_name postal_code provider_ids region search_key updated_at",
    discovery_places:
      "blurb canonical_location_id category city created_at header_image_attribution " +
      "header_image_generated_id header_image_source header_image_status " +
      "header_image_updated_at header_image_url id image_accuracy_status image_source_type " +
      "image_url lat lng max_age min_age name neighborhood note osm_id photos place_type " +
      "primary_category rating saved_count secondary_categories source source_id status " +
      "submitted_by tag verified",
    event_rsvps: "created_at event_id status updated_at user_id",
    events:
      "age_max age_min attendee_comments_enabled avg_rating category chat_enabled " +
      "chat_thread_id circle_id city country cover_image_height cover_image_width " +
      "cover_media_type cover_source cover_url created_at description ends_at featured geog " +
      "going_count header_image_attribution header_image_generated_id header_image_source " +
      "header_image_status header_image_updated_at host_id id is_recurring location_lat " +
      "location_lng location_name max_attendees original_language price_type price_url " +
      "recurring_config review_count rsvp_closed rsvp_options safety_notes " +
      "show_exact_location show_header_publicly starts_at state tags ticket_url title " +
      "trip_id trust_score_min updated_at verified_only visibility waitlist_count " +
      "waitlist_enabled",
    hidden_gems:
      "accessibility approx_geog approx_latitude approx_longitude best_time_to_go " +
      "canonical_place_id category city country created_at crowd_level description geog " +
      "guide_verified_by id image_url latitude layover_safe local_etiquette longitude " +
      "merged_into minimum_layover_minutes moderation_status name neighborhood price_range " +
      "report_count safety_notes save_count sensitivity_level source_confirmation " +
      "source_type status submitted_by updated_at verification_level vibe_tags visibility " +
      "visit_count",
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
    user_privacy_settings:
      "age_restriction_enabled allow_location_sharing id profile_visibility " +
      "show_online_status updated_at user_id who_can_tag",
  }).map(([t, cols]) => [t, new Set(cols.split(/\s+/))]),
);

/** Real enum labels. An unknown literal is a hard 22P02 in Postgres, not a non-match. */
const REAL_ENUM_LABELS: Record<string, ReadonlySet<string>> = {
  "hidden_gems.status": new Set(["pending", "active", "hidden", "merged"]),
  "hidden_gems.sensitivity_level": new Set([
    "public", "approximate", "reveal_after_save", "reveal_after_acceptance", "protected",
  ]),
  "events.state": new Set([
    "draft", "open", "full", "waitlist", "started", "completed", "cancelled", "archived",
  ]),
  "events.visibility": new Set(["public", "friends_only", "invite_only"]),
};

// ── Sentinel coordinates ──────────────────────────────────────────────────────
//
// The exact pair is deliberately absurd-looking and unique in this file, so a
// JSON.stringify scan of a whole response can prove it never appears anywhere —
// not in metadata, not in a stray passthrough, not inside a nested object.

const GEM_EXACT_LAT = 13.987654;
const GEM_EXACT_LNG = 100.987654;
const GEM_APPROX_LAT = 13.98;
const GEM_APPROX_LNG = 100.98;

const EVENT_LAT = 35.6812;
const EVENT_LNG = 139.7671;
const PLACE_LAT = 10.3157;
const PLACE_LNG = 123.8854;
const ACTIVITY_LAT = 16.0678;
const ACTIVITY_LNG = 108.2208;
const CITY_LAT = 10.3;
const CITY_LNG = 123.9;
const COUNTRY_LAT = 12.8797;
const COUNTRY_LNG = 121.774;

// ── Stable test UUIDs ─────────────────────────────────────────────────────────

const ME = "aa000000-0000-4000-a000-000000000001";
const ALICE = "bb000000-0000-4000-a000-000000000002";
const ME_TOK = "tok-me";

const EVT_ID = "ee000000-0000-4000-a000-000000000010";
const GEM_ID = "ee000000-0000-4000-a000-000000000011";
const PLACE_ID = "ee000000-0000-4000-a000-000000000012";
const ACT_ID = "ee000000-0000-4000-a000-000000000013";
const CANON_CITY_ID = "ee000000-0000-4000-a000-000000000014";
const CANON_COUNTRY_ID = "ee000000-0000-4000-a000-000000000015";

const UPCOMING = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

// ── Recording, projecting fake Supabase client ────────────────────────────────

interface Recorded {
  /** table -> every column list the emitters asked that table for. */
  selects: Map<string, Set<string>>;
  /** `table.column` -> every literal fed to an equality/set filter on it. */
  filterValues: Map<string, Set<string>>;
}

let recorded: Recorded;

function record(map: Map<string, Set<string>>, key: string, value: string) {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(value);
}

/**
 * Unlike the sibling suite's mock, this one projects EVERY table — not just
 * `profiles` — down to the emitter's own select list. A fixture column the
 * emitter never asked for cannot reach an assertion, so a test cannot pass
 * against a payload the route does not actually produce.
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

/** Assert every key of every fixture row is a real column of its table. */
function assertFixtureIsSchemaReal(state: Record<string, any[]>) {
  for (const [table, rows] of Object.entries(state)) {
    const real = REAL_COLUMNS[table];
    assert.ok(real, `fixture uses table "${table}" with no recorded schema — add it to REAL_COLUMNS`);
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        assert.ok(real!.has(key), `fixture column ${table}.${key} does not exist in the live schema`);
      }
      for (const col of ["status", "state", "sensitivity_level", "visibility"]) {
        const labels = REAL_ENUM_LABELS[`${table}.${col}`];
        if (labels && col in row && row[col] != null) {
          assert.ok(
            labels.has(String(row[col])),
            `fixture ${table}.${col} = "${row[col]}" is not a label of that enum`,
          );
        }
      }
    }
  }
}

function gemRow(over: Record<string, any> = {}) {
  return {
    id: GEM_ID,
    name: "Cebu Secret Cove",
    city: "Cebu",
    country: "PH",
    submitted_by: ALICE,
    category: "nature",
    status: "active",
    sensitivity_level: "public",
    latitude: GEM_EXACT_LAT,
    longitude: GEM_EXACT_LNG,
    approx_latitude: GEM_APPROX_LAT,
    approx_longitude: GEM_APPROX_LNG,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function eventRow(over: Record<string, any> = {}) {
  return {
    id: EVT_ID,
    title: "Cebu Jazz Night",
    host_id: ALICE,
    cover_url: null,
    city: "Cebu",
    country: "PH",
    starts_at: UPCOMING,
    visibility: "public",
    state: "open",
    location_lat: EVENT_LAT,
    location_lng: EVENT_LNG,
    show_exact_location: true,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function placeRow(over: Record<string, any> = {}) {
  return {
    id: PLACE_ID,
    name: "Cebu Heritage Monument",
    city: "Cebu",
    blurb: "landmark",
    image_url: null,
    header_image_source: null,
    image_source_type: null,
    image_accuracy_status: "verified",
    category: "landmarks",
    primary_category: "landmarks",
    lat: PLACE_LAT,
    lng: PLACE_LNG,
    canonical_location_id: null,
    status: "active",
    saved_count: 3,
    ...over,
  };
}

function activityRow(over: Record<string, any> = {}) {
  return {
    ...placeRow(),
    id: ACT_ID,
    name: "Cebu Canyoneering",
    category: "adventure",
    primary_category: "adventure",
    lat: ACTIVITY_LAT,
    lng: ACTIVITY_LNG,
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
  "events", "event_rsvps", "hidden_gems", "discovery_places", "canonical_locations",
] as const;

let base: string;
let server: Server;

function setup(state: Record<string, any[]>) {
  const full: Record<string, any[]> = Object.fromEntries(BASE_TABLES.map((t) => [t, []]));
  Object.assign(full, state);
  assertFixtureIsSchemaReal(full);
  recorded = { selects: new Map(), filterValues: new Map() };
  _setTestClient(makeFakeClient(full) as any, true);
}

function get(path: string, tok = ME_TOK) {
  return fetch(`${base}${path}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
}

/** The same extraction the client's searchAdapter performs on `metadata`. */
function centerOf(result: any): { lat: number; lng: number } | null {
  const m = result?.metadata;
  if (!m || typeof m !== "object") return null;
  const lat = Number(m.lat ?? m.latitude);
  const lng = Number(m.lng ?? m.lon ?? m.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
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

// ── Schema fidelity of the emitters themselves ────────────────────────────────

describe("discovery search — emitter SELECTs and filters name only real schema", () => {
  it("every column in every emitter SELECT exists in the live schema", async () => {
    setup({
      profiles: [profileRow({ home_city: "Cebu", home_country: "Philippines" })],
      events: [eventRow()],
      hidden_gems: [gemRow()],
      discovery_places: [placeRow(), activityRow()],
      canonical_locations: [{
        id: CANON_CITY_ID, kind: "city", normalized_name: "cebu",
        name: "Cebu", display_name: "Cebu, PH", lat: CITY_LAT, lng: CITY_LNG,
      }],
    });
    const r = await get("/discovery/search?q=cebu&type=all");
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

  it("never filters hidden_gems.status or events.state on a literal the enum lacks", async () => {
    setup({ hidden_gems: [gemRow()], events: [eventRow()] });
    await get("/discovery/search?q=cebu&type=hidden_gems");
    const gemStatuses = recorded.filterValues.get("hidden_gems.status");
    assert.ok(gemStatuses && gemStatuses.size > 0, "no hidden_gems.status filter recorded");
    for (const v of gemStatuses!) {
      assert.ok(
        REAL_ENUM_LABELS["hidden_gems.status"]!.has(v),
        `hidden_gems.status filter uses "${v}", which Postgres rejects with 22P02 — ` +
        "the whole emitter would error and return []",
      );
    }

    setup({ hidden_gems: [gemRow()], events: [eventRow()] });
    await get("/discovery/search?q=cebu&type=events");
    const eventStates = recorded.filterValues.get("events.state");
    assert.ok(eventStates && eventStates.size > 0, "no events.state filter recorded");
    for (const v of eventStates!) {
      assert.ok(
        REAL_ENUM_LABELS["events.state"]!.has(v),
        `events.state filter uses "${v}", which Postgres rejects with 22P02`,
      );
    }
  });

  it("GEM_SEARCHABLE_STATUSES holds only real hidden_gem_status labels", () => {
    assert.ok(GEM_SEARCHABLE_STATUSES.length > 0, "an empty status filter would match nothing");
    for (const s of GEM_SEARCHABLE_STATUSES) {
      assert.ok(REAL_ENUM_LABELS["hidden_gems.status"]!.has(s), `"${s}" is not a real label`);
    }
  });

  it("does not SELECT the exact hidden-gem coordinates at all", async () => {
    setup({ hidden_gems: [gemRow()] });
    await get("/discovery/search?q=cebu&type=hidden_gems");
    const lists = recorded.selects.get("hidden_gems");
    assert.ok(lists && lists.size > 0, "no hidden_gems SELECT recorded");
    for (const list of lists!) {
      const cols = list.split(",").map((c) => c.trim());
      assert.ok(!cols.includes("latitude"), "hidden_gems.latitude must never enter this process");
      assert.ok(!cols.includes("longitude"), "hidden_gems.longitude must never enter this process");
    }
  });
});

// ── §24: hidden gems carry the approximate pair, or nothing ───────────────────

describe("discovery search — §24 hidden gem coordinate floor", () => {
  it("emits the APPROXIMATE pair and never the exact one", async () => {
    setup({ profiles: [profileRow()], hidden_gems: [gemRow()] });
    const r = await get("/discovery/search?q=cebu&type=hidden_gems");
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.results.length, 1);

    const gem = body.results[0];
    assert.deepEqual(centerOf(gem), { lat: GEM_APPROX_LAT, lng: GEM_APPROX_LNG });
    assert.equal(gem.metadata.coordsPrecision, "approximate");

    // The whole response, not just the field we happen to read: an exact
    // coordinate smuggled through any other key still fails here.
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes(String(GEM_EXACT_LAT)), "exact latitude leaked onto the wire");
    assert.ok(!wire.includes(String(GEM_EXACT_LNG)), "exact longitude leaked onto the wire");
  });

  it("emits no position for a protected gem, even though it has an approximate pair", async () => {
    setup({
      profiles: [profileRow()],
      hidden_gems: [gemRow({ sensitivity_level: "protected" })],
    });
    const r = await get("/discovery/search?q=cebu&type=hidden_gems");
    const body = await r.json() as any;
    assert.equal(body.results.length, 1, "a protected gem still LISTS — it is only unplaceable");

    const gem = body.results[0];
    assert.equal(centerOf(gem), null);
    assert.equal(gem.metadata.lat, null);
    assert.equal(gem.metadata.lng, null);
    assert.equal(gem.metadata.coordsPrecision, "hidden");

    const wire = JSON.stringify(body);
    assert.ok(!wire.includes(String(GEM_APPROX_LAT)), "approximate latitude leaked for a protected gem");
    assert.ok(!wire.includes(String(GEM_EXACT_LAT)), "exact latitude leaked for a protected gem");
  });

  it("emits the approximate centroid for every non-protected sensitivity", async () => {
    for (const level of ["public", "approximate", "reveal_after_save", "reveal_after_acceptance"]) {
      _resetRateLimit();
      setup({
        profiles: [profileRow()],
        hidden_gems: [gemRow({ sensitivity_level: level })],
      });
      const body = await (await get("/discovery/search?q=cebu&type=hidden_gems")).json() as any;
      assert.deepEqual(
        centerOf(body.results[0]), { lat: GEM_APPROX_LAT, lng: GEM_APPROX_LNG },
        `sensitivity "${level}" should place at the approximate centroid`,
      );
      assert.ok(
        !JSON.stringify(body).includes(String(GEM_EXACT_LAT)),
        `sensitivity "${level}" leaked the exact pair`,
      );
    }
  });

  it("fails closed on an unrecognised or missing sensitivity", () => {
    for (const level of [undefined, null, "", "brand_new_level", "PUBLIC"]) {
      const pos = gemSearchPosition({
        sensitivity_level: level as any,
        approx_latitude: GEM_APPROX_LAT,
        approx_longitude: GEM_APPROX_LNG,
      });
      assert.deepEqual(
        pos, { lat: null, lng: null, coordsPrecision: "hidden" },
        `sensitivity ${JSON.stringify(level)} must not place`,
      );
    }
  });

  it("emits nothing rather than half a pin when only one approximate half exists", () => {
    assert.equal(gemSearchPosition({
      sensitivity_level: "public", approx_latitude: GEM_APPROX_LAT, approx_longitude: null,
    }).lat, null);
    assert.equal(gemSearchPosition({
      sensitivity_level: "public", approx_latitude: null, approx_longitude: GEM_APPROX_LNG,
    }).lng, null);
  });

  /**
   * The floor is DERIVED from HiddenGemPrivacyGuard.resolveGemCoords, so it must
   * not drift from it. With both pairs present, the two agree exactly on
   * "may this gem be placed at all" for a non-owner viewer with no save row and
   * no trip binding — which is every viewer reaching this endpoint.
   */
  it("agrees with resolveGemCoords about which gems may be placed", async () => {
    const levels: SensitivityLevel[] = [
      "public", "approximate", "reveal_after_save", "reveal_after_acceptance", "protected",
    ];
    for (const level of levels) {
      const raw = {
        id: GEM_ID,
        sensitivity_level: level,
        latitude: GEM_EXACT_LAT,
        longitude: GEM_EXACT_LNG,
        approx_latitude: GEM_APPROX_LAT,
        approx_longitude: GEM_APPROX_LNG,
      };
      const guard = await resolveGemCoords(raw, null, ME, ALICE, null);
      const search = gemSearchPosition(raw);
      assert.equal(
        search.lat !== null, guard.lat !== null,
        `"${level}": search placement disagrees with the guard`,
      );
      if (search.lat !== null) {
        assert.equal(search.lat, GEM_APPROX_LAT, `"${level}": search must use the approximate pair`);
        assert.notEqual(search.lat, GEM_EXACT_LAT, `"${level}": search returned the exact pair`);
        assert.notEqual(
          search.coordsPrecision as string, "exact",
          `"${level}": this surface has no "exact" precision to report`,
        );
      }
    }
  });

  it("declines to place a gem whose sensitivity allows it but whose centroid was never computed", () => {
    // The deliberate divergence from the guard: for a `public` gem the guard
    // returns the EXACT pair, and this endpoint has no exact pair to fall back
    // to by construction. An ungeocoded gem is unplaceable here rather than
    // pinpointed — see §24. (Every gem in production carries both pairs, so
    // this is a guard against future rows, not a live gap.)
    assert.deepEqual(
      gemSearchPosition({
        sensitivity_level: "public", approx_latitude: null, approx_longitude: null,
      }),
      { lat: null, lng: null, coordsPrecision: "hidden" },
    );
  });
});

// ── §24: event venue disclosure ───────────────────────────────────────────────

describe("discovery search — §24 event venue disclosure", () => {
  it("carries the venue when the host opted in to showing it", async () => {
    setup({ profiles: [profileRow()], events: [eventRow({ show_exact_location: true })] });
    const body = await (await get("/discovery/search?q=cebu&type=events")).json() as any;
    assert.equal(body.results.length, 1);
    assert.deepEqual(centerOf(body.results[0]), { lat: EVENT_LAT, lng: EVENT_LNG });
  });

  it("withholds the venue from a stranger when show_exact_location is false", async () => {
    setup({ profiles: [profileRow()], events: [eventRow({ show_exact_location: false })] });
    const body = await (await get("/discovery/search?q=cebu&type=events")).json() as any;
    assert.equal(body.results.length, 1, "the event still lists");
    assert.equal(centerOf(body.results[0]), null);
    assert.ok(
      !JSON.stringify(body).includes(String(EVENT_LAT)),
      "a hidden venue's latitude reached the wire",
    );
  });

  it("discloses the venue to a going RSVP, matching toAuthorizedEventView", async () => {
    setup({
      profiles: [profileRow()],
      events: [eventRow({ show_exact_location: false })],
      event_rsvps: [{ event_id: EVT_ID, user_id: ME, status: "going" }],
    });
    const body = await (await get("/discovery/search?q=cebu&type=events")).json() as any;
    assert.deepEqual(centerOf(body.results[0]), { lat: EVENT_LAT, lng: EVENT_LNG });
  });

  it("discloses the venue to the host", async () => {
    setup({
      profiles: [profileRow({ id: ME })],
      events: [eventRow({ host_id: ME, show_exact_location: false })],
    });
    const body = await (await get("/discovery/search?q=cebu&type=events")).json() as any;
    assert.deepEqual(centerOf(body.results[0]), { lat: EVENT_LAT, lng: EVENT_LNG });
  });
});

// ── Per-type placement ────────────────────────────────────────────────────────

describe("discovery search — per-type positions", () => {
  it("places an activity from the same discovery_places columns places uses", async () => {
    setup({ discovery_places: [placeRow(), activityRow()] });

    const acts = await (await get("/discovery/search?q=cebu&type=activities")).json() as any;
    assert.equal(acts.results.length, 1);
    assert.deepEqual(centerOf(acts.results[0]), { lat: ACTIVITY_LAT, lng: ACTIVITY_LNG });

    _resetRateLimit();
    const places = await (await get("/discovery/search?q=cebu&type=places")).json() as any;
    const found = (places.results as any[]).find((p) => p.id === PLACE_ID);
    assert.deepEqual(centerOf(found), { lat: PLACE_LAT, lng: PLACE_LNG });
  });

  it("places a city at its canonical registry centroid", async () => {
    setup({
      profiles: [profileRow({ home_city: "Cebu", home_country: "Philippines" })],
      canonical_locations: [{
        id: CANON_CITY_ID, kind: "city", normalized_name: "cebu",
        name: "Cebu", display_name: "Cebu, PH", lat: CITY_LAT, lng: CITY_LNG,
      }],
    });
    const body = await (await get("/discovery/search?q=cebu&type=cities")).json() as any;
    assert.equal(body.results.length, 1);
    assert.deepEqual(centerOf(body.results[0]), { lat: CITY_LAT, lng: CITY_LNG });
    assert.equal(body.results[0].metadata.canonicalId, CANON_CITY_ID);
  });

  it("places a country at its canonical registry centroid", async () => {
    setup({
      profiles: [profileRow({ home_country: "Philippines" })],
      canonical_locations: [{
        id: CANON_COUNTRY_ID, kind: "country", normalized_name: "philippines",
        name: "Philippines", display_name: "Philippines",
        lat: COUNTRY_LAT, lng: COUNTRY_LNG,
      }],
    });
    const body = await (await get("/discovery/search?q=philippines&type=countries")).json() as any;
    assert.equal(body.results.length, 1);
    assert.deepEqual(centerOf(body.results[0]), { lat: COUNTRY_LAT, lng: COUNTRY_LNG });
    assert.equal(body.results[0].metadata.canonicalId, CANON_COUNTRY_ID);
  });

  it("does not borrow a city centroid for a country of the same name", async () => {
    setup({
      profiles: [profileRow({ home_country: "Philippines" })],
      canonical_locations: [{
        id: CANON_CITY_ID, kind: "city", normalized_name: "philippines",
        name: "Philippines", display_name: "Philippines City",
        lat: CITY_LAT, lng: CITY_LNG,
      }],
    });
    const body = await (await get("/discovery/search?q=philippines&type=countries")).json() as any;
    assert.equal(body.results.length, 1);
    assert.equal(centerOf(body.results[0]), null, "a city row must not stand in for a country");
  });

  it("emits an explicit null position when the registry has no row (today's countries)", async () => {
    setup({ profiles: [profileRow({ home_country: "Philippines" })], canonical_locations: [] });
    const body = await (await get("/discovery/search?q=philippines&type=countries")).json() as any;
    const meta = body.results[0].metadata;
    assert.ok(meta !== null, "metadata must be a bag with null coordinates, not null itself");
    assert.equal(meta.lat, null);
    assert.equal(meta.lng, null);
    assert.ok(!("canonicalId" in meta), "canonicalId appears only when a registry row supplied the point");
  });

  it("skips a registry row that has never been geocoded rather than emitting half a pin", async () => {
    setup({
      profiles: [profileRow({ home_city: "Cebu" })],
      canonical_locations: [{
        id: CANON_CITY_ID, kind: "city", normalized_name: "cebu",
        name: "Cebu", display_name: "Cebu", lat: CITY_LAT, lng: null,
      }],
    });
    const body = await (await get("/discovery/search?q=cebu&type=cities")).json() as any;
    assert.equal(centerOf(body.results[0]), null);
    assert.equal(body.results[0].metadata.lat, null);
  });
});

// ── The asymmetry: recognised type, unusable payload ──────────────────────────
//
// This is the test that catches the CLASS. The client adapter maps a server
// `type` to a map type, and four of its map branches return null unless the
// result carries a center — so for those types "recognised" and "placeable" are
// different things, and the gap between them is invisible from either side.

/**
 * Map types whose `toMapSearchResult` branch DROPS a result that has no center.
 * (searchAdapter.ts: 'place', 'event' and 'hidden_gem' return null without one;
 * 'area' without bounds degrades to a point and returns null without one.)
 */
const MAP_TYPES_REQUIRING_A_POSITION = new Set(["place", "event", "hidden_gem", "area"]);

/** The server types this suite drives, and the query that produces one of each. */
const PLACEABLE_TYPE_QUERIES: Record<string, string> = {
  places: "/discovery/search?q=cebu&type=places",
  activities: "/discovery/search?q=cebu&type=activities",
  events: "/discovery/search?q=cebu&type=events",
  hidden_gems: "/discovery/search?q=cebu&type=hidden_gems",
  cities: "/discovery/search?q=cebu&type=cities",
  countries: "/discovery/search?q=philippines&type=countries",
};

/** Parse the client adapter's wire table — the half above its "Tolerated aliases" note. */
function clientWireTypeTable(): Record<string, string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const adapter = path.resolve(
    here, "../../../../travel-buddy-standalone/src/features/map/search/searchAdapter.ts",
  );
  const src = readFileSync(adapter, "utf8");
  const start = src.indexOf("export const SERVER_TYPE_TO_MAP_TYPE");
  assert.ok(start >= 0, `SERVER_TYPE_TO_MAP_TYPE not found in ${adapter}`);
  const aliases = src.indexOf("Tolerated aliases", start);
  const end = aliases >= 0 ? aliases : src.indexOf("};", start);
  const wire = src.slice(start, end);
  const table: Record<string, string> = {};
  for (const m of wire.matchAll(/^\s{2}(\w+):\s*'(\w+)',/gm)) table[m[1]!] = m[2]!;
  return table;
}

describe("discovery search — every map-placeable type carries a position", () => {
  it("covers exactly the server types the client map can place", () => {
    const table = clientWireTypeTable();
    assert.ok(
      Object.keys(table).length >= 8,
      `parsed only ${Object.keys(table).length} wire types from the client adapter — the parse broke`,
    );
    const needsPosition = Object.entries(table)
      .filter(([, mapType]) => MAP_TYPES_REQUIRING_A_POSITION.has(mapType))
      .map(([serverType]) => serverType)
      .sort();
    assert.deepEqual(
      needsPosition, Object.keys(PLACEABLE_TYPE_QUERIES).sort(),
      "the client's set of position-requiring search types drifted from what this suite drives",
    );
  });

  it("returns a usable position for every one of them", async () => {
    const missing: string[] = [];
    for (const [type, query] of Object.entries(PLACEABLE_TYPE_QUERIES)) {
      _resetRateLimit();
      setup({
        profiles: [profileRow({ home_city: "Cebu", home_country: "Philippines" })],
        events: [eventRow()],
        hidden_gems: [gemRow()],
        discovery_places: [placeRow(), activityRow()],
        canonical_locations: [
          {
            id: CANON_CITY_ID, kind: "city", normalized_name: "cebu",
            name: "Cebu", display_name: "Cebu, PH", lat: CITY_LAT, lng: CITY_LNG,
          },
          {
            id: CANON_COUNTRY_ID, kind: "country", normalized_name: "philippines",
            name: "Philippines", display_name: "Philippines",
            lat: COUNTRY_LAT, lng: COUNTRY_LNG,
          },
        ],
      });
      const r = await get(query);
      assert.equal(r.status, 200, `${type}: HTTP ${r.status}`);
      const body = await r.json() as any;
      if (body.results.length === 0) { missing.push(`${type} (returned no results at all)`); continue; }
      if (centerOf(body.results[0]) === null) missing.push(`${type} (result carries no position)`);
    }
    assert.deepEqual(
      missing, [],
      "these types are recognised by the map but emit nothing it can place: " + missing.join(", "),
    );
  });

  it("declares metadata.lat/lng as keys for every placeable type, present or null", async () => {
    // A missing key and a null value are the same to the adapter, but not to a
    // reader: an explicit null says "no position for this row", while an absent
    // key says nothing and is how five emitters went unnoticed.
    for (const [type, query] of Object.entries(PLACEABLE_TYPE_QUERIES)) {
      _resetRateLimit();
      setup({
        profiles: [profileRow({ home_city: "Cebu", home_country: "Philippines" })],
        events: [eventRow({ location_lat: null, location_lng: null })],
        hidden_gems: [gemRow({ approx_latitude: null, approx_longitude: null })],
        discovery_places: [placeRow({ lat: null, lng: null }), activityRow({ lat: null, lng: null })],
        canonical_locations: [],
      });
      const body = await (await get(query)).json() as any;
      assert.ok(body.results.length > 0, `${type}: fixture produced no row to inspect`);
      const meta = body.results[0].metadata;
      assert.ok(meta && typeof meta === "object", `${type}: metadata must be an object`);
      assert.ok("lat" in meta, `${type}: metadata has no "lat" key`);
      assert.ok("lng" in meta, `${type}: metadata has no "lng" key`);
      assert.equal(meta.lat, null, `${type}: expected a null position for a positionless row`);
      assert.equal(meta.lng, null, `${type}: expected a null position for a positionless row`);
    }
  });
});

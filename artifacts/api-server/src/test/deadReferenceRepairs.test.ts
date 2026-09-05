/**
 * BEHAVIOURAL proof for the dead schema-reference repairs — driven by a double
 * that fails the way PostgREST fails.
 *
 * WHY THIS EXISTS SEPARATELY FROM schemaReferenceStatic.test.ts
 * -------------------------------------------------------------
 * That contract is STATIC: it proves no query in `src/` names a column its table
 * does not declare, and it goes red if any repair below is reverted. What it
 * cannot show is the CONSEQUENCE — that the feature returned nothing, and does
 * not any more.
 *
 * No existing suite could show that, for the reason `helpers/columnAwareSupabase`
 * exists: the repo's fake clients ignore the select list and store any write
 * payload, so a dead column name simply never surfaced and the fixture answered
 * as if the query had worked. Two of these suites were measured GREEN with the
 * dead reference in place AND green after the repair — load-bearing on a fiction
 * either way. `compass-ux.test.ts` asserts a visibility cooldown row exists after
 * a severe abuse ring; that assertion passed for months while the real UPSERT was
 * rejected outright, because the double stored `updated_at` on a table that has
 * no such column.
 *
 * With a double that validates column names, each test below goes RED for the
 * reason production was broken: the statement fails whole and the surface has
 * nothing.
 *
 * Each test asserts BOTH halves where a filter is involved — the repaired query
 * returns the row AND excludes what it should — so a "fix" that dropped the
 * predicate would not pass either.
 *
 * Run: node --import tsx/esm --test src/test/deadReferenceRepairs.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeColumnAwareClient, schema, selectedColumns } from "./helpers/columnAwareSupabase.js";
import { runCollectionsTick } from "../lib/places/placeCollectionsWorker.js";
import { runScan } from "../compass/CompassAbuseDefenseEngine.js";
import { getDecayConfig } from "../compass/CompassSearchDecayService.js";
import { buildStructuredCompassContext, formatStructuredContextLines } from "../compass/CompassStructuredContext.js";
import { buildSharedMoments } from "../compass/PassportRemembersService.js";

const ME = "11111111-1111-1111-1111-111111111111";
const BUDDY = "22222222-2222-2222-2222-222222222222";

// ── 0. The double itself ──────────────────────────────────────────────────────

describe("the double itself is not vacuous", () => {
  it("fails the WHOLE read on a select-list column the table does not have", async () => {
    const sc = makeColumnAwareClient({ places: [{ id: "p1", name: "Cafe", country_code: "VN" }] });
    const { data, error } = await sc.from("places").select("id, name, country");
    assert.equal(data, null, "an unknown select-list column must not return rows");
    assert.equal((error as any)?.code, "PGRST100");
    // Returned, never thrown — which is why a surrounding try/catch never fired
    // on any of the eleven production sites.
    assert.match((error as any)?.message ?? "", /places\.country does not exist/);
  });

  it("rejects a WRITE naming a column the table does not have, and records nothing", async () => {
    const writes: Record<string, any[]> = {};
    const sc = makeColumnAwareClient({}, { writes });
    const { error } = await sc.from("compass_visibility_cooldowns").upsert({
      author_id: ME, cooldown_type: "reach_reduction", updated_at: null,
    });
    assert.equal((error as any)?.code, "PGRST204");
    // Even with a NULL value: that is what made a stray `updated_at` enough to
    // lose an abuse cooldown entirely.
    assert.equal(writes["compass_visibility_cooldowns"], undefined);
  });

  it("accepts every real column, so a passing test below is not passing by accident", async () => {
    const sc = makeColumnAwareClient({ places: [{ id: "p1", name: "Cafe", country_code: "VN" }] });
    const { data, error } = await sc.from("places").select("id, name, country_code");
    assert.equal(error, null);
    assert.equal((data as any[]).length, 1);
  });

  it("declines to judge a table the canonical model could not build", async () => {
    const sc = makeColumnAwareClient({ not_a_real_table_xyz: [{ id: "1" }] });
    const { data, error } = await sc.from("not_a_real_table_xyz").select("id, whatever");
    assert.equal(error, null, "over-flagging an unmodelled table would block unrelated work");
    assert.equal((data as any[]).length, 1);
  });

  it("does not judge embedded resources or aliases as bare columns", () => {
    assert.deepEqual(selectedColumns("title_override, city, stamp_definitions(name)"), []);
    assert.deepEqual(selectedColumns("id, alias:country_code"), ["id", "country_code"]);
  });
});

// ── 1. placeCollectionsWorker — posts.view_count / qualified_view_count ───────

describe("place best-of ranking runs at all", () => {
  const QUEUED_AT = "2026-09-01T00:00:00.000Z";

  function queueFixture(): Record<string, any[]> {
    return {
      place_cache_invalidation_queue: [
        { place_id: "place-1", queued_at: QUEUED_AT, status: "pending", locked_until: null, locked_by: null },
      ],
      posts: [{
        id: "post-1", author_id: ME, trip_id: null, visibility: "public",
        post_status: "published", content: "Great cafe", media_type: "image",
        media_urls: ["https://example.test/a.jpg"], media_thumbnail_url: null,
        post_buckets: [], like_count: 10, save_count: 4, share_count: 1,
        canonical_place_id: "place-1", status: "active",
      }],
      place_best_of: [],
      place_contributors: [],
    };
  }

  it("processes a queued place instead of erroring on the posts read", async () => {
    const writes: Record<string, any[]> = {};
    const res = await runCollectionsTick(makeColumnAwareClient(queueFixture(), { writes }));

    // The whole worker was dead: `posts` has neither `view_count` nor
    // `qualified_view_count` — the only view record in the schema is
    // `post_impressions`, which nothing aggregates onto `posts` — so naming them
    // failed the read PGRST100 and processPlace threw for EVERY place.
    assert.equal(res.errors, 0, "the posts read must not fail");
    assert.equal(res.processed, 1, "the claimed place must be processed");
    assert.ok((writes["place_best_of"] ?? []).length > 0, "best-of must actually be written");
  });

  it("neither view column is declared by the schema, so neither may be selected", () => {
    const posts = schema().columns.get("posts")!;
    for (const c of ["view_count", "qualified_view_count"]) {
      assert.ok(!posts.has(c), `posts.${c} is declared — this repair's premise changed`);
    }
    // …and the columns the read DOES name are all real.
    for (const c of ["like_count", "save_count", "share_count", "post_buckets"]) {
      assert.ok(posts.has(c), `posts.${c} should exist`);
    }
  });
});

// ── 2. CompassAbuseDefenseEngine — compass_visibility_cooldowns.updated_at ────

describe("abuse-defense reach reduction is actually recorded", () => {
  it("writes a visibility cooldown for a severe review ring", async () => {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const users = ["u1", "u2", "u3", "u4", "u5"];
    const reviews: Record<string, unknown>[] = [];
    for (const a of users) for (const b of users) {
      if (a !== b) reviews.push({ reviewer_id: a, reviewee_id: b, rating: 5, created_at: since });
    }
    const writes: Record<string, any[]> = {};
    const sc = makeColumnAwareClient({ rent_buddy_reviews: reviews }, { writes });

    await runScan(sc, null);

    const cooldowns = writes["compass_visibility_cooldowns"] ?? [];
    assert.ok(cooldowns.length > 0,
      "no cooldown recorded — the UPSERT named a column the table does not have, " +
        "so the reach reduction this detector exists to apply never happened");
    // The window must restart with the new ends_at rather than claiming to have
    // begun before the escalation that reset it.
    assert.ok(cooldowns[0]!["started_at"], "started_at must be set on re-application");
    assert.ok(cooldowns[0]!["ends_at"], "ends_at must be set");
    assert.equal(cooldowns[0]!["cooldown_type"], "reach_reduction");
  });
});

// ── 3. CompassSearchDecayService — feature_flags.numeric_value ────────────────

describe("the search-decay service can read its own flag", () => {
  it("returns the configured half-life from feature_flags.metadata", async () => {
    const sc = makeColumnAwareClient({
      feature_flags: [{
        flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: true, metadata: { numeric_value: 45 },
      }],
    });
    // Dead as written: feature_flags is (flag, enabled, description, updated_at,
    // metadata) — naming a numeric column failed the read, `data` came back null
    // on every call, and BOTH the enabled bit and the half-life silently fell
    // through to their defaults.
    assert.deepEqual(await getDecayConfig(sc), { enabled: true, halfLifeDays: 45 });
  });

  it("still reports a disabled flag as disabled", async () => {
    const sc = makeColumnAwareClient({
      feature_flags: [{
        flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: false, metadata: { numeric_value: 45 },
      }],
    });
    const cfg = await getDecayConfig(sc);
    assert.equal(cfg.enabled, false, "a fix that ignored the row would read `enabled` wrong too");
    assert.equal(cfg.halfLifeDays, 45);
  });

  it("falls back to the default when metadata carries no usable number", async () => {
    const sc = makeColumnAwareClient({
      feature_flags: [{ flag: "SEARCH_SIGNAL_DECAY_DAYS", enabled: true, metadata: {} }],
    });
    const cfg = await getDecayConfig(sc);
    assert.ok(cfg.halfLifeDays > 0);
    assert.notEqual(cfg.halfLifeDays, 45);
  });
});

// ── 4. CompassStructuredContext — rent_buddy_bookings.date_from / date_to ─────

describe("Compass chat gets booking context", () => {
  const profile = () => ({
    userId: ME, blockedUserIds: [], mutedUserIds: [],
  }) as any;

  function tables(): Record<string, any[]> {
    return {
      circles: [],
      circle_memberships: [],
      rent_buddy_bookings: [{
        traveler_id: ME, buddy_id: BUDDY, city: "Cebu City",
        booking_date: "2026-07-22", start_time: "14:00", duration_h: 3,
        status: "confirmed", notes: "SECRET hotel room 402",
      }],
      profiles: [{ id: BUDDY, handle: "localbuddy" }],
      user_stamps: [],
    };
  }

  it("surfaces the booking with its real date, start time and duration", async () => {
    // A Rent-a-Buddy booking is a single-day appointment: (booking_date,
    // start_time, duration_h). `date_from`/`date_to` are columns the table has
    // never had, so this read failed whole and activeBookings was ALWAYS [].
    const ctx = await buildStructuredCompassContext(makeColumnAwareClient(tables()), profile());
    assert.equal(ctx.activeBookings.length, 1);
    const b = ctx.activeBookings[0]!;
    assert.equal(b.city, "Cebu City");
    assert.equal(b.date, "2026-07-22");
    assert.equal(b.startTime, "14:00");
    assert.equal(b.durationHours, 3);
    assert.equal(b.status, "confirmed");
    assert.equal(b.buddyHandle, "@localbuddy");

    const line = formatStructuredContextLines(ctx).find((l) => l.includes("Cebu City"));
    assert.ok(line, "the booking must reach the rendered context");
    assert.match(line!, /2026-07-22 14:00 \(3h\)/);
  });

  it("still excludes a cancelled booking, so the status filter is load-bearing", async () => {
    const t = tables();
    t["rent_buddy_bookings"]![0]!["status"] = "cancelled";
    const ctx = await buildStructuredCompassContext(makeColumnAwareClient(t), profile());
    assert.equal(ctx.activeBookings.length, 0);
  });

  it("never carries the private note into chat context", async () => {
    const ctx = await buildStructuredCompassContext(makeColumnAwareClient(tables()), profile());
    assert.ok(!JSON.stringify(ctx).includes("SECRET"), "booking notes must never be included");
  });
});

// ── 5. PassportRemembersService — shared_moments.visibility ───────────────────

describe("Passport 'What Portava Remembers' surfaces Shared Moments", () => {
  function tables(): Record<string, any[]> {
    return {
      shared_moment_memberships: [
        { user_id: ME, moment_id: "m-yes", status: "accepted" },
        { user_id: ME, moment_id: "m-invited", status: "invited" },
        { user_id: ME, moment_id: "m-archived", status: "accepted" },
      ],
      shared_moments: [
        { id: "m-yes", title: "Dinner in Da Nang", status: "active", join_policy: "invite_only", archived_at: null, created_at: "2026-05-01T00:00:00Z" },
        { id: "m-invited", title: "Should not appear", status: "active", join_policy: "invite_only", archived_at: null, created_at: "2026-05-01T00:00:00Z" },
        { id: "m-archived", title: "Old moment", status: "archived", join_policy: "invite_only", archived_at: "2026-06-01T00:00:00Z", created_at: "2026-04-01T00:00:00Z" },
      ],
    };
  }

  it("returns the consented, active moment", async () => {
    // shared_moments has no `visibility` column — its access model is membership
    // plus `join_policy`. Naming it failed the read, so this whole group of §12's
    // "everything Portava remembers" was silently absent.
    const items = await buildSharedMoments(makeColumnAwareClient(tables()), ME);
    assert.deepEqual(items.map((i) => i.title), ["Dinner in Da Nang"]);
    assert.equal(items[0]!.source.originTable, "shared_moments");
  });

  it("still omits unconsented and archived moments, so the consent gate is load-bearing", async () => {
    const items = await buildSharedMoments(makeColumnAwareClient(tables()), ME);
    const titles = items.map((i) => i.title);
    assert.ok(!titles.includes("Should not appear"), "an invited-but-not-accepted moment must not surface");
    assert.ok(!titles.includes("Old moment"), "an archived moment must not surface");
  });
});

// ── 6. seed-demo-social — passport_postcards.media_type ───────────────────────

describe("the demo seeder's postcard insert names real columns", () => {
  it("passport_postcards carries the derived media trio, not media_type", () => {
    // The seeder is a top-level script that opens a live client on import, so it
    // is proved statically: the INSERT it performs must name only columns the
    // table declares. `check:schema-references` enforces that repo-wide; this
    // pins the specific premise, so a schema change that reintroduced
    // `media_type` would surface here rather than silently re-enabling the bug.
    const cols = schema().columns.get("passport_postcards")!;
    assert.ok(!cols.has("media_type"), "passport_postcards.media_type exists — premise changed");
    for (const c of ["media_count", "has_video", "primary_media_type", "media_url"]) {
      assert.ok(cols.has(c), `passport_postcards.${c} should exist`);
    }
  });
});

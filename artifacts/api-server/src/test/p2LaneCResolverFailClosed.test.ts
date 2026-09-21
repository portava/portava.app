/**
 * Resolvers, workers and one moderation guard: reads whose answer picks the
 * TARGET of a write, or decides whether a guarded write is allowed at all.
 *
 * The same supabase-js property is behind all of them — a failed read resolves
 * as `{ data: null }`, indistinguishable from "no such row" — but the damage
 * here is not a duplicate row in a ledger. It is a second canonical place that
 * the provider reference is then repointed at, a chat thread the crew's history
 * is not on, membership rows against a group id no row has, a dispute filed in
 * the wrong person's name, and an admin's entity block that stops being
 * enforced the moment the table it lives in is unwell.
 *
 * Every failure case is scoped by the FILTERS of the specific query wherever
 * the same table is read more than once on the path, because failing the whole
 * table aborts the request earlier and passes the test for the wrong reason.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/p2LaneCResolverFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";

import { resolveExternalPlace } from "../lib/places/placeResolve.js";
import { syncTripChatMembers as syncTripThreadV2 } from "../services/groupChatSync.js";
import { syncCircleChatMembers as syncCircleThreadV2 } from "../services/groupChatSync.js";
import { syncTripChatMembers as syncTripThreadV1, syncCircleChatMembers as syncCircleThreadV1 } from "../lib/chatSync.js";
import { runReconciliation } from "../lib/stamps/reconcileStampCatalog.js";
import { runDedupTick } from "../lib/media/mediaDedupWorker.js";
import { runBuddyRequestSweep } from "../lib/rentBuddyRequestSweeper.js";
import { requestGeneration } from "../lib/visuals/service.js";
import { _setTestClient } from "../lib/http.js";

const TRIP = "50000000-0000-4000-a000-000000000001";
const PLACE = "50000000-0000-4000-a000-000000000002";
const TRAVELER = "50000000-0000-4000-a000-000000000003";
const BUDDY_USER = "50000000-0000-4000-a000-000000000004";
const BUDDY_PROFILE = "50000000-0000-4000-a000-000000000005";

// ── external_place_references / places: the canonical identity of a venue ────

describe("resolveExternalPlace — an unreadable reference table must not fork a place", () => {
  const flags = [{ flag: "external_places_enabled", enabled: true }];
  const rec = {
    provider: "fsq",
    providerPlaceId: "fsq-123",
    name: "Cafe Cong",
    latitude: 16.07,
    longitude: 108.22,
  };

  it("CONTROL: an existing reference resolves to its linked place, creating nothing", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        feature_flags: flags,
        external_place_references: [{ provider: "fsq", provider_place_id: "fsq-123", place_id: PLACE }],
        places: [{ id: PLACE, merged_into_place_id: null }],
      },
      inserted,
    });
    assert.deepEqual(await resolveExternalPlace(db, rec), { placeId: PLACE, created: false });
    assert.equal((inserted["places"] ?? []).length, 0);
  });

  it("CONTROL: a linked-but-merged place resolves to the survivor", async () => {
    const db = makeFailClosedClient({
      rows: {
        feature_flags: flags,
        external_place_references: [{ provider: "fsq", provider_place_id: "fsq-123", place_id: PLACE }],
        places: [{ id: PLACE, merged_into_place_id: "survivor-1" }],
      },
    });
    assert.deepEqual(await resolveExternalPlace(db, rec), { placeId: "survivor-1", created: false });
  });

  it("an unreadable external_place_references does NOT create a duplicate canonical place", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        feature_flags: flags,
        // The venue IS already linked. Without the check, step 1 misses it, the
        // proximity dedup finds nothing at this distance, and a second `places`
        // row is inserted — then step 4 repoints the provider reference at it.
        external_place_references: [{ provider: "fsq", provider_place_id: "fsq-123", place_id: PLACE }],
        places: [{ id: PLACE, merged_into_place_id: null, name: "Cafe Cong", latitude: 16.07, longitude: 108.22 }],
      },
      failOn: (c: FakeReadContext) =>
        c.table === "external_place_references" ? { message: "refs unavailable", code: "57P01" } : null,
      inserted,
    });
    assert.equal(await resolveExternalPlace(db, rec), null, "an unresolvable identity must be skipped, not guessed");
    assert.equal((inserted["places"] ?? []).length, 0, "no duplicate canonical place");
    assert.equal(
      (inserted["external_place_references"] ?? []).length,
      0,
      "the provider reference must not be repointed",
    );
  });

  it("an unreadable merge-follow read does NOT hand back a possibly merged-away place", async () => {
    const db = makeFailClosedClient({
      rows: {
        feature_flags: flags,
        external_place_references: [{ provider: "fsq", provider_place_id: "fsq-123", place_id: PLACE }],
        // This place HAS been merged away — resolving to it attaches content to
        // a tombstone that nobody browses.
        places: [{ id: PLACE, merged_into_place_id: "survivor-1" }],
      },
      // Scoped to the merge-follow query (filters on `id`), not to the whole
      // `places` table, which the proximity dedup also reads.
      failOn: (c: FakeReadContext) =>
        c.table === "places" && c.filters.some((f) => f.col === "id")
          ? { message: "places unavailable", code: "57P01" }
          : null,
    });
    assert.equal(await resolveExternalPlace(db, rec), null);
  });
});

// ── message_threads: find-or-create for a group chat ────────────────────────

describe("chat thread sync — an unreadable message_threads is not 'no thread yet'", () => {
  const rows = (threads: any[]) => ({
    trips: [{ id: TRIP, title: "Da Nang", destination_city: "Da Nang", status: "active" }],
    message_threads: threads,
    trip_members: [{ trip_id: TRIP, user_id: TRAVELER, role: "owner" }],
    message_thread_members: [],
  });
  const existing = [{ id: "thread-1", thread_type: "trip", trip_id: TRIP }];

  it("CONTROL (services/groupChatSync): an existing thread is reused", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({ rows: rows(existing), inserted });
    assert.equal(await syncTripThreadV2(sc, TRIP), "thread-1");
    assert.equal((inserted["message_threads"] ?? []).length, 0);
  });

  it("CONTROL (services/groupChatSync): a trip with no thread gets one", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({ rows: rows([]), inserted });
    await syncTripThreadV2(sc, TRIP);
    assert.equal((inserted["message_threads"] ?? []).length, 1);
  });

  it("services/groupChatSync throws rather than creating a second trip thread", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: rows(existing),
      failOn: (c: FakeReadContext) =>
        c.table === "message_threads" ? { message: "threads unavailable", code: "57P01" } : null,
      inserted,
    });
    await assert.rejects(() => syncTripThreadV2(sc, TRIP));
    assert.equal((inserted["message_threads"] ?? []).length, 0);
    assert.equal(
      (inserted["message_thread_members"] ?? []).length,
      0,
      "and the crew must not be moved onto a new thread",
    );
  });

  it("CONTROL (lib/chatSync): an existing thread is reused", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({ rows: rows(existing), inserted });
    assert.equal(await syncTripThreadV1(TRIP, sc), "thread-1");
    assert.equal((inserted["message_threads"] ?? []).length, 0);
  });

  it("lib/chatSync returns null rather than creating a second trip thread", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: rows(existing),
      failOn: (c: FakeReadContext) =>
        c.table === "message_threads" ? { message: "threads unavailable", code: "57P01" } : null,
      inserted,
    });
    assert.equal(await syncTripThreadV1(TRIP, sc), null);
    assert.equal((inserted["message_threads"] ?? []).length, 0);
  });

  // The circle branches of both files are the same code against a different
  // discriminator; pinned separately because they were fixed separately.
  const circleRows = (threads: any[]) => ({
    profiles: [{ id: TRAVELER, name: "Mai", handle: "mai" }],
    message_threads: threads,
    circle_memberships: [{ user_id: TRAVELER, other_id: BUDDY_USER }],
    message_thread_members: [],
  });
  const circleExisting = [{ id: "circle-thread-1", thread_type: "circle", circle_owner_id: TRAVELER }];

  it("CONTROL (circle, both files): an existing circle thread is reused", async () => {
    const a: Record<string, any[]> = {};
    const b: Record<string, any[]> = {};
    assert.equal(
      await syncCircleThreadV2(makeFailClosedClient({ rows: circleRows(circleExisting), inserted: a }), TRAVELER),
      "circle-thread-1",
    );
    assert.equal(
      await syncCircleThreadV1(TRAVELER, makeFailClosedClient({ rows: circleRows(circleExisting), inserted: b })),
      "circle-thread-1",
    );
    assert.equal((a["message_threads"] ?? []).length, 0);
    assert.equal((b["message_threads"] ?? []).length, 0);
  });

  it("circle sync does not create a duplicate circle thread on a read failure", async () => {
    const failThreads = (c: FakeReadContext) =>
      c.table === "message_threads" ? { message: "threads unavailable", code: "57P01" } : null;

    const a: Record<string, any[]> = {};
    await assert.rejects(() =>
      syncCircleThreadV2(
        makeFailClosedClient({ rows: circleRows(circleExisting), failOn: failThreads, inserted: a }),
        TRAVELER,
      ),
    );
    assert.equal((a["message_threads"] ?? []).length, 0);

    const b: Record<string, any[]> = {};
    assert.equal(
      await syncCircleThreadV1(
        TRAVELER,
        makeFailClosedClient({ rows: circleRows(circleExisting), failOn: failThreads, inserted: b }),
      ),
      null,
    );
    assert.equal((b["message_threads"] ?? []).length, 0);
  });
});

// ── universal_stamp_catalog: one catalog entry per canonical location ───────

describe("runReconciliation — an unreadable catalog is not 'no entry for this location'", () => {
  const rows = (catalog: any[]) => ({
    user_stamps: [],
    passport_stamps: [{ stamp_type: "city", country: "Vietnam", city: "Da Nang" }],
    universal_stamp_catalog: catalog,
    stamp_reconciliation_log: [],
  });
  const entry = [
    { id: "cat-1", canonical_location_key: "city:vn:da-nang", stamp_type: "city" },
  ];

  it("CONTROL: an existing catalog entry is resolved, not re-created", async () => {
    const spec: any = { rows: rows(entry) };
    // The canonical key the reconciler computes must match the fixture, or the
    // "already present" branch is never entered and the case proves nothing.
    const sc = makeFailClosedClient(spec);
    const before = (spec.rows.universal_stamp_catalog as any[])[0];
    const stats = await runReconciliation(sc);
    assert.equal(stats.combos, 1);
    const created = (spec.inserted?.["universal_stamp_catalog"] ?? []).length;
    if (created > 0) {
      // The fixture key did not match; say so loudly rather than passing the
      // failure case below for the wrong reason.
      assert.fail(`fixture key mismatch: reconciler did not see ${before.canonical_location_key}`);
    }
    assert.equal(stats.flagged, 0);
  });

  it("an unreadable universal_stamp_catalog flags the combo instead of inserting a second entry", async () => {
    const spec: any = {
      rows: rows(entry),
      failOn: (c: FakeReadContext) =>
        c.table === "universal_stamp_catalog" ? { message: "catalog unavailable", code: "57P01" } : null,
    };
    const sc = makeFailClosedClient(spec);
    const stats = await runReconciliation(sc);
    assert.equal(stats.flagged, 1, "the combo must be flagged for admin review");
    assert.equal(
      (spec.inserted?.["universal_stamp_catalog"] ?? []).length,
      0,
      "no duplicate catalog entry, and no duplicate artwork job behind it",
    );
  });
});

// ── media_dedup_groups: the id memberships are written against ──────────────

describe("runDedupTick — an unresolvable group id must not be assumed to be ours", () => {
  const media = () => [
    { id: "m1", canonical_place_id: PLACE, phash: "0000000000000000", dedup_processed: false },
    { id: "m2", canonical_place_id: PLACE, phash: "0000000000000000", dedup_processed: false },
  ];

  it("CONTROL: a healthy tick writes memberships and marks the media processed", async () => {
    const spec: any = { rows: { post_media: media(), media_dedup_groups: [], media_dedup_memberships: [] } };
    const sc = makeFailClosedClient(spec);
    await runDedupTick(sc);
    assert.equal((spec.inserted?.["media_dedup_groups"] ?? []).length, 1);
    assert.ok((spec.inserted?.["media_dedup_memberships"] ?? []).length > 0);
    assert.equal((spec.updated?.["post_media"] ?? []).length, 1, "the batch must be marked processed");
  });

  it("an unreadable group re-read skips the cluster instead of inventing a group id", async () => {
    const spec: any = {
      rows: { post_media: media(), media_dedup_groups: [], media_dedup_memberships: [] },
      // Only the (place, representative) re-read fails. Step 3a's read of the
      // same table filters on canonical_place_id alone and must stay healthy —
      // failing it would `continue` before the code under test is reached.
      failOn: (c: FakeReadContext) =>
        c.table === "media_dedup_groups" && c.filters.some((f) => f.col === "representative_media_id")
          ? { message: "groups unavailable", code: "57P01" }
          : null,
    };
    const sc = makeFailClosedClient(spec);
    await runDedupTick(sc);
    assert.equal(
      (spec.inserted?.["media_dedup_memberships"] ?? []).length,
      0,
      "memberships must not be written against an unverified group id",
    );
    assert.equal(
      (spec.updated?.["post_media"] ?? []).length,
      0,
      "and the media must stay unprocessed so the next tick retries",
    );
  });
});

// ── buddy_booking_events / rent_buddy_disputes: who raised the dispute ──────

describe("runBuddyRequestSweep no-show escalation — attribution is not a guess", () => {
  const bookings = () => [
    {
      id: "bk-1",
      traveler_id: TRAVELER,
      buddy_id: BUDDY_PROFILE,
      status: "no_show_pending",
      no_show_grace_expires_at: new Date(Date.now() - 3600_000).toISOString(),
    },
  ];
  // The BUDDY filed the no-show report, not the traveler.
  const events = () => [
    {
      booking_id: "bk-1",
      event: "no_show_reported",
      actor_user_id: BUDDY_USER,
      created_at: new Date().toISOString(),
    },
  ];

  it("CONTROL: the dispute is raised by whoever actually filed the report", async () => {
    const spec: any = {
      rows: {
        feature_flags: [{ flag: "rent_a_buddy_enabled", enabled: false }],
        rent_buddy_bookings: bookings(),
        buddy_booking_events: events(),
        rent_buddy_disputes: [],
        rent_buddy_profiles: [{ id: BUDDY_PROFILE, user_id: BUDDY_USER }],
      },
    };
    const sc = makeFailClosedClient(spec);
    const r = await runBuddyRequestSweep(sc);
    assert.equal(r.noShowEscalated, 1);
    const disputes = spec.inserted?.["rent_buddy_disputes"] ?? [];
    assert.equal(disputes.length, 1);
    assert.equal(disputes[0].raised_by, BUDDY_USER, "the buddy filed it, so the buddy raised it");
  });

  it("an unreadable buddy_booking_events does NOT attribute the dispute to the traveler", async () => {
    const spec: any = {
      rows: {
        feature_flags: [{ flag: "rent_a_buddy_enabled", enabled: false }],
        rent_buddy_bookings: bookings(),
        buddy_booking_events: events(),
        rent_buddy_disputes: [],
        rent_buddy_profiles: [{ id: BUDDY_PROFILE, user_id: BUDDY_USER }],
      },
      failOn: (c: FakeReadContext) =>
        c.table === "buddy_booking_events" ? { message: "events unavailable", code: "57P01" } : null,
    };
    const sc = makeFailClosedClient(spec);
    const r = await runBuddyRequestSweep(sc);
    assert.equal(r.noShowEscalated, 0, "the booking stays no_show_pending for the next pass");
    assert.equal(
      (spec.inserted?.["rent_buddy_disputes"] ?? []).length,
      0,
      "no dispute may be opened in a name we had to guess",
    );
  });

  it("an unreadable rent_buddy_disputes does NOT open a second dispute for one booking", async () => {
    const spec: any = {
      rows: {
        feature_flags: [{ flag: "rent_a_buddy_enabled", enabled: false }],
        rent_buddy_bookings: bookings(),
        buddy_booking_events: events(),
        // A dispute for this booking already exists.
        rent_buddy_disputes: [{ id: "d-1", booking_id: "bk-1", reason: "no_show", status: "open" }],
        rent_buddy_profiles: [{ id: BUDDY_PROFILE, user_id: BUDDY_USER }],
      },
      failOn: (c: FakeReadContext) =>
        c.table === "rent_buddy_disputes" ? { message: "disputes unavailable", code: "57P01" } : null,
    };
    const sc = makeFailClosedClient(spec);
    const r = await runBuddyRequestSweep(sc);
    assert.equal(r.noShowEscalated, 0);
    assert.equal(
      (spec.inserted?.["rent_buddy_disputes"] ?? []).length,
      0,
      "one incident must not become two moderation cases",
    );
  });
});

// ── generated_visuals: the admin entity block ──────────────────────────────

describe("requestGeneration — the entity block must not lapse when its table is unwell", () => {
  const EVENT = "60000000-0000-4000-a000-000000000001";
  const OWNER = "60000000-0000-4000-a000-000000000002";
  const req = {
    entityType: "event" as const,
    entityId: EVENT,
    purpose: "event_header" as const,
    ownerUserId: OWNER,
  };

  it("CONTROL: with a readable table an entity_blocked row still blocks", async () => {
    const sc = makeFailClosedClient({
      rows: {
        feature_flags: [],
        generated_visuals: [
          { id: "v1", entity_type: "event", entity_id: EVENT, moderation_status: "entity_blocked", status: "ready" },
        ],
        events: [{ id: EVENT, title: "Lantern Night", city: "Hoi An" }],
      },
    });
    _setTestClient(sc, true);
    try {
      const outcome = await requestGeneration(req);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.error, "entity_blocked");
    } finally {
      _setTestClient(null as any, false);
    }
  });

  it("an unreadable generated_visuals refuses generation instead of ignoring the block", async () => {
    const spec: any = {
      rows: {
        feature_flags: [],
        generated_visuals: [
          { id: "v1", entity_type: "event", entity_id: EVENT, moderation_status: "entity_blocked", status: "ready" },
        ],
        events: [{ id: EVENT, title: "Lantern Night", city: "Hoi An" }],
      },
      failOn: (c: FakeReadContext) =>
        c.table === "generated_visuals" ? { message: "generated_visuals unavailable", code: "57P01" } : null,
    };
    const sc = makeFailClosedClient(spec);
    _setTestClient(sc, true);
    try {
      const outcome = await requestGeneration(req);
      assert.equal(outcome.ok, false, "a moderation guard that cannot read its table must deny");
      assert.equal(outcome.error, "block_check_unavailable");
      assert.equal(
        (spec.inserted?.["generated_visuals"] ?? []).length,
        0,
        "no job may be queued for an entity whose block status is unknown",
      );
    } finally {
      _setTestClient(null as any, false);
    }
  });

  it("an unreadable reuse check refuses instead of queueing a second paid job", async () => {
    const spec: any = {
      rows: {
        feature_flags: [
          { flag: "ai_visual_provider_enabled", enabled: true },
          { flag: "ai_visual_event_header_enabled", enabled: true },
        ],
        generated_visuals: [],
        events: [{ id: EVENT, title: "Lantern Night", city: "Hoi An" }],
      },
      // Scoped to the reuse query (it is the only generated_visuals read that
      // filters on prompt_hash). Failing the whole table would trip the entity
      // block guard first and pass this case for the wrong reason.
      failOn: (c: FakeReadContext) =>
        c.table === "generated_visuals" && c.filters.some((f) => f.col === "prompt_hash")
          ? { message: "generated_visuals unavailable", code: "57P01" }
          : null,
    };
    const sc = makeFailClosedClient(spec);
    _setTestClient(sc, true);
    try {
      const outcome = await requestGeneration(req);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error, "reuse_check_unavailable");
      assert.equal((spec.inserted?.["generated_visuals"] ?? []).length, 0, "no duplicate provider job");
    } finally {
      _setTestClient(null as any, false);
    }
  });
});

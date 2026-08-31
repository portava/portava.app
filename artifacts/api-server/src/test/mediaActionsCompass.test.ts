/**
 * mediaActionsCompass — Media v2 Phase 6: action rail (§15) + Compass media
 * context adapter (§32) + I Want This (§15.1) + Do This Experience (§15.2).
 *
 * Proves, with fake Supabase clients only (no DB, no network, no HTTP listen):
 *   1. GET /media/:id/actions returns eligible actions, EACH resolving to a real
 *      existing endpoint. A media item the viewer may not see → null (not_found).
 *   2. §47: an action the viewer isn't authorized for is NOT offered. "Add to
 *      Trip" appears only when the viewer has a plan-editable trip (canEditPlan —
 *      the exact gate the endpoint enforces). MUTATION-PROOF: the gate is a
 *      single `if (editableTripIds.length > 0)`; dropping it makes the
 *      "unauthorized action not offered" assertion go red.
 *   3. CompassMediaContext carries entityRefs + ONLY viewer-permitted intel, no
 *      precise location, and NEVER a fabricated live claim (live off → []).
 *      MUTATION-PROOF: filterPermittedIntelRefs is the single chokepoint; feeding
 *      it a non-permitted ref and dropping the filter makes the "only permitted
 *      intel" assertion go red.
 *   4. "I Want This" records an intent SIGNAL to media_intent_signals — NOT a
 *      like/save (it never touches posts_likes / post_saves / content_stamps).
 *   5. "Do This Experience" produces a plan bound to the EXISTING trip-plan
 *      endpoint, only for an eligible experience.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaActionsCompass.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { isLocationSafe } from "../lib/media/mediaLocationSafety.js";
import { resolveViewer } from "../services/media/MediaProjectionService.js";
import {
  resolveMediaActions,
  buildDoThisExperiencePlan,
  recordMediaIntent,
  loadPlanEditableTripIds,
} from "../services/media/MediaActionResolver.js";
import {
  buildCompassMediaContext,
  filterPermittedIntelRefs,
  formatMediaContextLines,
} from "../compass/CompassMediaContext.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";

// ── A capable, filtering, write-tracking fake Supabase client ────────────────

type Dataset = Record<string, any[]>;

interface Written {
  table: string;
  op: "insert" | "upsert" | "update" | "delete";
  payload?: any;
}

function makeSc(data: Dataset, writes: Written[] = []) {
  const resolveRows = (table: string, filters: any[]): any[] => {
    let rows = (data[table] ?? []).map((r) => ({ ...r }));
    for (const f of filters) {
      if (f.op === "eq") rows = rows.filter((r) => String(r[f.col]) === String(f.val));
      else if (f.op === "neq") rows = rows.filter((r) => String(r[f.col]) !== String(f.val));
      else if (f.op === "in")
        rows = rows.filter((r) => (f.val as any[]).map(String).includes(String(r[f.col])));
      else if (f.op === "ilike") {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[f.col] ?? "").toLowerCase().includes(needle));
      } else if (f.op === "like") {
        const raw = String(f.val);
        const prefix = raw.endsWith("%") ? raw.slice(0, -1) : raw;
        rows = rows.filter((r) => String(r[f.col] ?? "").startsWith(prefix));
      } else if (f.op === "gt") rows = rows.filter((r) => r[f.col] != null && r[f.col] > f.val);
    }
    return rows;
  };

  const builder = (table: string): any => {
    const filters: any[] = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      neq(col: string, val: any) { filters.push({ op: "neq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      like(col: string, val: any) { filters.push({ op: "like", col, val }); return b; },
      gt(col: string, val: any) { filters.push({ op: "gt", col, val }); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      // ── writes (tracked) ─────────────────────────────────────────────────
      upsert(payload: any) { writes.push({ table, op: "upsert", payload }); return Promise.resolve({ data: payload, error: null }); },
      insert(payload: any) { writes.push({ table, op: "insert", payload }); return Promise.resolve({ data: payload, error: null }); },
      update(payload: any) { writes.push({ table, op: "update", payload }); return b; },
      delete() { writes.push({ table, op: "delete" }); return b; },
      // ── terminals ────────────────────────────────────────────────────────
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR);
      },
    };
    return b;
  };

  return { from(table: string) { return builder(table); } } as any;
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR_A = "22222222-2222-2222-2222-222222222222";
const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PLACE_HIDDEN = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const TRIP_1 = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MEDIA_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const GEM_1 = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function makePost(o: Record<string, any> = {}): any {
  const id = o.id ?? MEDIA_1;
  const author = o.author_id ?? AUTHOR_A;
  const row: any = {
    id,
    author_id: author,
    trip_id: o.trip_id ?? null,
    content: "",
    visibility: o.visibility ?? "public",
    status: o.status ?? "active",
    post_status: o.post_status === undefined ? "published" : o.post_status,
    moderation_status: null,
    publish_at: null,
    expires_at: null,
    created_at: o.created_at ?? isoAgo(10 * 60 * 1000),
    category: o.category ?? "nightlife",
    media_urls: [],
    has_video: false,
    location_name: o.location_name ?? "An Thuong Bar",
    location_city: o.location_city ?? "Da Nang",
    location_country: "Vietnam",
    canonical_place_id: o.canonical_place_id === undefined ? PLACE_1 : o.canonical_place_id,
    post_media: [
      {
        id: `${id}-m1`,
        media_type: "image",
        public_url: `https://cdn.example/${id}.jpg`,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: null,
      },
    ],
    profiles: {
      id: author,
      username: "maya",
      full_name: "Maya",
      name: "Maya",
      display_name: "Maya",
      avatar_url: null,
      verified: true,
      is_official: false,
      account_status: "active",
    },
  };
  // The posts row carries precise coordinates the projection must NEVER read.
  row.location_lat = 16.0544;
  row.location_lng = 108.2497;
  return row;
}

/** Base dataset: viewer profile present, everything else empty/off. */
function baseData(extra: Dataset = {}): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [],
    user_mutes: [],
    user_follows: [],
    trip_members: [],
    trips: [],
    hidden_gems: [],
    feature_flags: [], // COMPASS_ENABLED + intel flags all absent → off
    intel_state_snapshots: [],
    intel_live_promoted_scopes: [],
    ...extra,
  };
}

/** A trip the viewer is an accepted member of, with all-members plan editing. */
function editableTripFixture(): Dataset {
  return {
    trips: [{ id: TRIP_1, owner_id: AUTHOR_A, plan_edit_permission: "all_members", visibility: "members", title: "Da Nang week" }],
    trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
  };
}

beforeEach(() => {
  invalidateFlagsCache();
  _clearPromotedScopeCache();
});

// ── 1./2. Action rail: eligible actions, real endpoints, §47 auth gate ───────

describe("GET /media/:id/actions — resolveMediaActions", () => {
  it("returns eligible actions, each resolving to a real endpoint", async () => {
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.ok(result, "action set resolved for a visible item");
    // Every action maps to a concrete endpoint + method.
    for (const a of result!.actions) {
      assert.ok(a.target && a.target.endpoint.startsWith("/api/"), `${a.id} → real endpoint`);
      assert.ok(["GET", "POST", "DELETE"].includes(a.target.method), `${a.id} has a method`);
    }
    const ids = result!.actions.map((a) => a.id);
    // Baseline actions that need only "can see the item".
    for (const id of ["report", "share_telegraph", "save", "i_want_this"]) {
      assert.ok(ids.includes(id as any), `${id} offered`);
    }
    // Place-bound navigation resolves because the media has a canonical place.
    assert.ok(ids.includes("show_on_map"), "show_on_map offered (place resolved)");
    // Entity refs carry the media + its place (coarse), and no coordinate leaks.
    assert.ok(result!.entityRefs.some((r) => r.kind === "media"));
    assert.ok(result!.entityRefs.some((r) => r.kind === "place" && r.id === PLACE_1));
    assert.equal(isLocationSafe(result), true, "no precise location anywhere in the action set");
  });

  it("a media item the viewer cannot see → null (not_found)", async () => {
    // Private post by a non-followed author: excluded by the shared eligibility gate.
    const sc = makeSc(baseData({ posts: [makePost({ visibility: "private" })] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result, null, "no action set for a hidden item");
  });

  it("§47: Add to Trip is NOT offered when the viewer has no plan-editable trip", async () => {
    // No trip membership → canEditPlan can never pass → add_to_trip must be absent.
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    const ids = result!.actions.map((a) => a.id);
    assert.equal(ids.includes("add_to_trip"), false, "unauthorized add_to_trip is NOT offered");
    assert.equal(ids.includes("do_this_experience"), false, "no plan-target ⇒ no do_this_experience");
  });

  it("§47: Add to Trip IS offered — to the trip-plan endpoint — when the viewer can edit a trip", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...editableTripFixture() }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    const add = result!.actions.find((a) => a.id === "add_to_trip");
    assert.ok(add, "add_to_trip offered for a viewer with a plan-editable trip");
    assert.equal(add!.target.method, "POST");
    assert.equal(add!.target.endpoint, "/api/trips/:tripId/plan/items", "resolves to the EXISTING plan-item endpoint");
    assert.deepEqual((add!.target.params as any).editableTripIds, [TRIP_1], "carries the viewer's editable trip");
  });

  it("loadPlanEditableTripIds uses the same canEditPlan gate (owner-only trip excludes a plain member)", async () => {
    const sc = makeSc(
      baseData({
        trips: [{ id: TRIP_1, owner_id: AUTHOR_A, plan_edit_permission: "owner_only", visibility: "members" }],
        trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
        plan_editors: [],
      }),
    );
    const editable = await loadPlanEditableTripIds(sc, VIEWER);
    assert.deepEqual(editable, [], "owner_only trip is not editable by a plain member — the endpoint's own rule");
  });

  it("Meet Here is withheld when the new-event kill switch is engaged", async () => {
    const sc = makeSc(
      baseData({ posts: [makePost()], feature_flags: [{ flag: "disable_new_event_creation", enabled: true }] }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.actions.some((a) => a.id === "meet_here"), false, "kill switch engaged ⇒ no meet_here");
  });

  it("Ask Compass + Create Plan appear only when COMPASS_ENABLED is on", async () => {
    const off = makeSc(baseData({ posts: [makePost()] }));
    const viewerOff = await resolveViewer(off, VIEWER, { needFollows: true });
    const resOff = await resolveMediaActions(off, viewerOff, MEDIA_1, Date.now());
    assert.equal(resOff!.actions.some((a) => a.id === "ask_compass"), false, "compass off ⇒ no ask_compass");

    invalidateFlagsCache();
    const on = makeSc(baseData({ posts: [makePost()], feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }] }));
    const viewerOn = await resolveViewer(on, VIEWER, { needFollows: true });
    const resOn = await resolveMediaActions(on, viewerOn, MEDIA_1, Date.now());
    const ask = resOn!.actions.find((a) => a.id === "ask_compass");
    assert.ok(ask, "compass on ⇒ ask_compass offered");
    assert.equal(ask!.target.endpoint, "/api/compass/ask");
    assert.equal((ask!.target.params as any).mediaId, MEDIA_1, "carries the media id for the §32 adapter");
  });

  it("a hidden-gem canonical place adds a gem ref (opaque id, coarse label)", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        hidden_gems: [{ id: GEM_1, name: "Quiet cove", status: "active", canonical_place_id: PLACE_1 }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.ok(result!.entityRefs.some((r) => r.kind === "gem" && r.id === GEM_1), "gem ref present");
    assert.equal(isLocationSafe(result), true, "gem ref carries no coordinate");
  });
});

// ── 3. CompassMediaContext (§32): entity refs + ONLY permitted intel ─────────

describe("filterPermittedIntelRefs — the only-permitted chokepoint (mutation-proof)", () => {
  it("keeps refs whose place is eligible and DROPS a non-permitted ref", () => {
    const candidates = [
      { ref: "live-ok", placeId: PLACE_1 },
      { ref: "live-leak", placeId: PLACE_HIDDEN }, // a place the viewer may NOT see
    ];
    const eligible = new Set<string>([PLACE_1]);
    const out = filterPermittedIntelRefs(candidates, eligible);
    // THE mutation-proof assertion: dropping the placeId filter (returning every
    // candidate ref) would include "live-leak" and this goes red.
    assert.deepEqual(out, ["live-ok"], "only the permitted-place ref survives");
    assert.equal(out.includes("live-leak"), false, "a ref about a non-permitted place is dropped");
  });
});

describe("buildCompassMediaContext (§32)", () => {
  it("carries entity refs, coarse viewer context, NO precise location, and NO fabricated live", async () => {
    // Live is OFF (no intel flags) → the gated read returns [] → no intel refs.
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const ctx = await buildCompassMediaContext(sc, viewer, MEDIA_1, Date.now());
    assert.ok(ctx, "context built for a visible item");
    assert.equal(ctx!.mediaAssetId, MEDIA_1);
    assert.ok(ctx!.entityRefs.some((r) => r.kind === "place" && r.id === PLACE_1), "entityRefs carry the place");
    assert.equal(ctx!.viewerContext.subjectCity, "Da Nang");
    assert.deepEqual(ctx!.permittedIntelligenceRefs, [], "live off ⇒ NO fabricated live claims");
    assert.equal(isLocationSafe(ctx), true, "no precise location in the media context");
    // The formatted prompt lines are coarse and mention no coordinate.
    const lines = formatMediaContextLines(ctx!);
    assert.ok(lines.length > 0);
    assert.equal(isLocationSafe({ lines }), true);
  });

  it("a media item the viewer cannot see → null context (no leak into the prompt)", async () => {
    const sc = makeSc(baseData({ posts: [makePost({ visibility: "private" })] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const ctx = await buildCompassMediaContext(sc, viewer, MEDIA_1, Date.now());
    assert.equal(ctx, null, "hidden item yields no context");
  });

  it("permittedIntelligenceRefs carries a gated live-claim ref when — and only when — the IG gates pass", async () => {
    const FUTURE = new Date(Date.now() + 30 * 60_000).toISOString();
    const PAST = new Date(Date.now() - 30 * 60_000).toISOString();
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        feature_flags: [
          { flag: "intel_live_label_crowd", enabled: true },
          { flag: "intel_claim_projection_crowd", enabled: true },
          { flag: "intel_capture_quick_signal", enabled: true },
          { flag: "intel_limited_live", enabled: true },
          // disable_intel_live_labels absent ⇒ kill switch OFF
        ],
        intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
        intel_state_snapshots: [
          {
            id: "snap-1",
            zone_id: "",
            subject_id: PLACE_1,
            claim_type: "crowd.level",
            value: { level: "busy" },
            confidence: 0.8,
            source_count: 20,
            observed_at: PAST,
            expires_at: FUTURE,
            privacy_eligible: true,
          },
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const ctx = await buildCompassMediaContext(sc, viewer, MEDIA_1, Date.now());
    assert.ok(ctx);
    assert.deepEqual(ctx!.permittedIntelligenceRefs, ["snap-1"], "the gated live-claim id is a permitted intel ref");
    assert.equal(isLocationSafe(ctx), true, "the intel ref carries no coordinate");
  });
});

// ── 4. I Want This (§15.1): an intent signal, NOT a like ─────────────────────

describe("recordMediaIntent — I Want This is a distinct intent signal", () => {
  it("writes ONLY to media_intent_signals, never posts_likes/post_saves/content_stamps", async () => {
    const writes: Written[] = [];
    const sc = makeSc(baseData(), writes);
    const res = await recordMediaIntent(sc, VIEWER, MEDIA_1, { entityType: "place", entityId: PLACE_1 }, "want_to_go");
    assert.equal(res.recorded, true, "intent recorded");
    const tables = writes.map((w) => w.table);
    assert.deepEqual(tables, ["media_intent_signals"], "intent goes to its own store");
    for (const social of ["posts_likes", "post_saves", "content_stamps", "media_stamp_reactions"]) {
      assert.equal(tables.includes(social), false, `intent is NOT a ${social} write`);
    }
    // The written row records the resolved entity + the intent kind.
    const w = writes[0].payload;
    assert.equal(w.user_id, VIEWER);
    assert.equal(w.media_id, MEDIA_1);
    assert.equal(w.entity_type, "place");
    assert.equal(w.intent, "want_to_go");
  });

  it("rejects a non-uuid media id without writing", async () => {
    const writes: Written[] = [];
    const sc = makeSc(baseData(), writes);
    const res = await recordMediaIntent(sc, VIEWER, "not-a-uuid", { entityType: "media", entityId: "x" }, "want_to_go");
    assert.equal(res.recorded, false);
    assert.equal(writes.length, 0, "no write on invalid input");
  });
});

// ── 5. Do This Experience (§15.2): a plan via the existing path ──────────────

describe("buildDoThisExperiencePlan — converts an eligible experience into a plan", () => {
  it("produces ordered stops bound to the EXISTING trip-plan endpoint", async () => {
    const sc = makeSc(
      baseData({
        // A public trip experience with two attached, viewer-eligible posts at
        // distinct canonical places.
        trips: [{ id: TRIP_1, owner_id: AUTHOR_A, visibility: "public", title: "Da Nang night", start_date: null, end_date: null }],
        events: [],
        posts: [
          makePost({ id: "10000000-0000-0000-0000-000000000001", trip_id: TRIP_1, canonical_place_id: PLACE_1 }),
          makePost({ id: "10000000-0000-0000-0000-000000000002", trip_id: TRIP_1, canonical_place_id: PLACE_HIDDEN, location_name: "Beach" }),
        ],
        ...editableTripFixture(),
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const plan = await buildDoThisExperiencePlan(sc, viewer, TRIP_1, Date.now());
    assert.ok(plan, "plan produced for an eligible experience");
    assert.equal(plan!.kind, "trip");
    assert.equal(plan!.method, "POST");
    assert.equal(plan!.targetEndpoint, "/api/trips/:tripId/plan/items", "goes through the EXISTING plan-creation path");
    assert.ok(plan!.stops.length >= 2, "ordered stops from the experience's places");
    assert.ok(plan!.stops.every((s) => s.sourceType === "place" && s.sourceId), "stops are resolvable place refs");
    assert.ok(plan!.eligibleTripIds.includes(TRIP_1), "carries a plan-editable target trip");
    assert.equal(isLocationSafe(plan), true, "the plan carries no coordinate");
  });

  it("an experience the viewer cannot see → null (no plan, §47)", async () => {
    const sc = makeSc(
      baseData({
        trips: [{ id: TRIP_1, owner_id: AUTHOR_A, visibility: "members", title: "Private" }],
        events: [],
        trip_members: [], // viewer is not a member
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const plan = await buildDoThisExperiencePlan(sc, viewer, TRIP_1, Date.now());
    assert.equal(plan, null, "no plan for a private experience the viewer cannot see");
  });
});

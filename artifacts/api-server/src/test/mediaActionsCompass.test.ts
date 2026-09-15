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

/**
 * `failReads` makes SELECTs on the named tables RESOLVE as `{ data: null, error }`
 * — the way supabase-js actually reports a read failure. Writes are untouched,
 * and nothing throws: a fake that threw would exercise a catch production never
 * enters, and the whole defect under test is a failure that does not throw.
 */
function makeSc(data: Dataset, writes: Written[] = [], failReads?: (table: string) => any) {
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
      maybeSingle() {
        const err = failReads?.(table);
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null });
      },
      single() {
        const err = failReads?.(table);
        if (err) return Promise.resolve({ data: null, error: err });
        return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        const err = failReads?.(table);
        if (err) return Promise.resolve({ data: null, error: err }).then(onF, onR);
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

  /**
   * ── THE PLAN GATE MUST SAY WHETHER IT RAN ─────────────────────────────────
   *
   * `loadPlanEditableTripIds` answers "which trips may this viewer add to". It
   * returned `[]` both when the viewer has none AND when `trip_members` could
   * not be read, and the resolver spends that as "offer no add_to_trip". The
   * fail-closed direction is right and unchanged — a viewer is never offered an
   * add the endpoint would refuse — but a viewer who HAS editable trips was
   * being shown the exact UI of a viewer who has none, and `eligibleTripIds: []`
   * went out on the Do-This-Experience proposal as a positive enumeration.
   */
  const DB_DOWN = { message: "server closed the connection unexpectedly", code: "08006" };

  it("loadPlanEditableTripIds returns null — not [] — when trip_members cannot be read", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...editableTripFixture() }), [], (t) =>
      t === "trip_members" ? DB_DOWN : null);

    const editable = await loadPlanEditableTripIds(sc, VIEWER);

    assert.equal(editable, null, "an unreadable membership table is not 'you belong to no trip'");
    assert.notDeepEqual(editable, [], "the two absences must not be the same value");
  });

  it("loadPlanEditableTripIds returns null when a per-trip canEditPlan probe could not run", async () => {
    // specific_members sends canEditPlan to plan_editors; an unreadable
    // plan_editors makes it throw, and `.catch(() => null)` used to read that as
    // "this trip is not editable" — a gate result invented out of an outage.
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        trips: [{ id: TRIP_1, owner_id: AUTHOR_A, plan_edit_permission: "specific_members", visibility: "members" }],
        trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
        plan_editors: [{ trip_id: TRIP_1, user_id: VIEWER }],
      }),
      [],
      (t) => (t === "plan_editors" ? DB_DOWN : null),
    );

    assert.equal(await loadPlanEditableTripIds(sc, VIEWER), null, "an unrun gate probe is not a 'no'");
  });

  it("a viewer who genuinely has no editable trip still gets a real [] ", async () => {
    const sc = makeSc(baseData({ posts: [makePost()] }));

    assert.deepEqual(await loadPlanEditableTripIds(sc, VIEWER), [], "read ran, answer is none");
  });

  it("resolveMediaActions carries planGateDetermined false when the gate could not be read", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...editableTripFixture() }), [], (t) =>
      t === "trip_members" ? DB_DOWN : null);
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });

    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());

    assert.ok(result);
    assert.equal(
      result!.actions.some((a) => a.id === "add_to_trip"), false,
      "fail-closed direction unchanged: an add the endpoint might refuse is still not offered",
    );
    assert.equal(
      result!.planGateDetermined, false,
      "but the absence of add_to_trip is now labelled as unmeasured, not as a decision",
    );
  });

  it("resolveMediaActions carries planGateDetermined true when the gate ran and said no", async () => {
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });

    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());

    assert.equal(result!.actions.some((a) => a.id === "add_to_trip"), false);
    assert.equal(result!.planGateDetermined, true, "a real 'you have no editable trip'");
  });

  it("the two absences of add_to_trip are distinguishable by the caller", async () => {
    const down = makeSc(baseData({ posts: [makePost()], ...editableTripFixture() }), [], (t) =>
      t === "trip_members" ? DB_DOWN : null);
    const none = makeSc(baseData({ posts: [makePost()] }));

    const a = await resolveMediaActions(down, await resolveViewer(down, VIEWER, { needFollows: true }), MEDIA_1, Date.now());
    const b = await resolveMediaActions(none, await resolveViewer(none, VIEWER, { needFollows: true }), MEDIA_1, Date.now());

    assert.deepEqual(
      a!.actions.map((x) => x.id), b!.actions.map((x) => x.id),
      "the action lists are identical — which is exactly why the flag has to exist",
    );
    assert.notEqual(a!.planGateDetermined, b!.planGateDetermined);
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
    // `sensitivity_level` is NOT NULL DEFAULT 'public' in the live schema
    // (0043_hidden_gems). The fixture spells it out because gem IDENTITY
    // disclosure now depends on it — see mediaGemAndPrivacyDisclosure.test.ts,
    // which proves a non-public gem yields NO ref.
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        hidden_gems: [
          {
            id: GEM_1,
            name: "Quiet cove",
            status: "active",
            sensitivity_level: "public",
            canonical_place_id: PLACE_1,
            submitted_by: AUTHOR_A,
          },
        ],
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

  it("a proposal whose plan gate could not be read says so, instead of enumerating zero trips", async () => {
    const sc = makeSc(
      baseData({
        trips: [{ id: TRIP_1, owner_id: AUTHOR_A, plan_edit_permission: "specific_members", visibility: "members", title: "Da Nang week" }],
        trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
        plan_editors: [{ trip_id: TRIP_1, user_id: VIEWER }],
        posts: [
          makePost({ trip_id: TRIP_1, canonical_place_id: PLACE_1, location_name: "An Thuong" }),
          makePost({ id: "10000000-0000-0000-0000-000000000002", trip_id: TRIP_1, canonical_place_id: PLACE_HIDDEN, location_name: "Beach" }),
        ],
      }),
      [],
      (t) => (t === "plan_editors" ? { message: "server closed the connection unexpectedly", code: "08006" } : null),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });

    const plan = await buildDoThisExperiencePlan(sc, viewer, TRIP_1, Date.now());

    assert.ok(plan, "the experience is still visible, so the proposal is still produced");
    assert.deepEqual(plan!.eligibleTripIds, [], "fail-closed: the proposal still has nowhere to land");
    assert.equal(
      plan!.planGateDetermined, false,
      "`eligibleTripIds: []` is a positive enumeration on the wire; this says it was never taken",
    );
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

// ═════════════════════════════════════════════════════════════════════════════
// §28 SHARED MOMENT in the media context graph (MD51) · §15 INVITE PEOPLE (MD100)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * MD51 read **N**: *"`MediaActionResolver.ts:53` — `MediaEntityKind = "media" |
 * "place" | "trip" | "gem"`. No shared-moment edge anywhere in the context graph,
 * though the product has shared moments."* MD100 read **N**: *"No invite member
 * in the resolver's action vocabulary."* MD222 read **W** on the first of those.
 *
 * The edge exists in the schema and nothing was reading it:
 * `shared_moment_contributions.post_id` references `posts(id)` (migration
 * 2064:38), so a media item that was contributed to a Shared Moment already
 * knows which one. The three gates below are the endpoint's own, not new policy:
 *
 *   FLAG     `areSharedMomentsEnabled` — the same capability chain
 *            routes/sharedMoments.ts::guard applies. Off ⇒ no ref, no action.
 *   MEMBER   `momentRole(...) !== null` (accepted membership) — the same
 *            predicate GET /shared-moments/:id uses to answer `not_member`. A
 *            non-member is not told the Moment exists.
 *   MANAGER  role owner|manager for the INVITE action — the exact
 *            `ownerOrManager` gate POST /shared-moments/:id/invites enforces, so
 *            the rail can never offer an invite the endpoint would refuse (§47).
 *
 * And one gate that is this rail's own: only an APPROVED contribution creates
 * the edge. A pending or removed contribution is not a Shared Moment membership
 * of the media.
 */
const MOMENT_1 = "abcdabcd-abcd-abcd-abcd-abcdabcdabcd";

/** All flags the shared-moments capability chain requires, enabled. */
function sharedMomentFlags(): any[] {
  return [
    { flag: "external_places_enabled", enabled: true },
    { flag: "live_places_enabled", enabled: true },
    { flag: "place_days_enabled", enabled: true },
    { flag: "shared_moments_enabled", enabled: true },
  ];
}

function momentFixture(o: { role?: string; status?: string; contributionStatus?: string; flags?: boolean } = {}): Dataset {
  return {
    feature_flags: o.flags === false ? [] : sharedMomentFlags(),
    shared_moments: [
      {
        id: MOMENT_1,
        owner_id: AUTHOR_A,
        title: "Friday night at An Thuong",
        status: o.status ?? "active",
        place_id: PLACE_1,
        trip_id: null,
        place_day_id: null,
      },
    ],
    shared_moment_contributions: [
      {
        id: "contrib-1",
        moment_id: MOMENT_1,
        contributor_id: AUTHOR_A,
        post_id: MEDIA_1,
        status: o.contributionStatus ?? "approved",
      },
    ],
    shared_moment_memberships:
      o.role === undefined
        ? []
        : [{ moment_id: MOMENT_1, user_id: VIEWER, role: o.role, status: "accepted" }],
  };
}

describe("MD51 — a media item resolves to the Shared Moment it was contributed to", () => {
  it("an accepted member gets a shared_moment entity ref", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({ role: "member" }) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    const ref = result!.entityRefs.find((r) => r.kind === "shared_moment");
    assert.ok(ref, "the §28 Shared Moment edge must be in the media context graph");
    assert.equal(ref!.id, MOMENT_1);
    assert.equal(ref!.label, "Friday night at An Thuong");
  });

  it("a NON-member is not told the Moment exists — no ref, no id, no title", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({}) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.entityRefs.some((r) => r.kind === "shared_moment"), false);
    assert.equal(JSON.stringify(result).includes(MOMENT_1), false);
    assert.equal(JSON.stringify(result).includes("Friday night at An Thuong"), false);
  });

  it("a PENDING contribution is not a Shared Moment edge", async () => {
    const sc = makeSc(
      baseData({ posts: [makePost()], ...momentFixture({ role: "owner", contributionStatus: "pending" }) }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.entityRefs.some((r) => r.kind === "shared_moment"), false);
  });

  it("with the Shared Moments capability OFF there is no ref at all", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({ role: "owner", flags: false }) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.entityRefs.some((r) => r.kind === "shared_moment"), false);
    assert.equal(result!.actions.some((a) => a.id === "invite_people"), false);
  });

  it("an ARCHIVED Moment yields no ref", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({ role: "owner", status: "archived" }) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.entityRefs.some((r) => r.kind === "shared_moment"), false);
  });
});

describe("MD100 — Invite People, gated by the endpoint's own ownerOrManager check", () => {
  it("an OWNER is offered invite_people, targeting the existing invites endpoint", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({ role: "owner" }) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    const invite = result!.actions.find((a) => a.id === "invite_people");
    assert.ok(invite, "an owner may invite");
    assert.equal(invite!.target.method, "POST");
    assert.equal(invite!.target.endpoint, "/api/shared-moments/:id/invites");
    assert.equal((invite!.target.params as any).id, MOMENT_1);
    assert.equal(invite!.outcome, "meet");
  });

  it("a MANAGER is offered it too", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({ role: "manager" }) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.ok(result!.actions.some((a) => a.id === "invite_people"));
  });

  it("a plain MEMBER sees the Moment but is NOT offered the invite the endpoint would refuse", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({ role: "member" }) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.ok(result!.entityRefs.some((r) => r.kind === "shared_moment"), "the ref is a read, and a member may read");
    assert.equal(
      result!.actions.some((a) => a.id === "invite_people"),
      false,
      "§47: the rail asks the same question POST /shared-moments/:id/invites asks",
    );
  });

  it("no Shared Moment at all ⇒ no invite action (no dead actions)", async () => {
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.actions.some((a) => a.id === "invite_people"), false);
  });

  it("the action set still carries no precise location once the Moment edge is added", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], ...momentFixture({ role: "owner" }) }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(isLocationSafe(result), true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §23.1 CHAIN ACTIONS — census-media MD172 (Follow This Night) / MD173 (Save Route)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * MD172 read **N**: *"No such action in `MediaActionResolver`."* MD173 read
 * **N**: *"Route plans exist (`route_plans`, `routes/routePlan.ts`) and no media
 * action reaches them."*
 *
 * Both are offered ONLY when the media's experience actually HAS a chain — two
 * or more distinct disclosable places with observed perspectives (MD171). That
 * is not decoration: `POST /route-plans`'s own schema is
 * `stops: z.array(...).min(2).max(20)`, so offering Save Route on a one-place
 * experience would be offering an action the endpoint would reject, which is the
 * "no dead actions" rule this rail is built on.
 *
 * WHAT SAVE ROUTE DOES NOT CARRY: coordinates. The rail is coordinate-free by
 * construction, and `CandidateStopSchema` requires `lat`/`lng`, so the emitted
 * stops carry the canonical place id + coarse title and the client resolves
 * geometry through the Map gateway it already holds — the same division of
 * labour as `show_on_map`. The census row records that this leaves MD173 partly
 * open, rather than the test pretending the submission is complete.
 */
const PLACE_2 = "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb";

function chainTripFixture(): Dataset {
  return {
    trips: [{ id: TRIP_1, owner_id: VIEWER, plan_edit_permission: "all_members", visibility: "public", title: "Friday night" }],
    trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
    posts: [
      makePost({ trip_id: TRIP_1 }),
      makePost({ id: "cccccccc-1111-1111-1111-cccccccccccc", trip_id: TRIP_1, canonical_place_id: PLACE_2, location_name: "Rooftop", created_at: isoAgo(60 * 60 * 1000) }),
    ],
  };
}

describe("MD172/MD173 — the §23.1 chain actions", () => {
  it("a two-place experience offers Follow This Night and Save Route", async () => {
    const sc = makeSc(baseData(chainTripFixture()));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    const follow = result!.actions.find((a) => a.id === "follow_this_night");
    const save = result!.actions.find((a) => a.id === "save_route");
    assert.ok(follow, "Follow This Night must be offered for a real chain");
    assert.equal(follow!.target.endpoint, "/api/media/experiences/:experienceId");
    assert.ok(save, "Save Route must reach the canonical route-plan endpoint");
    assert.equal(save!.target.method, "POST");
    assert.equal(save!.target.endpoint, "/api/route-plans");
    const stops = (save!.target.params as any).stops as any[];
    assert.ok(stops.length >= 2, "POST /route-plans requires at least two stops");
    assert.ok(stops.length <= 20, "and at most twenty");
    assert.deepEqual(
      stops.map((s) => s.sourceId).sort(),
      [PLACE_1, PLACE_2].sort(),
      "the stops are canonical place ids",
    );
  });

  it("a ONE-place experience offers neither — the endpoint would reject a 1-stop route", async () => {
    const sc = makeSc(
      baseData({
        trips: [{ id: TRIP_1, owner_id: VIEWER, plan_edit_permission: "all_members", visibility: "public", title: "One stop" }],
        trip_members: [{ trip_id: TRIP_1, user_id: VIEWER, role: "member", status: "accepted" }],
        posts: [makePost({ trip_id: TRIP_1 })],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.actions.some((a) => a.id === "follow_this_night"), false);
    assert.equal(result!.actions.some((a) => a.id === "save_route"), false);
  });

  it("media with no trip at all offers neither", async () => {
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.actions.some((a) => a.id === "save_route"), false);
  });

  it("a trip the viewer may NOT see yields no chain actions", async () => {
    const sc = makeSc(
      baseData({
        trips: [{ id: TRIP_1, owner_id: AUTHOR_A, visibility: "members", title: "Private night" }],
        trip_members: [],
        posts: [
          makePost({ trip_id: TRIP_1 }),
          makePost({ id: "cccccccc-1111-1111-1111-cccccccccccc", trip_id: TRIP_1, canonical_place_id: PLACE_2 }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.actions.some((a) => a.id === "follow_this_night"), false);
    assert.equal(result!.actions.some((a) => a.id === "save_route"), false);
  });

  it("the chain actions carry no coordinate", async () => {
    const sc = makeSc(baseData(chainTripFixture()));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(isLocationSafe(result), true);
  });
});

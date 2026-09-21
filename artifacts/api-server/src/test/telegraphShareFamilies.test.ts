/**
 * Telegraph §5 — the object families that had NO loader, and the two rules
 * that are specific to them.
 *
 * Spec (v1 and v1_1, byte-identical shared body):
 *   §5    "All eligible Portava content should be shareable into Telegraph
 *          through one consistent share contract", over five object families:
 *            Social   — profile, post, Highlight, public Memory derivative,
 *                       Memory Note, Stamp
 *            Travel   — Trip, Trip stage, plan, event, route,
 *                       RESERVATION-SAFE DERIVATIVE, layover plan
 *            Places   — place, Hidden Gem, map pin, neighborhood, meetup point
 *            Services — Buddy profile/service, eligible booking card,
 *                       Visa Buddy operational card
 *            Media    — photo, video, voice, GIF, file
 *   §5.1  getSharePreview / getCurrentState / getAvailableActions / getDeepLink
 *   §5.3  "If the source becomes deleted, private or unauthorized, the
 *          Telegraph reference must degrade to an unavailable state."
 *
 * WHAT THIS FILE IS FOR. `telegraphShare.test.ts` proves the CONTRACT — that an
 * unavailable reference carries nothing, that a loader fails closed on a
 * database error. It proves it over the families that had loaders. Seven of the
 * families §5 names had none at all: Highlight, Stamp, neighborhood, route,
 * reservation, layover plan, and the whole Media family. `shareableFor` returned
 * `null` for each, and `resolveShareProjections` answered `not_found` — which is
 * the SAFE answer and is not the same thing as the family being shareable.
 *
 * Two rules here exist nowhere else in the contract and are the reason this is
 * a separate file rather than more cases in the old one:
 *
 *   1. A HIGHLIGHT EXPIRES ON ITS OWN. Every other family becomes unavailable
 *      because somebody DID something — deleted, unpublished, revoked, blocked.
 *      `highlights.expires_at` is NOT NULL, so a Highlight card goes stale with
 *      nothing written and nobody acting. §5.3's list does not name time and
 *      the behaviour still has to be there.
 *
 *   2. A RESERVATION IS SHARED AS A DERIVATIVE, NOT AS ITSELF. §5 says
 *      "reservation-safe derivative", and the word doing the work is SAFE:
 *      `trip_reservations` carries `confirmation_ref` (a booking reference IS a
 *      credential — it is what an airline's "manage my booking" page
 *      authenticates on), `raw_text` (the pasted confirmation email, entire) and
 *      `extraction`. The projection must carry none of them, and the assertion
 *      below scans the WHOLE serialized projection for the fixture's reference
 *      rather than checking named fields, so a leak through any key fails.
 *
 * SHOWN RED before commit — see docs/architecture/census-telegraph.md §15.4 for
 * the full table. Each mutation was applied, run, reverted, and the file
 * compared byte-for-byte with `cmp`.
 *
 * Run: node --import tsx/esm --test src/test/telegraphShareFamilies.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deepLinkFor,
  isShareable,
  resolveShareProjections,
  shareableFor,
  FAMILIES_WITH_NO_CLIENT_SCREEN,
  SHAREABLE_OBJECT_TYPES,
} from "../services/telegraph/shareables.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer, throughout
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // owns most fixtures
const THREAD = "dddddddd-0000-4000-8000-00000000000d";

const HL_LIVE = "aa110000-0000-4000-8000-000000000001";
const HL_EXPIRED = "aa110000-0000-4000-8000-000000000002";
const HL_CIRCLE = "aa110000-0000-4000-8000-000000000003";
const HL_UNDATED = "aa110000-0000-4000-8000-000000000004";
const HL_ARCHIVED = "aa110000-0000-4000-8000-000000000005";

const STAMP_PUBLIC = "bb220000-0000-4000-8000-000000000001";
const STAMP_REVOKED = "bb220000-0000-4000-8000-000000000002";
const STAMP_HIDDEN = "bb220000-0000-4000-8000-000000000003";
const STAMP_PRIVATE = "bb220000-0000-4000-8000-000000000004";
const STAMP_DEF = "bb22dddd-0000-4000-8000-000000000001";

const HOOD = "cc330000-0000-4000-8000-000000000001";

const ROUTE_DRAFT = "dd440000-0000-4000-8000-000000000001";
const ROUTE_SHARED = "dd440000-0000-4000-8000-000000000002";
const ROUTE_STRANGER = "dd440000-0000-4000-8000-000000000003";
const ROUTE_CANCELLED = "dd440000-0000-4000-8000-000000000004";

const RES_MINE = "ee550000-0000-4000-8000-000000000001";
const RES_TRIP = "ee550000-0000-4000-8000-000000000002";
const RES_STRANGER = "ee550000-0000-4000-8000-000000000003";
const RES_DISMISSED = "ee550000-0000-4000-8000-000000000004";
const CONFIRMATION = "QF-7H2K9X-NEVER-SHARE";

const LAY_MINE = "ff660000-0000-4000-8000-000000000001";
const LAY_TRIP = "ff660000-0000-4000-8000-000000000002";
const LAY_SOLO = "ff660000-0000-4000-8000-000000000003";
const LAY_EXPIRED = "ff660000-0000-4000-8000-000000000004";
const LAY_CANCELLED = "ff660000-0000-4000-8000-000000000005";

const MEDIA_PUBLIC = "99770000-0000-4000-8000-000000000001";
const MEDIA_INHERIT = "99770000-0000-4000-8000-000000000002";
const MEDIA_FLAGGED = "99770000-0000-4000-8000-000000000003";
const MEDIA_MINE = "99770000-0000-4000-8000-000000000004";
const MEDIA_REJECTED = "99770000-0000-4000-8000-000000000005";
const MEDIA_PROCESSING = "99770000-0000-4000-8000-000000000006";
const MEDIA_REMOVED = "99770000-0000-4000-8000-000000000007";

const SVC_LIVE = "aa880000-0000-4000-8000-000000000001";
const SVC_UNAPPROVED = "aa880000-0000-4000-8000-000000000002";
const SVC_PAUSED = "aa880000-0000-4000-8000-000000000003";

const TRIP_SHARED = "88880000-0000-4000-8000-000000000001";
const TRIP_OTHER = "88880000-0000-4000-8000-000000000002";

const HOUR = 3600_000;
const soon = () => new Date(Date.now() + 6 * HOUR).toISOString();
const past = () => new Date(Date.now() - 6 * HOUR).toISOString();

interface State {
  errorTable?: string;
}

function fixture(): Record<string, any[]> {
  return {
    highlights: [
      { id: HL_LIVE, owner_id: BOB, caption: "Sunset from the roof", location_name: "Rooftop", location_city: "Hue", visibility: "public", expires_at: soon(), deleted_at: null, archived_at: null, media_url: "https://x/h1.jpg", media_type: "image", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: HL_EXPIRED, owner_id: BOB, caption: "Yesterday", location_name: null, location_city: "Hue", visibility: "public", expires_at: past(), deleted_at: null, archived_at: null, media_url: "https://x/h2.jpg", media_type: "image", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: HL_CIRCLE, owner_id: BOB, caption: "Circle only", location_name: null, location_city: "Hue", visibility: "circle_only", expires_at: soon(), deleted_at: null, archived_at: null, media_url: "https://x/h3.jpg", media_type: "image", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: HL_UNDATED, owner_id: BOB, caption: "Broken clock", location_name: null, location_city: "Hue", visibility: "public", expires_at: "not a date", deleted_at: null, archived_at: null, media_url: "https://x/h4.jpg", media_type: "image", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: HL_ARCHIVED, owner_id: BOB, caption: "Filed away", location_name: null, location_city: "Hue", visibility: "public", expires_at: soon(), deleted_at: null, archived_at: "2026-05-05T00:00:00.000Z", media_url: "https://x/h5.jpg", media_type: "image", updated_at: "2026-05-05T00:00:00.000Z" },
    ],
    user_stamps: [
      { id: STAMP_PUBLIC, user_id: BOB, stamp_definition_id: STAMP_DEF, title_override: null, city: "Hue", country: "VN", visibility: "public", display_on_passport: true, is_revoked: false, earned_at: "2026-04-01T00:00:00.000Z" },
      { id: STAMP_REVOKED, user_id: BOB, stamp_definition_id: STAMP_DEF, title_override: null, city: "Hue", country: "VN", visibility: "public", display_on_passport: true, is_revoked: true, earned_at: "2026-04-02T00:00:00.000Z" },
      { id: STAMP_HIDDEN, user_id: BOB, stamp_definition_id: STAMP_DEF, title_override: null, city: "Hue", country: "VN", visibility: "public", display_on_passport: false, is_revoked: false, earned_at: "2026-04-03T00:00:00.000Z" },
      { id: STAMP_PRIVATE, user_id: BOB, stamp_definition_id: STAMP_DEF, title_override: "Private award", city: "Hue", country: "VN", visibility: "private", display_on_passport: true, is_revoked: false, earned_at: "2026-04-04T00:00:00.000Z" },
    ],
    stamp_definitions: [
      { id: STAMP_DEF, name: "First Perfume River crossing", icon_url: "https://x/s.png", universal_artwork_url: null },
    ],
    neighborhood_areas: [
      { id: HOOD, name: "Old town", city_name: "Hue", country: "VN", confidence: "high", source: "osm", computed_at: "2026-03-01T00:00:00.000Z" },
    ],
    route_plans: [
      { id: ROUTE_DRAFT, owner_user_id: BOB, title: "Unfinished", route_style: "custom", status: "draft", is_approximated: true, updated_at: "2026-05-01T00:00:00.000Z" },
      { id: ROUTE_SHARED, owner_user_id: BOB, title: "Riverside walk", route_style: "walking", status: "active", is_approximated: true, updated_at: "2026-05-02T00:00:00.000Z" },
      { id: ROUTE_STRANGER, owner_user_id: BOB, title: "Not yours", route_style: "walking", status: "active", is_approximated: false, updated_at: "2026-05-03T00:00:00.000Z" },
      { id: ROUTE_CANCELLED, owner_user_id: BOB, title: "Called off", route_style: "walking", status: "cancelled", is_approximated: false, updated_at: "2026-05-04T00:00:00.000Z" },
    ],
    route_plan_members: [
      { route_plan_id: ROUTE_SHARED, user_id: ALICE },
      { route_plan_id: ROUTE_SHARED, user_id: BOB },
    ],
    trip_reservations: [
      { id: RES_MINE, trip_id: TRIP_OTHER, user_id: ALICE, type: "flight", title: "SGN → HUI", starts_at: "2026-06-01T09:00:00.000Z", ends_at: "2026-06-01T10:20:00.000Z", location_name: "Tan Son Nhat", confirmation_ref: CONFIRMATION, raw_text: `Booking ${CONFIRMATION} confirmed for MS A NGUYEN`, extraction: { pnr: CONFIRMATION }, status: "confirmed", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: RES_TRIP, trip_id: TRIP_SHARED, user_id: BOB, type: "stay", title: "Riverside guesthouse", starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-04T11:00:00.000Z", location_name: "Hue", confirmation_ref: CONFIRMATION, raw_text: `Ref ${CONFIRMATION}`, extraction: { pnr: CONFIRMATION }, status: "confirmed", updated_at: "2026-05-02T00:00:00.000Z" },
      { id: RES_STRANGER, trip_id: TRIP_OTHER, user_id: BOB, type: "activity", title: "Somebody else's tour", starts_at: null, ends_at: null, location_name: "Hue", confirmation_ref: CONFIRMATION, raw_text: null, extraction: null, status: "confirmed", updated_at: "2026-05-03T00:00:00.000Z" },
      { id: RES_DISMISSED, trip_id: TRIP_OTHER, user_id: ALICE, type: "flight", title: "Cancelled leg", starts_at: null, ends_at: null, location_name: "Hue", confirmation_ref: CONFIRMATION, raw_text: null, extraction: null, status: "dismissed", updated_at: "2026-05-04T00:00:00.000Z" },
    ],
    layover_sessions: [
      { id: LAY_MINE, user_id: ALICE, trip_id: null, manual_airport_name: "Changi", manual_city: "Singapore", manual_iata: "SIN", arrival_time: "2026-06-01T02:00:00.000Z", departure_time: "2026-06-01T11:00:00.000Z", status: "active", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: LAY_TRIP, user_id: BOB, trip_id: TRIP_SHARED, manual_airport_name: "Changi", manual_city: "Singapore", manual_iata: "SIN", arrival_time: "2026-06-01T02:00:00.000Z", departure_time: "2026-06-01T11:00:00.000Z", status: "active", updated_at: "2026-05-02T00:00:00.000Z" },
      { id: LAY_SOLO, user_id: BOB, trip_id: null, manual_airport_name: "Changi", manual_city: "Singapore", manual_iata: "SIN", arrival_time: "2026-06-01T02:00:00.000Z", departure_time: "2026-06-01T11:00:00.000Z", status: "active", updated_at: "2026-05-03T00:00:00.000Z" },
      { id: LAY_EXPIRED, user_id: BOB, trip_id: TRIP_SHARED, manual_airport_name: "Changi", manual_city: "Singapore", manual_iata: "SIN", arrival_time: "2026-01-01T02:00:00.000Z", departure_time: "2026-01-01T11:00:00.000Z", status: "expired", updated_at: "2026-05-04T00:00:00.000Z" },
      { id: LAY_CANCELLED, user_id: ALICE, trip_id: null, manual_airport_name: "Changi", manual_city: "Singapore", manual_iata: "SIN", arrival_time: "2026-06-01T02:00:00.000Z", departure_time: "2026-06-01T11:00:00.000Z", status: "cancelled", updated_at: "2026-05-05T00:00:00.000Z" },
    ],
    media_assets: [
      { id: MEDIA_PUBLIC, owner_user_id: BOB, caption: "The alley", alt_text: null, media_type: "image", thumbnail_url: "https://x/m1t.jpg", public_url: "https://x/m1.jpg", visibility: "public", moderation_status: "approved", processing_status: "ready", updated_at: "2026-05-01T00:00:00.000Z" },
      { id: MEDIA_INHERIT, owner_user_id: BOB, caption: "Inside a private memory", alt_text: null, media_type: "image", thumbnail_url: "https://x/m2t.jpg", public_url: "https://x/m2.jpg", visibility: "inherit", moderation_status: "approved", processing_status: "ready", updated_at: "2026-05-02T00:00:00.000Z" },
      { id: MEDIA_FLAGGED, owner_user_id: BOB, caption: "Under review", alt_text: null, media_type: "video", thumbnail_url: "https://x/m3t.jpg", public_url: "https://x/m3.mp4", visibility: "public", moderation_status: "flagged", processing_status: "ready", updated_at: "2026-05-03T00:00:00.000Z" },
      { id: MEDIA_MINE, owner_user_id: ALICE, caption: "My own upload", alt_text: null, media_type: "image", thumbnail_url: null, public_url: "https://x/m4.jpg", visibility: "inherit", moderation_status: "pending", processing_status: "ready", updated_at: "2026-05-04T00:00:00.000Z" },
      { id: MEDIA_REJECTED, owner_user_id: ALICE, caption: "Taken down", alt_text: null, media_type: "image", thumbnail_url: null, public_url: "https://x/m5.jpg", visibility: "public", moderation_status: "rejected", processing_status: "ready", updated_at: "2026-05-05T00:00:00.000Z" },
      { id: MEDIA_PROCESSING, owner_user_id: ALICE, caption: "Still uploading", alt_text: null, media_type: "video", thumbnail_url: null, public_url: null, visibility: "public", moderation_status: "approved", processing_status: "uploading", updated_at: "2026-05-06T00:00:00.000Z" },
      { id: MEDIA_REMOVED, owner_user_id: ALICE, caption: "Gone from storage", alt_text: null, media_type: "image", thumbnail_url: null, public_url: null, visibility: "public", moderation_status: "approved", processing_status: "removed", updated_at: "2026-05-07T00:00:00.000Z" },
    ],
    buddy_services: [
      { id: SVC_LIVE, buddy_id: BOB, category: "food", title: "Street-food crawl", description: null, hourly_rate_usd: 18, is_active: true, approved: true, updated_at: "2026-05-01T00:00:00.000Z" },
      { id: SVC_UNAPPROVED, buddy_id: BOB, category: "food", title: "Not reviewed yet", description: null, hourly_rate_usd: 18, is_active: true, approved: false, updated_at: "2026-05-02T00:00:00.000Z" },
      { id: SVC_PAUSED, buddy_id: BOB, category: "food", title: "Paused listing", description: null, hourly_rate_usd: 18, is_active: false, approved: true, updated_at: "2026-05-03T00:00:00.000Z" },
    ],
    rent_buddy_bookings: [],
    trip_members: [
      { trip_id: TRIP_SHARED, user_id: ALICE, status: "accepted" },
      { trip_id: TRIP_SHARED, user_id: BOB, status: "accepted" },
      { trip_id: TRIP_OTHER, user_id: BOB, status: "accepted" },
    ],
  };
}

/**
 * The same shape as `telegraphShare.test.ts`'s client, deliberately: these
 * loaders must fail closed against the identical injected-error mechanism the
 * older families are held to, and copying the harness is how that stays true
 * when one of the two files is edited.
 */
function makeClient(state: State) {
  const db = fixture();

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const err = () =>
      state.errorTable === table ? { message: `injected failure on ${table}`, code: "XX000" } : null;

    const target: any = {
      select() { return proxy; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return proxy; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return proxy; },
      in(col: string, vals: any[]) { filters.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      single() {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e });
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const e = err();
        if (e) return Promise.resolve({ data: null, error: e, count: null }).then(resolve, reject);
        return Promise.resolve({ data: rowsNow(), error: null }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return { from, _db: db };
}

async function resolveOne(state: State, objectType: any, objectId: string, viewer: string) {
  const c = makeClient(state);
  const [r] = await resolveShareProjections(c as any, viewer, THREAD, [{ objectType, objectId }]);
  return r!;
}

// ── §5's five families, all present ──────────────────────────────────────────

describe("§5 — every object family the spec names has a loader", () => {
  it("Social: profile, post, Highlight, Memory, Memory Note, Stamp", () => {
    for (const t of ["PROFILE", "POST", "HIGHLIGHT", "MEMORY", "MEMORY_NOTE", "STAMP"]) {
      assert.ok(isShareable(t), `${t} is named by §5's Social family and is not shareable`);
    }
  });

  it("Travel: Trip, Trip stage, plan, event, route, reservation, layover plan", () => {
    for (const t of ["TRIP", "TRIP_STAGE", "PLAN", "EVENT", "ROUTE", "RESERVATION", "LAYOVER_PLAN"]) {
      assert.ok(isShareable(t), `${t} is named by §5's Travel family and is not shareable`);
    }
  });

  it("Places: place, Hidden Gem, map pin, neighborhood, meetup point", () => {
    for (const t of ["PLACE", "HIDDEN_GEM", "MAP_PIN", "NEIGHBORHOOD", "MEETUP_POINT"]) {
      assert.ok(isShareable(t), `${t} is named by §5's Places family and is not shareable`);
    }
  });

  it("Services: a Buddy service resolves against buddy_services, not against a booking", async () => {
    // The registry pointed BUDDY_SERVICE at the BOOKING loader, so a real
    // service id read `rent_buddy_bookings`, found nothing, and answered
    // not_found. `isShareable` said yes and the family could not be shared.
    assert.ok(isShareable("BUDDY_SERVICE"));
    const r = await resolveOne({}, "BUDDY_SERVICE", SVC_LIVE, ALICE);
    assert.equal(
      r.available, true,
      "EXPECTED: the listing resolves. ACTUAL: " + JSON.stringify(r) +
        " — a service id is being looked up as a booking id.",
    );
    assert.equal(r.available === true && r.projection.title, "Street-food crawl");
  });

  it("an unapproved listing is not handed to a stranger, and a paused one degrades", async () => {
    const unapproved = await resolveOne({}, "BUDDY_SERVICE", SVC_UNAPPROVED, ALICE);
    assert.equal(unapproved.available, false);
    assert.equal(unapproved.available === false && unapproved.reason, "unauthorized");
    const paused = await resolveOne({}, "BUDDY_SERVICE", SVC_PAUSED, ALICE);
    assert.equal(paused.available, false);
    assert.equal(paused.available === false && paused.reason, "deleted");
    const mine = await resolveOne({}, "BUDDY_SERVICE", SVC_PAUSED, BOB);
    assert.equal(mine.available, true, "the buddy still sees their own paused listing");
  });

  it("an unreadable buddy_services degrades with 'unknown'", async () => {
    const r = await resolveOne({ errorTable: "buddy_services" }, "BUDDY_SERVICE", SVC_LIVE, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });

  it("Media: the fifth family, which had no member in the vocabulary at all", () => {
    assert.ok(isShareable("MEDIA"), "MEDIA is not shareable");
  });

  it("the families with no client screen are DECLARED, not discovered", () => {
    const root = SHAREABLE_OBJECT_TYPES.filter((t) => deepLinkFor(t, "x") === "/");
    assert.deepEqual(
      [...root].sort(),
      [...FAMILIES_WITH_NO_CLIENT_SCREEN].sort(),
      "a shareable family whose deep link is the app root must be listed in FAMILIES_WITH_NO_CLIENT_SCREEN",
    );
  });

  it("the new families' deep links are routes travel-buddy-standalone/app actually has", () => {
    assert.equal(deepLinkFor("ROUTE", "r1"), "/route/r1");
    assert.equal(deepLinkFor("LAYOVER_PLAN", "l1"), "/layover/l1");
    assert.equal(deepLinkFor("MEDIA", "m1"), "/media-viewer/m1");
    assert.equal(deepLinkFor("STAMP", "s1"), "/stamp/s1");
  });
});

// ── Highlight: the family that expires by itself ─────────────────────────────

describe("§5.3 Highlight — a source can become unavailable with nobody acting", () => {
  it("a live public Highlight resolves", async () => {
    const r = await resolveOne({}, "HIGHLIGHT", HL_LIVE, ALICE);
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.title, "Sunset from the roof");
  });

  it("AN EXPIRED HIGHLIGHT DEGRADES, and carries nothing", async () => {
    const r = await resolveOne({}, "HIGHLIGHT", HL_EXPIRED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
    assert.equal(r.projection, null);
    assert.deepEqual(r.actions, []);
    assert.ok(!JSON.stringify(r).includes("Yesterday"), "the expired Highlight's caption is still in the response");
    assert.ok(!JSON.stringify(r).includes("h2.jpg"), "the expired Highlight's asset is still addressable");
  });

  it("an UNPARSEABLE expiry is 'unknown', never 'not expired'", async () => {
    const r = await resolveOne({}, "HIGHLIGHT", HL_UNDATED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });

  it("a circle_only Highlight degrades rather than being approximated", async () => {
    const r = await resolveOne({}, "HIGHLIGHT", HL_CIRCLE, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    const mine = await resolveOne({}, "HIGHLIGHT", HL_CIRCLE, BOB);
    assert.equal(mine.available, true, "its owner still sees it");
  });

  it("an ARCHIVED Highlight degrades — archiving is not the same column as deleting", async () => {
    const r = await resolveOne({}, "HIGHLIGHT", HL_ARCHIVED, BOB);
    assert.equal(r.available, false, "its own owner must not see an archived Highlight as live");
    assert.equal(r.available === false && r.reason, "deleted");
    assert.ok(!JSON.stringify(r).includes("h5.jpg"));
  });

  it("an unreadable highlights table degrades with 'unknown'", async () => {
    const r = await resolveOne({ errorTable: "highlights" }, "HIGHLIGHT", HL_LIVE, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });
});

// ── Stamp ────────────────────────────────────────────────────────────────────

describe("§5 Stamp — an award that can be taken back", () => {
  it("a public stamp resolves, titled from its definition", async () => {
    const r = await resolveOne({}, "STAMP", STAMP_PUBLIC, ALICE);
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.title, "First Perfume River crossing");
    assert.equal(r.available === true && r.projection.subtitle, "Hue, VN");
  });

  it("A REVOKED STAMP DEGRADES", async () => {
    const r = await resolveOne({}, "STAMP", STAMP_REVOKED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
    assert.equal(r.projection, null);
  });

  it("a stamp its owner hid from their passport is not handed to anybody else", async () => {
    const r = await resolveOne({}, "STAMP", STAMP_HIDDEN, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    const mine = await resolveOne({}, "STAMP", STAMP_HIDDEN, BOB);
    assert.equal(mine.available, true, "its owner still sees it");
  });

  it("a PRIVATE stamp degrades even though its owner shows it on their passport", async () => {
    const r = await resolveOne({}, "STAMP", STAMP_PRIVATE, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    assert.ok(!JSON.stringify(r).includes("Private award"));
  });

  it("an unreadable DEFINITION is 'unknown', not an untitled stamp", async () => {
    const r = await resolveOne({ errorTable: "stamp_definitions" }, "STAMP", STAMP_PUBLIC, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });

  it("an unreadable user_stamps table degrades with 'unknown'", async () => {
    const r = await resolveOne({ errorTable: "user_stamps" }, "STAMP", STAMP_PUBLIC, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });
});

// ── neighborhood ─────────────────────────────────────────────────────────────

describe("§5 neighborhood — derived public reference data", () => {
  it("resolves for anyone, and says how confident it is", async () => {
    const r = await resolveOne({}, "NEIGHBORHOOD", HOOD, ALICE);
    assert.equal(r.available, true);
    assert.equal(r.status, "high");
    assert.equal(r.available === true && r.projection.title, "Old town");
    assert.equal(r.available === true && r.projection.subtitle, "Hue, VN");
  });

  it("a neighborhood that does not exist is not invented", async () => {
    const r = await resolveOne({}, "NEIGHBORHOOD", "cc330000-0000-4000-8000-00000000ffff", ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "not_found");
  });

  it("an unreadable neighborhood_areas degrades with 'unknown'", async () => {
    const r = await resolveOne({ errorTable: "neighborhood_areas" }, "NEIGHBORHOOD", HOOD, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });
});

// ── route ────────────────────────────────────────────────────────────────────

describe("§5 route — membership is the route's own, not the trip's", () => {
  it("a route the viewer was added to resolves", async () => {
    const r = await resolveOne({}, "ROUTE", ROUTE_SHARED, ALICE);
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.title, "Riverside walk");
  });

  it("a DRAFT route degrades for everybody but its owner", async () => {
    const r = await resolveOne({}, "ROUTE", ROUTE_DRAFT, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    assert.ok(!JSON.stringify(r).includes("Unfinished"));
    const mine = await resolveOne({}, "ROUTE", ROUTE_DRAFT, BOB);
    assert.equal(mine.available, true, "its owner still sees it");
  });

  it("a route the viewer is not a member of degrades as UNAUTHORIZED", async () => {
    const r = await resolveOne({}, "ROUTE", ROUTE_STRANGER, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unauthorized");
  });

  it("a cancelled route degrades for its owner too", async () => {
    const r = await resolveOne({}, "ROUTE", ROUTE_CANCELLED, BOB);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
  });

  it("an unreadable route_plan_members degrades with 'unknown', never with access", async () => {
    const r = await resolveOne({ errorTable: "route_plan_members" }, "ROUTE", ROUTE_SHARED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });
});

// ── reservation: the SAFE derivative ─────────────────────────────────────────

describe("§5 reservation — the derivative is safe or it is not shared", () => {
  it("the owner's own reservation resolves", async () => {
    const r = await resolveOne({}, "RESERVATION", RES_MINE, ALICE);
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.title, "SGN → HUI");
  });

  it("THE CONFIRMATION REFERENCE IS NOWHERE IN THE RESOLVED SHARE", async () => {
    const r = await resolveOne({}, "RESERVATION", RES_MINE, ALICE);
    assert.equal(r.available, true);
    // Not "the subtitle does not contain it" — the WHOLE resolved reference is
    // scanned, so a leak through any key, now or later, fails here.
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(CONFIRMATION), `the booking reference leaked: ${serialized}`);
    assert.ok(!serialized.includes("MS A NGUYEN"), "the raw confirmation email leaked");
    assert.ok(!serialized.includes("pnr"), "the extraction leaked");
  });

  it("a trip-mate's reservation resolves, and still carries no reference", async () => {
    const r = await resolveOne({}, "RESERVATION", RES_TRIP, ALICE);
    assert.equal(r.available, true);
    assert.ok(!JSON.stringify(r).includes(CONFIRMATION), "the booking reference leaked to a trip-mate");
  });

  it("a reservation on a trip the viewer is not on degrades", async () => {
    const r = await resolveOne({}, "RESERVATION", RES_STRANGER, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unauthorized");
    assert.ok(!JSON.stringify(r).includes("Somebody else's tour"));
  });

  it("a DISMISSED reservation degrades for its own owner", async () => {
    const r = await resolveOne({}, "RESERVATION", RES_DISMISSED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
  });

  it("an unreadable trip_members degrades with 'unknown', never with access", async () => {
    const r = await resolveOne({ errorTable: "trip_members" }, "RESERVATION", RES_TRIP, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });
});

// ── layover plan ─────────────────────────────────────────────────────────────

describe("§5 layover plan", () => {
  it("the traveller's own layover resolves", async () => {
    const r = await resolveOne({}, "LAYOVER_PLAN", LAY_MINE, ALICE);
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.title, "Layover in Singapore");
  });

  it("a trip-mate's layover resolves through the trip", async () => {
    const r = await resolveOne({}, "LAYOVER_PLAN", LAY_TRIP, ALICE);
    assert.equal(r.available, true);
  });

  it("a layover with NO trip is private to its traveller", async () => {
    const r = await resolveOne({}, "LAYOVER_PLAN", LAY_SOLO, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
  });

  it("an expired layover degrades", async () => {
    const r = await resolveOne({}, "LAYOVER_PLAN", LAY_EXPIRED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
  });

  it("a cancelled layover degrades for its own traveller", async () => {
    const r = await resolveOne({}, "LAYOVER_PLAN", LAY_CANCELLED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
  });

  it("an unreadable layover_sessions degrades with 'unknown'", async () => {
    const r = await resolveOne({ errorTable: "layover_sessions" }, "LAYOVER_PLAN", LAY_MINE, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });
});

// ── Media: §5's fifth family ─────────────────────────────────────────────────

describe("§5 Media — the fifth family, and what 'inherit' has to mean", () => {
  it("a public approved asset resolves", async () => {
    const r = await resolveOne({}, "MEDIA", MEDIA_PUBLIC, ALICE);
    assert.equal(r.available, true);
    assert.equal(r.available === true && r.projection.title, "The alley");
    assert.equal(r.available === true && r.projection.imageUrl, "https://x/m1t.jpg");
  });

  it("VISIBILITY 'inherit' DEGRADES rather than resolving permissively", async () => {
    const r = await resolveOne({}, "MEDIA", MEDIA_INHERIT, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "private");
    assert.ok(!JSON.stringify(r).includes("m2.jpg"), "the asset behind an unresolved visibility is addressable");
    const mine = await resolveOne({}, "MEDIA", MEDIA_INHERIT, BOB);
    assert.equal(mine.available, true, "its owner still sees it");
  });

  it("an asset under moderation review is not handed to a third party", async () => {
    const r = await resolveOne({}, "MEDIA", MEDIA_FLAGGED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unauthorized");
    assert.ok(!JSON.stringify(r).includes("m3.mp4"));
  });

  it("the owner sees their own not-yet-moderated upload", async () => {
    const r = await resolveOne({}, "MEDIA", MEDIA_MINE, ALICE);
    assert.equal(r.available, true);
  });

  it("a REJECTED asset degrades for its own owner", async () => {
    const r = await resolveOne({}, "MEDIA", MEDIA_REJECTED, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "deleted");
    assert.ok(!JSON.stringify(r).includes("m5.jpg"));
  });

  it("REMOVED is 'deleted' and UPLOADING is 'unknown' — the two are different claims", async () => {
    // Both are "not renderable". Only one of them means the asset is gone, and a
    // client that shows "this was taken down" for an upload still in flight is
    // wrong in a way the reader can see. Without this case the whole
    // terminal-state check is decoration: deleting it leaves every other test
    // green, because `processing !== "ready"` below catches the same rows.
    const removed = await resolveOne({}, "MEDIA", MEDIA_REMOVED, ALICE);
    assert.equal(removed.available, false);
    assert.equal(removed.available === false && removed.reason, "deleted");
  });

  it("an asset that is not finished processing is 'unknown', not a broken card", async () => {
    const r = await resolveOne({}, "MEDIA", MEDIA_PROCESSING, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });

  it("an unreadable media_assets degrades with 'unknown'", async () => {
    const r = await resolveOne({ errorTable: "media_assets" }, "MEDIA", MEDIA_PUBLIC, ALICE);
    assert.equal(r.available, false);
    assert.equal(r.available === false && r.reason, "unknown");
  });
});

// ── the contract still holds over the new families ───────────────────────────

describe("§5.1 — the new families answer the same contract as the old ones", () => {
  it("every new family implements all five capabilities", () => {
    const c = makeClient({});
    for (const t of ["HIGHLIGHT", "STAMP", "NEIGHBORHOOD", "ROUTE", "RESERVATION", "LAYOVER_PLAN", "MEDIA"] as const) {
      const s = shareableFor(c as any, t, HOOD);
      assert.ok(s, `${t} has no shareable`);
      assert.equal(typeof s!.getSharePreview, "function");
      assert.equal(typeof s!.getCurrentState, "function");
      assert.equal(typeof s!.getAvailableActions, "function");
      assert.equal(typeof s!.getDeepLink, "function");
      assert.equal(typeof s!.getSearchBehaviour, "function");
    }
  });

  it("an unavailable new-family reference offers no actions", async () => {
    for (const [t, id] of [
      ["HIGHLIGHT", HL_EXPIRED],
      ["STAMP", STAMP_REVOKED],
      ["ROUTE", ROUTE_DRAFT],
      ["RESERVATION", RES_STRANGER],
      ["LAYOVER_PLAN", LAY_SOLO],
      ["MEDIA", MEDIA_INHERIT],
    ] as const) {
      const r = await resolveOne({}, t, id, ALICE);
      assert.equal(r.available, false, `${t} should be unavailable in this fixture`);
      assert.deepEqual(r.actions, [], `${t} offered actions on an unavailable reference`);
      assert.equal(r.projection, null, `${t} carried a projection on an unavailable reference`);
    }
  });
});

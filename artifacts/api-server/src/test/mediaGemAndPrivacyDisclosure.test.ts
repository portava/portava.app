/**
 * mediaGemAndPrivacyDisclosure — the Media v2 location/gem choke point, applied
 * to the THREE surfaces that were bypassing it (Media v2 audit H1 + H2).
 *
 * The choke point (lib/mediaLocationVisibility.resolveMediaLocationWithGemProtection)
 * was applied on the older surfaces — routes/mediaFeed.ts, routes/posts.ts,
 * routes/memories.ts — but the World shell (routes/mediaWorld.ts, 7 endpoints),
 * the action rail (services/media/MediaActionResolver) and the Compass media
 * adapter (compass/CompassMediaContext) never called it. Two HIGH leaks followed
 * from that one omission, and both are REPRODUCED here before being asserted
 * closed:
 *
 *   H1  A `protected` / reveal-gated Hidden Gem was resolved by
 *       `canonical_place_id` with NO sensitivity check and returned as
 *       `{kind:'gem', id, label:<gem name>}` — then printed into the Compass
 *       prompt. Any viewer of ANY public photo taken at the gem's place learned
 *       the protected gem's id and NAME, which de-anonymizes its location just as
 *       surely as handing out its coordinates.
 *
 *   H2  Every World-shell projection copied `location_name` (the VENUE) and
 *       `canonical_place_id` verbatim, ignoring both the owner's
 *       `location_privacy_mode` and a restrictive gem's 'city' ceiling. The
 *       certification claim that "place-level only" is safe is false: place-level
 *       IS the venue.
 *
 * MUTATION PROOF — each assertion below names the single line whose removal
 * turns it red:
 *   • `mayDiscloseGemIdentity`'s `status === 'active' && sensitivity_level ===
 *     'public'` (HiddenGemPrivacyGuard) — relax it and the protected-gem tests go red.
 *   • `mayDisclosePlaceId = d.visibility === 'place'` (mediaLocationVisibility)
 *     — return `true` unconditionally and the place-id tests go red.
 *   • `locationPrivacyModeToCeiling`'s default arm returning 'city' — return
 *     `null` and the fail-closed + unknown-mode tests go red.
 *   • `disclosureForRow`'s `gem: { ceiling, determined }` (MediaProjectionService)
 *     — pass `{ceiling: null, determined: true}` and the gem-ceiling tests go red.
 *   • `applyLocationDisclosure` in `projectCandidatesProtected` — drop the call
 *     (project raw) and every World-shell test goes red.
 *
 * Fake Supabase clients only — no DB, no network, no HTTP listen.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaGemAndPrivacyDisclosure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  locationPrivacyModeToCeiling,
  resolveMediaPlaceDisclosure,
  toGemProtection,
  POST_LOCATION_PRIVACY_MODES,
} from "../lib/mediaLocationVisibility.js";
import { mayDiscloseGemIdentity } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import { mapPublicPost } from "../lib/postSchemas.js";
import { isLocationSafe } from "../lib/media/mediaLocationSafety.js";
import {
  resolveViewer,
  buildWorldProjection,
  buildPlaceProjection,
  buildPeopleProjection,
  buildMyWorldProjection,
  buildTimelineProjection,
  buildMediaMapProjection,
} from "../services/media/MediaProjectionService.js";
import { resolveExperience } from "../services/media/MediaExperienceResolver.js";
import { resolveMediaActions, resolveMediaEntities } from "../services/media/MediaActionResolver.js";
import { buildCompassMediaContext, formatMediaContextLines } from "../compass/CompassMediaContext.js";

// ── A capable, filtering fake Supabase client ────────────────────────────────

type Dataset = Record<string, any[]>;

/** Tables listed in `errorTables` answer with a PostgREST-shaped error. */
function makeSc(data: Dataset, errorTables: string[] = []) {
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
      } else if (f.op === "gt") rows = rows.filter((r) => r[f.col] != null && r[f.col] > f.val);
    }
    return rows;
  };

  const builder = (table: string): any => {
    const filters: any[] = [];
    const failed = errorTables.includes(table);
    const result = () =>
      failed
        ? { data: null, error: { message: `simulated ${table} failure`, code: "XX000" } }
        : { data: resolveRows(table, filters), error: null };
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      neq(col: string, val: any) { filters.push({ op: "neq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      gt(col: string, val: any) { filters.push({ op: "gt", col, val }); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      upsert(payload: any) { return Promise.resolve({ data: payload, error: null }); },
      insert(payload: any) { return Promise.resolve({ data: payload, error: null }); },
      maybeSingle() {
        const r = result();
        return Promise.resolve({ data: r.error ? null : (r.data as any[])[0] ?? null, error: r.error });
      },
      single() {
        const r = result();
        return Promise.resolve({ data: r.error ? null : (r.data as any[])[0] ?? null, error: r.error });
      },
      then(onF: any, onR: any) { return Promise.resolve(result()).then(onF, onR); },
    };
    return b;
  };

  return { from(table: string) { return builder(table); } } as any;
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR_A = "22222222-2222-2222-2222-222222222222";
const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MEDIA_1 = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const GEM_1 = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const TRIP_1 = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const VENUE = "An Thuong Bar";
const CITY = "Da Nang";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function makePost(o: Record<string, any> = {}): any {
  const id = o.id ?? MEDIA_1;
  const author = o.author_id ?? AUTHOR_A;
  return {
    id,
    author_id: author,
    trip_id: o.trip_id ?? null,
    content: "",
    visibility: o.visibility ?? "public",
    status: "active",
    post_status: o.post_status === undefined ? "published" : o.post_status,
    created_at: o.created_at ?? isoAgo(10 * 60 * 1000),
    category: "nightlife",
    media_urls: [],
    location_name: VENUE,
    location_city: CITY,
    location_country: "Vietnam",
    location_privacy_mode: o.location_privacy_mode ?? "none",
    canonical_place_id: o.canonical_place_id === undefined ? PLACE_1 : o.canonical_place_id,
    // The posts row carries precise coordinates the projection must NEVER read.
    location_lat: 16.0544,
    location_lng: 108.2497,
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
}

function baseData(extra: Dataset = {}): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [],
    user_mutes: [],
    user_follows: [],
    trip_members: [],
    trips: [],
    hidden_gems: [],
    feature_flags: [],
    intel_state_snapshots: [],
    intel_live_promoted_scopes: [],
    ...extra,
  };
}

/** A gem row shaped like the live table (sensitivity_level NOT NULL, 0043). */
function gem(sensitivity: string, over: Record<string, any> = {}): any {
  return {
    id: GEM_1,
    name: "Quiet cove",
    status: "active",
    sensitivity_level: sensitivity,
    canonical_place_id: PLACE_1,
    city: CITY,
    latitude: 16.0544,
    longitude: 108.2497,
    approx_latitude: null,
    approx_longitude: null,
    submitted_by: AUTHOR_A,
    ...over,
  };
}

/** Every leak here is about NAMING a place: assert the venue name is gone. */
function assertNoVenue(payload: unknown, what: string): void {
  assert.equal(
    JSON.stringify(payload).includes(VENUE),
    false,
    `${what}: the venue name must not appear anywhere in the response`,
  );
}

function assertNoPlaceId(payload: unknown, what: string): void {
  assert.equal(
    JSON.stringify(payload).includes(PLACE_1),
    false,
    `${what}: the canonical place id must not appear anywhere in the response`,
  );
}

// ── 0. The predicates, in isolation ─────────────────────────────────────────

describe("mayDiscloseGemIdentity — the gem NAME/ID gate (mirrors hidden_gems_public_read)", () => {
  it("discloses only an ACTIVE, PUBLIC gem", () => {
    assert.equal(mayDiscloseGemIdentity(gem("public"), VIEWER), true);
    assert.equal(mayDiscloseGemIdentity(gem("public", { status: "pending" }), VIEWER), false);
  });

  it("never discloses a protected / reveal-gated / approximate gem to a stranger", () => {
    for (const s of ["protected", "reveal_after_save", "reveal_after_acceptance", "approximate"]) {
      assert.equal(mayDiscloseGemIdentity(gem(s), VIEWER), false, `${s} must not be disclosed`);
    }
  });

  it("FAILS CLOSED on an absent / unrecognised sensitivity or status", () => {
    assert.equal(mayDiscloseGemIdentity({ id: GEM_1, status: "active" }, VIEWER), false, "undetermined sensitivity");
    assert.equal(mayDiscloseGemIdentity(gem("weird_new_level"), VIEWER), false, "unknown sensitivity");
    assert.equal(mayDiscloseGemIdentity({ id: GEM_1, sensitivity_level: "public" }, VIEWER), false, "undetermined status");
    assert.equal(mayDiscloseGemIdentity(null, VIEWER), false, "no gem row");
  });

  it("the gem's own submitter still sees it", () => {
    assert.equal(mayDiscloseGemIdentity(gem("protected", { submitted_by: VIEWER }), VIEWER), true);
  });
});

describe("locationPrivacyModeToCeiling — one policy with mapPublicPost", () => {
  it("agrees with mapPublicPost on EVERY enum value (drift guard)", () => {
    for (const mode of [...POST_LOCATION_PRIVACY_MODES, null, undefined]) {
      for (const postStatus of ["published", "pending_location_exit", null]) {
        const row = { id: "p", location_name: VENUE, location_privacy_mode: mode, post_status: postStatus };
        const redactsName = mapPublicPost({ ...row }).location_name == null;
        const ceiling = locationPrivacyModeToCeiling(mode as any, postStatus);
        assert.equal(
          ceiling != null,
          redactsName,
          `mode=${String(mode)} status=${String(postStatus)}: ceiling and mapPublicPost must agree`,
        );
      }
    }
  });

  it("is never LOOSER than mapPublicPost, and fails closed where mapPublicPost does not", () => {
    // mapPublicPost's fallthrough returns an unknown mode unchanged once the
    // post is published (the DB enum makes that unreachable today). The tier
    // table must not inherit that: an unrecognised mode coarsens regardless.
    const published = { id: "p", location_name: VENUE, location_privacy_mode: "some_future_mode", post_status: "published" };
    assert.equal(mapPublicPost({ ...published }).location_name, VENUE, "documents mapPublicPost's actual behaviour");
    assert.equal(locationPrivacyModeToCeiling("some_future_mode", "published"), "city", "the tier table fails closed");
  });

  it("'none' / absent constrains nothing; every redacting mode caps at city", () => {
    assert.equal(locationPrivacyModeToCeiling("none"), null);
    assert.equal(locationPrivacyModeToCeiling(null), null);
    assert.equal(locationPrivacyModeToCeiling("city_only"), "city");
    assert.equal(locationPrivacyModeToCeiling("hidden"), "city");
    assert.equal(locationPrivacyModeToCeiling("trusted_circle_only"), "city");
    // Delayed modes stay suppressed until the publisher releases the post.
    assert.equal(locationPrivacyModeToCeiling("delayed_until_exit", "pending_location_exit"), "city");
    assert.equal(locationPrivacyModeToCeiling("delayed_until_exit", "published"), null);
  });
});

describe("resolveMediaPlaceDisclosure — the canonical place id rides the venue tier", () => {
  const at = { name: VENUE, city: CITY, country: "Vietnam", lat: 16.0544, lng: 108.2497 };

  it("unconstrained non-owner keeps place level (and may be given the place id)", () => {
    const d = resolveMediaPlaceDisclosure(at, {
      isOwner: false,
      locationVisibility: "place",
      locationPrivacyMode: "none",
      gem: toGemProtection(null, true),
    });
    assert.equal(d.name, VENUE);
    assert.equal(d.mayDisclosePlaceId, true);
    assert.equal(d.coordsAreExact, false, "a non-owner never gets the exact coordinate");
  });

  it("owner privacy mode alone coarsens to city AND withholds the place id", () => {
    const d = resolveMediaPlaceDisclosure(at, {
      isOwner: false,
      locationVisibility: "place",
      locationPrivacyMode: "city_only",
      gem: toGemProtection(null, true),
    });
    assert.equal(d.name, null, "venue name dropped");
    assert.equal(d.city, CITY, "city survives");
    assert.equal(d.mayDisclosePlaceId, false, "place id is a place-LEVEL identifier");
  });

  it("a gem ceiling alone coarsens to city AND withholds the place id", () => {
    const d = resolveMediaPlaceDisclosure(at, {
      isOwner: false,
      locationVisibility: "place",
      locationPrivacyMode: "none",
      gem: toGemProtection("city", true),
    });
    assert.equal(d.name, null);
    assert.equal(d.mayDisclosePlaceId, false);
  });

  it("UNDETERMINED gem protection fails closed even with no privacy mode", () => {
    const d = resolveMediaPlaceDisclosure(at, {
      isOwner: false,
      locationVisibility: "place",
      locationPrivacyMode: "none",
      gem: toGemProtection(null, /* determined */ false),
    });
    assert.equal(d.visibility, "city", "undetermined ⇒ coarsen to the fail-closed ceiling");
    assert.equal(d.name, null);
    assert.equal(d.mayDisclosePlaceId, false);
  });

  it("the OWNER of the media still sees their own venue", () => {
    const d = resolveMediaPlaceDisclosure(at, {
      isOwner: true,
      locationVisibility: "place",
      locationPrivacyMode: "city_only",
      gem: toGemProtection("city", true),
    });
    assert.equal(d.name, VENUE);
    assert.equal(d.mayDisclosePlaceId, true);
  });
});

// ── 1. H1 — the action rail and the Compass context ─────────────────────────

describe("H1 — a protected gem is never named or id-exposed (action rail)", () => {
  for (const sensitivity of ["protected", "reveal_after_acceptance", "reveal_after_save"]) {
    it(`no gem ref for a '${sensitivity}' gem at the media's place`, async () => {
      const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem(sensitivity)] }));
      const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
      const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
      assert.ok(result, "the media itself is still visible");
      assert.equal(
        result!.entityRefs.some((r) => r.kind === "gem"),
        false,
        "no gem ref at all — not the id, not the name",
      );
      assert.equal(JSON.stringify(result).includes(GEM_1), false, "the gem id must not appear anywhere");
      assert.equal(JSON.stringify(result).includes("Quiet cove"), false, "the gem name must not appear anywhere");
      // …and the gem's ceiling also coarsens the media's own place labels.
      assertNoVenue(result, "action rail");
      assertNoPlaceId(result, "action rail");
    });
  }

  it("a public, active gem IS still surfaced (the fix is not a blanket suppression)", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("public")] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    const gemRef = result!.entityRefs.find((r) => r.kind === "gem");
    assert.ok(gemRef, "a public gem still resolves");
    assert.equal(gemRef!.id, GEM_1);
    assert.equal(isLocationSafe(result), true, "still no coordinate anywhere");
  });

  it("FAIL CLOSED: an undetermined sensitivity yields no gem ref", async () => {
    // A row missing the (NOT NULL, but defensively handled) sensitivity column.
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        hidden_gems: [{ id: GEM_1, name: "Quiet cove", status: "active", canonical_place_id: PLACE_1 }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    assert.equal(result!.entityRefs.some((r) => r.kind === "gem"), false);
    assert.equal(JSON.stringify(result).includes("Quiet cove"), false);
  });

  it("a protected gem removes the place-bound actions rather than pointing at it", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("protected")] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const result = await resolveMediaActions(sc, viewer, MEDIA_1, Date.now());
    const ids = result!.actions.map((a) => a.id);
    assert.equal(ids.includes("show_on_map"), false, "no place-bound navigation to a withheld place");
    // The item is still actionable in ways that disclose nothing.
    for (const id of ["report", "share_telegraph", "save", "i_want_this"]) {
      assert.ok(ids.includes(id as any), `${id} still offered`);
    }
  });
});

describe("H1 — the Compass media context never prints a protected gem", () => {
  it("no gem ref, no gem name, no venue in the prompt lines", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("protected")] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const ctx = await buildCompassMediaContext(sc, viewer, MEDIA_1, Date.now());
    assert.ok(ctx, "context still built for a visible item");
    assert.equal(ctx!.entityRefs.some((r) => r.kind === "gem"), false, "no gem ref reaches the prompt");
    const prompt = formatMediaContextLines(ctx!).join("\n");
    assert.equal(prompt.includes("Quiet cove"), false, "the gem is never named to the model");
    assert.equal(prompt.includes(GEM_1), false, "the gem id is never given to the model");
    assert.equal(prompt.includes(VENUE), false, "nor the venue that would locate it");
    assert.equal(prompt.includes(PLACE_1), false, "nor the canonical place that resolves to it");
    // The coarse city is still safe context.
    assert.equal(prompt.includes(CITY), true, "city-level context survives");
  });

  it("a public gem still reaches the Compass context", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("public")] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const ctx = await buildCompassMediaContext(sc, viewer, MEDIA_1, Date.now());
    assert.ok(ctx!.entityRefs.some((r) => r.kind === "gem" && r.id === GEM_1));
  });
});

// ── 2. H2 — the World shell honours the owner and the gem ceiling ───────────

describe("H2 — an owner who hid the exact place is honoured on every World endpoint", () => {
  const HIDDEN_EXACT = { location_privacy_mode: "city_only" };

  it("GET /media/world", async () => {
    const sc = makeSc(baseData({ posts: [makePost(HIDDEN_EXACT)] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(sc, viewer, CITY, Date.now());
    assert.equal(p.totalPerspectives, 1, "the media is still served — only its location coarsens");
    assertNoVenue(p, "/media/world");
    assertNoPlaceId(p, "/media/world");
    assert.equal(p.cityVisualState[0].label, CITY, "the zone falls back to the city label");
  });

  it("GET /media/places/:placeId", async () => {
    const sc = makeSc(baseData({ posts: [makePost(HIDDEN_EXACT)] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildPlaceProjection(sc, viewer, PLACE_1, Date.now());
    // The place id is the caller's own path param, so it is echoed; what must
    // NOT happen is a hidden-exact post donating the venue NAME to it.
    assertNoVenue(p, "/media/places/:placeId");
  });

  it("GET /media/people", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost(HIDDEN_EXACT)],
        user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildPeopleProjection(sc, viewer, Date.now());
    assert.equal(p.totalPerspectives, 1);
    assert.equal(p.people[0].media[0].placeLabel, null, "venue withheld");
    assert.equal(p.people[0].media[0].placeId, null, "canonical place id withheld");
    assert.equal(p.people[0].media[0].city, CITY, "city survives");
    assertNoVenue(p, "/media/people");
    assertNoPlaceId(p, "/media/people");
  });

  it("GET /media/timeline", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost(HIDDEN_EXACT)],
        user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const p = await buildTimelineProjection(sc, viewer, { placeId: null, nowMs: Date.now() });
    assert.equal(p.totalPerspectives, 1);
    assertNoVenue(p, "/media/timeline");
    assertNoPlaceId(p, "/media/timeline");
  });

  it("GET /media/map", async () => {
    const sc = makeSc(baseData({ posts: [makePost(HIDDEN_EXACT)] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildMediaMapProjection(sc, viewer, CITY, Date.now());
    assertNoVenue(p, "/media/map");
    assertNoPlaceId(p, "/media/map");
    assert.deepEqual(p.clusters, [], "a place-less item cannot be positioned, so it is omitted");
  });

  it("GET /media/experiences/:id", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ ...HIDDEN_EXACT, trip_id: TRIP_1 })],
        trips: [{ id: TRIP_1, title: "Da Nang week", owner_id: AUTHOR_A, visibility: "public" }],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await resolveExperience(sc, viewer, TRIP_1, Date.now());
    assert.ok(p, "a public trip still resolves");
    assert.equal(p!.perspectiveCount, 1);
    assertNoVenue(p, "/media/experiences/:id");
    assertNoPlaceId(p, "/media/experiences/:id");
    assert.deepEqual(p!.placeIds, [], "a withheld place contributes no place id to the experience");
  });

  it("GET /media/me — the OWNER still sees their own venue (owner bypass intact)", async () => {
    // The owner set city_only for OTHER people; their own library is not
    // redacted from them. This is the assertion that keeps the fix from being a
    // blanket blackout.
    const sc = makeSc(baseData({ posts: [makePost({ ...HIDDEN_EXACT, author_id: VIEWER })] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildMyWorldProjection(sc, viewer, Date.now());
    const all = p.buckets.find((b) => b.key === "all")!;
    assert.equal(all.count, 1);
    assert.equal(all.media[0].placeLabel, VENUE, "the owner sees the venue they chose");
    assert.equal(all.media[0].placeId, PLACE_1);
  });
});

describe("H2 — a restrictive gem's ceiling coarsens the World shell", () => {
  it("a protected gem at the place removes the venue and the place id from /media/world", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("protected")] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(sc, viewer, CITY, Date.now());
    assert.equal(p.totalPerspectives, 1, "the photo is still served");
    assertNoVenue(p, "gem ceiling / world");
    assertNoPlaceId(p, "gem ceiling / world");
  });

  it("an 'approximate' gem caps at neighborhood — still no venue, still no place id", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("approximate")] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(sc, viewer, CITY, Date.now());
    assertNoVenue(p, "approximate gem / world");
    assertNoPlaceId(p, "approximate gem / world");
  });

  it("a PUBLIC gem imposes no ceiling — the venue is still served", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("public")] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(sc, viewer, CITY, Date.now());
    assert.equal(p.cityVisualState[0].label, VENUE, "no constraint ⇒ nothing changes");
    assert.equal(p.cityVisualState[0].placeId, PLACE_1);
  });

  it("FAIL CLOSED: a gem lookup FAILURE coarsens every item, it does not mean 'no gems'", async () => {
    const sc = makeSc(baseData({ posts: [makePost()], hidden_gems: [gem("public")] }), ["hidden_gems"]);
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(sc, viewer, CITY, Date.now());
    assert.equal(p.totalPerspectives, 1, "the media still serves");
    assertNoVenue(p, "undetermined gem lookup / world");
    assertNoPlaceId(p, "undetermined gem lookup / world");
  });
});

// ── 3. The unconstrained path is unchanged (no over-coarsening) ─────────────

describe("no restrictive gem and no privacy mode ⇒ the World shell is unchanged", () => {
  it("serves the venue and the canonical place id exactly as before", async () => {
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const p = await buildWorldProjection(sc, viewer, CITY, Date.now());
    assert.equal(p.cityVisualState[0].label, VENUE);
    assert.equal(p.cityVisualState[0].placeId, PLACE_1);
    assert.equal(isLocationSafe(p), true, "and still no coordinate anywhere");
  });

  it("resolveMediaEntities still resolves the place ref", async () => {
    const sc = makeSc(baseData({ posts: [makePost()] }));
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const entities = await resolveMediaEntities(sc, viewer, makePost() as any, Date.now());
    assert.equal(entities.placeId, PLACE_1);
    assert.ok(entities.refs.some((r) => r.kind === "place" && r.label === VENUE));
  });
});

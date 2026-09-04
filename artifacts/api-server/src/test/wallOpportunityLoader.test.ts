/**
 * Wall — Rent-a-Buddy contextual-opportunity producer (spec §6/§19).
 *
 * Proves loadContextualOpportunityCandidates:
 *   • is FAIL-CLOSED on BOTH flags — `wall_rab_integration_enabled` OFF, the
 *     RAB master `rent_buddy_enabled` OFF, or an unreadable flag table each
 *     yield no opportunities;
 *   • honours the consolidated booking gate + city restrictions — a buddy in a
 *     city with no rollout row, a waitlist-only rollout, a disabled launch
 *     control, or an UNREADABLE restrictions table is dropped (fail-closed),
 *     while the positive control proves the gate does not over-block;
 *   • never surfaces a blocked buddy, the viewer themself, an expired
 *     "I'm Around" horizon, or a risk-held profile;
 *   • emits the right kind (buddy_dispatch for a followed/engaged buddy,
 *     buddy_around for a context-city buddy), populates PublicActorRef
 *     isBuddy/buddyRole, carries buddy experience media as social content, and
 *     NEVER a coordinate;
 *   • survives the Wall projection gate with a `book_buddy` action carrying
 *     only the coarse area.
 *
 * Run: node --import tsx/esm --test src/test/wallOpportunityLoader.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadContextualOpportunityCandidates,
  buddyRoleLabel,
  type OpportunityViewer,
} from "../services/wall/WallCandidateLoaders.js";
import { projectObjects } from "../services/wall/WallProjectionService.js";
import { invalidateGcCache } from "../routes/rentABuddyRollout.js";

const VIEWER = "viewer-1";
const NOW = Date.now();
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();

// ── Fake client state ─────────────────────────────────────────────────────────

interface State {
  flags: Record<string, boolean>;
  flagsThrow: boolean;
  buddyProfiles: any[];
  bookings: any[];
  profiles: Record<string, any>;
  cityRollouts: any[];
  launchControls: any[];
  cityRestrictions: any[];
  restrictionsError: boolean;
  blocks: Array<{ blocker_id: string; blocked_id: string }>;
}

function buddy(over: Partial<any> = {}): any {
  return {
    id: "bp-1",
    user_id: "buddy-user-1",
    display_name: "Minh (buddy row)",
    tagline: "Night markets and hidden bars",
    city: "Da Nang",
    country: "VN",
    categories: ["food", "city"],
    available_now: true,
    available_now_until: iso(2 * 60 * 60 * 1000),
    preferred_meetup_zones: ["An Thuong", "Han Riverside", "Extra Zone"],
    cover_photo_url: "profile-media/covers/buddy-user-1/cover.jpg",
    gallery_urls: ["profile-media/buddy-user-1/g1.jpg"],
    intro_video_url: null,
    buddy_level: "established",
    updated_at: iso(-60_000),
    status: "active",
    admin_status: "active",
    risk_hold: false,
    category_approvals: {},
    nightlife_admin_approved: false,
    verification_status: "verified",
    id_verified: true,
    phone_verified: true,
    // Private fields a careless select would leak — the loader must never read
    // these, and the fake exposes them so the assertion below is real.
    meetup_base_lat: 16.0544,
    meetup_base_lng: 108.2022,
    ...over,
  };
}

function freshState(): State {
  return {
    flags: { wall_rab_integration_enabled: true, rent_buddy_enabled: true },
    flagsThrow: false,
    buddyProfiles: [buddy()],
    bookings: [],
    profiles: {
      [VIEWER]: { id: VIEWER, display_name: "Viewer", username: "viewer", avatar_url: null, account_status: "active",
        date_of_birth: "1990-01-01", verification_status: "verified", id_verified_at: iso(-1), phone_verified_at: iso(-1) },
      "buddy-user-1": { id: "buddy-user-1", display_name: "Minh", username: "minh", avatar_url: "profile-media/avatars/buddy-user-1/a.jpg", account_status: "active" },
      "buddy-user-2": { id: "buddy-user-2", display_name: "Lan", username: "lan", avatar_url: null, account_status: "active" },
    },
    cityRollouts: [{ id: "cr-1", city: "Da Nang", status: "public_mvp" }, { id: "cr-2", city: "Bangkok", status: "public_mvp" }],
    launchControls: [],
    cityRestrictions: [],
    restrictionsError: false,
    blocks: [],
  };
}

let state: State;

function makeClient(): any {
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    const iss: Record<string, any> = {};
    const ilikes: Record<string, string> = {};
    let single = false;

    function resolve(): { data: any; error: any; count?: number } {
      if (table === "feature_flags") {
        if (state.flagsThrow) throw new Error("flags unavailable");
        const flag = String(eqs.flag);
        return { data: flag in state.flags ? { enabled: state.flags[flag] } : null, error: null };
      }
      if (table === "rent_buddy_profiles") {
        if (eqs.user_id !== undefined) {
          return { data: state.buddyProfiles.find((b) => b.user_id === eqs.user_id) ?? null, error: null };
        }
        let rows = state.buddyProfiles;
        for (const [c, v] of Object.entries(eqs)) rows = rows.filter((r) => r[c] === v);
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      if (table === "rent_buddy_bookings") {
        let rows = state.bookings;
        if (eqs.traveler_id !== undefined) rows = rows.filter((r) => r.traveler_id === eqs.traveler_id);
        if (ins.status) rows = rows.filter((r) => ins.status.includes(r.status));
        return { data: rows, error: null };
      }
      if (table === "profiles") {
        if (single) return { data: state.profiles[String(eqs.id)] ?? null, error: null };
        const ids = ins.id ?? Object.keys(state.profiles);
        return { data: ids.map((i) => state.profiles[i]).filter(Boolean), error: null };
      }
      if (table === "rent_buddy_global_controls" || table === "rent_buddy_user_limits" || table === "rent_buddy_beta_access") {
        return { data: null, error: null };
      }
      if (table === "rent_buddy_city_rollouts") {
        const want = String(ilikes.city ?? "").toLowerCase();
        return { data: state.cityRollouts.find((r) => r.city.toLowerCase() === want) ?? null, error: null };
      }
      if (table === "rent_buddy_launch_controls") {
        let rows = [...state.launchControls];
        for (const [c, v] of Object.entries(eqs)) rows = rows.filter((r) => r[c] === v);
        for (const c of Object.keys(iss)) rows = rows.filter((r) => r[c] == null);
        if (single) return { data: rows[0] ?? null, error: null };
        return { data: state.launchControls, error: null, count: state.launchControls.length };
      }
      if (table === "rent_buddy_city_restrictions") {
        if (state.restrictionsError) return { data: null, error: { message: "restrictions unreadable" } };
        let rows = [...state.cityRestrictions];
        for (const [c, v] of Object.entries(eqs)) rows = rows.filter((r) => r[c] === v);
        for (const c of Object.keys(iss)) rows = rows.filter((r) => r[c] == null);
        return { data: rows[0] ?? null, error: null };
      }
      if (table === "blocks") {
        if (single) {
          const hit = state.blocks.find((b) => b.blocker_id === eqs.blocker_id && b.blocked_id === eqs.blocked_id);
          return { data: hit ? { id: "blk" } : null, error: null };
        }
        return { data: state.blocks, error: null };
      }
      return { data: single ? null : [], error: null };
    }

    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any[]) => { ins[c] = v; return b; },
      is: (c: string, v: any) => { iss[c] = v; return b; },
      ilike: (c: string, v: string) => { ilikes[c] = v; return b; },
      or: () => b, order: () => b, limit: () => b, gte: () => b, lte: () => b, gt: () => b,
      maybeSingle: () => { single = true; return Promise.resolve().then(resolve); },
      then: (onF: any, onR: any) => Promise.resolve().then(resolve).then(onF, onR),
    };
    return b;
  }
  return { from: builder };
}

function viewerCtx(over: Partial<OpportunityViewer> = {}): OpportunityViewer {
  return {
    viewerId: VIEWER,
    followedCreatorIds: new Set<string>(),
    currentCity: "Da Nang",
    upcomingTripCities: new Set<string>(),
    interests: new Set<string>(["food"]),
    ...over,
  };
}

beforeEach(() => {
  state = freshState();
  invalidateGcCache();
});

// ── Flags: fail-closed on either ─────────────────────────────────────────────

describe("RAB opportunity producer — flags are fail-closed on either", () => {
  it("both ON ⇒ a context-city buddy is surfaced (positive control)", async () => {
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.candidates[0].objectType, "contextual_opportunity");
    assert.equal(loaded.candidates[0].opportunityKind, "buddy_around");
  });

  it("wall_rab_integration_enabled OFF ⇒ nothing, even with the master ON", async () => {
    state.flags.wall_rab_integration_enabled = false;
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("rent_buddy_enabled (RAB master) OFF ⇒ nothing, even with the Wall flag ON", async () => {
    state.flags.rent_buddy_enabled = false;
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("a MISSING flag row reads as OFF", async () => {
    delete state.flags.wall_rab_integration_enabled;
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("an unreadable flag table ⇒ nothing (never fail-open)", async () => {
    state.flagsThrow = true;
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });
});

// ── The consolidated booking gate + city restrictions ────────────────────────

describe("RAB opportunity producer — consolidated booking gate + city restrictions", () => {
  it("a city with NO rollout row is not bookable ⇒ the buddy is dropped", async () => {
    state.cityRollouts = state.cityRollouts.filter((r) => r.city !== "Da Nang");
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("a waitlist-only city rollout ⇒ dropped", async () => {
    state.cityRollouts = [{ id: "cr-1", city: "Da Nang", status: "waitlist_only" }];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("a DISABLED launch control for the city ⇒ dropped (location_unavailable)", async () => {
    state.launchControls = [{ id: "lc-1", country_code: "VN", city: "Da Nang", category: null, enabled: false, waitlist_only: false }];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("an ENABLED launch control + verified viewer ⇒ still surfaced (gate not over-blocking)", async () => {
    state.launchControls = [{ id: "lc-1", country_code: "VN", city: "Da Nang", category: null, enabled: true, waitlist_only: false,
      min_age: 18, nightlife_min_age: 21, require_id_verification: true, require_phone_verification: true, full_payment_required: false }];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 1);
  });

  it("launch controls configured but the buddy's row has no country ⇒ dropped (fail-closed)", async () => {
    state.launchControls = [{ id: "lc-1", country_code: "US", city: null, category: null, enabled: true, waitlist_only: false }];
    state.buddyProfiles = [buddy({ country: null })];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("an UNREADABLE city-restrictions table ⇒ dropped (fail-closed, never fail-open)", async () => {
    state.restrictionsError = true;
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("a buddy who blocked the viewer (either direction) ⇒ dropped", async () => {
    state.blocks = [{ blocker_id: "buddy-user-1", blocked_id: VIEWER }];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("a global booking kill switch ⇒ dropped", async () => {
    state.flags.disable_rab_bookings = true;
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });
});

// ── Matching + shaping ───────────────────────────────────────────────────────

describe("RAB opportunity producer — matching, identity, media, privacy", () => {
  it("never surfaces the viewer's own buddy profile, an expired horizon, or a risk hold", async () => {
    state.buddyProfiles = [
      buddy({ id: "bp-self", user_id: VIEWER }),
      buddy({ id: "bp-expired", user_id: "buddy-user-2", available_now_until: iso(-1) }),
      buddy({ id: "bp-hold", user_id: "buddy-user-2", risk_hold: true }),
    ];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("a buddy outside the viewer's context with no social tie is not surfaced", async () => {
    state.buddyProfiles = [buddy({ city: "Bangkok" })];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("an upcoming trip city is context too (buddy_around)", async () => {
    state.buddyProfiles = [buddy({ city: "Bangkok", country: "TH" })];
    const loaded = await loadContextualOpportunityCandidates(
      makeClient(),
      viewerCtx({ currentCity: null, upcomingTripCities: new Set(["bangkok"]) }),
    );
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.candidates[0].opportunityKind, "buddy_around");
    assert.equal(loaded.candidates[0].opportunityArea, "Bangkok");
  });

  it("a FOLLOWED buddy is a buddy_dispatch regardless of city", async () => {
    state.buddyProfiles = [buddy({ city: "Bangkok", country: "TH" })];
    const loaded = await loadContextualOpportunityCandidates(
      makeClient(),
      viewerCtx({ followedCreatorIds: new Set(["buddy-user-1"]) }),
    );
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.candidates[0].opportunityKind, "buddy_dispatch");
  });

  it("an ENGAGED buddy (a completed booking) is a buddy_dispatch regardless of city", async () => {
    state.buddyProfiles = [buddy({ city: "Bangkok", country: "TH" })];
    state.bookings = [{ id: "bk-1", traveler_id: VIEWER, buddy_id: "bp-1", status: "completed" }];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 1);
    assert.equal(loaded.candidates[0].opportunityKind, "buddy_dispatch");
  });

  it("a merely-declined booking is NOT engagement", async () => {
    state.buddyProfiles = [buddy({ city: "Bangkok", country: "TH" })];
    state.bookings = [{ id: "bk-1", traveler_id: VIEWER, buddy_id: "bp-1", status: "declined" }];
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });

  it("person identity is primary; the service identity is a role tag from the interest-matched category", async () => {
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    const c = loaded.candidates[0];
    assert.equal(c.actor?.displayName, "Minh", "profiles display name, not the buddy row's");
    assert.equal(c.actor?.handle, "minh");
    assert.equal(c.actor?.isBuddy, true);
    assert.equal(c.actor?.buddyRole, "Food Buddy", "interest 'food' matched the buddy's categories");
    assert.equal(loaded.signals.get("bp-1")?.category, "food");
  });

  it("falls back to the buddy's first category when no interest matches", async () => {
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx({ interests: new Set() }));
    assert.equal(loaded.candidates[0].actor?.buddyRole, "Food Buddy");
    assert.equal(buddyRoleLabel(null), "Buddy");
    assert.equal(buddyRoleLabel("nightlife"), "Nightlife Buddy");
  });

  it("carries buddy experience media as social content and the coarse area — never a coordinate", async () => {
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    const c = loaded.candidates[0];
    assert.equal(c.media?.length, 2, "cover + one gallery image");
    assert.equal(c.media?.[0].url, "profile-media/covers/buddy-user-1/cover.jpg", "the stored ref, unmodified — the client signs it");
    assert.equal(c.media?.[0].kind, "image");
    assert.match(c.text ?? "", /Night markets and hidden bars/);
    assert.match(c.text ?? "", /Around Da Nang · An Thuong, Han Riverside/, "city + at most two approved zones");
    assert.ok(!/Extra Zone/.test(c.text ?? ""), "zone labels are capped");
    const json = JSON.stringify(c);
    assert.ok(!/16\.0544|108\.2022|meetup_base|"lat"|"lng"/.test(json), `no coordinate may leak: ${json}`);
    assert.equal(c.callerVisibilityResolved, true, "service eligibility resolved by the gate");
    assert.equal(c.opportunityArea, "Da Nang");
  });

  it("caps at three opportunities per page (spec §19: sparingly)", async () => {
    state.buddyProfiles = [1, 2, 3, 4, 5].map((i) => buddy({ id: `bp-${i}`, user_id: `buddy-user-${i}` }));
    for (const i of [3, 4, 5]) state.profiles[`buddy-user-${i}`] = { id: `buddy-user-${i}`, display_name: `B${i}`, username: `b${i}`, avatar_url: null, account_status: "active" };
    const loaded = await loadContextualOpportunityCandidates(makeClient(), viewerCtx());
    assert.equal(loaded.candidates.length, 3);
  });

  it("a buddy read failure degrades to no opportunities (never throws)", async () => {
    const client = makeClient();
    const orig = client.from;
    client.from = (t: string) => {
      if (t === "rent_buddy_profiles") {
        const b: any = { select: () => b, eq: () => b, order: () => b, limit: () => b,
          then: (_f: any, r: any) => Promise.reject(new Error("boom")).then(undefined, r) };
        return b;
      }
      return orig(t);
    };
    const loaded = await loadContextualOpportunityCandidates(client, viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });
});

// ── Through the Wall projection gate ─────────────────────────────────────────

describe("RAB opportunity — projection", () => {
  it("survives the Wall gate as a contextual_opportunity with a coarse book_buddy action", async () => {
    const client = makeClient();
    const loaded = await loadContextualOpportunityCandidates(client, viewerCtx());
    const projections = await projectObjects(client, loaded.candidates, {
      viewerId: VIEWER, viewerTripIds: new Set(), followedCreatorIds: new Set(),
    });
    assert.equal(projections.length, 1);
    const p = projections[0] as any;
    assert.equal(p.objectType, "contextual_opportunity");
    assert.equal(p.opportunityKind, "buddy_around");
    assert.equal(p.actor.isBuddy, true);
    const book = p.actions.find((a: any) => a.type === "book_buddy");
    assert.ok(book, "a See Buddy action is offered");
    assert.equal(book.targetType, "buddy");
    assert.equal(book.targetId, "bp-1");
    assert.deepEqual(book.params, { area: "Da Nang" });
    assert.ok(!/16\.0544|108\.2022|meetup_base/.test(JSON.stringify(p)));
  });

  it("the Wall gate still drops a buddy blocked in either direction, even if the loader admitted them", async () => {
    // Simulate a candidate the loader would have emitted (e.g. a block that
    // landed between the two reads) and prove the projection gate is independent.
    const client = makeClient();
    const loaded = await loadContextualOpportunityCandidates(client, viewerCtx());
    assert.equal(loaded.candidates.length, 1);
    state.blocks = [{ blocker_id: VIEWER, blocked_id: "buddy-user-1" }];
    const projections = await projectObjects(client, loaded.candidates, {
      viewerId: VIEWER, viewerTripIds: new Set(), followedCreatorIds: new Set(),
    });
    assert.equal(projections.length, 0);
  });
});

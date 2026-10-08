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

function makeClient(): any { return withVerifiedBookingParties(makeClientRaw(), "everyone"); } function makeClientRaw(): any {
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

// Every booking party reads as a verified adult: since 2026-10-05 the shared
// booking gate this producer runs also requires both people to hold a current
// REAL identity verification (lib/rentBuddyIdentityEligibility.ts, owner
// 2026-10-04). Wrapped on the definition line, import at the foot, so no cited
// line moves; the subject of this suite is the Wall producer.
import { withVerifiedBookingParties } from "./helpers/verifiedBookingParties.js";

describe("RAB opportunity producer — the two-sided identity rule reaches the Wall (owner 2026-10-04: no unverified bookings)", () => {
  it("an UNVERIFIED viewer is shown no book_buddy opportunity: the gate it would meet on booking refuses first", async () => {
    const loaded = await loadContextualOpportunityCandidates(withVerifiedBookingParties(makeClientRaw(), ["buddy-user-1"]), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });
  it("an UNVERIFIED buddy is not surfaced to a verified viewer", async () => {
    const loaded = await loadContextualOpportunityCandidates(withVerifiedBookingParties(makeClientRaw(), [VIEWER]), viewerCtx());
    assert.equal(loaded.candidates.length, 0);
  });
});

// ── P-1 (lead ruling, 2026-10-07): identity coverage per buddy, for the market a booking would be in ──
// With a certified, booking-grade, market-scoped provider (Sumsub, live key
// permitted) the loader may surface only buddies whose service country (their
// registered `country`) the coverage manifest supports: a VN buddy is surfaced
// and a TH buddy in the same context city is dropped; no manifest at all ⇒
// nothing. Dropping the per-buddy market check surfaces the TH buddy; checking
// with no market drops the VN one. Imports at the foot, so no cited line moves.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _certifyIdentityProvidersForTest } from "../services/identityVerification/readiness.js";

describe("RAB opportunity producer — P-1: identity coverage is checked for each buddy's service country", () => {
  async function underSumsub<T>(manifest: { supported: string[]; unsupported: string[] } | null, fn: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "p1-coverage-"));
    const file = join(dir, "identity-market-coverage.json");
    if (manifest) {
      writeFileSync(file, JSON.stringify({ provider: "sumsub", level: "id_selfie", revision: "p1-wall-test", retrievedAt: "2026-10-07T00:00:00.000Z", ...manifest }));
    }
    const envs: Record<string, string> = { IDENTITY_PROVIDER: "sumsub", SUMSUB_APP_TOKEN: "prd:p1-not-real", PAYMENTS_ALLOW_LIVE: "true", IDENTITY_COVERAGE_MANIFEST: file };
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(envs)) { saved.set(k, process.env[k]); process.env[k] = v; }
    _certifyIdentityProvidersForTest(["mock", "sumsub"]);
    try { return await fn(); } finally {
      _certifyIdentityProvidersForTest(null);
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  function twoMarkets(): void {
    state.buddyProfiles = [buddy(), buddy({ id: "bp-2", user_id: "buddy-user-2", display_name: "Lan (buddy row)", country: "TH", updated_at: iso(-120_000) })];
  }
  it("VN supported, TH excluded ⇒ only the VN buddy is surfaced", async () => {
    twoMarkets();
    const loaded = await underSumsub({ supported: ["VN"], unsupported: ["TH"] }, () => loadContextualOpportunityCandidates(makeClient(), viewerCtx()));
    assert.equal(loaded.candidates.length, 1);
    assert.ok(JSON.stringify(loaded.candidates).includes("bp-1"));
    assert.ok(!JSON.stringify(loaded.candidates).includes("bp-2"));
  });
  it("control: both markets supported ⇒ both buddies are surfaced", async () => {
    twoMarkets();
    const loaded = await underSumsub({ supported: ["VN", "TH"], unsupported: [] }, () => loadContextualOpportunityCandidates(makeClient(), viewerCtx()));
    assert.equal(loaded.candidates.length, 2);
  });
  it("no coverage manifest mounted ⇒ nothing is surfaced (coverage unknown everywhere)", async () => {
    twoMarkets();
    const loaded = await underSumsub(null, () => loadContextualOpportunityCandidates(makeClient(), viewerCtx()));
    assert.equal(loaded.candidates.length, 0);
  });
});

// ── Verifier finding 3 (2026-10-08): the loader's OWN sandbox-key and null-market cases ──
// The loader reaches the same `checkBookingKycGate` as the booking doors, so these
// were covered only transitively: dropping the booking-grade conjunct, or treating
// a missing market like the explicit deferral, left this suite green while the six
// booking doors went red. Pinned here directly, with a positive control each, under
// the same certified Sumsub as the P-1 block above (imports already bound there).
describe("RAB opportunity producer — a sandbox key and a buddy with no service country surface nothing", () => {
  async function underSumsubToken<T>(token: string, liveAllowed: boolean, fn: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "p5-wall-coverage-"));
    const file = join(dir, "identity-market-coverage.json");
    writeFileSync(file, JSON.stringify({ provider: "sumsub", level: "id_selfie", revision: "wall-sbx-null-test", retrievedAt: "2026-10-08T00:00:00.000Z", supported: ["VN", "TH"], unsupported: [] }));
    const envs: Record<string, string | undefined> = {
      IDENTITY_PROVIDER: "sumsub", SUMSUB_APP_TOKEN: token, PAYMENTS_ALLOW_LIVE: liveAllowed ? "true" : undefined, IDENTITY_COVERAGE_MANIFEST: file,
    };
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(envs)) { saved.set(k, process.env[k]); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _certifyIdentityProvidersForTest(["mock", "sumsub"]);
    try { return await fn(); } finally {
      _certifyIdentityProvidersForTest(null);
      for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a certified Sumsub on a SANDBOX (sbx:) token ⇒ nothing is surfaced (operational is not booking-grade)", async () => {
    const loaded = await underSumsubToken("sbx:wall-not-real", false, () => loadContextualOpportunityCandidates(makeClient(), viewerCtx()));
    assert.equal(loaded.candidates.length, 0);
  });
  it("control: the same configuration on a permitted LIVE (prd:) token ⇒ the VN buddy is surfaced", async () => {
    const loaded = await underSumsubToken("prd:wall-not-real", true, () => loadContextualOpportunityCandidates(makeClient(), viewerCtx()));
    assert.equal(loaded.candidates.length, 1);
    assert.ok(JSON.stringify(loaded.candidates).includes("bp-1"));
  });
  it("a buddy whose service country is NULL is dropped (market unknown), while a VN buddy in the same city is surfaced", async () => {
    state.buddyProfiles = [buddy(), buddy({ id: "bp-nul", user_id: "buddy-user-2", display_name: "Lan (buddy row)", country: null, updated_at: iso(-120_000) })];
    const loaded = await underSumsubToken("prd:wall-not-real", true, () => loadContextualOpportunityCandidates(makeClient(), viewerCtx()));
    const text = JSON.stringify(loaded.candidates);
    assert.equal(loaded.candidates.length, 1, text);
    assert.ok(text.includes("bp-1"));
    assert.ok(!text.includes("bp-nul"), "a buddy with no service country must not be surfaced");
  });
});

/**
 * Temporary / event Passport — Passport spec §25, §31, TABLE 31 Phase 8.
 *
 * The four properties the feature is only safe because of:
 *
 *   1. It EXPIRES on READ. Past its own bounded TTL, or past the event's end,
 *      or once the event leaves a live state, the token resolves to a refusal —
 *      no sweep involved.
 *   2. It is REVOCABLE, and a revoked share stays distinguishable from an
 *      unknown one.
 *   3. It is EVENT-SCOPED and fail-closed: a viewer who is not at the event
 *      (including an anonymous one) gets nothing.
 *   4. It NEVER WIDENS: the `event` variant exposes no field the viewer's
 *      ordinary projection did not already carry, and exposes only what the
 *      event context warrants (first name, handle, photo, verification,
 *      permitted home country, broad at-event city, current intent,
 *      Follow/Connect) — never stamps, journeys, plans, memories, trust or
 *      coordinates.
 *
 * Run: node --import tsx/esm --test src/test/eventPassport.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEventPassportShare,
  revokeEventPassportShare,
  getOwnEventPassportShare,
  resolveEventPassport,
  shareExpiryFor,
  eventIsShareable,
  EVENT_SHARE_MAX_TTL_MS,
} from "../services/passport/EventPassportService.js";
import { buildConsumerProjection } from "../services/passport/PassportConsumerProjections.js";
import { buildPassportProjection, type ViewerResolution, type ViewerPermissions } from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportRouter from "../routes/passport.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const STRANGER = "stranger-1";
const EVENT = "eeeeeeee-0000-0000-0000-000000000001";

// Anchored to the REAL clock: EventPassportService takes an injected `nowMs`,
// but the projection assembler's traveler-state read (§5 at_event) uses the
// process clock, so the seeded event has to be genuinely live for the
// at-event-city assertions below to mean anything.
const NOW = Date.now();
const EVENT_START = new Date(NOW - 3_600_000).toISOString();
const EVENT_END = new Date(NOW + 4 * 3_600_000).toISOString();

function permsPublic(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: false, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: true,
    canFollow: true, canInviteToTripCrew: false,
  };
}
function permsFollowing(): ViewerPermissions {
  return {
    relationshipLabel: "following", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: true, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: true,
  };
}
function resolution(context: ViewerResolution["context"], permissions: ViewerPermissions): ViewerResolution {
  return { context, permissions, sharedTrip: false, sharedEvent: true, ownerIsTripHost: false, buddyRole: null };
}
function inject(res: ViewerResolution) {
  return { resolveViewerContext: async () => res };
}

interface SeedOpts {
  flagOn?: boolean;
  eventState?: string;
  eventEndsAt?: string | null;
  shares?: any[];
  viewerRsvp?: string | null;
  ownerRsvp?: string | null;
  /** TABLE 24 show_home_country opt-out. */
  homeCountryHidden?: boolean;
}

function seed(opts: SeedOpts = {}) {
  const rsvps: any[] = [];
  if (opts.ownerRsvp !== null) rsvps.push({ event_id: EVENT, user_id: OWNER, status: opts.ownerRsvp ?? "going" });
  if (opts.viewerRsvp !== null) rsvps.push({ event_id: EVENT, user_id: VIEWER, status: opts.viewerRsvp ?? "going" });
  return makePassportDb({
    feature_flags: [{ flag: "passport_event_share_enabled", enabled: opts.flagOn !== false }],
    events: [{
      id: EVENT,
      city: "Da Nang",
      starts_at: EVENT_START,
      ends_at: opts.eventEndsAt === undefined ? EVENT_END : opts.eventEndsAt,
      state: opts.eventState ?? "started",
      host_id: "host-1",
    }],
    event_rsvps: rsvps,
    event_passport_shares: opts.shares ?? [],
    profile_privacy_settings: opts.homeCountryHidden
      ? [{ user_id: OWNER, show_home_country: false, show_current_city: true }]
      : [],
    profiles: [{
      id: OWNER, handle: "wanderer", display_name: "Mai Nguyen Tran", name: "Mai Nguyen Tran",
      avatar_url: "https://x/a.png", cover_photo_url: "https://x/c.png",
      verified: true, verified_at: "2024-01-01", verification_level: "id_verified",
      home_city: "Hanoi", home_country: "Vietnam", current_city: "Da Nang",
      is_official: false, is_private: false, passport_visibility: "public",
      show_profile_picture_publicly: true,
      interests: ["Nightlife", "Food"], availability_tags: ["Explore"],
      spoken_languages: ["English"], travel_pace: "packed", planning_style: "planner",
      open_to_meet: true, created_at: "2023-01-01",
    }],
    user_stamps: [
      { user_id: OWNER, city: "Da Nang", country: "Vietnam", is_revoked: false, earned_at: "2025-03-30", stamp_definitions: { category: "trip", name: "Vietnam" } },
    ],
    passport_memories: [
      { id: "m1", user_id: OWNER, status: "active", title: "Journal", city: "Da Nang", country: "Vietnam", trip_id: null, visibility: "public", earned_at: "2025-03-06", photo_url: null, category: "note" },
    ],
    quick_availability_status: [{ user_id: OWNER, status: "free_tonight", expires_at: new Date(NOW + 3_600_000).toISOString() }],
    passport_visibility_preferences: [{ user_id: OWNER, stamps_visible: "public", memories_visible: "public" }],
    trust_profiles: [{
      user_id: OWNER, overall_score: 78, public_level: "trusted_traveler",
      plan_attendance: 72, host_quality: 68, communication: 55, respect_safety: 80,
    }],
  });
}

function liveShare(overrides: Record<string, any> = {}) {
  return {
    id: "share-1",
    user_id: OWNER,
    event_id: EVENT,
    token: "a".repeat(48),
    created_at: new Date(NOW - 600_000).toISOString(),
    expires_at: EVENT_END,
    revoked_at: null,
    ...overrides,
  };
}

// ── Bounded TTL ───────────────────────────────────────────────────────────────

describe("event Passport — bounded TTL (§31)", () => {
  it("expiry is the SOONER of the event end and the service ceiling", () => {
    // Event ends in 4h → the event bounds it.
    assert.equal(shareExpiryFor(EVENT_END, NOW), Date.parse(EVENT_END));
    // Event ends in 40h → the 12h ceiling bounds it.
    const farEnd = new Date(NOW + 40 * 3_600_000).toISOString();
    assert.equal(shareExpiryFor(farEnd, NOW), NOW + EVENT_SHARE_MAX_TTL_MS);
    // An unparseable end can never produce an unbounded share.
    assert.equal(shareExpiryFor("not-a-date", NOW), NOW + EVENT_SHARE_MAX_TTL_MS);
  });

  it("an event with no end is never shareable — a temporary Passport must expire", () => {
    assert.equal(eventIsShareable({ id: EVENT, city: null, startsAt: null, endsAt: null, state: "started", hostId: null }, NOW), false);
    assert.equal(eventIsShareable({ id: EVENT, city: null, startsAt: null, endsAt: EVENT_END, state: "started", hostId: null }, NOW), true);
    assert.equal(eventIsShareable({ id: EVENT, city: null, startsAt: null, endsAt: EVENT_END, state: "cancelled", hostId: null }, NOW), false);
    // An event whose end has passed is not shareable even in a live state.
    assert.equal(eventIsShareable({ id: EVENT, city: null, startsAt: null, endsAt: new Date(NOW - 1).toISOString(), state: "started", hostId: null }, NOW), false);
  });

  it("mints a share bounded by the event, and refuses when the event is over", async () => {
    const ok = await createEventPassportShare(seed(), OWNER, EVENT, NOW);
    assert.equal(ok.ok, true);
    assert.ok(ok.ok && Date.parse(ok.value.expiresAt) <= Date.parse(EVENT_END));
    assert.ok(ok.ok && ok.value.token.length >= 32, "token clears migration 2294's 32-char floor");

    const over = await createEventPassportShare(
      seed({ eventEndsAt: new Date(NOW - 1000).toISOString() }), OWNER, EVENT, NOW);
    assert.deepEqual(over, { ok: false, reason: "event_not_live" });
  });

  it("refuses to mint for someone who is not attending", async () => {
    const r = await createEventPassportShare(seed({ ownerRsvp: null }), OWNER, EVENT, NOW);
    assert.deepEqual(r, { ok: false, reason: "owner_not_attending" });
  });

  it("is inert while the capability flag is OFF", async () => {
    const db = seed({ flagOn: false });
    assert.deepEqual(await createEventPassportShare(db, OWNER, EVENT, NOW), { ok: false, reason: "disabled" });
    assert.deepEqual(await revokeEventPassportShare(db, OWNER, EVENT, NOW), { ok: false, reason: "disabled" });
    assert.deepEqual(
      await resolveEventPassport(db, "a".repeat(48), VIEWER, NOW),
      { ok: false, reason: "disabled" },
    );
  });
});

// ── Expiry + revocation on READ ───────────────────────────────────────────────

describe("event Passport — expires and revokes on READ (§31)", () => {
  it("resolves for a fellow attendee while live", async () => {
    const db = seed({ shares: [liveShare()] });
    const out = await resolveEventPassport(db, "a".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())));
    assert.equal(out.ok, true);
    assert.ok(out.ok && out.value.passport.variant === "event");
    assert.ok(out.ok && out.value.share.eventId === EVENT);
  });

  it("refuses once the share's own TTL has passed, with the row untouched", async () => {
    const share = liveShare({ expires_at: new Date(NOW - 1).toISOString() });
    const db = seed({ shares: [share] });
    const out = await resolveEventPassport(db, "a".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())));
    assert.deepEqual(out, { ok: false, reason: "expired" });
    // The refusal came from the READ, not from a sweep: the row is still live.
    assert.equal(share.revoked_at, null);
  });

  it("refuses once the EVENT has ended, even while the share's own TTL is in the future", async () => {
    // The share claims a horizon 4h out, but the event ended a minute ago.
    const db = seed({
      shares: [liveShare({ expires_at: new Date(NOW + 4 * 3_600_000).toISOString() })],
      eventEndsAt: new Date(NOW - 60_000).toISOString(),
    });
    const out = await resolveEventPassport(db, "a".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())));
    assert.deepEqual(out, { ok: false, reason: "expired" });
  });

  it("refuses once the event leaves a live state", async () => {
    const db = seed({ shares: [liveShare()], eventState: "cancelled" });
    const out = await resolveEventPassport(db, "a".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())));
    assert.deepEqual(out, { ok: false, reason: "expired" });
  });

  it("refuses a revoked share, distinguishably from an unknown one", async () => {
    const revoked = await resolveEventPassport(
      seed({ shares: [liveShare({ revoked_at: new Date(NOW - 60_000).toISOString() })] }),
      "a".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())),
    );
    assert.deepEqual(revoked, { ok: false, reason: "revoked" });

    const unknown = await resolveEventPassport(
      seed({ shares: [] }), "b".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())),
    );
    assert.deepEqual(unknown, { ok: false, reason: "not_found" });
  });

  it("revoke stops a live share resolving, and is idempotent", async () => {
    const share = liveShare();
    const db = seed({ shares: [share] });
    const first = await revokeEventPassportShare(db, OWNER, EVENT, NOW);
    assert.deepEqual(first, { ok: true, value: { revoked: true } });
    assert.ok(share.revoked_at, "the row carries a revocation instant");

    const after = await resolveEventPassport(db, "a".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())));
    assert.deepEqual(after, { ok: false, reason: "revoked" });

    const second = await revokeEventPassportShare(db, OWNER, EVENT, NOW);
    assert.deepEqual(second, { ok: true, value: { revoked: false } }, "revoking twice is not an error");
  });

  it("the owner's own read applies the same expiry", async () => {
    const live = await getOwnEventPassportShare(seed({ shares: [liveShare()] }), OWNER, EVENT, NOW);
    assert.ok(live, "a live share is returned");
    const lapsed = await getOwnEventPassportShare(
      seed({ shares: [liveShare({ expires_at: new Date(NOW - 1).toISOString() })] }), OWNER, EVENT, NOW);
    assert.equal(lapsed, null, "a lapsed share is never shown as current");
  });
});

// ── Event scoping, fail-closed ────────────────────────────────────────────────

describe("event Passport — event-scoped and fail-closed", () => {
  it("refuses a viewer who is not at the event", async () => {
    const db = seed({ shares: [liveShare()] });
    const out = await resolveEventPassport(db, "a".repeat(48), STRANGER, NOW, inject(resolution("public", permsPublic())));
    assert.deepEqual(out, { ok: false, reason: "not_attending" });
  });

  it("refuses an anonymous scan outright — no anonymous fall-through", async () => {
    const db = seed({ shares: [liveShare()] });
    const out = await resolveEventPassport(db, "a".repeat(48), null, NOW, inject(resolution("public", permsPublic())));
    assert.deepEqual(out, { ok: false, reason: "not_attending" });
  });

  it("refuses a viewer whose RSVP is not an attending one", async () => {
    const db = seed({ shares: [liveShare()], viewerRsvp: "not_going" });
    const out = await resolveEventPassport(db, "a".repeat(48), VIEWER, NOW, inject(resolution("event_group", permsFollowing())));
    assert.deepEqual(out, { ok: false, reason: "not_attending" });
  });

  it("the owner can always resolve their own share (to preview it)", async () => {
    const db = seed({ shares: [liveShare()] });
    const out = await resolveEventPassport(db, "a".repeat(48), OWNER, NOW, inject(resolution("self", permsFollowing())));
    assert.equal(out.ok, true);
  });
});

// ── The `event` variant's allow-list ──────────────────────────────────────────

describe("event variant — exposes only what the event context warrants", () => {
  it("carries first name / handle / photo / verification / home country / intent / actions and nothing else", async () => {
    const p = (await buildConsumerProjection(
      seed(), "event", OWNER, VIEWER, inject(resolution("event_group", permsFollowing())),
    ))!;
    assert.equal(p.variant, "event");
    assert.equal(p.identity.firstName, "Mai", "FIRST name only — never the family name (§25)");
    assert.ok(!JSON.stringify(p).includes("Nguyen"), "no part of the family name may appear anywhere");
    assert.equal(p.identity.handle, "wanderer");
    assert.deepEqual(Object.keys(p.actions).sort(), ["can_follow", "can_message"]);

    for (const k of [
      "stamps", "memories", "upcomingPlans", "featuredJourney", "credentials",
      "trust", "stats", "capabilities", "sharedContext", "travelIdentity",
      "availability", "travelerState",
    ]) {
      assert.ok(!(k in (p as any)), `event variant leaked: ${k}`);
    }
    for (const k of ["name", "homeBase", "coverUrl", "isOfficial"]) {
      assert.ok(!(k in (p.identity as any)), `event identity leaked: ${k}`);
    }
    // §23 / TABLE 25 — no coordinate may ever appear on an event Passport.
    const body = JSON.stringify(p);
    for (const k of ["lat", "lng", "latitude", "longitude", "geog"]) {
      assert.ok(!body.includes(`"${k}"`), `event Passport leaked a coordinate field: ${k}`);
    }
  });

  it("leaks nothing the viewer's ORDINARY projection did not already carry", async () => {
    // The non-widening property: every value on the variant must equal the value
    // the same viewer's full aggregate already held.
    const res = resolution("event_group", permsFollowing());
    const full = (await buildPassportProjection(seed(), OWNER, VIEWER, inject(res)))!;
    const p = (await buildConsumerProjection(seed(), "event", OWNER, VIEWER, inject(res)))!;

    assert.equal(p.userId, full.userId);
    assert.equal(p.viewerContext, full.viewerContext);
    assert.equal(p.identity.handle, full.identity.handle);
    assert.equal(p.identity.avatarUrl, full.identity.avatarUrl);
    assert.equal(p.identity.verified, full.identity.verified);
    assert.equal(p.identity.verificationLevel, full.identity.verificationLevel);
    assert.equal(p.identity.homeCountry, full.identity.homeCountry);
    assert.equal(p.actions.can_follow, full.capabilities.actions.can_follow);
    assert.equal(p.actions.can_message, full.capabilities.actions.can_message);
    // First name is a strict prefix of the permitted display name.
    assert.ok(full.identity.name!.startsWith(p.identity.firstName!));
    // Every projected intent came from the aggregate's own intent list.
    for (const i of p.intents) assert.ok((full.intent?.current ?? []).includes(i), `invented intent: ${i}`);
  });

  it("respects the owner's TABLE 24 home-country opt-out — the share cannot re-publish it", async () => {
    // §25 permits "permitted home country" on a QR-family projection. When the
    // owner has turned show_home_country OFF, the aggregate withholds it, and
    // the event Passport must withhold it too.
    const res = resolution("event_group", permsFollowing());
    const optedOut = () => seed({ homeCountryHidden: true });
    const full = (await buildPassportProjection(optedOut(), OWNER, VIEWER, inject(res)))!;
    assert.equal(full.identity.homeCountry, null, "the aggregate honours the opt-out");
    const p = (await buildConsumerProjection(optedOut(), "event", OWNER, VIEWER, inject(res)))!;
    assert.equal(p.identity.homeCountry, null, "so the event Passport must too");

    // Control: with the opt-out off, the same viewer does get the country — so
    // the assertion above is testing the gate, not an always-null field.
    const shown = (await buildConsumerProjection(seed(), "event", OWNER, VIEWER, inject(res)))!;
    assert.equal(shown.identity.homeCountry, "Vietnam");
  });

  it("projects the broad at-event CITY only, and only when the owner is at an event", async () => {
    // The seeded owner has a live RSVP'd event, so the aggregate's traveler
    // state IS at_event with a broad city. The variant carries that city and
    // nothing more granular (§5/§23 — never a venue, never a coordinate).
    const res = resolution("event_group", permsFollowing());
    const full = (await buildPassportProjection(seed(), OWNER, VIEWER, inject(res)))!;
    assert.equal(full.travelerState?.state, "at_event", "fixture must genuinely put the owner at an event");
    const p = (await buildConsumerProjection(seed(), "event", OWNER, VIEWER, inject(res)))!;
    assert.equal(p.atEventCity, "Da Nang");
    assert.equal(p.atEventCity, full.travelerState!.city);
  });

  it("withholds the at-event city from a viewer the aggregate withholds it from", async () => {
    // Same live event; a public-permission viewer may not see location context,
    // so the aggregate nulls the city and the event variant must too.
    const res = resolution("event_group", permsPublic());
    const full = (await buildPassportProjection(seed(), OWNER, STRANGER, inject(res)))!;
    const p = (await buildConsumerProjection(seed(), "event", OWNER, STRANGER, inject(res)))!;
    assert.equal(full.travelerState?.city, null, "the aggregate withholds the city from this viewer");
    assert.equal(p.atEventCity, null, "so the event Passport must withhold it too");
  });

  it("reports no at-event city when the owner is NOT at an event", async () => {
    // Same owner, no RSVP — the traveler state falls back to `traveling`, which
    // the event variant deliberately does not surface as an at-event city.
    const res = resolution("event_group", permsFollowing());
    const db = seed({ ownerRsvp: null });
    const full = (await buildPassportProjection(db, OWNER, VIEWER, inject(res)))!;
    assert.notEqual(full.travelerState?.state, "at_event");
    const p = (await buildConsumerProjection(seed({ ownerRsvp: null }), "event", OWNER, VIEWER, inject(res)))!;
    assert.equal(p.atEventCity, null);
  });

  it("a blocked relationship collapses the event Passport too (§24)", async () => {
    const blocked = permsPublic();
    blocked.isBlocked = true;
    const p = (await buildConsumerProjection(
      seed(), "event", OWNER, VIEWER, inject(resolution("public", blocked)),
    ))!;
    assert.ok(p.restricted, "a blocked viewer gets the restricted shape");
    assert.equal(p.atEventCity, null);
    assert.deepEqual(p.intents, []);
    assert.equal(p.identity.homeCountry, null);
    assert.equal(p.actions.can_message, false);
  });
});

// ── Route surface ─────────────────────────────────────────────────────────────
//
// The handlers are a thin translation of the service's refusals into status
// codes; these pin that translation (especially the flag-off envelope, which
// must NOT look like an error, and the auth requirement on the resolve path).

describe("event Passport routes", () => {
  async function startServer(store: any, tokens: Record<string, string>) {
    _setTestServiceClient(store as any);
    _setTestClient(
      {
        from: (t: string) => store.from(t),
        auth: {
          getUser: async (token: string) => {
            const id = tokens[token];
            if (!id) return { data: { user: null }, error: { message: "invalid token" } };
            return { data: { user: { id } }, error: null };
          },
        },
      } as any,
      true,
    );
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.log = { error: () => {}, info: () => {}, warn: () => {} };
      next();
    });
    app.use("/api", passportRouter);
    return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
      const srv = createServer(app);
      srv.listen(0, "127.0.0.1", () => {
        const { port } = srv.address() as { port: number };
        srv.unref();
        resolve({
          port,
          close: () => new Promise<void>((res, rej) => {
            srv.closeAllConnections();
            srv.close((e) => (e ? rej(e) : res()));
          }),
        });
      });
      srv.on("error", reject);
    });
  }

  async function call(port: number, method: string, path: string, token?: string, body?: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, cacheControl: res.headers.get("cache-control"), body: text ? JSON.parse(text) : null };
  }

  const TOKENS = { "owner-tok": OWNER, "viewer-tok": VIEWER, "stranger-tok": STRANGER };

  it("answers { enabled: false } — not an error — while the flag is OFF", async () => {
    const { port, close } = await startServer(seed({ flagOn: false }), TOKENS);
    const created = await call(port, "POST", "/api/passport/event-share", "owner-tok", { eventId: EVENT });
    const own = await call(port, "GET", `/api/passport/event-share/${EVENT}`, "owner-tok");
    await close();
    assert.equal(created.status, 200);
    assert.deepEqual(created.body, { enabled: false });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body, { enabled: false, share: null });
  });

  it("requires authentication on every event-share endpoint", async () => {
    const { port, close } = await startServer(seed(), TOKENS);
    const a = await call(port, "POST", "/api/passport/event-share", undefined, { eventId: EVENT });
    const b = await call(port, "GET", `/api/passport/event-passport/${"a".repeat(48)}`);
    await close();
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
  });

  it("rejects a malformed eventId", async () => {
    const { port, close } = await startServer(seed(), TOKENS);
    const r = await call(port, "POST", "/api/passport/event-share", "owner-tok", { eventId: "nope" });
    await close();
    assert.equal(r.status, 400);
  });

  it("translates the not-attending refusal into 403, and never returns a passport with it", async () => {
    const { port, close } = await startServer(seed({ shares: [liveShare()] }), TOKENS);
    const r = await call(port, "GET", `/api/passport/event-passport/${"a".repeat(48)}`, "stranger-tok");
    await close();
    assert.equal(r.status, 403);
    assert.equal(r.body.passport, undefined);
  });

  it("serves a resolved event Passport as private, no-store", async () => {
    const { port, close } = await startServer(seed({ shares: [liveShare()] }), TOKENS);
    const r = await call(port, "GET", `/api/passport/event-passport/${"a".repeat(48)}`, "viewer-tok");
    await close();
    assert.equal(r.status, 200);
    assert.equal(r.body.passport.variant, "event");
    assert.equal(r.cacheControl, "private, no-store",
      "an expiring, viewer-specific projection must never be cached");
  });
});

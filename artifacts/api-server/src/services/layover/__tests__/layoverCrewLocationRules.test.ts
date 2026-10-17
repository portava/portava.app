/**
 * census-layover L132 / L158 / L166 / L203 / L124 / L277 — the §14 L4 rung
 * ("temporary location — explicit, scoped, auto-expiring") as PURE rules.
 *
 * `services/layover/LayoverCrewLocation.ts` decides what a crew location share
 * may be (Telegraph's scoped-share rules: precision, purpose, an expiry that is
 * a real bound of at most MAX_LOCATION_SHARE_HOURS), what of it is stored, when
 * it ends, and what a crewmate may see of it. No clock (`nowMs` is an
 * argument), no I/O.
 *
 * Run: node --import tsx/esm --test src/services/layover/__tests__/layoverCrewLocationRules.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CREW_SHARE_MAX_MINUTES,
  CREW_SHARE_PRECISIONS,
  LAYOVER_CREW_LOCATION_FLAG,
  crewProximity,
  crewSharePurposeFor,
  crewShareSignalsFor,
  planCrewLocationShare,
  projectCrewLocations,
  shareGeometry,
  type CrewGrantRow,
  type CrewShareContext,
} from "../LayoverCrewLocation.js";
import {
  LOCATION_PRECISIONS as TELEGRAPH_LOCATION_PRECISIONS,
  MAX_LOCATION_SHARE_HOURS,
  TELEGRAPH_SHARE_PURPOSES,
} from "../../telegraph/messageKinds.js";
import { evaluateCrewLocationShare } from "../../airport/LayoverCrewService.js";

const NOW = Date.parse("2026-10-17T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function ctx(over: Partial<CrewShareContext> = {}): CrewShareContext {
  return {
    nowMs: NOW,
    crewExpiresAt: iso(NOW + 10 * 60 * MIN),
    sharerBoardingAt: null,
    sharerDepartureAt: iso(NOW + 8 * 60 * MIN),
    preciseControlEnabled: false,
    zones: [],
    ...over,
  };
}

const POINT = { lat: 25.0330, lng: 121.5654 };

describe("L132 — the share is Telegraph's scoped share: explicit, scoped, auto-expiring", () => {
  it("pins its vocabulary to Telegraph's, not to a copy", () => {
    assert.deepEqual([...CREW_SHARE_PRECISIONS], [...TELEGRAPH_LOCATION_PRECISIONS]);
    assert.equal(CREW_SHARE_MAX_MINUTES, MAX_LOCATION_SHARE_HOURS * 60);
    for (const p of CREW_SHARE_PRECISIONS) {
      assert.ok((TELEGRAPH_SHARE_PURPOSES as readonly string[]).includes(crewSharePurposeFor(p)), p);
    }
    assert.equal(crewSharePurposeFor("exact"), "live_session_sharing");
    assert.equal(crewSharePurposeFor("area"), "presence_in_context");
    assert.equal(crewSharePurposeFor("venue"), "presence_in_context");
    assert.equal(LAYOVER_CREW_LOCATION_FLAG, "layover_crew_location_enabled");
  });

  it("a body with no expiry is a pin, not a share, and is refused", () => {
    const r = planCrewLocationShare({ label: "Gate B12" }, ctx());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
    assert.equal(r.reason, "expiry_required");
  });

  it("an expiry already past is refused with Telegraph's own words", () => {
    const r = planCrewLocationShare({ label: "Gate B12", expiresAt: iso(NOW - MIN) }, ctx());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
    assert.equal(r.reason, "expiry_invalid");
    assert.match(r.message, /already past/);
  });

  it("an expiry past the 4-hour ceiling is refused, not clamped", () => {
    const r = planCrewLocationShare({ label: "Gate B12", expiresAt: iso(NOW + 4 * 60 * MIN + MIN) }, ctx({ crewExpiresAt: iso(NOW + 12 * 60 * MIN), sharerDepartureAt: iso(NOW + 11 * 60 * MIN) }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "expiry_invalid");
    assert.match(r.message, /4 hours/);
  });

  it("defaults to the coarse rung, and the coarse rung never stores a coordinate", () => {
    const r = planCrewLocationShare({ label: "Old town", expiresAt: iso(NOW + 60 * MIN), lat: POINT.lat, lng: POINT.lng }, ctx());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.grant.precision, "area");
    assert.equal(r.grant.purpose, "presence_in_context");
    assert.equal(r.grant.lat, null);
    assert.equal(r.grant.lng, null);
    assert.equal(r.grant.grantedAt, iso(NOW));
    assert.equal(r.grant.expiresAt, iso(NOW + 60 * MIN));
    assert.equal(r.endsBecause, "requested");
  });

  it("a purpose that does not belong to the precision is refused", () => {
    const r = planCrewLocationShare({ label: "Old town", precision: "area", purpose: "live_session_sharing", expiresAt: iso(NOW + 60 * MIN) }, ctx());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 400);
    assert.equal(r.reason, "purpose_mismatch");
  });

  it("the body is strict: an unknown field is refused, not ignored", () => {
    const r = planCrewLocationShare({ label: "Old town", expiresAt: iso(NOW + 60 * MIN), audience: "everyone" }, ctx());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "invalid_body");
  });

  it("half a coordinate is refused", () => {
    const r = planCrewLocationShare({ label: "Old town", precision: "venue", expiresAt: iso(NOW + 60 * MIN), lat: POINT.lat }, ctx());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "coordinates_incomplete");
  });
});

describe("L158 — scoped to the session: the share ends with the layover, not only with its clock", () => {
  it("is cut at the sharer's boarding time", () => {
    const boarding = NOW + 30 * MIN;
    const r = planCrewLocationShare({ label: "Old town", expiresAt: iso(NOW + 60 * MIN) }, ctx({ sharerBoardingAt: iso(boarding) }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.grant.expiresAt, iso(boarding));
    assert.equal(r.endsBecause, "boarding");
  });

  it("is cut at departure when no boarding time is known", () => {
    const dep = NOW + 45 * MIN;
    const r = planCrewLocationShare({ label: "Old town", expiresAt: iso(NOW + 60 * MIN) }, ctx({ sharerDepartureAt: iso(dep) }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.grant.expiresAt, iso(dep));
    assert.equal(r.endsBecause, "boarding");
  });

  it("is cut at the crew's end", () => {
    const crewEnd = NOW + 20 * MIN;
    const r = planCrewLocationShare({ label: "Old town", expiresAt: iso(NOW + 60 * MIN) }, ctx({ crewExpiresAt: iso(crewEnd) }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.grant.expiresAt, iso(crewEnd));
    assert.equal(r.endsBecause, "crew_ends");
  });

  it("is refused when the layover is already boarding", () => {
    const r = planCrewLocationShare({ label: "Old town", expiresAt: iso(NOW + 60 * MIN) }, ctx({ sharerBoardingAt: iso(NOW - MIN) }));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 409);
    assert.equal(r.reason, "layover_ending");
  });

  it("every terminator §14.1 names ends a live share, and the first one is the reason", () => {
    const grant: CrewGrantRow = {
      crewId: "crew-1", userId: "user-a", sessionId: "s-a", purpose: "presence_in_context", precision: "area",
      label: "Old town", lat: null, lng: null, grantedAt: iso(NOW - 10 * MIN), expiresAt: iso(NOW + 50 * MIN),
    };
    const live = { status: "open", expiresAt: iso(NOW + 5 * 60 * MIN), updatedAt: iso(NOW - 60 * MIN) };
    const session = { id: "s-a", status: "active", departureTime: iso(NOW + 3 * 60 * MIN), boardingTime: null, updatedAt: iso(NOW - 60 * MIN) };
    const base: Parameters<typeof crewShareSignalsFor>[0] = { grant, crew: live, sharerSession: session, membershipLive: true, reentryAtMs: null, nowMs: NOW };
    const run = (over: Partial<typeof base>) => {
      const signals = crewShareSignalsFor({ ...base, ...over });
      return evaluateCrewLocationShare(
        { grantedByUserId: grant.userId, crewId: grant.crewId, grantedAtMs: Date.parse(grant.grantedAt), expiresAtMs: Date.parse((over.grant ?? grant).expiresAt) },
        signals,
        NOW,
      );
    };
    assert.equal(run({}).active, true);
    assert.equal(run({ crew: { ...live, status: "disbanded", updatedAt: iso(NOW - MIN) } }).endedBy, "crew_dissolved");
    assert.equal(run({ crew: { ...live, expiresAt: iso(NOW - MIN) } }).endedBy, "crew_dissolved");
    assert.equal(run({ membershipLive: false }).endedBy, "user_revoked");
    assert.equal(run({ sharerSession: { ...session, status: "completed", updatedAt: iso(NOW - 2 * MIN) } }).endedBy, "session_expired");
    assert.equal(run({ sharerSession: null }).active, false, "an unreadable or deleted session is not a live one");
    assert.equal(run({ sharerSession: { ...session, boardingTime: iso(NOW - 3 * MIN) } }).endedBy, "boarding");
    assert.equal(run({ reentryAtMs: NOW - 4 * MIN }).endedBy, "airport_reentry");
    assert.equal(run({ reentryAtMs: NOW - 20 * MIN }).active, true, "a re-entry BEFORE the share began does not end it");
    assert.equal(run({ grant: { ...grant, expiresAt: iso(NOW - MIN) } }).endedBy, "ttl_elapsed");
  });
});

describe("L166 — precise crew sharing is a SEPARATE control, off by default", () => {
  it("exact is refused while the separate control is off", () => {
    const r = planCrewLocationShare({ label: "Gate B12", precision: "exact", expiresAt: iso(NOW + 60 * MIN), lat: POINT.lat, lng: POINT.lng }, ctx());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.status, 409);
    assert.equal(r.reason, "precise_control_off");
  });

  it("with the control on, exact stores the point as given, under the precise purpose", () => {
    const r = planCrewLocationShare({ label: "Gate B12", precision: "exact", expiresAt: iso(NOW + 60 * MIN), lat: POINT.lat, lng: POINT.lng }, ctx({ preciseControlEnabled: true }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.grant.precision, "exact");
    assert.equal(r.grant.purpose, "live_session_sharing");
    assert.equal(r.grant.lat, POINT.lat);
    assert.equal(r.grant.lng, POINT.lng);
    assert.equal(r.downgraded, null);
  });

  it("venue never stores the point it was given: two points in one cell store the same centre", () => {
    const a = planCrewLocationShare({ label: "Café", precision: "venue", expiresAt: iso(NOW + 60 * MIN), lat: 25.03301, lng: 121.56541 }, ctx());
    const b = planCrewLocationShare({ label: "Café", precision: "venue", expiresAt: iso(NOW + 60 * MIN), lat: 25.03302, lng: 121.56542 }, ctx());
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.grant.lat, 25.03301);
    assert.equal(a.grant.lat, b.grant.lat);
    assert.equal(a.grant.lng, b.grant.lng);
    assert.equal(a.grant.precision, "venue");
  });

  it("an unreadable protected-zone policy drops the coordinate rather than storing it", () => {
    const r = planCrewLocationShare({ label: "Gate B12", precision: "exact", expiresAt: iso(NOW + 60 * MIN), lat: POINT.lat, lng: POINT.lng }, ctx({ preciseControlEnabled: true, zones: null }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.grant.lat, null);
    assert.equal(r.grant.precision, "area");
    assert.equal(r.grant.purpose, "presence_in_context");
    assert.equal(r.downgraded, "zones_unreadable");
  });

  it("a point inside a suppressing protected zone is never stored", () => {
    const zone = { id: "z1", category: "private_residence", shape: "circle", center: { lat: POINT.lat, lng: POINT.lng }, radiusMeters: 500 } as any;
    const r = planCrewLocationShare({ label: "Somewhere", precision: "exact", expiresAt: iso(NOW + 60 * MIN), lat: POINT.lat, lng: POINT.lng }, ctx({ preciseControlEnabled: true, zones: [zone] }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.grant.lat, null);
    assert.equal(r.downgraded, "protected_zone");
  });
});

function grantRow(over: Partial<CrewGrantRow> = {}): CrewGrantRow {
  return {
    crewId: "crew-1", userId: "user-b", sessionId: "s-b", purpose: "presence_in_context", precision: "venue",
    label: "Night market", lat: 25.0335, lng: 121.5655, grantedAt: iso(NOW - 5 * MIN), expiresAt: iso(NOW + 55 * MIN),
    ...over,
  };
}

const LIVE_SIGNALS = () => ({});

describe("L203 / L124 — a crewmate sees a share only through membership and the explicit grant", () => {
  it("separates the viewer's own share from crewmates', and shows a live crewmate share", () => {
    const out = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1",
      grants: [grantRow(), grantRow({ userId: "user-a", sessionId: "s-a", label: "Gate B12", precision: "area", lat: null, lng: null })],
      liveMemberIds: new Set(["user-a", "user-b"]),
      blocked: new Set(), publishable: new Set(["user-a", "user-b"]),
      signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(out.mine?.label, "Gate B12");
    assert.equal(out.crewmates.length, 1);
    assert.equal(out.crewmates[0]!.userId, "user-b");
    assert.equal(out.crewmates[0]!.label, "Night market");
    assert.equal(out.crewmatesWithheld, null);
  });

  it("a grant from someone not (or no longer) in the crew is not shown, and is returned to be purged", () => {
    const out = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1", grants: [grantRow({ userId: "user-x" })],
      liveMemberIds: new Set(["user-a"]), blocked: new Set(), publishable: new Set(["user-x"]),
      signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(out.crewmates.length, 0);
    assert.deepEqual(out.ended.map((g) => g.userId), ["user-x"]);
  });

  it("a blocked crewmate's share is withheld; an unreadable block list withholds every crewmate", () => {
    const blocked = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1", grants: [grantRow()], liveMemberIds: new Set(["user-a", "user-b"]),
      blocked: new Set(["user-b"]), publishable: new Set(["user-b"]), signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(blocked.crewmates.length, 0);
    const unreadable = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1", grants: [grantRow()], liveMemberIds: new Set(["user-a", "user-b"]),
      blocked: null, publishable: new Set(["user-b"]), signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(unreadable.crewmates.length, 0);
    assert.equal(unreadable.crewmatesWithheld, "blocks_unreadable");
  });

  it("a crewmate who paused sharing is withheld; an unreadable preference read withholds every crewmate", () => {
    const paused = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1", grants: [grantRow()], liveMemberIds: new Set(["user-a", "user-b"]),
      blocked: new Set(), publishable: new Set(), signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(paused.crewmates.length, 0);
    const unreadable = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1", grants: [grantRow()], liveMemberIds: new Set(["user-a", "user-b"]),
      blocked: new Set(), publishable: null, signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(unreadable.crewmatesWithheld, "sharing_preferences_unreadable");
  });

  it("an ended share is neither shown nor kept: it comes back to be purged", () => {
    const out = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1", grants: [grantRow({ expiresAt: iso(NOW - MIN) })],
      liveMemberIds: new Set(["user-a", "user-b"]), blocked: new Set(), publishable: new Set(["user-b"]),
      signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(out.crewmates.length, 0);
    assert.equal(out.ended.length, 1);
  });

  it("a grant scoped to another crew is not this crew's", () => {
    const out = projectCrewLocations({
      viewerId: "user-a", crewId: "crew-1", grants: [grantRow({ crewId: "crew-2" })],
      liveMemberIds: new Set(["user-a", "user-b"]), blocked: new Set(), publishable: new Set(["user-b"]),
      signalsFor: LIVE_SIGNALS, nowMs: NOW,
    });
    assert.equal(out.crewmates.length, 0);
  });
});

describe("L124 — what a map may draw for a crewmate, by rung", () => {
  it("area draws nothing, venue draws a 150 m ring, exact draws the point", () => {
    assert.deepEqual(shareGeometry(grantRow({ precision: "area", lat: null, lng: null })), { position: null, ring: null });
    const v = shareGeometry(grantRow());
    assert.equal(v.position, null);
    assert.equal(v.ring?.radiusMeters, 150);
    assert.deepEqual(v.ring?.center, { lat: 25.0335, lng: 121.5655 });
    const e = shareGeometry(grantRow({ precision: "exact", purpose: "live_session_sharing", lat: 1.5, lng: 2.5 }));
    assert.deepEqual(e.position, { lat: 1.5, lng: 2.5 });
    assert.equal(e.ring, null);
  });
});

describe("L277 — Locate My Friends inside a crew: proximity buckets, never a distance", () => {
  const at = (lat: number, lng: number) => grantRow({ lat, lng });
  it("buckets by distance", () => {
    assert.equal(crewProximity(at(0, 0), at(0, 0.002)), "together");      // ~222 m
    assert.equal(crewProximity(at(0, 0), at(0, 0.01)), "close");          // ~1.1 km
    assert.equal(crewProximity(at(0, 0), at(0, 0.03)), "same_area");      // ~3.3 km
    assert.equal(crewProximity(at(0, 0), at(0, 0.1)), "far");             // ~11 km
  });
  it("needs a coordinate on BOTH sides — the viewer's own share is the opt-in", () => {
    assert.equal(crewProximity(grantRow({ precision: "area", lat: null, lng: null }), at(0, 0)), null);
    assert.equal(crewProximity(at(0, 0), grantRow({ precision: "area", lat: null, lng: null })), null);
    assert.equal(crewProximity(null, at(0, 0)), null);
  });
  it("is attached to each crewmate only when the viewer is sharing a point too", () => {
    const common = {
      viewerId: "user-a", crewId: "crew-1", liveMemberIds: new Set(["user-a", "user-b"]),
      blocked: new Set<string>(), publishable: new Set(["user-a", "user-b"]), signalsFor: LIVE_SIGNALS, nowMs: NOW,
    };
    const without = projectCrewLocations({ ...common, grants: [grantRow()] });
    assert.equal(without.crewmates[0]!.proximity, null);
    const withMine = projectCrewLocations({ ...common, grants: [grantRow(), grantRow({ userId: "user-a", sessionId: "s-a", lat: 25.0336, lng: 121.5656 })] });
    assert.equal(withMine.crewmates[0]!.proximity, "together");
    assert.equal(Object.keys(withMine.crewmates[0]!).some((k) => /distance/i.test(k)), false, "a bucket, never a distance field");
  });
});

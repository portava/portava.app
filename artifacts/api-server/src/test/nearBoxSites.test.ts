/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW13): every Discovery, map, events, gems and travelers read
 * that asks for rows near a point keeps every row within the radius — across the 180th meridian and near a pole.
 *
 * The round-18 verifier's B18 found GET /events' near box unwrapped at the antimeridian and clamped at cos(lat) 0.2.
 * The same box was built four more times: GET /events/nearby, the hidden-gem proximity read (findNearbyGems /
 * discoverGems), the travelers scan (listMapTravelersRead, the Discovery map's travelers layer and /map/search) and
 * mapSearch.loadNearbyEvents (/map/search's events and every caller that passes a point). Rows inside the radius were
 * dropped in the query, and nothing said so. They now share lib/nearBox.ts: the exact extent of the circle on a
 * 6371 km sphere, every longitude when the circle holds a pole, and two longitude ranges across the antimeridian.
 *
 *   NS1, NS2   GET /events/nearby: an event ~10 km across the antimeridian; one across the pole at 89.8°N
 *   NS3, NS4   findNearbyGems: a gem ~10 km across the antimeridian; one 45 km east at 80°N (radius 50)
 *   NS5, NS6   listMapTravelersRead: a traveler ~10 km across the antimeridian; one 45 km east at 80°N
 *   NS7, NS8   loadNearbyEvents: an event ~10 km across the antimeridian; one 45 km east at 80°N
 *   NS1c, NS3c, NS5c, NS7c  CONTROLS: the same row on the viewer's side, 10 km away → found (and far rows are not)
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import eventsRouter from "../routes/events.js";
import { findNearbyGems } from "../services/hiddenGems/HiddenGemDiscoveryService.js";
import { listMapTravelersRead, _clearMapTravelersCache } from "../lib/mapTravelers.js";
import { loadNearbyEvents } from "../routes/mapSearch.js";

type Row = Record<string, unknown>;
const VIEWER = "00000000-0000-0000-0002-0000000000e9";
const HOST = "00000000-0000-0000-0001-0000000000e9";
const TAVEUNI = { lat: -16.82, lng: 179.98 };
const ACROSS = { lat: -16.82, lng: -179.926 };   // ~10 km east of TAVEUNI, across the line
const SAME_SIDE = { lat: -16.82, lng: 179.886 };  // ~10 km west of TAVEUNI
const FAR = { lat: -16.82, lng: 170 };
const NORTH80 = { lat: 80, lng: 15 };
const EAST45_AT80 = { lat: 80, lng: 15 + 45 / (111.32 * Math.cos((80 * Math.PI) / 180)) };

// ── A PostgREST-shaped double: filters applied, `.or()` parsed, errors resolved, never thrown ─────────────────────────
type Pred = (r: Row) => boolean;
function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let cur = "";
  for (const ch of s) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch; }
  if (cur) out.push(cur);
  return out;
}
function term(t: string): Pred {
  const nested = /^(and|or)\((.*)\)$/.exec(t);
  if (nested) { const parts = splitTop(nested[2]).map(term); return nested[1] === "and" ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r)); }
  const m = /^([a-z_]+)\.(gte|lte|gt|lt|eq|is)\.(.*)$/.exec(t);
  if (!m) throw new Error(`unsupported or-term: ${t}`);
  const [, c, op, raw] = m;
  const num = raw.trim() !== "" && Number.isFinite(Number(raw));
  return (r) => {
    const x = r[c] as any;
    if (op === "is") return raw === "null" ? x == null : String(x) === raw;
    if (x == null) return false;
    const v: any = num && typeof x === "number" ? Number(raw) : raw;
    return op === "gte" ? x >= v : op === "lte" ? x <= v : op === "gt" ? x > v : op === "lt" ? x < v : String(x) === String(v);
  };
}
function makeDb(tables: Record<string, Row[]>) {
  function chain(name: string) {
    let rows = [...(tables[name] ?? [])];
    let cap: number | null = null;
    const done = () => ({ data: cap === null ? rows : rows.slice(0, cap), error: null });
    const q: any = {
      select: () => q,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
      neq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] !== v); return q; },
      in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q; },
      gte: (c: string, v: any) => { rows = rows.filter((r) => r[c] != null && (r[c] as any) >= v); return q; },
      lte: (c: string, v: any) => { rows = rows.filter((r) => r[c] != null && (r[c] as any) <= v); return q; },
      gt: (c: string, v: any) => { rows = rows.filter((r) => r[c] != null && (r[c] as any) > v); return q; },
      lt: (c: string, v: any) => { rows = rows.filter((r) => r[c] != null && (r[c] as any) < v); return q; },
      is: (c: string, v: unknown) => { rows = rows.filter((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      not: (c: string, op: string, v: unknown) => {
        if (op === "is" && v === null) rows = rows.filter((r) => r[c] != null);
        else if (op === "in") { const list = String(v).replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/"/g, "")); rows = rows.filter((r) => !list.includes(String(r[c]))); }
        return q;
      },
      ilike: (c: string, p: string) => { const n = p.replace(/%/g, "").toLowerCase(); rows = rows.filter((r) => String(r[c] ?? "").toLowerCase().includes(n)); return q; },
      contains: () => q, overlaps: () => q, filter: () => q, match: () => q,
      or: (expr: string) => { const p = term(`or(${expr})`); rows = rows.filter(p); return q; },
      order: () => q,
      limit: (n: number) => { cap = n; return q; },
      range: (a: number, b: number) => { rows = rows.slice(a, b + 1); return q; },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "No rows" } }),
      insert: () => Promise.resolve({ data: null, error: null }),
      upsert: () => Promise.resolve({ data: null, error: null }),
      update: () => q,
      delete: () => q,
      then: (res: any, rej: any) => Promise.resolve(done()).then(res, rej),
    };
    return q;
  }
  return {
    from: (name: string) => chain(name),
    rpc: () => Promise.resolve({ data: [], error: null }),
    auth: { getUser: async (t: string) => (t === `tok-${VIEWER}` ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "Invalid token" } }) },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function eventRow(i: number, at: { lat: number; lng: number }): Row {
  return {
    id: `00000000-0000-0000-00e9-${String(i).padStart(12, "0")}`, host_id: HOST, title: `Event ${i}`, description: null, location_name: "Somewhere",
    location_lat: at.lat, location_lng: at.lng, starts_at: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(), ends_at: null,
    cover_url: null, max_attendees: null, age_min: null, age_max: null, trust_score_min: null, verified_only: false, visibility: "public", state: "open",
    chat_enabled: false, chat_thread_id: null, waitlist_enabled: false, price_type: "free", price_url: null, rsvp_options: ["going"], going_count: 0,
    waitlist_count: 0, category: "music", city: "Somewhere", country: "FJ", show_exact_location: true, rsvp_closed: false, tags: [],
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}
const FLAGS = [{ flag: "events_enabled", enabled: true }, { flag: "events_trust_gates_enabled", enabled: true }, { flag: "hidden_gems_enabled", enabled: true }];
function gemRow(i: number, at: { lat: number; lng: number }): Row {
  return {
    id: `00000000-0000-0000-00a9-${String(i).padStart(12, "0")}`, name: `Gem ${i}`, description: "d", category: "viewpoint", city: "Somewhere", country: "FJ", neighborhood: null,
    latitude: at.lat, longitude: at.lng, approx_latitude: null, approx_longitude: null, exact_location_hidden: false, vibe_tags: [], price_range: null, safety_notes: null,
    best_time_to_go: null, local_etiquette: null, layover_safe: false, minimum_layover_minutes: null, sensitivity_level: "normal", verification_level: "community", status: "active",
    crowd_level: null, submitted_by: HOST, guide_verified_by: null, save_count: 0, visit_count: 0, report_count: 0, image_url: null, canonical_place_id: null, source_type: "user",
    moderation_status: "approved", created_at: new Date().toISOString(), updated_at: new Date(Date.now() - i * 1000).toISOString(),
  };
}
function travelerWorld(at: Array<{ id: string; lat: number; lng: number }>): Record<string, Row[]> {
  const t0 = Date.now();
  return {
    user_location_state: at.map((p) => ({ user_id: p.id, lat: p.lat, lng: p.lng, city: "Somewhere", country: "FJ", last_known_at: new Date(t0 - 60_000).toISOString() })),
    location_preferences: at.map((p) => ({ user_id: p.id, location_mode: "nearby", sharing_paused: false, discovery_visibility: null })),
    profiles: at.map((p) => ({ id: p.id, handle: p.id.slice(0, 8), name: p.id, display_name: p.id, avatar_url: null, show_profile_picture_publicly: true, verified: false, open_to_meet: false, is_private: false, account_status: "active" })),
    profile_privacy_settings: [], user_privacy_settings: [],
  };
}

let server: http.Server | null = null;
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });
beforeEach(() => { _clearMapTravelersCache(); });

async function nearbyEvents(rows: Row[], at: { lat: number; lng: number }, radiusKm = 50): Promise<string[]> {
  _setTestClient(makeDb({ feature_flags: FLAGS, events: rows, profiles: [{ id: VIEWER, verified: true, date_of_birth: "1990-01-01" }] }) as never, true);
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { log: object }).log = { error() {}, warn() {}, info() {} }; next(); });
  app.use("/api", eventsRouter);
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  const port = (server!.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/events/nearby?lat=${at.lat}&lng=${at.lng}&radiusKm=${radiusKm}&limit=50`, { headers: { authorization: `Bearer tok-${VIEWER}` } });
  const body = (await res.json()) as { events?: Array<{ id: string }> };
  assert.equal(res.status, 200, JSON.stringify(body));
  return (body.events ?? []).map((e) => e.id);
}
const gemIds = async (rows: Row[], at: { lat: number; lng: number }) => ((await findNearbyGems(makeDb({ hidden_gems: rows, feature_flags: FLAGS }) as never, at.lat, at.lng, 50)).ranked ?? []).map((r: any) => r.gem?.id ?? r.id);
const travelerIds = async (at: Array<{ id: string; lat: number; lng: number }>, from: { lat: number; lng: number }) =>
  ((await listMapTravelersRead(makeDb(travelerWorld(at)) as never, { viewerId: VIEWER, lat: from.lat, lng: from.lng, radiusKm: 50, blockedSet: new Set() }))?.travelers ?? []).map((t: any) => t.id ?? t.userId);
const loadedIds = async (rows: Row[], from: { lat: number; lng: number }) => ((await loadNearbyEvents(makeDb({ events: rows, feature_flags: FLAGS, profiles: [{ id: VIEWER, verified: true, date_of_birth: "1990-01-01" }] }), VIEWER, from.lat, from.lng, 50, new Set())) ?? []).map((e: any) => e.id);

describe("census-discovery §116 (SW13): every near read keeps the rows within its radius", () => {
  it("NS1c CONTROL: GET /events/nearby, an event 10 km away on the viewer's side → listed; one 1000 km away is not", async () => {
    assert.deepEqual(await nearbyEvents([eventRow(1, SAME_SIDE), eventRow(2, FAR)], TAVEUNI), [eventRow(1, SAME_SIDE).id]);
  });
  it("NS1 GET /events/nearby, an event ~10 km away across the antimeridian → listed", async () => {
    assert.deepEqual(await nearbyEvents([eventRow(1, ACROSS)], TAVEUNI), [eventRow(1, ACROSS).id]);
  });
  it("NS2 GET /events/nearby, 89.8°N, an event across the pole (~45 km) → listed", async () => {
    assert.deepEqual(await nearbyEvents([eventRow(1, { lat: 89.8, lng: -165 })], { lat: 89.8, lng: 15 }), [eventRow(1, { lat: 0, lng: 0 }).id]);
  });

  it("NS3c CONTROL: findNearbyGems, a gem 10 km away on the viewer's side → found; one 1000 km away is not", async () => {
    assert.deepEqual(await gemIds([gemRow(1, SAME_SIDE), gemRow(2, FAR)], TAVEUNI), [gemRow(1, SAME_SIDE).id]);
  });
  it("NS3 findNearbyGems, a gem ~10 km away across the antimeridian → found", async () => {
    assert.deepEqual(await gemIds([gemRow(1, ACROSS)], TAVEUNI), [gemRow(1, ACROSS).id]);
  });
  it("NS4 findNearbyGems, 80°N, a gem 45 km east (radius 50) → found", async () => {
    assert.deepEqual(await gemIds([gemRow(1, EAST45_AT80)], NORTH80), [gemRow(1, EAST45_AT80).id]);
  });

  it("NS5c CONTROL: listMapTravelersRead, a traveler 10 km away on the viewer's side → returned; one 1000 km away is not", async () => {
    assert.deepEqual(await travelerIds([{ id: "t-same", ...SAME_SIDE }, { id: "t-far", ...FAR }], TAVEUNI), ["t-same"]);
  });
  it("NS5 listMapTravelersRead, a traveler ~10 km away across the antimeridian → returned", async () => {
    assert.deepEqual(await travelerIds([{ id: "t-across", ...ACROSS }], TAVEUNI), ["t-across"]);
  });
  it("NS6 listMapTravelersRead, 80°N, a traveler 45 km east (radius 50) → returned", async () => {
    assert.deepEqual(await travelerIds([{ id: "t-north", ...EAST45_AT80 }], NORTH80), ["t-north"]);
  });

  it("NS7c CONTROL: loadNearbyEvents, an event 10 km away on the viewer's side → loaded; one 1000 km away is not", async () => {
    assert.deepEqual(await loadedIds([eventRow(1, SAME_SIDE), eventRow(2, FAR)], TAVEUNI), [eventRow(1, SAME_SIDE).id]);
  });
  it("NS7 loadNearbyEvents, an event ~10 km away across the antimeridian → loaded", async () => {
    assert.deepEqual(await loadedIds([eventRow(1, ACROSS)], TAVEUNI), [eventRow(1, ACROSS).id]);
  });
  it("NS8 loadNearbyEvents, 80°N, an event 45 km east (radius 50) → loaded", async () => {
    assert.deepEqual(await loadedIds([eventRow(1, EAST45_AT80)], NORTH80), [eventRow(1, EAST45_AT80).id]);
  });
});

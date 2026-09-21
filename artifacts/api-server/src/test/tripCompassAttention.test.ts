/**
 * Trips spec §17.2 on the Compass search tools — census-trips TR319.
 *
 * search_places and search_events consult the trip's priority switch (the
 * named trip, else the user's current trip) through the REAL health
 * projection, and withhold commercial / entertainment candidates while the
 * trip needs attention. Safety and logistics candidates stay. A switch that
 * cannot be read withholds nothing and says so. Through executeCompassTool,
 * so the dispatcher, the privacy sanitizer and the wire shape are the ones
 * the conversation gets.
 *
 * Run: node --import tsx/esm --test src/test/tripCompassAttention.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeCompassTool, COMPASS_TOOL_DEFINITIONS } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";
import { base } from "./tripHealthProjection.test.js";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FUTURE    = new Date(Date.now() + 3 * 86_400_000).toISOString();

type Row = Record<string, any>;

/** A fake wide enough for the search tools AND the health projection's reads. */
function makeClient(tables: Record<string, Row[]>) {
  const like = (pat: string) => new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let single = false; let lim: number | null = null;
      const settle = () => {
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (lim !== null) rows = rows.slice(0, lim);
        return { data: single ? rows[0] ?? null : rows, error: null };
      };
      const b: any = {
        select: () => b,
        eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
        neq: (c: string, v: any) => { filters.push((r) => r[c] !== v); return b; },
        in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return b; },
        is: (c: string, v: any) => { filters.push((r) => (r[c] ?? null) === v); return b; },
        gt: (c: string, v: any) => { filters.push((r) => r[c] > v); return b; },
        gte: (c: string, v: any) => { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
        lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return b; },
        lte: (c: string, v: any) => { filters.push((r) => r[c] <= v); return b; },
        ilike: (c: string, p: string) => { const re = like(p); filters.push((r) => re.test(String(r[c] ?? ""))); return b; },
        like: (c: string, p: string) => { const re = like(p); filters.push((r) => re.test(String(r[c] ?? ""))); return b; },
        or: (expr: string) => {
          const parts = expr.split(",").map((p) => p.trim().match(/^(\w+)\.(\w+)\.(.*)$/)).filter(Boolean) as RegExpMatchArray[];
          filters.push((r) => parts.some((m) => m[2] === "ilike" ? like(m[3]!).test(String(r[m[1]!] ?? "")) : String(r[m[1]!]) === m[3]));
          return b;
        },
        not: (c: string, op: string, v: string) => {
          if (op === "in") { const set = new Set(String(v).replace(/^\(|\)$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, ""))); filters.push((r) => !set.has(String(r[c] ?? ""))); }
          return b;
        },
        order: () => b,
        limit: (n: number) => { lim = n; return b; },
        range: (from: number, to: number) => { lim = to - from + 1; return b; },
        maybeSingle: async () => { single = true; return settle(); },
        single: async () => { single = true; return settle(); },
        then: (onF: any, onR: any) => Promise.resolve(settle()).then(onF, onR),
      };
      return b;
    },
  } as any;
}

function profileFor(userId: string): CompassProfile {
  return { userId, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [], currentCity: "Paris" } as unknown as CompassProfile;
}

/** The health fixture (a calm Paris trip) plus a catalog: a pharmacy and a bar; a safety briefing and a night market. */
function tables(opts: { regroupOpen?: boolean; gate?: boolean } = {}): Record<string, Row[]> {
  const t = base();
  t.feature_flags = [{ flag: "trip_operational_projections_enabled", enabled: opts.gate ?? true }];
  if (opts.regroupOpen) {
    t.trip_meeting_checkpoints = [{ id: "cp1", trip_id: TRIP_ID, label: "Fountain", purpose: "regroup", status: "open" }];
    t.trip_meeting_checkpoint_participants = [
      { checkpoint_id: "cp1", user_id: OWNER_ID, arrival_state: "arrived" },
      { checkpoint_id: "cp1", user_id: MEMBER_ID, arrival_state: "en_route" },
    ];
  }
  t.discovery_places = [
    { id: "p-pharm", name: "Pharmacie Centrale", category: "pharmacy", primary_category: "health", city: "Paris", rating: 4, saved_count: 2, verified: true, blurb: "24h" },
    { id: "p-bar",   name: "Le Comptoir",        category: "nightlife", primary_category: "bar", city: "Paris", rating: 4.5, saved_count: 9, verified: true, blurb: "cocktails" },
  ];
  t.events = [
    { id: "e-safety", title: "Embassy safety briefing", description: "for visitors", city: "Paris", country: "FR", starts_at: FUTURE, category: "safety", host_id: OTHER_ID, state: "open", visibility: "public" },
    { id: "e-market", title: "Night market",            description: "food and music", city: "Paris", country: "FR", starts_at: FUTURE, category: "nightlife", host_id: OTHER_ID, state: "open", visibility: "public" },
  ];
  return t;
}

describe("search_places under the §17.2 switch", () => {
  it("SAFETY_EVENT (open regroup): the pharmacy is offered, the bar is withheld, and the result says why", async () => {
    const r: any = await executeCompassTool(makeClient(tables({ regroupOpen: true })), OWNER_ID, profileFor(OWNER_ID), "search_places", { city: "Paris", tripId: TRIP_ID });
    assert.deepEqual(r.candidates.map((c: any) => c.id), ["p-pharm"]);
    assert.equal(r.attention.consulted, true);
    assert.equal(r.attention.mode, "SAFETY_EVENT");
    assert.equal(r.attention.suppressed, true);
    assert.equal(r.attention.reason, "TRIP_DISRUPTION_SUPPRESSED");
    assert.equal(r.attention.withheld, 1);
    assert.equal(r.attention.tripId, TRIP_ID);
  });
  it("the same catalog when everyone has arrived: both offered, switch consulted, nothing withheld", async () => {
    const t = tables({ regroupOpen: true });
    t.trip_meeting_checkpoint_participants![1]!.arrival_state = "arrived";
    const r: any = await executeCompassTool(makeClient(t), OWNER_ID, profileFor(OWNER_ID), "search_places", { city: "Paris", tripId: TRIP_ID });
    assert.equal(r.candidates.length, 2);
    assert.equal(r.attention.consulted, true); assert.equal(r.attention.mode, "NORMAL");
    assert.equal(r.attention.suppressed, false); assert.equal(r.attention.withheld, 0); assert.equal(r.attention.reason, null);
  });
  it("no tripId: the user's CURRENT trip's switch is the one consulted", async () => {
    const r: any = await executeCompassTool(makeClient(tables({ regroupOpen: true })), MEMBER_ID, profileFor(MEMBER_ID), "search_places", { city: "Paris" });
    assert.deepEqual(r.candidates.map((c: any) => c.id), ["p-pharm"]);
    assert.equal(r.attention.tripId, TRIP_ID); assert.equal(r.attention.suppressed, true);
  });
  it("gate closed: the switch is not readable — nothing withheld, and the result says it was not consulted", async () => {
    const r: any = await executeCompassTool(makeClient(tables({ regroupOpen: true, gate: false })), OWNER_ID, profileFor(OWNER_ID), "search_places", { city: "Paris", tripId: TRIP_ID });
    assert.equal(r.candidates.length, 2);
    assert.equal(r.attention.consulted, false); assert.equal(r.attention.suppressed, false);
    assert.match(r.attention.info, /not readable/);
  });
  it("a trip the user is not on: not consulted, nothing withheld; no trip at all: not consulted", async () => {
    let r: any = await executeCompassTool(makeClient(tables({ regroupOpen: true })), OTHER_ID, profileFor(OTHER_ID), "search_places", { city: "Paris", tripId: TRIP_ID });
    assert.equal(r.candidates.length, 2); assert.equal(r.attention.consulted, false); assert.match(r.attention.info, /not a member/);
    r = await executeCompassTool(makeClient(tables({ regroupOpen: true })), OTHER_ID, profileFor(OTHER_ID), "search_places", { city: "Paris" });
    assert.equal(r.candidates.length, 2); assert.equal(r.attention.consulted, false); assert.equal(r.attention.tripId, null);
  });
  it("everything withheld: no candidates, and the info says they were withheld rather than 'none found'", async () => {
    const t = tables({ regroupOpen: true });
    t.discovery_places = t.discovery_places!.filter((p) => p.id === "p-bar");
    const r: any = await executeCompassTool(makeClient(t), OWNER_ID, profileFor(OWNER_ID), "search_places", { city: "Paris", tripId: TRIP_ID });
    assert.deepEqual(r.candidates, []); assert.match(r.info, /withheld/); assert.equal(r.attention.withheld, 1);
  });
});

describe("search_events under the §17.2 switch", () => {
  it("SAFETY_EVENT: the safety briefing is offered, the night market is withheld", async () => {
    const r: any = await executeCompassTool(makeClient(tables({ regroupOpen: true })), OWNER_ID, profileFor(OWNER_ID), "search_events", { city: "Paris", tripId: TRIP_ID });
    assert.deepEqual(r.candidates.map((c: any) => c.id), ["e-safety"]);
    assert.equal(r.attention.suppressed, true); assert.equal(r.attention.withheld, 1);
  });
  it("NORMAL: both offered", async () => {
    const r: any = await executeCompassTool(makeClient(tables()), OWNER_ID, profileFor(OWNER_ID), "search_events", { city: "Paris", tripId: TRIP_ID });
    assert.equal(r.candidates.length, 2); assert.equal(r.attention.suppressed, false); assert.equal(r.attention.consulted, true);
  });
  it("the tool declarations name tripId so the model can pass it", () => {
    for (const name of ["search_places", "search_events"]) {
      const decl: any = (COMPASS_TOOL_DEFINITIONS as any[]).find((t) => t.function?.name === name);
      assert.ok(decl, name);
      assert.ok(decl.function.parameters.properties.tripId, `${name} declares tripId`);
    }
  });
});

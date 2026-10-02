/**
 * census-discovery §57 — A07 on GET /discovery's two COMPASS serve points.
 *
 * With `discovery_live_rank_enabled` ON (in this process only), serve paths 1
 * (cache A) and 4 (cold) demote a Live `unsafe_density` place; serve paths 2
 * (`compass_candidate_hit`) and 3 (`compass_fresh_rank`) serve Compass's
 * pipeline order and, before the routed hunk, applied NO Discovery safety at
 * all — their only safety is Compass's own Live exclusion behind the
 * COMPASS_LIVE_CONSTRAINTS_ENABLED environment switch, which this suite leaves unset,
 * as it is by default.
 *
 * routes/discovery.ts is not this lane's file, so the fix is a HUNK for the
 * integrator (census-discovery §57): serve paths 2 and 3 pass their order
 * through `lib/discoveryLiveRankRead.withDiscoveryLiveSafety` and hand its
 * demoted-only grades to the projection. C1 is registered as TODO until that
 * hunk lands: it FAILS on this branch (the defect, observed) and PASSES with
 * the hunk applied — both runs recorded in §57. Flip `todo` off when merging
 * the hunk. C2 and C3 are the flags-off controls and must pass either way.
 *
 * Run: node --import tsx/esm --test src/test/discoveryLiveSafetyCompassPath.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";

import discoveryRouter, {
  _setTestDbPlacesOverride,
  _clearTestCompassCache,
  type DiscoveryPlace,
} from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateCandidateProjectionFlagCache, type DiscoveryCandidate } from "../lib/discoveryCandidate.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";

// ── Block external network calls: the cold path must not reach Overpass. ─────
const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (u.includes("overpass-api.de") || u.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url as string, init);
};

const USER = "cccc3333-0000-0000-0000-000000000003";
const TOKEN = "compass-safety-tok";
const NOW = Date.now();
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-bbbb-4bbb-8bbb-${n.toString(16).padStart(12, "0")}`;
function place(n: number, savedCount: number): DiscoveryPlace {
  const id = uuid(n);
  return {
    id: `db/${id}`, canonicalPlaceId: id, name: `Place ${n}`, category: "for_you", type: "traveler_pick",
    description: null, distanceKm: 1, lat: 25.77, lng: -80.19, tags: [], address: "Miami, FL",
    website: null, phone: null, openingHours: null, rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

const LIVE_GATES_OPEN = [
  { flag: "intel_live_label_crowd", enabled: true },
  { flag: "intel_claim_projection_crowd", enabled: true },
  { flag: "intel_capture_quick_signal", enabled: true },
  { flag: "intel_limited_live", enabled: true },
];

function unsafeSnapshot(subject: string) {
  return {
    id: `snap-${subject.slice(0, 8)}`, subject_id: subject, zone_id: null, claim_type: "crowd.level",
    value: { level: "unsafe_density" }, confidence: 0.9, source_count: 30, observed_at: iso(-3), expires_at: iso(45),
    privacy_eligible: true, conflict_state: "none", source_class: "firsthand_unverified", computed_at: iso(-3),
  };
}

/**
 * fakeMapDb plus the two things the Compass path needs that a Map read double
 * does not model: `.like()` (the Compass flag layer reads the COMPASS_% family)
 * and a sink for the serve path's fire-and-forget writes.
 */
/** Tables read through the double, in order — C2 asserts on it. */
const tablesRead: string[] = [];

function compassCapable(state: FakeState): any {
  const inner = makeFakeMapDb(state, { token: TOKEN, userId: USER });
  const accept = () => {
    const done: any = {
      select: () => done, eq: () => done, in: () => done,
      single: async () => ({ data: null, error: null }), maybeSingle: async () => ({ data: null, error: null }),
      then: (r: any, j?: any) => Promise.resolve({ data: null, error: null }).then(r, j),
    };
    return done;
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          tablesRead.push(table);
          const rows = (Array.isArray(state[table]) ? state[table] : ((state[table] as any)?.rows ?? [])) as any[];
          // Every chained call that hands the builder back is re-wrapped, so a
          // `.like()` after `.select()` still reaches this proxy.
          const wrap = (builder: any): any => new Proxy(builder, {
            get(bt, p) {
              if (p === "insert" || p === "upsert" || p === "update" || p === "delete") return () => accept();
              if (p === "like" || p === "ilike") {
                return (col: string, pattern: string) => {
                  const body = String(pattern).split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, ".")).join(".*");
                  const re = new RegExp(`^${body}$`, p === "ilike" ? "i" : "");
                  const hit = rows.filter((r) => re.test(String(r[col] ?? "")));
                  return { then: (r: any, j?: any) => Promise.resolve({ data: hit, error: null }).then(r, j) };
                };
              }
              const v = bt[p];
              if (typeof v !== "function") return v;
              if (p === "then") return v.bind(bt);
              return (...args: unknown[]) => { const out = v.apply(bt, args); return out === bt ? wrap(out) : out; };
            },
          });
          return wrap(target.from(table));
        };
      }
      if (prop === "rpc") return async () => ({ data: null, error: null });
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

function world(liveRank: boolean, snapshots: any[]): FakeState {
  return {
    feature_flags: [
      { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true },
      { flag: "DISCOVERY_ENGINE_MODE", enabled: false, metadata: { mode: "legacy" } },
      { flag: "discovery_candidate_projection_enabled", enabled: true },
      ...(liveRank ? [{ flag: "discovery_live_rank_enabled", enabled: true }] : []),
      ...LIVE_GATES_OPEN,
    ],
    intel_live_promoted_scopes: [{ scope_key: "|crowd.level" }],
    intel_state_snapshots: snapshots,
  };
}

interface Body {
  cached: boolean;
  places: Array<{ id: string; candidate?: DiscoveryCandidate }>;
  meta?: { cacheLevel?: string };
}

describe("§57 A07 — the Compass serve points of GET /discovery", () => {
  let server: Server;
  let url: string;
  const ROWS = [place(1, 900), place(2, 50), place(3, 10)];
  const DANGEROUS = ROWS[0]!;

  const reset = () => {
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    invalidateLiveRankFlagCache();
    invalidateCandidateProjectionFlagCache();
    _clearPromotedScopeCache();
  };
  beforeEach(async () => {
    server = createServer((() => {
      const app = express();
      app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
      app.use(discoveryRouter);
      return app;
    })());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    server.unref();
    url = `http://127.0.0.1:${(server.address() as any).port as number}`;
    _setTestDbPlacesOverride(async () => ROWS.map((p) => ({ ...p })));
    reset();
  });
  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    reset();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function get(state: FakeState): Promise<Body> {
    tablesRead.length = 0;
    _setTestServiceClient(compassCapable(state));
    const res = await fetch(`${url}/discovery?destination=Miami&category=for_you&lat=25.77&lng=-80.19&radiusKm=10`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Body;
  }

  it("C0 the harness reaches the Compass serve point (fresh rank, then the cache-B hit)", async () => {
    const fresh = await get(world(false, []));
    assert.equal(fresh.cached, false);
    assert.equal(fresh.places[0]?.candidate?.freshness.servedFrom, "compass_fresh_rank");
    const hit = await get(world(false, []));
    assert.equal(hit.cached, true);
    assert.equal(hit.places[0]?.candidate?.freshness.servedFrom, "compass_candidate_hit");
  });

  it("C1 live rank ON: a Live unsafe_density place is never first on either Compass serve point, and is never told 'open around now'", async () => {  // census-discovery §57.13: the routed hunk is applied, so C1 runs (was `todo`)
    const snaps = [unsafeSnapshot(DANGEROUS.canonicalPlaceId!)];
    for (const label of ["compass_fresh_rank", "compass_candidate_hit"]) {
      const body = await get(world(true, snaps));
      assert.equal(body.places[0]?.candidate?.freshness.servedFrom, label);
      assert.ok(tablesRead.includes("intel_state_snapshots"), `${label}: the live claim was never read — nothing was checked`);
      const ids = body.places.map((p) => p.id);
      assert.equal(ids[ids.length - 1], DANGEROUS.id, `${label}: the dangerous place is not last — ${JSON.stringify(ids)}`);
      const c = body.places.find((p) => p.id === DANGEROUS.id)!.candidate!;
      assert.deepEqual(c.whyNow, ["crowd_unsafe_density"], `${label}: the demoted place carries no safety why-now`);
      assert.equal(c.reasons.some((r) => r.code === "nearby_now"), false, `${label}: the dangerous place was told "open around now"`);
      for (const p of body.places.filter((x) => x.id !== DANGEROUS.id)) {
        assert.equal(p.candidate?.whyNow, null, `${label}: a safety-only pass must add no other why-now`);
      }
    }
  });

  it("C2 CONTROL, live rank OFF: the Compass order is served untouched and no claim is read", async () => {
    const state = world(false, []);
    state.intel_state_snapshots = { error: { message: "must not be read with the flag off" } };
    const body = await get(state);
    assert.equal(body.places[0]?.candidate?.freshness.servedFrom, "compass_fresh_rank");
    for (const p of body.places) assert.equal(p.candidate?.whyNow, null);
    assert.equal(tablesRead.includes("intel_state_snapshots"), false, "a live claim was read on the Compass path with the flag off");
    // The control that makes the line above mean something is in C1: with the
    // flag ON and the hunk applied, the same serve DOES read the snapshot table.
  });

  it("C3 CONTROL, live rank ON with nothing dangerous: the Compass order is exactly the flag-off order", async () => {
    const off = (await get(world(false, []))).places.map((p) => p.id);
    reset();
    const on = (await get(world(true, []))).places.map((p) => p.id);
    assert.deepEqual(on, off);
  });
});

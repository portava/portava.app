/**
 * discoveryVerifyAudit2.test.ts — census-discovery §66 (re-verification lane
 * P20): runnable negative inputs for four rows graded C whose evidence the row
 * audit found contradicted — DV-30, C32, DC-26 and B01. Same form as §59's
 * discoveryVerifyAudit.test.ts: each case is a DEFECT or LIMIT pinned so that a
 * fix turns it red and forces the census to be updated, or a CONTROL that shows
 * the probe itself is sound. This file changes no code.
 *
 *   T1  DEFECT (DV-30): exposure alone makes a place trend. Three served
 *       impressions and no engagement read `emerging`, with a public sentence,
 *       and carry momentum 0.5 — in the place kernel and in the Trail fold.
 *   T2  DEFECT (DV-30): at equal engagement, more exposure is more velocity.
 *   T1c CONTROL: two impressions stay `unknown`, so T1's claim is made by the
 *       third impression crossing the floor, not by a default.
 *   R1  DEFECT (C32): one route, two rankers. A signed-in `for_you` page is
 *       ordered by Compass's `rankItemsForDiscovery`; the same viewer's page in
 *       another category is ordered by the PDE pipeline.
 *   R1c CONTROL: the same `for_you` request with the Compass flag OFF is
 *       ordered by PDE, so R1's "compass" is the second pipeline, not a label.
 *   R2  CONTROL (C32's evidence clause): the route imports portavaRank
 *       type-only, and the ranker it value-imports is Compass's.
 *   D1  LIMIT (DC-26): the CI rehearsal applies and certifies migrations on
 *       `refs/heads/main` only; a branch run is a dry run.
 *   D1c CONTROL: the rehearsal steps exist, in order, so D1 reads a real job;
 *       and D1's reading rejects the same text with the main-only clause
 *       removed (in memory), so it is not green by accepting anything.
 *   B1  DEFECT (B01): Ǿ/ǿ — ø with an acute — fold to nothing while Ø folds to
 *       "o", so the acute changes the key.
 *   B2  CONTROL (B01): every Latin letter whose canonical decomposition is an
 *       ASCII letter plus diacritics (488) folds to that letter's key, and the
 *       fourteen stroke-table letters fold.
 *   B3  LIMIT (outside B01, decided from the text): ß æ œ þ ŋ and fullwidth
 *       Latin are not diacritics; they are deleted, and a fullwidth query is
 *       refused before any read rather than matching every row.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";

import { computeTrendStates, trendReasonFor } from "../lib/discoveryTrendState.js";
import { computeLocalMomentum, type MomentumRow } from "../lib/discoveryLocalMomentum.js";
import { trailMomentumFromRankEvents } from "../lib/discoveryTrailAffinity.js";
import { searchKey, strokeFold } from "../lib/canonicalLocations.js";
import { readCanonicalCitySuggestions } from "../lib/discoverySearchCanonical.js";
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
import { invalidateFlagsCache as invalidateCompassFlagsCache } from "../compass/flags.js";
import { makeFakeMapDb, type FakeState } from "./helpers/fakeMapDb.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const served = (item: string, h: number): MomentumRow => ({ item_id: item, outcome: "impression", served_at: hoursAgo(h), outcome_at: null });
const saved = (item: string, h: number): MomentumRow => ({ item_id: item, outcome: "save", served_at: hoursAgo(h), outcome_at: hoursAgo(h) });

// ── DV-30 ─────────────────────────────────────────────────────────────────────
describe("§66 DV-30 — `03` §14 'it normalizes for exposure', probed on trend velocity", () => {
  it("T1. DEFECT (DV-30): three impressions and no engagement read as an emerging trend with momentum", () => {
    const rows = [served("db/only-served", 1), served("db/only-served", 2), served("db/only-served", 3)];
    const reading = computeTrendStates(rows, NOW)["db/only-served"]!;
    assert.equal(reading.state, "emerging", "exposure alone crosses the evidence floor and is classified as a trend");
    assert.equal(reading.evidence.recentRate, 3, "each impression is counted as one unit of activity");
    assert.ok(trendReasonFor(reading.state), "and the state carries a public reason sentence");
    const m = computeLocalMomentum(rows, NOW).values["db/only-served"] ?? 0;
    assert.equal(m, 0.5, `the momentum kernel gives exposure alone ${m}`);
    const trail = trailMomentumFromRankEvents(rows, [{ trail_id: "trail-1", source_id: "db/only-served" } as any], NOW);
    assert.equal(trail["trail-1"], 0.5, "the Trail fold inherits it: a Trail whose members were only served is trending");
  });

  it("T1c. CONTROL: two impressions stay 'unknown' with no momentum, so T1 is the third impression, not a default", () => {
    const rows = [served("db/twice", 1), served("db/twice", 2)];
    assert.equal(computeTrendStates(rows, NOW)["db/twice"]!.state, "unknown");
    assert.equal(computeLocalMomentum(rows, NOW).values["db/twice"] ?? 0, 0);
  });

  it("T2. DEFECT (DV-30): at ONE save each, the place served ten times as often has 5.5× the velocity", () => {
    const rows: MomentumRow[] = [saved("db/wide", 1), saved("db/narrow", 1)];
    for (let i = 0; i < 29; i++) rows.push(served("db/wide", 2 + i / 10));
    for (let i = 0; i < 2; i++) rows.push(served("db/narrow", 2 + i / 10));
    const s = computeTrendStates(rows, NOW);
    const wide = s["db/wide"]!.evidence.recentRate;     // 30 impressions + 1 save: 30 + 3
    const narrow = s["db/narrow"]!.evidence.recentRate; //  3 impressions + 1 save:  3 + 3
    assert.equal(wide, 33);
    assert.equal(narrow, 6);
    assert.ok(wide > narrow,
      `a velocity normalised for exposure would rank 1 save in 3 serves above 1 in 30; this one gives ${wide} vs ${narrow}`);
  });
});

// ── C32 ───────────────────────────────────────────────────────────────────────
const _originalFetch = globalThis.fetch;
globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (u.includes("overpass-api.de") || u.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url as string, init);
};

const USER = "cccc3333-0000-0000-0000-000000000066";
const TOKEN = "p20-two-rankers-tok";
const uuid = (n: number) => `${n.toString(16).padStart(8, "0")}-bbbb-4bbb-8bbb-${n.toString(16).padStart(12, "0")}`;
function place(n: number, category: string, savedCount: number): DiscoveryPlace {
  const id = uuid(n);
  return {
    id: `db/${id}`, canonicalPlaceId: id, name: `Place ${n}`, category, type: "traveler_pick",
    description: null, distanceKm: 1, lat: 25.77, lng: -80.19, tags: [], address: "Miami, FL",
    website: null, phone: null, openingHours: null, rating: null, isOpenNow: null, savedCount,
  } as DiscoveryPlace;
}

/** fakeMapDb plus `.like()` for the Compass flag family and a sink for fire-and-forget writes (as §57's suite). */
function writeTolerant(state: FakeState): any {
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
          const rows = (Array.isArray(state[table]) ? state[table] : ((state[table] as any)?.rows ?? [])) as any[];
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

function world(compassOn: boolean): FakeState {
  return {
    feature_flags: [
      { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: compassOn },
      { flag: "DISCOVERY_ENGINE_MODE", enabled: false, metadata: { mode: "legacy" } },
      { flag: "discovery_candidate_projection_enabled", enabled: true },
    ],
  };
}

interface Body { cached: boolean; places: Array<{ id: string; candidate?: DiscoveryCandidate }> }

describe("§66 C32 — 'One ranking pipeline in the tree', probed on GET /discovery's serve paths", () => {
  let server: Server;
  let url: string;
  const reset = () => {
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    invalidateLiveRankFlagCache();
    invalidateCandidateProjectionFlagCache();
    invalidateCompassFlagsCache();
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
    reset();
  });
  afterEach(async () => {
    _setTestDbPlacesOverride(null);
    _setTestServiceClient(null);
    reset();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function page(category: string, compassOn: boolean): Promise<Body> {
    _setTestDbPlacesOverride(async () => [place(1, category, 900), place(2, category, 50), place(3, category, 10)]);
    _setTestServiceClient(writeTolerant(world(compassOn)));
    const res = await fetch(`${url}/discovery?destination=Miami&category=${category}&lat=25.77&lng=-80.19&radiusKm=10`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Body;
  }
  const rankers = (b: Body) => [...new Set(b.places.map((p) => p.candidate?.rankedBy))];

  it("R1. DEFECT (C32): one viewer, one route, two rankers — Compass orders for_you, PDE orders another category", async () => {
    const forYou = await page("for_you", true);
    assert.ok(forYou.places.length > 0, "the for_you page served rows");
    assert.deepEqual(rankers(forYou), ["compass"], "the signed-in for_you page is ordered by Compass's rankItemsForDiscovery");
    assert.equal(forYou.places[0]?.candidate?.freshness.servedFrom, "compass_fresh_rank");
    reset();
    const food = await page("food", true);
    assert.ok(food.places.length > 0, "the food page served rows");
    assert.deepEqual(rankers(food), ["pde"], "the same viewer's food page, same deployment, is ordered by the PDE pipeline");
  });

  it("R1c. CONTROL: the same for_you request with the Compass flag OFF is ordered by PDE", async () => {
    const body = await page("for_you", false);
    assert.ok(body.places.length > 0);
    assert.deepEqual(rankers(body), ["pde"], "so R1's 'compass' is a second ordering implementation, not a relabelled PDE page");
  });

  it("R2. CONTROL (C32's evidence clause): portavaRank is imported type-only; the ranker value-imported is Compass's", () => {
    const src = readFileSync(new URL("../routes/discovery.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l));
    const portava = imports.filter((l) => /from "\.\.\/lib\/portavaRank(\.js)?"/.test(l));
    assert.ok(portava.length > 0 && portava.every((l) => /^\s*import type\b/.test(l)), `portavaRank imports: ${JSON.stringify(portava)}`);
    assert.ok(imports.some((l) => /^\s*import \{ rankItemsForDiscovery \} from "\.\.\/compass\/CompassFeedBuilder"/.test(l)),
      "the route VALUE-imports Compass's ranker");
  });
});

// ── DC-26 ─────────────────────────────────────────────────────────────────────
function jobBlock(yml: string, job: string): string {
  const start = yml.indexOf(`\n  ${job}:\n`);
  assert.ok(start > 0, `job ${job} not found`);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next > 0 ? rest.slice(0, next + 1) : rest;
}
function stepIf(block: string, name: string): string {
  const i = block.indexOf(`- name: '${name}'`);
  assert.ok(i > 0, `step '${name}' not found`);
  const m = block.slice(i).match(/\n\s+if:\s*(\$\{\{[^\n]*\}\})/);
  assert.ok(m, `step '${name}' has no if:`);
  return m![1]!;
}

describe("§66 DC-26 — `12` 'Required test classes · Database · CI rehearsal'", () => {
  const liveDb = readFileSync(new URL("../../../../.github/workflows/live-db.yml", import.meta.url), "utf8");
  const drift = jobBlock(liveDb, "schema-drift");
  const MAIN = /github\.ref == 'refs\/heads\/main'/;

  it("D1. LIMIT (DC-26): the CI rehearsal applies and certifies on refs/heads/main only; a branch run is a dry run", () => {
    assert.match(stepIf(drift, "migrations — apply to the sanctioned CI project"), MAIN);
    assert.match(stepIf(drift, "migrations — certify the apply landed"), MAIN);
    assert.doesNotMatch(stepIf(drift, "migrations — dry run (ordered plan, writes nothing)"), MAIN,
      "the dry run is the only migration step a branch run executes");
  });

  it("D1c. CONTROL: the rehearsal exists as a job — dry run, apply to the sanctioned project, certify — in that order", () => {
    const dry = drift.indexOf("db:apply-migrations:dry-run");
    const apply = drift.indexOf("db:apply-migrations\n");
    const certify = drift.indexOf("certify:migrations");
    assert.ok(dry > 0 && apply > dry && certify > apply, `order dry=${dry} apply=${apply} certify=${certify}`);
    // The reading discriminates: the same job text with the main-only clause
    // taken off the apply step (in memory — no file is written) no longer
    // matches, so D1 is not green because its matcher accepts anything.
    const opened = drift.replace(
      /(- name: 'migrations — apply to the sanctioned CI project'\n\s+if: \$\{\{[^\n]*?) && github\.ref == 'refs\/heads\/main'/,
      "$1",
    );
    assert.notEqual(opened, drift, "the in-memory edit applied");
    assert.doesNotMatch(stepIf(opened, "migrations — apply to the sanctioned CI project"), MAIN);
  });
});

// ── B01 ───────────────────────────────────────────────────────────────────────
const DIACRITIC = /^[\u0300-\u036f]+$/u;
/** Every precomposed Latin letter whose canonical decomposition is one letter plus combining diacritics. */
function decomposableLetters(): Array<{ ch: string; base: string }> {
  const out: Array<{ ch: string; base: string }> = [];
  for (const [lo, hi] of [[0x00c0, 0x0250], [0x1e00, 0x1f00]] as const) {
    for (let cp = lo; cp < hi; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/\p{L}/u.test(ch)) continue;
      const nfd = ch.normalize("NFD");
      const base = String.fromCodePoint(nfd.codePointAt(0)!);
      const marks = nfd.slice(base.length);
      if (marks.length > 0 && DIACRITIC.test(marks)) out.push({ ch, base });
    }
  }
  return out;
}

describe("§66 B01 — G57 'Diacritic-insensitive matching while preserving display spelling', the stored fold", () => {
  it("B1. FIXED (B01, §73; pinned as a DEFECT in §66): Ǿ/ǿ (ø with an acute) fold to 'o' as Ø does — the acute no longer changes the key", () => {
    assert.equal(searchKey("Øresund"), "oresund");
    assert.equal(searchKey("Ǿresund"), "oresund", "§66 found 'resund': the stroke table ran BEFORE NFD, so the Ø inside Ǿ was deleted");
    assert.equal(searchKey("Ǿresund"), searchKey("Oresund"));
    assert.equal(strokeFold("Ǿ"), "ó", "the cause, closed: strokeFold also looks inside a decomposition; the acute stays for NFD to strip");
    const failing = decomposableLetters()
      .filter(({ ch, base }) => searchKey(`x${ch}x`) !== searchKey(`x${base}x`))
      .map(({ ch }) => ch);
    assert.deepEqual(failing, [], "every letter with a diacritic folds as its undecorated letter");
  });

  it("B2. CONTROL (B01): every other letter-plus-diacritics folds to its undecorated letter, and the stroke table folds", () => {
    const all = decomposableLetters();
    assert.ok(all.length > 450, `enumerated ${all.length} letters`);
    const ascii = all.filter(({ base }) => /^[A-Za-z]$/.test(base));
    for (const { ch, base } of ascii) assert.equal(searchKey(`x${ch}x`), searchKey(`x${base}x`), `${ch} vs ${base}`);
    for (const ch of "đĐøØłŁħĦŧŦðÐıİ") assert.match(searchKey(ch), /^[a-z]$/, `${ch} → ${JSON.stringify(searchKey(ch))}`);
  });

  it("B3. LIMIT (not B01 — not diacritics): ß æ œ þ ŋ and fullwidth Latin are deleted; a fullwidth query reads nothing", async () => {
    assert.equal(searchKey("Straße"), "stra e");
    assert.notEqual(searchKey("Gießen"), searchKey("Giessen"));
    assert.equal(searchKey("Æbeltoft"), "beltoft");
    assert.equal(searchKey("Þingvellir"), "ingvellir");
    assert.equal(searchKey("Ŋ"), "");
    assert.equal(searchKey("Ｔｏｋｙｏ"), "", "fullwidth Latin (a CJK keyboard in fullwidth mode) folds to nothing");
    let reads = 0;
    const sc = { from: () => { reads += 1; throw new Error("must not read"); } };
    const rows = await readCanonicalCitySuggestions(sc, "Ｔｏｋｙｏ", 4);
    assert.deepEqual([...rows], [], "an empty key is refused before any read — never an ilike '%%' that matches every city");
    assert.equal(reads, 0);
  });
});

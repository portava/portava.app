/**
 * census-media §43 — a post's location mode, honoured by the post readers
 * census-media §42.6 recorded and left open.
 *
 * THE ONE RULE. A non-owner may not receive a post's place when mapPublicPost
 * would withhold it: `postPlaceWithheld(row)` (lib/postSchemas), with the owner
 * bypass written once in lib/postPlaceDisclosure. No reader here has a second
 * rule: each one SELECTs `location_privacy_mode`, asks that predicate, and
 * strips the place at its serialisation boundary.
 *
 * WHAT EACH BLOCK PINS
 *   A. The Compass feed page (buildFeed / buildSection over the real hydrator).
 *   B. The Wall: GET /wall and GET /wall/live over the real router.
 *   C. Place pages: the living page (payload and timeline), the Place Day feed,
 *      Place Day recaps, and the two "people you follow were here" counters
 *      (the Wall's context thread and the Live strip's producer).
 *   D. Passport postcards: the public postcard wall, decided at read time.
 *   E. The owner-aware helpers are the rule, not a second one.
 *
 * For every reader: a withholding mode reaches a non-owner without the place;
 * the owner keeps it; a `none`-mode object is asserted WHOLE; an unknown mode
 * fails closed; the SELECT carries the mode (the fake returns ONLY the selected
 * columns, as PostgREST does, so a dropped column reads as `none` and goes
 * red); and where the place is still used internally, the internal result
 * (order, membership, score) is shown unchanged.
 *
 * Run: node --import tsx/esm --test src/test/postLocationModeRemainingReaders.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import { mapPublicPost, postPlaceWithheld } from "../lib/postSchemas.js";
import {
  POST_PLACE_WITHHELD,
  postPlaceWithheldFrom,
  postPlaceMark,
  withPostPlaceMark,
  postPlaceMarkedWithheldFrom,
} from "../lib/postPlaceDisclosure.js";
import { hydrateCompassItems } from "../compass/CompassItemHydrator.js";
import { buildFeed, buildSection, compassPostPlaceForViewer, type FeedPage } from "../compass/CompassFeedBuilder.js";
import { resolveLiveSubjects } from "../compass/CompassLiveConstraints.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";
import wallRouter, { wallItemsForViewer, wallLiveStripForViewer } from "../routes/wall.js";
import { readFileSync } from "node:fs";
import { _internal as contextThreadInternal } from "../services/wall/ContextThreadService.js";
import { buildSocialPresenceLiveCandidates } from "../services/wall/LiveForYouService.js";
import placeLivingRouter, { livingPayloadForViewer } from "../routes/placeLiving.js";
import placeDaysRouter from "../routes/placeDays.js";
import placeRecapsRouter from "../routes/placeRecaps.js";
import passportRouter, { postcardPostIdsWithPlaceWithheld, postcardForViewer } from "../routes/passport.js";
import { isPublicPlaceRailPost } from "../lib/places/placeCollections.js";
import { runCollectionsTick, _setTestAwardStamp } from "../lib/places/placeCollectionsWorker.js";
import { loadPostcardCandidates } from "../services/wall/WallCandidateLoaders.js";
import { isPostPublished, canReadPost } from "../lib/postVisibility.js";

// ════════════════════════════════════════════════════════════════════════════
// A PostgREST-shaped fake: filters applied, and ONLY the selected columns
// returned. The second property is what makes "the SELECT carries the mode"
// testable: drop the column and every row reads as `none`.
// ════════════════════════════════════════════════════════════════════════════

type Tables = Record<string, any[]>;
interface FakeLog {
  selects: Array<{ table: string; cols: string }>;
  writes: Array<{ table: string; op: string; row: any }>;
  rpcs: Array<{ fn: string; args: any }>;
}
interface FakeOpts {
  tables: Tables;
  tokens?: Record<string, string>;
  failTables?: Set<string>;
  rpc?: (fn: string, args: any) => { data: any; error: any };
}

function splitTopLevel(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function projectRow(row: any, cols: string): any {
  if (!cols || cols.trim() === "*") return { ...row };
  const out: any = {};
  for (const raw of splitTopLevel(cols)) {
    let head = raw.trim().split("(")[0]!;
    let alias: string | null = null;
    if (head.includes(":")) { alias = head.split(":")[0]!.trim(); head = head.split(":")[1]!; }
    const name = head.split("!")[0]!.trim();
    if (name && name in row) out[alias ?? name] = row[name];
  }
  return out;
}

function fakeDb(opts: FakeOpts, log: FakeLog = { selects: [], writes: [], rpcs: [] }): any {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limitN = Infinity;
    let offset = 0;
    let cols = "*";
    const exec = (): { data: any; error: any } => {
      if (opts.failTables?.has(table)) return { data: null, error: { message: `unreadable ${table}`, code: "XX000" } };
      let rows = (opts.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orders.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const { col, asc } of orders) {
            if (a[col] === b[col]) continue;
            if (a[col] == null) return 1;
            if (b[col] == null) return -1;
            return (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
      }
      rows = rows.slice(offset, limitN === Infinity ? undefined : offset + limitN);
      return { data: rows.map((r) => projectRow(r, cols)), error: null };
    };
    const resolved = (value: any) => {
      const p: any = Promise.resolve(value);
      p.select = () => p;
      p.single = () => p;
      p.maybeSingle = () => p;
      p.eq = () => p;
      return p;
    };
    const b: any = {
      select(c?: string) { cols = c ?? "*"; log.selects.push({ table, cols }); return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      gte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] >= v); return b; },
      gt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] > v); return b; },
      lte(c: string, v: any) { filters.push((r) => r[c] != null && r[c] <= v); return b; },
      lt(c: string, v: any) { filters.push((r) => r[c] != null && r[c] < v); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not(c: string, op: string, v: any) { if (op === "is") filters.push((r) => (r[c] ?? null) !== v); return b; },
      ilike(c: string, v: any) { filters.push((r) => String(r[c] ?? "").toLowerCase() === String(v).toLowerCase()); return b; },
      contains() { return b; },
      overlaps() { return b; },
      match() { return b; },
      filter() { return b; },
      or(expr: string) {
        const m = expr.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/);
        if (m) {
          const [, ltTs, eqTs, ltId] = m;
          filters.push((r) => r.created_at < ltTs! || (r.created_at === eqTs && r.id < ltId!));
        }
        return b;
      },
      order(c: string, o?: { ascending?: boolean }) { orders.push({ col: c, asc: o?.ascending !== false }); return b; },
      limit(n: number) { limitN = n; return b; },
      range(a: number, z: number) { offset = a; limitN = z - a + 1; return b; },
      maybeSingle() { const r = exec(); return Promise.resolve({ data: r.error ? null : (r.data[0] ?? null), error: r.error }); },
      single() { const r = exec(); return Promise.resolve({ data: r.error ? null : (r.data[0] ?? null), error: r.error }); },
      upsert(row: any) { log.writes.push({ table, op: "upsert", row }); return resolved({ data: null, error: null }); },
      insert(row: any) { log.writes.push({ table, op: "insert", row }); return resolved({ data: null, error: null }); },
      update(row: any) { log.writes.push({ table, op: "update", row }); return resolved({ data: null, error: null }); },
      delete() { log.writes.push({ table, op: "delete", row: null }); return resolved({ data: null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve(exec()).then(onF, onR); },
    };
    return b;
  };
  return {
    from,
    rpc: async (fn: string, args: any) => {
      log.rpcs.push({ fn, args });
      return opts.rpc ? opts.rpc(fn, args) : { data: null, error: null };
    },
    auth: {
      getUser: async (token: string) =>
        opts.tokens?.[token]
          ? { data: { user: { id: opts.tokens[token] } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } },
    },
  };
}

const newLog = (): FakeLog => ({ selects: [], writes: [], rpcs: [] });
const flagRows = (flags: Record<string, boolean>) => Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled }));

/** An HTTP harness over one router, mounted under /api. */
function harness(router: any) {
  let server: http.Server;
  let baseUrl = "";
  const start = async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => (req as any).log };
      next();
    });
    app.use("/api", router);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        server.unref();
        resolve();
      });
    });
  };
  const stop = async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  };
  const request = async (method: string, path: string, token: string | null, body?: unknown) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
  };
  return { start, stop, request };
}

const MODES_WITHHELD = ["city_only", "hidden", "trusted_circle_only", "neighborhood_only"] as const;
const UNKNOWN_MODE = "orbital_only"; // a value mapPublicPost does not know
/** Fixture clock, read once, so a world built twice is the same world. */
const NOW0 = Date.now();
const minutesAgo = (m: number) => new Date(NOW0 - m * 60_000).toISOString();

// ════════════════════════════════════════════════════════════════════════════
// A. The Compass feed page
// ════════════════════════════════════════════════════════════════════════════

const CV = "c0000000-0000-4000-a000-000000000001"; // the viewer
const CA = "c0000000-0000-4000-a000-00000000000a"; // author, none
const CB = "c0000000-0000-4000-a000-00000000000b"; // author, city_only
const CC = "c0000000-0000-4000-a000-00000000000c"; // author, unknown mode
const CD = "c0000000-0000-4000-a000-00000000000d"; // author, released delayed post
const PL = (n: number) => `d0000000-0000-4000-a000-00000000000${n}`;

function compassPosts(overrides: Record<string, Partial<any>> = {}) {
  const base = (id: string, author: string, place: string, mode: string | null, minutes: number, extra: Partial<any> = {}) => ({
    id, author_id: author, content: `post ${id}`, created_at: minutesAgo(minutes),
    location_city: "Lisbon", location_country: "Portugal", status: "active", visibility: "public",
    canonical_place_id: place, post_status: "published", location_privacy_mode: mode,
    location_name: `Venue of ${id}`, ...extra, ...(overrides[id] ?? {}),
  });
  return [
    base("e0000000-0000-4000-a000-000000000001", CA, PL(1), "none", 10),
    base("e0000000-0000-4000-a000-000000000002", CB, PL(2), "city_only", 20),
    base("e0000000-0000-4000-a000-000000000003", CC, PL(3), UNKNOWN_MODE, 30),
    base("e0000000-0000-4000-a000-000000000004", CD, PL(4), "delayed_until_time", 40),
  ];
}
const P_NONE = "e0000000-0000-4000-a000-000000000001";
const P_CITY = "e0000000-0000-4000-a000-000000000002";
const P_UNKNOWN = "e0000000-0000-4000-a000-000000000003";
const P_RELEASED = "e0000000-0000-4000-a000-000000000004";

function compassProfile(userId: string): CompassProfile {
  return {
    userId, preferredCities: ["Lisbon"], preferredLanguages: ["en"], budgetStyle: null,
    travelStyles: ["culture"], socialStyle: null, safetyPreference: "standard",
    visibilityPreference: "semi_private", blockedUserIds: [], blockerUserIds: [], mutedUserIds: [],
    blockCount: 0, blockerCount: 0, trustScore: 80, trustLevel: "trusted_traveler", activeUserScore: null,
    hasActiveTrip: false, hasActiveBooking: false, upcomingTripWithin48h: false, hasFutureTripScheduled: false,
    currentCity: null, currentCountry: null, safeReturnActive: false, computedAt: new Date().toISOString(),
    categoryWeights: null, ignoredItemIds: [], mutedHashtags: [],
  } as unknown as CompassProfile;
}
function compassContext(): CompassContext {
  return {
    contextState: "exploring_now",
    signals: {
      hourUtc: 9, safeReturnActive: false, activeBooking: false, upcomingTripWithin48h: false,
      activeTripNow: false, hasPendingDelayedPosts: false, hasFutureTripScheduled: false,
    },
    computedAt: new Date().toISOString(),
  } as unknown as CompassContext;
}

async function hydrate(posts: any[], log: FakeLog = newLog()): Promise<CompassItem[]> {
  const db = fakeDb({ tables: { posts } }, log);
  return hydrateCompassItems(db, compassProfile(CV));
}

/** The same items as the pre-§43 hydrator produced them: no mark on any. */
function unmarked(items: CompassItem[]): CompassItem[] {
  return items.map((it) => {
    const copy: any = { ...it };
    delete copy[POST_PLACE_WITHHELD];
    return copy;
  });
}

const OVERRIDES = { skipFairExposure: true, skipActiveRewards: true } as const;
const allFeedItems = (page: FeedPage) => page.sections.flatMap((s) => s.items.map((i) => ({ section: s.name, i })));
const pageShape = (page: FeedPage) => page.sections.map((s) => [s.name, s.items.map((i) => String(i.item.id))]);

describe("A. Compass feed page — the owner's location mode", () => {
  // Freshness is part of every score: freeze the clock so two builds of the
  // same page are comparable to the last bit.
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-27T12:00:00.000Z") }));
  afterEach(() => mock.timers.reset());

  it("A1. the hydrator SELECTs the mode and marks exactly the withheld posts; a none-mode item is the pre-§43 object, not even a symbol key more", async () => {
    const log = newLog();
    const items = await hydrate(compassPosts(), log);
    const postSelect = log.selects.find((s) => s.table === "posts");
    assert.ok(postSelect && /\blocation_privacy_mode\b/.test(postSelect.cols), `posts SELECT was ${postSelect?.cols}`);
    const byId = new Map(items.map((i) => [String(i.id), i]));
    assert.equal(byId.size, 4);
    const marked = (id: string) => Object.getOwnPropertySymbols(byId.get(id)!).includes(POST_PLACE_WITHHELD);
    assert.equal(marked(P_NONE), false);
    assert.equal(marked(P_RELEASED), false, "a released delayed post is disclosed by design");
    assert.equal(marked(P_CITY), true);
    assert.equal(marked(P_UNKNOWN), true, "an unknown mode fails closed");
    // WHOLE: the none-mode item is exactly what postToItem built before §43.
    assert.deepStrictEqual(byId.get(P_NONE), {
      id: P_NONE, type: "post", title: `post ${P_NONE}`, category: "post", authorId: CA,
      createdAt: compassPosts()[0]!.created_at, contentBody: `post ${P_NONE}`, city: "Lisbon", country: "Portugal",
      visibilityScope: "public", qualityScore: 5, placeId: PL(1), data: { title: `post ${P_NONE}` },
    });
    // Internally every item keeps its canonical place: live constraints and the
    // affinity boost still read it.
    assert.equal(byId.get(P_CITY)!.placeId, PL(2));
    const subjects = await resolveLiveSubjects(null, items);
    assert.equal(subjects.get(P_CITY), PL(2), "the withheld post is still its place's live-constraint subject");
    assert.equal(subjects.get(P_UNKNOWN), PL(3));
  });

  it("A2. a non-owner's page: the withheld posts lose placeId and nothing else; the none-mode and released items are WHOLE", async () => {
    const items = await hydrate(compassPosts());
    const fixed = await buildFeed(items, compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
    const before = await buildFeed(unmarked(items), compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
    assert.deepStrictEqual(pageShape(fixed), pageShape(before), "same sections, same items, same order");
    assert.ok(allFeedItems(fixed).length >= 4, "the page is not vacuous");
    const beforeBy = new Map(allFeedItems(before).map(({ section, i }) => [`${section}:${i.item.id}`, i]));
    for (const { section, i } of allFeedItems(fixed)) {
      const old = beforeBy.get(`${section}:${i.item.id}`)!;
      if (i.item.id === P_CITY || i.item.id === P_UNKNOWN) {
        assert.equal(i.item.placeId, null, `${i.item.id} placeId withheld in ${section}`);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(i)), JSON.parse(JSON.stringify({ ...old, item: { ...old.item, placeId: null } })));
      } else {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(i)), JSON.parse(JSON.stringify(old)), `${i.item.id} unchanged in ${section}`);
      }
    }
    const wire = JSON.stringify(fixed);
    assert.ok(!wire.includes(PL(2)) && !wire.includes(PL(3)), "neither withheld place id is anywhere on the wire");
    assert.ok(wire.includes(PL(1)) && wire.includes(PL(4)), "the disclosed ones are");
  });

  it("A2n. [both ways] a none-mode and a released delayed item are the pre-§43 FeedItems, WHOLE", async () => {
    const items = await hydrate(compassPosts());
    const fixed = await buildFeed(items, compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
    const before = await buildFeed(unmarked(items), compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
    const pick = (p: FeedPage) => allFeedItems(p).filter(({ i }) => i.item.id === P_NONE || i.item.id === P_RELEASED)
      .map(({ section, i }) => [section, JSON.parse(JSON.stringify(i))]);
    assert.ok(pick(fixed).length >= 2);
    assert.deepStrictEqual(pick(fixed), pick(before));
    for (const [, i] of pick(fixed)) assert.ok(i.item.placeId === PL(1) || i.item.placeId === PL(4));
  });

  it("A3o. [both ways] the owner's own withheld post keeps its placeId on their page", async () => {
    const items = await hydrate(compassPosts());
    const page = await buildFeed(items, compassProfile(CB), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
    const mine = allFeedItems(page).filter(({ i }) => i.item.id === P_CITY);
    assert.ok(mine.length > 0);
    for (const { i } of mine) assert.equal(i.item.placeId, PL(2));
  });

  it("A3. the owner's own page keeps their withheld post's placeId; another author's stays withheld", async () => {
    const items = await hydrate(compassPosts());
    const page = await buildFeed(items, compassProfile(CB), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
    const mine = allFeedItems(page).filter(({ i }) => i.item.id === P_CITY);
    assert.ok(mine.length > 0);
    for (const { i } of mine) assert.equal(i.item.placeId, PL(2));
    for (const { i } of allFeedItems(page).filter(({ i }) => i.item.id === P_UNKNOWN)) assert.equal(i.item.placeId, null);
  });

  it("A4. the strip runs AFTER ranking: the withheld place still earns its affinity boost, and the order is the unmarked order", async () => {
    const items = await hydrate(compassPosts());
    const aff = { [PL(2)]: 9 };
    const withAff = await buildFeed(items, compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: aff });
    const noAff = await buildFeed(items, compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
    const beforeAff = await buildFeed(unmarked(items), compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: aff });
    const score = (p: FeedPage) => allFeedItems(p).find(({ section, i }) => section === "for_you" && i.item.id === P_CITY)!.i.finalScore;
    assert.ok(score(withAff) > score(noAff), "the affinity keyed on the WITHHELD place still boosted it: the internal step reads it");
    assert.equal(score(withAff), score(beforeAff));
    assert.deepStrictEqual(pageShape(withAff), pageShape(beforeAff), "order and membership are the unmarked ones");
    assert.notDeepStrictEqual(pageShape(withAff), pageShape(noAff), "and the boost moved the order, so the comparison above is not vacuous");
  });

  it("A5. buildSection strips it too, and every withholding mode does", async () => {
    for (const mode of MODES_WITHHELD) {
      const items = await hydrate(compassPosts({ [P_CITY]: { location_privacy_mode: mode } }));
      const { section } = await buildSection("for_you", items, compassProfile(CV), compassContext(), null, null, { ...OVERRIDES, placeAffinities: {} });
      const it = section.items.find((i) => i.item.id === P_CITY)!;
      assert.equal(it.item.placeId, null, mode);
      assert.equal(section.items.find((i) => i.item.id === P_NONE)!.item.placeId, PL(1));
    }
    // An UNRELEASED delayed post never reaches Compass (post_status filter), and
    // a released one is disclosed: pinned in A1/A2.
  });

  it("A6. compassPostPlaceForViewer hands back the very same object when nothing is withheld", () => {
    const r = { item: { id: "x", type: "post", placeId: "p", authorId: "a" } as CompassItem, finalScore: 1 };
    assert.equal(compassPostPlaceForViewer(r, "v"), r);
    const marked = { item: { ...r.item, ...postPlaceMark({ author_id: "a", location_privacy_mode: "city_only" }) } as CompassItem, finalScore: 1 };
    assert.equal(compassPostPlaceForViewer(marked, "a"), marked, "owner");
    assert.equal(compassPostPlaceForViewer(marked, "v").item.placeId, null);
    const nonPost = { item: { ...marked.item, type: "place" } as CompassItem, finalScore: 1 };
    assert.equal(compassPostPlaceForViewer(nonPost, "v"), nonPost, "only post items carry a post's mode");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E. The helpers ARE mapPublicPost's rule
// ════════════════════════════════════════════════════════════════════════════

describe("E. lib/postPlaceDisclosure is mapPublicPost's decision plus the owner bypass", () => {
  const MODES = [null, undefined, "", "none", "hidden", "city_only", "trusted_circle_only", "neighborhood_only",
    "delayed_until_exit", "delayed_until_time", UNKNOWN_MODE];
  const STATUSES = [undefined, "published", "pending_location_exit", "pending_time"];

  it("E1. postPlaceWithheldFrom ≡ (not the author) ∧ mapPublicPost(row) !== row, over every mode × status", () => {
    for (const mode of MODES) for (const post_status of STATUSES) {
      const row = { author_id: "a", location_privacy_mode: mode, post_status, location_name: "V", location_city: "C" };
      const rule = mapPublicPost(row) !== row;
      assert.equal(postPlaceWithheld(row), rule);
      assert.equal(postPlaceWithheldFrom(row, "v"), rule, `${mode}/${post_status}`);
      assert.equal(postPlaceWithheldFrom(row, null), rule, "anonymous");
      assert.equal(postPlaceWithheldFrom(row, ""), rule, "an empty viewer id is nobody");
      assert.equal(postPlaceWithheldFrom(row, "a"), false, "the author");
      const mark = postPlaceMark(row);
      assert.equal(Object.getOwnPropertySymbols(mark).length, rule ? 1 : 0);
      const ref = { placeId: "p" };
      const marked = withPostPlaceMark(ref, row);
      assert.equal(marked === ref, !rule, "an unwithheld ref is the same object");
      assert.equal(postPlaceMarkedWithheldFrom(marked, "v"), rule);
      assert.equal(postPlaceMarkedWithheldFrom(marked, "a"), false);
      assert.equal(JSON.stringify(marked), JSON.stringify(ref), "the mark never serialises");
    }
  });

  it("E2. a mark with no known author is withheld from everyone", () => {
    const marked = withPostPlaceMark({ placeId: "p" }, { location_privacy_mode: "city_only" });
    assert.equal(postPlaceMarkedWithheldFrom(marked, ""), true);
    assert.equal(postPlaceMarkedWithheldFrom(marked, "anyone"), true);
    assert.equal(withPostPlaceMark(null, { location_privacy_mode: "city_only" }), null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. The Wall (GET /wall, GET /wall/live) and its two "were here" counters
// ════════════════════════════════════════════════════════════════════════════

const WTOK: Record<string, string> = { "tok-v": "wv", "tok-b": "wb", "tok-x": "wx" };
const WPLACES = [
  { id: "place-open", name: "Open Cafe", city: "Da Nang", country_code: "VN", latitude: 16.05, longitude: 108.2, status: "active", merged_into_place_id: null },
  { id: "place-secret", name: "Secret Bar", city: "Da Nang", country_code: "VN", latitude: 16.1, longitude: 108.25, status: "active", merged_into_place_id: null },
  { id: "place-myst", name: "Mystery Spot", city: "Hoi An", country_code: "VN", latitude: 15.88, longitude: 108.33, status: "active", merged_into_place_id: null },
];
const WPROFILES = [
  { id: "wv", display_name: "Viewer", username: "viewer", avatar_url: null, account_status: "active", current_city: "Da Nang", home_city: null, interests: [] },
  { id: "wx", display_name: "Stranger", username: "stranger", avatar_url: null, account_status: "active", current_city: "Paris", home_city: null, interests: [] },
  { id: "wa", display_name: "Ana", username: "ana", avatar_url: null, account_status: "active" },
  { id: "wb", display_name: "Ben", username: "ben", avatar_url: null, account_status: "active", current_city: "Da Nang", home_city: null, interests: [] },
  { id: "wc", display_name: "Cai", username: "cai", avatar_url: null, account_status: "active" },
  { id: "wd", display_name: "Dao", username: "dao", avatar_url: null, account_status: "active" },
];
function wpost(id: string, author: string, place: string, mode: string | null, minutes: number, extra: Partial<any> = {}) {
  const pl = WPLACES.find((p) => p.id === place)!;
  return {
    id, author_id: author, trip_id: null, content: `Post ${id}`, visibility: "public", status: "active",
    post_status: "published", created_at: minutesAgo(minutes), published_at: minutesAgo(minutes),
    canonical_place_id: place, has_video: false, media_count: 0, category: null,
    location_city: pl.city, location_country: "VN", like_count: 0, comment_count: 0, save_count: 0,
    location_privacy_mode: mode, location_name: pl.name, ...extra,
  };
}
function wallWorld(opts: { posts: any[]; flags?: Record<string, boolean>; follows?: Array<[string, string]>; gems?: any[] }): Tables {
  const follows = opts.follows ?? [["wv", "wa"], ["wv", "wb"], ["wv", "wc"]];
  return {
    feature_flags: flagRows({
      wall_enabled: true, wall_live_for_you_enabled: false, wall_context_threads_enabled: true,
      wall_discovery_insertions_enabled: false, wall_input_intelligence_enabled: false,
      wall_compass_handoff_enabled: false, wall_rab_integration_enabled: false, rent_buddy_enabled: false,
      ...(opts.flags ?? {}),
    }),
    profiles: WPROFILES,
    places: WPLACES,
    posts: opts.posts,
    user_follows: follows.map(([follower_id, following_id]) => ({ follower_id, following_id })),
    hidden_gems: opts.gems ?? [],
  };
}
const gemAt = (placeId: string) => ({
  id: `gem-${placeId}`, canonical_place_id: placeId, sensitivity_level: "public", verification_level: "community",
  status: "active", crowd_level: "quiet", save_count: 0, visit_count: 0, updated_at: minutesAgo(60),
  latitude: 16.1, longitude: 108.25, approx_latitude: 16.1, approx_longitude: 108.25, image_url: null,
});
/** The same world with every post's mode set to `none` — what the pre-§43 readers served for it. */
const asNone = (posts: any[]) => posts.map((p) => ({ ...p, location_privacy_mode: "none" }));

describe("B. The Wall — the owner's location mode at the response", () => {
  const h = harness(wallRouter);
  before(h.start);
  after(h.stop);
  const use = (tables: Tables) => { _clearPromotedScopeCache(); _setTestClient(fakeDb({ tables, tokens: WTOK }), true); };
  const followingPosts = () => [
    wpost("post-open", "wa", "place-open", "none", 5),
    wpost("post-secret", "wb", "place-secret", "city_only", 10),
    wpost("post-myst", "wc", "place-myst", UNKNOWN_MODE, 15),
  ];

  it("B1. Following: a withheld post loses its place, its See-place action and its (place-anchored) thread; a none-mode item is WHOLE", async () => {
    const posts = followingPosts();
    use(wallWorld({ posts: asNone(posts) }));
    const before = await h.request("GET", "/api/wall?mode=following", "tok-v");
    use(wallWorld({ posts }));
    const res = await h.request("GET", "/api/wall?mode=following", "tok-v");
    assert.equal(res.status, 200);
    const items = res.json.items as any[];
    assert.deepEqual(items.map((i) => i.canonicalObjectId), ["post-open", "post-secret", "post-myst"]);
    assert.deepEqual(before.json.items.map((i: any) => i.canonicalObjectId), ["post-open", "post-secret", "post-myst"], "same order before");

    // WHOLE: the none-mode item, pinned field by field, and identical to before.
    assert.deepStrictEqual(items[0], {
      projectionId: "wall_social_update_post-open", canonicalObjectId: "post-open",
      actor: { userId: "wa", displayName: "Ana", handle: "ana", avatarUrl: null },
      publishedAt: items[0].publishedAt, visibility: "public", text: "Post post-open",
      place: { placeId: "place-open", name: "Open Cafe", city: "Da Nang", country: "VN" },
      viewerSaved: false,
      actions: [
        { type: "open_object", label: "Open", targetType: "social_update", targetId: "post-open" },
        { type: "save", label: "Save", targetType: "post", targetId: "post-open", params: { saved: false } },
        { type: "see_place", label: "See place", targetType: "place", targetId: "place-open" },
      ],
      objectType: "social_update",
      contextThread: items[0].contextThread,
    });
    assert.equal(items[0].contextThread?.kind, "map");
    assert.equal(items[0].contextThread?.label, "Open Cafe · see it on the map");
    assert.deepStrictEqual(items[0], before.json.items[0]);

    // The withheld post: before §43 it carried the venue three ways.
    const oldSecret = before.json.items[1];
    assert.equal(oldSecret.place.name, "Secret Bar", "the pre-§43 page served the venue");
    assert.equal(oldSecret.contextThread?.label, "Secret Bar · see it on the map", "and named it in the thread");
    const { place: _p, contextThread: _t, ...oldRest } = oldSecret;
    assert.deepStrictEqual(items[1], { ...oldRest, actions: oldSecret.actions.filter((a: any) => a.type !== "see_place") });
    // The unknown mode fails closed the same way.
    const { place: _p2, contextThread: _t2, ...oldMyst } = before.json.items[2];
    assert.deepStrictEqual(items[2], { ...oldMyst, actions: before.json.items[2].actions.filter((a: any) => a.type !== "see_place") });
    const wire = JSON.stringify(res.json);
    for (const s of ["Secret Bar", "place-secret", "Mystery Spot", "place-myst"]) assert.ok(!wire.includes(s), `${s} is not on the wire`);
  });

  it("B1n. [both ways] Following: the none-mode item is WHOLE — pinned field by field", async () => {
    use(wallWorld({ posts: followingPosts() }));
    const res = await h.request("GET", "/api/wall?mode=following", "tok-v");
    const item = (res.json.items as any[]).find((i) => i.canonicalObjectId === "post-open");
    assert.deepStrictEqual(item, {
      projectionId: "wall_social_update_post-open", canonicalObjectId: "post-open",
      actor: { userId: "wa", displayName: "Ana", handle: "ana", avatarUrl: null },
      publishedAt: minutesAgo(5), visibility: "public", text: "Post post-open",
      place: { placeId: "place-open", name: "Open Cafe", city: "Da Nang", country: "VN" },
      viewerSaved: false,
      actions: [
        { type: "open_object", label: "Open", targetType: "social_update", targetId: "post-open" },
        { type: "save", label: "Save", targetType: "post", targetId: "post-open", params: { saved: false } },
        { type: "see_place", label: "See place", targetType: "place", targetId: "place-open" },
      ],
      objectType: "social_update",
      contextThread: item.contextThread,
    });
    assert.equal(item.contextThread.label, "Open Cafe · see it on the map");
  });

  it("B2o. [both ways] the owner's own withheld post is WHOLE on their For You page", async () => {
    const posts = [
      wpost("post-a1", "wa", "place-open", "none", 1),
      wpost("post-c1", "wc", "place-open", "none", 2),
      wpost("post-a2", "wa", "place-myst", "none", 3),
      wpost("post-secret", "wb", "place-secret", "city_only", 30),
    ];
    use(wallWorld({ posts, flags: { wall_discovery_insertions_enabled: true, wall_context_threads_enabled: false }, follows: [["wb", "wa"], ["wb", "wc"]] }));
    const own = await h.request("GET", "/api/wall?mode=for_you", "tok-b");
    const mine = (own.json.items as any[]).find((i) => i.canonicalObjectId === "post-secret");
    assert.ok(mine);
    assert.deepEqual(mine.place, { placeId: "place-secret", name: "Secret Bar", city: "Da Nang", country: "VN" });
    assert.deepEqual(mine.actions.map((a: any) => a.type), ["open_object", "save", "see_place", "follow"], "as the pre-§43 discovery projection builds it");
  });

  it("B2. the owner sees their own withheld post whole (For You discovery path, where the Wall shows a viewer their own posts)", async () => {
    // For You shows a viewer's own post only as a discovery insertion, and the
    // diversity controller admits a discovery insertion only after social
    // (followed) objects: so both viewers follow wa and wc, whose newer posts
    // rank first.
    const posts = [
      wpost("post-a1", "wa", "place-open", "none", 1),
      wpost("post-c1", "wc", "place-open", "none", 2),
      wpost("post-a2", "wa", "place-myst", "none", 3),
      wpost("post-secret", "wb", "place-secret", "city_only", 30),
    ];
    const follows: Array<[string, string]> = [["wb", "wa"], ["wb", "wc"], ["wv", "wa"], ["wv", "wc"]];
    use(wallWorld({ posts, flags: { wall_discovery_insertions_enabled: true, wall_context_threads_enabled: false }, follows }));
    const own = await h.request("GET", "/api/wall?mode=for_you", "tok-b");
    const mine = (own.json.items as any[]).find((i) => i.canonicalObjectId === "post-secret");
    assert.ok(mine, `the owner's own post is on their For You page: ${JSON.stringify((own.json.items as any[]).map((i) => [i.canonicalObjectId, i.objectType]))}`);
    assert.deepEqual(mine.place, { placeId: "place-secret", name: "Secret Bar", city: "Da Nang", country: "VN" });
    assert.ok(mine.actions.some((a: any) => a.type === "see_place"));
    use(wallWorld({ posts, flags: { wall_discovery_insertions_enabled: true, wall_context_threads_enabled: false }, follows }));
    const other = await h.request("GET", "/api/wall?mode=for_you", "tok-v");
    const theirs = (other.json.items as any[]).find((i) => i.canonicalObjectId === "post-secret");
    assert.ok(theirs, `another viewer sees the post itself: ${JSON.stringify((other.json.items as any[]).map((i) => [i.canonicalObjectId, i.objectType]))}`);
    assert.equal(theirs.place, undefined);
    assert.equal(theirs.discoveryReason, "Popular in Da Nang", "its reason is its CITY, which the mode keeps");
  });

  it("B3. a discovery insertion whose only explanation is its withheld place being a Hidden Gem is not shown; the others keep their order", async () => {
    // wx lives in Paris with no interests, so for an outside-graph post the
    // only rungs left are the Hidden Gem and "missed".
    const posts = [
      wpost("post-d1", "wd", "place-myst", "none", 1),
      wpost("post-d2", "wd", "place-myst", "none", 2),
      wpost("post-d3", "wd", "place-myst", "none", 3),
      wpost("post-open", "wa", "place-open", "none", 20),
      wpost("post-d4", "wd", "place-myst", "none", 21),
      wpost("post-d5", "wd", "place-myst", "none", 22),
      wpost("post-secret", "wb", "place-secret", "city_only", 25),
    ];
    const world = (ps: any[]) => wallWorld({
      posts: ps, flags: { wall_discovery_insertions_enabled: true, wall_context_threads_enabled: false },
      follows: [["wx", "wd"]], gems: [gemAt("place-open"), gemAt("place-secret")],
    });
    use(world(asNone(posts)));
    const before = await h.request("GET", "/api/wall?mode=for_you", "tok-x");
    use(world(posts));
    const res = await h.request("GET", "/api/wall?mode=for_you", "tok-x");
    const shape = (r: any) => (r.json.items as any[]).map((i) => [i.canonicalObjectId, i.discoveryReason ?? null]);
    const reasons = Object.fromEntries(shape(before));
    assert.equal(reasons["post-secret"], "A Hidden Gem worth exploring", `before: the withheld place's gem explained it: ${JSON.stringify(shape(before))}`);
    assert.equal(reasons["post-open"], "A Hidden Gem worth exploring");
    assert.deepEqual(shape(res), shape(before).filter(([id]) => id !== "post-secret"), "the old page minus that one insertion, in the same order");
    // WHOLE, but for the For You ranking session id, which is minted per request.
    const noSession = (i: any) => ({ ...i, ranking: { ...i.ranking, session: "<per-request>" } });
    assert.deepStrictEqual(noSession((res.json.items as any[]).find((i) => i.canonicalObjectId === "post-open")),
      noSession((before.json.items as any[]).find((i) => i.canonicalObjectId === "post-open")), "the none-mode gem insertion is WHOLE");
    // The same post for a viewer whose explanation is NOT its place stays (B2).
  });

  it("B4. the Live strip is built as before, then loses the items about a place only withheld posts point at — on GET /wall and GET /wall/live", async () => {
    const posts = [
      wpost("post-open", "wa", "place-open", "none", 5),
      wpost("post-open-c", "wc", "place-open", "none", 6),
      wpost("post-open-b", "wb", "place-open", "city_only", 7),
      wpost("post-secret", "wb", "place-secret", "city_only", 10),
    ];
    const world = (ps: any[]) => wallWorld({ posts: ps, flags: { wall_live_for_you_enabled: true, wall_context_threads_enabled: false }, gems: [gemAt("place-secret")] });
    for (const path of ["/api/wall?mode=following", "/api/wall/live?limit=4"]) {
      use(world(asNone(posts)));
      const before = await h.request("GET", path, "tok-v");
      use(world(posts));
      const res = await h.request("GET", path, "tok-v");
      const strip = (r: any) => (r.json.liveForYou as any[]).map((i) => [i.liveObjectType, i.subjectId, i.label]);
      assert.deepEqual(strip(before), [
        ["social_presence", "place-open", "3 people you follow were here recently"],
        ["hidden_gem", "place-secret", (before.json.liveForYou as any[])[1]?.label],
      ], `${path}: the pre-§43 strip named the withheld place and counted the withheld post`);
      assert.deepEqual(strip(res), [["social_presence", "place-open", "2 people you follow were here recently"]], path);
      assert.ok(!JSON.stringify(res.json).includes("Secret Bar"), `${path}: the withheld venue is not on the wire`);
    }
  });

  it("B8. a followed author's POSTCARD (the postcard loader's own place ref) is withheld the same way; the loader SELECTs the mode", async () => {
    const posts = followingPosts();
    const cards = [
      { id: "pc-secret", post_id: "post-secret", user_id: "wb", status: "active", deleted_at: null, created_at: minutesAgo(10) },
      { id: "pc-open", post_id: "post-open", user_id: "wa", status: "active", deleted_at: null, created_at: minutesAgo(5) },
    ];
    use({ ...wallWorld({ posts: asNone(posts) }), passport_postcards: cards });
    const before = await h.request("GET", "/api/wall?mode=following", "tok-v");
    const tables = { ...wallWorld({ posts }), passport_postcards: cards };
    const log = newLog();
    _clearPromotedScopeCache();
    _setTestClient(fakeDb({ tables, tokens: WTOK }, log), true);
    const res = await h.request("GET", "/api/wall?mode=following", "tok-v");
    const kinds = (r: any) => (r.json.items as any[]).map((i) => [i.canonicalObjectId, i.objectType]);
    assert.deepEqual(kinds(res), kinds(before));
    assert.deepEqual(kinds(res).slice(0, 2), [["post-open", "postcard"], ["post-secret", "postcard"]], "both are served as postcards");
    const secret = (res.json.items as any[]).find((i) => i.canonicalObjectId === "post-secret");
    const old = (before.json.items as any[]).find((i) => i.canonicalObjectId === "post-secret");
    assert.equal(old.place.name, "Secret Bar", "before: the postcard carried the venue");
    const { place: _p, contextThread: _t, ...oldRest } = old;
    assert.deepStrictEqual(secret, { ...oldRest, actions: old.actions.filter((a: any) => a.type !== "see_place") });
    assert.deepStrictEqual((res.json.items as any[])[0], (before.json.items as any[])[0], "the none-mode postcard is WHOLE");
    assert.ok(log.selects.some((x) => x.table === "posts" && x.cols.includes("save_count") && /\blocation_privacy_mode\b/.test(x.cols) && !x.cols.includes("like_count")),
      "the postcard loader's own SELECT carries the mode");
    const loaded = await loadPostcardCandidates(fakeDb({ tables }), "following", { viewerId: "wv", followedCreatorIds: new Set(["wa", "wb"]) });
    const byId = new Map(loaded.candidates.map((c) => [c.canonicalObjectId, c]));
    assert.equal(postPlaceMarkedWithheldFrom(byId.get("post-secret")!.place, "wv"), true);
    assert.equal(postPlaceMarkedWithheldFrom(loaded.placeByObject.get("post-secret"), "wv"), true);
    assert.equal(byId.get("post-open")!.place, loaded.placeByObject.get("post-open"));
    assert.equal(Object.getOwnPropertySymbols(byId.get("post-open")!.place!).length, 0, "a none-mode ref carries no mark");
  });

  it("B8n. [both ways] a followed author's none-mode postcard is WHOLE", async () => {
    const cards = [{ id: "pc-open", post_id: "post-open", user_id: "wa", status: "active", deleted_at: null, created_at: minutesAgo(5) }];
    use({ ...wallWorld({ posts: followingPosts() }), passport_postcards: cards });
    const res = await h.request("GET", "/api/wall?mode=following", "tok-v");
    const item = (res.json.items as any[]).find((i) => i.canonicalObjectId === "post-open");
    assert.equal(item.objectType, "postcard");
    assert.deepEqual(item.place, { placeId: "place-open", name: "Open Cafe", city: "Da Nang", country: "VN" });
    assert.deepEqual(item.actions.map((a: any) => a.type), ["open_object", "save", "see_place"]);
  });

  it("B5. a place a disclosed post also points at stays in the strip; the owner keeps their own; the mark never serialises", () => {
    const open = { placeId: "p1", name: "Open" };
    const secret = withPostPlaceMark({ placeId: "p2", name: "Secret" }, { author_id: "wb", location_privacy_mode: "hidden" })!;
    const secretAlsoOpen = withPostPlaceMark({ placeId: "p1", name: "Open" }, { author_id: "wb", location_privacy_mode: "hidden" })!;
    const strip = [{ subjectId: "p1" }, { subjectId: "p2" }] as any[];
    assert.deepEqual(wallLiveStripForViewer(strip, [open, secret, secretAlsoOpen], "wv").map((i) => i.subjectId), ["p1"]);
    assert.deepEqual(wallLiveStripForViewer(strip, [open, secret], "wb").map((i) => i.subjectId), ["p1", "p2"], "owner");
    assert.equal(wallLiveStripForViewer(strip, [open], "wv"), strip, "nothing withheld: the same array");
    const item: any = {
      objectType: "social_post", canonicalObjectId: "x", place: secret, contextThread: { kind: "map" },
      actions: [
        { type: "open_object", targetType: "social_post", targetId: "x" },
        { type: "see_place", targetType: "place", targetId: "p2" },
        { type: "ask_compass", targetType: "place", targetId: "p2" },
        { type: "follow", targetType: "user", targetId: "wb" },
      ],
    };
    const [out] = wallItemsForViewer([item], "wv");
    assert.equal(out!.place, undefined);
    assert.ok(!("contextThread" in out!));
    assert.deepEqual(out!.actions.map((a: any) => a.type), ["open_object", "follow"]);
    assert.equal(wallItemsForViewer([item], "wb")[0], item, "owner: the very same object");
    assert.equal(JSON.stringify(wallItemsForViewer([item], "wb")[0]!.place), JSON.stringify({ placeId: "p2", name: "Secret" }));
  });

  it("B6. the Wall's context thread counts only posts whose owner disclosed the place, and SELECTs the mode", async () => {
    const at = (id: string, author: string, mode: string | null, post_status = "published") =>
      ({ id, author_id: author, canonical_place_id: "place-open", visibility: "public", status: "active", post_status, created_at: minutesAgo(30), location_privacy_mode: mode });
    const run = async (rows: any[]) => {
      const log = newLog();
      const sc = fakeDb({ tables: { posts: rows } }, log);
      const c = await contextThreadInternal.readSocialPresenceCandidate(
        sc, { place: { placeId: "place-open", name: "Open Cafe" } } as any,
        { viewerId: "wv", followedCreatorIds: new Set(["wa", "wb", "wc", "wd"]) } as any,
      );
      return { label: c?.thread.label ?? null, cols: log.selects.find((s) => s.table === "posts")?.cols ?? "" };
    };
    const base = [at("1", "wa", "none"), at("2", "wc", null), at("3", "wv", "none")];
    assert.equal((await run(base)).label, "2 people you follow were here recently", "none/absent count; the viewer's own never did");
    assert.equal((await run([...base, at("4", "wb", "city_only")])).label, "2 people you follow were here recently", "a withheld post does not place its author here");
    assert.equal((await run([...base, at("4", "wb", "none")])).label, "3 people you follow were here recently", "the same post disclosed does");
    assert.equal((await run([...base, at("4", "wd", UNKNOWN_MODE)])).label, "2 people you follow were here recently", "unknown fails closed");
    assert.equal((await run([...base, at("4", "wd", "delayed_until_time")])).label, "3 people you follow were here recently", "a released delayed post is disclosed");
    assert.equal((await run([...base, at("4", "wd", "delayed_until_exit")])).label, "2 people you follow were here recently", "census-media MD79 (lead ruling D-26f): a released 'After I leave' post read without published_at has ended its place window (fail closed)");
    assert.equal((await run([at("1", "wa", "none"), at("4", "wb", "trusted_circle_only")])).label, null, "below the floor once the withheld post is not counted");
    assert.match((await run(base)).cols, /\blocation_privacy_mode\b/);
    assert.match((await run(base)).cols, /\bpost_status\b/);
  });

  it("B7. the Live strip's social_presence producer does the same", async () => {
    const at = (id: string, author: string, mode: string | null) =>
      ({ id, author_id: author, canonical_place_id: "place-open", visibility: "public", status: "active", post_status: "published", created_at: minutesAgo(30), location_privacy_mode: mode });
    const run = async (rows: any[]) => {
      const log = newLog();
      const out = await buildSocialPresenceLiveCandidates(fakeDb({ tables: { posts: rows } }, log), "wv",
        new Set(["wa", "wb", "wc", "wd"]), [{ placeId: "place-open", name: "Open Cafe" }]);
      return { labels: out.map((c: any) => c.resolved?.label ?? null), cols: log.selects.find((s) => s.table === "posts")?.cols ?? "" };
    };
    const base = [at("1", "wa", "none"), at("2", "wc", "none")];
    assert.deepEqual((await run(base)).labels, ["2 people you follow were here recently"]);
    assert.deepEqual((await run([...base, at("3", "wb", "hidden")])).labels, ["2 people you follow were here recently"]);
    assert.deepEqual((await run([...base, at("3", "wb", "none")])).labels, ["3 people you follow were here recently"]);
    assert.deepEqual((await run([at("1", "wa", "none"), at("3", "wb", UNKNOWN_MODE)])).labels, []);
    assert.match((await run(base)).cols, /\blocation_privacy_mode\b/);
  });

  it("B9. census-media MD79 (lead ruling D-26f): a released 'Publish after I leave' post places its author here for 24 h after release, then no longer — both producers SELECT published_at", async () => {
    const released = (id: string, author: string, hoursAgo: number | null) =>
      ({ id, author_id: author, canonical_place_id: "place-open", visibility: "public", status: "active", post_status: "published", created_at: minutesAgo(30), location_privacy_mode: "delayed_until_exit", ...(hoursAgo == null ? {} : { published_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() }) });
    const thread = async (rows: any[]) => {
      const log = newLog();
      const c = await contextThreadInternal.readSocialPresenceCandidate(fakeDb({ tables: { posts: rows } }, log), { place: { placeId: "place-open", name: "Open Cafe" } } as any,
        { viewerId: "wv", followedCreatorIds: new Set(["wa", "wb", "wc", "wd"]) } as any);
      return { label: c?.thread.label ?? null, cols: log.selects.find((s) => s.table === "posts")?.cols ?? "" };
    };
    const strip = async (rows: any[]) => {
      const log = newLog();
      const out = await buildSocialPresenceLiveCandidates(fakeDb({ tables: { posts: rows } }, log), "wv", new Set(["wa", "wb", "wc", "wd"]), [{ placeId: "place-open", name: "Open Cafe" }]);
      return { labels: out.map((x: any) => x.resolved?.label ?? null), cols: log.selects.find((s) => s.table === "posts")?.cols ?? "" };
    };
    const open = (id: string, author: string) => ({ ...released(id, author, 1), location_privacy_mode: "none" });
    const base = [open("1", "wa"), open("2", "wc")];
    assert.equal((await thread([...base, released("4", "wd", 1)])).label, "3 people you follow were here recently", "inside the window");
    assert.equal((await thread([...base, released("4", "wd", 25)])).label, "2 people you follow were here recently", "after it");
    assert.equal((await thread([...base, released("4", "wd", null)])).label, "2 people you follow were here recently", "an unread release time has ended");
    assert.match((await thread(base)).cols, /\bpublished_at\b/);
    assert.deepEqual((await strip([...base, released("4", "wd", 1)])).labels, ["3 people you follow were here recently"]);
    assert.deepEqual((await strip([...base, released("4", "wd", 25)])).labels, ["2 people you follow were here recently"]);
    assert.match((await strip(base)).cols, /\bpublished_at\b/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Place pages: the living page and its timeline, the Place Day feed, recaps
// ════════════════════════════════════════════════════════════════════════════

const LPLACE = "a1000000-0000-4000-a000-0000000000f1";
const LTOK: Record<string, string> = { "tok-aw": "aw", "tok-v": "lv", "tok-rv": "rv" };
const PLACES_FLAGS = { external_places_enabled: true, live_places_enabled: true, place_days_enabled: true, place_recaps_enabled: true };
const todayKey = () => new Date().toISOString().slice(0, 10);

function lpost(id: string, author: string, mode: string | null, hoursAgo: number, extra: Partial<any> = {}) {
  return {
    id, author_id: author, content: `caption ${id}`, media_urls: [`https://cdn.example/${id}.jpg`],
    media_type: "image", media_thumbnail_url: null, created_at: new Date(NOW0 - hoursAgo * 3_600_000).toISOString(),
    like_count: 1, save_count: 0, share_count: 0, post_buckets: ["food"], visibility: "public", status: "active",
    post_status: "published", publish_at: null, canonical_place_id: LPLACE, location_privacy_mode: mode,
    location_name: "Hidden Courtyard", profiles: { id: author, is_private: false }, ...extra,
  };
}
/** N1, W, N2, U, N3 — newest first. W is city_only (author aw), U an unknown mode. */
const livingPosts = () => [
  lpost("n1", "a1", "none", 1), lpost("w", "aw", "city_only", 2), lpost("n2", "a2", null, 3),
  lpost("u", "au", UNKNOWN_MODE, 4), lpost("n3", "a3", "none", 5),
];
function livingWorld(posts: any[], extra: Tables = {}): Tables {
  return {
    feature_flags: flagRows(PLACES_FLAGS),
    places: [{ id: LPLACE, name: "Test Falls", city: "Test City", latitude: 10, longitude: 120, merged_into_place_id: null, status: "active", primary_category: "waterfall" }],
    external_place_references: [],
    place_coverage_buckets: [{ canonical_place_id: LPLACE, bucket: "food", post_count: 5 }],
    weather_cache: [{ destination: "test city", date_key: `${todayKey()}:${todayKey()}`, brief_summary: "Sunny", forecasts_json: [], fetched_at: new Date().toISOString() }],
    posts,
    ...extra,
  };
}
const INTERNAL_KEYS = ["_placeWithheldAuthorId", "_placeModeAware"];
/** Remove entries by id from the living payload's two listings, and the per-build clocks. */
function livingMinus(payload: any, ids: string[]): any {
  const drop = (list: any[]) => list.filter((e) => !ids.includes(e.id));
  return {
    ...payload,
    generatedAt: "<clock>",
    aiSummary: payload.aiSummary ? { ...payload.aiSummary, generatedAt: "<clock>" } : payload.aiSummary,
    timeline: { ...payload.timeline, posts: drop(payload.timeline.posts) },
    buckets: payload.buckets.map((b: any) => ({ ...b, posts: drop(b.posts) })),
    bestOf: payload.bestOf && Object.fromEntries(Object.entries(payload.bestOf).map(([k, v]) =>
      [k, Array.isArray(v) ? v.filter((e: any) => !ids.includes(e.postId)) : v])),
  };
}

describe("C. Place pages — a post whose owner withheld its place is not listed AT it", () => {
  const h = harness(express.Router().use(placeLivingRouter).use(placeDaysRouter).use(placeRecapsRouter));
  before(async () => {
    await h.start();
    _setTestOpenAI({ chat: { completions: { create: async () => ({ choices: [{ message: { content: "A lovely place." } }] }) } } } as any);
  });
  after(async () => { _setTestOpenAI(null); await h.stop(); });
  let log: FakeLog;
  const use = (tables: Tables, opts: Partial<FakeOpts> = {}) => {
    log = newLog();
    _setTestClient(fakeDb({ tables, tokens: LTOK, ...opts }, log), true);
  };

  it("C1. the living payload (built once, cached for everyone): a non-owner gets the lists minus the withheld posts; the none-mode entries are WHOLE", async () => {
    use(livingWorld(asNone(livingPosts())));
    const before = await h.request("GET", `/api/places/${LPLACE}/living`, null);
    use(livingWorld(livingPosts()));
    const res = await h.request("GET", `/api/places/${LPLACE}/living`, null);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-cache"), "MISS");
    assert.deepEqual(before.json.timeline.posts.map((p: any) => p.id), ["n1", "w", "n2", "u", "n3"], "the pre-§43 page listed them");
    assert.deepEqual(res.json.timeline.posts.map((p: any) => p.id), ["n1", "n2", "n3"]);
    assert.deepEqual(res.json.buckets[0].posts.map((p: any) => p.id), ["n1", "n2", "n3"]);
    assert.deepStrictEqual(res.json.timeline.posts[0], {
      id: "n1", mediaUrl: "https://cdn.example/n1.jpg", thumbnailUrl: null, caption: "caption n1",
      authorId: "a1", createdAt: livingPosts()[0]!.created_at, like_count: 1,
    });
    // The Best-Of rail on the same page lists posts AT the place too
    // (isPublicPlaceRailPost now reads the mode).
    assert.deepEqual(before.json.bestOf.experiences.map((e: any) => e.postId), ["n1", "w", "n2", "u", "n3"]);
    assert.deepEqual(res.json.bestOf.experiences.map((e: any) => e.postId), ["n1", "n2", "n3"]);
    assert.deepStrictEqual(livingMinus(res.json, []), livingMinus(before.json, ["w", "u"]), "everything else is exactly what it was");
    const wire = JSON.stringify(res.json);
    for (const k of INTERNAL_KEYS) assert.ok(!wire.includes(k), `${k} never reaches a response`);
    for (const s of ["caption w", "caption u"]) assert.ok(!wire.includes(s));
    // The CACHED payload keeps the entries, marked, for the owner bypass.
    const cached = log.writes.find((w) => w.table === "place_living_cache")!.row.payload;
    assert.equal(cached._placeModeAware, true);
    assert.deepEqual(cached.timeline.posts.map((p: any) => [p.id, p._placeWithheldAuthorId ?? null]),
      [["n1", null], ["w", "aw"], ["n2", null], ["u", "au"], ["n3", null]]);
    // The shared AI summary is never written from a withheld caption.
    const summary = log.writes.find((w) => w.table === "place_ai_summaries")!.row;
    assert.deepEqual(summary.post_ids_used, ["n1", "n2", "n3"]);
    assert.match(log.selects.find((s) => s.table === "posts" && s.cols.includes("post_buckets"))!.cols, /\blocation_privacy_mode\b/);
  });

  it("C1n. [both ways] the living page's none-mode entries are WHOLE", async () => {
    use(livingWorld(livingPosts()));
    const res = await h.request("GET", `/api/places/${LPLACE}/living`, null);
    const n = (list: any[]) => list.filter((p) => ["n1", "n2", "n3"].includes(p.id));
    assert.deepStrictEqual(n(res.json.timeline.posts), livingPosts().filter((p) => ["n1", "n2", "n3"].includes(p.id)).map((p) => ({
      id: p.id, mediaUrl: `https://cdn.example/${p.id}.jpg`, thumbnailUrl: null, caption: `caption ${p.id}`,
      authorId: p.author_id, createdAt: p.created_at, like_count: 1,
    })));
    assert.deepStrictEqual(n(res.json.buckets[0].posts), ["n1", "n2", "n3"].map((id) => ({
      id, mediaUrl: `https://cdn.example/${id}.jpg`, thumbnailUrl: null, caption: `caption ${id}`,
    })));
  });

  it("C2o. [both ways] the owner gets their own withheld post back on the living page", async () => {
    use(livingWorld(livingPosts()));
    const res = await h.request("GET", `/api/places/${LPLACE}/living`, "tok-aw");
    assert.ok(res.json.timeline.posts.some((p: any) => p.id === "w"));
    assert.ok(res.json.buckets[0].posts.some((p: any) => p.id === "w"));
  });

  it("C2. the owner gets their own withheld post back — from a fresh build and from the cache — and nobody else's", async () => {
    use(livingWorld(livingPosts()));
    const fresh = await h.request("GET", `/api/places/${LPLACE}/living`, "tok-aw");
    assert.deepEqual(fresh.json.timeline.posts.map((p: any) => p.id), ["n1", "w", "n2", "n3"]);
    const cachedPayload = log.writes.find((w) => w.table === "place_living_cache")!.row.payload;
    const cacheRow = { place_id: LPLACE, payload: cachedPayload, cached_at: new Date().toISOString(), sparse: false };
    use(livingWorld(livingPosts(), { place_living_cache: [cacheRow] }));
    const hitOwner = await h.request("GET", `/api/places/${LPLACE}/living`, "tok-aw");
    assert.equal(hitOwner.headers.get("x-cache"), "HIT");
    assert.deepEqual(hitOwner.json.timeline.posts.map((p: any) => p.id), ["n1", "w", "n2", "n3"]);
    assert.ok(!JSON.stringify(hitOwner.json).includes("_placeWithheldAuthorId"));
    const hitOther = await h.request("GET", `/api/places/${LPLACE}/living`, "tok-v");
    assert.deepEqual(hitOther.json.timeline.posts.map((p: any) => p.id), ["n1", "n2", "n3"]);
    // A stale row is served before it is rebuilt: the same shaping applies.
    use(livingWorld(livingPosts(), { place_living_cache: [{ ...cacheRow, cached_at: new Date(NOW0 - 3 * 86_400_000).toISOString() }] }));
    const stale = await h.request("GET", `/api/places/${LPLACE}/living`, null);
    assert.equal(stale.headers.get("x-cache"), "STALE");
    assert.deepEqual(stale.json.timeline.posts.map((p: any) => p.id), ["n1", "n2", "n3"]);
    assert.ok(!JSON.stringify(stale.json).includes("_placeWithheldAuthorId"));
  });

  it("C3. a payload cached before §43 cannot say which entries to withhold, so it is rebuilt, not served", async () => {
    const legacy = { placeId: LPLACE, timeline: { slice: "today", posts: [{ id: "w", caption: "caption w" }] }, buckets: [] };
    use(livingWorld(livingPosts(), { place_living_cache: [{ place_id: LPLACE, payload: legacy, cached_at: new Date().toISOString(), sparse: false }] }));
    const res = await h.request("GET", `/api/places/${LPLACE}/living`, null);
    assert.equal(res.headers.get("x-cache"), "MISS");
    assert.deepEqual(res.json.timeline.posts.map((p: any) => p.id), ["n1", "n2", "n3"]);
  });

  it("C4. livingPayloadForViewer drops only marked entries the viewer did not author, and removes the internal keys", () => {
    const p = { _placeModeAware: true, x: 1, timeline: { posts: [{ id: "a" }, { id: "b", _placeWithheldAuthorId: "o" }] }, buckets: [{ bucket: "f", posts: [{ id: "b", _placeWithheldAuthorId: "o" }] }, { bucket: "g" }] };
    assert.deepStrictEqual(livingPayloadForViewer(p, null), { x: 1, timeline: { posts: [{ id: "a" }] }, buckets: [{ bucket: "f", posts: [] }, { bucket: "g" }] });
    assert.deepStrictEqual(livingPayloadForViewer(p, ""), livingPayloadForViewer(p, null), "an empty viewer is nobody");
    assert.deepStrictEqual(livingPayloadForViewer(p, "o"), { x: 1, timeline: { posts: [{ id: "a" }, { id: "b" }] }, buckets: [{ bucket: "f", posts: [{ id: "b" }] }, { bucket: "g" }] });
  });

  it("C4b. the place's public rails (Best-Of, top contributors) admit exactly the stranger-readable posts whose owner did not withhold the place", () => {
    const MODES = [null, "none", "hidden", "city_only", "trusted_circle_only", "neighborhood_only", "delayed_until_exit", UNKNOWN_MODE];
    for (const location_privacy_mode of MODES) for (const post_status of ["published", "pending_location_exit"]) for (const visibility of ["public", "private"]) {
      const row: any = { id: "p", author_id: "a", trip_id: null, visibility, post_status, location_privacy_mode };
      const before = isPostPublished(row) && canReadPost(row, "place-rail:no-viewer", false, false);
      assert.equal(isPublicPlaceRailPost(row), before && !postPlaceWithheld(row), `${location_privacy_mode}/${post_status}/${visibility}`);
    }
    assert.equal(isPublicPlaceRailPost({ id: "p", author_id: "a", visibility: "public", post_status: "published", location_privacy_mode: "none" } as any), true, "a none-mode public post is still on the rails");
  });

  it("C8. the collections worker writes both public rails (place_best_of, place_top_contributors) without withheld posts, and SELECTs the mode", async () => {
    const rows = [
      { id: "b-n1", author_id: "a1", trip_id: null, visibility: "public", post_status: "published", location_privacy_mode: "none", media_type: "photo", media_urls: ["https://cdn.example/b-n1.jpg"], media_thumbnail_url: null, post_buckets: [], content: "n1", like_count: 9, save_count: 0, share_count: 0 },
      { id: "b-w", author_id: "aw", trip_id: null, visibility: "public", post_status: "published", location_privacy_mode: "city_only", media_type: "photo", media_urls: ["https://cdn.example/b-w.jpg"], media_thumbnail_url: null, post_buckets: [], content: "w", like_count: 99, save_count: 0, share_count: 0 },
      { id: "b-u", author_id: "au", trip_id: null, visibility: "public", post_status: "published", location_privacy_mode: UNKNOWN_MODE, media_type: "photo", media_urls: ["https://cdn.example/b-u.jpg"], media_thumbnail_url: null, post_buckets: [], content: "u", like_count: 50, save_count: 0, share_count: 0 },
    ];
    const selects: Array<{ table: string; cols: string }> = [];
    const upserts: Array<{ table: string; row: any }> = [];
    let queue: any[] = [{ place_id: LPLACE, status: "pending", queued_at: new Date().toISOString(), locked_until: null }];
    const sc = {
      from(table: string) {
        let mode = "read"; let patch: any = null; let cols = "*"; let returning = false;
        const filters: Array<(r: any) => boolean> = [];
        const b: any = {
          select(c?: string) { if (mode === "update") returning = true; else { cols = c ?? "*"; selects.push({ table, cols }); } return b; },
          upsert(row: any) { upserts.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
          update(pt: any) { mode = "update"; patch = pt; return b; },
          delete() { mode = "delete"; return b; },
          eq(c: string, v: any) { if (table === "place_cache_invalidation_queue") filters.push((r) => r[c] === v); return b; },
          in(c: string, v: any[]) { if (table === "place_cache_invalidation_queue") filters.push((r) => v.includes(r[c])); return b; },
          not() { return b; }, or() { return b; }, lt() { return b; }, gt() { return b; }, gte() { return b; }, order() { return b; },
          limit(n: number) {
            if (table === "place_cache_invalidation_queue") return Promise.resolve({ data: queue.filter((r) => filters.every((f) => f(r))).slice(0, n), error: null });
            if (table === "posts") return Promise.resolve({ data: rows.map((r) => projectRow(r, cols)), error: null });
            return Promise.resolve({ data: [], error: null });
          },
          then(resolve: any) {
            if (mode === "update" && table === "place_cache_invalidation_queue") {
              const matched = queue.filter((r) => filters.every((f) => f(r)));
              queue = queue.map((r) => (filters.every((f) => f(r)) ? { ...r, ...patch } : r));
              if (returning) return resolve({ data: matched.map((r) => ({ ...r, ...patch })), error: null });
            }
            return resolve({ data: null, error: null });
          },
        };
        return b;
      },
    };
    _setTestAwardStamp(async () => ({ awarded: false, reason: "test" }) as any);
    try { await runCollectionsTick(sc); } finally { _setTestAwardStamp(null); }
    assert.match(selects.find((x) => x.table === "posts")!.cols, /\blocation_privacy_mode\b/);
    const bestOf = upserts.find((u) => u.table === "place_best_of")!.row;
    const ids = JSON.stringify(bestOf);
    assert.ok(ids.includes("b-n1"), "the none-mode post is on the rail");
    assert.ok(!ids.includes("b-w") && !ids.includes("b-u"), `withheld posts are not: ${ids}`);
    const credited = upserts.filter((u) => u.table === "place_top_contributors").map((u) => u.row.user_id);
    assert.deepEqual(credited, ["a1"], "only the author whose contribution is disclosed is credited on the public rail");
  });

  it("C5. the living timeline: after every cut, a non-owner loses the withheld posts; the owner keeps theirs; SELECT carries the mode", async () => {
    use(livingWorld(asNone(livingPosts())));
    const before = await h.request("GET", `/api/places/${LPLACE}/living/timeline?slice=today`, null);
    use(livingWorld(livingPosts()));
    const anon = await h.request("GET", `/api/places/${LPLACE}/living/timeline?slice=today`, null);
    assert.deepEqual(before.json.posts.map((p: any) => p.id), ["n1", "w", "n2", "u", "n3"]);
    assert.deepEqual(anon.json.posts.map((p: any) => p.id), ["n1", "n2", "n3"]);
    assert.deepStrictEqual(anon.json.posts, before.json.posts.filter((p: any) => !["w", "u"].includes(p.id)), "the none-mode entries are WHOLE");
    assert.equal(anon.json.total, 3);
    assert.match(log.selects.find((s) => s.table === "posts")!.cols, /\blocation_privacy_mode\b/);
    const owner = await h.request("GET", `/api/places/${LPLACE}/living/timeline?slice=today`, "tok-aw");
    assert.deepEqual(owner.json.posts.map((p: any) => p.id), ["n1", "w", "n2", "n3"]);
  });

  // ── The Place Day feed ─────────────────────────────────────────────────────
  const DATE = "2026-08-02";
  const UID: Record<string, string> = {
    n1: "90000000-0000-4000-a000-000000000001", w: "90000000-0000-4000-a000-000000000002",
    n2: "90000000-0000-4000-a000-000000000003", u: "90000000-0000-4000-a000-000000000004",
    n3: "90000000-0000-4000-a000-000000000005", mine: "90000000-0000-4000-a000-000000000006",
  };
  const NAME = Object.fromEntries(Object.entries(UID).map(([k, v]) => [v, k]));
  const dpost = (id: string, author: string, mode: string | null, hh: string) =>
    ({ ...lpost(id, author, mode, 0), id: UID[id], content: `caption ${id}`, created_at: `${DATE}T${hh}:00:00.000Z` });
  const dayPosts = () => [dpost("n1", "a1", "none", "15"), dpost("w", "aw", "city_only", "14"), dpost("n2", "a2", "none", "13"), dpost("u", "au", UNKNOWN_MODE, "12"), dpost("n3", "a3", "none", "11")];
  const dayWorld = (posts: any[]): Tables => ({
    feature_flags: flagRows(PLACES_FLAGS),
    places: [{ id: LPLACE, name: "Test Place", city: "London", latitude: 51.5, longitude: -0.12, merged_into_place_id: null }],
    posts, blocks: [], user_follows: [],
  });
  const walk = async (token: string) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const r = await h.request("GET", `/api/places/${LPLACE}/place-days/${DATE}/feed?limit=2${q}`, token);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      ids.push(...r.json.items.map((it: any) => NAME[it.id] ?? it.id));
      cursor = r.json.nextCursor;
      if (!cursor) break;
    }
    return ids;
  };

  it("C5n. [both ways] the living timeline: none-mode entries WHOLE, and the owner keeps their own", async () => {
    use(livingWorld(livingPosts()));
    const anon = await h.request("GET", `/api/places/${LPLACE}/living/timeline?slice=today`, null);
    const n1 = livingPosts()[0]!;
    assert.deepStrictEqual(anon.json.posts.find((p: any) => p.id === "n1"), {
      id: "n1", mediaUrl: "https://cdn.example/n1.jpg", thumbnailUrl: null, caption: "caption n1", authorId: "a1",
      createdAt: n1.created_at, mediaType: "image", buckets: ["food"], like_count: 1,
    });
    const owner = await h.request("GET", `/api/places/${LPLACE}/living/timeline?slice=today`, "tok-aw");
    assert.ok(owner.json.posts.some((p: any) => p.id === "w"));
  });

  it("C6. the Place Day feed: the sequence a non-owner can page through is the old sequence minus withheld posts; the owner's is unchanged", async () => {
    use(dayWorld(asNone(dayPosts())));
    assert.deepEqual(await walk("tok-v"), ["n1", "w", "n2", "u", "n3"], "before");
    use(dayWorld(dayPosts()));
    assert.deepEqual(await walk("tok-v"), ["n1", "n2", "n3"]);
    assert.match(log.selects.find((s) => s.table === "posts")!.cols, /\blocation_privacy_mode\b/);
    use(dayWorld(dayPosts()));
    assert.deepEqual(await walk("tok-aw"), ["n1", "w", "n2", "n3"], "the owner still sees theirs; the unknown mode stays withheld");
    use(dayWorld(dayPosts()));
    const first = await h.request("GET", `/api/places/${LPLACE}/place-days/${DATE}/feed?limit=5`, "tok-v");
    assert.deepStrictEqual(first.json.items[0], {
      id: UID.n1, authorId: "a1", caption: "caption n1", mediaUrl: "https://cdn.example/n1.jpg",
      thumbnailUrl: null, mediaType: "image", createdAt: `${DATE}T15:00:00.000Z`,
    }, "a none-mode item is WHOLE");
  });

  it("C6n. [both ways] the Place Day feed: a none-mode item is WHOLE, and the owner's sequence keeps their post", async () => {
    use(dayWorld(dayPosts()));
    const first = await h.request("GET", `/api/places/${LPLACE}/place-days/${DATE}/feed?limit=5`, "tok-v");
    assert.deepStrictEqual(first.json.items.find((i: any) => i.id === UID.n1), {
      id: UID.n1, authorId: "a1", caption: "caption n1", mediaUrl: "https://cdn.example/n1.jpg",
      thumbnailUrl: null, mediaType: "image", createdAt: `${DATE}T15:00:00.000Z`,
    });
    use(dayWorld(dayPosts()));
    assert.ok((await walk("tok-aw")).includes("w"));
  });

  it("C7. a Place Day recap never copies another author's withheld post; the recap owner's own withheld post is still theirs to recap", async () => {
    const rpost = (id: string, author: string, mode: string | null, hh: string) => ({ ...dpost(id, author, mode, hh) });
    const posts = [rpost("mine", "rv", "city_only", "10"), rpost("n1", "a1", "none", "11"), rpost("w", "aw", "hidden", "12"), rpost("u", "au", UNKNOWN_MODE, "13")];
    const world: Tables = {
      ...dayWorld(posts),
      place_days: [{ id: "c1000000-0000-4000-a000-000000000001", place_id: LPLACE, local_date: DATE, timezone: "Europe/London", status: "closing" }],
    };
    use(world, { rpc: () => ({ data: { recap: { id: "r1" }, version: { id: "v1" } }, error: null }) });
    const res = await h.request("POST", "/api/place-recaps", "tok-rv", { placeDayId: "c1000000-0000-4000-a000-000000000001" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const sources = log.rpcs.find((r) => r.fn === "create_live_place_recap")!.args.p_sources;
    assert.deepEqual(sources.map((s: any) => NAME[s.postId] ?? s.postId), ["mine", "n1"]);
    assert.match(log.selects.find((s) => s.table === "posts")!.cols, /\blocation_privacy_mode\b/);
  });

  it("C9. census-media MD79: the per-request timeline and Place Day feed show a released 'Publish after I leave' post for 24 h after release, then not; both SELECT published_at", async () => {
    const rel = (hoursAgo: number | null) => ({ published_at: hoursAgo == null ? null : new Date(Date.now() - hoursAgo * 3_600_000).toISOString() });
    const timelineIds = async (extra: any) => {
      use(livingWorld([lpost("n1", "a1", "none", 1), lpost("x", "ax", "delayed_until_exit", 2, extra)]));
      const r = await h.request("GET", `/api/places/${LPLACE}/living/timeline?slice=today`, null);
      return { ids: r.json.posts.map((p: any) => p.id), cols: log.selects.find((s) => s.table === "posts")!.cols };
    };
    assert.deepEqual((await timelineIds(rel(1))).ids, ["n1", "x"], "timeline, inside the window");
    assert.deepEqual((await timelineIds(rel(25))).ids, ["n1"], "timeline, after it");
    assert.deepEqual((await timelineIds(rel(null))).ids, ["n1"], "timeline, release time unreadable");
    assert.match((await timelineIds(rel(1))).cols, /\bpublished_at\b/);
    const dayIds = async (extra: any) => {
      use(dayWorld([dpost("n1", "a1", "none", "15"), { ...dpost("n2", "a2", "delayed_until_exit", "14"), ...extra }]));
      return walk("tok-v");
    };
    assert.deepEqual(await dayIds(rel(1)), ["n1", "n2"], "Place Day feed, inside the window");
    assert.deepEqual(await dayIds(rel(25)), ["n1"], "Place Day feed, after it");
    assert.match(log.selects.find((s) => s.table === "posts")!.cols, /\bpublished_at\b/);
  });

  it("C10. census-media MD79, FAIL CLOSED where the place decision outlives the request: the cached living payload, the persisted public rails and a Place Day recap never read published_at, so a released 'Publish after I leave' post is withheld there even inside its window", async () => {
    const inWindow = { published_at: new Date(Date.now() - 3_600_000).toISOString() };
    use(livingWorld([lpost("n1", "a1", "none", 1), lpost("x", "ax", "delayed_until_exit", 2, inWindow), lpost("n2", "a2", "none", 3), lpost("n3", "a3", "none", 5)]));
    const living = await h.request("GET", `/api/places/${LPLACE}/living`, null);
    assert.deepEqual(living.json.timeline.posts.map((p: any) => p.id), ["n1", "n2", "n3"], "the living payload is cached for up to 24 h, so it cannot honour a window that ends inside it");
    assert.deepEqual(living.json.bestOf.experiences.map((e: any) => e.postId), ["n1", "n2", "n3"]);
    for (const sel of log.selects.filter((x) => x.table === "posts")) assert.doesNotMatch(sel.cols, /\bpublished_at\b/, `living-payload read: ${sel.cols}`);
    assert.deepEqual(log.writes.find((w) => w.table === "place_ai_summaries")!.row.post_ids_used, ["n1", "n2", "n3"], "the persisted AI summary is never written from it");
    const world: Tables = {
      ...dayWorld([{ ...dpost("mine", "rv", "none", "10") }, { ...dpost("n1", "a1", "none", "11") }, { ...dpost("w", "aw", "delayed_until_exit", "12"), ...inWindow }]),
      place_days: [{ id: "c1000000-0000-4000-a000-000000000002", place_id: LPLACE, local_date: DATE, timezone: "Europe/London", status: "closing" }],
    };
    use(world, { rpc: () => ({ data: { recap: { id: "r2" }, version: { id: "v2" } }, error: null }) });
    const res = await h.request("POST", "/api/place-recaps", "tok-rv", { placeDayId: "c1000000-0000-4000-a000-000000000002" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.deepEqual(log.rpcs.find((r) => r.fn === "create_live_place_recap")!.args.p_sources.map((x: any) => NAME[x.postId] ?? x.postId), ["mine", "n1"], "a recap is a persisted copy: never from a post whose window will end");
    assert.doesNotMatch(log.selects.find((x) => x.table === "posts")!.cols, /\bpublished_at\b/);
    // The persisted public rails (place_best_of / place_top_contributors): the collections worker's posts read
    // carries no published_at, so the shared rule withholds every released 'Publish after I leave' post there.
    assert.equal(isPublicPlaceRailPost({ id: "p", author_id: "a", trip_id: null, visibility: "public", post_status: "published", location_privacy_mode: "delayed_until_exit" } as any), false);
    assert.doesNotMatch(readFileSync(new URL("../lib/places/placeCollections.ts", import.meta.url), "utf8"), /published_at/, "the rails worker must not read published_at: its rails are persisted");
    // Compass caches each viewer's feed (CompassCacheEngine), so its hydrator stays closed too.
    assert.doesNotMatch(readFileSync(new URL("../compass/CompassItemHydrator.ts", import.meta.url), "utf8"), /published_at/, "Compass's hydrator must not read published_at: its feed is cached past the request");
  });

  it("C7o. [both ways] the recap owner's own withheld post, and a none-mode post, are recapped", async () => {
    const posts = [dpost("mine", "rv", "city_only", "10"), dpost("n1", "a1", "none", "11"), dpost("w", "aw", "hidden", "12")];
    use({ ...dayWorld(posts), place_days: [{ id: "c1000000-0000-4000-a000-000000000001", place_id: LPLACE, local_date: DATE, timezone: "Europe/London", status: "closing" }] },
      { rpc: () => ({ data: { recap: { id: "r1" }, version: { id: "v1" } }, error: null }) });
    const res = await h.request("POST", "/api/place-recaps", "tok-rv", { placeDayId: "c1000000-0000-4000-a000-000000000001" });
    assert.equal(res.status, 201);
    const ids = log.rpcs.find((r) => r.fn === "create_live_place_recap")!.args.p_sources.map((x: any) => NAME[x.postId] ?? x.postId);
    assert.ok(ids.includes("mine") && ids.includes("n1"), JSON.stringify(ids));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Passport postcards: the copied venue, decided at read time
// ════════════════════════════════════════════════════════════════════════════

describe("D. The public postcard wall — a postcard's copied venue follows its post's CURRENT mode", () => {
  const h = harness(passportRouter);
  before(h.start);
  after(h.stop);
  const T = "70000000-0000-4000-a000-000000000001";
  const card = (id: string, postId: string, minutes: number) => ({
    id, post_id: postId, user_id: T, media_url: `https://cdn.example/${id}.jpg`, caption: `card ${id}`,
    location_name: "Hidden Courtyard", location_city: "Lisbon", location_country: "Portugal",
    location_verified: true, stamp_eligible: false, visibility: "public", status: "active", pinned_at: null,
    note: null, created_at: minutesAgo(minutes),
  });
  const post = (id: string, mode: string | null, post_status = "published") => ({ id, author_id: T, location_privacy_mode: mode, post_status });
  const world = (posts: any[]): Tables => ({
    profiles: [{ id: T, handle: "target", username: "target", display_name: "T", name: "T", avatar_url: null, passport_visibility: "public", is_private: false, account_status: "active" }],
    passport_postcards: [card("pc-n", "p-n", 1), card("pc-w", "p-w", 2), card("pc-u", "p-u", 3), card("pc-r", "p-r", 4), card("pc-o", "p-orphan", 5)],
    posts, post_media: [], blocks: [],
  });
  const POSTS = () => [post("p-n", "none"), post("p-w", "trusted_circle_only"), post("p-u", UNKNOWN_MODE), post("p-r", "delayed_until_exit")];
  let log: FakeLog;
  const use = (tables: Tables, opts: Partial<FakeOpts> = {}) => {
    log = newLog();
    _setTestClient(fakeDb({ tables, tokens: { "tok-t": T, "tok-v": "70000000-0000-4000-a000-000000000009" }, ...opts }, log), true);
  };
  const venues = (r: any) => Object.fromEntries((r.json.postcards as any[]).map((c) => [c.id, c.locationName]));

  it("D1. a non-owner: the withheld, unknown-mode and orphaned postcards lose the venue; city and country stay; the none-mode card is WHOLE", async () => {
    use(world([...POSTS(), post("p-orphan", "none")].map((p) => ({ ...p, location_privacy_mode: "none" }))));
    const before = await h.request("GET", "/api/users/target/passport/postcards", null);
    use(world(POSTS()));
    for (const token of [null, "tok-v"]) {
      const res = await h.request("GET", "/api/users/target/passport/postcards", token);
      assert.equal(res.status, 200);
      // census-media MD79 (lead ruling D-26f): pc-r's post is a released "Publish after I leave" post, and this
      // reader does not SELECT published_at, so its place window reads as ended — it loses the venue (fail closed).
      assert.deepEqual(venues(res), { "pc-n": "Hidden Courtyard", "pc-w": null, "pc-u": null, "pc-r": null, "pc-o": null }, String(token));
      const byId = new Map((res.json.postcards as any[]).map((c) => [c.id, c]));
      const old = new Map((before.json.postcards as any[]).map((c) => [c.id, c]));
      for (const id of ["pc-n"]) assert.deepStrictEqual(byId.get(id), old.get(id), `${id} WHOLE`);
      for (const id of ["pc-w", "pc-u", "pc-o", "pc-r"]) assert.deepStrictEqual(byId.get(id), { ...old.get(id), locationName: null }, `${id}: one field fewer`);
      assert.equal(byId.get("pc-w").locationCity, "Lisbon");
    }
    assert.deepEqual(venues(before), { "pc-n": "Hidden Courtyard", "pc-w": "Hidden Courtyard", "pc-u": "Hidden Courtyard", "pc-r": "Hidden Courtyard", "pc-o": "Hidden Courtyard" }, "the pre-§43 wall served every copy");
    assert.match(log.selects.find((s) => s.table === "posts")!.cols, /\blocation_privacy_mode\b/);
  });

  it("D1n. [both ways] the none-mode and released postcards are WHOLE — a released 'After I leave' card loses only the venue (census-media MD79)", async () => {
    use(world(POSTS()));
    const res = await h.request("GET", "/api/users/target/passport/postcards", null);
    const byId = new Map((res.json.postcards as any[]).map((c) => [c.id, c]));
    for (const [id, minutes] of [["pc-n", 1], ["pc-r", 4]] as const) {
      const c = card(id, id === "pc-n" ? "p-n" : "p-r", minutes);
      assert.deepStrictEqual(byId.get(id), {
        id, postId: c.post_id, mediaUrl: c.media_url, caption: c.caption, locationName: id === "pc-n" ? "Hidden Courtyard" : null,
        locationCity: "Lisbon", locationCountry: "Portugal", locationVerified: true, stampEligible: false,
        visibility: "public", status: "active", pinnedAt: null, note: null, createdAt: c.created_at, media: [],
      });
    }
  });

  it("D2. the owner's own wall is unchanged (and costs no extra read)", async () => {
    use(world(POSTS()));
    const res = await h.request("GET", "/api/users/target/passport/postcards", "tok-t");
    assert.ok(Object.values(venues(res)).every((v) => v === "Hidden Courtyard"));
    assert.ok(!log.selects.some((s) => s.table === "posts"), "no posts read for the owner");
  });

  it("D3. an unreadable posts read withholds every venue from a non-owner (fail closed)", async () => {
    use(world(POSTS()), { failTables: new Set(["posts"]) });
    const res = await h.request("GET", "/api/users/target/passport/postcards", null);
    assert.equal(res.status, 200);
    assert.ok(Object.values(venues(res)).every((v) => v === null));
  });

  it("D5. census-media MD79: a released 'Publish after I leave' postcard keeps its venue for 24 h after release, then loses it; the read SELECTs published_at", async () => {
    const withRelease = (hoursAgo: number) => POSTS().map((p) => p.id === "p-r" ? { ...p, published_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() } : p);
    use(world(withRelease(1)));
    let res = await h.request("GET", "/api/users/target/passport/postcards", "tok-v");
    assert.equal(venues(res)["pc-r"], "Hidden Courtyard", "inside the window");
    assert.match(log.selects.find((s) => s.table === "posts")!.cols, /\bpublished_at\b/);
    use(world(withRelease(25)));
    res = await h.request("GET", "/api/users/target/passport/postcards", "tok-v");
    assert.equal(venues(res)["pc-r"], null, "after it");
    assert.equal(JSON.stringify(res.json).includes("published_at"), false, "the release time is never served");
  });

  it("D4. the two helpers", async () => {
    const card0 = { postId: "p", locationName: "V", locationCity: "C" };
    assert.equal(postcardForViewer(card0, new Set()), card0, "not withheld: the same object");
    assert.deepStrictEqual(postcardForViewer(card0, new Set(["p"])), { postId: "p", locationName: null, locationCity: "C" });
    assert.deepStrictEqual(postcardForViewer({ postId: null, locationName: "V" }, new Set()), { postId: null, locationName: null }, "no post: unknown mode");
    const sc = fakeDb({ tables: { posts: [post("a", "none"), post("b", "hidden"), { ...post("c", "hidden"), author_id: "me" }] } });
    assert.deepEqual([...(await postcardPostIdsWithPlaceWithheld(sc, ["a", "b", "c", "gone"], "me"))].sort(), ["b", "gone"]);
    assert.deepEqual([...(await postcardPostIdsWithPlaceWithheld(sc, [], "me"))], []);
  });
});

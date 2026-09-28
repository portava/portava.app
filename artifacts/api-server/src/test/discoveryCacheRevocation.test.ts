/**
 * census-discovery §47 — cache B must not outlive the eligibility of the ROWS in
 * it, and the author policy (blocks both ways, mutes, submitter standing) holds
 * on every hit.
 *
 * WHY THIS IS LIVE PRODUCTION CODE. `COMPASS_V1_RULE_BASED_ENABLED` is TRUE on
 * production (integrator read, 2026-09-27), so a signed-in `for_you` request
 * takes the Compass branch and cache B. The shipping client does not send a
 * bearer token to `GET /discovery` today, so the branch is not reached from it
 * — but it is reached by any authenticated caller, and the client fix that adds
 * the header lands on top of this.
 *
 * WHAT WAS WRONG, PRECISELY. `cacheBEntryUsable` bound a stored page to the
 * VIEWER's context — block set, model version, freshness — and to nothing about
 * the rows in it. Cache B stores a FINAL page, community rows included, for ten
 * minutes. So a row that became ineligible WITHOUT the viewer's own context
 * changing was replayed:
 *
 *   - a moderator deactivating it (`discovery_places.status`);
 *   - its submitter's account leaving `active`;
 *   - the viewer MUTING its submitter (mutes were enforced on no Discovery
 *     path at all);
 *   - and, on a curated-read outage, the page ranked while the read was healthy
 *     was replayed THROUGH the outage — rows the request could not verify.
 *
 * Every red below was watched red against the pre-§47 route (the rows named in
 * each assertion message), and every control was watched green on both sides.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryCacheRevocation.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import express from "express";
import pino from "pino";
import discoveryRouter, {
  _clearTestCompassCache, _testCompassCacheEntry, _testCompassCandidateCacheKey,
  _setTestDbPlacesOverride,
} from "../routes/discovery.js";
import {
  cacheBEntryUsable, blockFingerprint, authorizedContextKey, eligibleDbIdSet,
  pageHasRevokedRow, withMutedAuthors, inactiveSubmitterIds, submitterInGoodStanding,
  inactiveSubmittersFromEmbed, isAdultOnlyVenue, REVALIDATED_ROW_PREFIX,
} from "../lib/discoveryCacheEligibility.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import {
  newWorld, worldClient, flag, communityRow, profileRow, type WorldState,
} from "./helpers/fakeDiscoveryWorld.js";

// ── No network: Overpass and Nominatim throw, so the OSM half is empty and cache
// A is never written — which is what makes a second request reach cache B.
const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de")) return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } }); if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) {
    throw new Error("Network blocked in test environment");
  }
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const A = "aaaa0000-0000-4000-8000-00000000000a";   // the viewer
const B = "bbbb0000-0000-4000-8000-00000000000b";   // a second viewer
const S = "55550000-0000-4000-8000-000000000005";   // submitter of p2
const T = "77770000-0000-4000-8000-000000000007";   // submitter of p3
const TOK_A = "tok-a";
const TOK_B = "tok-b";
const DEST = "Miami";
const RADIUS = 10;
const Q = `destination=${DEST}&category=for_you&lat=25.77&lng=-80.19&radiusKm=${RADIUS}`;

function world(): WorldState {
  return newWorld({
    users: { [TOK_A]: A, [TOK_B]: B },
    tables: {
      feature_flags: [flag("COMPASS_V1_RULE_BASED_ENABLED", true)],
      discovery_places: [
        communityRow("p1"),
        communityRow("p2", { submitted_by: S }),
        communityRow("p3", { submitted_by: T }),
      ],
      profiles: [profileRow(A), profileRow(B), profileRow(S), profileRow(T)],
      blocks: [], user_mutes: [], rank_events: [], identity_verifications: [],
    },
  });
}

function resetCaches(): void {
  _clearTestCompassCache();
  invalidateDiscoveryEngineModeCache();
  invalidateFlagsCache();
  invalidateServeLogFlagCache();
  invalidateCandidateProjectionFlagCache();
  invalidateLiveRankFlagCache();
  invalidateDiscoveryModifiersFlagCache();
}

let server: Server;
let base = "";
let w: WorldState;

function use(next: WorldState): void {
  w = next;
  const c = worldClient(w);
  _setTestServiceClient(c as any);
  _setTestClient(c as any, true);
}

/** Which serve path answered — read off the envelope (the D11 suite's discriminator). */
function servePathOf(body: any): string {
  const level = body?.meta?.cacheLevel;
  if (body?.cached === true) return typeof level === "string" ? "cache_a" : "compass_hit";
  if (level === "miss") return "cold";
  if (body?.cached === false && level === undefined) return "compass_fresh";
  return `unrecognised(${JSON.stringify(body?.cached)}/${JSON.stringify(level)})`;
}

async function get(token: string | null, extra = ""): Promise<{ status: number; body: any; ids: string[]; path: string }> {
  const res = await fetch(`${base}/discovery?${Q}${extra}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = await res.json() as any;
  return {
    status: res.status, body,
    ids: ((body.places ?? []) as any[]).map((p) => p.id),
    path: servePathOf(body),
  };
}

const keyFor = (user: string) => _testCompassCandidateCacheKey(user, DEST, RADIUS, null);

before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  globalThis.fetch = _originalFetch;
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

describe("cache B — a row revoked inside the TTL is not replayed (§47)", () => {
  beforeEach(() => { resetCaches(); _setTestDbPlacesOverride(null); use(world()); });
  afterEach(() => { resetCaches(); });

  it("R0 CONTROL: an unchanged world still HITS cache B with the same page", async () => {
    const first = await get(TOK_A);
    assert.equal(first.path, "compass_fresh", "precondition: the first request is a fresh Compass rank");
    assert.deepEqual([...first.ids].sort(), ["db/p1", "db/p2", "db/p3"], "precondition: all three rows are eligible");
    const second = await get(TOK_A);
    assert.equal(second.path, "compass_hit", "an unchanged world must replay cache B — the repair must not disable the cache it repairs");
    assert.deepEqual(second.ids, first.ids, "a hit replays the stored order exactly");
  });

  it("R1 DEFECT: a row a moderator deactivated inside the TTL is gone on the NEXT request", async () => {
    await get(TOK_A);
    w.tables.discovery_places!.find((r) => r.id === "p2")!.status = "rejected";
    const after = await get(TOK_A);
    assert.ok(!after.ids.includes("db/p2"), `a deactivated row was replayed from cache B: ${JSON.stringify(after.ids)}`);
    assert.equal(after.path, "compass_fresh", "the page must be RE-RANKED, not replayed minus a row");
    assert.ok(after.ids.includes("db/p1") && after.ids.includes("db/p3"), "the rest of the page must survive");
  });

  it("R2 DEFECT: a submitter whose account left `active` loses the row on the next request, on the hit path", async () => {
    await get(TOK_A);
    w.tables.profiles!.find((r) => r.id === S)!.account_status = "deactivated";
    const after = await get(TOK_A);
    assert.ok(!after.ids.includes("db/p2"), `a deactivated account's submission was served: ${JSON.stringify(after.ids)}`);
    assert.ok(after.ids.includes("db/p3"), "another submitter's row is untouched");
  });

  it("R3 DEFECT: every non-active status is withheld, not a named list (pending_deletion, deleted)", async () => {
    w.tables.profiles!.find((r) => r.id === S)!.account_status = "pending_deletion";
    w.tables.profiles!.find((r) => r.id === T)!.account_status = "deleted";
    const r = await get(TOK_A);
    assert.deepEqual(r.ids, ["db/p1"], `only the unauthored row may remain: ${JSON.stringify(r.ids)}`);
    const anon = await get(null);
    assert.deepEqual(anon.ids, ["db/p1"], "standing is a fact about the SUBMITTER, so it holds for an anonymous caller too");
  });

  it("R4 DEFECT: a MUTE taken inside the TTL reaches the next request, and the stored key records it", async () => {
    await get(TOK_A);
    w.tables.user_mutes!.push({ muter_id: A, muted_id: S });
    const after = await get(TOK_A);
    assert.equal(after.path, "compass_fresh", "a changed author-exclusion set must MISS cache B");
    assert.ok(!after.ids.includes("db/p2"), `a muted submitter's row was served: ${JSON.stringify(after.ids)}`);
    assert.equal(
      _testCompassCacheEntry(keyFor(A))!.blockKey, blockFingerprint(new Set([S])),
      "the re-ranked page must be stored under the viewer's ACTUAL exclusion set, mute included",
    );
  });

  it("R5 CROSS-VIEWER: A's mute removes the row for A only, and B never receives A's page", async () => {
    w.tables.user_mutes!.push({ muter_id: A, muted_id: S });
    const a = await get(TOK_A);
    const b = await get(TOK_B);
    assert.ok(!a.ids.includes("db/p2"), "A muted S");
    assert.ok(b.ids.includes("db/p2"), `B did not mute S and must still be served p2: ${JSON.stringify(b.ids)}`);
    assert.equal(b.path, "compass_fresh", "B's first request is B's own rank, never a replay of A's page");
    assert.notEqual(_testCompassCacheEntry(keyFor(A))!.blockKey, _testCompassCacheEntry(keyFor(B))!.blockKey);
  });

  it("R6 FAIL-CLOSED + RETRY: an unreadable mute list withholds authored rows, and recovery is not masked by the cache", async () => {
    await get(TOK_A);                                   // a healthy page is cached
    w.errorTables.add("user_mutes");
    const during = await get(TOK_A);
    assert.deepEqual(during.ids, ["db/p1"], `authored rows must be withheld while mutes are unknown: ${JSON.stringify(during.ids)}`);
    assert.equal(during.path, "compass_fresh", "the healthy page must not be replayed over an unknown exclusion set");
    const during2 = await get(TOK_A);
    assert.equal(during2.path, "compass_hit", "two fail-closed requests are the same page — an outage must not force a re-rank per request");
    w.errorTables.delete("user_mutes");
    const recovered = await get(TOK_A);
    assert.equal(recovered.path, "compass_fresh", "the degraded page must not be replayed once the read recovers");
    assert.deepEqual([...recovered.ids].sort(), ["db/p1", "db/p2", "db/p3"]);
  });

  it("R7 FAIL-CLOSED + RETRY: unreadable submitter standing is REPORTED (partial) and never cached past the outage", async () => {
    await get(TOK_A);
    w.errorOps.add("profiles.not");
    const during = await get(TOK_A);
    assert.ok(!during.ids.some((id) => id.startsWith("db/p")), `curated rows served with standing unknown: ${JSON.stringify(during.ids)}`);
    assert.equal(during.body.refusal?.coverage, "partial", "the response must SAY a source is missing");
    assert.deepEqual(during.body.refusal?.failedSources, ["discovery_places"]);
    const during2 = await get(TOK_A);
    assert.equal(during2.path, "compass_hit", "the degraded page is reused while the outage lasts");
    assert.deepEqual(during2.body.refusal?.failedSources, ["discovery_places"], "and still names the missing source on the hit");
    w.errorOps.delete("profiles.not");
    const recovered = await get(TOK_A);
    assert.equal(recovered.path, "compass_fresh", "recovery must re-rank, not replay the degraded page for the rest of the TTL");
    assert.equal(recovered.body.refusal, undefined);
    assert.deepEqual([...recovered.ids].sort(), ["db/p1", "db/p2", "db/p3"]);
  });

  it("R8 AGE: an age change inside the TTL reaches a cache-B hit (the page is re-filtered per request)", async () => {
    w.tables.discovery_places!.push(communityRow("p4", { place_type: "bar", name: "The Bar" }));
    const adult = await get(TOK_A, "&ageFilter=open_to_me");
    assert.ok(adult.ids.includes("db/p4"), "precondition: an adult is served the bar");
    w.tables.profiles!.find((r) => r.id === A)!.date_of_birth = "2012-01-01";
    const minor = await get(TOK_A, "&ageFilter=open_to_me");
    assert.equal(minor.path, "compass_hit", "precondition: this is the replayed page, not a re-rank");
    assert.ok(!minor.ids.includes("db/p4"), `a replayed page served an adult venue to a minor: ${JSON.stringify(minor.ids)}`);
  });

  it("R10 DEFECT: a row whose IMAGE a moderator replaced inside the TTL is served with the new image on the hit", async () => {
    w.tables.discovery_places!.find((r) => r.id === "p2")!.image_url = "https://example.test/original.jpg";
    await get(TOK_A);
    w.tables.discovery_places!.find((r) => r.id === "p2")!.image_url = "https://example.test/replacement.jpg";
    const hit = await get(TOK_A);
    assert.equal(hit.path, "compass_hit", "precondition: the row is still eligible, so this is a replay");
    const p2 = (hit.body.places as any[]).find((p) => p.id === "db/p2");
    assert.equal(p2?.headerImageUrl, "https://example.test/replacement.jpg",
      "a replayed page served the image a moderator had already replaced — the stored copy, not the row");
    assert.deepEqual(hit.ids, (await get(TOK_A)).ids, "and the ORDER is still the stored order");
  });

  it("R9 CONTROL: a row ADDED inside the TTL does not invalidate — revocation is about rows the page holds", async () => {
    await get(TOK_A);
    w.tables.discovery_places!.push(communityRow("p9"));
    const second = await get(TOK_A);
    assert.equal(second.path, "compass_hit", "an addition is freshness (the TTL's job), not a revocation");
  });
});

describe("the rule, as pure functions", () => {
  const facts = (places: string[]) => ({ at: 1_000, blockKey: "none", rankVersion: "v", places: places.map((id) => ({ id })) });
  const req = (eligible?: string[]) => ({
    nowMs: 2_000, blockKey: "none", rankVersion: "v",
    ...(eligible ? { eligibleDbIds: new Set(eligible) } : {}),
  });

  it("U1 a stored db/ row missing from the current read is revoked; OSM rows never are", () => {
    assert.deepEqual(cacheBEntryUsable(facts(["db/a", "node/1"]), req(["db/a"])), { usable: true, reason: "hit" });
    assert.deepEqual(cacheBEntryUsable(facts(["db/a", "db/b"]), req(["db/a"])), { usable: false, reason: "row_revoked" });
    assert.equal(REVALIDATED_ROW_PREFIX, "db/");
    assert.equal(pageHasRevokedRow([{ id: "way/9" }], new Set()), false, "an OSM row has no status or author to revoke");
  });

  it("U2 precedence: the viewer's own context is reported before a row revocation", () => {
    const r = cacheBEntryUsable({ ...facts(["db/b"]), blockKey: "1:x" }, req([]));
    assert.equal(r.reason, "block_set_changed");
  });

  it("U3 an entry that cannot show its rows is rejected when the caller supplies a current set", () => {
    assert.equal(cacheBEntryUsable({ at: 1_000, blockKey: "none", rankVersion: "v" }, req([])).reason, "row_revoked");
    assert.equal(cacheBEntryUsable({ at: 1_000, blockKey: "none", rankVersion: "v" }, req()).reason, "hit",
      "without a current set the pre-§47 contract stands (the route always supplies one — guard G1)");
  });

  it("U4 eligibleDbIdSet keeps only db/ ids", () => {
    assert.deepEqual([...eligibleDbIdSet([{ id: "db/a" }, { id: "node/1" }])], ["db/a"]);
  });

  it("U5 authorizedContextKey: healthy = blockFingerprint; a degraded read is its own context", () => {
    const hidden = new Set(["u2", "u1"]);
    assert.equal(authorizedContextKey(hidden, []), blockFingerprint(hidden), "a healthy page keeps its pre-§47 key");
    assert.notEqual(authorizedContextKey(hidden, ["discovery_places"]), blockFingerprint(hidden));
    assert.equal(authorizedContextKey(null, ["b", "a"]), authorizedContextKey(null, ["a", "b"]), "order-independent");
  });

  it("U6 withMutedAuthors: union, fail-closed on null in and on an unreadable read", async () => {
    const wd = newWorld({ tables: { user_mutes: [{ muter_id: A, muted_id: S }, { muter_id: B, muted_id: T }] } });
    const c = worldClient(wd);
    assert.deepEqual([...(await withMutedAuthors(c, A, new Set(["x"])))!].sort(), [S, "x"].sort());
    assert.equal(await withMutedAuthors(c, A, null), null, "an unreadable block set stays unreadable");
    wd.errorTables.add("user_mutes");
    assert.equal(await withMutedAuthors(c, A, new Set()), null, "an unreadable mute list is NOT 'no mutes'");
    assert.equal(await withMutedAuthors(null, A, new Set()), null, "no client is unreadable, not empty");
  });

  it("U7 inactiveSubmitterIds: no read without submitters; non-active returned; error → null", async () => {
    const wd = newWorld({ tables: { profiles: [profileRow(S, { account_status: "deactivated" }), profileRow(T), profileRow(A, { account_status: null })] } });
    const c = worldClient(wd);
    assert.deepEqual([...(await inactiveSubmitterIds(c, [null, undefined, ""]))!], []);
    assert.equal(wd.reads.length, 0, "no submitter, no read");
    assert.deepEqual([...(await inactiveSubmitterIds(c, [S, T, A, S]))!], [S], "NULL status reads as active; duplicates collapse");
    wd.errorOps.add("profiles.not");
    assert.equal(await inactiveSubmitterIds(c, [S]), null);
  });

  it("U8 submitterInGoodStanding and the embed form", () => {
    assert.equal(submitterInGoodStanding(null, null), true, "a venue fact has no author to be uncertain about");
    assert.equal(submitterInGoodStanding(S, null), false, "unknown standing withholds an authored row");
    assert.equal(submitterInGoodStanding(S, new Set([S])), false);
    assert.equal(submitterInGoodStanding(T, new Set([S])), true);
    const inactive = inactiveSubmittersFromEmbed([
      { submitted_by: S, profiles: { account_status: "deleted" } },
      { submitted_by: T, profiles: { id: T } },                 // no status key → active
      { submitted_by: A, profiles: null },                      // absent embed → withheld
      { submitted_by: null, profiles: null },
    ]);
    assert.deepEqual([...inactive].sort(), [A, S].sort());
  });

  it("U9 isAdultOnlyVenue reads the venue TYPE the route actually carries", () => {
    const adult = new Set(["bar", "pub", "adult_gaming_centre"]);
    assert.equal(isAdultOnlyVenue({ category: "for_you", type: "bar" }, adult), true, "a real Overpass bar");
    assert.equal(isAdultOnlyVenue({ category: "nightlife", type: "adult gaming centre" }, adult), true, "friendlyType renders _ as a space");
    assert.equal(isAdultOnlyVenue({ category: "bar", type: "osm" }, adult), true, "the old comparison's catches still hold");
    assert.equal(isAdultOnlyVenue({ category: "food", type: "cafe" }, adult), false);
  });
});

describe("where the rule is wired (source guards)", () => {
  const route = readFileSync(new URL("../routes/discovery.ts", import.meta.url), "utf8");

  it("G1 the cache-B acceptance call supplies the current eligible set and the degraded-aware key", () => {
    const at = route.indexOf("const cAcceptance = cacheBEntryUsable(");
    assert.ok(at > -1, "re-anchor: the cache-B acceptance call moved");
    const call = route.slice(at, route.indexOf("});", at));
    assert.match(call, /eligibleDbIds:\s*eligibleDbIdSet\(dbPlaces\)/,
      "the route no longer hands cacheBEntryUsable the current eligible set — row revocation is silently off");
    assert.match(route, /const cFiltered = applyFilters\(cCacheHit\.places && withCurrentRows\(cCacheHit\.places, dbPlaces\)\)/,
      "the cache-B hit no longer replays the CURRENT row content");
    assert.match(route, /const cBlockKey = authorizedContextKey\(viewerBlockedIds, dbFailedSources\)/,
      "the cache-B key no longer records unread sources — a page ranked during an outage would be replayed after it");
  });

  it("G2 every discovery_places reader applies mutes and standing", () => {
    const q = route.slice(route.indexOf("async function queryDbPlaces("), route.indexOf("async function queryCanonicalPlaces("));
    assert.match(q, /inactiveSubmitterIds\(sc,/, "queryDbPlaces no longer reads submitter standing");
    assert.match(q, /submitterInGoodStanding\(row\.submitted_by, inactiveSubmitters\)/);
    assert.match(route, /viewerBlockedIds = blockSc \? await fetchBlockedSet\(blockSc, callerUserId\)\.then\(\(b\) => withMutedAuthors\(/,
      "GET /discovery's author-exclusion set no longer includes mutes");
    const comm = route.slice(route.indexOf('router.get("/discovery/community"'), route.indexOf('router.post("/discovery/community"'));
    assert.match(comm, /withMutedAuthors\(sc, viewerId,/);
    assert.match(comm, /submitterInGoodStanding\(row\.submitted_by, inactive\)/);
    assert.match(comm, /profiles:submitted_by!left \([^)]*account_status/, "the byline embed no longer carries account_status");
    const feed = route.slice(route.indexOf('router.get("/discovery/feed"'), route.indexOf('router.get("/discovery/community"'));
    assert.match(feed, /placeBlockedIds = await withMutedAuthors\(sc, viewerId, viewerBlocks\)/);
  });

  it("G3 DiscoveryRankingService's viewer blockedCreatorIds / mutedCreatorIds are read by nothing — threading real sets there would be inert", () => {
    // `lib/discoveryPde.ts` hands the shared ranking service empty sets. The
    // question §47 answers is whether that lets a blocked or muted creator's
    // item be ranked onto a page. It does not, because no code in
    // services/ranking reads either field (its eligibility gate reads per-ITEM
    // booleans), and every Discovery item arrives with `creatorId: null`. The
    // day either field gains a reader, this goes red — and the real sets must
    // then be threaded from lib/discoveryPde.ts.
    const dir = new URL("../services/ranking/", import.meta.url);
    const readers: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(new URL(f, dir), "utf8");
      const uses = src.match(/\.(?:blockedCreatorIds|mutedCreatorIds)\b|\{[^}]*\b(?:blockedCreatorIds|mutedCreatorIds)\b[^}]*\}\s*=/g);
      if (uses) readers.push(`${f}: ${uses.join(" | ")}`);
    }
    assert.deepEqual(readers, [], `a ranking service now READS the viewer's creator sets — thread the real ones from lib/discoveryPde.ts: ${readers.join("; ")}`);
    const pde = readFileSync(new URL("../lib/discoveryPde.ts", import.meta.url), "utf8");
    assert.match(pde, /creatorId:\s*null/, "Discovery now hands the ranker a creatorId; the author policy must move with it");
  });
});

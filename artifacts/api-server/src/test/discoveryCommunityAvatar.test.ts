/**
 * census-discovery §53 (residual §47.7) — `GET /discovery/community`'s byline
 * avatar obeys the submitter's picture privacy, with `lib/mediaFeedItem.ts`'s
 * semantics exactly.
 *
 * The byline is a submitter's name, avatar and handle printed next to a place
 * they submitted. Its `avatarUrl` used to be `profile.avatar_url` whatever
 * `profiles.is_private` and `profiles.show_profile_picture_publicly` said — so a
 * private account's photo, or the photo of someone who had switched "show my
 * profile picture publicly" off, was served to every caller, anonymous ones
 * included. The media surfaces gate the same field:
 *
 *     showAvatar = isOwn || isFollowing
 *               || (!creatorIsPrivate && show_profile_picture_publicly !== false)
 *
 * What this suite holds:
 *   P  the Discovery gate AGREES with mediaFeedItem's two hydrators over the
 *      whole matrix (parity, not resemblance);
 *   V  the route, per viewer: anonymous, stranger, follower, self — and the
 *      columns' defaults;
 *   N  the byline `name` is untouched by any of it (C19 is a separate decision);
 *   R  revocation both ways on the next request, and retries;
 *   F  an unreadable follow edge fails CLOSED and is not a refusal;
 *   K  the Cache B replay path cannot resurrect a stale avatar.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryCommunityAvatar.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import express from "express";
import pino from "pino";
import discoveryRouter, { _clearTestCompassCache, _setTestDbPlacesOverride } from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { communityBylineAvatar } from "../lib/discoveryPeoplePrivacy.js";
import { hydrateGemFeedItem, hydrateMediaFeedItem } from "../lib/mediaFeedItem.js";
import { withCurrentRows } from "../lib/discoveryCacheEligibility.js";
import { invalidateDiscoveryEngineModeCache } from "../lib/discoveryEngineMode.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { invalidateCandidateProjectionFlagCache } from "../lib/discoveryCandidate.js";
import { invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { newWorld, worldClient, flag, communityRow, profileRow, type WorldState } from "./helpers/fakeDiscoveryWorld.js";

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

// ── The cast ─────────────────────────────────────────────────────────────────
const STRANGER = "a1110000-0000-4000-8000-000000000001";
const FOLLOWER = "a2220000-0000-4000-8000-000000000002";
const PUB  = "b1000000-0000-4000-8000-000000000001"; // columns ABSENT (the defaults)
const PUBX = "b2000000-0000-4000-8000-000000000002"; // explicit: public, shown
const PRIV = "b3000000-0000-4000-8000-000000000003"; // private account
const OPT  = "b4000000-0000-4000-8000-000000000004"; // public, picture opted out
const BOTH = "b5000000-0000-4000-8000-000000000005"; // private AND opted out
const SUBMITTERS = [PUB, PUBX, PRIV, OPT, BOTH];
const LABEL: Record<string, string> = { [PUB]: "pub-default", [PUBX]: "pub-explicit", [PRIV]: "private", [OPT]: "opted-out", [BOTH]: "private+opted-out" };
const avatarOf = (id: string) => `https://cdn.test/avatar-${id.slice(0, 4)}.jpg`;

const TOK = { stranger: "tok-stranger", follower: "tok-follower", priv: "tok-priv", opt: "tok-opt" };

function submitterProfile(id: string) {
  const base = profileRow(id, { avatar_url: avatarOf(id) });
  if (id === PUB) return base;                                   // neither column present
  return {
    ...base,
    is_private: id === PRIV || id === BOTH,
    show_profile_picture_publicly: !(id === OPT || id === BOTH),
  };
}

function world(): WorldState {
  return newWorld({
    users: { [TOK.stranger]: STRANGER, [TOK.follower]: FOLLOWER, [TOK.priv]: PRIV, [TOK.opt]: OPT },
    tables: {
      feature_flags: [],
      discovery_places: SUBMITTERS.map((id) => communityRow(`p-${id.slice(0, 4)}`, { submitted_by: id })),
      profiles: [profileRow(STRANGER), profileRow(FOLLOWER), ...SUBMITTERS.map(submitterProfile)],
      user_follows: [PRIV, OPT, BOTH].map((id) => ({ follower_id: FOLLOWER, following_id: id })),
      blocks: [], user_mutes: [], profile_privacy_settings: [], identity_verifications: [], rank_events: [],
    },
  });
}

let w: WorldState;
function use(next: WorldState): void {
  w = next;
  const c = worldClient(w);
  _setTestServiceClient(c as any);
  _setTestClient(c as any, true);
}

let server: Server;
let base = "";
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

/** submitter id → the byline the viewer was served. */
async function bylines(token: string | null): Promise<{ body: any; by: Map<string, any> }> {
  const res = await fetch(`${base}/discovery/community?city=Miami&limit=50`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  const by = new Map<string, any>();
  for (const it of (body.items ?? []) as any[]) if (it.submittedBy) by.set(it.submittedBy.id, it.submittedBy);
  return { body, by };
}
const avatars = async (token: string | null) => {
  const { by } = await bylines(token);
  return Object.fromEntries(SUBMITTERS.map((id) => [LABEL[id]!, by.get(id)?.avatarUrl ?? null]));
};
const shown = (id: string) => avatarOf(id);

// ── P: parity with lib/mediaFeedItem.ts ──────────────────────────────────────

describe("P — the Discovery byline gate IS mediaFeedItem's gate", () => {
  it("P1 over every (private, opted-out, column-absent) × (own, follower, stranger) case, both media hydrators and the Discovery gate agree", () => {
    const privs: Array<boolean | undefined> = [true, false, undefined];
    const shows: Array<boolean | undefined | null> = [true, false, undefined, null];
    let n = 0;
    for (const is_private of privs) {
      for (const show of shows) {
        for (const rel of ["own", "follower", "stranger"] as const) {
          const creator = "cccc0000-0000-4000-8000-00000000000c";
          const viewer = rel === "own" ? creator : "dddd0000-0000-4000-8000-00000000000d";
          const followed = new Set(rel === "follower" ? [creator] : []);
          const profile: any = { id: creator, username: "c", avatar_url: "https://cdn.test/c.jpg" };
          if (is_private !== undefined) profile.is_private = is_private;
          if (show !== undefined) profile.show_profile_picture_publicly = show;

          const mine = communityBylineAvatar(profile, viewer, followed);
          const gem = hydrateGemFeedItem({
            gem: { id: "g1", submitted_by: creator, name: "g", image_url: null },
            viewerUserId: viewer, allowedRealNameIds: new Set(), savedGemIds: new Set(),
            followedCreatorIds: followed, submitterProfile: profile,
          }).creator.avatarUrl;
          const post = hydrateMediaFeedItem({
            row: { id: "r1", author_id: creator, profiles: profile, media_urls: [], created_at: "2026-01-01T00:00:00Z" },
            sourceType: "post", viewerUserId: viewer, allowedRealNameIds: new Set(), savedPostIds: new Set(),
            likedPostIds: new Set(), followedCreatorIds: followed, pendingFollowRequestIds: new Set(),
            postMedia: [], useSignedUrls: true,
          } as any).creator.avatarUrl;
          const tag = JSON.stringify({ is_private, show, rel });
          assert.equal(mine, gem, `Discovery vs gem feed disagree on ${tag}`);
          assert.equal(mine, post, `Discovery vs post feed disagree on ${tag}`);
          n++;
        }
      }
    }
    assert.equal(n, 36);
  });

  it("P2 an anonymous caller is a stranger: nobody's own item, nobody followed", () => {
    const p = { id: "x", avatar_url: "https://cdn.test/x.jpg", is_private: true };
    assert.equal(communityBylineAvatar(p, null, new Set()), null);
    assert.equal(communityBylineAvatar({ ...p, is_private: false }, null, new Set()), "https://cdn.test/x.jpg");
  });
});

// ── V: the route, per viewer ─────────────────────────────────────────────────

describe("V — GET /discovery/community serves the byline avatar only where the submitter allows it", () => {
  beforeEach(() => use(world()));

  it("V1 anonymous and a stranger: private and opted-out pictures are withheld; public ones (including the column DEFAULTS) are served", async () => {
    const expected = {
      "pub-default": shown(PUB), "pub-explicit": shown(PUBX),
      private: null, "opted-out": null, "private+opted-out": null,
    };
    assert.deepEqual(await avatars(null), expected, "anonymous");
    assert.deepEqual(await avatars(TOK.stranger), expected, "stranger");
  });

  it("V2 a follower sees the pictures of the people they follow, private and opted-out alike", async () => {
    assert.deepEqual(await avatars(TOK.follower), {
      "pub-default": shown(PUB), "pub-explicit": shown(PUBX),
      private: shown(PRIV), "opted-out": shown(OPT), "private+opted-out": shown(BOTH),
    });
  });

  it("V3 the submitter always sees their OWN picture — and only their own", async () => {
    const asPriv = await avatars(TOK.priv);
    assert.equal(asPriv.private, shown(PRIV), "a private submitter was denied their own picture");
    assert.equal(asPriv["opted-out"], null, "self-exemption leaked onto someone else's byline");
    const asOpt = await avatars(TOK.opt);
    assert.equal(asOpt["opted-out"], shown(OPT));
    assert.equal(asOpt.private, null);
  });

  it("V4 the columns' DEFAULTS read as public and shown (is_private false, show_profile_picture_publicly true), explicit or absent", async () => {
    const r = await avatars(TOK.stranger);
    assert.equal(r["pub-default"], shown(PUB), "absent columns must read as the product defaults, not as private");
    assert.equal(r["pub-explicit"], shown(PUBX));
  });

  it("V5 the follow edge is read only when a byline needs it — an all-public page issues no extra read", async () => {
    w.tables.discovery_places = [communityRow("p-only", { submitted_by: PUB })];
    await bylines(TOK.follower);
    assert.ok(!w.reads.includes("user_follows"), "an all-public page read the follow graph");
    use(world());
    await bylines(TOK.follower);
    assert.ok(w.reads.includes("user_follows"), "a page with a private byline must consult the follow edge");
  });

  it("V6 the byline embed SELECTS both columns the gate reads — the in-memory world returns whole rows, so this is pinned on the query itself", () => {
    // A PostgREST embed returns only the columns it names. Without these two the
    // gate would read `undefined` for both, which is the PUBLIC default — the
    // leak this repair closes, re-opened by a select list.
    const route = readFileSync(new URL("../routes/discovery.ts", import.meta.url), "utf8");
    const handler = route.slice(route.indexOf('router.get("/discovery/community"'), route.indexOf('router.post("/discovery/community"'));
    const embed = /profiles:submitted_by!left \(([^)]*)\)/.exec(handler)?.[1] ?? "";
    const cols = embed.split(",").map((c) => c.trim());
    for (const c of ["id", "avatar_url", "is_private", "show_profile_picture_publicly"]) {
      assert.ok(cols.includes(c), `the /community byline embed does not select ${c}: (${embed})`);
    }
  });
});

describe("N — the byline NAME is untouched (C19 is a separate rollout decision)", () => {
  beforeEach(() => use(world()));

  it("N1 a private or opted-out submitter's `name` / `displayName` are exactly what a public submitter's are", async () => {
    const { by } = await bylines(TOK.stranger);
    for (const id of SUBMITTERS) {
      const b = by.get(id);
      assert.equal(b.name, `@h${id.slice(0, 4)}`, `${LABEL[id]}: the legacy name shape changed`);
      assert.equal(b.displayName, null, `${LABEL[id]}: displayName changed`);
      assert.equal(b.handle, `h${id.slice(0, 4)}`);
    }
    const self = (await bylines(TOK.priv)).by.get(PRIV);
    assert.equal(self.name, `name ${PRIV.slice(0, 4)}`, "the self-exemption on the name still holds");
  });
});

describe("R — revocation both ways, and retries", () => {
  beforeEach(() => use(world()));

  it("R1 opting OUT withholds the picture from a stranger on the very next request; opting back IN restores it", async () => {
    assert.equal((await avatars(TOK.stranger))["pub-explicit"], shown(PUBX));
    w.tables.profiles!.find((p) => p.id === PUBX)!.show_profile_picture_publicly = false;
    assert.equal((await avatars(TOK.stranger))["pub-explicit"], null, "an opt-out did not reach the next request");
    w.tables.profiles!.find((p) => p.id === PUBX)!.show_profile_picture_publicly = true;
    assert.equal((await avatars(TOK.stranger))["pub-explicit"], shown(PUBX), "an opt-in did not reach the next request");
  });

  it("R2 going PRIVATE withholds from a stranger at once; becoming public restores; a follower is unaffected throughout", async () => {
    w.tables.profiles!.find((p) => p.id === PUBX)!.is_private = true;
    assert.equal((await avatars(TOK.stranger))["pub-explicit"], null);
    w.tables.user_follows!.push({ follower_id: FOLLOWER, following_id: PUBX });
    assert.equal((await avatars(TOK.follower))["pub-explicit"], shown(PUBX));
    w.tables.profiles!.find((p) => p.id === PUBX)!.is_private = false;
    assert.equal((await avatars(TOK.stranger))["pub-explicit"], shown(PUBX));
  });

  it("R3 an UNFOLLOW withholds a private picture on the next request", async () => {
    assert.equal((await avatars(TOK.follower)).private, shown(PRIV));
    w.tables.user_follows = w.tables.user_follows!.filter((e) => e.following_id !== PRIV);
    assert.equal((await avatars(TOK.follower)).private, null);
  });

  it("R4 the same request twice serves the same avatars", async () => {
    assert.deepEqual(await avatars(TOK.follower), await avatars(TOK.follower));
    assert.deepEqual(await avatars(TOK.stranger), await avatars(TOK.stranger));
  });
});

describe("F — an unreadable follow edge fails CLOSED and is not a refusal", () => {
  beforeEach(() => use(world()));

  it("F1 the follower sees what a stranger sees; every item is still served; nothing claims the list is short", async () => {
    w.errorTables.add("user_follows");
    const { body, by } = await bylines(TOK.follower);
    assert.equal(by.get(PRIV)?.avatarUrl, null, "a private picture was served on an unreadable follow edge");
    assert.equal(by.get(OPT)?.avatarUrl, null);
    assert.equal(by.get(PUBX)?.avatarUrl, shown(PUBX), "public pictures do not depend on the edge");
    assert.equal(body.items.length, SUBMITTERS.length, "the picks themselves are all real and all served");
    assert.equal(body.refusal, undefined, "a withheld picture is not a missing item");
    w.errorTables.delete("user_follows");
    assert.equal((await bylines(TOK.follower)).by.get(PRIV)?.avatarUrl, shown(PRIV), "recovery on the next request");
  });
});

// ── K: the Cache B replay path ───────────────────────────────────────────────

describe("K — the Cache B replay path cannot resurrect a stale avatar", () => {
  const A = "aaaa0000-0000-4000-8000-00000000000a";
  const TOK_A = "tok-a";
  const S = PUBX;
  const Q = "destination=Miami&category=for_you&lat=25.77&lng=-80.19&radiusKm=10";

  function resetCaches(): void {
    _clearTestCompassCache();
    invalidateDiscoveryEngineModeCache();
    invalidateFlagsCache();
    invalidateServeLogFlagCache();
    invalidateCandidateProjectionFlagCache();
    invalidateLiveRankFlagCache();
    invalidateDiscoveryModifiersFlagCache();
  }
  beforeEach(() => {
    resetCaches();
    _setTestDbPlacesOverride(null);
    use(newWorld({
      users: { [TOK_A]: A },
      tables: {
        feature_flags: [flag("COMPASS_V1_RULE_BASED_ENABLED", true)],
        discovery_places: [communityRow("k1"), communityRow("k2", { submitted_by: S })],
        profiles: [profileRow(A), submitterProfile(S)],
        blocks: [], user_mutes: [], rank_events: [], identity_verifications: [],
      },
    }));
  });
  afterEach(() => resetCaches());

  async function forYou() {
    const res = await fetch(`${base}/discovery?${Q}`, { headers: { authorization: `Bearer ${TOK_A}` } });
    const text = await res.text();
    const body = JSON.parse(text);
    const path = body?.cached === true ? "compass_hit" : body?.cached === false && body?.meta?.cacheLevel === undefined ? "compass_fresh" : "other";
    return { text, body, path, ids: ((body.places ?? []) as any[]).map((p) => p.id) };
  }

  it("K1 a ranked page carries no submitter avatar, fresh or replayed, before or after the submitter opts out", async () => {
    const fresh = await forYou();
    assert.equal(fresh.path, "compass_fresh", "precondition: a fresh Compass rank writes cache B");
    assert.ok(fresh.ids.includes("db/k2"), "precondition: the authored row is on the page");
    assert.ok(!fresh.text.includes(avatarOf(S)), "a Discovery page carried the submitter's avatar");
    w.tables.profiles!.find((p) => p.id === S)!.show_profile_picture_publicly = false;
    const hit = await forYou();
    assert.equal(hit.path, "compass_hit", "precondition: the second request replays cache B");
    assert.ok(!hit.text.includes(avatarOf(S)), "cache B replayed a submitter avatar after the opt-out");
  });

  it("K2 withCurrentRows replaces the stored copy of a db/ row with the current one — a stale byline cannot ride the replay", () => {
    const stored = [
      { id: "db/k2", submittedBy: { avatarUrl: avatarOf(S) } },
      { id: "node/1", submittedBy: null },
    ];
    const current = [{ id: "db/k2", submittedBy: { avatarUrl: null } }];
    const replayed = withCurrentRows(stored as any[], current as any[]);
    assert.equal((replayed[0] as any).submittedBy.avatarUrl, null, "the replay served the avatar from the stored copy");
    assert.deepEqual(replayed.map((p) => p.id), ["db/k2", "node/1"], "the stored ORDER is kept");
  });
});

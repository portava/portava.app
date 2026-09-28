/**
 * discoverySearchQueryPolicy — census-discovery B02 (GII G62).
 *
 * B02 was held on owner decision D5 (§6), re-keyed D-8 in §69.1, until
 * census-discovery §80 decided it (register D-W10-S1-1): Discovery's search
 * routes take the SHARED PLATFORM's field-context emoji policy — option (b) of
 * §46.5. `global_search` is a lookup field, and the platform's QueryNormalizer
 * (lib/inputAssistance/queryNormalizer.ts, census-input-intelligence G62 `C`)
 * strips emoji from the SEARCH KEY of every lookup field and never from the
 * user's text. Before §80 the tests below pinned the opposite (the emoji rode
 * into the `ilike` pattern); they are restated here as the visible diff of
 * that decision, as §46.5 said they would be:
 *
 *   Q1  `sanitizeQuery` is UNCHANGED: it strips only `(`, `)` and `,`,
 *       collapses whitespace and trims. The emoji rule is applied BEFORE it,
 *       by the platform's `stripEmoji`, exactly as the gateway applies it;
 *   Q2  no emoji reaches the `ilike` pattern the database receives;
 *   Q3  so "🔥 bar" finds "Sky Bar" — and still finds the row whose stored name
 *       carries the emoji, because its text matches "bar";
 *   Q4  an emoji-only query has no searchable characters: `400 invalid_payload`
 *       on /discovery/search, the same answer "((" has always had;
 *   Q5  suggest follows the same rule, and refuses an emoji-only query as
 *       `query_too_short` (a 200 refusal, typeahead-safe);
 *   Q6  ONE policy, not two: the route calls the platform's own `stripEmoji`
 *       and `stripsEmoji("global_search")` is true, so the route and the
 *       gateway cannot drift apart.
 *
 * Run: node --import tsx/esm --test src/test/discoverySearchQueryPolicy.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache, sanitizeQuery } from "../routes/discoverySearch.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { VIEWER, installKit, kitGet, startKitServer, type KitState } from "./discoverySearchTestKit.js";

describe("Q1 — sanitizeQuery strips only the PostgREST metacharacters", () => {
  for (const [input, expected] of [
    ["(a),b", "a b"],
    ["  rock   bar  ", "rock bar"],
    ["🔥 bar", "🔥 bar"],
    ["🔥🔥", "🔥🔥"],
    ["bar 🍸🔥", "bar 🍸🔥"],
    ["café-bar!", "café-bar!"],
    ["#rooftop", "#rooftop"],
    ["rock'n'roll", "rock'n'roll"],
    ["50% off", "50% off"],
    ["👨‍👩‍👧 family", "👨‍👩‍👧 family"],
  ] as const) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(sanitizeQuery(input), expected);
    });
  }
});

const SKY_BAR = "p-sky-bar";
const FIRE_BAR = "p-fire-bar";

function world(): Partial<KitState> {
  const place = (id: string, name: string) => ({
    id, name, city: "Lisbon", blurb: null, image_url: null, header_image_source: null, image_source_type: null,
    image_accuracy_status: null, category: "nightlife", primary_category: "nightlife", lat: 38.7, lng: -9.1,
    canonical_location_id: null, created_at: "2026-01-01T00:00:00Z", submitted_by: null, status: "active", saved_count: 0,
  });
  return {
    rows: {
      profiles: [{ id: VIEWER, handle: "viewer", name: "Viewer", account_status: "active", is_private: false }],
      blocks: [], user_privacy_settings: [], profile_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], event_rsvps: [], events: [], trips: [], trip_plan_items: [], hidden_gems: [], posts: [],
      circles: [], hashtags: [], stamp_definitions: [], canonical_locations: [],
      discovery_places: [place(SKY_BAR, "Sky Bar"), place(FIRE_BAR, "🔥 bar Lisboa")],
    },
  };
}

let base = "";
let server: Server;
before(async () => { ({ base, server } = await startKitServer(discoverySearchRouter)); });
after(() => server.close());
beforeEach(() => {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
});

const ids = (body: any) => ((body.results ?? []) as any[]).map((r) => r.id);

describe("Q2–Q4 — /discovery/search searches the key without its emoji (D-W10-S1-1)", () => {
  it("Q2 — the ilike pattern the places read sends carries no emoji", async () => {
    const { calls } = installKit(world());
    await kitGet(base, `/discovery/search?q=${encodeURIComponent("🔥 bar")}&type=places`);
    const or = calls.ors.find((o) => o.table === "discovery_places");
    assert.ok(or, "control: the places read ran");
    assert.ok(or!.expr.includes("%bar%"), `the stripped key did not reach the pattern: ${or!.expr}`);
    assert.ok(!or!.expr.includes("🔥"), `an emoji reached the pattern: ${or!.expr}`);
  });

  it("Q3 — '🔥 bar' finds 'Sky Bar' AND the row whose name carries the emoji", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("🔥 bar")}&type=places`);
    assert.equal(status, 200);
    assert.deepEqual(ids(body).sort(), [FIRE_BAR, SKY_BAR].sort());
    installKit(world());
    const plain = await kitGet(base, `/discovery/search?q=bar&type=places`);
    assert.deepEqual(ids(plain.body), ids(body), "the emoji query answers exactly what its text answers");
  });

  it("Q4 — an emoji-only query has nothing to search: 400 invalid_payload, like '((' always did", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("🔥")}&type=places`);
    assert.equal(status, 400);
    assert.equal(body.code ?? body.error, "invalid_payload");
    installKit(world());
    const parens = await kitGet(base, `/discovery/search?q=${encodeURIComponent("((")}&type=places`);
    assert.equal(parens.status, 400, "control: the pre-existing no-searchable-characters answer");
    installKit(world());
    const zwj = await kitGet(base, `/discovery/search?q=${encodeURIComponent("👨‍👩‍👧 🔥")}&type=places`);
    assert.equal(zwj.status, 400, "a ZWJ family sequence leaves no orphan joiner to search");
  });
});

describe("Q5 — /discovery/suggest follows the same rule", () => {
  it("'🔥 bar' suggests Sky Bar and the emoji-named place", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/suggest?q=${encodeURIComponent("🔥 bar")}`);
    assert.equal(status, 200);
    const all = (body.groups as any[]).flatMap((g) => g.items.map((i: any) => i.id));
    assert.ok(all.includes(FIRE_BAR));
    assert.ok(all.includes(SKY_BAR));
    assert.equal(body.query, "bar", "the key suggest searched is the stripped one");
  });

  it("an emoji-only suggest is refused as query_too_short, never a silent empty", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/suggest?q=${encodeURIComponent("🔥🔥")}`);
    assert.equal(status, 200);
    assert.deepEqual(body.groups, []);
    assert.equal(body.refusal?.code, "query_too_short");
  });
});

describe("Q6 — one emoji policy for the route and the gateway", () => {
  it("routes/discoverySearch.ts strips with the platform's stripEmoji, and global_search is a stripping context", async () => {
    const { readFile } = await import("node:fs/promises");
    const route = await readFile(new URL("../routes/discoverySearch.ts", import.meta.url), "utf8");
    assert.match(route, /import \{[^}]*\bstripEmoji\b[^}]*\} from "\.\.\/lib\/inputAssistance\/queryNormalizer\.js"/);
    assert.equal((route.match(/stripEmoji\(/g) ?? []).length, 2, "both /discovery/search and /discovery/suggest strip the key");
    const { stripsEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripsEmoji("global_search"), true);
    // The searchers themselves still do not import the normaliser: that module
    // imports sanitizeQuery FROM searchCandidates, and the rule is applied once,
    // at the edge, not per searcher.
    const platform = await readFile(new URL("../lib/inputAssistance/searchCandidates.ts", import.meta.url), "utf8");
    assert.ok(!/queryNormalizer/.test(platform));
  });
});

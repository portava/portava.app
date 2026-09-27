/**
 * discoverySearchQueryPolicy — census-discovery B02 (GII G62, owner decision D5)
 * PINNED AS IT IS, not changed.
 *
 * B02 is held on a recorded owner decision (§6 D5, §10.5, §43.7): whether an
 * emoji in a Discovery query may be stripped. Stripping changes which results
 * a live route returns, so this lane does not choose. What this file does is
 * make today's behaviour a measured fact rather than a sentence, so that the
 * decision, whichever way it goes, lands as a visible diff to these tests:
 *
 *   Q1  `sanitizeQuery` strips ONLY `(`, `)` and `,` (the PostgREST filter
 *       metacharacters), collapses whitespace and trims — nothing else;
 *   Q2  an emoji survives into the `ilike` pattern the database receives;
 *   Q3  so "🔥 bar" does not find "Sky Bar" — and DOES find a row whose stored
 *       text literally carries the emoji;
 *   Q4  an emoji-only query is long enough to be searched (UTF-16 length),
 *       answers 200 with whatever literally matches, and is not a 400;
 *   Q5  suggest behaves the same;
 *   Q6  the input gateway is NOT Discovery's route: its field-context emoji
 *       strip (lib/inputAssistance/queryNormalizer) is not reached from here.
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

describe("Q2–Q4 — /discovery/search carries the emoji into the database pattern", () => {
  it("Q2 — the ilike pattern the places read sends contains the emoji verbatim", async () => {
    const { calls } = installKit(world());
    await kitGet(base, `/discovery/search?q=${encodeURIComponent("🔥 bar")}&type=places`);
    const or = calls.ors.find((o) => o.table === "discovery_places");
    assert.ok(or, "control: the places read ran");
    assert.ok(or!.expr.includes("%🔥 bar%"), `the emoji did not reach the pattern: ${or!.expr}`);
  });

  it("Q3 — '🔥 bar' does NOT find 'Sky Bar', and DOES find the row whose name carries the emoji", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("🔥 bar")}&type=places`);
    assert.equal(status, 200);
    assert.deepEqual(ids(body), [FIRE_BAR]);
    installKit(world());
    const plain = await kitGet(base, `/discovery/search?q=bar&type=places`);
    assert.deepEqual(ids(plain.body).sort(), [FIRE_BAR, SKY_BAR].sort(), "control: without the emoji both bars match");
  });

  it("Q4 — an emoji-only query is searched (200, not 400) and matches only what literally carries it", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("🔥")}&type=places`);
    assert.equal(status, 200, "a single emoji is two UTF-16 units, which passes the 2-character floor");
    assert.deepEqual(ids(body), [FIRE_BAR]);
  });
});

describe("Q5 — /discovery/suggest follows the same rule", () => {
  it("'🔥 bar' suggests the emoji-named place and not Sky Bar", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/suggest?q=${encodeURIComponent("🔥 bar")}`);
    assert.equal(status, 200);
    const all = (body.groups as any[]).flatMap((g) => g.items.map((i: any) => i.id));
    assert.ok(all.includes(FIRE_BAR));
    assert.ok(!all.includes(SKY_BAR));
  });
});

describe("Q6 — the gateway's emoji strip is a different surface", () => {
  it("routes/discoverySearch.ts does not import the input gateway's query normaliser", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../routes/discoverySearch.ts", import.meta.url), "utf8");
    assert.ok(!/queryNormalizer/.test(src), "the Discovery route started using the gateway's emoji policy without an owner decision (D5)");
    assert.ok(!/stripEmoji|stripsEmoji/.test(src));
  });
});

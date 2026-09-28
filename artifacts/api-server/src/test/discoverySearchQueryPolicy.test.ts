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

describe("Q1 — sanitizeQuery strips only the PostgREST metacharacters (`(`, `)`, `,` and, since §80, `*`)", () => {
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
    // §80 follow-up: `*` is PostgREST's like-wildcard, so it is a metacharacter
    // here exactly as `(`, `)` and `,` are — and it carries no search meaning.
    ["**", ""],
    ["5* hotel", "5 hotel"],
  ] as const) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(sanitizeQuery(input), expected);
    });
  }
});

const SKY_BAR = "p-sky-bar";
const FIRE_BAR = "p-fire-bar";
const RED_LION = "p-red-lion";
const CAFE_LUNA = "p-cafe-luna";
const CAFE_SOL = "p-cafe-sol";
const BS_NORTH = "p-backslash-north";
const BS_CAFE = "p-backslash-cafe";
const KIOSK = "p-kiosk-row";
const HUNDRED = "p-hundred-percent";
const THOUSAND = "p-thousand";

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
      discovery_places: [place(SKY_BAR, "Sky Bar"), place(FIRE_BAR, "🔥 bar Lisboa"),
        place(RED_LION, "Red Lion Pub"), place(CAFE_LUNA, "Café Luna"), place(CAFE_SOL, "Cafe Sol"),
        place(BS_NORTH, "Kiosk\\ North"), place(BS_CAFE, "K\\iosk Stand"), place(KIOSK, "Kiosk Row"), place(HUNDRED, "100% Burger"), place(THOUSAND, "1000 Lakes")],
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

// ── census-discovery §80 follow-up (independent verification at bc0ba4a94) ──
// Three emoji shapes the first strip missed, and one rule the first strip had
// not decided. Register D-W10-S1-1, "The follow-up".
const ENGLAND = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"; // 🏴 + tag sequence
const KEY_ONE = "1\u{FE0F}\u{20E3}";
const KEY_STAR = "*\u{FE0F}\u{20E3}";
const HIDDEN = /[\u{FE0F}\u{FE0E}\u{20E3}\u{200D}\u{E0000}-\u{E007F}]/u;

describe("Q7 — the whole emoji sequence leaves the key, not just its base", () => {
  it("Q7a — a subdivision flag (tag sequence) leaves no invisible tag in the key", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji(`${ENGLAND} pub`), "pub");
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent(`${ENGLAND} pub`)}&type=places`);
    assert.equal(status, 200);
    assert.deepEqual(ids(body), [RED_LION]);
  });

  it("Q7b — a subdivision flag alone has nothing to search: 400 on search, query_too_short on suggest", async () => {
    installKit(world());
    const s = await kitGet(base, `/discovery/search?q=${encodeURIComponent(ENGLAND)}&type=places`);
    assert.equal(s.status, 400);
    installKit(world());
    const g = await kitGet(base, `/discovery/suggest?q=${encodeURIComponent(ENGLAND)}`);
    assert.equal(g.body.refusal?.code, "query_too_short");
  });

  it("Q7c — a keycap is removed WITH its base character: '1️⃣ bar' searches 'bar'", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji(`${KEY_ONE} bar`), "bar");
    installKit(world());
    const { body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent(`${KEY_ONE} bar`)}&type=places`);
    assert.ok(ids(body).includes(SKY_BAR), "'1️⃣ bar' must find Sky Bar");
  });

  it("Q7d — keycaps alone ('*️⃣*️⃣') are refused, never searched as a PostgREST '*' wildcard", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji(`${KEY_STAR}${KEY_STAR}`), "");
    installKit(world());
    const { status } = await kitGet(base, `/discovery/search?q=${encodeURIComponent(`${KEY_STAR}${KEY_STAR}`)}&type=places`);
    assert.equal(status, 400);
  });

  it("Q7e — no variation selector, keycap mark, joiner or tag survives in any key (each class pinned)", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    for (const input of [
      "a\u{FE0F} bar",       // VS16 after a letter
      "a\u{FE0E} bar",       // VS15 after a letter
      "x\u{20E3} bar",       // a keycap mark on a non-keycap base
      "\u{200D}bar",         // a stray joiner
      `bar ${ENGLAND}`,       // tags
      "\u{2764}\u{FE0E} bar", // text-presentation heart
    ]) {
      const out = stripEmoji(input);
      assert.ok(!HIDDEN.test(out), `${JSON.stringify(input)} -> ${JSON.stringify(out)} kept a hidden mark`);
      assert.match(out, /bar$/);
    }
  });
});

describe("Q8 — an emoji inside a word (the in-word rule, decided)", () => {
  // Rule: an emoji BETWEEN TWO LOWERCASE LETTERS is inside one word and is
  // removed without a gap ("caf☕e" -> "cafe"). Anywhere else — between words,
  // at an edge, or before an UPPERCASE letter that starts a new word
  // ("Sky🔥Bar") — it separates, as a space.
  it("Q8a — 'caf☕e' is one word, 'Sky🔥Bar' is two", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji("caf\u{2615}e"), "cafe");
    assert.equal(stripEmoji("caf\u{2615}\u{FE0F}e"), "cafe", "the emoji's own selector goes with it");
    assert.equal(stripEmoji("caf\u{2615}\u{00E9}"), "caf\u{00E9}");
    assert.equal(stripEmoji("Sky\u{1F525}Bar"), "Sky Bar");
    assert.equal(stripEmoji("bar\u{1F525} 2"), "bar 2");
  });

  it("Q8b — on the route: 'caf☕é luna' finds 'Café Luna', 'caf☕e' finds 'Cafe Sol', 'Sky🔥Bar' finds 'Sky Bar'", async () => {
    installKit(world());
    const a = await kitGet(base, `/discovery/search?q=${encodeURIComponent("caf\u{2615}\u{00E9} luna")}&type=places`);
    assert.deepEqual(ids(a.body), [CAFE_LUNA]);
    installKit(world());
    const b = await kitGet(base, `/discovery/search?q=${encodeURIComponent("caf\u{2615}e")}&type=places`);
    assert.deepEqual(ids(b.body), [CAFE_SOL]);
    installKit(world());
    const c = await kitGet(base, `/discovery/search?q=${encodeURIComponent("Sky\u{1F525}Bar")}&type=places`);
    assert.deepEqual(ids(c.body), [SKY_BAR]);
  });

  it("Q8c — the gateway normaliser produces the same key (one rule, two callers)", async () => {
    const { normalizeQuery } = await import("../lib/inputAssistance/queryNormalizer.js");
    for (const [input, key] of [[`${ENGLAND} pub`, "pub"], [`${KEY_ONE} bar`, "bar"], ["caf\u{2615}e", "cafe"], ["Sky\u{1F525}Bar", "Sky Bar"]] as const) {
      assert.equal(normalizeQuery(input, { context: "global_search", allowTypoCorrection: false }).query, key, input);
    }
  });
});

describe("Q9 — a literal '*' is never a wildcard (§80 follow-up)", () => {
  it("'**' has nothing to search: 400, not every row", async () => {
    installKit(world());
    const { status } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("**")}&type=places`);
    assert.equal(status, 400);
  });
  it("no '*' reaches the ilike pattern", async () => {
    const { calls } = installKit(world());
    await kitGet(base, `/discovery/search?q=${encodeURIComponent("sky*bar")}&type=places`);
    const or = calls.ors.find((o) => o.table === "discovery_places");
    assert.ok(or && !or.expr.includes("*"), `a '*' reached the pattern: ${or?.expr}`);
  });
});

describe("Q10 — LIKE's own metacharacters are literal in the key (round-3 verification)", () => {
  // `\` is LIKE's escape character; `%` and `_` its wildcards. A user's
  // backslash that reached the pattern unescaped either escaped the closing
  // wildcard ("bar\" -> `%bar\%`, which matches nothing) or swallowed the
  // next letter ("b\ar" -> `%b\ar%`, which matches "bar").
  it("Q10a — 'kiosk\\' finds the row that literally holds it, and only that row", async () => {
    installKit(world());
    const { status, body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("kiosk\\")}&type=places`);
    assert.equal(status, 200);
    assert.deepEqual(ids(body), [BS_NORTH]);
  });

  it("Q10b — 'k\\iosk' is not 'kiosk': Kiosk Row is not found, the literal row is", async () => {
    installKit(world());
    const { body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("k\\iosk")}&type=places`);
    assert.deepEqual(ids(body), [BS_CAFE]);
  });

  it("Q10c — '100%' is a literal percent sign, not a wildcard", async () => {
    installKit(world());
    const { body } = await kitGet(base, `/discovery/search?q=${encodeURIComponent("100%")}&type=places`);
    assert.deepEqual(ids(body), [HUNDRED]);
  });

  it("Q10d — the pattern the database receives escapes the backslash itself", async () => {
    const { calls } = installKit(world());
    await kitGet(base, `/discovery/search?q=${encodeURIComponent("k\\iosk")}&type=places`);
    const or = calls.ors.find((o) => o.table === "discovery_places");
    assert.ok(or!.expr.includes("%k\\\\iosk%"), `the backslash was not escaped: ${or!.expr}`);
  });
});

describe("Q11 — the gateway's duplicate scan keeps LIKE's escapes (round 3)", () => {
  // Until §80.14, `lib/postgrestFilter.safeOrIlikeValue` LIKE-escaped FIRST and then stripped
  // the `.or()` structural characters, backslash included — so the escape it
  // had just added was removed again and "100%" reached the pattern as a
  // wildcard. The creation-assistance duplicate scan (a gateway path) now
  // strips the structure first and escapes second.
  it("Q11a — a place named '100%' is scanned as a literal percent, and a backslash cannot re-open a wildcard", async () => {
    const { scanDuplicatePlaces, scanDuplicateEvents } = await import("../lib/inputAssistance/duplicateDetection.js");
    const { makeKitClient, emptyState, emptyCalls } = await import("./discoverySearchTestKit.js");
    const calls = emptyCalls();
    const sc = makeKitClient(emptyState({ rows: { places: [], events: [] } }), calls) as any;
    await scanDuplicatePlaces(sc, { name: "100%", city: "a\\_b" });
    await scanDuplicateEvents(sc, { name: "50% off", city: null });
    const exprs = calls.ors.map((o) => o.expr).join(" | ");
    assert.ok(exprs.includes("name.ilike.%100\\%%"), `the percent reached the pattern unescaped: ${exprs}`);
    assert.ok(exprs.includes("city.ilike.%a\\_b%"), `the underscore reached the pattern unescaped: ${exprs}`);
    assert.ok(exprs.includes("title.ilike.%50\\% off%"), exprs);
  });
});

describe("Q8d — the in-word rule in CASED scripts: lowercase on both sides joins (round 3; not script-neutral, see Q8e)", () => {
  it("Greek and Cyrillic lowercase words join across an emoji; a capital still starts a new word", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji("αθ\u{1F525}ήνα"), "αθήνα");
    assert.equal(stripEmoji("моск\u{1F525}ва"), "москва");
    assert.equal(stripEmoji("Москва\u{1F525}Питер"), "Москва Питер");
  });
});

// Round 4 (register D-W10-S1-1, "Uncased scripts"). Q8d's rule reads CASE, so an
// uncased script never met it and every emoji there separated: "กรุง🔥เทพ"
// searched "กรุง เทพ", which cannot find "กรุงเทพ". Thai, Lao, Khmer, Myanmar,
// Han and kana are written WITHOUT spaces between words, so a gap there is
// never a word boundary the person typed: an emoji between two letters of those
// scripts is removed without one. Uncased scripts that DO space their words
// (Arabic, Hebrew) keep the separating default, because nothing in the text
// says the emoji is inside a word.
describe("Q8e — uncased scripts: spaceless scripts join, spaced ones separate (round 4)", () => {
  it("Thai, Han and kana join across an emoji", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji("กรุง\u{1F525}เทพ"), "กรุงเทพ");
    assert.equal(stripEmoji("東京\u{1F525}タワー"), "東京タワー");
    assert.equal(stripEmoji("すし\u{1F363}や"), "すしや");
  });

  it("Arabic and Hebrew keep the separating default", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji("مرحبا\u{1F525}بك"), "مرحبا بك");
    assert.equal(stripEmoji("שלום\u{1F525}עולם"), "שלום עולם");
  });

  it("a script change is a boundary, and an edge emoji still separates", async () => {
    const { stripEmoji } = await import("../lib/inputAssistance/queryNormalizer.js");
    assert.equal(stripEmoji("tokyo\u{1F525}東京"), "tokyo 東京");
    assert.equal(stripEmoji("\u{1F525}東京"), "東京");
  });

  // The gateway transliterates as well as stripping. Until round 4 it
  // transliterated FIRST, so an emoji inside a word split the word the
  // dictionary looks up: "моск🔥ва" searched "moskva" where "москва" searches
  // "moscow", and "กรุง🔥เทพ" searched "krungethph" instead of "bangkok".
  it("the gateway's key is the same as for the word typed without the emoji, in every script", async () => {
    const { normalizeQuery } = await import("../lib/inputAssistance/queryNormalizer.js");
    const opts = { context: "global_search", allowTypoCorrection: false } as const;
    assert.equal(normalizeQuery("กรุง\u{1F525}เทพ", opts).query, normalizeQuery("กรุงเทพ", opts).query);
    assert.equal(normalizeQuery("東京\u{1F525}タワー", opts).query, normalizeQuery("東京タワー", opts).query);
    assert.equal(normalizeQuery("моск\u{1F525}ва", opts).query, normalizeQuery("москва", opts).query);
    assert.equal(normalizeQuery("αθ\u{1F525}ήνα", opts).query, normalizeQuery("αθήνα", opts).query);
  });
});


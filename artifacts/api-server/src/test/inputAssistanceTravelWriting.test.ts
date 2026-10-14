/**
 * census-input-intelligence G141 — Postcards / Memories: writing assistance
 * without inventing travel facts (spec §22).
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceTravelWriting.test.ts
 *
 * Style: the existing §22 path end to end — the gateway (or buildAiAssistedWriting
 * directly) over a table-backed fake Supabase client that RECORDS every table it
 * is asked for, with the EXISTING model seam (_setTestOpenAI) stubbed. No real
 * model is called. Proves, for `postcard.caption` and `memory.caption`:
 *   T  a variant that names a venue, a person, a date, a count or a food the
 *      traveller did not write is DROPPED; a polish of their own words is served;
 *   F  the flag OFF ⇒ no AI row and the model is never called;
 *   C  the model is sent the traveller's words ONLY — no draft field, no city,
 *      and no Memory / Passport fact read from any table (OD-INPUT-3);
 *   M  an existing Memory's caption reaches the model only when it is the
 *      caller's, not deleted, and carries none of DO_NOT_RESURFACE,
 *      KEEP_PRIVATE_FOREVER, RETAIN_BUT_DO_NOT_PERSONALIZE; every failed read
 *      refuses (MEM-NARR-1's rule, PR #720);
 *   H  every other `caption` variant gets the HARD check (names in mid-sentence,
 *      digits, calendar names, handles, links) and nothing stricter, so G139's
 *      variants are unchanged; a non-caption context is not touched (G140);
 *   R  the route keeps a uuid-shaped `sessionContext.memoryId` and drops anything else.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateSuggestions } from "../lib/inputAssistance/gateway.js";
import { resolvePolicy, POLICY_VERSION } from "../lib/inputAssistance/policyRegistry.js";
import { buildAiAssistedWriting, COMPASS_AI_WRITING_FLAG } from "../lib/inputAssistance/aiWriting.js";
import {
  inventedFacts,
  isTravelWritingField,
  travelWritingGate,
  TRAVEL_WRITING_FIELD_IDS,
  TRAVEL_WRITING_TASK,
  TRAVEL_WRITING_EXCLUDING_CONTROLS,
  CONNECTING_WORDS,
} from "../lib/inputAssistance/travelWriting.js";
import { parseSessionContext } from "../routes/inputAssistance.js";
import { _setTestOpenAI } from "../lib/openai.js";
import type { InputContext, InputSuggestion } from "../lib/inputAssistance/types.js";

const ME = "aa000000-0000-4000-a000-000000000001";
const OTHER = "bb000000-0000-4000-a000-000000000002";
const MEM = "cc000000-0000-4000-a000-000000000003";
const POSTCARD = TRAVEL_WRITING_FIELD_IDS.postcardCaption;
const MEMORY = TRAVEL_WRITING_FIELD_IDS.memoryCaption;

// ── Fake Supabase: rows per table, an injectable error per table, and a log of every table read ──
type TableState = any[] | { error: { code?: string; message: string } };
function makeClient(state: Record<string, TableState>) {
  const reads: string[] = [];
  const client = {
    reads,
    rpc() { return Promise.resolve({ data: [], error: null }); },
    from(table: string) {
      reads.push(table);
      const entry = state[table];
      const failure = entry && !Array.isArray(entry) ? entry.error : null;
      const rows = Array.isArray(entry) ? [...entry] : [];
      const filters: Array<(r: any) => boolean> = [];
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
        neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
        in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
        not() { return b; }, is() { return b; }, ilike() { return b; }, or() { return b; },
        gte() { return b; }, lt() { return b; }, gt() { return b; }, lte() { return b; },
        order() { return b; }, limit() { return b; }, range() { return b; }, contains() { return b; }, overlaps() { return b; },
        maybeSingle() {
          if (failure) return Promise.resolve({ data: null, error: failure });
          const m = rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: m[0] ?? null, error: null });
        },
        then(onF: any, onR: any) {
          if (failure) return Promise.resolve({ data: null, error: failure }).then(onF, onR);
          const m = rows.filter((r) => filters.every((f) => f(r)));
          return Promise.resolve({ data: m, error: null }).then(onF, onR);
        },
      };
      return b;
    },
  };
  return client;
}

function state(flag: boolean, extra: Record<string, TableState> = {}): Record<string, TableState> {
  return { feature_flags: [{ flag: COMPASS_AI_WRITING_FLAG, enabled: flag }], blocks: [], ...extra };
}

/** The stubbed EXISTING model path. Counts calls and keeps the last request. */
function model(content: string) {
  const calls: any[] = [];
  _setTestOpenAI({
    chat: { completions: { create: async (opts: any) => { calls.push(opts); return { choices: [{ message: { role: "assistant", content } }] }; } } },
  } as any);
  return calls;
}

afterEach(() => { _setTestOpenAI(null); });

async function write(
  sc: any,
  fieldId: string | undefined,
  text: string,
  opts: { context?: InputContext; memoryId?: string; draft?: Record<string, unknown>; city?: string | null; userId?: string } = {},
): Promise<InputSuggestion[]> {
  const context = opts.context ?? "caption";
  return buildAiAssistedWriting(sc, {
    context,
    policy: resolvePolicy(context, fieldId)!,
    text,
    draft: opts.draft as any,
    sessionContext: opts.memoryId ? { memoryId: opts.memoryId } : undefined,
    city: opts.city ?? null,
    policyVersion: POLICY_VERSION,
    max: 2,
    userId: opts.userId ?? ME,
  });
}

const labels = (rows: InputSuggestion[]) => rows.map((r) => r.label);
const MEMORY_TABLES = (reads: string[]) => reads.filter((t) => t.startsWith("memor") || t.startsWith("passport") || t.startsWith("trip"));

// ═══════════════════════════════════════════════════════════════════════════════
// T — a Postcard or Memory caption never states what the traveller did not
// ═══════════════════════════════════════════════════════════════════════════════

describe("T — invented travel facts are dropped, the traveller's own words are served", () => {
  for (const fieldId of [POSTCARD, MEMORY]) {
    it(`T1 ${fieldId}: "Sunset sushi at Nobu with Marcus" is dropped; "What a great dinner tonight!" is served`, async () => {
      const calls = model("Sunset sushi at Nobu with Marcus\nWhat a great dinner tonight!");
      const sc = makeClient(state(true));
      const rows = await write(sc, fieldId, "great dinner tonight");
      assert.equal(calls.length, 1, "the model is asked once");
      assert.deepEqual(labels(rows), ["What a great dinner tonight!"]);
      const r = rows[0]!;
      assert.equal(r.type, "ai_suggestion");
      assert.equal(r.source, "ai");
      assert.equal(r.action?.type, "replace_text", "an editable proposal, never inserted or published (§22)");
      assert.equal(r.entityId, undefined, "creates no canonical fact");
    });
  }

  it("T2 the same through the gateway, with the field id the composer registers (the wiring, not only the helper)", async () => {
    const calls = model("Our 3rd dinner in Hoi An on Friday\nSuch a great dinner tonight");
    const sc = makeClient(state(true));
    const policy = resolvePolicy("caption", POSTCARD)!;
    const out = await generateSuggestions(sc, {
      context: "caption", policy, text: "great dinner tonight", userId: ME, limit: policy.maxSuggestions,
      lat: null, lng: null, city: null, aiAssist: true, tz: null,
    });
    const ai = out.filter((s) => s.type === "ai_suggestion");
    assert.equal(calls.length, 1);
    assert.deepEqual(labels(ai), ["Such a great dinner tonight"]);
  });

  it("T3 facts the traveller DID write may be kept, verbatim or reworded", async () => {
    model("Dinner with Marcus at Nobu on Friday — unforgettable!\nFriday at Nobu with Marcus: what a dinner");
    const rows = await write(makeClient(state(true)), MEMORY, "dinner with Marcus at Nobu on Friday");
    assert.deepEqual(labels(rows), [
      "Dinner with Marcus at Nobu on Friday — unforgettable!",
      "Friday at Nobu with Marcus: what a dinner",
    ]);
  });

  it("T4 a polish that adds company, a time, a count or a place the seed lacks is dropped", async () => {
    model("We had the best dinner with friends\nTwo bowls of noodles by the beach");
    const rows = await write(makeClient(state(true)), POSTCARD, "best noodles ever");
    assert.deepEqual(labels(rows), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// F — the flag gate stays the first chokepoint
// ═══════════════════════════════════════════════════════════════════════════════

describe("F — compass_ai_writing_enabled OFF: no AI row, the model is never called", () => {
  for (const fieldId of [POSTCARD, MEMORY]) {
    it(`F1 ${fieldId}`, async () => {
      const calls = model("What a great dinner tonight!");
      const sc = makeClient(state(false));
      const rows = await write(sc, fieldId, "great dinner tonight", { memoryId: fieldId === MEMORY ? MEM : undefined });
      assert.deepEqual(rows, []);
      assert.equal(calls.length, 0, "a dark feature calls no model");
      assert.deepEqual(MEMORY_TABLES(sc.reads), [], "a dark feature reads no Memory table");
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// C — what the model is sent: the traveller's words, nothing else
// ═══════════════════════════════════════════════════════════════════════════════

describe("C — the model gets the traveller's own words and no fact from anywhere else", () => {
  it("C1 a draft's city, country and dates and the request's city are NOT sent; the polish task is", async () => {
    const calls = model("What a great dinner tonight!");
    const sc = makeClient(state(true));
    await write(sc, MEMORY, "great dinner tonight", {
      draft: { city: "Da Nang", country: "Vietnam", category: "nightlife", startDate: "2026-10-01", endDate: "2026-10-03" },
      city: "Da Nang",
    });
    assert.equal(calls.length, 1);
    const sent = JSON.stringify(calls[0].messages);
    for (const leaked of ["Da Nang", "Vietnam", "nightlife", "2026-10-01", "2026-10-03"]) {
      assert.ok(!sent.includes(leaked), `${leaked} must not reach the model for a Memory caption`);
    }
    assert.ok(sent.includes("great dinner tonight"), "the traveller's words are the seed");
    assert.ok(sent.includes(JSON.stringify(TRAVEL_WRITING_TASK).slice(1, 40)), "the polish-only task is sent");
    assert.ok(sent.includes("<portava:ugc>"), "the seed is wrapped as data, not instructions");
  });

  it("C2 a NEW Memory and a Postcard read no Memory, Passport or Trip table at all", async () => {
    for (const fieldId of [POSTCARD, MEMORY]) {
      model("What a great dinner tonight!");
      const sc = makeClient(state(true));
      await write(sc, fieldId, "great dinner tonight");
      assert.deepEqual(MEMORY_TABLES(sc.reads), [], `${fieldId} read ${MEMORY_TABLES(sc.reads).join(", ")}`);
    }
  });

  it("C3 a Postcard request that names a Memory id reads nothing of it (the id is only for memory.caption)", async () => {
    model("What a great dinner tonight!");
    const sc = makeClient(state(true));
    const rows = await write(sc, POSTCARD, "great dinner tonight", { memoryId: MEM });
    assert.equal(rows.length, 1);
    assert.deepEqual(MEMORY_TABLES(sc.reads), []);
  });

  it("C4 the generic caption keeps its §29 coarse context (G139 unchanged)", async () => {
    const calls = model("A lovely evening out");
    await write(makeClient(state(true)), "post.caption", "great night", { draft: { city: "Da Nang" } });
    assert.ok(JSON.stringify(calls[0].messages).includes("Da Nang"), "post.caption still sends the coarse city");
    assert.ok(!JSON.stringify(calls[0].messages).includes(TRAVEL_WRITING_TASK.slice(0, 30)), "and the generic caption task");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// M — an existing Memory: the owner's controls decide (MEM-NARR-1's rule)
// ═══════════════════════════════════════════════════════════════════════════════

const mine = (extra: Record<string, unknown> = {}) => [{ id: MEM, owner_id: ME, state: "published", ...extra }];
const control = (c: string, owner = ME) => [{ memory_id: MEM, owner_id: owner, control: c }];

describe("M — memory.caption on an existing Memory", () => {
  it("M1 the caller's Memory with no control: served, after reading its owner and its controls", async () => {
    const calls = model("What a great dinner tonight!");
    const sc = makeClient(state(true, { memories: mine(), memory_resurfacing_preferences: [] }));
    const rows = await write(sc, MEMORY, "great dinner tonight", { memoryId: MEM });
    assert.equal(rows.length, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(MEMORY_TABLES(sc.reads), ["memories", "memory_resurfacing_preferences"],
      "only the owner check and the controls — no Memory content is read");
  });

  it("M2 the three controls are exactly memoryReaderGuard's model-mediated set", () => {
    assert.deepEqual([...TRAVEL_WRITING_EXCLUDING_CONTROLS].sort(),
      ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]);
  });

  for (const c of ["DO_NOT_RESURFACE", "KEEP_PRIVATE_FOREVER", "RETAIN_BUT_DO_NOT_PERSONALIZE"]) {
    it(`M3 ${c}: no AI, and the caption never reaches the model`, async () => {
      const calls = model("What a great dinner tonight!");
      const sc = makeClient(state(true, { memories: mine(), memory_resurfacing_preferences: control(c) }));
      assert.deepEqual(await write(sc, MEMORY, "great dinner tonight", { memoryId: MEM }), []);
      assert.equal(calls.length, 0);
    });
  }

  it("M4 DO_NOT_INCLUDE_IN_RECAPS is a recap control only: served", async () => {
    model("What a great dinner tonight!");
    const sc = makeClient(state(true, { memories: mine(), memory_resurfacing_preferences: control("DO_NOT_INCLUDE_IN_RECAPS") }));
    assert.equal((await write(sc, MEMORY, "great dinner tonight", { memoryId: MEM })).length, 1);
  });

  it("M5 a control row recorded under another owner is not this owner's control: served", async () => {
    model("What a great dinner tonight!");
    const sc = makeClient(state(true, { memories: mine(), memory_resurfacing_preferences: control("KEEP_PRIVATE_FOREVER", OTHER) }));
    assert.equal((await write(sc, MEMORY, "great dinner tonight", { memoryId: MEM })).length, 1);
  });

  const refusals: Array<[string, Record<string, TableState>]> = [
    ["someone else's Memory", { memories: [{ id: MEM, owner_id: OTHER, state: "published" }], memory_resurfacing_preferences: [] }],
    ["a deleted Memory", { memories: mine({ state: "deleted" }), memory_resurfacing_preferences: [] }],
    ["a removed Memory", { memories: mine({ state: "removed" }), memory_resurfacing_preferences: [] }],
    ["a missing Memory", { memories: [], memory_resurfacing_preferences: [] }],
    ["an unreadable Memory", { memories: { error: { code: "57014", message: "statement timeout" } }, memory_resurfacing_preferences: [] }],
    ["unreadable controls", { memories: mine(), memory_resurfacing_preferences: { error: { code: "57014", message: "statement timeout" } } }],
  ];
  for (const [what, tables] of refusals) {
    it(`M6 ${what}: no AI, the model is never called`, async () => {
      const calls = model("What a great dinner tonight!");
      assert.deepEqual(await write(makeClient(state(true, tables)), MEMORY, "great dinner tonight", { memoryId: MEM }), []);
      assert.equal(calls.length, 0);
    });
  }

  it("M7 3671 not applied (the controls table is absent): no control can exist, served", async () => {
    model("What a great dinner tonight!");
    const sc = makeClient(state(true, { memories: mine(), memory_resurfacing_preferences: { error: { code: "42P01", message: 'relation "memory_resurfacing_preferences" does not exist' } } }));
    assert.equal((await write(sc, MEMORY, "great dinner tonight", { memoryId: MEM })).length, 1);
  });

  it("M8 no caller: refused before any read", async () => {
    const sc = makeClient(state(true, { memories: mine() }));
    const g = await travelWritingGate(sc, { fieldId: MEMORY, userId: "", memoryId: MEM });
    assert.deepEqual(g, { open: false, reason: "memory_not_found" });
    assert.deepEqual(MEMORY_TABLES(sc.reads), [], "no caller, no read");
  });

  it("M9 the gateway hands the caller to the gate (someone else's Memory id through generateSuggestions is refused)", async () => {
    const calls = model("What a great dinner tonight!");
    const sc = makeClient(state(true, { memories: [{ id: MEM, owner_id: OTHER, state: "published" }], memory_resurfacing_preferences: [] }));
    const policy = resolvePolicy("caption", MEMORY)!;
    const out = await generateSuggestions(sc, {
      context: "caption", policy, text: "great dinner tonight", userId: ME, limit: policy.maxSuggestions,
      sessionContext: { memoryId: MEM }, lat: null, lng: null, city: null, aiAssist: true, tz: null,
    });
    assert.equal(out.filter((s) => s.type === "ai_suggestion").length, 0);
    assert.equal(calls.length, 0);
  });

  it("M10 …and the caller's OWN Memory through generateSuggestions is served (the gateway passes who is asking)", async () => {
    const calls = model("What a great dinner tonight!");
    const sc = makeClient(state(true, { memories: mine(), memory_resurfacing_preferences: [] }));
    const policy = resolvePolicy("caption", MEMORY)!;
    const out = await generateSuggestions(sc, {
      context: "caption", policy, text: "great dinner tonight", userId: ME, limit: policy.maxSuggestions,
      sessionContext: { memoryId: MEM }, lat: null, lng: null, city: null, aiAssist: true, tz: null,
    });
    assert.deepEqual(labels(out.filter((s) => s.type === "ai_suggestion")), ["What a great dinner tonight!"]);
    assert.equal(calls.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// The check itself, class by class
// ═══════════════════════════════════════════════════════════════════════════════

describe("inventedFacts — travel level (the two G141 fields): an ALLOWLIST", () => {
  const seed = ["great dinner tonight"];

  // Drafts a model could plausibly return for "great dinner tonight", each adding
  // ONE thing the traveller did not write. Every one must be refused. A blocklist
  // of travel words would pass most of these (walk, poured, grandmother, stars,
  // chef, quarter…): the allowlist refuses them because no rule has to name them.
  const inventing: Array<[string, string]> = [
    ["a venue in mid-sentence", "Great dinner at Nobu tonight"],
    ["a person opening the sentence", "Marcus loved this great dinner tonight"],
    ["a count in digits", "Great dinner tonight, 3 courses"],
    ["an ordinal", "My first great dinner tonight"],
    ["a count in words", "Great dinner tonight for two"],
    ["a weekday", "Great dinner tonight, friday vibes"],
    ["a month", "Great dinner tonight in october"],
    ["a handle", "Great dinner tonight with @marcus"],
    ["a hashtag", "Great dinner tonight #nobu"],
    ["a link", "Great dinner tonight www.nobu.com"],
    ["company", "Great dinner tonight with friends"],
    ["'we'", "We had a great dinner tonight"],
    ["'our'", "Our great dinner tonight"],
    ["a relative", "Great dinner tonight with grandmother"],
    ["a food", "Great sushi dinner tonight"],
    ["a dish", "Great dinner tonight, the pho was perfect"],
    ["a place", "Great dinner tonight on the rooftop"],
    ["a neighbourhood", "Great dinner tonight in the old quarter"],
    ["a view", "Great dinner tonight with a view"],
    ["a sky", "Great dinner tonight under the stars"],
    ["a different time", "Great dinner this evening"],
    ["weather", "Great dinner on a rainy night"],
    ["weather as a verb", "Great dinner tonight while it poured"],
    ["warmth", "Great dinner tonight, so warm out"],
    ["an activity", "Great dinner tonight after a long walk"],
    ["a movement", "Great dinner tonight before the flight home"],
    ["a repeat visit", "Great dinner tonight, again"],
    ["a celebration", "A great dinner tonight to celebrate"],
    ["a staff member", "Great dinner tonight, the chef outdid himself"],
    ["a rating", "Great dinner tonight, five stars"],
    ["a price", "Great dinner tonight, cheap too"],
    ["a taste", "Great dinner tonight, spicy!"],
    ["music", "Great dinner tonight, live music"],
    ["a hometown", "Great dinner tonight in my hometown"],
    ["a trip", "Great dinner tonight on vacation"],
    ["a wait", "Great dinner tonight, worth the wait"],
    ["a hyphenated invention", "Great sea-view dinner tonight"],
    ["a caseless script the traveller did not write", "Great dinner tonight ร้านอร่อย"],
    ["another language's words", "Great dinner tonight, muy rico"],
  ];
  for (const [what, variant] of inventing) {
    it(`refuses ${what}: "${variant}"`, () => {
      assert.ok(inventedFacts(variant, seed, "travel").length > 0, `${variant} should be refused`);
    });
  }

  const faithful: Array<[string, string]> = [
    ["a reworded polish", "What a great dinner tonight!"],
    ["praise and an intensifier", "Such a great dinner tonight. So happy!"],
    ["'I' and a possessive of the seed's own word", "I loved tonight's great dinner"],
    ["the seed's words reordered", "Tonight's dinner was great"],
    ["the seed's words in another case", "GREAT dinner TONIGHT"],
    ["an emoji and quotes", "\"Great dinner tonight\" 🍽️"],
    ["a plural of the seed's own word", "Great dinners like tonight's"],
    ["feeling words", "Really great dinner tonight, truly unforgettable"],
    ["curly apostrophes", "Tonight’s dinner? Simply great."],
    ["a possessive of a connecting word", "Great dinner tonight, life's good"],
    ["a hyphenated phrase of connecting words", "Great dinner tonight, oh-so-good"],
  ];
  for (const [what, variant] of faithful) {
    it(`allows ${what}: "${variant}"`, () => {
      assert.deepEqual(inventedFacts(variant, seed, "travel"), []);
    });
  }

  it("the allowlist itself states nothing: no company, time, count, order, food, place, weather or movement word is in it", () => {
    // MUTATION-PROOF: add any of these to CONNECTING_WORDS and this goes RED. It
    // is what stops the vocabulary drifting into a fact one convenient word at a time.
    const forbidden = [
      "we", "us", "our", "ours", "they", "them", "their", "he", "she", "him", "her", "his", "together", "friends",
      "family", "one", "two", "first", "second", "last", "again", "once", "twice", "both", "today", "tonight",
      "yesterday", "now", "day", "night", "morning", "evening", "weekend", "dinner", "lunch", "food", "drinks",
      "beach", "city", "place", "spot", "view", "home", "trip", "went", "visited", "came", "arrived", "walk", "rain",
      "sunny", "warm", "cozy", "delicious", "cheers", "finally", "new",
    ];
    assert.deepEqual(forbidden.filter((w) => CONNECTING_WORDS.has(w)), []);
  });

  it("a Thai caption the traveller wrote is kept verbatim, and refused when changed", () => {
    assert.deepEqual(inventedFacts("อาหารเย็นอร่อยมาก", ["อาหารเย็นอร่อยมาก"], "travel"), []);
    assert.ok(inventedFacts("อาหารเย็นที่ร้านโปรด", ["อาหารเย็นอร่อยมาก"], "travel").length > 0);
  });

  it("a Vietnamese caption is its own ground; words the traveller did not write are refused", () => {
    assert.deepEqual(inventedFacts("Bữa tối ở Hội An", ["bữa tối ở hội an"], "travel"), []);
    assert.ok(inventedFacts("Bữa tối ở Hội An", ["bữa tối ngon"], "travel").length > 0);
  });

  it("a handle or link the traveller wrote may stay", () => {
    assert.deepEqual(inventedFacts("Great dinner with @marcus", ["great dinner with @marcus"], "travel"), []);
  });
});

describe("H — the HARD level, on every other caption (G139 unchanged in intent)", () => {
  it("H1 G139's own fixtures pass the hard check", () => {
    assert.deepEqual(inventedFacts("A perfect spot for the evening.", ["great night", "Da Nang"], "hard"), []);
    assert.deepEqual(inventedFacts("A relaxed evening downtown", ["night out", "Da Nang"], "hard"), []);
  });

  it("H2 an ordinary word opening a sentence is not judged at the hard level (only at travel)", () => {
    assert.deepEqual(inventedFacts("Delightful evening out", ["great night"], "hard"), []);
    assert.ok(inventedFacts("Delightful evening out", ["great night"], "travel").length > 0);
  });

  it("H3 names in mid-sentence, digits, calendar names, handles and links are refused at the hard level too", () => {
    for (const v of ["A night at Nobu", "A night for 4", "A great Friday night", "A night in october", "A night with @marcus", "A night, see https://x.io"]) {
      assert.ok(inventedFacts(v, ["great night"], "hard").length > 0, v);
    }
  });

  it("H7 'I' in mid-sentence is not a name", () => {
    assert.deepEqual(inventedFacts("A night I loved", ["great night"], "hard"), []);
  });

  it("H4 the city the traveller sent is ground for the generic caption", () => {
    assert.deepEqual(inventedFacts("Sunset over Da Nang", ["great night", "Da Nang"], "hard"), []);
  });

  it("H5 a generic caption through buildAiAssistedWriting drops a venue it was never given", async () => {
    model("Dinner at Nobu with Marcus\nA lovely evening out");
    const rows = await write(makeClient(state(true)), "post.caption", "great night", { city: "Da Nang" });
    assert.deepEqual(labels(rows), ["A lovely evening out"]);
  });

  it("H6 a non-caption context is not checked (G140's event text is out of this row's scope)", async () => {
    model("Join us at Nobu for a sunset meetup");
    const rows = await write(makeClient(state(true)), undefined, "sunset meetup", { context: "event_description" });
    assert.deepEqual(labels(rows), ["Join us at Nobu for a sunset meetup"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// R — the route's session context and the field ids
// ═══════════════════════════════════════════════════════════════════════════════

describe("R — what the route accepts", () => {
  it("R1 a uuid-shaped memoryId is kept; anything else is dropped; tripId/cityId are as before", () => {
    assert.deepEqual(parseSessionContext({ memoryId: MEM }), { memoryId: MEM });
    assert.equal(parseSessionContext({ memoryId: "x' or 1=1" }), undefined);
    assert.equal(parseSessionContext({ memoryId: 42 }), undefined);
    assert.equal(parseSessionContext({ memoryId: `${MEM}0` }), undefined);
    assert.deepEqual(parseSessionContext({ tripId: "t1", cityId: "c1" }), { tripId: "t1", cityId: "c1" });
    assert.equal(parseSessionContext({}), undefined);
  });

  it("R2 the two fields are the travel fields and post.caption is not", () => {
    assert.ok(isTravelWritingField("postcard.caption"));
    assert.ok(isTravelWritingField("memory.caption"));
    assert.ok(!isTravelWritingField("post.caption"));
    assert.ok(!isTravelWritingField(undefined));
  });

  it("R3 both resolve to the caption context's policy, which allows AI (no new InputContext — G19's 29 hold)", () => {
    for (const id of [POSTCARD, MEMORY]) {
      const p = resolvePolicy("caption", id)!;
      assert.equal(p.fieldId, id);
      assert.equal(p.context, "caption");
      assert.ok(p.allowAI && p.allowedSuggestionTypes.includes("ai_suggestion"));
      assert.equal(p.allowMemoryContext, false, "OD-INPUT-3: no Memory context on a caption");
    }
  });
});

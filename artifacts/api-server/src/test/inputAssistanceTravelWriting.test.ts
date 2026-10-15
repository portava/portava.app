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
import { buildAiAssistedWriting, COMPASS_AI_WRITING_FLAG, sanitizeSuggestedText } from "../lib/inputAssistance/aiWriting.js";
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

  it("M6 a memories read that THROWS (not an {error} result): no AI, the model is never called", async () => {
    const calls = model("What a great dinner tonight!");
    const sc = makeClient(state(true, { memory_resurfacing_preferences: [] }));
    const from = sc.from.bind(sc);
    (sc as any).from = (table: string) => {
      if (table !== "memories") return from(table);
      const b: any = { select() { return b; }, eq() { return b; }, maybeSingle() { return Promise.reject(new Error("socket hang up")); } };
      return b;
    };
    assert.deepEqual(await write(sc, MEMORY, "great dinner tonight", { memoryId: MEM }), []);
    assert.equal(calls.length, 0);
  });

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
      // fix round 1 (VERIFY-727): a month, a relation, ranking, agency, transit and the addressee
      "may", "with", "best", "better", "greatest", "greater", "most", "more", "made", "make", "out", "way", "up",
      "over", "through", "you", "your",
    ];
    assert.deepEqual(forbidden.filter((w) => CONNECTING_WORDS.has(w)), []);
  });

  it("a Thai caption the traveller wrote is kept verbatim, and refused when changed", () => {
    assert.deepEqual(inventedFacts("อาหารเย็นอร่อยมาก", ["อาหารเย็นอร่อยมาก"], "travel"), []);
    assert.ok(inventedFacts("อาหารเย็นที่ร้านโปรด", ["อาหารเย็นอร่อยมาก"], "travel").length > 0);
  });

  it("a Vietnamese caption is its own ground; words the traveller did not write are refused", () => {
    assert.deepEqual(inventedFacts("Bữa tối ở Hội An", ["bữa tối ở Hội An"], "travel"), []);
    assert.ok(inventedFacts("Bữa tối ở Hội An", ["bữa tối ngon"], "travel").length > 0);
    // Strict by design (fix round 1): a name the traveller wrote in lower case is not capitalised for them.
    assert.ok(inventedFacts("Bữa tối ở Hội An", ["bữa tối ở hội an"], "travel").some((f) => f.startsWith("name:")));
  });

  it("strict by design: ALL-CAPS in mid-sentence is judged as a name, and an emoji the traveller did not write is refused", () => {
    assert.ok(inventedFacts("GREAT dinner TONIGHT", seed, "travel").some((f) => f === "name:TONIGHT"));
    assert.ok(inventedFacts("\"Great dinner tonight\" 🍽️", seed, "travel").some((f) => f.startsWith("emoji:")));
    assert.deepEqual(inventedFacts("\"Great dinner tonight\" 🍽️", ["great dinner tonight 🍽️"], "travel"), [], "the traveller's own emoji is theirs");
  });

  it("a handle or link the traveller wrote may stay", () => {
    assert.deepEqual(inventedFacts("Great dinner with @marcus", ["great dinner with @marcus"], "travel"), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY-727 battery (fix round 1) — the verifier's 52 adversarial drafts, 20
// controls and 14 faithful polishes, copied here as data (as #720 did) so they
// run on every head. Before the fix: 52/52 adversarial SERVED. After: 0 served.
// ═══════════════════════════════════════════════════════════════════════════════

type BCase = [cls: string, ground: string, draft: string];
const B1 = "great dinner tonight";
const B2 = "ramen in Tokyo with Marcus and Jen, stuck in a traffic jam first";
const B3 = "table 18 at 8 pm, 2019 trip";
const B4 = "sushi and sake, we loved it";
const B5 = "walked a mile to the Ganges at dawn with Frances";
const B6 = "not the best ramen in Tokyo, honestly";

const V727_ADVERSARIAL: BCase[] = [
  // A. emoji facts
  ["A emoji flag (country)", B1, "Great dinner tonight 🇯🇵"],
  ["A emoji flags (two countries)", B1, "Great dinner tonight 🇻🇳🇹🇭"],
  ["A emoji dishes", B1, "Great dinner tonight 🍣🍶"],
  ["A emoji couple (relation)", B1, "Great dinner tonight 👫"],
  ["A emoji weather", B1, "Great dinner tonight 🌧️"],
  ["A emoji landmark", B1, "Great dinner tonight 🗼"],
  ["A emoji birthday", B1, "Great dinner tonight 🎂"],
  ["A emoji engagement ring", B1, "Great dinner tonight 💍"],
  // B. digit substrings / fusion
  ["B digit substring 1 of 18", B3, "Table 1 at 8 pm, so great"],
  ["B digit substring 19 of 2019", B3, "19 at the table, so great"],
  ["B digit substring 20 of 2019", B3, "Trip 20, so great"],
  ["B digits fused across whitespace", "day 1 2 beers", "12 beers, so great"],
  ["B ordinal substring 1st of 21st", "my 21st birthday dinner", "My 1st birthday dinner"],
  // C. number re-binding
  ["C count rebound to another noun", B3, "18 trips, so great"],
  ["C repetition count via times", "table 3 tonight", "3 times tonight, so great"],
  ["C count swap between two numbers", "2 beers, 10 of us", "10 beers for 2 of us"],
  // D. draft-side stems
  ["D Andes via and", B4, "Sushi and sake in the Andes"],
  ["D Wes via we", B4, "Sushi and sake with Wes"],
  ["D Ines via in", B2, "Ramen in Tokyo with Ines"],
  ["D James via jam", B2, "Ramen in Tokyo with James"],
  ["D Miles via mile", B5, "A mile with Miles"],
  ["D Ames via am", "I am so happy, great dinner", "Great dinner in Ames"],
  ["D Marcos from Marco", "dinner with Marco", "Dinner with Marcos"],
  ["D Jens from Jen", "dinner with Jen", "Dinner with Jens"],
  ["D Lucas from Luca", "lunch with Luca", "Lunch with Lucas"],
  // E. ground-side stems
  ["E France from Frances", B5, "France at dawn, so good"],
  ["E gang from Ganges", B5, "The gang at dawn"],
  ["E jam from James", "dinner with James", "Dinner with jam, so good"],
  ["E Jon from Jones", "dinner with Jones", "Dinner with Jon"],
  ["E Hugh from Hughes", "dinner with Hughes", "Dinner with Hugh"],
  ["E a mile from Miles", "dinner with Miles", "A mile of fun"],
  // F. the month May
  ["F May mid-sentence", B1, "Great dinner tonight in May"],
  ["F May opening", B1, "May. Great dinner tonight."],
  // G. relations through allowed words
  ["G with my love", B1, "Great dinner tonight with my love"],
  ["G with you", B1, "Great dinner tonight with you"],
  ["G with my favourite", B1, "Great dinner tonight with my favourite"],
  ["G with my sweet", B1, "Great dinner tonight with my sweet"],
  ["G with my everything", B1, "Great dinner tonight with my everything"],
  ["G with the best", B1, "Great dinner tonight with the best"],
  // H. superlative world-claims
  ["H the best ramen in Tokyo", "ramen in Tokyo", "The best ramen in Tokyo!"],
  ["H the greatest ramen in all of Tokyo", "ramen in Tokyo", "The greatest ramen in all of Tokyo"],
  // I. negation dropped / meaning inverted
  ["I negation dropped", B6, "The best ramen in Tokyo!"],
  ["I no sushi -> sushi", "no sushi tonight, just rice", "Sushi tonight!"],
  ["I wish -> fact", "wish I'd gone to Nobu", "At Nobu!"],
  ["I absent person made present", "dinner with Marcus, Jen couldn't come", "Dinner with Jen"],
  ["I who cooked", B1, "I made a great dinner tonight"],
  // J. invisible splitting
  ["J ZWSP-split To\\u200Bby", B1, "Great dinner tonight with To\u200Bby"],
  ["J ZWSP-split A\\u200Bmy", B1, "Great dinner tonight with A\u200Bmy"],
  ["J soft-hyphen-split A\\u00ADmy", B1, "Great dinner tonight with A\u00ADmy"],
  // K. caseless subword
  ["K CJK subword 北京 from 北京烤鸭", "北京烤鸭 was great", "北京 was great"],
  // L. transit
  ["L on the way", B1, "Great dinner tonight on the way"],
  ["L out and about", B1, "Great dinner tonight, out and about"],
];

const V727_CONTROLS: BCase[] = [
  ["lower-case city", B1, "great dinner tonight in tokyo"],
  ["transliterated city", B1, "great dinner tonight in toukyou"],
  ["UPPER city", B1, "Great dinner tonight in TOKYO"],
  ["fullwidth city", B1, "Great dinner tonight in Ｔｏｋｙｏ"],
  ["hashtag city", B1, "Great dinner tonight #tokyo"],
  ["wife", B1, "Great dinner tonight with my wife"],
  ["number word", B1, "Great dinner tonight for three"],
  ["digit", B1, "Great dinner tonight, 3 courses"],
  ["weekday", B1, "Great dinner tonight, Friday"],
  ["month", B1, "Great dinner tonight in March"],
  ["time", B1, "Great dinner tonight at 8pm"],
  ["price", B1, "Great dinner tonight, $40"],
  ["dish", B1, "Great dinner tonight, the pho"],
  ["weather", B1, "Great dinner tonight, so sunny"],
  ["Cyrillic", B1, "Great dinner tonight в Москве"],
  ["Thai not written", B1, "Great dinner tonight กรุงเทพ"],
  ["ordinal word", B1, "My first great dinner tonight"],
  ["we", B1, "We had a great dinner tonight"],
  ["together", B1, "Great dinner tonight together"],
  ["chef", B1, "Great dinner tonight, the chef"],
];

const V727_FAITHFUL: BCase[] = [
  ["exclamation", B1, "What a great dinner tonight!"],
  ["loved it", B1, "Great dinner tonight, loved it"],
  ["reorder", B1, "Tonight's dinner was so great"],
  ["such a", B1, "Such a great dinner tonight!"],
  ["unforgettable", B1, "Great dinner tonight — unforgettable"],
  ["so happy", B1, "Great dinner tonight. So happy."],
  ["I really loved", B1, "I really loved tonight's great dinner"],
  ["what a moment", B1, "Great dinner tonight, what a moment"],
  ["colon", B1, "Dinner tonight: great!"],
  ["own facts kept", "dinner with Marcus at Nobu on Friday", "Dinner with Marcus at Nobu on Friday — unforgettable!"],
  ["own emoji kept", "great dinner tonight 🍣", "Great dinner tonight 🍣"],
  ["own digits kept", B3, "Table 18 at 8 pm, the 2019 trip, so good"],
  ["own Thai kept", "อาหารเย็นอร่อยมาก", "อาหารเย็นอร่อยมาก!"],
  ["own hashtag kept", "great dinner #tokyo", "Great dinner #tokyo, loved it"],
];

describe("VERIFY-727 battery — 52 adversarial drafts, 20 controls, 14 faithful polishes (travel level)", () => {
  it("counts: every adversarial draft and every control refused, every faithful polish served", () => {
    const served = (c: BCase[]) => c.filter(([, g, dr]) => inventedFacts(dr, [g], "travel").length === 0).map(([cls]) => cls);
    assert.equal(V727_ADVERSARIAL.length, 52);
    assert.equal(V727_CONTROLS.length, 20);
    assert.equal(V727_FAITHFUL.length, 14);
    assert.deepEqual(served(V727_ADVERSARIAL), [], "adversarial drafts served");
    assert.deepEqual(served(V727_CONTROLS), [], "controls served");
    assert.deepEqual(served(V727_FAITHFUL), V727_FAITHFUL.map(([cls]) => cls), "faithful polishes refused");
  });
  for (const [cls, ground, draft] of V727_ADVERSARIAL) {
    it(`refuses ${cls}`, () => { assert.ok(inventedFacts(draft, [ground], "travel").length > 0, draft); });
  }
  for (const [cls, ground, draft] of V727_FAITHFUL) {
    it(`serves ${cls}`, () => { assert.deepEqual(inventedFacts(draft, [ground], "travel"), []); });
  }

  it("the same drafts end to end through buildAiAssistedWriting: none served for postcard.caption", async () => {
    const e2e: Array<[string, string]> = [
      ["great dinner tonight", "Great dinner tonight 🇯🇵🍣"],
      ["great dinner tonight", "Great dinner tonight with my love"],
      ["great dinner tonight", "Great dinner tonight in May"],
      ["sushi and sake, we loved it", "Sushi and sake in the Andes with Wes"],
      ["walked a mile to the Ganges at dawn with Frances", "France at dawn with the gang"],
      ["table 18 at 8 pm, 2019 trip", "Table 1 at 8 pm, 19 trips"],
      ["not the best ramen in Tokyo, honestly", "The best ramen in Tokyo!"],
      ["great dinner tonight", "Great dinner tonight with To\u200Bby"],
    ];
    for (const [ground, draft] of e2e) {
      model(draft);
      assert.deepEqual(labels(await write(makeClient(state(true)), POSTCARD, ground)), [], draft);
    }
  });
});

describe("fix round 1 — the closed holes, class by class (travel level)", () => {
  it("a number keeps a neighbour it had: own '8 pm' may be written '8pm' and back; a number moved to another noun is refused", () => {
    assert.deepEqual(inventedFacts("Dinner at 8pm, so good", ["dinner at 8 pm"], "travel"), []);
    assert.deepEqual(inventedFacts("Dinner at 8 pm, so good", ["dinner at 8pm"], "travel"), []);
    assert.ok(inventedFacts("8 dinners", ["dinner at 8 pm"], "travel").length > 0);
  });
  it("a capitalised word in mid-sentence must be capitalised in the traveller's words (a lower-case 'nice' is not the city)", () => {
    assert.ok(inventedFacts("Dinner in Nice", ["dinner in nice weather"], "travel").some((f) => f.startsWith("name:")));
    assert.deepEqual(inventedFacts("Dinner in Nice", ["dinner in Nice"], "travel"), []);
  });
  it("no plural is guessed (fix round 2: a plural passes only when the traveller wrote it); the draft word is never stemmed", () => {
    assert.ok(inventedFacts("Great dinners", ["great dinner"], "travel").some((f) => f === "word:dinners"), "the measured cost of the conservative option");
    assert.deepEqual(inventedFacts("Great dinners", ["great dinners"], "travel"), []);
    assert.ok(inventedFacts("Great dinners like tonight's", ["great dinner tonight"], "travel").length > 0);
    assert.ok(inventedFacts("Dinner with Jens", ["dinner with Jen"], "travel").length > 0);
    assert.ok(inventedFacts("Great beer", ["great beers"], "travel").length > 0, "no singular is guessed from the traveller's plural");
    assert.ok(inventedFacts("dinner with jens", ["dinner with Jen"], "travel").length > 0, "no plural is made from a name, even in lower case");
  });
  it("negation and wish: kept when written, refused when dropped or added", () => {
    assert.deepEqual(inventedFacts("Not the best ramen in Tokyo, honestly", ["not the best ramen in Tokyo, honestly"], "travel"), []);
    assert.ok(inventedFacts("Not a great dinner tonight", [B1], "travel").some((f) => f === "added:not"));
    assert.ok(inventedFacts("Dinner with Marcus", ["dinner with Marcus, Jen couldn't come"], "travel").some((f) => f === "dropped:not"));
  });
  it("any symbol, flag or invisible character the traveller did not write is refused, at both levels", () => {
    for (const lvl of ["travel", "hard"] as const) {
      assert.ok(inventedFacts("A great night 🇯🇵", ["great night"], lvl).some((f) => f.startsWith("emoji:")), lvl);
      assert.ok(inventedFacts("A great night €€€", ["great night"], lvl).some((f) => f.startsWith("symbol:")), lvl);
      assert.ok(inventedFacts("A great night\u2060", ["great night"], lvl).some((f) => f.startsWith("invisible:")), lvl);
    }
    assert.ok(inventedFacts("A great night \u0301\u0301", ["great night"], "travel").length > 0, "a combining mark standing alone is judged like a word");
    assert.deepEqual(inventedFacts("A great night 👨\u200D👩\u200D👧", ["great night 👨\u200D👩\u200D👧"], "travel"), [], "a ZWJ family the traveller wrote is theirs");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY-727 delta battery (fix round 2) — the verifier's 81 drafts aimed at the
// round-1 rules and 24 realistic faithful polishes, copied here AS DATA (never
// executing the verifier's script). Kinds as the verifier labelled them: BUG (a
// mechanical hole: 20 served before this round), EXPECT-REFUSED (33 controls),
// RESIDUAL (28 inside the named classes of census §46.7).
// ═══════════════════════════════════════════════════════════════════════════════

const V727D_ADVERSARIAL: Array<[cls: string, ground: string, draft: string, kind: "BUG" | "RESIDUAL" | "EXPECT-REFUSED"]> = [
  ["number keeps one neighbour, time flipped pm\u{2192}am via vocab \"am\"", "table 18 at 8 pm, 2019 trip", "Table 18 at 8 am, so great", "RESIDUAL"],
  ["two times swapped, each keeps \"at\"", "left at 6, back at 11", "Left at 11, back at 6", "RESIDUAL"],
  ["distance re-bound to a kept neighbour", "18 km from the hotel, took 2 hours", "Took 2 km from the hotel", "RESIDUAL"],
  ["ordinal \u{2192} cardinal via digit-run of mixed token (\"5th\"\u{2192}\"5\")", "the 5th day was the best", "The 5 days were the best", "BUG"],
  ["ordinal \u{2192} cardinal (\"21st\"\u{2192}\"21\")", "my 21st birthday dinner", "My 21 birthday dinners", "BUG"],
  ["decimal split: 4.5 stars \u{2192} 5 stars", "gave it 4.5 stars", "Gave it 5 stars", "BUG"],
  ["time split: 8:30 \u{2192} 30", "met at 8:30 by the gate", "Met 30 by the gate", "BUG"],
  ["thousands split: 1,000 yen \u{2192} 000 yen", "paid 1,000 yen for it", "Paid 000 yen for it", "BUG"],
  ["unit added via \"%\" (Po, unchecked)", "18 of us at the table", "18% of us at the table", "BUG"],
  ["qualifier added via \"+\" (Sm, unchecked)", "18 of us at the table", "18+ of us at the table", "BUG"],
  ["unit added \"km\" (control)", "walked 18 today", "Walked 18 km today", "EXPECT-REFUSED"],
  ["unit added \"\u{B0}C\" (So)", "it was 18 today", "It was 18\u{B0}C today", "EXPECT-REFUSED"],
  ["fullwidth digits for the traveller's number", "table 18 at 8 pm, 2019 trip", "Table \u{FF11}\u{FF18} at 8 pm", "EXPECT-REFUSED"],
  ["date as words", "great dinner tonight", "Great dinner tonight, the fifth", "EXPECT-REFUSED"],
  ["cardinal \u{2192} ordinal word", "5 of us tonight", "The fifth of us tonight", "EXPECT-REFUSED"],
  ["number arrow \"\u{2192}\"", "table 18 at 8 pm, 2019 trip", "Table 18 \u{2192} 8 pm", "RESIDUAL"],
  ["name made a common noun (person \u{2192} weather)", "dinner with Sunny", "A sunny dinner", "BUG"],
  ["name made a common noun (person \u{2192} city, lower case)", "dinner with Paris", "Dinner in paris", "BUG"],
  ["name made a common noun (person \u{2192} season)", "road trip with Autumn", "An autumn road trip", "BUG"],
  ["name made a common noun (person \u{2192} invoice)", "met Bill at the bar", "Met the bar bill", "BUG"],
  ["sentence-initial name from ground word (homograph)", "rose early for the sunrise", "Rose. Early for the sunrise.", "RESIDUAL"],
  ["sentence-initial vocab word as a name", "great dinner tonight", "Hope. Great dinner tonight.", "RESIDUAL"],
  ["mid-sentence capitalised plural of a ground word", "paid the bill, great dinner", "Great dinner with the Bills", "EXPECT-REFUSED"],
  ["sentence-initial plural homograph (\"Bills\")", "paid the bill, great dinner", "Bills. Great dinner.", "RESIDUAL"],
  ["title case of own words", "great dinner tonight", "Great Dinner Tonight", "EXPECT-REFUSED"],
  ["camel-case name hidden in lower case ground", "the mark on the wall", "The wall, Mark", "EXPECT-REFUSED"],
  ["ALL-CAPS name", "great dinner tonight", "Great dinner tonight, TOKYO", "EXPECT-REFUSED"],
  ["\"James\" from \"jam\"+\"es\" at sentence start", "ramen in Tokyo, stuck in a traffic jam first", "James loved the ramen in Tokyo", "BUG"],
  ["\"james\" from \"jam\"+\"es\" mid-sentence (lower)", "ramen in Tokyo, stuck in a traffic jam first", "Ramen in Tokyo and james", "BUG"],
  ["\"Ganges\" from \"gang\"+\"es\" at sentence start", "the gang at dawn", "Ganges at dawn, the gang", "BUG"],
  ["\"customs\" from \"custom\" (a border)", "the custom here is tea", "The customs here, tea", "RESIDUAL"],
  ["\"ruins\" from \"ruin\" (a site)", "the day was a ruin", "The ruins, the day", "RESIDUAL"],
  ["\"clothes\" from \"cloth\"+\"es\"", "a cloth on the table", "Clothes on the table", "RESIDUAL"],
  ["\"spirits\" from \"spirit\" (alcohol)", "the spirit of the city", "Spirits of the city", "RESIDUAL"],
  ["\"Canaries\" from \"canary\"+\"ies\" at sentence start", "a canary in the caf\u{E9}", "Canaries. A canary in the caf\u{E9}.", "RESIDUAL"],
  ["flag junction: \u{1F1F9}\u{1F1EF} (Tajikistan) from \u{1F1F5}\u{1F1F9}\u{1F1EF}\u{1F1F5}", "great dinner tonight \u{1F1F5}\u{1F1F9}\u{1F1EF}\u{1F1F5}", "Great dinner tonight \u{1F1F9}\u{1F1EF}", "BUG"],
  ["flag junction: \u{1F1F8}\u{1F1E6} (Saudi Arabia) from \u{1F1FA}\u{1F1F8}\u{1F1E6}\u{1F1FA}", "great dinner tonight \u{1F1FA}\u{1F1F8}\u{1F1E6}\u{1F1FA}", "Great dinner tonight \u{1F1F8}\u{1F1E6}", "BUG"],
  ["ZWJ family from three single emoji", "great dinner \u{1F468} and \u{1F469} and \u{1F467}", "Great dinner \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", "EXPECT-REFUSED"],
  ["ZWJ sub-sequence (mother+child from family)", "great dinner \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", "Great dinner \u{1F469}\u{200D}\u{1F467}", "RESIDUAL"],
  ["skin tone added to own emoji", "great dinner \u{1F44D}", "Great dinner \u{1F44D}\u{1F3FF}", "EXPECT-REFUSED"],
  ["keycap built from own digit", "table 1 tonight", "Table 1\u{FE0F}\u{20E3} tonight", "EXPECT-REFUSED"],
  ["combining mark on own word", "great dinner tonight", "Great dinner tonight\u{303}", "EXPECT-REFUSED"],
  ["lone combining mark", "great dinner tonight", "Great dinner tonight \u{303}", "EXPECT-REFUSED"],
  ["combining mark on own emoji", "great dinner \u{1F363}", "Great dinner \u{1F363}\u{301}", "EXPECT-REFUSED"],
  ["Cyrillic \u{430} in own word", "great dinner at Nobu", "Great dinner at N\u{43E}bu", "EXPECT-REFUSED"],
  ["Cyrillic \u{430} in vocab word", "great dinner tonight", "Gre\u{430}t dinner tonight", "EXPECT-REFUSED"],
  ["fullwidth letters of own word", "great dinner tonight", "Great dinner \u{FF54}\u{FF4F}\u{FF4E}\u{FF49}\u{FF47}\u{FF48}\u{FF54}", "EXPECT-REFUSED"],
  ["Greek capital in a name", "dinner with Marcus", "Dinner, \u{39C}arcus", "EXPECT-REFUSED"],
  ["CJK suffix on own token", "\u{5317}\u{4EAC}\u{70E4}\u{9E2D} was great", "\u{5317}\u{4EAC}\u{70E4}\u{9E2D}\u{5E97} was great", "EXPECT-REFUSED"],
  ["apostrophe-less \"cant\" \u{2192} \"can\"", "cant believe how good it was", "I can believe how good it was", "BUG"],
  ["apostrophe-less \"dont\" dropped", "dont go to Nobu, overrated", "Go to Nobu", "BUG"],
  ["\"wished\" dropped (wish rule names only \"wish\")", "wished I'd gone to Nobu", "Gone to Nobu!", "BUG"],
  ["\"wishing\" dropped", "wishing I was at Nobu", "At Nobu!", "BUG"],
  ["negation moved between clauses", "the ramen was not bad, the view was great", "The ramen was great, the view was not bad", "RESIDUAL"],
  ["one of two negations dropped", "not bad, not great", "Not great", "RESIDUAL"],
  ["absence verb \"missed\" dropped", "missed the sunset at Fuji", "The sunset at Fuji, so lovely", "RESIDUAL"],
  ["absence \"was closed\" dropped", "Nobu was closed, sadly", "Nobu!", "RESIDUAL"],
  ["\"cancelled\" dropped", "cancelled the trip to Hakone", "The trip to Hakone!", "RESIDUAL"],
  ["\"tried to\" dropped", "tried to see Fuji, too cloudy", "Fuji!", "RESIDUAL"],
  ["French negation dropped (non-English)", "pas le meilleur ramen de Tokyo", "Le meilleur ramen de Tokyo", "RESIDUAL"],
  ["German negation dropped (non-English)", "nicht das beste Ramen in Tokyo", "Das beste Ramen in Tokyo", "RESIDUAL"],
  ["\"no\" kept but scope inverted", "no rain, great hike", "No great hike, rain", "RESIDUAL"],
  ["\"cannot\" \u{2192} \"can\" (control)", "cannot wait to go back", "Can wait to go back", "EXPECT-REFUSED"],
  ["\"couldn't\" dropped (control)", "Jen couldn't come", "Jen came", "EXPECT-REFUSED"],
  ["hashtag built from own word", "great dinner tonight", "Great dinner #tonight", "EXPECT-REFUSED"],
  ["mention built from own name", "dinner with Marcus", "Dinner with @marcus", "EXPECT-REFUSED"],
  ["URL built from own name", "dinner at Nobu", "Dinner at www.nobu.com", "EXPECT-REFUSED"],
  ["bare domain from own words", "dinner at Nobu, the com was down", "Dinner at nobu.com", "RESIDUAL"],
  ["own hashtag re-cased", "great dinner #Tokyo", "Great dinner #tokyo", "RESIDUAL"],
  ["\", my everything\" (named residual)", "great dinner tonight", "Great dinner tonight, my everything", "RESIDUAL"],
  ["\", my sweet\" (named residual)", "great dinner tonight", "Great dinner tonight, my sweet", "RESIDUAL"],
  ["\"for you\" (addressee, \"you\" dropped)", "great dinner tonight", "Great dinner tonight for you", "EXPECT-REFUSED"],
  ["\"for us\"", "great dinner tonight", "Great dinner tonight for us", "EXPECT-REFUSED"],
  ["\"for me\"", "great dinner tonight", "Great dinner tonight for me", "RESIDUAL"],
  ["\"and Jen\" re-related (Jen couldn't come \u{2192} with)", "dinner with Marcus, Jen couldn't come", "Dinner with Jen, Marcus couldn't come", "RESIDUAL"],
  ["word joiner U+2060 inside name", "great dinner tonight", "Great dinner tonight, To\u{2060}by", "EXPECT-REFUSED"],
  ["ZWNJ inside name", "great dinner tonight", "Great dinner tonight, To\u{200C}by", "EXPECT-REFUSED"],
  ["ZWJ outside emoji", "great dinner tonight", "Great dinner tonight, To\u{200D}by", "EXPECT-REFUSED"],
  ["BOM/ZWNBSP", "great dinner tonight", "Great dinner tonight\u{FEFF} Toby", "EXPECT-REFUSED"],
  ["apostrophe-joined smuggle", "great dinner tonight", "Great dinner tonight, to'by", "EXPECT-REFUSED"],
  ["hyphen-joined smuggle", "great dinner tonight", "Great dinner tonight, so-toby", "EXPECT-REFUSED"],
];
const V727D_FAITHFUL: Array<[cls: string, ground: string, draft: string]> = [
  ["typo fix in a vocab word", "grate dinner tonight", "Great dinner tonight"],
  ["typo fix in a content word (\"tonite\")", "great dinner tonite", "Great dinner tonight"],
  ["capitalise a city the traveller typed lower-case", "amazing sushi in tokyo", "Amazing sushi in Tokyo"],
  ["capitalise a person's name typed lower-case", "dinner with marcus", "Dinner with Marcus"],
  ["capitalise a venue + city", "dinner at nobu tokyo", "Dinner at Nobu, Tokyo"],
  ["punctuation + dash", "great dinner tonight loved it", "Great dinner tonight \u{2014} loved it!"],
  ["contraction I am \u{2192} I'm", "I am so happy tonight", "I'm so happy tonight"],
  ["contraction it is \u{2192} it's", "it is great here", "It's great here"],
  ["contraction cannot \u{2192} can't", "cannot wait to come back", "Can't wait to come back"],
  ["contraction do not \u{2192} don't", "do not want to leave", "Don't want to leave"],
  ["add apostrophe cant \u{2192} can't", "cant stop thinking about this place", "Can't stop thinking about this place"],
  ["its \u{2192} it's", "its so good", "It's so good"],
  ["shouting lowered", "GREAT DINNER TONIGHT", "Great dinner tonight!"],
  ["expand w/ \u{2192} with", "dinner w/ the gang", "Dinner with the gang"],
  ["sooo \u{2192} so", "sooo good", "So good!"],
  ["own superlative kept", "best ramen ever", "Best ramen ever!"],
  ["comma added between numbers", "2 beers 10 of us", "2 beers, 10 of us"],
  ["space in unit", "walked 18km today", "Walked 18 km today"],
  ["sentence-start capital of own first word", "day 1 in tokyo", "Day 1 in tokyo!"],
  ["emoji the traveller wrote kept, \"what a\"", "lovely evening \u{1F305}", "What a lovely evening \u{1F305}"],
  ["first person capitalised", "i love this city", "I love this city!"],
  ["own past tense kept", "finally made it to the top", "Finally made it to the top!"],
  ["reorder with colon removed", "tonight: great dinner", "Great dinner tonight"],
  ["so so \u{2192} so, so", "so so good", "So, so good"],
];


/** The RESIDUAL drafts still served — each inside a class census §46.7 names. Pinned both ways. 11 after round 2; 10 after round 3 ("Hope." is refused once "hope" is counted). */
const V727D_RESIDUAL_SERVED = [
  "two times swapped, each keeps \"at\"",
  "sentence-initial name from ground word (homograph)",
  "negation moved between clauses",
  "French negation dropped (non-English)",
  "German negation dropped (non-English)",
  "\"no\" kept but scope inverted",
  "\", my everything\" (named residual)",
  "\", my sweet\" (named residual)",
  "\"for me\"",
  "\"and Jen\" re-related (Jen couldn't come \u{2192} with)",
];

/** The 5 of 24 realistic faithful polishes refused after round 2, each with its cause (census §46.7, Q-G141-6). */
const V727D_FAITHFUL_REFUSED = [
  "typo fix in a content word (\"tonite\")", // by construction: "tonight" is not a word the traveller wrote
  "capitalise a city the traveller typed lower-case", // Q-G141-6: the mid-sentence name rule
  "capitalise a person's name typed lower-case", // Q-G141-6
  "capitalise a venue + city", // Q-G141-6
  "expand w/ \u{2192} with", // `with` left the vocabulary in round 1 (relations)
];

describe("VERIFY-727 delta battery — 81 drafts aimed at round 1, 24 realistic polishes (travel level)", () => {
  const verdict = (g: string, d: string) => {
    const clean = sanitizeSuggestedText(d);
    return clean ? inventedFacts(clean, [g], "travel") : ["sanitized-away"];
  };
  const servedOf = (kind: string) => V727D_ADVERSARIAL.filter(([, g, d, k]) => k === kind && verdict(g, d).length === 0).map(([c]) => c);

  it("counts: 0/20 BUG served, 0/33 controls served, 10/28 residuals served (each named); 19/24 faithful served", () => {
    assert.equal(V727D_ADVERSARIAL.length, 81);
    assert.equal(V727D_FAITHFUL.length, 24);
    assert.deepEqual(servedOf("BUG"), []);
    assert.deepEqual(servedOf("EXPECT-REFUSED"), []);
    assert.deepEqual(servedOf("RESIDUAL").sort(), [...V727D_RESIDUAL_SERVED].sort());
    const refused = V727D_FAITHFUL.filter(([, g, d]) => verdict(g, d).length > 0).map(([c]) => c);
    assert.deepEqual(refused.sort(), [...V727D_FAITHFUL_REFUSED].sort(), "the faithful-polish refusals and their causes");
  });
  for (const [cls, ground, draft, kind] of V727D_ADVERSARIAL.filter(([, , , k]) => k !== "RESIDUAL")) {
    it(`refuses [${kind}] ${cls}`, () => { assert.ok(verdict(ground, draft).length > 0, draft); });
  }

  it("the served round-1 drafts end to end through buildAiAssistedWriting: none served, on both fields", async () => {
    const e2e: Array<[string, string]> = [
      ["the 5th day was the best", "The 5 days were the best"],
      ["gave it 4.5 stars", "Gave it 5 stars"],
      ["18 of us at the table", "18% of us at the table"],
      ["dinner with Sunny", "A sunny dinner"],
      ["dinner with Paris", "Dinner in paris"],
      ["ramen in Tokyo, stuck in a traffic jam first", "James loved the ramen in Tokyo"],
      ["great dinner tonight \u{1F1F5}\u{1F1F9}\u{1F1EF}\u{1F1F5}", "Great dinner tonight \u{1F1F9}\u{1F1EF}"],
      ["cant believe how good it was", "I can believe how good it was"],
      ["wished I'd gone to Nobu", "Gone to Nobu!"],
      ["table 18 at 8 pm, 2019 trip", "Table 18 at 8 am, so great"],
    ];
    for (const fieldId of [POSTCARD, MEMORY]) {
      for (const [ground, draft] of e2e) {
        model(draft);
        assert.deepEqual(labels(await write(makeClient(state(true)), fieldId, ground)), [], `${fieldId}: ${draft}`);
      }
    }
  });
});

describe("fix round 2 — the rules, one at a time (travel level)", () => {
  it("a number is the whole numeric token: 4.5, 8:30, 1,000 kept whole; a piece of one is refused", () => {
    assert.deepEqual(inventedFacts("Gave it 4.5 stars!", ["gave it 4.5 stars"], "travel"), []);
    assert.deepEqual(inventedFacts("Met at 8:30 by the gate", ["met at 8:30 by the gate"], "travel"), []);
    assert.ok(inventedFacts("Met at 30 by the gate", ["met at 8:30 by the gate"], "travel").some((f) => f === "number:30"));
    assert.ok(inventedFacts("Paid 1 yen for it", ["paid 1,000 yen for it"], "travel").some((f) => f === "number:1"));
  });
  it("the letters of a mixed token are its mandatory neighbour: 8pm → 8 pm, never 8 days; 5th → never 5 days", () => {
    assert.deepEqual(inventedFacts("Dinner at 8 pm", ["dinner at 8pm"], "travel"), []);
    assert.ok(inventedFacts("Dinner, 8 days", ["dinner at 8pm"], "travel").some((f) => f === "number:8"));
    assert.ok(inventedFacts("The 5 days were the best", ["the 5th day was the best"], "travel").some((f) => f === "number:5"));
    assert.ok(inventedFacts("The 5 is the best", ["the 5th day was the best"], "travel").some((f) => f === "number:5"), "the neighbour outside the token ('the') does not stand in for its letters");
    assert.deepEqual(inventedFacts("The 5 th day, the best", ["the 5th day was the best"], "travel"), [], "keeping its letters, split, is the same number");
    assert.ok(inventedFacts("Gate 12 at 9", ["gate b12 at 9"], "travel").some((f) => f === "number:12"), "letters BEFORE the digits are mandatory too: B12 is not 12");
    assert.ok(inventedFacts("18% of us", ["100% great, 18 of us"], "travel").some((f) => f === "number:18%"), "a % stays part of its number: the traveller's other % does not make 18 into 18%");
  });
  it("am/pm and units stay: 8 pm never 8 am; 2 hours never 2 km", () => {
    assert.deepEqual(inventedFacts("Table 18 at 8 pm", ["table 18 at 8 pm"], "travel"), []);
    assert.ok(inventedFacts("Table 18 at 8 am", ["table 18 at 8 pm"], "travel").some((f) => f === "number:8"));
    assert.ok(inventedFacts("Took 2 km from the hotel", ["18 km from the hotel, took 2 hours"], "travel").some((f) => f === "number:2"));
    assert.deepEqual(inventedFacts("Took 2 hours, 18 km from the hotel", ["18 km from the hotel, took 2 hours"], "travel"), []);
  });
  it("each emoji is one of the traveller's own as a whole: no flag across a junction, no part of a family", () => {
    assert.ok(inventedFacts("Great \u{1F1F8}\u{1F1E6}", ["great \u{1F1FA}\u{1F1F8}\u{1F1E6}\u{1F1FA}"], "travel").some((f) => f.startsWith("emoji:")));
    assert.deepEqual(inventedFacts("Great \u{1F1FA}\u{1F1F8}", ["great \u{1F1FA}\u{1F1F8}\u{1F1E6}\u{1F1FA}"], "travel"), []);
    assert.ok(inventedFacts("Great dinner \u{1F469}\u{200D}\u{1F467}", ["great dinner \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"], "travel").some((f) => f.startsWith("emoji:")));
    assert.deepEqual(inventedFacts("Great \u{1F37D}", ["great \u{1F37D}\u{FE0F}"], "travel"), [], "a presentation selector is not a different emoji");
  });
  it("any symbol the traveller did not write: % + \u{2192} = ° $ — and a bare domain built from their words", () => {
    for (const d of ["18% of us", "18+ of us", "Table 18 \u{2192} 8 pm", "18 = us", "18\u{00B0} today", "$18 tonight"]) {
      assert.ok(inventedFacts(d, ["table 18 at 8 pm, 18 of us, us today, tonight"], "travel").length > 0, d);
    }
    assert.ok(inventedFacts("Dinner at nobu.com", ["dinner at Nobu, the com was down"], "travel").some((f) => f.startsWith("link:")));
  });
  it("a word the traveller capitalised in mid-sentence is a name: never a lower-case word; it may open a sentence", () => {
    assert.ok(inventedFacts("A sunny dinner", ["dinner with Sunny"], "travel").some((f) => f === "word:sunny"));
    assert.deepEqual(inventedFacts("Sunny loved dinner", ["dinner with Sunny"], "travel"), []);
    assert.deepEqual(inventedFacts("Great dinner tonight!", ["GREAT DINNER TONIGHT"], "travel"), [], "shouting is not a name");
  });
  it("negation, absence and wish are counted, in any spelling: cant = can't = cannot; none dropped, none added", () => {
    assert.deepEqual(inventedFacts("Can't wait to come back", ["cannot wait to come back"], "travel"), []);
    assert.deepEqual(inventedFacts("Can't stop thinking about it", ["cant stop thinking about it"], "travel"), []);
    assert.ok(inventedFacts("Not great", ["not bad, not great"], "travel").some((f) => f === "dropped:not"), "one of two dropped");
    assert.ok(inventedFacts("The sunset at Fuji, so lovely", ["missed the sunset at Fuji"], "travel").some((f) => f === "dropped:miss"));
    assert.ok(inventedFacts("Nobu!", ["Nobu was closed, sadly"], "travel").some((f) => f === "dropped:close"));
    assert.ok(inventedFacts("The trip to Hakone!", ["cancelled the trip to Hakone"], "travel").some((f) => f === "dropped:cancel"));
    assert.ok(inventedFacts("Fuji!", ["tried to see Fuji, too cloudy"], "travel").some((f) => f === "dropped:try"));
    assert.ok(inventedFacts("Gone to Nobu!", ["wished I'd gone to Nobu"], "travel").some((f) => f === "dropped:wish"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY-727 delta-2 battery (fix round 3, LR-B58-8) — the verifier's 85 drafts
// aimed at the round-2 rules, 20 fresh faithful polishes, 4 faithful-cost probes
// and 28 end-to-end drafts, copied here AS DATA (never executing its script).
// Kinds as the verifier labelled them: BUG (24 — 22 served before this round),
// EXPECT-REFUSED (35), RESIDUAL (7, inside a class §46.7 named before round 3),
// UNNAMED (19, design residuals §46.7 did not name before round 3).
// ═══════════════════════════════════════════════════════════════════════════════

const V727D2_ADVERSARIAL: Array<[cls: string, ground: string, draft: string, kind: "BUG" | "RESIDUAL" | "UNNAMED" | "EXPECT-REFUSED"]> = [
  ["un- prefix dropped, vocab antonym (unhappy\u{2192}happy)", "unhappy with the ramen", "Happy with the ramen", "UNNAMED"],
  ["vocab antonym of a ground word (forgettable\u{2192}unforgettable)", "a forgettable dinner", "An unforgettable dinner", "UNNAMED"],
  ["dis- prefix dropped (disliked\u{2192}liked)", "disliked the ramen", "Liked the ramen", "UNNAMED"],
  ["negative verb dropped, vocab praise added (hated\u{2192}loved)", "hated the ramen, loved the view", "Loved the ramen, loved the view", "UNNAMED"],
  ["double negation via prefix inverted (didn't dislike\u{2192}didn't like)", "didn't dislike it", "Didn't like it", "UNNAMED"],
  ["inflection of a counted key: trying (tried is counted)", "trying to see Fuji, too cloudy", "Fuji, so lovely", "BUG"],
  ["inflection of a counted key: skipping (skipped is counted)", "skipping Nobu tonight", "Nobu tonight!", "BUG"],
  ["inflection of a counted key: missing (missed is counted)", "missing the sunset at Fuji", "The sunset at Fuji!", "BUG"],
  ["inflection of a counted key: closes (closed is counted)", "Nobu closes early, sadly", "Nobu!", "BUG"],
  ["inflection of a counted key: cancelling (cancelled is counted)", "cancelling the Hakone trip", "The Hakone trip!", "BUG"],
  ["inflection of a counted key: losing (lost is counted)", "losing the gang at dawn", "The gang at dawn", "BUG"],
  ["absence word outside the list: postponed", "postponed the Hakone trip", "The Hakone trip!", "UNNAMED"],
  ["absence word outside the list: delayed", "the Hakone trip was delayed", "The Hakone trip!", "UNNAMED"],
  ["absence word outside the list: sold out", "Nobu was sold out", "Nobu!", "UNNAMED"],
  ["absence word outside the list: shut", "Nobu was shut", "Nobu!", "UNNAMED"],
  ["absence word outside the list: forgot", "forgot to see Fuji", "Fuji!", "UNNAMED"],
  ["absence word outside the list: hoped (hope is vocab, uncounted)", "hoped to see Fuji, too cloudy", "Fuji, so lovely", "UNNAMED"],
  ["apostrophe-less contraction the key misses: mightnt", "mightnt go back", "Go back!", "BUG"],
  ["apostrophe-less contraction the key misses: shant", "shant go back", "Go back!", "BUG"],
  ["acute accent as apostrophe (U+00B4) in the ground: can\u{B4}t \u{2192} can", "can\u{B4}t believe how good it was", "I can believe how good it was", "BUG"],
  ["modifier-letter apostrophe (U+02BC) in the ground: can\u{2BC}t \u{2192} can", "can\u{2BC}t believe how good it was", "I can believe how good it was", "BUG"],
  ["double negation cancelled (not bad \u{2192} good)", "not bad at all", "Good at all", "EXPECT-REFUSED"],
  ["two nots dropping to one", "it wasn't not fun", "It wasn't fun", "EXPECT-REFUSED"],
  ["a cancelling pair added (not not)", "great dinner tonight", "Not not a great dinner tonight", "EXPECT-REFUSED"],
  ["never dropped, ever kept", "never going back to Nobu", "Ever going back to Nobu", "EXPECT-REFUSED"],
  ["without dropped", "dinner without Marcus", "Dinner, Marcus", "EXPECT-REFUSED"],
  ["barely dropped", "barely slept in Tokyo", "Slept in Tokyo", "EXPECT-REFUSED"],
  ["nobody dropped", "nobody came to dinner", "Came to dinner", "EXPECT-REFUSED"],
  ["digit \u{2192} number word", "table for 8", "Table for eight", "EXPECT-REFUSED"],
  ["time as words", "dinner at 8 pm", "Dinner at eight pm", "EXPECT-REFUSED"],
  ["ordinal as a word", "the 5th day", "The fifth day", "EXPECT-REFUSED"],
  ["number word \u{2192} digit", "eight of us tonight", "8 of us tonight", "EXPECT-REFUSED"],
  ["ordinal word \u{2192} digit ordinal", "first time in Tokyo", "1st time in Tokyo", "EXPECT-REFUSED"],
  ["a time gains am from the VOCABULARY (am is a vocab auxiliary and a NUMBER_UNIT)", "dinner at 2, loved it", "Dinner at 2 am, loved it", "BUG"],
  ["a count gains a unit from the VOCABULARY (times is vocab and a NUMBER_UNIT)", "went for dinner, 2 of us", "Went for dinner 2 times", "BUG"],
  ["currency sign moved to another of their numbers", "paid $18 for 2 bowls", "Paid 18 for $2 bowls", "BUG"],
  ["currency sign moved (2)", "paid $18, table for 2", "Paid 18, table for $2", "BUG"],
  ["/ between two of their numbers makes a date", "room 12, 3 of us", "Room 12/3", "BUG"],
  ["- between two of their numbers makes a range", "room 12, 3 of us", "Room 12-3", "BUG"],
  ["hyphen before a number makes it negative", "we were 5 at dinner, so cold", "We were -5 at dinner, so cold", "BUG"],
  ["en dash before a number", "we were 5 at dinner, so cold", "We were \u{2013}5 at dinner, so cold", "BUG"],
  ["* after a number (a rating)", "dinner for 5", "Dinner for 5*", "BUG"],
  ["keycap from their digit", "day 1 in tokyo", "Day 1\u{FE0F}\u{20E3} in tokyo", "EXPECT-REFUSED"],
  ["superscript digit", "table for 5", "Table for \u{2075}", "EXPECT-REFUSED"],
  ["vulgar fraction", "gave it 2.5 stars", "Gave it 2 \u{BD} stars", "EXPECT-REFUSED"],
  ["unit spelled out from %", "18% of us", "18 percent of us", "EXPECT-REFUSED"],
  ["unit changed (day \u{2192} night) after an ordinal", "the 5th day", "The 5th night", "EXPECT-REFUSED"],
  ["roman numeral for their digit", "day 2 in tokyo", "Day II in tokyo", "EXPECT-REFUSED"],
  ["dagger after a name (deceased)", "dinner with Marcus", "Dinner with Marcus \u{2020}", "BUG"],
  ["ampersand between two names (= and)", "Marcus, Sunny at dinner", "Marcus & Sunny at dinner", "RESIDUAL"],
  ["star symbol (So) control", "great dinner tonight", "Great dinner tonight \u{2605}", "EXPECT-REFUSED"],
  ["heart symbol between names (So) control", "Marcus, Sunny at dinner", "Marcus \u{2665} Sunny at dinner", "EXPECT-REFUSED"],
  ["skin tone added to their emoji", "great dinner \u{1F44D}", "Great dinner \u{1F44D}\u{1F3FF}", "EXPECT-REFUSED"],
  ["skin tone removed from their emoji", "great dinner \u{1F44D}\u{1F3FF}", "Great dinner \u{1F44D}", "EXPECT-REFUSED"],
  ["ZWJ sequence built from two of their emoji", "dinner \u{1F468} \u{1F373}", "Dinner \u{1F468}\u{200D}\u{1F373}", "EXPECT-REFUSED"],
  ["sub-sequence of their family emoji", "dinner \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", "Dinner \u{1F469}\u{200D}\u{1F467}", "EXPECT-REFUSED"],
  ["flag from the junction of two flags (fresh pair)", "trip \u{1F1EB}\u{1F1EE}\u{1F1F7}\u{1F1FA}", "Trip \u{1F1EE}\u{1F1F7}", "EXPECT-REFUSED"],
  ["gender ZWJ added to their emoji", "surf day \u{1F3C4}", "Surf day \u{1F3C4}\u{200D}\u{2640}\u{FE0F}", "EXPECT-REFUSED"],
  ["single regional indicator from their flag", "trip \u{1F1EF}\u{1F1F5}", "Trip \u{1F1EF}", "EXPECT-REFUSED"],
  ["emoji modifier on its own", "great dinner \u{1F44D}", "Great dinner \u{1F3FF}", "EXPECT-REFUSED"],
  ["tag-sequence flag from their black flag", "trip \u{1F3F4}", "Trip \u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", "EXPECT-REFUSED"],
  ["sentence-initial ground name re-used lower-case mid-sentence", "Sunny came to dinner", "Came to a sunny dinner", "RESIDUAL"],
  ["ALL-CAPS ground name lower-cased into a word", "dinner with SUNNY", "A sunny dinner", "UNNAMED"],
  ["ALL-CAPS ground place lower-cased into a word", "dinner in NICE", "A nice dinner", "UNNAMED"],
  ["their name opening a sentence reads as a word", "dinner with Sunny", "Sunny dinner tonight", "RESIDUAL"],
  ["their lower-case word opening a sentence reads as a place", "nice weather today", "Nice. Weather today.", "RESIDUAL"],
  ["two lower-case words joined into a place", "pizza in new york", "Pizza in New York", "EXPECT-REFUSED"],
  ["half-capitalised place", "pizza in new york", "Pizza in New york", "EXPECT-REFUSED"],
  ["their words attributed to a person as speech", "dinner with Marcus, so good", "Marcus: \"so good\"", "RESIDUAL"],
  ["speech verb added", "dinner with Marcus, so good", "\"So good,\" said Marcus", "EXPECT-REFUSED"],
  ["possessive relation from vocab (my Marcus)", "dinner with Marcus", "My Marcus at dinner", "RESIDUAL"],
  ["relationship claim from vocab (the love of my life)", "dinner with Marcus", "Marcus, the love of my life", "RESIDUAL"],
  ["their name lower-cased at sentence start", "dinner with Sunny", "sunny dinner tonight", "EXPECT-REFUSED"],
  ["prefix of their handle is another account", "dinner with @marcusk", "Dinner with @marcus", "BUG"],
  ["prefix of their hashtag is another tag", "ramen #tokyofood", "Ramen #tokyo", "BUG"],
  ["prefix of their domain is another domain", "book at nobu.com.au", "Book at nobu.com", "BUG"],
  ["a domain built from their capitalised words (DOMAIN_RE is case-sensitive)", "ramen at Nobu, Tokyo", "Ramen at Nobu.Tokyo", "BUG"],
  ["hashtag extended (control)", "ramen #tokyo", "Ramen #tokyofood", "EXPECT-REFUSED"],
  ["domain from a bare word (control)", "ramen at nobu", "Ramen at nobu.com", "EXPECT-REFUSED"],
  ["counterfactual (would have) \u{2014} an added wish", "ramen at Ichiran", "Would have loved ramen at Ichiran", "UNNAMED"],
  ["future (I'll) \u{2014} the event has not happened", "ramen at Ichiran", "I'll have ramen at Ichiran", "UNNAMED"],
  ["if only \u{2014} an added wish", "ramen at Ichiran tonight", "If only I'd had ramen at Ichiran tonight", "UNNAMED"],
  ["wanted (vocab, uncounted) dropped like a wish", "wanted to see Fuji, too cloudy", "Fuji, so lovely", "UNNAMED"],
  ["frequency from a vocab quantifier (every night)", "night at Nobu", "Every night at Nobu", "UNNAMED"],
  ["comparison from vocab (as \u{2026} as)", "ramen in Tokyo and Paris", "Tokyo ramen, as lovely as Paris", "UNNAMED"],
];
const V727D2_FAITHFUL: Array<[cls: string, ground: string, draft: string]> = [
  ["dash + exclamation", "sunset at the beach, so pretty", "Sunset at the beach \u{2014} so pretty!"],
  ["apostrophe added, own capitalised city kept", "cant wait to come back to Tokyo", "Can't wait to come back to Tokyo!"],
  ["own names + \"with\" kept, feeling added", "lunch with Marcus and Jen", "Lunch with Marcus and Jen, loved it"],
  ["own superlative at sentence start", "best ramen ever at Ichiran", "Best ramen ever at Ichiran!"],
  ["its \u{2192} it's with own \"we are\"", "its raining but we are happy", "It's raining, but we are happy"],
  ["day number + two-word city", "day 3 in Da Nang", "Day 3 in Da Nang!"],
  ["clock time kept", "dinner at 7:30 with the gang", "Dinner at 7:30 with the gang!"],
  ["thousands separator kept", "walked 10,000 steps today", "Walked 10,000 steps today!"],
  ["own negation kept with a dash", "3 days in Kyoto, not enough", "3 days in Kyoto \u{2014} not enough!"],
  ["never kept", "never want to leave this place", "Never want to leave this place"],
  ["sooo \u{2192} so, comma", "sooo tired after the hike but worth it", "So tired after the hike, but worth it!"],
  ["abbreviated mountain name kept", "finally saw Mt Fuji", "Finally saw Mt Fuji!"],
  ["own \"first\" + emoji kept", "first sunset in Bali \u{1F305}", "First sunset in Bali \u{1F305}"],
  ["8am \u{2192} 8 am", "coffee at 8am then the beach", "Coffee at 8 am, then the beach"],
  ["didnt \u{2192} didn't, own \"we\"", "we didnt want to leave", "We didn't want to leave"],
  ["own \"made\"/\"best\" kept", "Marcus made the best pasta", "Marcus made the best pasta!"],
  ["i \u{2192} I, miss kept", "i miss this place already", "I miss this place already"],
  ["\"for 2\" kept, praise added", "dinner for 2 at Nobu tonight", "Dinner for 2 at Nobu tonight, so good"],
  ["two-word landmark kept", "what a view from the top of Tokyo Tower", "What a view from the top of Tokyo Tower!"],
  ["percent token kept", "night market in Taipei, 100% worth it", "Night market in Taipei \u{2014} 100% worth it!"],
];
const V727D2_COST_PROBES: Array<[cls: string, ground: string, draft: string]> = [
  ["nobody \u{2192} no one", "nobody wanted to leave", "No one wanted to leave"],
  ["1000 \u{2192} 1,000", "1000 yen ramen, so good", "1,000 yen ramen, so good"],
  ["hours \u{2192} hrs", "2 hours at the museum", "2 hrs at the museum"],
  ["shouted name re-cased", "dinner with SUNNY", "Dinner with Sunny"],
];
const V727D2_E2E: Array<[ground: string, draft: string]> = [
  ["trying to see Fuji, too cloudy", "Fuji, so lovely"],
  ["skipping Nobu tonight", "Nobu tonight!"],
  ["missing the sunset at Fuji", "The sunset at Fuji!"],
  ["Nobu closes early, sadly", "Nobu!"],
  ["cancelling the Hakone trip", "The Hakone trip!"],
  ["losing the gang at dawn", "The gang at dawn"],
  ["mightnt go back", "Go back!"],
  ["shant go back", "Go back!"],
  ["can\u{B4}t believe how good it was", "I can believe how good it was"],
  ["can\u{2BC}t believe how good it was", "I can believe how good it was"],
  ["dinner at 2, loved it", "Dinner at 2 am, loved it"],
  ["went for dinner, 2 of us", "Went for dinner 2 times"],
  ["paid $18 for 2 bowls", "Paid 18 for $2 bowls"],
  ["paid $18, table for 2", "Paid 18, table for $2"],
  ["paid \u{A5}1,800 for 2 bowls", "Paid 1,800 for \u{A5}2 bowls"],
  ["room 12, 3 of us", "Room 12/3"],
  ["room 12, 3 of us", "Room 12-3"],
  ["table 18, 2019 trip", "Table 18/2019 trip"],
  ["we were 5 at dinner, so cold", "We were -5 at dinner, so cold"],
  ["we were 5 at dinner, so cold", "We were \u{2013}5 at dinner, so cold"],
  ["dinner for 5", "Dinner for 5*"],
  ["dinner with Marcus", "Dinner with Marcus \u{2020}"],
  ["dinner with Marcus", "Dinner with Marcus \u{2021}"],
  ["book at nobu.com.au", "Book at nobu.com"],
  ["ramen at Nobu, Tokyo", "Ramen at Nobu.Tokyo"],
  ["dinner with @marcus_k", "Dinner with @marcus"],
  ["dinner with @marcus.k", "Dinner with @marcus"],
  ["ramen #tokyo_food", "Ramen #tokyo"],
];


/** Served after round 3, each NAMED in census §46.7 (pinned both ways): 6 of 7 RESIDUAL, 6 of 19 UNNAMED. */
const V727D2_SERVED = [
  "ampersand between two names (= and)",
  "sentence-initial ground name re-used lower-case mid-sentence",
  "their lower-case word opening a sentence reads as a place",
  "their words attributed to a person as speech",
  "possessive relation from vocab (my Marcus)",
  "relationship claim from vocab (the love of my life)",
  "negative verb dropped, vocab praise added (hated\u{2192}loved)",
  "ALL-CAPS ground name lower-cased into a word",
  "ALL-CAPS ground place lower-cased into a word",
  "future (I'll) \u{2014} the event has not happened",
  "frequency from a vocab quantifier (every night)",
  "comparison from vocab (as \u{2026} as)",
];

describe("VERIFY-727 delta-2 battery — 85 drafts aimed at round 2, 20 fresh polishes, 4 cost probes (travel level)", () => {
  const verdict = (g: string, d: string) => {
    const clean = sanitizeSuggestedText(d);
    return clean ? inventedFacts(clean, [g], "travel") : ["sanitized-away"];
  };
  const servedOf = (kinds: string[]) => V727D2_ADVERSARIAL.filter(([, g, d, k]) => kinds.includes(k) && verdict(g, d).length === 0).map(([c]) => c);

  it("counts: 0/24 BUG, 0/35 controls; 6/7 RESIDUAL and 6/19 UNNAMED served (each named); 20/20 fresh faithful; the 4 cost probes refused", () => {
    assert.equal(V727D2_ADVERSARIAL.length, 85);
    assert.equal(V727D2_FAITHFUL.length, 20);
    assert.deepEqual(servedOf(["BUG"]), []);
    assert.deepEqual(servedOf(["EXPECT-REFUSED"]), []);
    assert.deepEqual(servedOf(["RESIDUAL", "UNNAMED"]).sort(), [...V727D2_SERVED].sort());
    assert.deepEqual(V727D2_FAITHFUL.filter(([, g, d]) => verdict(g, d).length > 0).map(([c]) => c), []);
    // The measured faithful COSTS (census §46.7): each is refused, by design.
    assert.deepEqual(V727D2_COST_PROBES.filter(([, g, d]) => verdict(g, d).length === 0).map(([c]) => c), []);
  });
  for (const [cls, ground, draft, kind] of V727D2_ADVERSARIAL.filter(([, , , k]) => k === "BUG" || k === "EXPECT-REFUSED")) {
    it(`refuses [${kind}] ${cls}`, () => { assert.ok(verdict(ground, draft).length > 0, draft); });
  }
  for (const [cls, ground, draft] of V727D2_FAITHFUL) {
    it(`serves the fresh polish: ${cls}`, () => { assert.deepEqual(verdict(ground, draft), []); });
  }

  it("the 28 served round-2 drafts end to end through buildAiAssistedWriting: none served, on both fields", async () => {
    for (const fieldId of [POSTCARD, MEMORY]) {
      for (const [ground, draft] of V727D2_E2E) {
        model(draft);
        assert.deepEqual(labels(await write(makeClient(state(true)), fieldId, ground)), [], `${fieldId}: ${draft}`);
      }
    }
  });
});

describe("fix round 3 — the rules, one at a time (travel level)", () => {
  it("every apostrophe form is one apostrophe: can\u{B4}t and can\u{2BC}t are can't", () => {
    for (const ap of ["\u{B4}", "\u{2BC}", "\u{2BB}", "\u{2018}", "\u{60}"]) {
      assert.ok(inventedFacts("I can believe it", [`can${ap}t believe it`], "travel").some((f) => f === "dropped:not"), ap);
      assert.deepEqual(inventedFacts("Can't believe it!", [`can${ap}t believe it`], "travel"), [], ap);
    }
  });
  it("the counted words in every inflection, and the new ones: trying, closes, losing, postponed, sold, forgot, mightnt, shant", () => {
    const cases: Array<[string, string, string]> = [
      ["trying to see Fuji", "Fuji!", "dropped:try"], ["Nobu closes early", "Nobu early!", "dropped:close"],
      ["losing the gang at dawn", "The gang at dawn", "dropped:lose"], ["postponed the Hakone trip", "The Hakone trip!", "dropped:postpone"],
      ["Nobu was sold out", "Nobu!", "dropped:sell"], ["forgot to see Fuji", "Fuji!", "dropped:forget"],
      ["mightnt go back", "Go back!", "dropped:not"], ["shant go back", "Go back!", "dropped:not"],
      ["hoped to see Fuji", "Fuji!", "dropped:hope"], ["wanted to see Fuji", "Fuji!", "dropped:want"],
    ];
    for (const [g, d, f] of cases) assert.ok(inventedFacts(d, [g], "travel").includes(f), `${g} -> ${d}`);
  });
  it("two-word wishes are counted: if only, would have, could've", () => {
    assert.ok(inventedFacts("If only I'd had ramen at Ichiran tonight", ["ramen at Ichiran tonight"], "travel").some((f) => f === "added:if only"));
    assert.ok(inventedFacts("Would have loved ramen at Ichiran", ["ramen at Ichiran"], "travel").some((f) => f === "added:would have"));
    assert.ok(inventedFacts("Ramen at Ichiran", ["could've had ramen at Ichiran"], "travel").some((f) => f === "dropped:could have"));
    assert.deepEqual(inventedFacts("If only, ramen at Ichiran!", ["if only, ramen at Ichiran"], "travel"), []);
  });
  it("a number may not GAIN a unit: 2 never becomes 2 am or 2 times; a unit it had stays", () => {
    assert.ok(inventedFacts("Dinner at 2 am", ["dinner at 2, loved it"], "travel").some((f) => f === "number:2"));
    assert.ok(inventedFacts("Dinner 2 times", ["dinner, 2 of us"], "travel").some((f) => f === "number:2"));
    assert.deepEqual(inventedFacts("Coffee at 8 am, then the beach", ["coffee at 8am then the beach"], "travel"), []);
  });
  it("a currency sign, a leading minus or dash, and / - \u{2013} between digits are part of the number", () => {
    assert.ok(inventedFacts("Paid 18 for 2 bowls", ["paid $18 for 2 bowls"], "travel").some((f) => f === "number:18"));
    assert.deepEqual(inventedFacts("Paid $18 for 2 bowls!", ["paid $18 for 2 bowls"], "travel"), []);
    assert.deepEqual(inventedFacts("Paid \u{A5}1,800 for 2 bowls", ["paid \u{A5}1,800 for 2 bowls"], "travel"), []);
    assert.ok(inventedFacts("Room 12-3", ["room 12, 3 of us"], "travel").some((f) => f === "number:12-3"));
    assert.ok(inventedFacts("We were -5 at dinner", ["we were 5 at dinner"], "travel").some((f) => f === "number:-5"));
    assert.deepEqual(inventedFacts("A 2-3 hour wait, worth it", ["a 2-3 hour wait, worth it"], "travel"), []);
    assert.deepEqual(inventedFacts("Dinner-time", ["dinner-time"], "travel"), [], "a hyphen between letters still separates words");
  });
  it("* \u{2020} \u{2021} \u{A7} \u{B6} / are symbols: the traveller's own or refused", () => {
    for (const sym of ["*", "\u{2020}", "\u{2021}", "\u{A7}", "\u{B6}", "/"]) {
      assert.ok(inventedFacts(`Dinner with Marcus ${sym}`, ["dinner with Marcus"], "travel").some((f) => f === `symbol:${sym}`), sym);
    }
    assert.deepEqual(inventedFacts("Dinner w/ the gang", ["dinner w/ the gang"], "travel"), []);
  });
  it("a handle, hashtag or domain must be one of the traveller's own as a whole (no prefix); domains in any case", () => {
    assert.ok(inventedFacts("Dinner with @marcus", ["dinner with @marcus_k"], "travel").some((f) => f === "ref:@marcus"));
    assert.ok(inventedFacts("Ramen #tokyo", ["ramen #tokyo_food"], "travel").some((f) => f === "ref:#tokyo"));
    assert.ok(inventedFacts("Book at nobu.com", ["book at nobu.com.au"], "travel").some((f) => f === "link:nobu.com"));
    assert.ok(inventedFacts("Ramen at Nobu.Tokyo", ["ramen at Nobu, Tokyo"], "travel").some((f) => f === "link:Nobu.Tokyo"));
    assert.deepEqual(inventedFacts("Dinner with @marcus.", ["dinner with @marcus"], "travel"), [], "a full stop after a handle is not part of it");
  });
  it("a vocabulary word that inverts one of theirs (un-/dis-) is refused; short words never collide", () => {
    assert.ok(inventedFacts("Happy with the ramen", ["unhappy with the ramen"], "travel").some((f) => f === "inverted:Happy"));
    assert.ok(inventedFacts("Liked the ramen", ["disliked the ramen"], "travel").some((f) => f === "inverted:Liked"));
    assert.ok(inventedFacts("An unforgettable dinner", ["a forgettable dinner"], "travel").some((f) => f === "inverted:unforgettable"));
    assert.deepEqual(inventedFacts("It was great", ["rented a unit, great"], "travel"), [], "it/unit: a short vocabulary word is not an inversion");
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

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY-727 confirmation battery (LR-B58-8, at 1efdec98c) and lane IN-G141-R4.
// The verifier's 25 fresh variants of the five round-3 classes, 25 more of the
// same mechanisms, 21 residual probes and 20 fresh faithful polishes, copied here
// AS DATA (never executing its script). Its §4 named two groups of residuals:
// Group A — the round-3 currency and dash mechanisms in positions that fix did not
// reach (a sign after the number, spaced, or letter-prefixed; a dash other than
// - and –, or spaced, between two numbers) — CLOSED by IN-G141-R4; Group B — new
// design residuals — still served and NAMED in census §46.7, pinned by name.
// ═══════════════════════════════════════════════════════════════════════════════

const V727C_FRESH: Array<[cls: string, ground: string, draft: string]> = [
  ["C1 \u{2BB} U+02BB okina apostrophe, n\u{2019}t dropped", "couldn\u{2BB}t get in at Nobu", "Get in at Nobu!"],
  ["C1 \u{2C8} U+02C8 modifier-letter apostrophe, n\u{2019}t dropped", "wasn\u{2C8}t worth the queue at Nobu", "Worth the queue at Nobu!"],
  ["C1 \u{FF07} U+FF07 fullwidth apostrophe, n\u{2019}t dropped", "haven\u{FF07}t stopped thinking about Tokyo", "Stopped thinking about Tokyo!"],
  ["C1 inflection \"failing\" dropped", "failing to find the ramen place", "Find the ramen place!"],
  ["C1 inflection \"shutting\" dropped", "Nobu shutting early, sadly", "Nobu!"],
  ["C2 bare count gains \"am\"", "we were 3 at lunch", "Lunch at 3 am"],
  ["C2 their unit moved onto the other number", "walked 10 blocks, 2 hours", "Walked 10 hours, 2 blocks"],
  ["C2 bare count gains \"times\"", "coffee at 9, 4 of us", "Coffee 4 times at 9"],
  ["C2 \"nights\" swapped onto the other number", "2 nights, table for 6", "6 nights, table for 2"],
  ["C2 a count becomes a frequency", "5 of us at Nobu", "At Nobu 5 times"],
  ["C3 \u{20AC} unbound from its number", "\u{20AC}12 for 3 beers", "12 for \u{20AC}3 beers"],
  ["C3 \u{A3} unbound from its number", "paid \u{A3}40, table for 2", "Paid 40, table for \u{A3}2"],
  ["C3 \u{A5} with thousands separator unbound", "\u{A5}1,800 ramen, 2 bowls", "1,800 ramen, \u{A5}2 bowls"],
  ["C3 \u{20A9} unbound", "\u{20A9}15,000 for 2 of us", "15,000 for \u{20A9}2 of us"],
  ["C3 currency swapped between their two numbers", "paid $18, 2 bowls", "Paid $2, 18 bowls"],
  ["C4 en dash range between their two numbers", "table 18, 2019 trip", "Table 18\u{2013}2019 trip"],
  ["C4 reversed slash date", "room 12, 3 of us", "Room 3/12"],
  ["C4 slash spaced on one side", "room 12, 3 of us", "Room 12 /3"],
  ["C4 leading minus after a paren", "we were 5 at dinner, so cold", "At dinner we were (-5), so cold"],
  ["C4 triple star rating", "dinner for 5", "Dinner for 5 ***"],
  ["C5 hashtag extended", "ramen #tokyo_food", "Ramen #tokyo_foodie"],
  ["C5 dotted handle prefix", "dinner with @marcus.k.jp", "Dinner with @marcus.k"],
  ["C5 two-label TLD truncated", "book at nobu.co.uk", "Book at nobu.co"],
  ["C5 upper-case TLD domain from their two names", "ramen at Nobu, Tokyo", "Ramen at Nobu.TOKYO"],
  ["C5 subdomain added", "booked nobu.com for dinner", "Booked menu.nobu.com for dinner"],
];
const V727C_EXTRA: Array<[cls: string, ground: string, draft: string]> = [
  ["C1x hoping dropped", "hoping to see Fuji, too cloudy", "Fuji, so lovely"],
  ["C1x sold out dropped", "the ramen place was sold out", "The ramen place!"],
  ["C1x forgetting dropped", "forgetting the camera at the hotel", "The camera at the hotel!"],
  ["C1x delaying dropped", "delaying our flight to Tokyo", "Our flight to Tokyo!"],
  ["C1x oughtn\u{B4}t (U+00B4) dropped", "oughtn\u{B4}t have gone back", "Gone back!"],
  ["C1x darent dropped", "darent go back to Nobu", "Go back to Nobu!"],
  ["C1x unable dropped", "unable to get a table at Nobu", "Get a table at Nobu!"],
  ["C1x \"if only\" dropped", "if only we'd had more time in Tokyo", "We'd had more time in Tokyo!"],
  ["C1x \"should have\" dropped", "should have booked Nobu", "Booked Nobu!"],
  ["C1x wanting dropped", "wanting to see Fuji, too cloudy", "Fuji, too cloudy"],
  ["C2x joined unit (2am) from a bare 2", "dinner at 2, loved it", "Dinner at 2am, loved it"],
  ["C2x bare number gains their \"km\"", "walked 5 km, 3 of us", "Walked 3 km, 5 of us"],
  ["C2x count gains \"people\"", "table 12 for dinner", "Table for 12 people at dinner"],
  ["C3x currency code moved (usd)", "paid 18 usd for 2 bowls", "Paid 18 for 2 usd bowls"],
  ["C3x $ sign added to their bare number", "paid 18 for 2 bowls", "Paid $18 for 2 bowls"],
  ["C4x section sign", "dinner for 5", "Dinner for 5 \u{A7}"],
  ["C4x tilde range (Sm)", "room 12, 3 of us", "Room 12~3"],
  ["C4x \"No.\" before their number (added no)", "room 12 tonight", "No. 12 tonight"],
  ["C4x dot date (round-2 join, control)", "room 12, 3 of us", "Room 12.3"],
  ["C4x ISO date from three numbers", "table 18, 2019 trip, 3 of us", "Table 2019-18-3 trip"],
  ["C5x Unicode handle from their name", "dinner with \u{30DE}\u{30EB}\u{30AF}\u{30B9}", "Dinner with @\u{30DE}\u{30EB}\u{30AF}\u{30B9}"],
  ["C5x hashtag with digits truncated", "ramen #tokyo2019", "Ramen #tokyo"],
  ["C5x www. added", "book at nobu.com", "Book at www.nobu.com"],
  ["C5x hashtag from two of their words", "ramen in tokyo, food heaven", "Ramen #tokyofood"],
  ["C5x all-caps label domain", "ramen at NOBU, tokyo", "Ramen at NOBU.tokyo"],
];
const V727C_PROBES: Array<[cls: string, ground: string, draft: string]> = [
  ["P1 prime U+2032 as an apostrophe", "can\u{2032}t believe how good it was", "I can believe how good it was"],
  ["P1 space before the apostrophe", "can 't believe how good it was", "I can believe how good it was"],
  ["P1 absence word outside the list: zero", "zero regrets about Tokyo", "Regrets about Tokyo!"],
  ["P1 absence word outside the list: nope", "nope. great dinner at Nobu", "Great dinner at Nobu!"],
  ["P2 unit binds across a comma (people)", "table 4, people everywhere", "Table, 4 people everywhere"],
  ["P2 unit binds across a comma (hours)", "left at 4, hours of fun", "Left at 4 hours of fun"],
  ["P3 postfix \u{20AC} (18\u{20AC}) unbound", "18\u{20AC} for 2 bowls", "18 for 2\u{20AC} bowls"],
  ["P3 postfix $ (18$) unbound", "paid 18$ for 2 bowls", "Paid 18 for 2$ bowls"],
  ["P3 spaced sign ($ 18) unbound", "paid $ 18 for 2 bowls", "Paid 18 for $ 2 bowls"],
  ["P3 letter-prefixed sign (US$18) unbound", "paid US$18 for 2 bowls", "Paid 18 for US$2 bowls"],
  ["P3 letter-prefixed sign (A$18) unbound", "paid A$18 for 2 bowls", "Paid 18 for A$2 bowls"],
  ["P4 em dash range (U+2014)", "room 12, 3 of us", "Room 12\u{2014}3"],
  ["P4 spaced hyphen range", "room 12, 3 of us", "Room 12 - 3"],
  ["P4 spaced en dash range", "room 12, 3 of us", "Room 12 \u{2013} 3"],
  ["P4 U+2010 hyphen range", "room 12, 3 of us", "Room 12\u{2010}3"],
  ["P4 U+2011 non-breaking hyphen range", "room 12, 3 of us", "Room 12\u{2011}3"],
  ["P4 ASCII apostrophe as a feet/minutes mark", "12 of us at dinner", "12' of us at dinner"],
  ["P4 vocabulary range (\"to\")", "room 12, 3 of us", "Room 12 to 3"],
  ["P4 hyphen couples two names", "dinner with Marcus and Jen", "Marcus-Jen dinner"],
  ["P4 parenthesised count", "room 12, 3 of us", "Room 12 (3)"],
  ["P5 hyphenated hashtag prefix", "ramen #tokyo-food", "Ramen #tokyo"],
];
const V727C_FAITHFUL: Array<[cls: string, ground: string, draft: string]> = [
  ["F cant \u{2192} Can't, own possessive kept", "cant wait for tomorrow's dinner at Nobu", "Can't wait for tomorrow's dinner at Nobu!"],
  ["F own $ price and count kept, dash added", "paid $18 for 2 bowls, worth it", "Paid $18 for 2 bowls \u{2014} so worth it!"],
  ["F own room and count kept", "room 12, 3 of us, so cosy", "Room 12, 3 of us \u{2014} so cosy!"],
  ["F dead-key apostrophe normalised", "didn\u{B4}t want to leave Tokyo", "Didn't want to leave Tokyo!"],
  ["F own handle and hashtag kept", "dinner with @marcus_k #tokyo_food", "Dinner with @marcus_k #tokyo_food, loved it"],
  ["F own domain, weekday and count kept", "booked nobu.com for Friday, 2 of us", "Booked nobu.com for Friday, 2 of us!"],
  ["F own missed + km kept", "missed the last train, walked 5 km home", "Missed the last train \u{2014} walked 5 km home!"],
  ["F own 10/10 kept", "tried the ramen at Ichiran, 10/10", "Tried the ramen at Ichiran \u{2014} 10/10!"],
  ["F own time and ordinal kept", "sunset at 6:30 pm from the 12th floor", "Sunset at 6:30 pm from the 12th floor \u{2014} wow"],
  ["F own lost + didnt \u{2192} didn't", "lost my hat at Fuji, didnt care", "Lost my hat at Fuji, didn't care!"],
  ["F \u{20AC} price kept", "\u{20AC}12 for 3 beers, happy", "\u{20AC}12 for 3 beers \u{2014} so happy!"],
  ["F negative temperature kept", "-5 at dawn on Fuji, worth it", "-5 at dawn on Fuji \u{2014} so worth it!"],
  ["F hoping kept", "hoping to see Fuji tomorrow", "Hoping to see Fuji tomorrow!"],
  ["F date range kept", "Tokyo 12/3\u{2013}12/9, unreal", "Tokyo 12/3\u{2013}12/9 \u{2014} unreal!"],
  ["F sold out kept", "Nobu was sold out, so sad", "Nobu was sold out \u{2014} so sad!"],
  ["F couldn\u{2019}t (U+2019) \u{2192} couldn't", "couldn\u{2019}t stop smiling in Tokyo", "Couldn't stop smiling in Tokyo!"],
  ["F own US$ kept", "paid US$18 for 2 bowls", "Paid US$18 for 2 bowls, worth it"],
  ["F if only kept", "if only we'd had more time in Tokyo", "If only we'd had more time in Tokyo!"],
  ["F wished kept", "wished I'd booked Nobu", "Wished I'd booked Nobu!"],
  ["F 7:30pm \u{2192} 7:30 pm", "2 of us at 7:30pm", "2 of us at 7:30 pm!"],
];

/** Group A of the confirmation's §4: served at 1efdec98c, refused after IN-G141-R4. */
const V727C_GROUP_A = [
  "P3 postfix \u{20AC} (18\u{20AC}) unbound",
  "P3 postfix $ (18$) unbound",
  "P3 spaced sign ($ 18) unbound",
  "P3 letter-prefixed sign (US$18) unbound",
  "P3 letter-prefixed sign (A$18) unbound",
  "P4 em dash range (U+2014)",
  "P4 spaced hyphen range",
  "P4 spaced en dash range",
  "P4 U+2010 hyphen range",
  "P4 U+2011 non-breaking hyphen range",
];

/** Group B of the confirmation's §4: still served, each NAMED in census §46.7 (pinned both ways). */
const V727C_GROUP_B_SERVED = [
  "P1 prime U+2032 as an apostrophe",
  "P1 space before the apostrophe",
  "P1 absence word outside the list: zero",
  "P1 absence word outside the list: nope",
  "P2 unit binds across a comma (people)",
  "P2 unit binds across a comma (hours)",
  "P4 ASCII apostrophe as a feet/minutes mark",
  "P4 hyphen couples two names",
  "P4 parenthesised count",
  "P5 hyphenated hashtag prefix", // not a finding: a hashtag cannot hold a hyphen, so the traveller's tag IS #tokyo
];

/** The one fresh faithful polish refused: the sanitizer strips a leading "-" as a list marker (census §46.7, a named cost). */
const V727C_FAITHFUL_REFUSED = ["F negative temperature kept"];

/**
 * Group A, more of the same mechanisms (lane IN-G141-R4's own drafts, plus the dashes the lead's brief names that the
 * confirmation did not draft: U+2012 and U+2212). Every one is refused after IN-G141-R4; the ones marked "served at
 * 1efdec98c" were the holes.
 */
const R4_GROUP_A: Array<[cls: string, ground: string, draft: string]> = [
  // Every dash between two numbers joins them, spaced or not.
  ["U+2012 figure dash range", "room 12, 3 of us", "Room 12\u{2012}3"],
  ["U+2212 minus between two numbers (their minus elsewhere)", "room 12, 3 of us, \u{2212}2 outside", "Room 12\u{2212}3, \u{2212}2 outside"],
  ["U+2212 minus range (no minus of theirs: a symbol)", "room 12, 3 of us", "Room 12\u{2212}3"],
  ["U+2015 horizontal bar range", "room 12, 3 of us", "Room 12\u{2015}3"],
  ["U+FF0D fullwidth hyphen range", "room 12, 3 of us", "Room 12\u{FF0D}3"],
  ["U+301C wave dash range", "room 12, 3 of us", "Room 12\u{301C}3"],
  ["spaced em dash range", "room 12, 3 of us", "Room 12 \u{2014} 3"],
  ["hyphen spaced on the left", "room 12, 3 of us", "Room 12 -3"],
  ["hyphen spaced on the right", "room 12, 3 of us", "Room 12- 3"],
  ["spaced slash date (their slash elsewhere)", "dinner w/ the gang, room 12, 3 of us", "Room 12 / 3 w/ the gang"],
  ["U+2010 leading hyphen makes a number negative", "we were 5 at dinner, so cold", "We were \u{2010}5 at dinner, so cold"],
  ["U+2212 leading minus moved between their numbers", "we were 5 at dinner, \u{2212}2 outside", "We were \u{2212}5 at dinner, 2 outside"],
  // A sign after its number, spaced from it, or letter-prefixed binds to it like a leading one.
  ["postfix \u{20AC} spaced (18 \u{20AC}) moved", "18 \u{20AC} for 2 bowls", "18 for 2 \u{20AC} bowls"],
  ["postfix \u{20AC} with a no-break space moved", "18\u{A0}\u{20AC} for 2 bowls", "18 for 2\u{A0}\u{20AC} bowls"],
  ["postfix \u{20AC} dropped", "18\u{20AC} for 2 bowls", "18 for 2 bowls"],
  ["spaced $ dropped", "paid $ 18 for 2 bowls", "Paid 18 for 2 bowls"],
  ["US$ dropped to a bare number", "paid US$18 for 2 bowls", "Paid 18 for 2 bowls"],
  ["R$ moved", "paid R$18 for 2 bowls", "Paid 18 for R$2 bowls"],
  ["HK$ moved", "paid HK$18 for 2 bowls", "Paid 18 for HK$2 bowls"],
  ["NZ$ moved", "paid NZ$18 for 2 bowls", "Paid 18 for NZ$2 bowls"],
  ["a sign glued to a longer word, dropped", "the bill cost$18 for 2 bowls", "The bill cost 18 for 2 bowls"],
];

describe("VERIFY-727 confirmation battery — 25 fresh, 25 extra, 21 probes, 20 fresh polishes; Group A closed (travel level)", () => {
  const verdict = (g: string, d: string) => {
    const clean = sanitizeSuggestedText(d);
    return clean ? inventedFacts(clean, [g], "travel") : ["sanitized-away"];
  };
  type C3 = [cls: string, ground: string, draft: string];
  const served = (cs: C3[]) => cs.filter(([, g, d]) => verdict(g, d).length === 0).map(([c]) => c);
  const refused = (cs: C3[]) => cs.filter(([, g, d]) => verdict(g, d).length > 0).map(([c]) => c);

  it("counts: 0/25 fresh, 0/25 extra; of 21 probes only the 10 Group B named are served; 0 Group A; 19/20 fresh faithful", () => {
    assert.equal(V727C_FRESH.length, 25);
    assert.equal(V727C_EXTRA.length, 25);
    assert.equal(V727C_PROBES.length, 21);
    assert.equal(V727C_FAITHFUL.length, 20);
    assert.equal(V727C_GROUP_A.length, 10);
    assert.deepEqual(served(V727C_FRESH), []);
    assert.deepEqual(served(V727C_EXTRA), []);
    assert.deepEqual(served(V727C_PROBES).sort(), [...V727C_GROUP_B_SERVED].sort());
    assert.deepEqual(served(R4_GROUP_A), []);
    assert.deepEqual(refused(V727C_FAITHFUL), V727C_FAITHFUL_REFUSED);
  });
  for (const [cls, ground, draft] of [...V727C_FRESH, ...V727C_EXTRA]) {
    it(`refuses ${cls}`, () => { assert.ok(verdict(ground, draft).length > 0, draft); });
  }
  for (const [cls, ground, draft] of V727C_PROBES.filter(([c]) => V727C_GROUP_A.includes(c))) {
    it(`refuses Group A: ${cls}`, () => { assert.ok(verdict(ground, draft).length > 0, draft); });
  }
  for (const [cls, ground, draft] of R4_GROUP_A) {
    it(`refuses Group A (IN-G141-R4): ${cls}`, () => { assert.ok(verdict(ground, draft).length > 0, draft); });
  }
  for (const [cls, ground, draft] of V727C_FAITHFUL.filter(([c]) => !V727C_FAITHFUL_REFUSED.includes(c))) {
    it(`serves the fresh polish: ${cls}`, () => { assert.deepEqual(verdict(ground, draft), []); });
  }

  it("end to end through buildAiAssistedWriting, both fields: the 25 fresh drafts and every Group A draft are refused; of the probes only Group B is served", async () => {
    const groupA = [...V727C_PROBES.filter(([c]) => V727C_GROUP_A.includes(c)), ...R4_GROUP_A];
    for (const fieldId of [POSTCARD, MEMORY]) {
      for (const [, ground, draft] of [...V727C_FRESH, ...groupA]) {
        model(draft);
        assert.deepEqual(labels(await write(makeClient(state(true)), fieldId, ground)), [], `${fieldId}: ${draft}`);
      }
      const probesServed: string[] = [];
      for (const [cls, ground, draft] of V727C_PROBES) {
        model(draft);
        if ((await write(makeClient(state(true)), fieldId, ground)).length > 0) probesServed.push(cls);
      }
      assert.deepEqual(probesServed.sort(), [...V727C_GROUP_B_SERVED].sort(), fieldId);
    }
  });
});

describe("IN-G141-R4 — a currency sign is its number's on either side, spaced or letter-prefixed; every dash between two numbers joins them (travel level)", () => {
  it("a sign AFTER its number is part of it: 18\u{20AC} is not 18, and 2\u{20AC} is not 2", () => {
    const f = inventedFacts("18 for 2\u{20AC} bowls", ["18\u{20AC} for 2 bowls"], "travel");
    assert.ok(f.includes("number:18") && f.includes("number:2\u{20AC}"), f.join());
    assert.ok(inventedFacts("Paid 18 for 2$ bowls", ["paid 18$ for 2 bowls"], "travel").includes("number:2$"));
    assert.deepEqual(inventedFacts("18\u{20AC} for 2 bowls, so good!", ["18\u{20AC} for 2 bowls"], "travel"), []);
  });
  it("a sign spaced from its number is part of it when it stands beside one number only; '$ 18' is '$18', '18 \u{20AC}' is '18\u{20AC}'", () => {
    const f = inventedFacts("Paid 18 for $ 2 bowls", ["paid $ 18 for 2 bowls"], "travel");
    assert.ok(f.includes("number:18") && f.includes("number:$2"), f.join());
    assert.deepEqual(inventedFacts("Paid $18 for 2 bowls!", ["paid $ 18 for 2 bowls"], "travel"), []);
    assert.deepEqual(inventedFacts("Paid 18 \u{20AC} for 2 bowls!", ["paid 18\u{20AC} for 2 bowls"], "travel"), []);
    assert.deepEqual(inventedFacts("Paid 18\u{202F}\u{20AC} for 2 bowls!", ["paid 18 \u{20AC} for 2 bowls"], "travel"), [], "a narrow no-break space is a space");
    // Between two numbers a spaced sign binds neither; a draft that binds it to one is refused.
    assert.deepEqual(inventedFacts("Paid 2 $ 18, so good", ["paid 2 $ 18"], "travel"), []);
    assert.ok(inventedFacts("Paid $2 18, so good", ["paid 2 $ 18"], "travel").includes("number:$2"));
    assert.ok(inventedFacts("Paid 2 18 $, so good", ["paid 2 $ 18"], "travel").includes("number:18$"));
    assert.ok(inventedFacts("Paid 2 $18, so good", ["paid 2 $ 18"], "travel").includes("number:$18"));
    assert.ok(inventedFacts("Paid 2$ 18, so good", ["paid 2 $ 18"], "travel").includes("number:2$"));
  });
  it("a minus before the sign stays on the number: -$5 is not $5", () => {
    assert.ok(inventedFacts("Paid -$5, so good", ["paid $5, so good"], "travel").includes("number:-$5"));
    assert.deepEqual(inventedFacts("Paid -$5, so good!", ["paid -$5, so good"], "travel"), []);
  });
  it("up to three letters before the sign are part of the number (US$18, A$18, HK$18); dropping the letters or the sign is refused", () => {
    assert.ok(inventedFacts("Paid 18 for US$2 bowls", ["paid US$18 for 2 bowls"], "travel").includes("number:US$2"));
    assert.ok(inventedFacts("Paid 18 for 2 bowls", ["paid US$18 for 2 bowls"], "travel").includes("number:18"));
    assert.ok(inventedFacts("Paid $18 for 2 bowls", ["paid US$18 for 2 bowls"], "travel").includes("number:$18"));
    assert.ok(inventedFacts("Paid HK$18 for 2 bowls", ["paid US$18 for 2 bowls"], "travel").includes("number:HK$18"));
    assert.deepEqual(inventedFacts("Paid US$18 for 2 bowls!", ["paid us$18 for 2 bowls"], "travel"), []);
  });
  it("a sign glued to a longer word is still its number's", () => {
    assert.ok(inventedFacts("The bill cost 18 for 2 bowls", ["the bill cost$18 for 2 bowls"], "travel").includes("number:18"));
    assert.deepEqual(inventedFacts("The bill cost $18 for 2 bowls!", ["the bill cost$18 for 2 bowls"], "travel"), []);
  });
  it("every dash between two numbers joins them, spaced or not: - \u{2010} \u{2011} \u{2012} \u{2013} \u{2014} \u{2015} \u{FF0D} \u{301C}", () => {
    for (const dash of ["-", "\u{2010}", "\u{2011}", "\u{2012}", "\u{2013}", "\u{2014}", "\u{2015}", "\u{FF0D}", "\u{301C}"]) {
      for (const [l, r] of [["", ""], [" ", " "], [" ", ""], ["", " "]]) {
        const draft = `Room 12${l}${dash}${r}3`;
        assert.ok(inventedFacts(draft, ["room 12, 3 of us"], "travel").includes(`number:12${l}${dash}${r}3`.replace(/ /gu, "")), draft);
      }
    }
    // U+2212 is a symbol (refused unless the traveller wrote it) and, where they did, a dash like the others.
    assert.ok(inventedFacts("Room 12\u{2212}3", ["room 12, 3 of us"], "travel").includes("symbol:\u{2212}"));
    assert.ok(inventedFacts("Room 12\u{2212}3, \u{2212}2 outside", ["room 12, 3 of us, \u{2212}2 outside"], "travel").includes("number:12\u{2212}3"));
    // A spaced slash joins too ("12 / 3" is a date), where the traveller's own slash makes it no new symbol.
    assert.ok(inventedFacts("Room 12 / 3 w/ the gang", ["dinner w/ the gang, room 12, 3 of us"], "travel").includes("number:12/3"));
  });
  it("their own pair is compared as the pair, whatever the dash and the spacing: '12 - 3' may be written '12\u{2013}3'", () => {
    assert.deepEqual(inventedFacts("Room 12\u{2013}3, so cosy", ["room 12 - 3, so cosy"], "travel"), []);
    assert.deepEqual(inventedFacts("Tokyo 12/3\u{2013}12/9 \u{2014} unreal!", ["Tokyo 12/3 - 12/9, unreal"], "travel"), []);
    assert.deepEqual(inventedFacts("Score: 10/10!", ["score 10 / 10"], "travel"), []);
    assert.deepEqual(inventedFacts("Tokyo 12/3\u{2013}12/9 \u{2014} unreal!", ["Tokyo 12/3\u{2013}12/9, unreal"], "travel"), [], "a dash after a number, before a word, joins nothing");
  });
  it("a leading dash of any kind makes a number negative: \u{2010}5 and \u{2212}5 are not 5; their own \u{2212}2 may be written -2", () => {
    assert.ok(inventedFacts("We were \u{2010}5 at dinner", ["we were 5 at dinner"], "travel").includes("number:\u{2010}5"));
    const f = inventedFacts("We were \u{2212}5 at dinner, 2 outside", ["we were 5 at dinner, \u{2212}2 outside"], "travel");
    assert.ok(f.includes("number:\u{2212}5") && f.includes("number:2"), f.join());
    assert.deepEqual(inventedFacts("-2 outside, so cold!", ["\u{2212}2 outside, so cold"], "travel"), []);
    assert.deepEqual(inventedFacts("Day-3 in kyoto!", ["day-3 in kyoto"], "travel"), [], "a hyphen after a word is not a minus");
  });
  it("inside a mixed token the number keeps its sign and its dash: '$18k' is not '18 k', '12-3pm' is not '3 pm'", () => {
    assert.ok(inventedFacts("Paid 18 k", ["paid $18k"], "travel").includes("number:18"));
    assert.ok(inventedFacts("Open 3 pm", ["open 12-3pm"], "travel").includes("number:3"));
    assert.ok(inventedFacts("Paid 18 pp", ["paid 18\u{20AC}pp"], "travel").includes("number:18"), "18\u{20AC}pp is not 18 pp");
    assert.ok(inventedFacts("5 c at dawn", ["-5c at dawn"], "travel").includes("number:5"), "-5c is not 5 c");
    assert.deepEqual(inventedFacts("Open 12-3 pm!", ["open 12-3pm"], "travel"), []);
    assert.deepEqual(inventedFacts("Dinner at 8 pm!", ["dinner at 8pm"], "travel"), [], "8pm is still 8 pm");
  });
});

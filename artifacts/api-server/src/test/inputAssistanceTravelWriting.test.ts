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


/** The 11 RESIDUAL drafts still served after round 2 — each inside a class census §46.7 names. Pinned both ways. */
const V727D_RESIDUAL_SERVED = [
  "two times swapped, each keeps \"at\"",
  "sentence-initial name from ground word (homograph)",
  "sentence-initial vocab word as a name",
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

  it("counts: 0/20 BUG served, 0/33 controls served, 11/28 residuals served (each named); 19/24 faithful served", () => {
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
    assert.ok(inventedFacts("The sunset at Fuji, so lovely", ["missed the sunset at Fuji"], "travel").some((f) => f === "dropped:missed"));
    assert.ok(inventedFacts("Nobu!", ["Nobu was closed, sadly"], "travel").some((f) => f === "dropped:closed"));
    assert.ok(inventedFacts("The trip to Hakone!", ["cancelled the trip to Hakone"], "travel").some((f) => f === "dropped:cancel"));
    assert.ok(inventedFacts("Fuji!", ["tried to see Fuji, too cloudy"], "travel").some((f) => f === "dropped:tried"));
    assert.ok(inventedFacts("Gone to Nobu!", ["wished I'd gone to Nobu"], "travel").some((f) => f === "dropped:wish"));
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

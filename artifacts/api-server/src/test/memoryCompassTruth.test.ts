/**
 * The Compass Memory tools say what they found and nothing else — census-
 * highlights-memories H262 H265 H120 H123 H124 and MEM-POLICY's evidence-count
 * follow-up (b58 lane HM-A3 + MEM-COMPASS-2), through the REAL dispatcher.
 *
 * Every test in this file goes through `executeMemoryCompassTool` and the
 * exported definitions/prompt, which exist on origin/main, so each one is a
 * statement about BEHAVIOUR that main can be run against. The pure helpers
 * (`compass/memoryCompassTruth.ts`) are driven in memoryCompassTruthUnits.test.ts.
 *
 * WHAT WOULD TURN THIS RED
 *   - City matching by substring again (`includes`): York answers with New
 *     York (H262).
 *   - Picking one of several same-named cities: Portland answers with rows.
 *   - An unescaped handle in `ilike`: "c_rl" / "c*" resolve to @carl, in
 *     memory_get_shared AND memory_create_draft (the draft names Carl).
 *   - Dropping `original_text` / `original_language` from a Memory fact (H265).
 *   - The evidence accessor saying "absent" with "No migration in this
 *     repository creates it" again, or calling an unreadable store absent, or
 *     reading provenance for a viewer who is not the owner (H120/H123).
 *   - Counting a participant the viewer may not see, or answering a count
 *     whose block check failed with a number (MEM-POLICY follow-up).
 *   - A merge/split proposal that writes, ignores the flag, or proposes what
 *     the kernel would refuse (H124).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCompassTruth.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_COMPASS_PROMPT_RULES,
  MEMORY_COMPASS_TOOL_NAMES,
  executeMemoryCompassTool,
} from "../compass/MemoryCompassTools.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";
const DAVE = "dddddddd-0000-4000-8000-000000000004";
const ERIN = "eeeeeeee-0000-4000-8000-000000000005";
const UNDERSCORE = "ffffffff-0000-4000-8000-000000000006";

const M_NY_1 = "33333333-0000-4000-8000-000000000001";
const M_NY_2 = "33333333-0000-4000-8000-000000000002";
const M_PDX_US = "33333333-0000-4000-8000-000000000003";
const M_PDX_JM = "33333333-0000-4000-8000-000000000004";
const M_HUE = "33333333-0000-4000-8000-000000000005";
const M_THAI = "33333333-0000-4000-8000-000000000006";
const M_PEOPLE = "33333333-0000-4000-8000-000000000007";
const M_FRIENDS = "33333333-0000-4000-8000-000000000008";
const M_BOB = "33333333-0000-4000-8000-000000000009";
const EPISODE = "44444444-0000-4000-8000-000000000001";
const ITEM_1 = "55555555-0000-4000-8000-000000000001";
const ITEM_2 = "55555555-0000-4000-8000-000000000002";
const ITEM_3 = "55555555-0000-4000-8000-000000000003";
const ITEM_BOB = "55555555-0000-4000-8000-000000000004";

const THAI_CAPTION = "ทะเลสวยมาก 🌊 — แม่ชอบ";
const HUE_COMPOSED = "Huế"; // "Huế" as one code point per letter (NFC)

function memory(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "", owner_id: ALICE, title: null, caption: null, visibility: "public",
    allowed_user_ids: [], hidden_user_ids: [], state: "published",
    trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
    starts_at: "2026-03-01T00:00:00.000Z", ends_at: null,
    created_at: "2026-03-01T00:00:00.000Z", updated_at: "2026-03-01T00:00:00.000Z",
    location_city: null, location_country: null,
    location_lat: 40.7128, location_lng: -74.006,
    ...over,
  };
}

function fixture(): Record<string, any[]> {
  return {
    memories: [
      memory({ id: M_NY_1, title: "Brooklyn bridge walk", location_city: "New York", location_country: "United States", starts_at: "2026-04-01T12:00:00.000Z" }),
      memory({ id: M_NY_2, title: "Village jazz night", location_city: "New York", location_country: "United States", starts_at: "2026-04-02T21:00:00.000Z" }),
      memory({ id: M_PDX_US, title: "Powell's books", location_city: "Portland", location_country: "United States", starts_at: "2026-05-01T12:00:00.000Z" }),
      memory({ id: M_PDX_JM, title: "Blue Lagoon swim", location_city: "Portland", location_country: "Jamaica", starts_at: "2026-06-01T12:00:00.000Z" }),
      memory({ id: M_HUE, title: "Citadel at dusk", location_city: HUE_COMPOSED, location_country: "Vietnam", starts_at: "2026-02-01T12:00:00.000Z" }),
      memory({ id: M_THAI, title: "ทะเล", caption: THAI_CAPTION, location_city: "Krabi", location_country: "Thailand", starts_at: "2026-01-05T12:00:00.000Z" }),
      memory({ id: M_PEOPLE, title: "Boat day", location_city: "Phuket", location_country: "Thailand", starts_at: "2026-01-10T12:00:00.000Z" }),
      memory({ id: M_FRIENDS, title: "Rooftop dinner", visibility: "only_me", location_city: "Bangkok", location_country: "Thailand", starts_at: "2026-01-12T12:00:00.000Z" }),
      memory({ id: M_BOB, owner_id: BOB, visibility: "only_me", title: "Bob's own" }),
    ],
    memory_tags: [
      { memory_id: M_PEOPLE, tagged_user_id: CARL, status: "approved" },
      { memory_id: M_PEOPLE, tagged_user_id: DAVE, status: "approved" },
      { memory_id: M_PEOPLE, tagged_user_id: ERIN, status: "pending" },
    ],
    memory_items: [
      { id: ITEM_1, memory_id: M_FRIENDS, media_type: "image/jpeg", caption: "one", position: 0, created_at: "2026-01-12T12:00:00.000Z" },
      { id: ITEM_2, memory_id: M_FRIENDS, media_type: "image/jpeg", caption: "two", position: 1, created_at: "2026-01-12T12:01:00.000Z" },
      { id: ITEM_3, memory_id: M_FRIENDS, media_type: "video/mp4", caption: null, position: 2, created_at: "2026-01-12T12:02:00.000Z" },
      { id: ITEM_BOB, memory_id: M_BOB, media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-12T12:02:00.000Z" },
    ],
    profiles: [
      { id: ALICE, handle: "alice" }, { id: BOB, handle: "bob" }, { id: CARL, handle: "carl" },
      { id: DAVE, handle: "dave" }, { id: ERIN, handle: "erin" }, { id: UNDERSCORE, handle: "dave_x" },
    ],
    // Dave blocked Alice. Carl and Bob blocked nobody.
    blocks: [{ blocker_id: DAVE, blocked_id: ALICE }],
    trips: [], trip_members: [], user_follows: [], circle_memberships: [], discovery_places: [],
    feature_flags: [],
  };
}

interface State {
  /** Tables that answer as NOT DEPLOYED (42P01). */
  absent?: string[];
  /** Tables that answer with a plain database error. */
  failing?: string[];
  mergeSplitFlag?: boolean;
  extra?: Record<string, any[]>;
  patch?: Record<string, Record<string, unknown>>;
}

/**
 * PostgREST's LIKE semantics, faithfully: `%` and `*` match any run, `_`
 * matches ONE character, and a backslash escapes the next character. The
 * fake in memoryCompassTools.test.ts treats `_` as a literal, which is looser
 * than production and cannot show the wildcard substitution this file is about.
 */
function likeToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) { re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%" || c === "*") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function makeClient(state: State = {}) {
  const db = fixture();
  for (const [t, rows] of Object.entries(state.extra ?? {})) db[t] = [...(db[t] ?? []), ...rows];
  if (state.patch) db.memories = db.memories!.map((m) => (state.patch![m.id] ? { ...m, ...state.patch![m.id] } : m));
  if (state.mergeSplitFlag !== undefined) db.feature_flags!.push({ flag: "memory_merge_split_enabled", enabled: state.mergeSplitFlag });
  const writes: Array<{ table: string; op: string }> = [];
  const reads: Array<{ table: string; cols: string }> = [];

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limit: number | null = null;
    let cols = "";
    const failure = () => {
      if ((state.absent ?? []).includes(table)) return { code: "42P01", message: `relation "public.${table}" does not exist` };
      if ((state.failing ?? []).includes(table)) return { code: "XX000", message: `${table} read blew up` };
      return null;
    };
    const rows = () => {
      const all = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
      return limit === null ? all : all.slice(0, limit);
    };
    const target: any = {
      select(c?: string) { cols = String(c ?? ""); reads.push({ table, cols }); return proxy; },
      eq(c: string, v: any) { preds.push((r) => String(r[c]) === String(v)); return proxy; },
      neq(c: string, v: any) { preds.push((r) => String(r[c]) !== String(v)); return proxy; },
      in(c: string, vs: any[]) { preds.push((r) => vs.map(String).includes(String(r[c]))); return proxy; },
      ilike(c: string, pattern: string) { const re = likeToRegExp(String(pattern)); preds.push((r) => re.test(String(r[c] ?? ""))); return proxy; },
      order() { return proxy; },
      limit(n: number) { limit = n; return proxy; },
      insert() { writes.push({ table, op: "insert" }); return proxy; },
      update() { writes.push({ table, op: "update" }); return proxy; },
      upsert() { writes.push({ table, op: "upsert" }); return proxy; },
      delete() { writes.push({ table, op: "delete" }); return proxy; },
      maybeSingle() {
        const err = failure();
        if (err) return Promise.resolve({ data: null, error: err });
        const r = rows();
        if (r.length > 1) return Promise.resolve({ data: null, error: { code: "PGRST116", message: "multiple rows" } });
        return Promise.resolve({ data: r[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = failure();
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        const r = rows();
        return Promise.resolve({ data: r, error: null, count: r.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return { client: { from, rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }) } as any, writes, reads };
}

const call = (name: string, args: Record<string, unknown>, viewer = ALICE, state: State = {}) => {
  const c = makeClient(state);
  return executeMemoryCompassTool(c.client, viewer, name, args).then((out: any) => ({ out, ...c }));
};
const ids = (list: any[] | undefined) => (list ?? []).map((m: any) => m.memory_id).sort();
const unwrap = (s: string | null) => (s === null ? null : s.replace(/<\/?portava:ugc>/g, ""));

/* ─────────────────── §28.3 — a place is equal or it is not ─────────────────── */

describe("H262 §28.3 — a city that matches nothing is UNRESOLVED, never a similar city", () => {
  it("memory_search: the user's history has only New York; York returns UNRESOLVED and zero rows", async () => {
    const { out } = await call("memory_search", { city: "York" });
    assert.equal(out.resolution, "UNRESOLVED", `York resolved to ${JSON.stringify(ids(out.memories))}`);
    assert.deepEqual(out.memories, []);
    assert.deepEqual(out.asked, { city: "York", country: null });
    assert.match(out.info, /Nothing in the user's own Memories is "York"/);
  });

  it("memory_get_place_history: York is UNRESOLVED with no visits — New York is not offered as York", async () => {
    const { out } = await call("memory_get_place_history", { city: "York" });
    assert.equal(out.resolution, "UNRESOLVED");
    assert.deepEqual(out.visits, []);
    assert.equal(out.visit_count, 0);
    assert.ok(!JSON.stringify(out).includes("Brooklyn"), "a New York Memory reached a York answer");
  });

  it("a prefix or a fragment is not the place either (\"New\", \"ork\")", async () => {
    for (const city of ["New", "ork", "Yorkshire"]) {
      const { out } = await call("memory_search", { city });
      assert.equal(out.resolution, "UNRESOLVED", `${city} resolved`);
      assert.deepEqual(out.memories, []);
    }
  });

  it("CONTROL — the city that exists resolves, case and spacing aside", async () => {
    const { out } = await call("memory_search", { city: "  new   YORK " });
    assert.equal(out.resolution, "RESOLVED");
    assert.deepEqual(ids(out.memories), [M_NY_1, M_NY_2].sort());
    const hist = (await call("memory_get_place_history", { city: "New York" })).out;
    assert.equal(hist.resolution, "RESOLVED");
    assert.equal(hist.visit_count, 2);
  });

  it("NFC: a decomposed spelling of a stored composed city is the same city", async () => {
    const decomposed = HUE_COMPOSED.normalize("NFD");
    assert.notEqual(decomposed, HUE_COMPOSED, "fixture: the two spellings must differ byte-wise");
    const { out } = await call("memory_search", { city: decomposed });
    assert.equal(out.resolution, "RESOLVED");
    assert.deepEqual(ids(out.memories), [M_HUE]);
  });

  it("a city several countries share is AMBIGUOUS with the candidates — the tool never picks", async () => {
    const { out } = await call("memory_search", { city: "Portland" });
    assert.equal(out.resolution, "AMBIGUOUS", `Portland answered with ${JSON.stringify(ids(out.memories))}`);
    assert.deepEqual(out.memories, []);
    assert.deepEqual(
      out.candidates.map((c: any) => `${c.city}|${c.country}|${c.memory_count}`).sort(),
      ["Portland|Jamaica|1", "Portland|United States|1"],
    );
    const hist = (await call("memory_get_place_history", { city: "portland" })).out;
    assert.equal(hist.resolution, "AMBIGUOUS");
    assert.deepEqual(hist.visits, []);
  });

  it("the country settles an AMBIGUOUS city, exactly", async () => {
    const { out } = await call("memory_search", { city: "Portland", country: "jamaica" });
    assert.equal(out.resolution, "RESOLVED");
    assert.deepEqual(ids(out.memories), [M_PDX_JM]);
    const wrong = (await call("memory_search", { city: "Portland", country: "Jam" })).out;
    assert.equal(wrong.resolution, "UNRESOLVED");
  });

  it("a named city that resolves but whose other filters exclude everything is RESOLVED-and-empty, not UNRESOLVED", async () => {
    const { out } = await call("memory_search", { city: "New York", from: "2027-01-01" });
    assert.equal(out.resolution, "RESOLVED");
    assert.deepEqual(out.memories, []);
  });
});

describe("H262 §28.3 — a person is the handle asked for, literally", () => {
  it("memory_get_shared: \"c_rl\" is not @carl (`_` is a LIKE wildcard)", async () => {
    const { out } = await call("memory_get_shared", { personHandle: "c_rl" });
    assert.notEqual(out.person, "carl", "a handle nobody has was answered as @carl");
    assert.equal(out.resolution, "UNRESOLVED");
    assert.deepEqual(out.memories, []);
    assert.deepEqual(out.unconfirmed_participation, []);
  });

  it("memory_get_shared: \"c*\" and \"%arl\" are not @carl (`*` becomes `%` in PostgREST)", async () => {
    for (const personHandle of ["c*", "%arl", "car%"]) {
      const { out } = await call("memory_get_shared", { personHandle });
      assert.notEqual(out.person, "carl", `${personHandle} was answered as @carl`);
      assert.equal(out.resolution, "UNRESOLVED");
    }
  });

  it("memory_create_draft: a draft never names @carl for \"c_rl\" (census H74's exact-handle claim)", async () => {
    const { out } = await call("memory_create_draft", { title: "Boat day", startsAt: "2026-05-01", locationCity: "Phuket", participantHandles: ["c_rl"] });
    assert.equal(out.authorized, false, `the draft was made with ${JSON.stringify(out.draft?.participants)}`);
    assert.match(out.reason, /@c_rl/);
  });

  it("CONTROL — a real handle that CONTAINS `_` still resolves, exactly", async () => {
    const draft = (await call("memory_create_draft", { title: "x", startsAt: "2026-05-01", locationCity: "Hue", participantHandles: ["@Dave_X"] })).out;
    assert.deepEqual(draft.draft.participants, [{ handle: "dave_x", user_id: UNDERSCORE }]);
    const shared = (await call("memory_get_shared", { personHandle: "carl" })).out;
    assert.equal(shared.person, "carl");
    assert.equal(shared.resolution, "RESOLVED");
  });
});

/* ─────────────── §28.16 — the owner's words, verbatim (H265) ─────────────── */

describe("H265 §28.16 — every Memory fact carries the owner's words as stored", () => {
  it("a Thai caption comes back byte-identical in original_text, language undetermined", async () => {
    const { out } = await call("memory_get", { memoryId: M_THAI });
    assert.equal(unwrap(out.memory.original_text?.caption ?? null), THAI_CAPTION);
    assert.equal(unwrap(out.memory.original_text?.title ?? null), "ทะเล");
    assert.equal(out.memory.original_language, "und", "a language was claimed that nothing stores");
  });

  it("search, place history and trip lists carry it too (one builder)", async () => {
    const { out } = await call("memory_search", { city: "Krabi" });
    assert.equal(unwrap(out.memories[0].original_text.caption), THAI_CAPTION);
    assert.equal(out.memories[0].original_language, "und");
  });

  it("the prompt tells the model to quote, not translate or paraphrase, the owner's words", () => {
    assert.match(MEMORY_COMPASS_PROMPT_RULES, /original_text/);
    assert.match(MEMORY_COMPASS_PROMPT_RULES, /never translate or paraphrase them and present the result as the owner's words/i);
  });

  it("the prompt forbids presenting a Memory from a different place or person as the one asked about (H262)", () => {
    assert.match(MEMORY_COMPASS_PROMPT_RULES, /UNRESOLVED/);
    assert.match(MEMORY_COMPASS_PROMPT_RULES, /NEVER present a Memory from a different place or person as the one asked about/);
    assert.match(MEMORY_COMPASS_PROMPT_RULES, /AMBIGUOUS[^\n]*never pick/);
  });
});

/* ─────────── §16 getMemoryEvidence — the store, as it is (H120/H123) ────────── */

describe("H120/H123 — memory_get_evidence reads §3.3's memory_evidence where it exists", () => {
  it("the store not deployed (42P01) is `not_deployed`, and the false 'no migration' sentence is gone", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_PEOPLE }, ALICE, { absent: ["memory_evidence", "memory_episodes"] });
    assert.equal(out.evidence_store, "not_deployed");
    assert.match(out.evidence_store_reason, /2320/);
    assert.doesNotMatch(out.evidence_store_reason, /No migration in this repository/);
    assert.equal(out.provenance, undefined);
  });

  it("an UNREADABLE store is `unavailable`, never absent and never 'no provenance'", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_PEOPLE }, ALICE, { failing: ["memory_evidence"] });
    assert.equal(out.evidence_store, "unavailable");
    assert.match(out.evidence_store_reason, /does NOT mean/);
    assert.equal(out.provenance, undefined);
  });

  const SPINE: Record<string, any[]> = {
    memory_episodes: [{
      id: EPISODE, user_id: ALICE, detection_reason: "media_cluster", detector_version: 1, significance: 0.8,
      significance_basis: "user_affirmed", state: "confirmed", started_at: "2026-01-10T09:00:00.000Z", ended_at: "2026-01-10T15:00:00.000Z",
      city: "Somewhere Else", place_id: "place-not-the-memorys",
    }],
    memory_evidence: [
      { episode_id: EPISODE, user_id: ALICE, truth_level: "asserted", source_class: "explicit", source_table: "memories", source_id: M_PEOPLE, source_ref: { confirmed_by: "owner" }, observed_at: "2026-01-11T00:00:00.000Z", weight: 1 },
      { episode_id: EPISODE, user_id: ALICE, truth_level: "observed", source_class: "system", source_table: "media_assets", source_id: "asset-secret-id", source_ref: { lat: 7.8804, lng: 98.3923 }, observed_at: "2026-01-10T10:00:00.000Z", weight: 0.7 },
    ],
  };

  it("for the OWNER: the episode's detection and each record's truth level and confidence — no ids, refs or coordinates", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_PEOPLE }, ALICE, { extra: SPINE });
    assert.equal(out.evidence_store, "present");
    assert.equal(out.provenance.length, 1);
    const ep = out.provenance[0];
    assert.equal(ep.detection_reason, "media_cluster");
    assert.equal(ep.significance_basis, "user_affirmed");
    assert.deepEqual(
      ep.records.map((r: any) => `${r.truth_level}|${r.source_class}|${r.source_kind}|${r.confidence}`).sort(),
      ["asserted|explicit|owner_confirmation|1", "observed|system|captured_media|0.7"],
    );
    const text = JSON.stringify(out);
    assert.ok(!/asset-secret-id|source_ref|7\.8804|98\.3923|Somewhere Else|place-not-the-memorys/.test(text), "a source id, a ref, a coordinate or the episode's own place reached the model");
  });

  it("an owner Memory with no link row is `present` with no provenance, said in words", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_NY_1 }, ALICE, { extra: SPINE });
    assert.equal(out.evidence_store, "present");
    assert.deepEqual(out.provenance, []);
    assert.match(out.evidence_store_reason, /not kept from a detected episode/);
  });

  it("for anyone but the owner: `owner_only`, and memory_evidence is not even read (no 'was it auto-detected' oracle)", async () => {
    const { out, reads } = await call("memory_get_evidence", { memoryId: M_PEOPLE }, BOB, { extra: SPINE });
    assert.equal(out.evidence_store, "owner_only");
    assert.equal(out.provenance, undefined);
    assert.deepEqual(reads.filter((r) => r.table === "memory_evidence" || r.table === "memory_episodes"), []);
  });
});

/* ──── §10 — a participant COUNT goes through the detail read's ladder ──── */

describe("MEM-POLICY follow-up — evidence participant counts honour blocks and fail closed", () => {
  it("the owner's count leaves out a participant blocked either way (Dave blocked Alice)", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_PEOPLE }, ALICE);
    assert.equal(out.confirmed_participants, 1, "a blocked participant was counted as having been there");
    assert.equal(out.unconfirmed_participants, 1);
  });

  it("another viewer's count leaves out a participant blocked with THEM, and a pending tag is never 'unconfirmed attendance' for them", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_PEOPLE }, BOB, { extra: { blocks: [{ blocker_id: BOB, blocked_id: CARL }] } });
    assert.equal(out.confirmed_participants, 1, "Carl, whom Bob blocked, was counted for Bob");
    assert.equal(out.unconfirmed_participants, 0);
    assert.equal(out.unidentified_participants, 1, "the pending tag is §10's anonymous count for a third party");
  });

  it("an unreadable block check WITHHOLDS the counts — never a number computed from a failed read", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_PEOPLE }, ALICE, { failing: ["blocks"] });
    assert.equal(out.confirmed_participants, null);
    assert.equal(out.unconfirmed_participants, null);
    assert.equal(out.participants_unavailable, true);
    assert.equal(out.evidence_store === undefined, false, "the honest headline must survive a withheld count");
  });

  it("CONTROL — a Memory nobody is tagged on still answers zero, not unavailable", async () => {
    const { out } = await call("memory_get_evidence", { memoryId: M_NY_1 }, ALICE);
    assert.equal(out.confirmed_participants, 0);
    assert.equal(out.participants_unavailable, undefined);
  });
});

/* ──────────── §16 "may propose a merge/split" — write nothing (H124) ─────────── */

describe("H124 — memory_propose_merge / memory_propose_split", () => {
  it("both are offered to the model", () => {
    assert.ok(MEMORY_COMPASS_TOOL_NAMES.has("memory_propose_merge"));
    assert.ok(MEMORY_COMPASS_TOOL_NAMES.has("memory_propose_split"));
  });

  it("with the merge/split flag absent or off, nothing is proposed — the confirm route would refuse it", async () => {
    for (const state of [{}, { mergeSplitFlag: false }]) {
      const merge = (await call("memory_propose_merge", { survivorId: M_NY_1, absorbedIds: [M_NY_2] }, ALICE, state)).out;
      assert.equal(merge.authorized, false);
      assert.match(merge.reason, /not available yet/);
      const split = (await call("memory_propose_split", { memoryId: M_FRIENDS, itemIds: [ITEM_1] }, ALICE, state)).out;
      assert.equal(split.authorized, false);
      assert.match(split.reason, /not available yet/);
    }
  });

  it("a merge of the owner's own same-audience Memories is a PROPOSAL, and nothing is written", async () => {
    const { out, writes } = await call("memory_propose_merge", { survivorId: M_NY_1, absorbedIds: [M_NY_2] }, ALICE, { mergeSplitFlag: true });
    assert.equal(out.writes_nothing, true);
    assert.equal(out.proposal.kind, "merge");
    assert.equal(out.proposal.requires_confirmation, true);
    assert.equal(out.proposal.confirm_via, "POST /memories/merge");
    assert.deepEqual(out.proposal.confirm_body, { survivorId: M_NY_1, absorbedIds: [M_NY_2] });
    assert.equal(out.proposal.survivor.memory_id, M_NY_1);
    assert.deepEqual(writes, []);
  });

  it("a merge across audiences is refused, as 3676 would refuse it (MEMORY_MERGE_AUDIENCE_MISMATCH)", async () => {
    const { out } = await call("memory_propose_merge", { survivorId: M_NY_1, absorbedIds: [M_FRIENDS] }, ALICE, { mergeSplitFlag: true });
    assert.equal(out.authorized, false);
    assert.match(out.reason, /audience/);
  });

  it("another person's Memory is refused with the SAME words as one that does not exist", async () => {
    const other = (await call("memory_propose_merge", { survivorId: M_NY_1, absorbedIds: [M_BOB] }, ALICE, { mergeSplitFlag: true })).out;
    const missing = (await call("memory_propose_merge", { survivorId: M_NY_1, absorbedIds: ["99999999-0000-4000-8000-000000000000"] }, ALICE, { mergeSplitFlag: true })).out;
    assert.equal(other.authorized, false);
    assert.deepEqual(other, missing);
  });

  it("a split proposes moving the owner's chosen items and leaves the rest; nothing is written", async () => {
    const { out, writes } = await call("memory_propose_split", { memoryId: M_FRIENDS, itemIds: [ITEM_1, ITEM_3], title: "The video" }, ALICE, { mergeSplitFlag: true });
    assert.equal(out.writes_nothing, true);
    assert.equal(out.proposal.kind, "split");
    assert.equal(out.proposal.confirm_via, `POST /memories/${M_FRIENDS}/split`);
    assert.deepEqual(out.proposal.moving_items.map((i: any) => i.item_id), [ITEM_1, ITEM_3]);
    assert.equal(out.proposal.staying_item_count, 1);
    assert.deepEqual(writes, []);
  });

  it("a split that would empty the source, or names an item that is not the source's, is refused", async () => {
    const all = (await call("memory_propose_split", { memoryId: M_FRIENDS, itemIds: [ITEM_1, ITEM_2, ITEM_3] }, ALICE, { mergeSplitFlag: true })).out;
    assert.equal(all.authorized, false);
    assert.match(all.reason, /at least one item/);
    const foreign = (await call("memory_propose_split", { memoryId: M_FRIENDS, itemIds: [ITEM_BOB] }, ALICE, { mergeSplitFlag: true })).out;
    assert.equal(foreign.authorized, false);
    assert.match(foreign.reason, /Not every one of those items/);
  });

  it("a Memory its owner keeps away from the assistant is not proposed for anything (same rule as a correction)", async () => {
    const excluded = { memory_resurfacing_preferences: [{ memory_id: M_NY_2, owner_id: ALICE, control: "DO_NOT_RESURFACE" }] };
    const merge = (await call("memory_propose_merge", { survivorId: M_NY_1, absorbedIds: [M_NY_2] }, ALICE, { mergeSplitFlag: true, extra: excluded })).out;
    assert.equal(merge.authorized, false);
    assert.match(merge.reason, /does not bring it up/);
  });
});

/**
 * Write-precondition reads in the service layer: the read whose answer decides
 * whether an IRREVERSIBLE write happens.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. `const { data } = await …
 * .maybeSingle()` hands back `data === null` both when the row is absent and
 * when the table could not be read. Every site below is a dedup / idempotency
 * guard, so "could not read" silently became "nothing there yet" and the code
 * went on to insert.
 *
 * Each case pairs a CONTROL (the healthy path still writes, or still dedupes)
 * with the failure case. Without the control a fix that simply refused to do
 * anything would pass every failure assertion here while disabling the feature.
 *
 * `failOn` is scoped by table AND, where a table is read more than once in the
 * same path, by the filters of the specific query — scoping to a whole table
 * can abort the call before the code under test runs, which makes a case pass
 * for the wrong reason.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/p2LaneCDedupPreconditions.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";

import { createStamp } from "../services/passport/PassportStampService.js";
import { recordContribution } from "../services/passport/PassportContributionService.js";
import { saveGem } from "../services/hiddenGems/HiddenGemService.js";
import { reportGem } from "../services/hiddenGems/HiddenGemModerationService.js";
import { applyForGuide } from "../services/hiddenGems/LocalGuideService.js";
import { getOrCreateConversation } from "../services/compass/CompassConversationService.js";
import { translateContentFields } from "../services/contentTranslation.js";
import { processTagging } from "../services/tagging/TaggingService.js";
import { generateAiSummary } from "../lib/places/placeAiSummary.js";
import { _setTestOpenAI } from "../lib/openai.js";
import { writeObservation } from "../services/intel/IntelCaptureService.js";

const USER = "10000000-0000-4000-a000-000000000001";
const OTHER = "10000000-0000-4000-a000-000000000002";
const GEM = "20000000-0000-4000-a000-000000000003";

const dbDown = (table: string) => (ctx: FakeReadContext) =>
  ctx.table === table ? { message: `${table} unavailable`, code: "57P01" } : null;

// ── passport_stamps: the dedup read decides whether a stamp is minted ────────

describe("createStamp — an unreadable passport_stamps is not 'no such stamp'", () => {
  const input = {
    userId: USER,
    stampType: "city_visit",
    country: "Vietnam",
    city: "Da Nang",
  } as any;

  it("CONTROL: a readable table with the stamp already present returns it, isNew false", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        passport_visibility_preferences: [],
        passport_stamps: [
          { id: "stamp-1", user_id: USER, stamp_type: "city_visit", country: "Vietnam", city: "Da Nang" },
        ],
      },
      inserted,
    });
    const r = await createStamp(db, input);
    assert.deepEqual(r, { id: "stamp-1", isNew: false });
    assert.equal((inserted["passport_stamps"] ?? []).length, 0, "dedup must not mint a second stamp");
  });

  it("CONTROL: a readable, empty table still mints the stamp", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { passport_visibility_preferences: [], passport_stamps: [] },
      inserted,
    });
    const r = await createStamp(db, input);
    assert.ok(r, "the happy path must still award");
    assert.equal((inserted["passport_stamps"] ?? []).length, 1);
  });

  it("an unreadable passport_stamps refuses to mint rather than minting a duplicate", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        passport_visibility_preferences: [],
        // The stamp DOES exist. That is what makes this non-vacuous: without
        // the check the insert really does run and really does duplicate it.
        passport_stamps: [
          { id: "stamp-1", user_id: USER, stamp_type: "city_visit", country: "Vietnam", city: "Da Nang" },
        ],
      },
      failOn: dbDown("passport_stamps"),
      inserted,
    });
    const r = await createStamp(db, input);
    assert.equal(r, null, "a stamp must not be minted on the strength of an unreadable dedup read");
    assert.equal((inserted["passport_stamps"] ?? []).length, 0);
  });

  it("PGRST116 (the user already has TWO matching stamps) is also not 'no such stamp'", async () => {
    // maybeSingle resolves with an error, data null, when more than one row
    // matches — i.e. exactly when a third must not be created.
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        passport_visibility_preferences: [],
        passport_stamps: [
          { id: "stamp-1", user_id: USER, stamp_type: "city_visit", country: "Vietnam", city: "Da Nang" },
          { id: "stamp-2", user_id: USER, stamp_type: "city_visit", country: "Vietnam", city: "Da Nang" },
        ],
      },
      inserted,
    });
    const r = await createStamp(db, input);
    assert.equal(r, null);
    assert.equal((inserted["passport_stamps"] ?? []).length, 0, "a duplicate pair must not become a triple");
  });
});

// ── passport_contribution_events: double credit on the §20 ledger ────────────

describe("recordContribution — an unreadable ledger is not 'never credited'", () => {
  const input = {
    userId: USER,
    eventType: "city_visit_verified" as const,
    sourceType: "trip",
    sourceId: "trip-1",
  };

  it("CONTROL: an existing credit for this source is not credited twice", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        passport_contribution_events: [
          { id: "e1", user_id: USER, event_type: "city_visit_verified", source_id: "trip-1" },
        ],
      },
      inserted,
    });
    assert.equal(await recordContribution(db, input), false);
    assert.equal((inserted["passport_contribution_events"] ?? []).length, 0);
  });

  it("CONTROL: a first-time contribution is credited", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: { passport_contribution_events: [] }, inserted });
    assert.equal(await recordContribution(db, input), true);
    assert.equal((inserted["passport_contribution_events"] ?? []).length, 1);
  });

  it("an unreadable ledger does NOT re-credit an already-credited source", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        passport_contribution_events: [
          { id: "e1", user_id: USER, event_type: "city_visit_verified", source_id: "trip-1" },
        ],
      },
      failOn: dbDown("passport_contribution_events"),
      inserted,
    });
    assert.equal(await recordContribution(db, input), false);
    assert.equal((inserted["passport_contribution_events"] ?? []).length, 0, "no second credit for one action");
  });
});

// ── hidden_gem_saves: save_count is bumped once per NEW save ─────────────────

describe("saveGem — an unreadable hidden_gem_saves is not 'not saved yet'", () => {
  it("CONTROL: an already-saved gem reports alreadySaved and writes nothing", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { hidden_gem_saves: [{ gem_id: GEM, user_id: USER }], hidden_gems: [{ id: GEM, save_count: 7 }] },
      inserted,
    });
    // Field assertion, not deepEqual: saveGem also reports `saveCountIncremented`
    // (see hiddenGemSaveCountTruth.test.ts). What THIS case is about is the dedup.
    assert.equal((await saveGem(db, GEM, USER)).alreadySaved, true);
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 0);
  });

  it("CONTROL: a first save is written", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { hidden_gem_saves: [], hidden_gems: [{ id: GEM, save_count: 7 }] },
      inserted,
    });
    assert.equal((await saveGem(db, GEM, USER)).alreadySaved, false);
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 1);
  });

  it("an unreadable hidden_gem_saves throws instead of re-saving and re-counting", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { hidden_gem_saves: [{ gem_id: GEM, user_id: USER }], hidden_gems: [{ id: GEM, save_count: 7 }] },
      failOn: dbDown("hidden_gem_saves"),
      inserted,
    });
    await assert.rejects(() => saveGem(db, GEM, USER));
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 0, "no duplicate save row");
  });
});

// ── hidden_gem_reports: one reporter must not inflate report_count ──────────

describe("reportGem — an unreadable hidden_gem_reports is not 'never reported'", () => {
  it("CONTROL: a repeat report by the same reporter is a no-op", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        hidden_gem_reports: [{ id: "r1", gem_id: GEM, reporter_id: USER }],
        hidden_gems: [{ id: GEM, report_count: 3 }],
      },
      inserted,
    });
    assert.deepEqual(await reportGem(db, GEM, USER, "inaccurate"), { ok: true, alreadyReported: true });
    assert.equal((inserted["hidden_gem_reports"] ?? []).length, 0);
  });

  it("CONTROL: a first report is filed", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { hidden_gem_reports: [], hidden_gems: [{ id: GEM, report_count: 3 }] },
      inserted,
    });
    assert.deepEqual(await reportGem(db, GEM, USER, "inaccurate"), { ok: true, alreadyReported: false });
    assert.equal((inserted["hidden_gem_reports"] ?? []).length, 1);
  });

  it("an unreadable hidden_gem_reports throws instead of filing a second report", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        hidden_gem_reports: [{ id: "r1", gem_id: GEM, reporter_id: USER }],
        hidden_gems: [{ id: GEM, report_count: 3 }],
      },
      failOn: dbDown("hidden_gem_reports"),
      inserted,
    });
    await assert.rejects(() => reportGem(db, GEM, USER, "inaccurate"));
    assert.equal((inserted["hidden_gem_reports"] ?? []).length, 0, "report_count must not be bumped twice by one reporter");
  });
});

// ── local_guide_profiles: an active guide must not be reset to applicant ─────

describe("applyForGuide — an unreadable local_guide_profiles is not 'no profile'", () => {
  it("CONTROL: an existing profile is returned untouched", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { local_guide_profiles: [{ user_id: USER, status: "active" }] },
      inserted,
    });
    const r = await applyForGuide(db, USER);
    assert.equal(r.status, "active");
    assert.equal((inserted["local_guide_profiles"] ?? []).length, 0);
  });

  it("CONTROL: a first application inserts an applicant profile", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: { local_guide_profiles: [] }, inserted });
    await applyForGuide(db, USER);
    assert.equal((inserted["local_guide_profiles"] ?? []).length, 1);
    assert.equal(inserted["local_guide_profiles"][0].status, "applicant");
  });

  it("an unreadable table throws rather than overwriting an ACTIVE guide with applicant/level 0", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { local_guide_profiles: [{ user_id: USER, status: "active", guide_level: 4 }] },
      failOn: dbDown("local_guide_profiles"),
      inserted,
    });
    await assert.rejects(() => applyForGuide(db, USER));
    assert.equal((inserted["local_guide_profiles"] ?? []).length, 0, "a verified guide must not be demoted by a read error");
  });
});

// ── compass_conversations: a live session must not be silently abandoned ─────

describe("getOrCreateConversation — an unreadable table is not 'no such conversation'", () => {
  const CONV = "30000000-0000-4000-a000-000000000009";
  const fresh = () => [{ id: CONV, user_id: USER, last_active_at: new Date().toISOString() }];

  it("CONTROL: a live conversation is reused, nothing is inserted", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: { compass_conversations: fresh() }, inserted });
    assert.equal(await getOrCreateConversation(db, USER, CONV), CONV);
    assert.equal((inserted["compass_conversations"] ?? []).length, 0);
  });

  it("CONTROL: a stale conversation is replaced with a fresh row", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        compass_conversations: [
          { id: CONV, user_id: USER, last_active_at: new Date(Date.now() - 48 * 3600_000).toISOString() },
        ],
      },
      inserted,
    });
    await getOrCreateConversation(db, USER, CONV);
    assert.equal((inserted["compass_conversations"] ?? []).length, 1);
  });

  it("an unreadable table throws instead of abandoning the live conversation", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: { compass_conversations: fresh() },
      failOn: dbDown("compass_conversations"),
      inserted,
    });
    await assert.rejects(() => getOrCreateConversation(db, USER, CONV));
    assert.equal((inserted["compass_conversations"] ?? []).length, 0, "no orphan conversation on a read failure");
  });
});

// ── content_translations: a cache miss must not overwrite the cache ──────────

describe("translateContentFields — an unreadable cache is not a cache miss", () => {
  const base = {
    entityType: "post" as any,
    entityId: "post-1",
    fields: { title: "Bonjour" } as any,
    sourceLanguage: "fr",
    targetLanguage: "en",
  };
  const cachedRow = {
    entity_type: "post",
    entity_id: "post-1",
    target_language: "en",
    source_language: "fr",
    status: "translated",
    translated_fields: { title: "Hello" },
  };

  it("CONTROL: a readable cache hit is served and nothing is rewritten", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({ rows: { content_translations: [cachedRow] }, inserted });
    const r = await translateContentFields(sc, { ...base, logger: noopLog as any });
    assert.equal(r.status, "translated");
    assert.equal(r.translatedFields.title, "Hello");
    assert.equal((inserted["content_translations"] ?? []).length, 0, "a cache hit must not re-upsert");
  });

  it("an unreadable content_translations skips instead of retranslating over the stored row", async () => {
    const inserted: Record<string, any[]> = {};
    const sc = makeFailClosedClient({
      rows: { content_translations: [cachedRow] },
      failOn: dbDown("content_translations"),
      inserted,
    });
    const r = await translateContentFields(sc, { ...base, logger: noopLog as any });
    assert.equal(r.status, "skipped", "an unreadable cache must not turn into a provider call");
    assert.equal(
      (inserted["content_translations"] ?? []).length,
      0,
      "a good stored translation must not be overwritten with a failure sentinel",
    );
  });
});

// ── tags: at-most-once mention notification ─────────────────────────────────

describe("processTagging — an unreadable tags table is not 'not yet tagged'", () => {
  // The dedup read filters on tagged_user_id; the hourly rate-limit count on
  // the SAME table does not. Scoping the failure to the whole `tags` table
  // would trip the rate-limit guard first and return [] for the wrong reason.
  const dedupReadOnly = (ctx: FakeReadContext) =>
    ctx.table === "tags" && ctx.filters.some((f) => f.col === "tagged_user_id")
      ? { message: "tags unavailable", code: "57P01" }
      : null;

  const rows = (tagRows: any[]) => ({
    profiles: [{ id: OTHER, handle: "bob", tag_permission: "anyone" }],
    tags: tagRows,
    blocks: [],
    user_follows: [],
    posts: [{ id: "post-1", user_id: USER, visibility: "public" }],
  });

  const ctx = (db: any, inserted: Record<string, any[]>) => ({
    db,
    authorId: USER,
    sourceType: "post" as const,
    sourceId: "post-1",
    content: "hey @bob",
    logger: noopLog as any,
    _inserted: inserted,
  });

  it("CONTROL: a first mention is tagged and returned for notification", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({ rows: rows([]), inserted });
    const out = await processTagging(ctx(db, inserted) as any);
    assert.deepEqual(out, [OTHER], "the happy path must still notify");
    assert.equal((inserted["tags"] ?? []).length, 1);
  });

  it("CONTROL: an already-tagged mention is not returned a second time", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: rows([{ id: "t1", source_type: "post", source_id: "post-1", tagged_user_id: OTHER }]),
      inserted,
    });
    const out = await processTagging(ctx(db, inserted) as any);
    assert.deepEqual(out, [], "re-processing a post must not re-notify");
  });

  it("an unreadable tags table does NOT re-notify an already-tagged user", async () => {
    const inserted: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: rows([{ id: "t1", source_type: "post", source_id: "post-1", tagged_user_id: OTHER }]),
      failOn: dedupReadOnly,
      inserted,
    });
    const out = await processTagging(ctx(db, inserted) as any);
    assert.deepEqual(out, [], "at-most-once must survive an unreadable dedup table");
  });
});

// ── place_ai_summaries: the cache read is the only brake on a paid call ──────

describe("generateAiSummary — an unreadable cache is not a cache miss", () => {
  const PLACE = "70000000-0000-4000-a000-000000000001";
  const posts = [
    { id: "p1", caption: "great coffee" },
    { id: "p2", caption: "quiet in the morning" },
    { id: "p3", caption: "good wifi" },
  ] as any;
  const cachedRow = {
    place_id: PLACE,
    text: "Visitors praise the coffee.",
    generated_at: new Date().toISOString(),
  };

  /** Counts provider calls and captures console.warn, then restores both. */
  async function withProbe<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number; warns: string[] }> {
    let calls = 0;
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    _setTestOpenAI({
      chat: { completions: { create: async () => { calls++; return { choices: [{ message: { content: "fresh" } }] }; } } },
    } as any);
    try {
      const result = await fn();
      return { result, calls, warns };
    } finally {
      _setTestOpenAI(null);
      console.warn = realWarn;
    }
  }

  it("CONTROL: a readable cache hit is served without calling the provider", async () => {
    const inserted: Record<string, any[]> = {};
    const client = makeFailClosedClient({ rows: { place_ai_summaries: [cachedRow] }, inserted });
    const { result, calls } = await withProbe(() =>
      generateAiSummary(PLACE, "Cafe Cong", posts, null, client),
    );
    assert.equal(result?.text, "Visitors praise the coffee.");
    assert.equal(calls, 0, "a cache hit must not reach the provider");
  });

  it("CONTROL: a readable miss generates and caches", async () => {
    const inserted: Record<string, any[]> = {};
    const client = makeFailClosedClient({ rows: { place_ai_summaries: [] }, inserted });
    const { result, calls } = await withProbe(() =>
      generateAiSummary(PLACE, "Cafe Cong", posts, null, client),
    );
    assert.equal(result?.text, "fresh");
    assert.equal(calls, 1);
    assert.equal((inserted["place_ai_summaries"] ?? []).length, 1);
  });

  it("an unreadable place_ai_summaries does not spend a provider call or rewrite the cache", async () => {
    // Both with and without the fix this returns null-ish for the caller, so the
    // row-level outcome alone would be a vacuous assertion. The observable
    // difference is that WITHOUT the check the provider is actually called and
    // the still-fresh cached row is upserted over; and that the warning names
    // the cache read rather than a generation failure.
    const inserted: Record<string, any[]> = {};
    const client = makeFailClosedClient({
      rows: { place_ai_summaries: [cachedRow] },
      failOn: (c: FakeReadContext) =>
        c.table === "place_ai_summaries" ? { message: "summaries unavailable", code: "57P01" } : null,
      inserted,
    });
    const { result, calls, warns } = await withProbe(() =>
      generateAiSummary(PLACE, "Cafe Cong", posts, null, client),
    );
    assert.equal(result, null);
    assert.equal(calls, 0, "an unreadable cache must not become a per-request provider charge");
    assert.equal((inserted["place_ai_summaries"] ?? []).length, 0, "the cached summary must not be rewritten");
    assert.ok(
      warns.some((w) => w.includes("cache read failed")),
      `the cache-read failure must be named, got: ${JSON.stringify(warns)}`,
    );
  });
});

// ── intel replay lookups: the direction was already right, the story was not ─

describe("writeObservation replay lookup — a failed re-read is not a key collision", () => {
  const ACTOR = "80000000-0000-4000-a000-000000000001";
  const SUBJECT = "80000000-0000-4000-a000-000000000002";
  const input = {
    subjectId: SUBJECT,
    claimType: "crowd.level",
    value: { level: "busy" },
    observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    idempotencyKey: "obs-key-1",
  } as any;
  const rows = {
    feature_flags: [{ flag: "intel_capture_quick_signal", enabled: true }],
    intel_contribution_consent: [{ user_id: ACTOR, enabled: true, withdrawn_at: null }],
    places: [{ id: SUBJECT }],
    intel_observations: [
      { id: "obs-1", actor_id: ACTOR, idempotency_key: "obs-key-1" },
    ],
  };

  it("CONTROL: a real replay (23505 + readable table) returns the stored row", async () => {
    const sc = makeFailClosedClient({
      rows,
      failWritesOn: (t: string) =>
        t === "intel_observations" ? { message: "duplicate key value", code: "23505" } : null,
    });
    const r: any = await writeObservation(sc, ACTOR, input);
    assert.equal(r.ok, true);
    assert.equal(r.deduped, true);
  });

  it("a 23505 whose replay lookup FAILED is reported as the lookup failure, not the collision", async () => {
    const sc = makeFailClosedClient({
      rows,
      failWritesOn: (t: string) =>
        t === "intel_observations" ? { message: "duplicate key value", code: "23505" } : null,
      failOn: (c: FakeReadContext) =>
        c.table === "intel_observations" ? { message: "observations unavailable", code: "57P01" } : null,
    });
    const r: any = await writeObservation(sc, ACTOR, input);
    assert.equal(r.ok, false, "an unconfirmable replay must never be reported as a success");
    assert.match(
      String(r.detail ?? ""),
      /replay lookup failed/,
      "the operator must see that the re-read failed, not just 'duplicate key'",
    );
  });
});

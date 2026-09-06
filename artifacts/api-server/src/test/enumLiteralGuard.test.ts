/**
 * Dead-literal contract — `check:enum-literals`.
 *
 * THE CLASS THIS EXISTS FOR
 * -------------------------
 * Thirty-two live production call sites filtered a column on a value that
 * column cannot hold. `trips.status = 'in_progress'` (the enum has `active`),
 * `events.state <> 'banned'` (no such label), `hidden_gems.status IN
 * ('approved','active')`, `posts.status = 'published'`, `trips.visibility IN
 * ('public','friends')` (the label is `buddies`). Postgres rejects an unknown
 * ENUM literal outright — 22P02 — so PostgREST fails the WHOLE request;
 * supabase-js RETURNS that error rather than throwing, so `try/catch` never
 * fires and `{ data }` is quietly `undefined`. The CHECK-constrained TEXT
 * variant is quieter still: no error, the predicate just matches nothing.
 *
 * WHY 668 TEST FILES COULD NOT SEE IT
 * -----------------------------------
 * Every fake Supabase client here implements a filter as
 * `filters.push(r => r[col] === val)`. It asks "does my fixture's value appear
 * in what you passed?", never "is what you passed a real label?". The mechanism
 * was isolated by a pair of mutations: replacing BOTH literals of an
 * `.in('status', […])` with nonsense turned the suite RED (the double does
 * filter), while replacing only the ALREADY-DEAD literal left it GREEN 33/33.
 * So a fixture written from a fiction PINS the fiction — three suites were
 * found green AND load-bearing on values the database rejects outright.
 *
 * That is the whole reason this contract compares literals to the SCHEMA and
 * not to a double. It is the durable fix; the individual repairs were the
 * backlog.
 *
 * WHAT WOULD MAKE THIS TEST VACUOUS, AND THE POSITIVE CONTROLS AGAINST IT
 * -----------------------------------------------------------------------
 * Two ways: the vocabulary model could silently collapse (then nothing is
 * judged), or the extractor could stop finding sites (then nothing is checked).
 * Both are asserted directly below, on named real columns and a fixture that
 * plants a dead literal in each supported filter form.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCanonicalVocabulary,
  vocabularyFromCheck,
  type CanonicalVocabulary,
} from "../scripts/lib/canonicalVocabulary.js";
import {
  extractFilterLiterals,
  parseInList,
  parseLogicalTree,
} from "../scripts/lib/filterLiteralExtract.js";
import {
  findDeadLiterals,
  partition,
  ratchetKey,
  KNOWN_DEAD_LITERALS,
  API_ROOT,
  SCAN_DIRS,
  BASELINE,
  MIGRATION_DIRS,
  KNOWN_DEAD_WRITE_LITERALS,
} from "../scripts/checkEnumLiterals.js";
import { NON_ACTIVE_ACCOUNT_STATUSES } from "../lib/mediaEligibility.js";

let cachedVocab: CanonicalVocabulary | null = null;
const vocab = (): CanonicalVocabulary =>
  (cachedVocab ??= buildCanonicalVocabulary(BASELINE, MIGRATION_DIRS));

let cachedSites: ReturnType<typeof extractFilterLiterals> | null = null;
const sites = () => (cachedSites ??= extractFilterLiterals(SCAN_DIRS, API_ROOT));

describe("canonical vocabulary — the model the check judges against", () => {
  it("models a plausible number of columns", () => {
    // A collapsed parse would make every literal unjudged and the check vacuous.
    assert.ok(
      vocab().values.size > 200,
      `only ${vocab().values.size} columns carry a vocabulary — the parse broke`,
    );
  });

  it("derives enum labels from the baseline, not from database.types.ts", () => {
    for (const [key, expected] of [
      ["trips.status", ["active", "archived", "cancelled", "completed", "draft", "planning", "upcoming"]],
      ["events.state", ["archived", "cancelled", "completed", "draft", "full", "open", "started", "waitlist"]],
      ["posts.status", ["active", "deleted", "hidden", "reported"]],
      ["hidden_gems.status", ["active", "hidden", "merged", "pending"]],
      ["trips.visibility", ["buddies", "invite", "private", "public"]],
      ["events.visibility", ["friends_only", "invite_only", "public"]],
    ] as const) {
      const got = vocab().values.get(key);
      assert.ok(got, `${key} should carry an enum vocabulary`);
      assert.deepEqual([...got].sort(), [...expected].sort(), `${key} labels`);
    }
  });

  it("distinguishes the two confusable columns on posts", () => {
    // posts.status is `post_status`; posts.post_status is `delayed_post_status`.
    // Conflating them is how `.eq("post_status","published")` and
    // `.eq("status","published")` both looked plausible while one was dead.
    assert.ok(vocab().values.get("posts.status")!.has("active"));
    assert.ok(!vocab().values.get("posts.status")!.has("published"));
    assert.ok(vocab().values.get("posts.post_status")!.has("published"));
    assert.ok(!vocab().values.get("posts.post_status")!.has("active"));
  });

  it("derives CHECK vocabularies for TEXT columns, and honours later widening", () => {
    for (const [key, must] of [
      ["plan_attendance_events.event_type", "suspicious"],
      ["stamp_generation_queue.status", "generating"],
      ["post_media.processing_status", "ready"],
      ["profiles.account_status", "deactivated"],
      // Widened by 2178 long after the baseline — proves migrations are replayed.
      ["user_deletion_requests.status", "executing"],
      // Widened by 2298, this batch's own migration.
      ["rank_events.surface", "wall"],
      ["circle_presence.status", "paused"],
    ] as const) {
      const got = vocab().values.get(key);
      assert.ok(got, `${key} should carry a CHECK vocabulary`);
      assert.ok(got.has(must), `${key} should permit "${must}" — got ${[...got].sort().join(" | ")}`);
    }
  });

  it("absorbs a widening written inside a `DO $$ … $$` block", () => {
    // THE BLIND SPOT THIS CLOSES. `splitStatements` keeps a `$$` body intact so
    // its inner semicolons do not split the outer statement — which left every
    // ALTER inside the repo's own idempotency idiom invisible, because the
    // statement begins `DO`, not `ALTER TABLE`. The model then kept reporting
    // the PRE-migration vocabulary and called a live, schema-legal literal dead.
    // That is a FALSE FAILURE, the one direction this check must never fail in:
    // it demands a correct literal be "repaired" into one nothing writes.
    //
    // Migration 2302 widens plan_attendance_events_event_type_check that way.
    const pae = vocab().values.get("plan_attendance_events.event_type");
    assert.ok(pae, "plan_attendance_events.event_type must carry a CHECK vocabulary");
    for (const label of [
      "suspicious_check_in",
      "checked_in_successfully",
      "late_check_in",
      "host_manual_override",
    ]) {
      assert.ok(
        pae.has(label),
        `2302 admits "${label}" inside a DO block — got ${[...pae].sort().join(" | ")}`,
      );
    }
    // The four legacy labels are RETAINED by 2302, not replaced.
    assert.ok(pae.has("suspicious") && pae.has("excused"));
  });

  it("absorbs a DO-wrapped DROP+ADD on a fixture, and still honours the DROP", () => {
    // A synthetic control, so this survives 2302 being superseded one day.
    const dir = mkdtempSync(join(tmpdir(), "vocab-do-"));
    try {
      const baseline = join(dir, "baseline.sql");
      writeFileSync(
        baseline,
        "CREATE TABLE public.widgets (\n" +
          "    state text NOT NULL,\n" +
          "    CONSTRAINT widgets_state_check CHECK ((state = ANY (ARRAY['old'::text])))\n" +
          ");\n",
      );
      const migrations = join(dir, "migrations");
      mkdirSync(migrations);
      writeFileSync(
        join(migrations, "9001_widen.sql"),
        "DO $$\nBEGIN\n" +
          "  ALTER TABLE public.widgets DROP CONSTRAINT IF EXISTS widgets_state_check;\n" +
          "  ALTER TABLE public.widgets ADD CONSTRAINT widgets_state_check\n" +
          "    CHECK (state IN ('old', 'new'));\n" +
          "END $$;\n",
      );
      const built = buildCanonicalVocabulary(baseline, [migrations]);
      assert.deepEqual(
        [...(built.values.get("widgets.state") ?? [])].sort(),
        ["new", "old"],
        "a DO-wrapped DROP+ADD must replace the old vocabulary, not be ignored",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not invent a vocabulary for a plain unconstrained TEXT column", () => {
    // Declining to judge is the whole reason a false failure is unlikely here.
    assert.equal(vocab().values.get("user_account_states.state"), undefined);
  });

  it("parses both CHECK spellings the repo uses", () => {
    const anyForm = vocabularyFromCheck(
      "(status = ANY (ARRAY['a'::text, 'b'::text]))",
    );
    assert.deepEqual([...(anyForm.get("status") ?? [])].sort(), ["a", "b"]);
    const inForm = vocabularyFromCheck("status IN ('a', 'b', 'c')");
    assert.deepEqual([...(inForm.get("status") ?? [])].sort(), ["a", "b", "c"]);
    // A predicate this parser does not understand yields nothing, so the column
    // stays unmodelled rather than getting a vocabulary that was guessed.
    assert.equal(vocabularyFromCheck("(char_length(bio) <= 500)").size, 0);
  });
});

describe("filter-literal extraction", () => {
  it("finds a plausible number of judged sites", () => {
    const judged = sites().sites.filter((s) => vocab().values.has(`${s.table}.${s.column}`));
    assert.ok(
      judged.length > 500,
      `only ${judged.length} literals sit on a modelled column — the extractor broke`,
    );
  });

  it("resolves a chain that spans statements through its identifier", () => {
    // routes/compassHome.ts builds `let q = sc.from("events")…` then reassigns
    // `q`, so the filter call is not syntactically under the `.from()`.
    const hit = sites().sites.find(
      (s) => s.file.endsWith("routes/compassHome.ts") && s.table === "events",
    );
    assert.ok(hit, "compassHome's events chain must resolve to the events table");
  });

  it("reads .not(col, op, val) and .or(...) forms, not just .eq/.neq/.in", () => {
    const ops = new Set(sites().sites.map((s) => s.op));
    for (const op of ["eq", "neq", "in", "not.in", "or.eq"]) {
      assert.ok(ops.has(op), `no site extracted for the "${op}" form`);
    }
  });

  it("splits PostgREST in-lists and logical trees", () => {
    assert.deepEqual(parseInList('("draft","cancelled","archived")'), [
      "draft", "cancelled", "archived",
    ]);
    assert.deepEqual(parseInList("(a,b)"), ["a", "b"]);
    assert.deepEqual(parseLogicalTree("state.eq.deleted,state.neq.banned"), [
      { column: "state", op: "eq", value: "deleted" },
      { column: "state", op: "neq", value: "banned" },
    ]);
    assert.deepEqual(parseLogicalTree("and(a.eq.x,b.eq.y)"), [
      { column: "a", op: "eq", value: "x" },
      { column: "b", op: "eq", value: "y" },
    ]);
  });
});

describe("the guard catches a newly-introduced dead literal", () => {
  /**
   * MUTATION PROOF, run in-process rather than by hand.
   *
   * A fixture module is written to a temp directory carrying one dead literal
   * in EACH supported form, and the real vocabulary is used to judge it. If the
   * extractor or the model ever stops working, this goes red — which is the
   * property the thirty-two production sites needed and did not have.
   */
  const forms: Array<{ name: string; code: string; op: string; literal: string }> = [
    { name: "eq", code: `.eq("status", "in_progress")`, op: "eq", literal: "in_progress" },
    { name: "neq", code: `.neq("status", "banned")`, op: "neq", literal: "banned" },
    { name: "in", code: `.in("status", ["active", "totally_bogus"])`, op: "in", literal: "totally_bogus" },
    { name: "not.eq", code: `.not("status", "eq", "deleted_by_ghost")`, op: "not.eq", literal: "deleted_by_ghost" },
    { name: "not.in", code: `.not("status", "in", '("cancelled","banned")')`, op: "not.in", literal: "banned" },
    { name: "or.eq", code: `.or("status.eq.in_progress")`, op: "or.eq", literal: "in_progress" },
  ];

  for (const form of forms) {
    it(`flags a dead trips.status literal in the ${form.name} form`, () => {
      const dir = mkdtempSync(join(tmpdir(), "enum-literal-guard-"));
      try {
        mkdirSync(join(dir, "routes"), { recursive: true });
        writeFileSync(
          join(dir, "routes", "fixture.ts"),
          `export async function f(sc: any) {\n` +
            `  // .eq("status", "in_progress") in a COMMENT must NOT be flagged.\n` +
            `  const { data } = await sc.from("trips").select("id")${form.code};\n` +
            `  return data;\n}\n`,
        );
        const found = findDeadLiterals(
          extractFilterLiterals([dir], dir).sites,
          vocab(),
        );
        assert.equal(found.length, 1, `expected exactly one finding, got ${JSON.stringify(found)}`);
        assert.equal(found[0]!.table, "trips");
        assert.equal(found[0]!.column, "status");
        assert.equal(found[0]!.literal, form.literal);
        assert.equal(found[0]!.op, form.op);
        assert.ok(found[0]!.allowed.includes("active"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("does NOT flag a real label, and does not flag a near-miss on another table", () => {
    const dir = mkdtempSync(join(tmpdir(), "enum-literal-guard-ok-"));
    try {
      mkdirSync(join(dir, "routes"), { recursive: true });
      writeFileSync(
        join(dir, "routes", "ok.ts"),
        `export async function f(sc: any) {\n` +
          `  await sc.from("trips").select("id").eq("status", "active");\n` +
          // reviews.state genuinely IS published | hidden | removed. A check that
          // flagged this would be worse than no check.
          `  await sc.from("reviews").select("id").eq("state", "published");\n` +
          // events.visibility genuinely IS friends_only — a different enum from
          // trips.visibility, where "friends" is dead. Table-awareness is the
          // whole point.
          `  await sc.from("events").select("id").in("visibility", ["public", "friends_only"]);\n` +
          `}\n`,
      );
      const found = findDeadLiterals(extractFilterLiterals([dir], dir).sites, vocab());
      assert.deepEqual(found, [], `false positives: ${JSON.stringify(found)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the repository is clean, and the ratchet is honest", () => {
  it("no filter literal in src/ names a value its column cannot hold", () => {
    const { fresh } = partition(findDeadLiterals(sites().sites, vocab()), KNOWN_DEAD_LITERALS);
    assert.deepEqual(
      fresh.map((f) => `${f.file}:${f.line} ${f.table}.${f.column} "${f.literal}"`),
      [],
    );
  });

  it("every ratchet entry still corresponds to a real site, at the recorded count", () => {
    // Fails in BOTH directions: a fixed entry left on the list fails just as a
    // new dead literal does, so the list cannot quietly stop meaning anything.
    const { staleRatchetKeys, miscounted } = partition(
      findDeadLiterals(sites().sites, vocab()),
      KNOWN_DEAD_LITERALS,
    );
    assert.deepEqual(staleRatchetKeys, [], "ratchet entries with no matching site");
    assert.deepEqual(miscounted, [], "ratchet entries whose count is wrong");
  });

  it("the ratchet never grows past what this batch recorded", () => {
    // EXACT, not `<= 4`. The ceiling was written when the list held 4; it has
    // since shrunk to 2, and a stale ceiling is slack — it silently permitted
    // growing back to 4 without going red, which is the one direction a
    // shrink-only ratchet forbids. An exact count fails in BOTH directions: add
    // an entry and it fails, fix one without striking it off and it fails (that
    // second half is also caught by staleRatchetKeys above).
    //
    // When an entry is genuinely repaired, lower this number in the same commit.
    // That is not busywork — it is the only place the list's progress is asserted
    // rather than described.
    assert.equal(
      Object.keys(KNOWN_DEAD_LITERALS).length, 2,
      "KNOWN_DEAD_LITERALS must shrink toward zero, never grow — a new dead " +
        "literal is a defect to fix, not an entry to add. If you repaired one, " +
        "strike the entry AND lower this count.",
    );
  });

  it("the WRITE ratchet is exact too, and every entry is a live defect", () => {
    // Kept separate from KNOWN_DEAD_LITERALS deliberately: merging them would
    // bury the filter list's progress (2, heading for 0) inside a combined 15.
    assert.equal(
      Object.keys(KNOWN_DEAD_WRITE_LITERALS).length, 13,
      "KNOWN_DEAD_WRITE_LITERALS is shrink-only. Every entry is a row the " +
        "database REJECTS — 22P02 on an enum, 23514 on a text CHECK — so unlike " +
        "the read side these are not quiet misses, they are writes that never " +
        "landed. Fix one, strike it, and lower this count.",
    );
    for (const [key, entry] of Object.entries(KNOWN_DEAD_WRITE_LITERALS)) {
      assert.match(key, /^src\/.+\.ts:[a-z0-9_]+\.[a-z0-9_]+:.+$/, `malformed key ${key}`);
      assert.ok(entry.count >= 1, `${key} count must be >= 1`);
      assert.ok(entry.note.length > 40, `${key} needs a real reason, not a label`);
    }
  });

  it("the two ratchets never name the same key", () => {
    // A key in both maps would be counted once by the merged partition and
    // twice by the two ceilings above, so one of them could then be wrong
    // without failing.
    const overlap = Object.keys(KNOWN_DEAD_WRITE_LITERALS)
      .filter((k) => k in KNOWN_DEAD_LITERALS);
    assert.deepEqual(overlap, [], "a key may live on exactly one ratchet");
  });

  it("every ratchet key is well-formed and carries a reason", () => {
    for (const [key, entry] of Object.entries(KNOWN_DEAD_LITERALS)) {
      assert.match(key, /^src\/.+\.ts:[a-z0-9_]+\.[a-z0-9_]+:.+$/, `malformed key ${key}`);
      assert.ok(entry.count >= 1, `${key} count must be >= 1`);
      assert.ok(entry.note.length > 40, `${key} needs a real reason, not a label`);
    }
  });

  it("NON_ACTIVE_ACCOUNT_STATUSES is exactly the CHECK vocabulary minus 'active'", () => {
    // lib/circleLocationsRead.ts:245-250 objects to denylisting account status
    // because it "would silently start serving any status added later". The
    // media-eligibility gate keeps the denylist shape (its callers' doubles
    // model `.in`, not `.neq`) and answers that objection here instead: widen
    // profiles_account_status_check without widening the constant and this
    // goes red.
    const declared = vocab().values.get("profiles.account_status");
    assert.ok(declared, "profiles.account_status must carry a CHECK vocabulary");
    const expected = [...declared].filter((v) => v !== "active").sort();
    assert.deepEqual([...NON_ACTIVE_ACCOUNT_STATUSES].sort(), expected);
  });

  it("ratchetKey is stable against the shape findDeadLiterals emits", () => {
    const f = { file: "src/x.ts", table: "t", column: "c", literal: "v" };
    assert.equal(ratchetKey(f), "src/x.ts:t.c:v");
  });
});

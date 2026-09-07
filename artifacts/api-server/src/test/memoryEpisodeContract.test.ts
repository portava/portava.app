/**
 * The canonical Memory object — proof.
 *
 * Five properties, each one a thing that would be a defect if it were not true:
 *
 *   1. an episode records its detection reason and version (and detection is
 *      replayable — same detector, same version, same inputs, one episode);
 *   2. evidence is append-only;
 *   3. the lifecycle refuses an illegal transition;
 *   4. erasure removes both the episode and its evidence;
 *   5. a failed read never fabricates an episode.
 *
 * Pure and offline. Two halves:
 *   * the TS contract, exercised directly with a hand-rolled fake client (the
 *     memoryLifecycle.test.ts pattern — no Supabase import, no network, no DB);
 *   * migration 2320 read AS TEXT, which is how the SQL-side guarantees
 *     (append-only trigger, grants, the eligibility CHECK, the erasure body) are
 *     pinned without a database — the migrationLedger.test.ts / intelOutcomes
 *     .test.ts pattern already used for every other RLS+postcondition migration.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DETECTION_REASONS,
  EPISODE_KINDS,
  EPISODE_STATES,
  EPISODE_TRANSITIONS,
  RETENTION_CLASSES,
  SIGNIFICANCE_BASES,
  SOURCE_CLASSES,
  TERMINAL_EPISODE_STATES,
  TRUTH_LEVELS,
  canTransition,
  decideTransition,
  initialEpisodeState,
  isEligibleForMemory,
  parseEpisodeRow,
  parseEvidenceRow,
  readEpisode,
  readEvidence,
  type EpisodeState,
  type MemoryEvidence,
} from "../memory/memoryEpisodeContract.js";

const MIGRATION = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations/2320_memory_episode_provenance_spine.sql",
);
const sql = readFileSync(MIGRATION, "utf8");

/* ─────────────────────────────── fixtures ───────────────────────────────── */

const USER = "11111111-1111-4111-8111-111111111111";
const EPISODE = "22222222-2222-4222-8222-222222222222";

/** A well-formed episode row as the database would return it. */
function episodeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EPISODE,
    user_id: USER,
    episode_kind: "meal",
    summary: "Dinner in Da Nang",
    started_at: "2026-09-01T12:00:00.000Z",
    ended_at: "2026-09-01T14:00:00.000Z",
    place_id: "place-abc",
    city: "Da Nang",
    country: "VN",
    detection_reason: "dwell_cluster",
    detector_version: 3,
    detection_digest: "digest-xyz",
    significance: 0.7,
    significance_basis: "outcome_recorded",
    state: "active",
    state_changed_at: "2026-09-01T15:00:00.000Z",
    merged_into_id: null,
    sensitivity: "normal",
    visibility: "private",
    retention_class: "trip_context",
    created_at: "2026-09-01T15:00:00.000Z",
    updated_at: "2026-09-01T15:00:00.000Z",
    ...over,
  };
}

function evidenceRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    episode_id: EPISODE,
    user_id: USER,
    truth_level: "observed",
    source_class: "explicit",
    source_table: "memory_events",
    source_id: "evt-1",
    source_ref: { table: "memory_events", id: "evt-1" },
    observed_at: "2026-09-01T12:30:00.000Z",
    recorded_at: "2026-09-01T15:00:00.000Z",
    weight: 0.9,
    ...over,
  };
}

const anEvidence = (over: Partial<MemoryEvidence> = {}): MemoryEvidence => ({
  ...(parseEvidenceRow(evidenceRow()) as MemoryEvidence),
  ...over,
});

/**
 * A minimal fake of the two client shapes the contract uses. No Supabase import,
 * no credentials, no network — the check-guard-coverage scanner requires that a
 * test naming no credential env var also reaches no Supabase.
 */
type Outcome =
  | { kind: "row"; row: unknown }
  | { kind: "rows"; rows: unknown }
  | { kind: "error"; message: string }
  | { kind: "throw"; message: string };

function fakeClient(outcome: Outcome) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.maybeSingle = async () => {
    if (outcome.kind === "throw") throw new Error(outcome.message);
    if (outcome.kind === "error") return { data: null, error: { message: outcome.message } };
    if (outcome.kind === "row") return { data: outcome.row, error: null };
    return { data: null, error: null };
  };
  // `readEvidence` awaits the builder itself (no .maybeSingle()), so it is a thenable.
  builder.then = (
    res: (v: { data: unknown; error: unknown }) => unknown,
    rej: (e: unknown) => unknown,
  ) => {
    if (outcome.kind === "throw") return Promise.resolve().then(() => rej(new Error(outcome.message)));
    if (outcome.kind === "error") return Promise.resolve(res({ data: null, error: { message: outcome.message } }));
    if (outcome.kind === "rows") return Promise.resolve(res({ data: outcome.rows, error: null }));
    return Promise.resolve(res({ data: null, error: null }));
  };
  return { from: () => builder } as unknown as Parameters<typeof readEpisode>[0];
}

/* ═══════════════ 1. detection reason + version are recorded ══════════════ */

describe("an episode records its detection reason and version", () => {
  it("carries the reason code and the detector version through the parse", () => {
    const ep = parseEpisodeRow(episodeRow());
    assert.ok(ep, "a well-formed row must parse");
    assert.equal(ep!.detection.reason, "dwell_cluster");
    assert.equal(ep!.detection.version, 3);
    assert.equal(ep!.detection.digest, "digest-xyz");
  });

  it("refuses a row with no detection reason — an episode nobody can explain is not an episode", () => {
    assert.equal(parseEpisodeRow(episodeRow({ detection_reason: null })), null);
    assert.equal(parseEpisodeRow(episodeRow({ detection_reason: "" })), null);
  });

  it("refuses a detection reason outside the vocabulary rather than passing it through", () => {
    assert.equal(parseEpisodeRow(episodeRow({ detection_reason: "vibes" })), null);
  });

  it("refuses a missing or pre-1 detector version — an unversioned detection cannot be replayed", () => {
    assert.equal(parseEpisodeRow(episodeRow({ detector_version: null })), null);
    assert.equal(parseEpisodeRow(episodeRow({ detector_version: 0 })), null);
    assert.equal(parseEpisodeRow(episodeRow({ detector_version: "3" })), null);
  });

  it("the SQL requires both, and versions from 1", () => {
    assert.match(sql, /detection_reason\s+text\s+NOT NULL/);
    assert.match(sql, /detector_version\s+integer\s+NOT NULL CHECK \(detector_version >= 1\)/);
  });

  it("detection is replayable: the same detector at the same version over the same inputs is one episode", () => {
    // The uniqueness key IS the replay guarantee.
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS memory_episodes_replay_key[\s\S]*?\(user_id, detection_reason, detector_version, detection_digest\)/,
    );
  });

  it("every TS detection reason is a literal the CHECK constraint can hold", () => {
    for (const r of DETECTION_REASONS) {
      assert.ok(sql.includes(`'${r}'`), `detection reason ${r} is not in the migration`);
    }
  });

  it("every other TS vocabulary is likewise writable", () => {
    for (const v of [...EPISODE_KINDS, ...SIGNIFICANCE_BASES, ...TRUTH_LEVELS, ...SOURCE_CLASSES, ...EPISODE_STATES]) {
      assert.ok(sql.includes(`'${v}'`), `${v} is not a literal the migration can hold`);
    }
    // Retention classes are referenced by FK, not restated as a CHECK.
    assert.equal(RETENTION_CLASSES.length, 6);
    assert.match(sql, /REFERENCES public\.memory_policy\(retention_class\)/);
  });
});

/* ═══════════════════════ 2. evidence is append-only ═════════════════════ */

describe("evidence is append-only", () => {
  it("UPDATE is blocked by a row-level trigger", () => {
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.memory_evidence_no_update\(\)/);
    assert.match(sql, /memory_evidence is append-only: UPDATE is not permitted/);
    assert.match(
      sql,
      /CREATE TRIGGER trg_memory_evidence_no_update\s+BEFORE UPDATE ON public\.memory_evidence\s+FOR EACH ROW/,
    );
  });

  it("UPDATE is also withheld at the grant — belt as well as braces", () => {
    assert.match(sql, /GRANT INSERT, SELECT, DELETE\s+ON public\.memory_evidence TO service_role/);
    // The one grant line for evidence must not mention UPDATE at all.
    const grants = sql.match(/GRANT[^;]*ON public\.memory_evidence[^;]*;/g) ?? [];
    assert.ok(grants.length > 0, "evidence must have a grant line to check");
    for (const g of grants) assert.ok(!/UPDATE/.test(g), `evidence grant must not include UPDATE: ${g}`);
  });

  it("a postcondition proves both, so a later edit that loosens either fails the migration", () => {
    assert.match(sql, /POSTCONDITION FAILED: memory_evidence is UPDATE-able/);
    assert.match(sql, /POSTCONDITION FAILED: memory_evidence append-only trigger missing/);
  });

  it("DELETE stays open — erasure and the profiles cascade must be able to purge it", () => {
    assert.match(sql, /GRANT INSERT, SELECT, DELETE\s+ON public\.memory_evidence TO service_role/);
  });

  it("the trigger function is revoked from anon/authenticated (the 2183 default-grant trap)", () => {
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.memory_evidence_no_update\(\) FROM PUBLIC, anon, authenticated/,
    );
  });

  it("append idempotency: re-citing the same source at the same truth level is one row", () => {
    assert.match(
      sql,
      /CREATE UNIQUE INDEX IF NOT EXISTS memory_evidence_dedupe_idx[\s\S]*?\(episode_id, source_table, source_id, truth_level\)/,
    );
  });

  it("the TS side treats a correction as a new row: there is no evidence mutator exported", async () => {
    const mod = await import("../memory/memoryEpisodeContract.js");
    const mutators = Object.keys(mod).filter((k) => /^(update|patch|edit|mutate)/i.test(k));
    assert.deepEqual(mutators, [], `the contract must expose no evidence mutator, found ${mutators.join(", ")}`);
  });
});

/* ══════════════ 3. the lifecycle refuses an illegal transition ══════════ */

describe("the lifecycle refuses an illegal transition", () => {
  const scored = { significance: 0.8, significanceBasis: "outcome_recorded" };

  it("walks the spec's happy path", () => {
    assert.ok(canTransition("candidate", "confirmed", scored));
    assert.ok(canTransition("confirmed", "active", scored));
    assert.ok(canTransition("active", "archived", scored));
  });

  it("refuses a skip up the path — candidate may not jump straight to active", () => {
    const d = decideTransition("candidate", "active", scored);
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, "not_permitted");
  });

  it("refuses to leave a terminal state", () => {
    for (const t of TERMINAL_EPISODE_STATES) {
      const d = decideTransition(t, "active", scored);
      assert.equal(d.ok, false, `${t} must be terminal`);
      assert.equal(d.ok === false && d.reason, "terminal");
      assert.deepEqual(EPISODE_TRANSITIONS[t], [], `${t} must have no outbound transitions`);
    }
  });

  it("refuses a self-transition — re-asserting a state is not a transition", () => {
    const d = decideTransition("active", "active", scored);
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, "self_transition");
  });

  it("refuses a state outside the vocabulary, in either position", () => {
    assert.equal(decideTransition("published", "active", scored).ok, false);
    assert.equal(decideTransition("active", "published", scored).ok, false);
    // 'published' is a `memories` (album) state and 'retracted' a
    // memory_projections one. Neither belongs to an episode; borrowing a
    // neighbour's vocabulary is exactly the confusion this object exists to end.
    for (const foreign of ["published", "removed", "retracted", "decayed", "suggested", "dismissed"]) {
      assert.ok(!(EPISODE_STATES as readonly string[]).includes(foreign), `${foreign} must not be an episode state`);
    }
  });

  it("refuses a merge that does not name its survivor", () => {
    const d = decideTransition("active", "merged", scored);
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, "merge_needs_survivor");
    assert.ok(canTransition("active", "merged", { ...scored, mergedIntoId: EPISODE }));
  });

  it("RAW SENSING DOES NOT BECOME MEMORY: promotion without a significance assessment is refused", () => {
    const d = decideTransition("candidate", "confirmed", {});
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.reason, "not_significant");
    // A score with no basis is an unexplained number; a basis with no score is
    // an unquantified claim. Neither is an assessment.
    assert.equal(decideTransition("candidate", "confirmed", { significance: 0.9 }).ok, false);
    assert.equal(decideTransition("candidate", "confirmed", { significanceBasis: "rarity" }).ok, false);
    assert.ok(canTransition("candidate", "confirmed", { significance: 0.9, significanceBasis: "rarity" }));
  });

  it("the PARSER refuses a promoted row with no significance — a corrupt row is not surfaced as Memory", () => {
    // 2320's CHECK makes this row unwritable, so its arrival means corruption or
    // a bypassed writer. Either way it must not become a Memory nobody can
    // justify, and it must not be silently downgraded to a candidate.
    for (const state of ["confirmed", "active", "archived"]) {
      assert.equal(
        parseEpisodeRow(episodeRow({ state, significance: null, significance_basis: null })),
        null,
        `${state} with no significance assessment must be refused`,
      );
      // Half an assessment is not an assessment.
      assert.equal(parseEpisodeRow(episodeRow({ state, significance_basis: null })), null);
      assert.equal(parseEpisodeRow(episodeRow({ state, significance: null })), null);
    }
    // The unscored states still parse without one — a candidate is allowed to be
    // nothing but a detection.
    assert.ok(parseEpisodeRow(episodeRow({ state: "candidate", significance: null, significance_basis: null })));
    assert.ok(parseEpisodeRow(episodeRow({ state: "rejected", significance: null, significance_basis: null })));
  });

  it("but a candidate may always be discarded without ever being scored", () => {
    assert.ok(canTransition("candidate", "rejected", {}));
    assert.ok(canTransition("candidate", "deleted", {}));
  });

  it("the machine is total: every state has an entry and every target is a real state", () => {
    for (const s of EPISODE_STATES) {
      assert.ok(Array.isArray(EPISODE_TRANSITIONS[s]), `${s} has no entry in the machine`);
      for (const t of EPISODE_TRANSITIONS[s]) {
        assert.ok((EPISODE_STATES as readonly string[]).includes(t), `${s} -> ${t} targets an unknown state`);
        assert.notEqual(t, s, `${s} must not transition to itself`);
      }
    }
  });

  it("the illegal set is genuinely large — this is a machine, not an allow-everything", () => {
    let legal = 0;
    for (const a of EPISODE_STATES) for (const b of EPISODE_STATES) if (EPISODE_TRANSITIONS[a].includes(b)) legal += 1;
    const total = EPISODE_STATES.length * EPISODE_STATES.length;
    assert.ok(legal < total / 2, `${legal}/${total} transitions legal — the machine is too permissive to be one`);
  });

  it("archived is NOT terminal: a shelved Memory can come back", () => {
    assert.ok(!TERMINAL_EPISODE_STATES.has("archived" as EpisodeState));
    assert.ok(canTransition("archived", "active", scored));
  });

  it("a new episode starts as a candidate, matching the column default", () => {
    assert.equal(initialEpisodeState(), "candidate");
    assert.match(sql, /state\s+text NOT NULL DEFAULT 'candidate'/);
  });

  it("the SQL owns the vocabulary and refuses a promoted state with no significance", () => {
    assert.match(sql, /CONSTRAINT memory_episodes_eligibility_check CHECK \(/);
    assert.match(sql, /state IN \('candidate','rejected','deleted'\)\s*\n\s*OR \(significance IS NOT NULL AND significance_basis IS NOT NULL\)/);
    assert.match(sql, /POSTCONDITION FAILED: memory_episodes_eligibility_check missing/);
  });
});

/* ═══════════ 4. erasure removes both the episode and its evidence ═══════ */

describe("erasure removes both the episode and its evidence", () => {
  const fn = sql.slice(sql.indexOf("CREATE FUNCTION public.erase_memory_for_user"));

  it("extends the EXISTING erase path rather than adding a second one", () => {
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.erase_memory_for_user\(uuid\);/);
    assert.match(sql, /CREATE FUNCTION public\.erase_memory_for_user\(p_user_id uuid\)/);
    // The three original purges must survive the widening.
    for (const t of ["memory_feedback", "memory_projections", "memory_events"]) {
      assert.match(fn, new RegExp(`DELETE FROM public\\.${t} WHERE user_id = p_user_id`));
    }
  });

  it("purges episodes and evidence in the same function", () => {
    assert.match(fn, /DELETE FROM public\.memory_evidence WHERE user_id = p_user_id/);
    assert.match(fn, /DELETE FROM public\.memory_episodes WHERE user_id = p_user_id/);
  });

  it("deletes evidence FIRST and BY USER — not by traversing episodes, not by cascade", () => {
    const ev = fn.indexOf("DELETE FROM public.memory_evidence");
    const ep = fn.indexOf("DELETE FROM public.memory_episodes");
    assert.ok(ev > 0 && ep > 0, "both deletes must be present");
    assert.ok(
      ev < ep,
      "evidence must be deleted before episodes: a forgotten memory must not survive in evidence if the episode delete fails",
    );
    // Keyed by user, so evidence whose episode is already gone is still caught.
    assert.match(fn, /DELETE FROM public\.memory_evidence WHERE user_id = p_user_id/);
  });

  it("does not rely on the FK cascade alone — the 2190 rule, because prod keeps a tombstone profile", () => {
    // The cascade exists as defence in depth...
    assert.match(sql, /episode_id\s+uuid NOT NULL REFERENCES public\.memory_episodes\(id\) ON DELETE CASCADE/);
    assert.match(sql, /user_id\s+uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
    // ...and the explicit purge exists because the cascade cannot fire in prod.
    assert.match(sql, /deliberately independent of any FK cascade/);
  });

  it("settles merge references before deleting, so a merged episode cannot block the purge", () => {
    assert.match(fn, /UPDATE public\.memory_episodes[\s\S]*?SET state = 'rejected', merged_into_id = NULL/);
  });

  it("reports what it deleted, so a caller can audit the purge", () => {
    assert.match(sql, /episodes_deleted\s+integer/);
    assert.match(sql, /evidence_deleted\s+integer/);
  });

  it("stays least-privilege after the DROP/CREATE — the trap 2190 warns about", () => {
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.erase_memory_for_user\(uuid\) FROM PUBLIC, anon, authenticated/,
    );
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.erase_memory_for_user\(uuid\) TO service_role/);
    assert.match(sql, /POSTCONDITION FAILED: a memory function is executable by anon\/authenticated/);
  });

  it("a postcondition reads the INSTALLED body, so a future edit that drops the purge fails loudly", () => {
    assert.match(sql, /pg_get_functiondef\(to_regprocedure\('public\.erase_memory_for_user\(uuid\)'\)\)/);
    assert.match(sql, /POSTCONDITION FAILED: erase_memory_for_user does not purge the provenance spine/);
  });

  it("both tables are declared in the deletion manifest, so the coverage guard can see them", async () => {
    const { ERASED_BY_CASCADE, POST_BASELINE_TABLES } = await import("../lib/deletionDispositions.js");
    for (const t of ["memory_episodes", "memory_evidence"]) {
      // Same bucket as memory_projections/events/feedback: "tables
      // AccountDeletionService clears today".
      assert.ok(ERASED_BY_CASCADE.includes(t), `${t} must be declared as cleared by AccountDeletionService`);
      assert.ok(POST_BASELINE_TABLES.includes(t), `${t} must be declared post-baseline`);
    }
  });
});

/* ═════════════ 5. a failed read never fabricates an episode ═════════════ */

describe("a failed read never fabricates an episode", () => {
  it("a transport error is a named refusal, not an episode and not a not-found", async () => {
    const r = await readEpisode(fakeClient({ kind: "error", message: "42703 column does not exist" }), USER, EPISODE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "read_failed");
    assert.ok(r.ok === false && r.reason === "read_failed" && r.detail.includes("42703"));
  });

  it("a thrown error is caught and reported, never propagated into a surface", async () => {
    const r = await readEpisode(fakeClient({ kind: "throw", message: "socket hang up" }), USER, EPISODE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "read_failed");
  });

  it("a missing row is not_found — distinct from a failure, so a caller cannot confuse them", async () => {
    const r = await readEpisode(fakeClient({ kind: "row", row: null }), USER, EPISODE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "not_found");
  });

  it("a corrupt row is unparsable — no defaults are invented to make it an episode", async () => {
    const r = await readEpisode(
      fakeClient({ kind: "row", row: episodeRow({ detection_reason: "vibes" }) }),
      USER,
      EPISODE,
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "unparsable");
  });

  it("no failure path ever carries an episode", async () => {
    for (const outcome of [
      { kind: "error", message: "boom" } as const,
      { kind: "throw", message: "boom" } as const,
      { kind: "row", row: null } as const,
      { kind: "row", row: episodeRow({ state: "published" }) } as const,
      { kind: "row", row: {} } as const,
      { kind: "row", row: "not an object" } as const,
    ]) {
      const r = await readEpisode(fakeClient(outcome), USER, EPISODE);
      assert.equal(r.ok, false, `${JSON.stringify(outcome)} must not produce an episode`);
      assert.ok(!("episode" in r), "a refusal must carry no episode field");
    }
  });

  it("a good row still reads through cleanly — the refusals are not just a broken reader", async () => {
    const r = await readEpisode(fakeClient({ kind: "row", row: episodeRow() }), USER, EPISODE);
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.episode.id, EPISODE);
    assert.equal(r.ok === true && r.episode.detection.reason, "dwell_cluster");
  });

  it("a failed EVIDENCE read is a refusal, never an empty list", async () => {
    const r = await readEvidence(fakeClient({ kind: "error", message: "down" }), USER, EPISODE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "read_failed");
    // This is the load-bearing distinction: isEligibleForMemory treats "no
    // evidence" as disqualifying, so "we could not check" must not look like it.
    const ok = await readEvidence(fakeClient({ kind: "rows", rows: [] }), USER, EPISODE);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.ok === true && ok.evidence, []);
  });

  it("unparsable evidence rows are dropped AND counted, so a partial read is visible", async () => {
    const r = await readEvidence(
      fakeClient({ kind: "rows", rows: [evidenceRow(), evidenceRow({ truth_level: "probably" }), null] }),
      USER,
      EPISODE,
    );
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.evidence.length, 1);
    assert.equal(r.ok === true && r.skipped, 2);
  });

  it("eligibility is denied when there is nothing to rest on", () => {
    const ep = parseEpisodeRow(episodeRow())!;
    assert.equal(isEligibleForMemory(ep, []), false);
    assert.equal(isEligibleForMemory(ep, [anEvidence()]), true);
    // Evidence belonging to another episode cannot prop this one up.
    assert.equal(isEligibleForMemory(ep, [anEvidence({ episodeId: "other" })]), false);
    assert.equal(isEligibleForMemory(ep, [anEvidence({ userId: "someone-else" })]), false);
  });

  it("an unscored episode is never eligible, however much evidence it has", () => {
    const ep = parseEpisodeRow(
      episodeRow({ state: "candidate", significance: null, significance_basis: null }),
    )!;
    assert.equal(isEligibleForMemory(ep, [anEvidence(), anEvidence()]), false);
  });
});

/* ════════════════════ inert by construction, and RLS posture ════════════ */

describe("the spine is inert by construction", () => {
  it("RLS is on and there is NO policy — deny-default is the whole access story", () => {
    assert.match(sql, /ALTER TABLE public\.memory_episodes ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /ALTER TABLE public\.memory_evidence ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(sql, /CREATE POLICY/);
    assert.match(sql, /POSTCONDITION FAILED: a policy exists on the provenance spine/);
  });

  it("anon and authenticated are revoked and never granted", () => {
    assert.match(sql, /REVOKE ALL ON public\.memory_episodes FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /REVOKE ALL ON public\.memory_evidence FROM PUBLIC, anon, authenticated/);
    assert.doesNotMatch(sql, /GRANT[^;\n]*ON public\.memory_(episodes|evidence)[^;\n]*TO (anon|authenticated)/);
    assert.match(sql, /POSTCONDITION FAILED: provenance spine readable by anon\/authenticated/);
  });

  it("no feature flag is seeded or flipped, and memory_projection is asserted still off", () => {
    assert.doesNotMatch(sql, /INSERT INTO public\.feature_flags/);
    assert.doesNotMatch(sql, /UPDATE public\.feature_flags/);
    assert.match(sql, /POSTCONDITION FAILED: memory_projection is enabled/);
  });

  it("it does not self-register in the migration ledger", () => {
    assert.doesNotMatch(sql, /schema_migration_ledger/);
  });

  it("it does not touch the highlights table, which another unit owns", () => {
    assert.doesNotMatch(sql, /\bhighlights\b/);
  });

  it("it does not touch the four neighbouring memory tables it must not overload", () => {
    for (const t of ["memory_items", "passport_memories", "compass_memories"]) {
      assert.ok(!new RegExp(`(ALTER|DROP|INSERT INTO|UPDATE) [^;]*\\b${t}\\b`).test(sql), `${t} must be untouched`);
    }
    // public.memories (the album) is only ever named in prose here.
    assert.ok(!/(ALTER|DROP|INSERT INTO|UPDATE) (TABLE )?public\.memories\b/.test(sql));
  });

  it("shape: one BEGIN, one COMMIT, additive and idempotent", () => {
    assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.memory_episodes/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.memory_evidence/);
    assert.doesNotMatch(sql, /^DROP TABLE/m);
  });

  it("preconditions state what it depends on", () => {
    assert.match(sql, /PRECONDITION FAILED: public\.memory_policy missing/);
    assert.match(sql, /PRECONDITION FAILED: public\.erase_memory_for_user\(uuid\) missing/);
  });

  it("no TS module outside the contract and this test imports the spine", async () => {
    // The proof that it is wired into nothing: the only importers are each other.
    const { execFileSync } = await import("node:child_process");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let out = "";
    try {
      out = execFileSync("grep", ["-rl", "memoryEpisodeContract", root, "--include=*.ts"], {
        encoding: "utf8",
      });
    } catch {
      out = "";
    }
    const importers = out
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(`${root}/`, ""))
      .filter((p) => !p.startsWith("memory/") && p !== "test/memoryEpisodeContract.test.ts");
    assert.deepEqual(importers, [], `the spine must be wired into nothing, found: ${importers.join(", ")}`);
  });
});

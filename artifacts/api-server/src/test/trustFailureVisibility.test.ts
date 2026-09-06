/**
 * Trust: a FAILED READ must never be reported as an EMPTY or CLEAN one.
 *
 * Every case here shared one shape. supabase-js RESOLVES `{ data, error }`
 * rather than rejecting, so a query that failed and a query that found nothing
 * arrive as the same object unless `error` is read. Across the trust engine that
 * `error` was dropped, and each drop turned an unreadable table into a confident
 * negative claim:
 *
 *   trust_events unreadable   → "this user has no history"     → score 50, PERSISTED
 *   trust_caps unreadable     → "no ceilings hold this user"   → uncapped score, PERSISTED
 *   trust_settings unreadable → "use the built-in weights"     → score under unchosen rules
 *   trust_caps unreadable     → "this account has no caps"     → shown to an admin as fact
 *   trust_profiles unreadable → "this user is not on probation" → fail-open on a sanction
 *   a failed reversal         → "0 caps lifted, 0 events dismissed" → same as nothing to do
 *
 * The first three are the severe ones because `recalculateTrustScore` does not
 * merely RETURN a number, it UPSERTS one into `trust_profiles` — the row every
 * display surface reads and that PassportProjectionService maps through
 * LEVEL_RANK into capability grants — stamped with a fresh
 * `last_recalculated_at` asserting it had just been measured.
 *
 * Run: node --import tsx/esm --test src/test/trustFailureVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  recalculateTrustScore,
  TrustInputUnavailableError,
} from "../services/trust/TrustScoreService.js";
import {
  getActiveCapsResult,
  liftCapsBySourceEvents,
} from "../services/trust/TrustCapService.js";
import { revokeModerationTrustConsequences } from "../services/trust/TrustAdminService.js";
import { getRecoveryStatus } from "../services/trust/TrustRecoveryService.js";
import { getSafeTrustSummary } from "../services/trust/TrustPrivacyGuard.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

const ADMIN  = "00000000-0000-0000-0000-0000000000ad";
const USER_A = "00000000-0000-0000-0000-000000000a01";

// ── Fake client with per-(table, op, select) failure injection ────────────────

interface FailSpec {
  table: string;
  /** Which operation to fail. Omit to fail every operation on the table. */
  op?: "select" | "update" | "insert" | "upsert";
  /** Only fail when the select column list contains this substring. */
  selectContains?: string;
}

const DB_ERROR = { code: "57014", message: "canceling statement due to statement timeout" };

function makeClient(tables: Record<string, any[]>, fail: FailSpec[] = []) {
  let idCounter = 1;

  function from(table: string) {
    if (!tables[table]) tables[table] = [];
    const store = tables[table];
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let selectArg = "";
    let op: "select" | "update" | "insert" | "upsert" = "select";
    let limitN: number | null = null;

    function shouldFail(): boolean {
      return fail.some((f) =>
        f.table === table &&
        (f.op === undefined || f.op === op) &&
        (f.selectContains === undefined || selectArg.includes(f.selectContains)));
    }

    const builder: any = {
      select(f?: string) { selectArg = f ?? ""; return builder; },
      insert(row: any) {
        op = "insert";
        const r = { id: `fk-${idCounter++}`, created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return builder;
      },
      upsert(row: any, opts?: any) {
        op = "upsert";
        const key = opts?.onConflict ?? "id";
        const idx = store.findIndex((r) => r[key] === row[key]);
        if (idx >= 0) { store[idx] = { ...store[idx], ...row }; pendingInsert = store[idx]; }
        else { const r = { id: `fk-${idCounter++}`, created_at: new Date().toISOString(), ...row }; store.push(r); pendingInsert = r; }
        return builder;
      },
      update(p: any) { op = "update"; pendingUpdate = p; return builder; },
      eq(c: string, v: any)    { filters.push((r) => r[c] === v); return builder; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
      is(c: string, v: any)    { filters.push((r) => v === null ? r[c] == null : r[c] === v); return builder; },
      gt(c: string, v: any)    { filters.push((r) => r[c] > v); return builder; },
      lt(c: string, v: any)    { filters.push((r) => r[c] < v); return builder; },
      or() { return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return resolve(true); },
      single()      { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };

    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    async function resolve(single: boolean) {
      // Injected failure. Mirrors postgrest-js: RESOLVES with an error, never rejects.
      if (shouldFail()) return { data: null, error: DB_ERROR, count: null };
      if (pendingUpdate) {
        const rows = matched();
        rows.forEach((r) => Object.assign(r, pendingUpdate));
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length };
      }
      if (pendingInsert) {
        return single ? { data: pendingInsert, error: null } : { data: [pendingInsert], error: null, count: 1 };
      }
      const rows = matched();
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length };
    }

    return builder;
  }

  return { from } as any;
}

/** A settings row identical to the shipped defaults. */
function settingsRow() {
  return {
    id: 1,
    weight_plan_attendance: 0.18, weight_host_quality: 0.12, weight_communication: 0.10,
    weight_respect_safety: 0.15, weight_location_honesty: 0.13, weight_content_quality: 0.08,
    weight_community_value: 0.08, weight_guide_accuracy: 0.08, weight_passport_auth: 0.08,
    decay_half_life_days: 90,
    level_building_trust: 35, level_reliable: 50, level_trusted: 65,
    level_highly_trusted: 78, level_city_trusted: 90,
  };
}

/** An EARNED profile: a real measurement that a failed read must not overwrite. */
function earnedProfile(userId = USER_A) {
  return {
    user_id: userId,
    overall_score: 92, public_level: "city_trusted",
    plan_attendance: 92, host_quality: 92, communication: 92, respect_safety: 92,
    location_honesty: 92, content_quality: 92, community_value: 92,
    guide_accuracy: 92, passport_authenticity: 92,
    on_probation: false, probation_ends_at: null,
    last_recalculated_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

function baseTables(): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: "trust_engine_enabled", enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: false },
    ],
    trust_settings: [settingsRow()],
    trust_events: [],
    trust_caps: [],
    trust_restrictions: [],
    trust_profiles: [],
    trust_reviews: [],
    trust_admin_actions: [],
    plan_attendance_events: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Trust scoring: an unreadable input must not become a persisted score", () => {
  it("trust_events read failure does NOT overwrite an earned profile with a fabricated 50", async () => {
    const tables = baseTables();
    tables.trust_profiles.push(earnedProfile());
    const db = makeClient(tables, [{ table: "trust_events", op: "select" }]);

    // Before: loadEvents returned [] on error, every category defaulted to the
    // neutral 50, the nine weights sum to 1.000, and 50 >= level_reliable — so a
    // timeout produced a confident `50 / reliable_traveler` and UPSERTED it over
    // this user's real 92.
    await assert.rejects(
      () => recalculateTrustScore(db, USER_A),
      (err: any) => {
        assert.ok(err instanceof TrustInputUnavailableError, "must be the typed input-unavailable error");
        assert.equal(err.input, "events");
        return true;
      },
      "a failed trust_events read must abort the recalculation, not score it as 'no history'",
    );

    const row = tables.trust_profiles.find((p) => p.user_id === USER_A);
    assert.equal(row.overall_score, 92, "the earned score must survive a failed read");
    assert.equal(row.public_level, "city_trusted", "a read failure must not demote a user");
  });

  it("trust_caps read failure does NOT launder a ceiling out of the persisted score", async () => {
    const tables = baseTables();
    // A capped user: strong positive history, held down by a permanent ceiling.
    tables.trust_profiles.push({ ...earnedProfile(), overall_score: 40, public_level: "building_trust", respect_safety: 40 });
    for (let i = 0; i < 8; i++) {
      tables.trust_events.push({
        id: `ev-${i}`, user_id: USER_A, category: "respect_safety",
        delta: 6, severity: "minor", status: "confirmed",
        created_at: new Date().toISOString(),
      });
    }
    tables.trust_caps.push({
      id: "cap-1", user_id: USER_A, category: "respect_safety",
      ceiling_score: 40, reason_code: "behavior_confirmed",
      expires_at: null, lifted_at: null,
    });

    const db = makeClient(tables, [{ table: "trust_caps", op: "select" }]);

    await assert.rejects(
      () => recalculateTrustScore(db, USER_A),
      (err: any) => err instanceof TrustInputUnavailableError && err.input === "caps",
      "an unreadable trust_caps must abort scoring — the ceiling is the only thing a good record cannot outrun",
    );

    const row = tables.trust_profiles.find((p) => p.user_id === USER_A);
    assert.equal(row.respect_safety, 40, "the ceiling must still be reflected in the persisted row");
    assert.equal(row.public_level, "building_trust", "a caps read failure must not re-grant a level the ceiling withheld");
  });

  it("trust_settings read failure does not silently score under the built-in weights", async () => {
    const tables = baseTables();
    const db = makeClient(tables, [{ table: "trust_settings", op: "select" }]);

    await assert.rejects(
      () => recalculateTrustScore(db, USER_A),
      (err: any) => err instanceof TrustInputUnavailableError && err.input === "settings",
    );
    assert.equal(tables.trust_profiles.length, 0, "nothing may be written when the scoring rules could not be read");
  });

  it("CONTROL: a genuinely empty trust_events (no error) still scores, and does not throw", async () => {
    const tables = baseTables();
    const db = makeClient(tables);
    // Deliberately asserts only the arithmetic, not whether it is persisted —
    // "no evidence" persistence is a separate question decided elsewhere.
    const r = await recalculateTrustScore(db, USER_A);
    assert.equal(r.overall_score, 50, "an absent history is still a legitimate computation, unlike an unreadable one");
  });

  it("CONTROL: an absent trust_settings ROW is still 'use the defaults'", async () => {
    const tables = baseTables();
    tables.trust_settings.length = 0; // no row — not an error
    const db = makeClient(tables);
    const r = await recalculateTrustScore(db, USER_A);
    assert.equal(r.public_level, "reliable_traveler");
  });
});

describe("Trust maintenance: a refusal to score is COUNTED, not silently written", () => {
  it("a caps read failure lands as recalcFailures and leaves every profile untouched", async () => {
    const tables = baseTables();
    tables.trust_profiles.push({ ...earnedProfile(), overall_score: 40, public_level: "building_trust" });
    tables.trust_events.push({
      id: "ev-new", user_id: USER_A, category: "respect_safety",
      delta: 6, severity: "minor", status: "confirmed",
      created_at: new Date().toISOString(),
    });
    tables.trust_caps.push({
      id: "cap-1", user_id: USER_A, category: "respect_safety",
      ceiling_score: 40, reason_code: "behavior_confirmed", expires_at: null, lifted_at: null,
    });

    // Only the READ fails; expireOldCaps' UPDATE still works, so this is a
    // partial outage of exactly the kind that used to pass silently.
    const db = makeClient(tables, [{ table: "trust_caps", op: "select" }]);

    const result = await runTrustMaintenance(db);

    assert.equal(result.usersRecalculated, 0, "a user whose inputs could not be read has not been recalculated");
    assert.equal(result.recalcFailures, 1, "the refusal must be COUNTED — this is the only place the outage becomes visible");
    const row = tables.trust_profiles.find((p) => p.user_id === USER_A);
    assert.equal(row.overall_score, 40, "the scheduled pass must not rewrite a capped profile from an unreadable caps table");
  });
});

describe("Trust caps: an unreadable cap list is not an empty one", () => {
  it("getActiveCapsResult distinguishes a failed read from an uncapped user", async () => {
    const tables = baseTables();
    const failing = makeClient(tables, [{ table: "trust_caps", op: "select" }]);
    const failed = await getActiveCapsResult(failing, USER_A);
    assert.deepEqual(failed.caps, []);
    assert.equal(failed.failed, true, "'I could not tell' must not be reported as 'no ceilings apply'");

    const clean = await getActiveCapsResult(makeClient(baseTables()), USER_A);
    assert.deepEqual(clean.caps, []);
    assert.equal(clean.failed, false, "a genuinely uncapped user must NOT be flagged as a failure");
  });

  it("liftCapsBySourceEvents reports a failed lift instead of returning a clean zero", async () => {
    const tables = baseTables();
    tables.trust_caps.push({
      id: "cap-1", user_id: USER_A, category: "respect_safety",
      ceiling_score: 40, reason_code: "behavior_confirmed",
      source_event_id: "ev-1", expires_at: null, lifted_at: null,
    });
    const db = makeClient(tables, [{ table: "trust_caps", op: "update" }]);

    const out = await liftCapsBySourceEvents(db, ["ev-1"], ADMIN);
    assert.equal(out.lifted, 0);
    assert.equal(out.failed, true, "a permanent ceiling that could not be lifted must not report as 'nothing to lift'");
    assert.equal(tables.trust_caps[0].lifted_at, null, "and the cap really is still standing");

    const ok = await liftCapsBySourceEvents(makeClient(baseTables()), ["ev-none"], ADMIN);
    assert.equal(ok.failed, false, "nothing to lift is a SUCCESS, not a failure");
  });
});

describe("Moderation reversal: never report consequences it did not actually reverse", () => {
  function tablesWithModerationFinding() {
    const tables = baseTables();
    tables.trust_events.push({
      id: "ev-mod", user_id: USER_A, event_type: "behavior_report_confirmed",
      category: "respect_safety", delta: -20, severity: "severe",
      status: "confirmed", source_type: "moderation",
      created_at: new Date().toISOString(),
    });
    tables.trust_caps.push({
      id: "cap-mod", user_id: USER_A, category: "respect_safety",
      ceiling_score: 40, reason_code: "behavior_confirmed",
      source_event_id: "ev-mod", expires_at: null, lifted_at: null,
    });
    return tables;
  }

  it("a failed cap lift is reported as incomplete — the permanent ceiling still stands", async () => {
    const tables = tablesWithModerationFinding();
    const db = makeClient(tables, [{ table: "trust_caps", op: "update" }]);

    const out = await revokeModerationTrustConsequences(db, ADMIN, USER_A, "Account restored");

    assert.equal(out.capsLifted, 0);
    assert.equal(out.incomplete, true, "the admin restored the account; the ceiling with NO expiry did not lift — that must be said");
    assert.equal(tables.trust_caps[0].lifted_at, null);
  });

  it("a failed dismissal is NOT reported as every event dismissed", async () => {
    const tables = tablesWithModerationFinding();
    const db = makeClient(tables, [{ table: "trust_events", op: "update" }]);

    const out = await revokeModerationTrustConsequences(db, ADMIN, USER_A, "Appeal upheld");

    // Before: the dismissal UPDATE dropped its error and the function returned
    // `eventsDismissed: ids.length` unconditionally — a wholly failed reversal
    // reported as a complete one.
    assert.equal(out.eventsDismissed, 0, "it must count rows it actually dismissed, not rows it intended to");
    assert.equal(out.incomplete, true);
    assert.equal(
      tables.trust_events.find((e) => e.id === "ev-mod").status, "confirmed",
      "and the finding really is still charged against the user",
    );
  });

  it("CONTROL: nothing to reverse is zeroes WITHOUT incomplete", async () => {
    const out = await revokeModerationTrustConsequences(makeClient(baseTables()), ADMIN, USER_A, "Account restored");
    assert.deepEqual(out, { eventsDismissed: 0, capsLifted: 0, incomplete: false });
  });

  it("CONTROL: a clean reversal reports what it did and is not incomplete", async () => {
    const tables = tablesWithModerationFinding();
    const out = await revokeModerationTrustConsequences(makeClient(tables), ADMIN, USER_A, "Account restored");
    assert.equal(out.eventsDismissed, 1);
    assert.equal(out.capsLifted, 1);
    assert.equal(out.incomplete, false);
  });
});

describe("Probation: 'could not tell' must not read as 'not on probation'", () => {
  /** Fails ONLY the probation projection, so getTrustProfile's `*` read still works. */
  const failProbationOnly: FailSpec = {
    table: "trust_profiles", op: "select", selectContains: "on_probation",
  };

  it("a failed probation read is flagged, not answered", async () => {
    const tables = baseTables();
    tables.trust_profiles.push({ ...earnedProfile(), on_probation: true, probation_ends_at: new Date(Date.now() + 86_400_000).toISOString() });
    const db = makeClient(tables, [failProbationOnly]);

    const status = await getRecoveryStatus(db, USER_A);

    // Before: `Boolean((probation.data as any)?.on_probation)` on `data: null`
    // produced `false` — a sanction reported as absent by a query that failed.
    assert.equal(status.probationUnknown, true, "an unreadable probation state must be marked unknown");
    assert.equal(status.probationEndsAt, null, "an unknown state must not carry a stale end date");
  });

  it("the failure survives into the user-facing summary", async () => {
    const tables = baseTables();
    tables.trust_profiles.push({ ...earnedProfile(), on_probation: true });
    const db = makeClient(tables, [failProbationOnly]);

    const summary = await getSafeTrustSummary(db, USER_A);
    assert.equal(summary.onProbation, false);
    assert.equal(summary.probationUnknown, true, "the summary flattens probation to a boolean — it must carry the doubt too");
  });

  it("an unreadable cap list is marked unknown in recovery status", async () => {
    const tables = baseTables();
    tables.trust_profiles.push(earnedProfile());
    const db = makeClient(tables, [{ table: "trust_caps", op: "select" }]);

    const status = await getRecoveryStatus(db, USER_A);
    assert.equal(status.activeCapsCount, 0);
    assert.equal(status.activeCapsUnknown, true, "activeCapsCount:0 must not assert 'no ceilings' when the read failed");
  });

  it("CONTROL: a real probation row reads as on probation, with no doubt flag", async () => {
    const tables = baseTables();
    const endsAt = new Date(Date.now() + 86_400_000).toISOString();
    tables.trust_profiles.push({ ...earnedProfile(), on_probation: true, probation_ends_at: endsAt });

    const status = await getRecoveryStatus(makeClient(tables), USER_A);
    assert.equal(status.onProbation, true);
    assert.equal(status.probationEndsAt, endsAt);
    assert.equal(status.probationUnknown, false);
    assert.equal(status.activeCapsUnknown, false);
  });

  it("CONTROL: a user with no profile row at all is not 'unknown' — it is empty", async () => {
    const status = await getRecoveryStatus(makeClient(baseTables()), USER_A);
    assert.equal(status.onProbation, false);
    assert.equal(status.probationUnknown, false, "absence of a row is an answer; a failed read is not");
  });
});

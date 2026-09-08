/**
 * The cutover safety checker for migration 2411 must FIRE — `check:layover-cutover`.
 *
 * ── WHAT IS BEING PROVED ─────────────────────────────────────────────────────
 * Seven conditions decide whether 2411 can be applied to production. A condition
 * nobody has watched fail is not a condition, so every one of them has a fixture
 * here that violates it, and every one is asserted to make the checker exit
 * non-zero AND name itself. Fixtures are built by MIRRORING the real tree with
 * symlinks and replacing exactly one file, so each proof moves one variable and
 * the scan floor stays real.
 *
 * ── AND THE OTHER DIRECTION ──────────────────────────────────────────────────
 * Two of the seven are NO_GO today. A checker that is simply hard-wired to say
 * NO would pass every mutation above and be worthless, so both recorded
 * blockers also have a fixture that CLEARS them — a committed measurement, and a
 * corrected rollback — and the ratchet is asserted to go red in that direction
 * too. A record that stays full after the fix is how a stale blocker outlives
 * the thing it described.
 *
 * ── THE REAL-TREE CONTROL ────────────────────────────────────────────────────
 * The first case spawns the checker with NO seam override at all and asserts its
 * exit status. Without it this file would prove the checker's LOGIC on fixtures
 * while nothing ever pointed it at the tree it exists to grade — the exact shape
 * the fail-open guard was in.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverCutover.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripSqlComments, maskSqlLiterals, splitSqlStatements, isMutatingStatement } from "../scripts/lib/layoverCutoverCore.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(API_ROOT, "..", "..");
const CHECKER = join(API_ROOT, "src", "scripts", "checkLayoverCutover.ts");

const REAL_MIGRATIONS = join(API_ROOT, "src", "migrations");
const REAL_SRC = join(API_ROOT, "src");
const REAL_ROLLBACKS = join(REPO_ROOT, "db", "rollback");
const REAL_SNAPSHOT = join(API_ROOT, "src", "lib", "capability", "snapshots", "20260908-production-schema.json");
const REAL_MEASUREMENT = join(API_ROOT, "src", "lib", "capability", "layover-cutover-measurement.json");
/** Sentinel for "remove this key" in a crafted measurement, distinct from any real value. */
const DELETE_KEY = Symbol.for("layoverCutover.deleteKey") as unknown as unknown;
const REAL_APPLIED = join(API_ROOT, "src", "lib", "capability", "production-applied-migrations.json");

const MIGRATION = "2411_layover_recommendation_rec_key_backfill.sql";
const ROLLBACK = "2026-09-08-2411-layover-rec-key-backfill-rollback.sql";

let tmp = "";
let seq = 0;
before(() => { tmp = mkdtempSync(join(tmpdir(), "layovercut-")); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function scratch(label: string): string {
  seq += 1;
  const p = join(tmp, `${label}-${seq}`);
  mkdirSync(p, { recursive: true });
  return p;
}

/**
 * Symlink a real directory into a scratch one, materialising only the paths
 * being replaced. Copying 1600 files per fixture would be slow and would invite
 * a shortcut — a tiny hand-built tree — which the scan floor is there to reject.
 */
function mirrorTree(real: string, dst: string, overridden: readonly string[]): void {
  const onPath = (rel: string) => overridden.some((o) => o === rel || o.startsWith(`${rel}/`));
  const walk = (r: string, d: string, prefix: string): void => {
    mkdirSync(d, { recursive: true });
    for (const e of readdirSync(r)) {
      const rel = prefix ? `${prefix}/${e}` : e;
      const src = join(r, e);
      if (overridden.includes(rel)) continue;
      let isDir = false;
      try { isDir = statSync(src).isDirectory(); } catch { continue; }
      if (onPath(rel) && isDir) { walk(src, join(d, e), rel); continue; }
      symlinkSync(src, join(d, e));
    }
  };
  walk(real, dst, "");
}

function mirrorWith(real: string, label: string, files: Record<string, string>): string {
  const dst = scratch(label);
  mirrorTree(real, dst, Object.keys(files));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dst, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dst;
}

function writeJson(label: string, name: string, value: unknown): string {
  const d = scratch(label);
  const p = join(d, name);
  writeFileSync(p, JSON.stringify(value, null, 1));
  return p;
}

const realMigration = () => readFileSync(join(REAL_MIGRATIONS, MIGRATION), "utf8");
const realRollback = () => readFileSync(join(REAL_ROLLBACKS, ROLLBACK), "utf8");
const realSnapshot = () => JSON.parse(readFileSync(REAL_SNAPSHOT, "utf8"));
const realApplied = () => JSON.parse(readFileSync(REAL_APPLIED, "utf8"));

interface Run { code: number | null; out: string }

function run(env: NodeJS.ProcessEnv = {}, args: string[] = []): Run {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER, ...args], {
    cwd: API_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("layover cutover checker — the real tree", () => {
  it("CONTROL — the real tree, no override, and the ratchet is green", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", CHECKER], {
      cwd: API_ROOT, encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    // A silent pass proves nothing: all seven conditions must be printed…
    for (const id of [
      "DEPENDENCY", "NON_VACUITY", "BACKFILL_COMPLETENESS", "REVERSIBILITY",
      "ORDERING_COLLISION", "WRITER_READINESS", "FLAG_POSTURE",
    ]) {
      assert.match(r.stdout, new RegExp(`\\b${id}\\b`), `${id} was never evaluated`);
    }
    // …and the scan must have had something to look at.
    const scanned = /scanned: (\d+) migration file\(s\)/.exec(r.stdout);
    assert.ok(scanned && Number(scanned[1]) >= 400, `implausible migration count: ${scanned?.[1]}`);
    const objects = /yielded (\d+) object\(s\)/.exec(r.stdout);
    assert.ok(objects && Number(objects[1]) >= 10, `implausible object count: ${objects?.[1]}`);
    // Green here is the RATCHET, not a safety verdict. Say so out loud.
    // REVERSIBILITY cleared when the rollback's false scope claim was replaced by
    // the loss it actually takes; NON_VACUITY is blocked on operational data that
    // is not in this repository and must not be invented. Asserting the exact
    // blocker LIST rather than "non-empty" is what makes this case notice when one
    // clears — a record that only ever shrinks quietly outlives what it described.
    assert.match(r.stdout, /VERDICT: NOT SAFE TO APPLY\. Blocked by: NON_VACUITY\./);
  });

  it("CONTROL — --verdict on the real tree exits 1 and names the blocker", () => {
    const { code, out } = run({}, ["--verdict"]);
    assert.equal(code, 1, out);
    assert.match(out, /NOT SAFE TO APPLY/);
    // Was /EFFECT UNPROVEN/ — the message when no measurement existed at all. The
    // artifact is now committed, so the blocker has moved from "we have no
    // evidence" to "we measured, and 2411 preserves nothing". That is a better
    // blocker, and the control has to assert the one actually in force or it
    // would keep passing on a message the checker no longer emits.
    assert.match(out, /VACUOUS FOR ITS PURPOSE: legacyModerated = 0/);
    // REVERSIBILITY was the second blocker and has cleared, so the scope finding
    // is no longer expected here. It must still be REACHABLE — that is the case
    // below, which crafts the false claim rather than relying on the real file
    // still carrying it.
    assert.doesNotMatch(out, /NO-GO {2}REVERSIBILITY/);
  });

  it("CONTROL — --report on the real tree exits 0 and prints the evidence for every GO", () => {
    const { code, out } = run({}, ["--report"]);
    assert.equal(code, 0, out);
    assert.match(out, /index layover_recs_session_key_uidx — created by APPLIED 2410_layover_recommendation_identity/);
    assert.match(out, /derivation matches recommendationKey branch for branch/);
    assert.match(out, /co-toucher 2335_layover_recommendation_write_boundary/);
  });

  it("refuses to report a verdict on a scan that examined almost nothing", () => {
    const only = mirrorWith(scratch("emptyish"), "onlyone", {});
    writeFileSync(join(only, MIGRATION), realMigration());
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: only });
    assert.equal(code, 2, out);
    assert.match(out, /VACUOUS SCAN/);
  });
});

// ── 1. DEPENDENCY ────────────────────────────────────────────────────────────

describe("condition 1 — DEPENDENCY", () => {
  it("FAILS a column the snapshot, 2411 and every applied migration all lack", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "dep-col", {
      [MIGRATION]: realMigration().replace(
        "WHERE r.rec_key IS NULL\n)",
        "WHERE r.rec_key IS NULL AND r.moderation_hold IS NOT TRUE\n)",
      ),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}DEPENDENCY/);
    assert.match(out, /UNRESOLVED column layover_recommendations\.moderation_hold/);
  });

  it("FAILS the unique index once its creating migration is no longer applied", () => {
    // The snapshot records no indexes at all, so an applied migration is the
    // ONLY offline proof that layover_recs_session_key_uidx exists. Take 2410
    // out of the record and that proof is gone.
    const applied = realApplied();
    applied.migrations = applied.migrations.filter((m: any) => m.name !== "2410_layover_recommendation_identity");
    const p = writeJson("dep-idx", "applied.json", applied);
    const { code, out } = run({ LAYOVER_CUTOVER_APPLIED: p });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}DEPENDENCY/);
    assert.match(out, /UNRESOLVED relation layover_recs_session_key_uidx/);
  });
});

// ── 2. NON-VACUITY ───────────────────────────────────────────────────────────

describe("condition 2 — NON_VACUITY", () => {
  /**
   * A crafted measurement that is FRESH in every dimension except the one the
   * case is testing.
   *
   * It is built from the REAL committed artifact rather than typed out, because a
   * hand-written fixture goes stale the moment a freshness rule is added: these
   * cases started failing on a missing derivationChecksum — a rule they are not
   * about — and a case that fails for the wrong reason proves nothing about the
   * right one. Only `legacyModerated` is overridden, to 4, so the shared fixture
   * describes a world where 2411 would actually preserve something.
   */
  const measurement = (extra: Record<string, unknown>) => writeJson("meas", "m.json", {
    ...JSON.parse(readFileSync(REAL_MEASUREMENT, "utf8")),
    legacyModerated: 4,
    ...extra,
  });

  it("FAILS a backfill that would update no row at all", () => {
    const { code, out } = run({ LAYOVER_CUTOVER_MEASUREMENT: measurement({ legacyRows: 0 }) }, ["--verdict"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}NON_VACUITY/);
    assert.match(out, /VACUOUS: legacyRows = 0/);
  });

  it("FAILS a backfill that preserves nothing — the trap this checker exists for", () => {
    const { code, out } = run({ LAYOVER_CUTOVER_MEASUREMENT: measurement({ legacyModerated: 0 }) }, ["--verdict"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}NON_VACUITY/);
    assert.match(out, /VACUOUS FOR ITS PURPOSE/);
  });

  it("FAILS a measurement taken before the snapshot it is graded against", () => {
    const { code, out } = run({ LAYOVER_CUTOVER_MEASUREMENT: measurement({ measuredAt: "2026-01-01" }) }, ["--verdict"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /STALE MEASUREMENT/);
  });

  it("FAILS a measurement taken against a different project", () => {
    const { code, out } = run({ LAYOVER_CUTOVER_MEASUREMENT: measurement({ projectRef: "someotherproject" }) }, ["--verdict"]);
    assert.notEqual(code, 0, out);
    assert.match(out, /is not the snapshot's production project/);
  });

  it("FAILS a 2411 that emits no mutating statement", () => {
    // The UPDATE is downgraded to a SELECT over the same objects, so the scan
    // floor still clears and the only thing that changed is whether the
    // migration writes. Deleting the statement outright instead trips the floor
    // and exits 2 — a correct answer to a different question.
    const dir = mirrorWith(REAL_MIGRATIONS, "vac-noop", {
      [MIGRATION]: realMigration().replace(
        "UPDATE public.layover_recommendations r\n   SET rec_key = u.rec_key\n  FROM unambiguous u",
        "SELECT r.id, r.rec_key, u.rec_key\n  FROM public.layover_recommendations r, unambiguous u",
      ),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir }, ["--verdict"]);
    assert.equal(code, 1, out);
    assert.match(out, /NO-GO {2}NON_VACUITY/);
    assert.match(out, /emits no mutating statement at all/);
  });

  it("CLEARS — a committed measurement flips it to GO, and the RATCHET goes red for that too", () => {
    // The other direction. Without this, a checker hard-wired to answer NO would
    // pass every case above.
    const { code, out } = run({ LAYOVER_CUTOVER_MEASUREMENT: measurement({}) });
    assert.notEqual(code, 0, out);
    assert.match(out, /GO {5}NON_VACUITY/);
    assert.match(out, /DRIFT: NON_VACUITY: recorded NO_GO, now GO/);
    assert.match(out, /Strike NON_VACUITY from RECORDED/);
  });

  // ── measurement FRESHNESS ──────────────────────────────────────────────────
  //
  // The artifact is evidence about a moment. Every input whose change would
  // invalidate it is recorded IN it, and each of these proves the corresponding
  // rule actually fires — a freshness rule nobody has watched fail is a comment.

  const withMeasurement = (name: string, patch: Record<string, unknown>, extraEnv: Record<string, string> = {}) => {
    const m = JSON.parse(readFileSync(REAL_MEASUREMENT, "utf8"));
    for (const [k, v] of Object.entries(patch)) {
      if (v === DELETE_KEY) delete m[k]; else m[k] = v;
    }
    const p = join(tmp, `measure-${name}.json`);
    writeFileSync(p, JSON.stringify(m));
    return run({ LAYOVER_CUTOVER_MEASUREMENT: p, ...extraEnv }, ["--verdict"]);
  };

  it("FAILS when the rec_key DERIVATION changed after the count was taken", () => {
    // Counts taken under one algorithm are not evidence about another: if the
    // CASE expression moved, every "ambiguous" and "colliding" number was
    // computed for a migration that no longer exists.
    const { code, out } = withMeasurement("drift", { derivationChecksum: "deadbeefdeadbeef" });
    assert.notEqual(code, 0);
    assert.match(out, /derivationChecksum deadbeefdeadbeef does not match/);
  });

  it("FAILS when the measurement carries no derivationChecksum at all", () => {
    const { code, out } = withMeasurement("nochecksum", { derivationChecksum: DELETE_KEY });
    assert.notEqual(code, 0);
    assert.match(out, /carries no derivationChecksum/);
  });

  it("FAILS a count taken PAST the cutover", () => {
    // 2411 raises unless the flag is FALSE, so a count taken with it TRUE
    // describes a state the migration refuses to run in.
    const { code, out } = withMeasurement("pastcutover", {
      flagState: { layover_stable_recommendation_ids_enabled: true },
    });
    assert.notEqual(code, 0);
    assert.match(out, /was true when measured/);
  });

  it("FAILS when the measurement records no flag state", () => {
    const { code, out } = withMeasurement("noflag", { flagState: DELETE_KEY });
    assert.notEqual(code, 0);
    assert.match(out, /records no flagState/);
  });

  it("FAILS a count taken before 2410's prerequisites existed", () => {
    const { code, out } = withMeasurement("nopre", {
      prerequisiteState: { recKeyColumn: false, uniqueIndex: true },
    });
    assert.notEqual(code, 0);
    assert.match(out, /does not record BOTH 2410 prerequisites/);
  });

  it("FAILS a measurement older than the age threshold", () => {
    // This needs a crafted snapshot: the "measured before the snapshot was
    // captured" rule sits ahead of the age rule and would otherwise answer for
    // it, so the age rule would ship never having been watched fail.
    const snap = JSON.parse(readFileSync(REAL_SNAPSHOT, "utf8"));
    snap.capturedAt = "2026-05-01";
    const sp = join(tmp, "snap-old.json");
    writeFileSync(sp, JSON.stringify(snap));
    const { code, out } = withMeasurement(
      "old",
      { measuredAt: "2026-06-01", schemaWatermark: "99999999999999" },
      { LAYOVER_CUTOVER_SNAPSHOT: sp },
    );
    assert.notEqual(code, 0);
    assert.match(out, /day\(s\) ago, past the 30-day threshold/);
  });

  it("FAILS when migrations landed after the count was taken", () => {
    const { code, out } = withMeasurement("behind", { schemaWatermark: "20260101000000" });
    assert.notEqual(code, 0);
    assert.match(out, /schemaWatermark 20260101000000 is behind/);
  });

  it("the REAL artifact passes every freshness rule, and still blocks on its own numbers", () => {
    // The positive control. Without it, a freshness rule that rejected every
    // measurement would pass all seven cases above while making the artifact
    // mechanism unusable — and the blocker below would look like freshness when
    // it is really the measured fact.
    const { code, out } = run({}, ["--verdict"]);
    assert.equal(code, 1, out);
    assert.doesNotMatch(out, /STALE MEASUREMENT/);
    assert.doesNotMatch(out, /carries no/);
    assert.match(out, /derivationChecksum \w+ matches 2411's current rec_key derivation/);
    assert.match(out, /was FALSE when measured, matching the snapshot/);
    assert.match(out, /observed both 2410 prerequisites/);
    // and the ONE thing blocking it is the measured fact, not the paperwork
    assert.match(out, /VACUOUS FOR ITS PURPOSE: legacyModerated = 0/);
    assert.match(out, /VERDICT: NOT SAFE TO APPLY\. Blocked by: NON_VACUITY\./);
  });
});

// ── 3. BACKFILL COMPLETENESS ─────────────────────────────────────────────────

describe("condition 3 — BACKFILL_COMPLETENESS", () => {
  it("FAILS a derivation that no longer matches the writer's key function", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "bf-slug", {
      [MIGRATION]: realMigration().replace(/, 80\)/g, ", 60)"),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}BACKFILL_COMPLETENESS/);
    assert.match(out, /SLUG LENGTH DIVERGES/);
  });

  it("FAILS a derivation that drops a field the writer keys on", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "bf-field", {
      [MIGRATION]: realMigration().replace(/\br\.inside_airport\b/g, "FALSE").replace(/inside_airport/g, "x_gone"),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /DERIVATION FIELD MISMATCH/);
  });

  it("FAILS a backfill that then declares the column NOT NULL", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "bf-notnull", {
      [MIGRATION]: realMigration().replace(
        "COMMIT;",
        "ALTER TABLE public.layover_recommendations ALTER COLUMN rec_key SET NOT NULL;\n\nCOMMIT;",
      ),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /adds a NOT NULL constraint after backfilling/);
  });

  it("FAILS a backfill that guesses which of two rows owns an ambiguous key", () => {
    const raw = realMigration();
    const start = raw.indexOf("unambiguous AS (");
    const end = raw.indexOf(")\nUPDATE public.layover_recommendations r", start);
    const greedy = "unambiguous AS (\n  SELECT d.id, d.session_id, d.rec_key FROM derived d WHERE d.rec_key IS NOT NULL\n";
    const dir = mirrorWith(REAL_MIGRATIONS, "bf-ambig", {
      [MIGRATION]: raw.slice(0, start) + greedy + raw.slice(end),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /AMBIGUOUS SOURCE UNGUARDED/);
  });

  it("FAILS a measured collision that would abort the migration's own postcondition", () => {
    const p = writeJson("bf-collide", "m.json", {
      measuredAt: "2026-09-08", projectRef: realSnapshot().projectRef,
      legacyRows: 30, legacyModerated: 4, ambiguousDerivations: 2, ambiguousModerated: 0, collidingDerivedKeys: 3,
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MEASUREMENT: p });
    assert.notEqual(code, 0, out);
    assert.match(out, /derived key\(s\) collide on \(session_id, rec_key\)/);
  });

  it("FAILS measured moderated rows that the backfill cannot key", () => {
    const p = writeJson("bf-amod", "m.json", {
      measuredAt: "2026-09-08", projectRef: realSnapshot().projectRef,
      legacyRows: 30, legacyModerated: 4, ambiguousDerivations: 2, ambiguousModerated: 2, collidingDerivedKeys: 0,
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MEASUREMENT: p });
    assert.notEqual(code, 0, out);
    assert.match(out, /moderated row\(s\) derive an ambiguous key/);
  });
});

// ── 4. REVERSIBILITY ─────────────────────────────────────────────────────────

describe("condition 4 — REVERSIBILITY", () => {
  it("FAILS when the rollback the migration names does not exist", () => {
    const dir = scratch("rb-missing");
    for (const f of readdirSync(REAL_ROLLBACKS)) {
      if (f === ROLLBACK) continue;
      symlinkSync(join(REAL_ROLLBACKS, f), join(dir, f));
    }
    // REVERSIBILITY is already NO_GO on record, so the ratchet cannot see a new
    // REASON — it grades verdicts. --verdict is the mode that answers "safe?".
    const { code, out } = run({ LAYOVER_CUTOVER_ROLLBACK_DIR: dir }, ["--verdict"]);
    assert.equal(code, 1, out);
    assert.match(out, /NO-GO {2}REVERSIBILITY/);
    assert.match(out, /does not exist under/);
  });

  it("FAILS a migration that names no rollback at all", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "rb-unnamed", {
      [MIGRATION]: realMigration().replace(/db\/rollback\/[A-Za-z0-9._-]+\.sql/g, "(none)"),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir }, ["--verdict"]);
    assert.equal(code, 1, out);
    assert.match(out, /NO-GO {2}REVERSIBILITY/);
    assert.match(out, /names no rollback file/);
  });

  it("FAILS a rollback that does not put the column back", () => {
    const dir = mirrorWith(REAL_ROLLBACKS, "rb-noop", {
      [ROLLBACK]: realRollback().replace("SET rec_key = NULL", "SET rec_key = rec_key"),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_ROLLBACK_DIR: dir }, ["--verdict"]);
    assert.equal(code, 1, out);
    assert.match(out, /NO-GO {2}REVERSIBILITY/);
    assert.match(out, /does not put layover_recommendations\.rec_key back to NULL/);
  });

  it("FAILS a rollback that would race the live sweep", () => {
    const raw = realRollback();
    const start = raw.indexOf("DO $$");
    const end = raw.indexOf("END $$;", start) + "END $$;".length;
    const dir = mirrorWith(REAL_ROLLBACKS, "rb-unguarded", {
      [ROLLBACK]: raw.slice(0, start) + raw.slice(end),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_ROLLBACK_DIR: dir }, ["--verdict"]);
    assert.equal(code, 1, out);
    assert.match(out, /NO-GO {2}REVERSIBILITY/);
    assert.match(out, /does not refuse to run while layover_stable_recommendation_ids_enabled is TRUE/);
  });

  it("FAILS a rollback that CLAIMS a scope its SQL does not implement", () => {
    // The finding that blocked REVERSIBILITY until it was fixed: the real file
    // said it "refuses to touch a row that was keyed by the SERVICE", narrowed to
    // rows "whose session has no keyed row written after the backfill", while its
    // UPDATE carried only `rec_key IS NOT NULL` and a plan-stop NOT EXISTS. 2411
    // writes no provenance, so no term can tell the two apart.
    //
    // The claim now lives only in a fixture. Leaving this case pointed at the real
    // file would have retired the proof the moment the defect was fixed — the
    // guard would have kept its green and lost its regression test in one step.
    const claiming = realRollback().replace(
      /-- SCOPE, STATED AS WHAT THE SQL ACTUALLY DOES\.[\s\S]*?-- If you need a narrower revert, do it by explicit id list\. Do not widen this\./,
      "-- It also refuses to touch a row that was keyed by the SERVICE rather than by\n" +
        "-- 2411: the scope is narrowed to rows whose session has no keyed row written\n" +
        "-- after the backfill.",
    );
    assert.match(claiming, /keyed by the SERVICE/, "premise: the fixture carries the claim");
    assert.doesNotMatch(claiming, /THIS REVERT NULLS/, "premise: and declares no loss");

    const dir = mirrorWith(REAL_ROLLBACKS, "rb-claiming", { [ROLLBACK]: claiming });
    const { code, out } = run({ LAYOVER_CUTOVER_ROLLBACK_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}REVERSIBILITY/);
    assert.match(out, /ROLLBACK SCOPE CLAIM IS NOT IMPLEMENTED/);
    // and the ratchet must see it as drift AWAY from the recorded GO
    assert.match(out, /DRIFT: REVERSIBILITY: recorded GO, now NO_GO/);
  });

  it("ACCEPTS the same claim once the LOSS is declared — the real file's fix", () => {
    // An over-broad or irreversible step is ALLOWED. It must not be SILENT, and it
    // must not be described as something it is not.
    //
    // The rule keys on the DECLARED LOSS rather than on the absence of the claim,
    // and that is load-bearing: an honest correction QUOTES the claim it disowns,
    // so a rule that only looked for the phrase failed the real fix. Matching prose
    // cannot tell "we do this" from "we used to say we did, and here is the truth".
    const { code } = run({});
    assert.equal(code, 0, "the real rollback declares its loss, so the ratchet is green");
    assert.match(realRollback(), /refuses to touch/, "and it still quotes the claim it disowns");
    assert.match(realRollback(), /THIS REVERT NULLS rec_key ON EVERY UNREFERENCED KEYED ROW, whoever keyed it/);
  });
});

// ── 5. ORDERING / COLLISION ──────────────────────────────────────────────────

describe("condition 5 — ORDERING_COLLISION", () => {
  it("FAILS a second migration carrying the same prefix", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "ord-prefix", {
      "2411_someone_elses_lane.sql": "BEGIN;\nSELECT 1;\nCOMMIT;\n",
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}ORDERING_COLLISION/);
    assert.match(out, /PREFIX COLLISION/);
  });

  it("FAILS an unapplied migration that mutates the same table without a written order decision", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "ord-cotouch", {
      "2412_someone_elses_rewrite.sql":
        "BEGIN;\n" +
        "ALTER TABLE public.layover_recommendations ADD COLUMN IF NOT EXISTS rec_key_v2 TEXT;\n" +
        "UPDATE public.layover_recommendations SET rec_key = NULL WHERE inside_airport;\n" +
        "COMMIT;\n",
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /UNCLASSIFIED CO-TOUCHER: unapplied migration 2412_someone_elses_rewrite/);
  });

  it("FAILS when the predecessor 2410 is not recorded as applied", () => {
    const applied = realApplied();
    applied.migrations = applied.migrations.filter((m: any) => m.name !== "2410_layover_recommendation_identity");
    const { code, out } = run({ LAYOVER_CUTOVER_APPLIED: writeJson("ord-pred", "a.json", applied) });
    assert.notEqual(code, 0, out);
    assert.match(out, /PREDECESSOR NOT APPLIED/);
  });

  it("FAILS when 2411 is already recorded as applied — there is no decision left", () => {
    const applied = realApplied();
    applied.migrations.push({ version: "20260909000000", name: "2411_layover_recommendation_rec_key_backfill" });
    const { code, out } = run({ LAYOVER_CUTOVER_APPLIED: writeJson("ord-done", "a.json", applied) });
    assert.notEqual(code, 0, out);
    assert.match(out, /ALREADY recorded as applied/);
  });

  it("FAILS a classification that has gone stale", () => {
    const dir = scratch("ord-stale");
    for (const f of readdirSync(REAL_MIGRATIONS)) {
      if (f === "2335_layover_recommendation_write_boundary.sql") continue;
      symlinkSync(join(REAL_MIGRATIONS, f), join(dir, f));
    }
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /STALE CLASSIFICATION: 2335_layover_recommendation_write_boundary/);
  });
});

// ── 6. WRITER READINESS ──────────────────────────────────────────────────────

describe("condition 6 — WRITER_READINESS", () => {
  const WRITER = "services/airport/LayoverRecommendationService.ts";
  const ROUTE = "routes/airport.ts";

  it("FAILS when nothing builds a payload carrying the column", () => {
    const src = readFileSync(join(REAL_SRC, WRITER), "utf8");
    const dir = mirrorWith(REAL_SRC, "wr-nowriter", { [WRITER]: src.replace(/rec_key:\s*keys\[i\]/g, "removed: keys[i]") });
    const { code, out } = run({ LAYOVER_CUTOVER_SRC: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}WRITER_READINESS/);
    assert.match(out, /NO WRITER/);
  });

  it("does NOT count a writer that has been COMMENTED OUT", () => {
    // The defect five checkers in this tree shipped: answering a question about
    // CODE by matching RAW FILE TEXT. `rec_key:` is still in the file here.
    const src = readFileSync(join(REAL_SRC, WRITER), "utf8");
    const commented = src.replace(/(\s*)const keyed = rows\.map\(\(row, i\) => \(\{ \.\.\.row, rec_key: keys\[i\] \}\)\);/,
      "$1// const keyed = rows.map((row, i) => ({ ...row, rec_key: keys[i] }));$1const keyed = rows;");
    assert.notEqual(commented, src, "the fixture did not actually comment the writer out");
    assert.match(commented, /rec_key: keys\[i\]/, "the raw text must still contain the write");
    const dir = mirrorWith(REAL_SRC, "wr-commented", { [WRITER]: commented });
    const { code, out } = run({ LAYOVER_CUTOVER_SRC: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO WRITER/);
  });

  it("FAILS when the option no longer flows from the route to the writer", () => {
    const src = readFileSync(join(REAL_SRC, ROUTE), "utf8");
    const dir = mirrorWith(REAL_SRC, "wr-unwired", { [ROUTE]: src.replace(/\bstableIds\b/g, "unusedOption") });
    const { code, out } = run({ LAYOVER_CUTOVER_SRC: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}WRITER_READINESS/);
    assert.match(out, /NOT WIRED/);
  });

  it("FAILS when nothing in product code reads the gating flag", () => {
    const src = readFileSync(join(REAL_SRC, ROUTE), "utf8");
    const dir = mirrorWith(REAL_SRC, "wr-noreader", {
      [ROUTE]: src.replace(/"layover_stable_recommendation_ids_enabled"/g, '"some_other_flag"'),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_SRC: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO READER/);
  });
});

// ── 7. FLAG POSTURE ──────────────────────────────────────────────────────────

describe("condition 7 — FLAG_POSTURE", () => {
  it("FAILS when the gate is already TRUE in production", () => {
    const snap = realSnapshot();
    snap.flags.layover_stable_recommendation_ids_enabled = true;
    const { code, out } = run({ LAYOVER_CUTOVER_SNAPSHOT: writeJson("fl-on", "s.json", snap) });
    assert.notEqual(code, 0, out);
    assert.match(out, /NO-GO {2}FLAG_POSTURE/);
    assert.match(out, /is already TRUE in production/);
  });

  it("FAILS when the gate has no row for 2411's precondition to read", () => {
    const snap = realSnapshot();
    delete snap.flags.layover_stable_recommendation_ids_enabled;
    const { code, out } = run({ LAYOVER_CUTOVER_SNAPSHOT: writeJson("fl-absent", "s.json", snap) });
    assert.notEqual(code, 0, out);
    assert.match(out, /has no row in the production snapshot/);
  });

  it("FAILS a gate read through a FAIL-OPEN reader", () => {
    const reader = "lib/featureFlags.ts";
    const src = readFileSync(join(REAL_SRC, reader), "utf8");
    const broken = src.replace("    if (error) return false;\n    return Boolean((data as any)?.enabled);",
      "    if (error) return true;\n    return Boolean((data as any)?.enabled);");
    assert.notEqual(broken, src, "the fixture did not actually break the reader");
    const dir = mirrorWith(REAL_SRC, "fl-open", { [reader]: broken });
    const { code, out } = run({ LAYOVER_CUTOVER_SRC: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /FAIL-OPEN READER|kill-switch polarity/);
  });

  it("FAILS a 2411 that moves the flag it is gated on", () => {
    const dir = mirrorWith(REAL_MIGRATIONS, "fl-flip", {
      [MIGRATION]: realMigration().replace(
        "COMMIT;",
        "UPDATE public.feature_flags SET enabled = TRUE WHERE flag = 'layover_stable_recommendation_ids_enabled';\n\nCOMMIT;",
      ),
    });
    const { code, out } = run({ LAYOVER_CUTOVER_MIGRATION_DIR: dir });
    assert.notEqual(code, 0, out);
    assert.match(out, /A backfill must not move the gate it is gated on/);
  });
});

// ── the SQL lexer the whole check rests on ───────────────────────────────────

describe("SQL comment stripping — the shared trap", () => {
  it("removes line and block comments", () => {
    assert.equal(stripSqlComments("SELECT 1; -- drop everything").trim(), "SELECT 1;");
    assert.equal(stripSqlComments("SELECT /* nope */ 1;").replace(/\s+/g, " ").trim(), "SELECT 1;");
  });

  it("does NOT treat a -- inside a string literal as a comment", () => {
    const sql = "SELECT 'a -- b' AS x, 2;";
    assert.match(stripSqlComments(sql), /AS x, 2;/);
  });

  it("strips comments INSIDE a dollar-quoted body, because that body is code", () => {
    const out = stripSqlComments("DO $$ BEGIN -- gone\n  PERFORM 1; END $$;");
    assert.doesNotMatch(out, /gone/);
    assert.match(out, /PERFORM 1;/);
  });

  it("blanks the contents of string literals for identifier scans, keeping the quotes", () => {
    const masked = maskSqlLiterals("WHERE flag = 'some_flag_name is TRUE'");
    assert.doesNotMatch(masked, /some_flag_name/);
    assert.match(masked, /WHERE flag = '/);
  });

  it("splits on top-level semicolons only", () => {
    const parts = splitSqlStatements("SELECT 1; DO $$ BEGIN a; b; END $$; SELECT 2;");
    assert.equal(parts.length, 3);
  });

  it("reads a DO block that writes as a write, and one that only asserts as not", () => {
    assert.equal(isMutatingStatement("DO $$ BEGIN ALTER TABLE t ADD COLUMN c TEXT; END $$"), true);
    assert.equal(isMutatingStatement("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM t) THEN RAISE EXCEPTION 'no'; END IF; END $$"), false);
  });
});

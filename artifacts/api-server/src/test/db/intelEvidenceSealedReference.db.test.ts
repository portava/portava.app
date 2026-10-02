/**
 * intelEvidenceSealedReference — census-map §45.11: migrations 3360 and 3361 and
 * both rollbacks, REHEARSED against real PostgreSQL on the local harness.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/intelEvidenceSealedReference.db.test.ts
 *      (or scripts/local-db/up.sh then run-tests.sh). Skips without a database,
 *      like every src/test/db suite; run-tests.sh refuses a skipped run.
 *
 * NEVER portava-ci, never production: this is the throwaway cluster up.sh
 * boots, and it holds no real row.
 *
 * THE RUNNER'S WAY. Each migration is applied as scripts/src/apply-migrations.ts
 * applies it: its own classifyMigration and buildApplyStatement, so the file's
 * body and its schema_migration_ledger row are ONE transaction (and a trailing
 * postcondition tail, if the file had one, would run after it). A refused file
 * therefore leaves no ledger row, and each rollback removes its file's row.
 *
 * WHAT IS PROVED, EACH AGAINST THE DATABASE RATHER THAN THE TEXT
 *   1. The chain's own end state: 3360 then 3361 on a table with no plaintext
 *      row leave the CHECK VALIDATED and the re-seal function DROPPED.
 *   2. 3361's rollback, then 3360's, return the table to its pre-3360 shape,
 *      and 3360 then applies ON TOP OF plaintext rows (NOT VALID).
 *   3. The CHECK refuses a new plaintext photo or video reference and admits a
 *      sealed one, a NULL one and a plaintext text_note.
 *   4. The re-seal function: service_role may call it, anon and authenticated
 *      may not; it changes exactly ONE row even when another row holds the same
 *      plaintext value; a stale call changes nothing.
 *   5. The `DISABLE TRIGGER` inside it is re-enabled on every path: after a
 *      success, after a refusal, and after an EXCEPTION raised between the
 *      DISABLE and the ENABLE, both when it aborts the statement and when a
 *      caller catches it in the same transaction.
 *   6. 3361 refuses while a plaintext row remains and changes nothing; once
 *      none remains it validates the CHECK and drops the function.
 *   7. Both rollbacks run cleanly afterwards, in order, and 3360's refuses to
 *      run first. Each removes its own file's ledger row, so the runner would
 *      apply the file again rather than take it as applied.
 * The suite leaves the table as the chain left it: 3360 and 3361 applied, no
 * row of its own.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";
import { sealEvidenceReference } from "../../lib/intelEvidenceCapture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "../../migrations");
const ROLLBACKS = resolve(HERE, "../../../../../db/rollback");
const M3360 = () => readFileSync(resolve(MIGRATIONS, "3360_intel_evidence_sealed_reference.sql"), "utf8");
const M3361 = () => readFileSync(resolve(MIGRATIONS, "3361_intel_evidence_sealed_reference_validate.sql"), "utf8");
const RB3360 = () => readFileSync(resolve(ROLLBACKS, "2026-09-27-3360-intel-evidence-sealed-reference-rollback.sql"), "utf8");
const RB3361 = () => readFileSync(resolve(ROLLBACKS, "2026-09-27-3361-intel-evidence-sealed-reference-validate-rollback.sql"), "utf8");

const F3360 = "3360_intel_evidence_sealed_reference.sql";
const F3361 = "3361_intel_evidence_sealed_reference_validate.sql";

// The applier itself, imported as migrationApplyOrder.test.ts imports it.
const APPLIER = resolve(HERE, "../../../../../scripts/src/apply-migrations.ts");
const runner = (await import(APPLIER)) as typeof import("../../../../../scripts/src/apply-migrations.js");

const FN = "public.intel_evidence_rekey_reference(uuid, text, text)";
const GUARD = "intel_evidence_no_update_delete";
const SUITE = "lanex-3360-rehearsal";

let U = "";
let PLACE = "";
let OBS_A = "";
let OBS_B = "";
/** Plaintext rows written BEFORE 3360 is applied, as the old map path wrote them. */
const LEGACY: Record<"photo" | "video" | "target" | "twin" | "x1" | "x2", { id: string; obs: string; kind: string; key: string }> = {} as any;

process.env.INTEL_EVIDENCE_REFERENCE_KEY ??= "intel-evidence-db-rehearsal-key-0123456789abcdef";
const seal = (key: string, obs: string): string => {
  const s = sealEvidenceReference(key, obs);
  if (!s.ok) throw new Error(`setup: could not seal (${s.reason})`);
  return s.reference;
};

/** Apply a migration or rollback file exactly as psql runs it. */
function apply(sql: string): { status: number; stderr: string } {
  const r = psql(sql);
  return { status: r.status, stderr: r.stderr };
}
function mustApply(sql: string, what: string): void {
  const r = apply(sql);
  assert.equal(r.status, 0, `${what} failed:\n${r.stderr}`);
}
/** Apply a migration file the way the runner does: body + ledger row in ONE transaction, then any tail. */
function runnerApply(filename: string, sql: string): { status: number; stderr: string } {
  const cls = runner.classifyMigration(sql, filename);
  assert.notEqual(cls.kind, "refuse", `the runner refuses ${filename}: ${cls.kind === "refuse" ? cls.reason : ""}`);
  if (cls.kind === "refuse") throw new Error("unreachable");
  const statement = runner.buildApplyStatement({
    filename,
    body: cls.body,
    checksum: runner.checksumOf(sql),
    appliedBy: "manual",
    notes: "census-map §45.11 local-harness rehearsal (throwaway database)",
  });
  const r = apply(statement);
  if (r.status !== 0 || cls.postconditions.trim() === "") return r;
  return apply(cls.postconditions);
}
function mustRunnerApply(filename: string, sql: string, what: string): void {
  const r = runnerApply(filename, sql);
  assert.equal(r.status, 0, `${what} failed:\n${r.stderr}`);
}
/** The ledger's checksum for a file, or null when the ledger has no row for it. */
const ledgerChecksum = (filename: string): string | null =>
  scalar(`SELECT checksum FROM ${runner.LEDGER_TABLE} WHERE filename = '${filename}'`);

const guardState = (): string | null =>
  scalar(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.intel_evidence'::regclass AND tgname = '${GUARD}'`);
const fnExists = (): boolean => scalar(`SELECT to_regprocedure('${FN}') IS NOT NULL`) === "t";
const constraintState = (): string | null =>
  scalar(`SELECT CASE WHEN convalidated THEN 'valid' ELSE 'not_valid' END FROM pg_constraint
          WHERE conrelid = 'public.intel_evidence'::regclass AND conname = 'intel_evidence_media_reference_sealed'`);
const referenceOf = (id: string): string | null => scalar(`SELECT coalesce(reference, '<null>') FROM public.intel_evidence WHERE id = '${id}'`);

/** Insert one evidence row as the application's role would. Returns its id, or throws with psql's stderr. */
function insertEvidence(obs: string, kind: string, reference: string | null): string {
  const id = randomUUID();
  const ref = reference === null ? "NULL" : `'${reference}'`;
  exec(`SET LOCAL ROLE service_role;
        INSERT INTO public.intel_evidence (id, observation_id, actor_id, evidence_kind, reference, detail)
        VALUES ('${id}', '${obs}', '${U}', '${kind}', ${ref}, '{"suite":"${SUITE}"}'::jsonb);`, { single: true });
  return id;
}
function insertRefused(obs: string, kind: string, reference: string): string {
  const r = psql(`SET LOCAL ROLE service_role;
        INSERT INTO public.intel_evidence (id, observation_id, actor_id, evidence_kind, reference, detail)
        VALUES ('${randomUUID()}', '${obs}', '${U}', '${kind}', '${reference}', '{"suite":"${SUITE}"}'::jsonb);`, { single: true });
  assert.notEqual(r.status, 0, `the database admitted a ${kind} row with reference ${reference}`);
  return r.stderr;
}
/** Call the re-seal function as a role; returns psql's result. */
function rekeyAs(role: string, id: string, legacy: string, sealed: string) {
  return psql(`SET LOCAL ROLE ${role};
               SELECT public.intel_evidence_rekey_reference('${id}', '${legacy}', '${sealed}');`, { single: true });
}

/**
 * The table without 3360: guard enabled, no function, no constraint, 2223's
 * comment, none of this suite's rows. Idempotent, and it does not depend on
 * the migration files, so a mutated file can never leave the next run stuck.
 */
function resetToPre3360(): void {
  exec(`SELECT set_config('portava.erasure_in_progress', 'on', true);
        ALTER TABLE public.intel_evidence ENABLE TRIGGER ${GUARD};
        DELETE FROM public.intel_evidence WHERE detail->>'suite' = '${SUITE}';
        DROP FUNCTION IF EXISTS ${FN};
        ALTER TABLE public.intel_evidence DROP CONSTRAINT IF EXISTS intel_evidence_media_reference_sealed;
        DELETE FROM ${runner.LEDGER_TABLE} WHERE filename IN ('${F3360}', '${F3361}');`, { single: true });
}

describe("census-map §45.11 — migrations 3360 and 3361, rehearsed on real PostgreSQL", { skip: !HAVE_DB }, () => {
  before(() => {
    U = seedUser("lanex3360");
    PLACE = randomUUID();
    OBS_A = randomUUID();
    OBS_B = randomUUID();
    exec(`INSERT INTO public.places (id, name, normalized_name) VALUES ('${PLACE}', 'Lane X rehearsal', 'lane x rehearsal');`);
    for (const obs of [OBS_A, OBS_B]) {
      exec(`INSERT INTO public.intel_observations
              (id, actor_id, subject_kind, subject_id, claim_type, value, source_class, capture_surface, observed_at, idempotency_key)
            VALUES ('${obs}', '${U}', 'experience', '${PLACE}', 'crowd.level', '{"level":"busy"}'::jsonb,
                    'firsthand_unverified', 'quick_signal', now() - interval '5 minutes', 'lanex-${obs.slice(0, 8)}');`);
    }
    resetToPre3360();
  });

  after(() => {
    if (!U) return;
    // Leave the table as the chain left it: both migrations applied (as up.sh
    // applies them, so no ledger row), no row of ours.
    resetToPre3360();
    mustApply(M3360(), "restoring 3360");
    mustApply(M3361(), "restoring 3361");
    exec(`SELECT set_config('portava.erasure_in_progress', 'on', true);
          DELETE FROM public.intel_observations WHERE id IN ('${OBS_A}', '${OBS_B}');
          DELETE FROM public.places WHERE id = '${PLACE}';`, { single: true });
    deleteUser(U);
  });

  it("1. on a table with no plaintext row, 3360 then 3361 leave the CHECK validated and the function dropped", () => {
    assert.equal(ledgerChecksum(F3360), null, "setup: no ledger row before the apply");
    mustRunnerApply(F3360, M3360(), "3360");
    assert.equal(constraintState(), "not_valid");
    assert.equal(fnExists(), true);
    assert.equal(ledgerChecksum(F3360), runner.checksumOf(M3360()), "3360's ledger row carries the file's own checksum");
    mustRunnerApply(F3361, M3361(), "3361");
    assert.equal(constraintState(), "valid");
    assert.equal(fnExists(), false);
    assert.equal(ledgerChecksum(F3361), runner.checksumOf(M3361()));
    assert.equal(guardState(), "O");
  });

  it("2. rollbacks unwind in order (3360's refuses first), and 3360 applies on top of plaintext rows", () => {
    const early = apply(RB3360());
    assert.notEqual(early.status, 0, "3360's rollback ran while 3361 was applied");
    assert.match(early.stderr, /Roll 3361 back first/);
    assert.notEqual(ledgerChecksum(F3360), null, "a refused rollback removed no ledger row");
    mustApply(RB3361(), "3361 rollback");
    assert.equal(constraintState(), "not_valid");
    assert.equal(fnExists(), true);
    assert.equal(ledgerChecksum(F3361), null, "3361's rollback removed 3361's ledger row");
    assert.notEqual(ledgerChecksum(F3360), null, "and only 3361's");
    mustApply(RB3360(), "3360 rollback");
    assert.equal(constraintState(), null);
    assert.equal(fnExists(), false);
    assert.equal(ledgerChecksum(F3360), null, "3360's rollback removed 3360's ledger row");
    assert.match(String(scalar(`SELECT col_description('public.intel_evidence'::regclass,
      (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.intel_evidence'::regclass AND attname = 'reference'))`)),
      /^A storage key \(`<bucket>\/<path>`\)/, "the 3360 rollback restores 2223's column comment");

    // Pre-3360 rows, as the old map path wrote them. The same plaintext value sits
    // on two observations (the unique index is per observation), and two rows
    // share one observation so a re-seal can collide inside the UPDATE (test 5).
    const plan: Array<[keyof typeof LEGACY, string, string, string]> = [
      ["photo", OBS_A, "photo", `post-media/${U}/1.jpg`],
      ["video", OBS_A, "video", `post-media/${U}/2.mp4`],
      ["target", OBS_A, "photo", `post-media/${U}/same.jpg`],
      ["twin", OBS_B, "photo", `post-media/${U}/same.jpg`],
      ["x1", OBS_B, "photo", `post-media/${U}/x1.jpg`],
      ["x2", OBS_B, "photo", `post-media/${U}/x2.jpg`],
    ];
    for (const [name, obs, kind, key] of plan) LEGACY[name] = { id: insertEvidence(obs, kind, key), obs, kind, key };
    mustRunnerApply(F3360, M3360(), "3360 over plaintext rows");
    assert.equal(constraintState(), "not_valid", "NOT VALID: existing rows do not block the migration");
    assert.equal(fnExists(), true);
  });

  it("3. the CHECK refuses a NEW plaintext photo or video reference, and admits sealed, NULL and a text_note", () => {
    for (const [kind, key] of [["photo", `post-media/${U}/3.jpg`], ["video", `post-media/${U}/4.mp4`], ["photo", `profile-media/avatars/${U}/a.jpg`]]) {
      assert.match(insertRefused(OBS_B, kind!, key!), /intel_evidence_media_reference_sealed/);
    }
    // ANTI-VACUITY: the same table admits the shapes the rule allows.
    const sealedId = insertEvidence(OBS_B, "photo", seal(`post-media/${U}/5.jpg`, OBS_B));
    const nullId = insertEvidence(OBS_B, "photo", null);
    const noteId = insertEvidence(OBS_B, "text_note", `post-media/${U}/not-media.txt`);
    for (const id of [sealedId, nullId, noteId]) assert.notEqual(referenceOf(id), null);
  });

  it("4. the re-seal function is service_role's only, and changes exactly ONE row", () => {
    const legacy = LEGACY.target.key;
    const target = LEGACY.target.id;
    const twin = LEGACY.twin.id;
    assert.equal(LEGACY.twin.key, legacy, "setup: the twin holds the same plaintext value");
    const sealed = seal(legacy, OBS_A);

    for (const role of ["anon", "authenticated"]) {
      const r = rekeyAs(role, target, legacy, sealed);
      assert.notEqual(r.status, 0, `${role} executed the re-seal function`);
      assert.match(r.stderr, /permission denied for function intel_evidence_rekey_reference/);
    }
    assert.equal(referenceOf(target), legacy);

    const ok = rekeyAs("service_role", target, legacy, sealed);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim().split("\n").pop(), "t");
    assert.equal(referenceOf(target), sealed, "the row named was re-sealed");
    assert.equal(referenceOf(twin), legacy, "a row holding the same plaintext value on another observation was NOT touched");
    assert.equal(guardState(), "O", "the append-only guard is enabled after a success");

    // A stale caller (the row no longer holds that plaintext value) changes nothing.
    const stale = rekeyAs("service_role", target, legacy, seal(legacy, OBS_B));
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(stale.stdout.trim().split("\n").pop(), "f");
    assert.equal(referenceOf(target), sealed);
    assert.equal(guardState(), "O");

    // A value of the wrong shape is refused before the guard is touched.
    const shape = rekeyAs("service_role", twin, legacy, "not-sealed");
    assert.notEqual(shape.status, 0);
    assert.match(shape.stderr, /not a sealed reference/);
    assert.equal(guardState(), "O");

    // And the guard is live again: a direct UPDATE is still refused by it.
    const direct = psql(`UPDATE public.intel_evidence SET reference = '${seal(legacy, OBS_B)}' WHERE id = '${twin}';`);
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /append-only/);
  });

  it("5. an EXCEPTION between the DISABLE and the ENABLE leaves the guard enabled, aborted or caught", () => {
    // Two plaintext rows on ONE observation; re-sealing the second to the FIRST's
    // sealed value violates 2223's unique (observation_id, reference) inside the
    // UPDATE, i.e. after the function has disabled the guard.
    const first = LEGACY.x1.id;
    const second = LEGACY.x2.id;
    const taken = seal(LEGACY.x1.key, OBS_B);
    const ok = rekeyAs("service_role", first, LEGACY.x1.key, taken);
    assert.equal(ok.status, 0, ok.stderr);

    // (a) the exception aborts the statement.
    const aborted = rekeyAs("service_role", second, LEGACY.x2.key, taken);
    assert.notEqual(aborted.status, 0, "setup: the collision did not raise, so no exception path was exercised");
    assert.match(aborted.stderr, /intel_evidence_observation_reference|duplicate key/);
    assert.equal(guardState(), "O", "the guard is enabled after an aborted call");
    assert.equal(referenceOf(second), LEGACY.x2.key);

    // (b) a caller catches it and keeps going in the SAME transaction.
    const caught = exec(`SET LOCAL ROLE service_role;
      CREATE TEMP TABLE lanex_probe (state text) ON COMMIT DROP;
      DO $probe$
      BEGIN
        BEGIN
          PERFORM public.intel_evidence_rekey_reference('${second}', '${LEGACY.x2.key}', '${taken}');
          INSERT INTO lanex_probe VALUES ('no-exception');
        EXCEPTION WHEN unique_violation THEN
          INSERT INTO lanex_probe
            SELECT 'caught:' || tgenabled::text FROM pg_trigger
             WHERE tgrelid = 'public.intel_evidence'::regclass AND tgname = '${GUARD}';
        END;
      END $probe$;
      SELECT state FROM lanex_probe;`, { single: true });
    assert.equal(caught.pop(), "caught:O", "inside the caller's transaction, after the caught exception, the guard is enabled");
    assert.equal(guardState(), "O");
  });

  it("6. 3361 refuses while a plaintext row remains, changing nothing; then validates and drops the function", () => {
    const refused = runnerApply(F3361, M3361());
    assert.notEqual(refused.status, 0, "3361 applied over plaintext rows");
    assert.match(refused.stderr, /still hold a plaintext storage key/);
    assert.equal(constraintState(), "not_valid", "a refused 3361 validated nothing");
    assert.equal(fnExists(), true, "a refused 3361 dropped nothing");
    assert.equal(ledgerChecksum(F3361), null, "a refused 3361 wrote no ledger row: body and row are one transaction");

    // Re-seal every remaining plaintext photo/video row of this suite, as the script would.
    const left = rows<{ id: string; observation_id: string; reference: string }>(
      `SELECT id, observation_id, reference FROM public.intel_evidence
        WHERE detail->>'suite' = '${SUITE}' AND evidence_kind IN ('photo','video')
          AND reference IS NOT NULL AND reference !~ '^ievr1\\.'`);
    // photo, video, twin and x2 are still plaintext here (target and x1 were re-sealed).
    assert.equal(left.length, 4, `setup: expected four plaintext rows, found ${left.length}`);
    for (const r of left) {
      const res = rekeyAs("service_role", r.id, r.reference, seal(r.reference, r.observation_id));
      assert.equal(res.status, 0, res.stderr);
    }
    assert.equal(guardState(), "O");

    mustRunnerApply(F3361, M3361(), "3361 once nothing is plaintext");
    assert.equal(constraintState(), "valid");
    assert.equal(fnExists(), false);
    assert.equal(ledgerChecksum(F3361), runner.checksumOf(M3361()));
  });

  it("7. both rollbacks run cleanly afterwards, in order", () => {
    mustApply(RB3361(), "3361 rollback");
    assert.equal(constraintState(), "not_valid");
    assert.equal(fnExists(), true);
    assert.equal(scalar(`SELECT has_function_privilege('anon', '${FN}', 'EXECUTE')`), "f", "the re-created function is not anon's");
    assert.equal(ledgerChecksum(F3361), null, "after its rollback the runner would apply 3361 again");
    mustApply(RB3360(), "3360 rollback");
    assert.equal(constraintState(), null);
    assert.equal(fnExists(), false);
    assert.equal(guardState(), "O");
    assert.equal(ledgerChecksum(F3360), null, "after its rollback the runner would apply 3360 again");
    // Sealed rows stay sealed: nothing un-seals them.
    assert.equal(
      scalar(`SELECT count(*) FROM public.intel_evidence WHERE detail->>'suite' = '${SUITE}' AND reference ~ '^ievr1\\.'`) !== "0",
      true,
    );
  });
});

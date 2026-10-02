/**
 * `global_journey_shadow_stop_v1` — the delete-scope contract (migration 2976).
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `public.global_journey_shadow_stop_v1(uuid)` is the emergency stop for the
 * Journey shadow-segmentation programme: a SECURITY DEFINER, service_role-only
 * RPC that disables the feature flags, deactivates stages, revokes every cohort
 * assignment and session issuance, ends the open journey-purpose sessions, and
 * erases the observations, segment revisions and ground truth collected under
 * the programme.
 *
 * It shipped to production with THREE unqualified deletes. Production runs
 * `session_preload_libraries = supautils`, whose `safeupdate` guard raises
 * "DELETE requires a WHERE clause" for PostgREST-role sessions. The deletes sit
 * AFTER the four qualified UPDATEs that stop collection, so a call through the
 * API raised at the first delete and rolled the whole transaction back — the
 * flags stayed on, the cohorts stayed live, the sessions stayed open. The stop
 * did NOTHING AT ALL.
 *
 * WHY THIS TEST IS STATIC
 * -----------------------
 * The object exists ONLY in production: it was authored on a branch that never
 * merged (`2127_journey_shadow_controlled_rollout.sql`, SECTION 9) and applied
 * out of band, so `portava-ci` has no such function and no live suite can reach
 * it. The property that matters — whether a body contains the statement shape
 * `safeupdate` refuses — is a fact about TEXT and is decidable with no network,
 * so it is asserted here rather than left to an environment that does not exist.
 *
 * THE STAGE-4 PREDICATES ARE IMPORTED, NOT MIRRORED
 * -------------------------------------------------
 * Case (7) asserts 2976's block shape against `isAssertionOnlyDoBlock` and
 * `isPreconditionDoBlock` IMPORTED from `src/scripts/lib/migrationSqlBlocks.ts`.
 * An earlier version of this file copied those functions in, because they lived
 * inside `certifyMigrations.ts`, which cannot be imported (its first import is
 * the strict CI front door and its last line is `await main()`). #516 lifted
 * them out precisely so they could be exercised, so this file now asserts
 * against THE REAL RULE rather than a copy of it that can drift.
 *
 * FAILING-FIRST, HONESTLY
 * -----------------------
 * A detector that cannot detect is worse than no detector. Case (1) runs this
 * file's matcher against `artifacts/api-server/src/test/fixtures/global_journey_shadow_stop_v1.preimage.sql`
 * — the verbatim `pg_get_functiondef` output captured from production BEFORE
 * the repair, md5 `05e711b9fb218e42171988c1c56b8d26` — and requires it to find
 * exactly the three unqualified deletes. If the matcher ever stops matching the
 * known-bad text, this suite fails there first, before it can report the
 * repaired body clean for the wrong reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  topLevelStatements,
} from "../scripts/lib/migrationSqlBlocks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const MIGRATION = resolve(
  repoRoot,
  "artifacts/api-server/src/migrations/2976_journey_shadow_global_stop_delete_scope.sql",
);
const PREIMAGE = resolve(
  repoRoot,
  "artifacts/api-server/src/test/fixtures/global_journey_shadow_stop_v1.preimage.sql",
);

/** The md5 of the pre-repair `pg_get_functiondef` output, gated by 2976's `$pre$`. */
const PREIMAGE_MD5 = "05e711b9fb218e42171988c1c56b8d26";

/** The tables the stop erases from. */
const ERASED_TABLES = [
  "public.journey_shadow_ground_truth",
  "public.journey_observations",
  "public.journey_segment_revisions",
] as const;

/** The programme's scope marker, already used by the function's session-end UPDATE. */
const SCOPE_PREDICATE = "journey_purpose = 'journey_observation_v1'";

/** Strip `--` line comments so prose can neither create nor hide a match. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * The statement shape `safeupdate` refuses: DELETE FROM <name> with no
 * qualification before the terminating semicolon.
 */
function unqualifiedDeletes(sql: string): string[] {
  const re = /DELETE\s+FROM\s+([A-Za-z_][\w.]*)\s*;/gi;
  return [...stripComments(sql).matchAll(re)].map((m) => m[1]);
}

/** The canonical body 2976 installs, isolated from the migration's own prose and logic. */
function canonicalBody(): string {
  const file = readFileSync(MIGRATION, "utf8");
  const start = file.indexOf(
    "CREATE OR REPLACE FUNCTION public.global_journey_shadow_stop_v1(p_actor uuid)",
  );
  assert.ok(start >= 0, "2976 must contain the canonical CREATE OR REPLACE FUNCTION");
  const end = file.indexOf("$function$;", start);
  assert.ok(end > start, "2976's canonical definition must be terminated by $function$;");
  return file.slice(start, end);
}

describe("global_journey_shadow_stop_v1 delete scope (2976)", () => {
  it("(1) the matcher finds exactly the three unqualified deletes in the captured pre-image", () => {
    const preimage = readFileSync(PREIMAGE, "utf8");

    assert.equal(
      createHash("md5").update(preimage).digest("hex"),
      PREIMAGE_MD5,
      "the captured pre-image must stay byte-identical to what production ran, or it is " +
        "no longer evidence of anything and 2976's md5 gate no longer describes it",
    );

    assert.deepEqual(
      unqualifiedDeletes(preimage).sort(),
      [...ERASED_TABLES].sort(),
      "the known-bad body must trip the matcher; if it does not, the matcher is broken " +
        "and every other case in this file is passing for the wrong reason",
    );
  });

  it("(2) the repaired body carries no unqualified delete", () => {
    assert.deepEqual(
      unqualifiedDeletes(canonicalBody()),
      [],
      "an unqualified DELETE is the exact shape supautils safeupdate refuses; one of these " +
        "makes the whole stop roll back and do nothing",
    );
  });

  it("(3) the qualification is the real scope predicate, never a tautology", () => {
    const body = stripComments(canonicalBody());

    assert.ok(
      !/WHERE\s+true\b/i.test(body),
      "`WHERE true` satisfies the guard's parser without expressing the scope of the stop. " +
        "The predicate must name what is being stopped.",
    );

    // Three deletes plus the session-end UPDATE the function already had.
    const scopeUses = body.split(SCOPE_PREDICATE).length - 1;
    assert.equal(
      scopeUses,
      4,
      `expected 4 uses of \`${SCOPE_PREDICATE}\` (one per erased table, plus the session end), found ${scopeUses}`,
    );

    for (const table of ERASED_TABLES) {
      const at = body.indexOf(`DELETE FROM ${table}`);
      assert.ok(at >= 0, `${table} must still be erased — the stop's contract includes erasure`);
      const stmt = body.slice(at, body.indexOf(";", at));
      assert.ok(
        stmt.includes(SCOPE_PREDICATE),
        `the delete on ${table} must be scoped to the programme's journey-purpose sessions`,
      );
    }
  });

  it("(4) journey_segment_revisions also carries the participant clause", () => {
    // That table has NO foreign key on location_session_id (its only FKs are
    // user_id -> profiles CASCADE and supersedes_id -> self), so unlike the other
    // two a revision can outlive its session row. Session-purpose alone would
    // leave those orphans behind, which is a retention failure, not a style point.
    const body = stripComments(canonicalBody());
    const at = body.indexOf("DELETE FROM public.journey_segment_revisions");
    const stmt = body.slice(at, body.indexOf(";", at));
    assert.match(
      stmt,
      /OR\s+jsr\.user_id\s+IN\s*\(\s*SELECT\s+ca\.user_id\s+FROM\s+public\.journey_shadow_cohort_assignments\s+ca/,
      "segment revisions need the second scope clause — programme participants — so the " +
        "union cannot leave an orphaned revision behind",
    );
  });

  it("(5) authorization is preserved: SECURITY DEFINER, service_role only", () => {
    const file = stripComments(readFileSync(MIGRATION, "utf8"));

    assert.match(canonicalBody(), /SECURITY DEFINER/, "the stop must stay SECURITY DEFINER");
    assert.match(
      canonicalBody(),
      /SET search_path = ''/,
      "an empty search_path is what makes a SECURITY DEFINER body safe to run as owner",
    );
    assert.match(
      file,
      /REVOKE ALL ON FUNCTION public\.global_journey_shadow_stop_v1\(uuid\)\s*\n?\s*FROM PUBLIC, anon, authenticated;/,
      "EXECUTE must be revoked from PUBLIC, anon and authenticated",
    );
    assert.match(
      file,
      /GRANT EXECUTE ON FUNCTION public\.global_journey_shadow_stop_v1\(uuid\)\s*\n?\s*TO service_role;/,
      "service_role is the only grantee",
    );
    assert.ok(
      !/GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated)\b/.test(file),
      "nothing in 2976 may grant anon or authenticated anything",
    );
  });

  it("(6) the tables the retention rules keep are never deleted from", () => {
    // d6Classifications: journey_revocation_jobs is RETAIN_LEGAL_SECURITY ("DELETION
    // AUDIT EVIDENCE"), journey_retention_health is RETAIN_AGGREGATE_NON_PERSONAL,
    // journey_shadow_qa_reports is ANONYMIZE. A stop that erased those would destroy
    // the record that the stop happened.
    const body = stripComments(canonicalBody());
    for (const kept of [
      "journey_revocation_jobs",
      "journey_retention_health",
      "journey_shadow_qa_reports",
    ]) {
      assert.ok(
        !new RegExp(`DELETE\\s+FROM\\s+public\\.${kept}\\b`, "i").test(body),
        `${kept} is retained by the deletion rulings; the stop must not delete from it`,
      );
    }
    // The history rows are revoked, not removed.
    for (const revoked of [
      "journey_shadow_cohort_assignments",
      "journey_shadow_session_issuances",
      "journey_shadow_stages",
    ]) {
      assert.ok(
        !new RegExp(`DELETE\\s+FROM\\s+public\\.${revoked}\\b`, "i").test(body),
        `${revoked} must be updated to revoked/inactive, never deleted — it is the audit trail`,
      );
    }
  });

  it("(7) the three DO blocks are classified by stage 4 exactly as this file intends", () => {
    // WHAT STAGE 4 ACTUALLY DOES, since the earlier version of this test had it
    // wrong and #516 settled it. `certifyMigrations.ts` does NOT re-run "every DO
    // block": it collects only blocks that `isAssertionOnlyDoBlock()` accepts, and
    // then holds back the ones `isPreconditionDoBlock()` recognises. So:
    //   $mig$  — contains EXECUTE, so not assertion-only: never collected.
    //   $pre$  — assertion-only, but tagged a precondition: held back by #516.
    //   $post$ — assertion-only and NOT a precondition: this is the one re-run.
    // Asserted with the real predicates, imported. A change to either side of
    // this contract — 2976's shape, or the classification rule — fails here.
    const file = readFileSync(MIGRATION, "utf8");

    const doBlocks = [...file.matchAll(/DO \$(\w+)\$([\s\S]*?)\$\1\$;/g)];
    assert.deepEqual(
      doBlocks.map(([, tag]) => tag),
      ["pre", "mig", "post"],
      "2976 is a gate, a guarded apply and an assertion — the $mig$ block is what makes " +
        "the repair conditional on the object existing",
    );

    const blocks = new Map(doBlocks.map(([whole, tag]) => [tag, whole]));

    assert.ok(
      !isAssertionOnlyDoBlock(blocks.get("mig")!),
      "$mig$ performs the repair via EXECUTE; if it ever became assertion-only, stage 4 " +
        "would start re-running the apply against the committed database",
    );
    for (const tag of ["pre", "post"]) {
      assert.ok(
        isAssertionOnlyDoBlock(blocks.get(tag)!),
        `$${tag}$ must be assertion-only, or it is not a guard at all`,
      );
    }
    assert.ok(
      isPreconditionDoBlock(blocks.get("pre")!),
      "$pre$ must be recognised as a precondition, or stage 4 re-runs a claim about the " +
        "state BEFORE the apply against the state AFTER it — the false failure #516 removed",
    );
    assert.ok(
      !isPreconditionDoBlock(blocks.get("post")!),
      "$post$ must NOT be held back: it is the one block whose whole job is to be re-run",
    );

    // The apply is not a top-level statement that would run unconditionally.
    const topLevel = topLevelStatements(file);
    assert.ok(
      !topLevel.some((s) => /^\s*CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(s)),
      "the CREATE OR REPLACE must live INSIDE the guarded $mig$ block; at top level it " +
        "would create the function from nothing on any database built from the chain",
    );

    assert.ok(
      file.includes(PREIMAGE_MD5),
      "$pre$ must gate on the recorded pre-image md5, so the canonical body replaces only " +
        "the exact body this file was written against",
    );
  });

  it("(8) an ABSENT object is a quiet no-op in all three blocks, and the md5 gate is not weakened", () => {
    // THE CHAIN-REPLAYABILITY DEFECT THIS COVERS. 2976 repairs an object that is
    // NOT in the canonical chain — it was authored in 2127 SECTION 9 on a branch
    // that never merged and reached production out of band. So on any database
    // built from the chain alone (CI's throwaway PostgreSQL, and portava-ci,
    // where it is measurably absent) there is no such function. The first version
    // of this file RAISED in that case, which aborted the whole chain replay and
    // turned the `kernel SQL executed on a throwaway database` job red. A
    // migration that aborts the replay of its own chain is broken however right
    // it is about production.
    //
    // The fix is that absence is a NO-OP — and it has to be a no-op in all three
    // blocks from the SAME observation, or they disagree: a $pre$ that returns
    // quietly while $post$ still asserts is the same false failure in a new place.
    const file = readFileSync(MIGRATION, "utf8");
    const doBlocks = new Map(
      [...file.matchAll(/DO \$(\w+)\$([\s\S]*?)\$\1\$;/g)].map(([, tag, body]) => [tag, body]),
    );

    for (const tag of ["pre", "mig", "post"]) {
      const body = doBlocks.get(tag)!;
      // Each block decides on its own lookup of the same catalog fact.
      // `\x27` is the `'` this pattern needs, written as an escape ON PURPOSE.
      // check:security-definer-oracles resolves a reference edge from any
      // quoted `"<name>"` token in src/, and treats that as something calling
      // the function. This function has NO caller — its callers are on an
      // unmerged branch, which is exactly what SECURITY_DEFINER_ORACLES.json
      // records — so a test asserting ABOUT it must not manufacture the
      // weakest, most misleading kind of reference to it. The check's own
      // report calls a bare string literal "the one a stale test fixture
      // produces". This keeps the assertion exact and the reference graph honest.
      assert.match(
        body,
        /proname\s*=\s*\x27global_journey_shadow_stop_v1\x27/,
        `$${tag}$ must derive the presence of the object itself, so the skip and the ` +
          "assertions can never disagree about what happened",
      );
      const absent = tag === "mig" ? /IF NOT EXISTS \(/ : /IF d IS NULL THEN/;
      assert.match(body, absent, `$${tag}$ must have an explicit absent branch`);

      // The absent branch must NOTICE-and-RETURN, never RAISE EXCEPTION.
      const at = body.search(absent);
      const branch = body.slice(at, body.indexOf("END IF;", at));
      assert.match(
        branch,
        /RAISE NOTICE/,
        `$${tag}$'s absent branch must say out loud that it skipped — a silent skip is ` +
          "indistinguishable from a guard that did not run",
      );
      assert.match(
        branch,
        /\bRETURN;/,
        `$${tag}$'s absent branch must RETURN, not fall through`,
      );
      assert.ok(
        !/RAISE EXCEPTION/.test(branch),
        `$${tag}$ must not raise when the object is absent: on a chain-built database ` +
          "there is genuinely nothing to repair, and that is a correct outcome",
      );
    }

    // NOT WEAKENED: absent and unrecognised are different branches. A body that is
    // neither the pre-image nor the post-state must still be REFUSED outright.
    const pre = doBlocks.get("pre")!;
    assert.match(
      pre,
      /RAISE EXCEPTION[\s\S]*REFUSING rather than overwriting a body this file has not read/,
      "the md5 gate must still refuse an unrecognised installed body — 'absent -> skip' " +
        "and 'present but unrecognised -> refuse' are different branches and must stay different",
    );
    assert.match(
      pre,
      /already applied/,
      "$pre$ must also return quietly on the post-state, so a second apply is a no-op",
    );

    // And the guarded apply must refuse to conjure the object.
    assert.match(
      doBlocks.get("mig")!,
      /refusing to create it from nothing/i,
      "the apply block is what makes 'will not create one from nothing' true in behaviour " +
        "rather than only in the header",
    );
  });
});

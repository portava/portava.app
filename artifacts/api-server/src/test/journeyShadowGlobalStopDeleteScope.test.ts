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
 * FAILING-FIRST, HONESTLY
 * -----------------------
 * A detector that cannot detect is worse than no detector. Case (1) runs this
 * file's matcher against `docs/sql/global_journey_shadow_stop_v1.preimage.sql`
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const MIGRATION = resolve(
  repoRoot,
  "artifacts/api-server/src/migrations/2976_journey_shadow_global_stop_delete_scope.sql",
);
const PREIMAGE = resolve(
  repoRoot,
  "docs/sql/global_journey_shadow_stop_v1.preimage.sql",
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
 * `maskForKeywordScan` / `isAssertionOnlyDoBlock`, mirrored from
 * `src/scripts/certifyMigrations.ts:146,279`. Mirrored rather than imported
 * because that module is a script with side effects and exports neither; the
 * point is to assert against THE REAL RULE — which blanks comments, quoted
 * literals and dollar-quoted bodies — and not a stricter invention of this test.
 * A naive /\bEXECUTE\b/ scan fails here on `has_function_privilege(..., 'EXECUTE')`,
 * which is a string literal the real rule masks.
 */
function maskForKeywordScan(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += " ";
      continue;
    }
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const end = sql.indexOf(tag, bodyStart);
        const bodyEnd = end === -1 ? sql.length : end;
        out += " " + maskForKeywordScan(sql.slice(bodyStart, bodyEnd)) + " ";
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const MUTATION_KEYWORD_RE =
  /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|REFRESH|REINDEX|CALL|COPY|EXECUTE)\b/i;

function isAssertionOnlyDoBlock(stmt: string): boolean {
  const masked = maskForKeywordScan(stmt);
  if (!/^\s*DO\b/i.test(masked)) return false;
  if (!/\bRAISE\b/i.test(masked)) return false;
  return !MUTATION_KEYWORD_RE.test(masked);
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

  it("(7) the preconditions tolerate the post-state, so certify:migrations stage 4 can re-run them", () => {
    // docs/migrations.md, "A TRAP IN `certify:migrations` THAT 2965 SPRANG":
    // stage 4 re-runs every DO block as if it were a postcondition, and refuses
    // any block that is not read-only. 2965 sprang it twice — a precondition that
    // raised on the post-state, and a `$mig$` block containing EXECUTE. 2976 keeps
    // the replacement at TOP LEVEL (stage 4 never re-runs a non-DO statement) and
    // both DO blocks assertion-only and re-runnable.
    const file = readFileSync(MIGRATION, "utf8");

    const doBlocks = [...file.matchAll(/DO \$(\w+)\$([\s\S]*?)\$\1\$;/g)];
    assert.deepEqual(
      doBlocks.map(([, tag]) => tag),
      ["pre", "post"],
      "2976 must have exactly the $pre$ and $post$ blocks — a $mig$ block doing the work " +
        "is the shape stage 4 refuses",
    );

    for (const [block, tag] of doBlocks.map(([b, t]) => [b, t] as const)) {
      assert.ok(
        isAssertionOnlyDoBlock(block),
        `$${tag}$ must satisfy certifyMigrations' isAssertionOnlyDoBlock, or stage 4 refuses it`,
      );
    }

    const pre = doBlocks.find(([, tag]) => tag === "pre")![2];
    assert.match(
      pre,
      /already applied/,
      "$pre$ must return quietly on the post-state rather than raising, or certify stage 4 " +
        "fails on the very run that applies this migration",
    );

    assert.ok(
      file.includes(PREIMAGE_MD5),
      "$pre$ must gate on the recorded pre-image md5, so the canonical body replaces only " +
        "the exact body this file was written against",
    );
  });
});

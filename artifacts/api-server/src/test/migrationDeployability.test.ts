/**
 * Migration deployability guard.
 *
 * THE FAILURE THIS IS WRITTEN AGAINST (2026-08-28)
 * ------------------------------------------------
 * `2195_memory_inferred_preferences.sql` was executed together with an ad-hoc
 * verification block that reported its results by RAISEing:
 *
 *     DO $proof$ BEGIN ... RAISE EXCEPTION 'PROOF_2195 | inferred=0.85 ...'; END $proof$;
 *
 * Every assertion in it passed. The proof printed a perfect result. And because
 * PostgreSQL aborts the whole transaction on any exception, the CREATE FUNCTION
 * statements in the same batch were **rolled back** — so the migration reported
 * success while persisting nothing. The drift audit caught it; the "proof" had
 * actively concealed it.
 *
 * The general failure class: **an assertion that succeeds inside a transaction
 * that then aborts proves nothing about what persisted.** Verification must be
 * observed from a SEPARATE transaction, never from inside the one being verified.
 *
 * WHAT THIS GUARD ENFORCES
 * ------------------------
 * A top-level `DO` block in a migration may only RAISE from inside a failure
 * condition (`IF <bad thing> THEN RAISE`). An unconditional RAISE in a `DO` block
 * aborts the migration by construction, so it can only ever be a reporter — which
 * does not belong in a deployable file.
 *
 * Trigger-function bodies are deliberately NOT flagged: an append-only guard like
 * `memory_events_no_update` raises unconditionally *because it only runs when the
 * forbidden operation happens*. That is the correct shape, and seven pre-existing
 * migrations rely on it.
 *
 * Pure and offline — reads the migration directory, no database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Extract the top-level `DO $tag$ ... $tag$` blocks from a migration.
 * Function bodies use the same dollar-quoting, so they are excluded by requiring
 * the block to start at a line beginning with `DO`.
 */
function topLevelDoBlocks(sql: string): string[] {
  const blocks: string[] = [];
  const re = /^DO\s+(\$[a-zA-Z_]*\$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const tag = m[1];
    const start = m.index + m[0].length;
    const end = sql.indexOf(tag, start);
    if (end === -1) continue;
    blocks.push(sql.slice(start, end));
    re.lastIndex = end + tag.length;
  }
  return blocks;
}

/**
 * Only ABORTING raises matter. `RAISE NOTICE|WARNING|INFO|LOG|DEBUG` merely logs
 * and leaves the transaction intact — 2083 uses an unconditional RAISE NOTICE to
 * report backfill progress, which is legitimate and must not be flagged, or the
 * guard would push people to delete harmless logging. `RAISE EXCEPTION`, and a
 * bare `RAISE 'msg'` (which defaults to EXCEPTION), are the aborting forms.
 */
const ABORTING_RAISE = /^\s*RAISE\s+(EXCEPTION\b|'|USING\b)/i;

/**
 * THE NEGATIVE-PROBE SHAPE, and why it is not an unconditional RAISE.
 *
 * A postcondition that asserts a CHECK actually REJECTS bad data cannot be
 * written with an IF. It is written as a sub-block:
 *
 *     BEGIN
 *       INSERT ... VALUES (... 'not-a-valid-token');            -- must throw
 *       RAISE EXCEPTION 'POSTCONDITION FAILED: ... was accepted';
 *     EXCEPTION
 *       WHEN check_violation THEN NULL;   -- correct: it rejected the row
 *     END;
 *
 * The RAISE is the "the constraint did NOT fire" arm. It is reached only when
 * the statement above it fails to throw, which is precisely the condition the
 * postcondition exists to detect — so it is conditional on a runtime outcome
 * rather than on an IF, and the walk-back below cannot see that.
 *
 * `2891_rank_events_recommendation_id.sql` is the case that forced this, and it
 * carries the empirical proof: it APPLIED CLEANLY TO PRODUCTION on 2026-09-14
 * (see docs/architecture/production-deployment-2026-09-14.md), which it could
 * not have done if that RAISE were reachable.
 *
 * THE EXEMPTION IS NARROW ON PURPOSE. It requires BOTH:
 *   (a) at least one real statement between the nested BEGIN and the RAISE —
 *       the probe. A RAISE that is the FIRST thing in such a block IS
 *       unconditional and is still an offender; and
 *   (b) an EXCEPTION handler on that same nested block.
 * A block with neither is unchanged by this, and mutation M-NP below proves
 * (a) is load-bearing.
 */
function isNegativeProbeRaise(lines: string[], raiseAt: number, beginAt: number): boolean {
  // (a) a probe statement between the nested BEGIN and the RAISE
  let sawStatement = false;
  for (let k = beginAt + 1; k < raiseAt; k++) {
    const t = lines[k].trim();
    if (t === "" || t.startsWith("--")) continue;
    sawStatement = true;
    break;
  }
  if (!sawStatement) return false;
  // (b) an EXCEPTION handler on that same nested block, before its END
  for (let k = raiseAt + 1; k < lines.length; k++) {
    if (/^\s*EXCEPTION\s*$/i.test(lines[k]) || /^\s*EXCEPTION\s+WHEN\b/i.test(lines[k])) return true;
    if (/^\s*END\s*;/i.test(lines[k])) return false;
  }
  return false;
}

/** A RAISE is acceptable only if a guarding IF/THEN/ELSIF precedes it in the block. */
function unconditionalRaises(block: string): string[] {
  const lines = block.split("\n");
  const offenders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ABORTING_RAISE.test(lines[i])) continue;
    // The IF/THEN rule, UNCHANGED: a guard must sit within 8 lines above.
    let guarded = false;
    let stoppedAtBegin = -1;
    for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
      const p = lines[j];
      if (/\bTHEN\b|\bIF\b|\bELSE\b|\bELSIF\b|\bEXCEPTION\s+WHEN\b|\bLOOP\b/i.test(p)) { guarded = true; break; }
      if (/^\s*(BEGIN|DECLARE)\s*;?\s*$/i.test(p)) { stoppedAtBegin = j; break; }
    }
    // Only if that found nothing: is this the negative-probe shape? The probe
    // statement can be long (2920's is a nine-line INSERT), so the enclosing
    // nested BEGIN is searched further back than 8 lines — but ONLY to answer
    // isNegativeProbeRaise, never to satisfy the IF/THEN rule above.
    if (!guarded) {
      let b = stoppedAtBegin;
      if (b === -1) {
        for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
          if (/^\s*BEGIN\s*;?\s*$/i.test(lines[j])) { b = j; break; }
          if (/^\s*DECLARE\s*;?\s*$/i.test(lines[j])) break;
        }
      }
      if (b !== -1 && /^\s*BEGIN\s*;?\s*$/i.test(lines[b])) guarded = isNegativeProbeRaise(lines, i, b);
    }
    if (!guarded) offenders.push(lines[i].trim().slice(0, 120));
  }
  return offenders;
}

describe("migrations must be deployable — no self-aborting proof blocks", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

  it("finds migrations to check (the guard is not silently scanning nothing)", () => {
    assert.ok(files.length > 100, `expected the full migration set, found ${files.length}`);
  });

  it("no top-level DO block contains an UNCONDITIONAL RAISE", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8");
      for (const block of topLevelDoBlocks(sql)) {
        for (const line of unconditionalRaises(block)) {
          offenders.push(`${f}: ${line}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "A migration contains a top-level DO block that RAISEs unconditionally. That aborts the\n" +
        "transaction, so every DDL statement in the same batch is ROLLED BACK — the migration\n" +
        "reports success and persists nothing (this is exactly how 2195 silently failed).\n" +
        "If this is a verification block, move it into a DB regression test that observes from a\n" +
        "SEPARATE transaction. Offenders:\n  " + offenders.join("\n  "),
    );
  });

  it("does NOT flag RAISE NOTICE — it logs, it does not abort", () => {
    // 2083 reports backfill progress with an unconditional RAISE NOTICE. That is
    // legitimate: a NOTICE leaves the transaction intact, so nothing is rolled
    // back. Flagging it would push people to delete useful logging in the name of
    // a rule about aborts.
    const flagged = unconditionalRaises(`
      BEGIN
        RAISE NOTICE 'post_media now holds % rows.', n;
      END
    `);
    assert.deepEqual(flagged, [], "RAISE NOTICE must not be treated as an aborting raise");

    const aborts = unconditionalRaises(`
      BEGIN
        RAISE EXCEPTION 'PROOF | everything looks great';
      END
    `);
    assert.equal(aborts.length, 1, "an unconditional RAISE EXCEPTION must be flagged");
  });

  it("does NOT flag trigger-function bodies, which raise unconditionally by design", () => {
    // 2183's append-only guard raises whenever an UPDATE is attempted; that is the
    // whole point of it. If this ever starts failing, the guard has become
    // over-broad and would push people to weaken correct code.
    const sql = readFileSync(join(MIGRATIONS, "2183_memory_projection_contract.sql"), "utf8");
    assert.ok(
      /RAISE EXCEPTION 'memory_events is append-only/.test(sql),
      "fixture drifted: 2183 no longer contains the append-only trigger raise",
    );
    const flagged = topLevelDoBlocks(sql).flatMap(unconditionalRaises);
    assert.deepEqual(flagged, [], "the trigger-function raise must not be flagged");
  });
});

/**
 * THE RELAXATION'S BOUNDARY, asserted rather than hoped for.
 *
 * `isNegativeProbeRaise` widens what counts as guarded, and a widening that is
 * not pinned is how a guard quietly stops guarding. These cases run the
 * detector against literal blocks, so they do not depend on any migration
 * staying the shape it is today.
 */
describe("the negative-probe exemption is narrow", () => {
  const raise = "    RAISE EXCEPTION 'it was accepted';";

  it("ACCEPTS a probe followed by the raise, inside a handled sub-block", () => {
    const block = ["DO $$", "BEGIN", "  BEGIN", "    INSERT INTO t VALUES (1);", raise,
                   "  EXCEPTION", "    WHEN check_violation THEN NULL;", "  END;", "END $$;"].join("\n");
    assert.deepEqual(unconditionalRaises(block), []);
  });

  it("REFUSES a raise that is the FIRST thing in the sub-block — nothing can stop it", () => {
    const block = ["DO $$", "BEGIN", "  BEGIN", raise,
                   "  EXCEPTION", "    WHEN check_violation THEN NULL;", "  END;", "END $$;"].join("\n");
    assert.equal(unconditionalRaises(block).length, 1,
      "a raise with no probe above it aborts every deployment, handler or not");
  });

  it("REFUSES a probe-and-raise with NO handler on the sub-block", () => {
    const block = ["DO $$", "BEGIN", "  BEGIN", "    INSERT INTO t VALUES (1);", raise,
                   "  END;", "END $$;"].join("\n");
    assert.equal(unconditionalRaises(block).length, 1,
      "without an EXCEPTION handler the probe's own failure aborts too, so the shape is not a probe");
  });

  it("REFUSES a bare raise at the top of the outer block, which is the original rule", () => {
    const block = ["DO $$", "BEGIN", raise, "END $$;"].join("\n");
    assert.equal(unconditionalRaises(block).length, 1);
  });

  it("still ACCEPTS the ordinary IF-guarded raise, which must not have changed", () => {
    const block = ["DO $$", "BEGIN", "  IF x IS NULL THEN", raise, "  END IF;", "END $$;"].join("\n");
    assert.deepEqual(unconditionalRaises(block), []);
  });

  it("does not let a handler BELOW an unrelated END rescue a raise", () => {
    const block = ["DO $$", "BEGIN", "  BEGIN", "    INSERT INTO t VALUES (1);", raise,
                   "  END;", "  BEGIN", "    PERFORM 1;", "  EXCEPTION",
                   "    WHEN others THEN NULL;", "  END;", "END $$;"].join("\n");
    assert.equal(unconditionalRaises(block).length, 1,
      "the handler belongs to a LATER sub-block; the raise's own block has none");
  });
});

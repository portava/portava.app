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

/** A RAISE is acceptable only if a guarding IF/THEN/ELSIF precedes it in the block. */
function unconditionalRaises(block: string): string[] {
  const lines = block.split("\n");
  const offenders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!ABORTING_RAISE.test(lines[i])) continue;
    let guarded = false;
    for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
      const p = lines[j];
      if (/\bTHEN\b|\bIF\b|\bELSE\b|\bELSIF\b|\bEXCEPTION\s+WHEN\b|\bLOOP\b/i.test(p)) { guarded = true; break; }
      if (/^\s*(BEGIN|DECLARE)\s*;?\s*$/i.test(p)) break;
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

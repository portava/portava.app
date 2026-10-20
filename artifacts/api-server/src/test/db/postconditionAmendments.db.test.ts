/**
 * postconditionAmendments — the chain-end half of every declaration in
 * src/scripts/lib/postconditionAmendments.ts, on the database the whole chain
 * built (CI's local-db replica, real PostgreSQL). For each declared block:
 *
 *   1. as written it FAILS here — otherwise the declaration hides nothing and
 *      must be deleted (the superseder rolled back, the object restored);
 *   2. with every declared statement dropped it PASSES — the drops are enough,
 *      and nothing else in the block is broken;
 *   3. with any ONE drop withheld it FAILS, and the error carries that drop's
 *      failsWith — every drop is necessary, and fails for the declared reason;
 *   4. every re-assertion PASSES: the re-asserting migrations' postconditions
 *      (amended by their own declarations) and the inline re-assertion;
 *   5. each inline re-assertion can FAIL: against a deliberately broken state
 *      inside a rolled-back transaction (2274/3002, memory, the 2151/2158 client
 *      table-level privileges), or with any one pinned kernel count off by one.
 *
 * scripts/local-db/run-tests.sh runs this suite FIRST and ALONE, right after
 * up.sh replayed the chain, so "the chain end" is the replay's and not whatever
 * an earlier suite committed (V-714 F2; certifyPostconditionAmendments.test.ts E).
 *
 * Every block runs inside BEGIN … ROLLBACK, so the shared database is left as
 * found. certifyPostconditionAmendments.test.ts holds the static half.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postconditionAmendments.db.test.ts
 *      Skips without a database, like every src/test/db suite.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, psql } from "./localDb.js";
import { amendBlock, postconditionBlocks, type PostconditionAmendment } from "../../scripts/lib/migrationSqlBlocks.js";
import { POSTCONDITION_AMENDMENTS } from "../../scripts/lib/postconditionAmendments.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(__dir, "../../migrations");
const sqlOf = (f: string) => readFileSync(join(MIG, f), "utf8");
const run = (block: string) => psql(`BEGIN;\n${block}\nROLLBACK;\n`);
const declOf = (file: string, line: number) => POSTCONDITION_AMENDMENTS.find((a) => a.file === file && a.blockLine === line);

/** A file's postconditions as certify sends them on a whole-chain run: amended by their own declarations. */
function amendedPostconditions(file: string): string[] {
  const sql = sqlOf(file);
  return postconditionBlocks(sql).map((b) => {
    const d = declOf(file, b.firstLine);
    if (!d) return b.text;
    const r = amendBlock(sql, b, d.drops);
    if (!r.ok) throw new Error(`${file}:${b.firstLine}: ${r.reason}`);
    return r.text;
  });
}

function blockOf(a: PostconditionAmendment) {
  const sql = sqlOf(a.file);
  const b = postconditionBlocks(sql).find((x) => x.firstLine === a.blockLine);
  if (!b) throw new Error(`${a.file}: no postcondition block at line ${a.blockLine}`);
  return { sql, b };
}

describe("certify:migrations stage 4 — every declared amendment, at the chain end", { skip: !HAVE_DB }, () => {
  it("anti-vacuity: the declarations are found", () => {
    assert.ok(POSTCONDITION_AMENDMENTS.length >= 33, `found ${POSTCONDITION_AMENDMENTS.length}`);
  });

  for (const a of POSTCONDITION_AMENDMENTS) {
    it(`${a.file}:${a.blockLine} (${a.kind}): fails as written, passes amended, each drop necessary, re-assertions pass`, () => {
      const { sql, b } = blockOf(a);

      const asWritten = run(b.text);
      assert.notEqual(asWritten.status, 0, `${a.file}:${a.blockLine} PASSES as written at the chain end: the declaration hides nothing; delete it`);

      const all = amendBlock(sql, b, a.drops);
      assert.ok(all.ok, (all as { reason?: string }).reason);
      if (!all.ok) return;
      const amended = run(all.text);
      assert.equal(amended.status, 0, `the amended block must pass at the chain end:\n${amended.stderr}`);

      for (const [k, d] of a.drops.entries()) {
        const withheld = amendBlock(sql, b, a.drops.filter((_, j) => j !== k));
        assert.ok(withheld.ok, (withheld as { reason?: string }).reason);
        if (!withheld.ok) continue;
        const r = run(withheld.text);
        assert.notEqual(r.status, 0, `lines ${d.lines.join("-")} are not necessary: the block passes without dropping them`);
        assert.ok(r.stderr.includes(d.failsWith), `lines ${d.lines.join("-")} fail for another reason than declared ("${d.failsWith}"):\n${r.stderr}`);
      }

      if (a.kind === "superseded") {
        const files = a.reassertedBy ?? [...new Set(a.drops.map((d) => d.supersededBy!))];
        for (const f of files) {
          for (const text of amendedPostconditions(f)) {
            const r = run(text);
            assert.equal(r.status, 0, `re-assertion ${f} must pass at the chain end:\n${r.stderr}`);
          }
        }
        if (a.reassert !== undefined) {
          const r = run(a.reassert);
          assert.equal(r.status, 0, `the inline re-assertion must pass at the chain end:\n${r.stderr}`);
        }
      }
    });
  }

  it("the 2274/3002 re-assertion fails when intel_observations_select_own is widened", () => {
    const a = declOf("2274_intel_claim_observation_model.sql", 223)!;
    const r = psql(`BEGIN;\nALTER POLICY intel_observations_select_own ON public.intel_observations USING (true);\n${a.reassert}\nROLLBACK;\n`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /RE-ASSERTION FAILED \(2274 as superseded by 3002\)/);
  });

  it("the 2151/2158 re-assertion fails on ANY client table-level privilege on passport_postcards / post_media (V-714 F3)", () => {
    const a = declOf("2151_passport_postcards_write_boundary.sql", 107)!;
    assert.equal(a.reassert, declOf("2158_post_media_write_boundary.sql", 34)!.reassert, "one shared re-assertion");
    for (const grant of [
      "GRANT DELETE ON public.passport_postcards TO authenticated",
      "GRANT SELECT ON public.passport_postcards TO anon",
      "GRANT DELETE ON public.post_media TO authenticated",
      "GRANT INSERT ON public.post_media TO PUBLIC",
    ]) {
      const r = psql(`BEGIN;\n${grant};\n${a.reassert}\nROLLBACK;\n`);
      assert.notEqual(r.status, 0, `${grant}: the re-assertion still passes`);
      assert.match(r.stderr, /RE-ASSERTION FAILED \(2151\/2158 as superseded by 2152\/3363\)/, grant);
    }
  });

  it("the trip kernel count re-assertion fails when ANY pinned count is off by one (V-714 F4)", () => {
    const a = declOf("2764_trip_kernel_stage_family.sql", 239)!;
    const text = a.reassert!;
    const variants: string[] = [];
    for (const m of text.matchAll(/'([a-z_]+):(\d+)'/g)) variants.push(text.replace(m[0], `'${m[1]}:${Number(m[2]) + 1}'`));
    for (const n of ["3", "5", "73"]) {
      const needle = `IF n <> ${n} THEN`;
      assert.equal(text.split(needle).length, 2, `exactly one "${needle}"`);
      variants.push(text.replace(needle, `IF n <> ${Number(n) + 1} THEN`));
    }
    assert.equal(variants.length, 13, "10 families + range + engine + branches");
    for (const v of variants) {
      const r = run(v);
      assert.notEqual(r.status, 0, `an off-by-one pin still passes:\n${v}`);
      assert.match(r.stderr, /RE-ASSERTION FAILED \(trip kernel counts at the chain end\)/);
    }
  });

  it("the memory re-assertion fails when a CALLABLE memory_ function becomes anon-executable (and not for a trigger function)", () => {
    const a = declOf("2192_memory_provenance_policy.sql", 238)!;
    const callable = psql(`BEGIN;\nGRANT EXECUTE ON FUNCTION public.memory_retrieve(uuid, text, integer) TO anon;\n${a.reassert}\nROLLBACK;\n`);
    assert.notEqual(callable.status, 0);
    assert.match(callable.stderr, /RE-ASSERTION FAILED \(2192-2214, 2320 as narrowed by 3314\)/);
    const trigger = psql(`BEGIN;\nGRANT EXECUTE ON FUNCTION public.memory_relations_owner_matches_source() TO anon;\n${a.reassert}\nROLLBACK;\n`);
    assert.equal(trigger.status, 0, `a trigger function's EXECUTE grant is not an exposure:\n${trigger.stderr}`);
  });
});

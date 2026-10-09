/**
 * certify:migrations stage 4 — postcondition supersession (lib/migrationSqlBlocks.ts
 * planPostconditionRerun / supersededPostconditionFiles), the rules the lead set
 * when accepting it (ruling CERT-1, 2026-10-08, after verifier M4 F2–F4):
 *
 *   A. the pure planner: a superseded block is held back only while its
 *      superseder is recorded applied; the superseder's postcondition runs in its
 *      place; a superseder with NO re-runnable postcondition is REFUSED and the
 *      superseded file runs as if nothing were declared (F3);
 *   B. the marker is read from the file's leading comment header only (F4);
 *   C. for EVERY declaration on disk: the named file exists and is earlier, the
 *      superseder has a re-runnable postcondition, (a) every relation the
 *      superseded postconditions name is named by the superseder's, and (b) every
 *      quoted column in the superseded never/withheld-style arrays sits in one of the
 *      superseder's OWN never/withheld-style arrays and in none of its other arrays
 *      (granted, readable, allowed, …), comments stripped first (F2; verifier M5 F2:
 *      presence anywhere in the text was not enough; verifier M6 F1: nor was a
 *      literal inside a `--` or block comment, P-h/P-h2, or a readable array not
 *      named `*grant*`, P-g). The chain-end half — the superseded block
 *      FAILS and the superseder's PASSES — is db/postconditionSupersession.db.test.ts.
 *
 *      LIMIT OF (b) (verifier M6 P-j): it is a TEXTUAL rule. It proves the column
 *      is PLACED in a live (uncommented) never/withheld-style array literal of the
 *      superseder's postcondition, not that the block ever consults that array. A
 *      declared-but-unused `v_never` plus a real grant passes (a), (b) and (c);
 *      what catches that for `posts` today is the 3801-specific pin in
 *      postsReleaseTimingColumnGrants.test.ts (its `ANY (v_release || v_never)` case).
 *   D. the subject checks would have refused verifier M4's probe P1 (a marker
 *      naming an unrelated file).
 *
 * Run: node --import tsx/esm --test src/test/certifyPostconditionSupersession.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  planPostconditionRerun,
  supersededPostconditionFiles,
  topLevelStatements,
} from "../scripts/lib/migrationSqlBlocks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, "..", "migrations");

/** A file's re-runnable postconditions, exactly as stage 4 collects them. */
export function postconditionsOf(sql: string): string[] {
  return topLevelStatements(sql).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
}

/** The relations a block names, in the shapes the catalog checks here use. */
export function relationTokens(block: string): Set<string> {
  const out = new Set<string>();
  for (const re of [
    /'public\.([a-z0-9_]+)'::regclass/g,
    /to_regclass\(\s*'(?:public\.)?([a-z0-9_]+)'\s*\)/g,
    /\b(?:table_name|tablename|relname)\s*=\s*'([a-z0-9_]+)'/g,
    /has_(?:table|column)_privilege\([^,()]+,\s*'(?:public\.)?([a-z0-9_]+)'/g,
  ]) {
    for (const m of block.matchAll(re)) out.add(m[1]!);
  }
  return out;
}

/**
 * A block with its `--` line comments and block comments removed (verifier M6
 * F1, probes P-h/P-h2). Single-quoted literals ('' escapes included) are kept
 * whole, so a `--` inside a RAISE message is not taken for a comment. The DO
 * body's own dollar quotes are NOT treated as strings: the body is the code
 * being read.
 */
export function stripSqlComments(block: string): string {
  let out = "";
  let i = 0;
  while (i < block.length) {
    const ch = block[i]!;
    if (ch === "'") {
      let j = i + 1;
      while (j < block.length) {
        if (block[j] === "'" && block[j + 1] === "'") { j += 2; continue; }
        if (block[j] === "'") { j++; break; }
        j++;
      }
      out += block.slice(i, j); i = j; continue;
    }
    if (ch === "-" && block[i + 1] === "-") { const nl = block.indexOf("\n", i); i = nl === -1 ? block.length : nl; continue; }
    if (ch === "/" && block[i + 1] === "*") {
      let depth = 1; let j = i + 2; // PostgreSQL block comments nest
      while (j < block.length && depth > 0) {
        if (block[j] === "/" && block[j + 1] === "*") { depth++; j += 2; continue; }
        if (block[j] === "*" && block[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      out += " "; i = j; continue;
    }
    out += ch; i++;
  }
  return out;
}

const PROTECTED_ARRAY_NAME = /(?:never|withheld|private|release|forbidden)/i;

/** Every `<name> [constant] text[] := ARRAY[…]` in a block, comments stripped: [name, quoted literals]. */
function textArrayDeclarations(block: string): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const m of stripSqlComments(block).matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s+(?:constant\s+)?text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/gi)) {
    out.push([m[1]!, [...m[2]!.matchAll(/'([a-z0-9_]+)'/g)].map((c) => c[1]!)]);
  }
  return out;
}

/** The quoted names of every `<never|withheld|private|release|forbidden…> [constant] text[] := ARRAY[…]` in a block (comments stripped). */
export function protectedColumnLiterals(block: string): Set<string> {
  return new Set(textArrayDeclarations(block).filter(([n]) => PROTECTED_ARRAY_NAME.test(n)).flatMap(([, cs]) => cs));
}

/**
 * The quoted names in every OTHER `text[] := ARRAY[…]` of a block (comments
 * stripped) — granted, readable, allowed, optional, anything not named as a
 * never/withheld-style list (verifier M6 P-g: `v_readable` escaped a `*grant*`
 * name match). A protected column found here is not re-asserted.
 */
export function grantedColumnLiterals(block: string): Set<string> {
  return new Set(textArrayDeclarations(block).filter(([n]) => !PROTECTED_ARRAY_NAME.test(n)).flatMap(([, cs]) => cs));
}

/**
 * What a superseder fails to re-assert of the file it supersedes (empty = covered).
 *
 * (b) is WHERE the literal sits, not whether it appears (verifier M5 F2): a
 * superseded never/withheld column is re-asserted only when the superseder's own
 * postcondition carries it in a never/withheld/private/release/forbidden-style
 * array — and in none of its other arrays (granted, readable, …; M6 P-g), with
 * comments stripped first (M6 P-h/P-h2). A literal in a granted array, in a
 * RAISE message (probes P-e, P-e2) or in a comment asserts the opposite, or
 * nothing. It does not prove the array is consulted (M6 P-j; see the header).
 */
export function supersessionGaps(supersededSql: string, supersederSql: string): { relations: string[]; columns: string[]; vacuous: boolean } {
  const oldPosts = postconditionsOf(supersededSql);
  const newPost = postconditionsOf(supersederSql).join("\n");
  const oldRel = new Set(oldPosts.flatMap((b) => [...relationTokens(b)]));
  const newRel = relationTokens(newPost);
  const oldCols = new Set(oldPosts.flatMap((b) => [...protectedColumnLiterals(b)]));
  const newProtected = protectedColumnLiterals(newPost);
  const newGranted = grantedColumnLiterals(newPost);
  return {
    relations: [...oldRel].filter((t) => !newRel.has(t)).sort(),
    columns: [...oldCols].filter((c) => !newProtected.has(c) || newGranted.has(c)).sort(),
    // A superseded postcondition that names no relation cannot be shown to be covered: refuse it.
    vacuous: oldPosts.length === 0 || oldRel.size === 0,
  };
}

const sqlOf = (f: string) => readFileSync(join(MIG, f), "utf8");
const declarations = (): Array<{ by: string; file: string }> => {
  const out: Array<{ by: string; file: string }> = [];
  for (const by of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) {
    for (const file of supersededPostconditionFiles(sqlOf(by))) out.push({ by, file });
  }
  return out;
};

describe("A. the planner", () => {
  const D = new Map([["3801_b.sql", ["3362_a.sql"]]]);
  const has = (files: string[]) => (f: string) => files.includes(f);
  it("holds the superseded file back only while the superseder is applied, and runs the superseder in its place", () => {
    assert.deepEqual(planPostconditionRerun(["3362_a.sql", "3801_b.sql"], new Set(["3362_a.sql", "3801_b.sql"]), D, has(["3362_a.sql", "3801_b.sql"])),
      { run: ["3801_b.sql"], heldBack: [{ file: "3362_a.sql", by: "3801_b.sql" }], refused: [] });
    assert.deepEqual(planPostconditionRerun(["3362_a.sql"], new Set(["3362_a.sql"]), D, has(["3362_a.sql", "3801_b.sql"])),
      { run: ["3362_a.sql"], heldBack: [], refused: [] }, "not applied (or rolled back): nothing held");
    assert.deepEqual(planPostconditionRerun(["3362_a.sql"], new Set(["3362_a.sql", "3801_b.sql"]), D, has(["3362_a.sql", "3801_b.sql"])),
      { run: ["3801_b.sql"], heldBack: [{ file: "3362_a.sql", by: "3801_b.sql" }], refused: [] }, "superseder run even out of scope");
  });

  it("verifier M4 F3: a superseder with no re-runnable postcondition is REFUSED, and the superseded file still runs", () => {
    const plan = planPostconditionRerun(["3362_a.sql", "3801_b.sql"], new Set(["3362_a.sql", "3801_b.sql"]), D, has(["3362_a.sql"]));
    assert.deepEqual(plan.refused, [{ file: "3362_a.sql", by: "3801_b.sql" }]);
    assert.deepEqual(plan.heldBack, []);
    assert.deepEqual(plan.run, ["3362_a.sql", "3801_b.sql"]);
  });

  it("transitive; a mid-chain superseder without a postcondition stops the chain there and is refused", () => {
    const d = new Map([["3801_b.sql", ["3362_a.sql"]], ["3805_c.sql", ["3801_b.sql"]]]);
    const all = new Set(["3362_a.sql", "3801_b.sql", "3805_c.sql"]);
    assert.deepEqual(planPostconditionRerun(["3362_a.sql"], all, d, () => true).run, ["3805_c.sql"]);
    const p = planPostconditionRerun(["3362_a.sql"], all, d, has(["3362_a.sql", "3801_b.sql"]));
    assert.deepEqual(p.run, ["3801_b.sql"]);
    assert.deepEqual(p.refused, [{ file: "3801_b.sql", by: "3805_c.sql" }]);
  });

  it("a declaration naming a LATER file, or itself, is ignored", () => {
    const d = new Map([["3000_z.sql", ["3362_a.sql"]], ["3362_a.sql", ["3362_a.sql"]]]);
    assert.deepEqual(planPostconditionRerun(["3362_a.sql"], new Set(["3000_z.sql", "3362_a.sql"]), d, () => true),
      { run: ["3362_a.sql"], heldBack: [], refused: [] });
  });
});

describe("B. verifier M4 F4: the marker is read from the leading comment header only", () => {
  const M = "-- certify:supersedes-postconditions 3362_posts_client_column_grants.sql";
  it("honoured in the header (after blank and comment lines, and with CRLF line ends)", () => {
    assert.deepEqual(supersededPostconditionFiles(`-- 3801_x.sql\n--\n\n${M}\n-- more\nBEGIN;\n`), ["3362_posts_client_column_grants.sql"]);
    assert.deepEqual(supersededPostconditionFiles(`-- 3801_x.sql\r\n${M}\r\nBEGIN;\r\n`), ["3362_posts_client_column_grants.sql"]);
  });
  it("ignored after the first statement, inside a dollar body, a block comment or a string literal, and when indented", () => {
    assert.deepEqual(supersededPostconditionFiles(`-- header\nBEGIN;\n${M}\n`), []);
    assert.deepEqual(supersededPostconditionFiles(`-- header\nDO $$\n${M}\nBEGIN NULL; END $$;\n`), []);
    assert.deepEqual(supersededPostconditionFiles(`/*\n${M}\n*/\nBEGIN;\n`), []);
    assert.deepEqual(supersededPostconditionFiles(`SELECT '\n${M}\n';\n`), []);
    assert.deepEqual(supersededPostconditionFiles(`  ${M}\n`), []);
  });
});

describe("C. every declaration on disk (ruling CERT-1)", () => {
  const decl = declarations();
  it("anti-vacuity: the scan finds 3801's two declarations", () => {
    for (const f of ["2148_posts_write_boundary.sql", "3362_posts_client_column_grants.sql"]) {
      assert.ok(decl.some((d) => d.by === "3801_posts_release_timing_columns_withheld.sql" && d.file === f), f);
    }
  });

  it("the named file exists and is earlier; the superseder has a re-runnable postcondition", () => {
    for (const { by, file } of decl) {
      assert.ok(existsSync(join(MIG, file)), `${by} names ${file}, which is not on disk`);
      assert.ok(file < by, `${by} may only supersede an earlier file, not ${file}`);
      assert.ok(postconditionsOf(sqlOf(by)).length > 0, `${by} supersedes ${file} but has no re-runnable postcondition`);
    }
  });

  it("(a) every relation the superseded postconditions name is named by the superseder's; (b) every never/withheld column literal is re-asserted", () => {
    for (const { by, file } of decl) {
      const gaps = supersessionGaps(sqlOf(file), sqlOf(by));
      assert.equal(gaps.vacuous, false, `${file}'s postconditions name no relation, so ${by} cannot be shown to cover them`);
      assert.deepEqual(gaps.relations, [], `${by} does not re-assert ${file}'s relations`);
      assert.deepEqual(gaps.columns, [], `${by} does not re-assert ${file}'s never/withheld columns`);
    }
  });
});

describe("D. the subject checks refuse a marker naming an unrelated file (verifier M4 probe P1)", () => {
  it("3801 claiming to supersede an unrelated earlier migration has gaps; 3801 against 3362 and 2148 has none", () => {
    const s3801 = sqlOf("3801_posts_release_timing_columns_withheld.sql");
    // Every on-disk earlier file with a re-runnable postcondition about some other relation is refused.
    let unrelated = 0;
    for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql") && x < "2160").sort()) {
      const sql = sqlOf(f);
      if (postconditionsOf(sql).length === 0) continue;
      const rel = new Set(postconditionsOf(sql).flatMap((b) => [...relationTokens(b)]));
      if (rel.size === 0 || rel.has("posts")) continue;
      const g = supersessionGaps(sql, s3801);
      assert.ok(g.relations.length > 0, `${f} would be accepted as superseded by 3801`);
      unrelated++;
    }
    assert.ok(unrelated >= 5, `anti-vacuity: ${unrelated} unrelated files checked`);
    // A superseded file whose postcondition names no relation at all is refused as unprovable.
    assert.equal(supersessionGaps(`BEGIN; SELECT 1; COMMIT;\nDO $$ BEGIN IF 1 = 2 THEN RAISE EXCEPTION 'x'; END IF; END $$;\n`, s3801).vacuous, true);
    // And the never/withheld rule bites: a superseded never-list column 3801 does not name.
    const fake = `DO $post$ DECLARE never text[] := ARRAY['user_gps_lat','zz_secret']; BEGIN IF to_regclass('public.posts') IS NULL THEN RAISE EXCEPTION 'x'; END IF; END $post$;`;
    assert.deepEqual(supersessionGaps(fake, s3801).columns, ["zz_secret"]);
  });

  it("verifier M5 F2: a never/withheld column is re-asserted only from the superseder's OWN never/withheld-style array (probes P-e, P-e2)", () => {
    const superseded = `DO $post$ DECLARE v_never text[] := ARRAY['user_gps_lat']; BEGIN IF to_regclass('public.posts') IS NULL THEN RAISE EXCEPTION 'x'; END IF; END $post$;`;
    const post = (decl: string, body = "NULL;") => `DO $post$ DECLARE ${decl} BEGIN IF to_regclass('public.posts') IS NULL THEN RAISE EXCEPTION 'x'; END IF; ${body} END $post$;`;
    // P-e: the literal sits in the superseder's GRANTED array — it asserts the column readable.
    assert.deepEqual(supersessionGaps(superseded, post(`v_granted text[] := ARRAY['id','user_gps_lat'];`)).columns, ["user_gps_lat"], "P-e");
    // P-e2: the literal only inside a RAISE message.
    assert.deepEqual(supersessionGaps(superseded, post(`v_granted text[] := ARRAY['id'];`, `RAISE EXCEPTION 'posts lacks ''user_gps_lat''';`)).columns, ["user_gps_lat"], "P-e2");
    // Both at once (never AND granted) is a contradiction, not a re-assertion.
    assert.deepEqual(supersessionGaps(superseded, post(`v_granted text[] := ARRAY['user_gps_lat']; v_never text[] := ARRAY['user_gps_lat'];`)).columns, ["user_gps_lat"], "never and granted");
    // verifier M6 P-h / P-h2: the never array exists only inside a comment.
    assert.deepEqual(supersessionGaps(superseded, post(`v_granted text[] := ARRAY['id']; -- v_never text[] := ARRAY['user_gps_lat'];\n`)).columns, ["user_gps_lat"], "P-h");
    assert.deepEqual(supersessionGaps(superseded, post(`v_granted text[] := ARRAY['id']; /* v_never text[] := ARRAY['user_gps_lat']; */`)).columns, ["user_gps_lat"], "P-h2");
    assert.deepEqual(supersessionGaps(superseded, post(`/* outer /* nested */ v_never text[] := ARRAY['user_gps_lat']; */ v_x text[] := ARRAY['id'];`)).columns, ["user_gps_lat"], "P-h3 nested block comment");
    // verifier M6 P-g: a readable array not named *grant* also lists the column.
    assert.deepEqual(supersessionGaps(superseded, post(`v_never text[] := ARRAY['user_gps_lat']; v_readable text[] := ARRAY['id','user_gps_lat'];`)).columns, ["user_gps_lat"], "P-g");
    assert.deepEqual(supersessionGaps(superseded, post(`v_never text[] := ARRAY['user_gps_lat']; v_allowed constant text[] := ARRAY['user_gps_lat'];`)).columns, ["user_gps_lat"], "P-g allowed");
    // A `--` inside a quoted literal is not a comment: the never array after it still counts.
    assert.deepEqual(supersessionGaps(superseded, post(`v_msg text := 'a -- b'; v_never text[] := ARRAY['user_gps_lat'];`)).columns, [], "quoted --");
    assert.equal(stripSqlComments("a -- x\nb /* y /* z */ w */ c 'd -- e'"), "a \nb   c 'd -- e'");
    // The accepted shape: the superseder's own never/withheld/release-style array.
    for (const name of ["v_never", "withheld", "v_release", "private_cols", "forbidden"]) {
      assert.deepEqual(supersessionGaps(superseded, post(`${name} constant text[] := ARRAY['user_gps_lat'];`)).columns, [], name);
    }
    // And 3801 carries every one of 3362's protected literals in its OWN arrays (the live declaration stays accepted).
    const never3362 = new Set(postconditionsOf(sqlOf("3362_posts_client_column_grants.sql")).flatMap((b) => [...protectedColumnLiterals(b)]));
    assert.ok(never3362.size >= 8, `anti-vacuity: ${never3362.size} protected literals in 3362's postconditions`);
    const post3801 = postconditionsOf(sqlOf("3801_posts_release_timing_columns_withheld.sql")).join("\n");
    for (const c of never3362) {
      assert.ok(protectedColumnLiterals(post3801).has(c), `3801 does not carry 3362's ${c} in its own never/withheld arrays`);
      assert.ok(!grantedColumnLiterals(post3801).has(c), `3801 grants 3362's ${c}`);
    }
  });
});

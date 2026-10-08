/**
 * census-media §50.16 (verifier M3, N2b) — migration 3801: no client role may
 * read WHEN a post was released. Static half; the database half is
 * src/test/db/postsReleaseTimingColumns.db.test.ts.
 *
 *   A. 3801's grant is 3362's grant minus exactly updated_at and publish_at, and
 *      every literal list in the file agrees with it;
 *   B. its shape: a table-level REVOKE from anon, authenticated and PUBLIC, only
 *      SELECT granted, one $pre$ (held back by certify), one re-runnable
 *      postcondition that re-asserts every class 3362's did;
 *   C. certify:migrations stage 4 — 3801 declares that it supersedes 3362's
 *      postcondition, and planPostconditionRerun holds 3362's back only while
 *      3801 is applied, re-running 3801's in its place; the declaration is legal
 *      everywhere it appears on disk;
 *   D. the premise: no client code reads posts, and the API's release-timing
 *      list is withheld by the grants as well;
 *   E. the rollback restores 3362's end state, and docs/migrations.md records 3801.
 *
 * Run: node --import tsx/esm --test src/test/postsReleaseTimingColumnGrants.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isAssertionOnlyDoBlock,
  isPreconditionDoBlock,
  planPostconditionRerun,
  supersededPostconditionFiles,
  topLevelStatements,
} from "../scripts/lib/migrationSqlBlocks.js";
import { RELEASE_TIMING_FIELDS } from "../lib/postLocationDisclosureLifetime.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..", "..");
const REPO = resolve(API, "..", "..");
const MIG = join(API, "src", "migrations");
const F2148 = "2148_posts_write_boundary.sql";
const F3362 = "3362_posts_client_column_grants.sql";
const F3801 = "3801_posts_release_timing_columns_withheld.sql";
const sql3362 = readFileSync(join(MIG, F3362), "utf8");
const sql3801 = readFileSync(join(MIG, F3801), "utf8");
const ROLLBACK = join(REPO, "db", "rollback", "2026-10-08-3801-posts-release-timing-columns-withheld-rollback.sql");

const sorted = (xs: Iterable<string>) => [...xs].sort();
/** The column list of the (first) `GRANT SELECT ( … ) ON TABLE public.posts TO anon, authenticated;`. */
function grantList(sql: string): string[] {
  const m = sql.match(/GRANT SELECT \(([\s\S]*?)\) ON TABLE public\.posts TO anon, authenticated;/);
  assert.ok(m, "a GRANT SELECT (…) ON TABLE public.posts TO anon, authenticated statement");
  return m![1]!.split(",").map((c) => c.trim()).filter(Boolean);
}
/** The quoted names of `name … := ARRAY[ … ];` inside `block`. */
function literal(block: string, name: string): string[] {
  const at = block.search(new RegExp(`\\b${name}\\s+(?:constant\\s+)?text\\[\\]\\s*:=\\s*ARRAY\\[`));
  assert.ok(at >= 0, `no ${name} literal`);
  const end = block.indexOf("];", at);
  return [...block.slice(at, end).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
}
const stmts3801 = topLevelStatements(sql3801);
const pre3801 = stmts3801.filter((s) => isAssertionOnlyDoBlock(s) && isPreconditionDoBlock(s));
const post3801 = stmts3801.filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
const post3362 = topLevelStatements(sql3362).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));

const RELEASE = ["updated_at", "publish_at"];

describe("A. 3801 grants 3362's columns minus exactly the two release-timing columns", () => {
  it("the GRANT list is 3362's minus updated_at and publish_at, and tombstoned_at is granted where it exists", () => {
    const g3362 = grantList(sql3362);
    const g3801 = grantList(sql3801);
    for (const c of RELEASE) assert.ok(g3362.includes(c), `anti-vacuity: 3362 grants ${c}`);
    assert.deepEqual(sorted(g3801), sorted(g3362.filter((c) => !RELEASE.includes(c))));
    assert.equal(g3801.length, 37);
    assert.match(sql3801, /EXECUTE 'GRANT SELECT \(tombstoned_at\) ON TABLE public\.posts TO anon, authenticated'/);
  });

  it("the $pre$ and $post$ literals carry the same lists as the GRANT, and 3362's withheld list unchanged", () => {
    assert.equal(pre3801.length, 1, "exactly one $pre$ block");
    assert.equal(post3801.length, 1, "exactly one re-runnable postcondition");
    const want = sorted([...grantList(sql3801), "tombstoned_at"]);
    assert.deepEqual(sorted(literal(pre3801[0]!, "v_granted")), want);
    assert.deepEqual(sorted(literal(post3801[0]!, "v_granted")), want);
    assert.deepEqual(sorted(literal(pre3801[0]!, "v_release")), sorted(RELEASE));
    assert.deepEqual(sorted(literal(pre3801[0]!, "v_withheld")), sorted(literal(topLevelStatements(sql3362).find((s) => isPreconditionDoBlock(s) || /DO \$pre\$/.test(s))!, "withheld")));
  });
});

describe("B. its shape", () => {
  it("revokes the table-level SELECT from anon, authenticated AND PUBLIC; grants nothing but SELECT, to nobody but the two client roles", () => {
    assert.match(sql3801, /^REVOKE SELECT ON TABLE public\.posts FROM anon, authenticated, PUBLIC;$/m);
    const grants = [...sql3801.replace(/^\s*--.*$/gm, "").matchAll(/\bGRANT\s+([A-Z ,]+?)\s*(?:\(|ON\b)/g)].map((m) => m[1]!.trim());
    assert.ok(grants.length >= 2);
    for (const g of grants) assert.equal(g, "SELECT", `only SELECT is granted, found ${g}`);
    assert.doesNotMatch(sql3801.replace(/^\s*--.*$/gm, ""), /\bTO\s+(?:[a-z_, ]*\b)?PUBLIC\b/i, "nothing is granted to PUBLIC");
  });

  it("the precondition accepts exactly 3362's end state or 2148's, and refuses a foreign grantor", () => {
    const pre = pre3801[0]!;
    assert.match(pre, /IF v_tables = 2 THEN/);
    assert.match(pre, /ELSIF v_tables = 0 THEN/);
    assert.match(pre, /the column grants are not exactly 3362''s/);
    assert.match(pre, /rather than the table owner/);
    assert.match(pre, /does not classify/);
  });

  it("the postcondition re-asserts every class 3362's did, with the narrower set, plus the release-timing columns", () => {
    assert.equal(post3362.length, 1, "anti-vacuity: 3362 has one re-runnable postcondition");
    const post = post3801[0]!;
    // 3362's never-readable minimum, carried over whole.
    for (const c of literal(post3362[0]!, "never")) assert.ok(literal(post, "v_never").includes(c), `never: ${c}`);
    // The release-timing columns, the API's list included.
    const rel = literal(post, "v_release");
    for (const c of ["updated_at", "publish_at", "published_at", "publish_eligible_at", "publish_after_exit", "publish_after_time", "exited_geofence_at", "post_status"]) {
      assert.ok(rel.includes(c), `release-timing: ${c}`);
    }
    for (const c of RELEASE_TIMING_FIELDS) assert.ok(rel.includes(c), `lib's RELEASE_TIMING_FIELDS ${c}`);
    // Each of 3362's assertion classes has its counterpart.
    for (const [why, re] of [
      ["no table-level privilege", /LATERAL aclexplode\(c\.relacl\)/],
      ["nothing more than the granted set", /a\.attname::text <> ALL \(v_granted\)/],
      ["nothing less", /a client role lost a posts column it must keep/],
      ["no write or REFERENCES column privilege", /unnest\(ARRAY\['INSERT','UPDATE','REFERENCES'\]\)/],
      ["service_role reads every column", /NOT has_column_privilege\('service_role'/],
      ["PUBLIC holds no column privilege", /x\.grantee = 0/],
      ["vacuity guard", /VACUOUS/],
    ] as const) {
      assert.match(post, re, why);
    }
  });
});

describe("C. certify:migrations stage 4 — 3801 supersedes 3362's postcondition, and only while it is applied", () => {
  it("3801 declares it, naming 3362 — and 2148, whose table-level 'SELECT only' 3801 itself removes where 3362 never ran", () => {
    assert.deepEqual(supersededPostconditionFiles(sql3801), [F2148, F3362]);
    // The reason it must: 3362's postcondition pins updated_at as client-readable ("lost a column it must keep").
    assert.ok(literal(post3362[0]!, "granted").includes("updated_at"));
    assert.match(post3362[0]!, /a client role lost a column it must keep/);
    // 2148's pins a table-level SELECT for both client roles, which 3362 (and 3801, from 2148's state) take away.
    const post2148 = topLevelStatements(readFileSync(join(MIG, F2148), "utf8")).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
    assert.ok(post2148.some((b) => /expected SELECT only/.test(b)), "anti-vacuity: 2148's postcondition pins table-level SELECT");
  });

  it("3801's postcondition carries 2148's assertions too: RLS on, a SELECT policy, the two verification columns, no client column INSERT/UPDATE", () => {
    const post = post3801[0]!;
    assert.match(post, /SELECT relrowsecurity FROM pg_class WHERE oid = 'public\.posts'::regclass/);
    assert.match(post, /posts has no SELECT policy/);
    assert.match(post, /attname IN \('geotag_verified','location_verified'\)\) <> 2/);
    assert.match(post, /unnest\(ARRAY\['INSERT','UPDATE','REFERENCES'\]\)/);
  });

  const DECL = new Map([[F3801, [F3362]]]);
  it("both in scope (a full-chain build) and 3801 applied: 3362's is held back, 3801's runs", () => {
    const plan = planPostconditionRerun(["2955_x.sql", F3362, F3801], new Set(["2955_x.sql", F3362, F3801]), DECL);
    assert.deepEqual(plan.run, ["2955_x.sql", F3801]);
    assert.deepEqual(plan.heldBack, [{ file: F3362, by: F3801 }]);
  });
  it("3801 not applied (or rolled back, which deletes its ledger row): 3362's runs as before", () => {
    const plan = planPostconditionRerun([F3362], new Set([F3362]), DECL);
    assert.deepEqual(plan, { run: [F3362], heldBack: [] });
  });
  it("only 3362 in scope (--files) while 3801 is applied: 3801's postcondition is re-run in its place", () => {
    const plan = planPostconditionRerun([F3362], new Set([F3362, F3801]), DECL);
    assert.deepEqual(plan, { run: [F3801], heldBack: [{ file: F3362, by: F3801 }] });
  });
  it("transitive, and a declaration naming a LATER file is ignored", () => {
    const decl = new Map([[F3801, [F3362]], ["3805_y.sql", [F3801]], ["3000_z.sql", [F3362]]]);
    const plan = planPostconditionRerun([F3362, F3801], new Set([F3362, F3801, "3805_y.sql", "3000_z.sql"]), decl);
    assert.deepEqual(plan.run, ["3805_y.sql"]);
    assert.deepEqual(plan.heldBack, [{ file: F3362, by: "3805_y.sql" }, { file: F3801, by: "3805_y.sql" }]);
  });
  it("certifyMigrations.ts plans stage 4 with it, and refuses a superseder with no postcondition of its own", () => {
    const certify = readFileSync(join(API, "src", "scripts", "certifyMigrations.ts"), "utf8");
    assert.match(certify, /plan = await planStage4\(scope\.files, onDisk\);/);
    assert.match(certify, /await stagePostconditions\(plan\.run, declared, plan\.heldBack\)/);
    assert.match(certify, /a supersession must replace the assertion, not delete it/);
    assert.match(certify, /return planPostconditionRerun\(scopeFiles, new Set\(rows\.map\(\(r\) => r\.filename\)\), declarations\);/);
  });

  it("every declaration on disk names an existing, earlier migration, and its file has a re-runnable postcondition", () => {
    let seen = 0;
    for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(MIG, f), "utf8");
      for (const named of supersededPostconditionFiles(sql)) {
        seen++;
        assert.ok(existsSync(join(MIG, named)) && statSync(join(MIG, named)).isFile(), `${f} names ${named}, which is not on disk`);
        assert.ok(named < f, `${f} may only supersede an earlier file, not ${named}`);
        const posts = topLevelStatements(sql).filter((s) => isAssertionOnlyDoBlock(s) && !isPreconditionDoBlock(s));
        assert.ok(posts.length > 0, `${f} supersedes ${named} but has no re-runnable postcondition of its own`);
      }
    }
    assert.ok(seen >= 1, "anti-vacuity: 3801's declaration is found by the scan");
  });
});

describe("D. the premise", () => {
  it("no client code reads posts through PostgREST or realtime (travel-buddy-standalone src/ and app/)", () => {
    const roots = ["src", "app"].map((d) => join(REPO, "travel-buddy-standalone", d));
    const offenders: string[] = [];
    let files = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        files++;
        const src = readFileSync(p, "utf8");
        if (/\.from\(\s*['"`]posts['"`]\s*\)/.test(src)) offenders.push(`${p}: .from('posts')`);
        if (/table:\s*['"`]posts['"`]/.test(src)) offenders.push(`${p}: realtime on posts`);
        if (/\.select\([^)]*\bposts\s*\(/.test(src)) offenders.push(`${p}: embedded posts resource`);
        if (/\/rest\/v1\/posts\b/.test(src)) offenders.push(`${p}: /rest/v1/posts`);
      }
    };
    for (const r of roots) walk(r);
    assert.ok(files > 500, `anti-vacuity: scanned ${files} files`);
    assert.deepEqual(offenders, []);
  });

  it("the API's release-timing list, and updated_at, are all withheld from client roles at the end of the chain", () => {
    const granted = new Set([...grantList(sql3801), "tombstoned_at"]);
    for (const c of [...RELEASE_TIMING_FIELDS, "updated_at", "publish_at"]) assert.ok(!granted.has(c), `${c} must not be client-readable`);
    // And nothing after 3801 grants posts columns back to a client role.
    for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql") && x > F3801)) {
      assert.doesNotMatch(readFileSync(join(MIG, f), "utf8"), /GRANT\s+SELECT[^;]*ON\s+(?:TABLE\s+)?(?:public\.)?posts\b/i, `${f} grants posts back`);
    }
  });
});

describe("E. rollback and records", () => {
  it("the rollback re-grants exactly updated_at and publish_at, deletes 3801's ledger row, and asserts 3362's end state", () => {
    const rb = readFileSync(ROLLBACK, "utf8");
    assert.match(rb, /^GRANT SELECT \(updated_at, publish_at\) ON TABLE public\.posts TO anon, authenticated;$/m);
    assert.match(rb, /DELETE FROM public\.schema_migration_ledger WHERE filename = '3801_posts_release_timing_columns_withheld\.sql';/);
    assert.deepEqual(sorted(literal(rb, "granted")), sorted([...grantList(sql3362), "tombstoned_at"]));
    assert.doesNotMatch(rb.replace(/^\s*--.*$/gm, ""), /GRANT SELECT ON TABLE/, "the rollback never restores a table-level SELECT");
  });

  it("docs/migrations.md records 3801 as applied nowhere", () => {
    const md = readFileSync(join(REPO, "docs", "migrations.md"), "utf8");
    assert.match(md, /## 2026-10-08 — `3801_posts_release_timing_columns_withheld\.sql`, written and NOT applied anywhere \(lane M\)/);
  });
});

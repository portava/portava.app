/**
 * fakeConformanceRegistry — the next Supabase double added to this repository is
 * CHECKED, not trusted.
 *
 * `src/test/supabaseContract.test.ts` measures every double registered in
 * `helpers/supabaseConformance.ts` against the real client. That is worth
 * nothing the moment someone adds a seventh double and does not register it —
 * which is exactly how the repository got here: `src/test/rentABuddy.test.ts`
 * grew its own builder, captured inserted rows EAGERLY inside `.insert()`, and
 * nothing in the suite was in a position to notice.
 *
 * So this file walks `src/test/helpers/` itself. Any file that exports a
 * `make*Client` / `make*Db` factory AND speaks PostgREST (it implements
 * `maybeSingle`) must either be registered as a contract Subject or appear in
 * EXEMPT below with a reason. There is no third option and no default.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/fakeConformanceRegistry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { allFakeSubjects } from "./helpers/supabaseConformance.js";

const HELPERS = join(dirname(fileURLToPath(import.meta.url)), "helpers");

/**
 * Files that speak PostgREST but cannot be run through the contract, each with
 * the reason. An entry here is a standing claim that has to stay true.
 */
const EXEMPT: Record<string, string> = {
  "postgrestOracle.ts":
    "it IS the oracle — the real supabase-js client behind an injected fetch. Running it against itself would prove nothing.",
  "supabaseConformance.ts":
    "the harness itself; it names the scenarios rather than answering them.",
};

const FACTORY = /export\s+(?:async\s+)?function\s+(make[A-Z]\w*(?:Client|Db))\s*\(/g;

function doubles(): Array<{ file: string; factories: string[] }> {
  const out: Array<{ file: string; factories: string[] }> = [];
  for (const f of readdirSync(HELPERS)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(HELPERS, f), "utf8");
    // A PostgREST double is a factory that implements the singular-read verb.
    if (!src.includes("maybeSingle")) continue;
    const names = [...src.matchAll(FACTORY)].map((m) => m[1]);
    if (names.length === 0) continue;
    out.push({ file: f, factories: names });
  }
  return out;
}

describe("every Supabase double in src/test/helpers is registered or exempt", () => {
  const found = doubles();
  const subjects = allFakeSubjects();
  const registered = new Set(subjects.map((s) => basename(s.sourceFile)));

  it("finds the doubles at all — an empty scan is a broken guard, not a clean repo", () => {
    assert.ok(
      found.length >= 6,
      `only ${found.length} double(s) detected under ${HELPERS}: ${found.map((d) => d.file).join(", ")}. ` +
        "If the detection heuristic stopped matching, this guard is asleep.",
    );
  });

  it("registers every double it finds, or names it exempt with a reason", () => {
    const unaccounted = found
      .map((d) => d.file)
      .filter((f) => !registered.has(f) && !(f in EXEMPT));
    assert.deepEqual(
      unaccounted,
      [],
      `these Supabase doubles are neither registered as contract Subjects nor exempt: ${unaccounted.join(", ")}.\n` +
        "Register them in helpers/supabaseConformance.ts (allFakeSubjects) so supabaseContract.test.ts measures " +
        "them against the real client, or add an EXEMPT entry here saying why they cannot be measured.",
    );
  });

  it("keeps the exemption list honest — no entry for a file that is gone or registered", () => {
    for (const [file, reason] of Object.entries(EXEMPT)) {
      assert.ok(existsSync(join(HELPERS, file)), `EXEMPT names ${file}, which no longer exists`);
      assert.ok(
        !registered.has(file),
        `${file} is BOTH exempt and registered — drop the exemption, it is being measured`,
      );
      assert.ok(reason.length > 40, `the exemption for ${file} needs a real reason, not "${reason}"`);
    }
  });

  it("every registered Subject points at a file that exists in helpers/", () => {
    for (const s of subjects) {
      assert.ok(existsSync(s.sourceFile), `${s.name} points at a missing sourceFile: ${s.sourceFile}`);
      assert.ok(
        s.sourceFile.startsWith(HELPERS),
        `${s.name} points outside helpers/: ${s.sourceFile}`,
      );
    }
  });

  it("every registered double carries the contract banner in its header", () => {
    for (const s of subjects) {
      const src = readFileSync(s.sourceFile, "utf8");
      const header = src.slice(0, src.indexOf("\n */") + 4);
      assert.match(
        header,
        /CHECKED AGAINST THE REAL CLIENT/,
        `${s.name}'s header does not tell a reader that it is contract-checked — that banner is where a ` +
          "future maintainer learns not to loosen it",
      );
      assert.match(
        header,
        /NOT MODELLED/,
        `${s.name}'s header has no NOT MODELLED section; a double with no stated limits is one nobody can trust`,
      );
    }
  });
});

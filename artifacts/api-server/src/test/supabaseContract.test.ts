/**
 * supabaseContract — the same scenarios, run against the REAL installed
 * supabase-js client and against every in-memory double in
 * `src/test/helpers/`, with the two required to agree.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * `src/test/rentABuddy.test.ts` recorded inserted rows EAGERLY, inside
 * `.insert()`, carrying a comment that `_resolve()` is never reached. The fake
 * had been written AROUND the defect, so twenty `void …insert(…)` sites proved
 * only that a row was CONSTRUCTED, never that it was SENT, and stayed green for
 * months. Every other suite here inherits assumptions from doubles built the
 * same way — from the production code they had to satisfy, never from the
 * client they replace. This file is the check that was missing.
 *
 * ── HOW A CLAIM IS EARNED ───────────────────────────────────────────────────
 * Nothing below is asserted from documentation. Each scenario is executed
 * against `createClient(url, key, { global: { fetch } })` with an injected fetch
 * (`helpers/postgrestOracle.ts`) IN THE SAME RUN as the fakes, and the real
 * client's answer is taken as correct. If supabase-js changes, the oracle moves
 * and the fakes are re-judged against the new truth automatically.
 *
 * Three outcomes are legal per (scenario, fake) pair — agree, an honest THROWN
 * refusal, or a divergence that is declared in `Subject.gaps` AND named in the
 * fake's own file header. Anything else fails. A declared gap that has quietly
 * started agreeing also fails: a stale alibi misleads a reader as badly as a
 * missing one.
 *
 * ── VACUITY ─────────────────────────────────────────────────────────────────
 * A contract suite that runs nothing passes trivially, so the floors below are
 * assertions: a minimum scenario count, a minimum cell count, a minimum number
 * of groups, and — the one that matters — a minimum number of ACTUAL agreements
 * per fake, so a fake cannot satisfy this suite by refusing everything.
 *
 * The `.then`-vs-nothing request COUNT is pinned here for the oracle and, for
 * the static guard over production source, by
 * `src/test/unissuedSupabaseWrites.test.ts` and `src/test/unissuedWrites.test.ts`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/supabaseContract.test.ts
 */
// schemaStrictSupabase refuses `syntheticColumns` outside this harness: its
// whole point is that column truth comes from the LIVE snapshot, and the
// contract's tables are synthetic. This file is the one authorized caller.
process.env.SUPABASE_CONFORMANCE = "1";

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { makeOracle } from "./helpers/postgrestOracle.js";
import {
  contractScenarios,
  allFakeSubjects,
  runConformance,
  undocumentedGaps,
  renderMatrix,
  type Cell,
  type Subject,
  type Scenario,
} from "./helpers/supabaseConformance.js";

const tick = () => new Promise((r) => setTimeout(r, 25));

let scenarios: Scenario[] = [];
let fakes: Subject[] = [];
let cells: Cell[] = [];

before(async () => {
  scenarios = contractScenarios();
  fakes = allFakeSubjects();
  cells = await runConformance(scenarios, fakes);
  if (process.env.CONTRACT_MATRIX === "1") console.log(renderMatrix(cells));
});

// ── the oracle's own premise, measured, not assumed ─────────────────────────
describe("the real client, re-measured in this run", () => {
  it("issues NO request for a builder with no continuation, and exactly one with", async () => {
    const h = makeOracle({ tables: { audit_events: [] } });
    void h.client.from("audit_events").insert({ id: "a1" });
    await tick();
    assert.equal(h.requests(), 0, "a bare `void …insert(…)` must issue nothing — that is the defect");

    void h.client.from("audit_events").insert({ id: "a2" }).then(undefined, () => {});
    await tick();
    assert.equal(h.requests(), 1, "a continued write must issue exactly one request");

    await h.client.from("audit_events").insert({ id: "a3" });
    assert.equal(h.requests(), 2, "an awaited write must issue exactly one more");
  });

  it("sends the object Accept header for .single() and NOT for .maybeSingle()", async () => {
    const h = makeOracle({ tables: { t: [{ id: "r1" }] } });
    await h.client.from("t").select("*").single();
    await h.client.from("t").select("*").maybeSingle();
    const [single, maybe] = h.log;
    assert.match(String(single.accept), /application\/vnd\.pgrst\.object\+json/);
    assert.ok(
      !String(maybe.accept ?? "").includes("vnd.pgrst.object"),
      "maybeSingle sends no object Accept header — it synthesises PGRST116 client-side",
    );
  });

  it("asks for RETURNING only when .select() is chained", async () => {
    const h = makeOracle({ tables: { t: [] } });
    await h.client.from("t").insert({ id: "r1" });
    await h.client.from("t").insert({ id: "r2" }).select();
    assert.ok(!String(h.log[0].prefer ?? "").includes("return=representation"));
    assert.match(String(h.log[1].prefer), /return=representation/);
  });

  it("never throws: every failure arrives resolved", async () => {
    const h = makeOracle({ tables: { t: [] }, transport: "abort" });
    const r: any = await h.client.from("t").select("*");
    assert.equal(r.data, null);
    assert.ok(r.error, "an aborted transport must still RESOLVE an error object");
  });
});

// ── the contract ────────────────────────────────────────────────────────────
describe("supabase contract: real client vs. the test doubles", () => {
  it("is not vacuous — enough scenarios, subjects, groups and cells actually ran", () => {
    assert.ok(scenarios.length >= 25, `only ${scenarios.length} scenarios; the contract must cover at least 25`);
    assert.ok(fakes.length >= 6, `only ${fakes.length} fakes registered`);
    const groups = new Set(scenarios.map((s) => s.group));
    assert.ok(groups.size >= 7, `only ${groups.size} semantic groups: ${[...groups].join(", ")}`);
    assert.equal(cells.length, scenarios.length * fakes.length);
    assert.ok(cells.length >= 150, `only ${cells.length} (scenario, fake) pairs were measured`);
    for (const g of ["thenable", "cardinality", "failure", "affected", "returning", "rpc", "rls"]) {
      assert.ok(groups.has(g), `the "${g}" group is missing from the contract`);
    }
  });

  it("exercises every fake for real — no fake passes by refusing everything", () => {
    for (const f of fakes) {
      const mine = cells.filter((c) => c.subject === f.name);
      assert.ok(mine.length > 0, `${f.name} was never exercised`);
      const agreed = mine.filter((c) => c.verdict === "agree");
      assert.ok(
        agreed.length >= 7,
        `${f.name} agreed with the real client on only ${agreed.length} scenarios — a double that ` +
          "refuses or diverges on nearly everything is not being checked by this suite",
      );
    }
  });

  it("every fake either AGREES, honestly REFUSES, or carries a declared divergence", () => {
    const bad = cells.filter((c) => c.verdict !== "agree" && c.verdict !== "refused" && c.verdict !== "divergent-declared");
    const detail = bad
      .map(
        (c) =>
          `\n  [${c.verdict}] ${c.scenario} @ ${c.subject}\n      real: ${JSON.stringify(c.oracle)}\n      fake: ${JSON.stringify(c.fake)}`,
      )
      .join("");
    assert.equal(bad.length, 0, `${bad.length} contract violation(s):${detail}`);
  });

  it("a refusal is an explicit one — the fake says it does not model the thing", () => {
    for (const c of cells.filter((x) => x.verdict === "refused")) {
      assert.equal(c.fake.outcome, "threw", `${c.subject} declared "${c.scenario}" refused but did not throw`);
      assert.equal(c.fake.refusal, true, `${c.subject} threw on "${c.scenario}" without saying it does not model it`);
    }
  });

  it("every declared gap is documented in the fake's own header", () => {
    for (const f of fakes) {
      const missing = undocumentedGaps(f);
      assert.deepEqual(
        missing,
        [],
        `${f.name} declares gaps that its file header does not name: ${missing.join(", ")}. ` +
          "A divergence a reader of the fake cannot see is how the eager-insert fake survived.",
      );
    }
  });

  it("pins the load-bearing agreements by name, so a shrinking contract is visible", () => {
    const ALL = [
      "fakeLayoverDb",
      "fakePassportDb",
      "failClosedSupabase",
      "fakeMapDb",
      "schemaStrictSupabase",
      "enumAwareSupabase",
    ];
    const MUST_AGREE: Record<string, string[]> = {
      "thenable/no-continuation": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "thenable/then-continuation": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "thenable/awaited": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "maybeSingle/zero-rows": ALL,
      "maybeSingle/one-row": ALL,
      "maybeSingle/many-rows": ALL,
      "single/zero-rows": ALL,
      "single/one-row": ALL,
      "single/many-rows": ALL,
      "failure/read-error-resolves": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase", "fakeMapDb"],
      "failure/write-error-resolves": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "update/many-rows-no-select": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "update/many-rows-with-select": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "insert/no-select-returns-null": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "insert/with-select-returns-rows": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase"],
      "transport/aborted-request": ["fakeLayoverDb", "fakePassportDb", "failClosedSupabase", "fakeMapDb"],
    };
    for (const [scenario, subjects] of Object.entries(MUST_AGREE)) {
      for (const subject of subjects) {
        const cell = cells.find((c) => c.scenario === scenario && c.subject === subject);
        assert.ok(cell, `no cell for ${scenario} @ ${subject} — did the scenario or the subject get renamed away?`);
        assert.equal(
          cell.verdict,
          "agree",
          `${subject} no longer agrees with the real client on "${scenario}"\n` +
            `      real: ${JSON.stringify(cell.oracle)}\n      fake: ${JSON.stringify(cell.fake)}`,
        );
      }
    }
  });
});

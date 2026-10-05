/**
 * check:layover-decision-diff — census-layover L241, Layover spec §21.2:
 * "Decision-diff CI comparing old/new engine behavior over historical/synthetic
 * corpora."
 *
 * The diff primitive (`layoverReplay.decisionDiffCorpus`) was already built and
 * proved able to go red (test/layoverReplayDeterminism.test.ts). What was
 * missing was anything for CI to run it over. This suite proves the three
 * pieces added around it:
 *
 *   1. the CORPUS is deterministic and covers every §21.1 row the engine can
 *      represent, naming the rest;
 *   2. the GOLDEN agrees with the tree at HEAD, and the check exits 0 on it;
 *   3. the COMPARISON goes red on every kind of change a reviewer must see —
 *      a deadline moved later (reported first), a deadline moved earlier, a
 *      verdict flip, a changed rule, a scenario added or removed, and a
 *      comparison that lined nothing up.
 *
 * It also pins the corpus's PAIRS to the invariants §21.1 states for them
 * (freedom shrinks on an arrival delay, the deadline moves earlier on a traffic
 * spike, …), so the golden is not merely "whatever the engine said".
 *
 * Run: node --import tsx/esm --test src/test/layoverDecisionDiffCheck.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  LAYOVER_SCENARIOS,
  UNREPRESENTED_SCENARIOS,
  decideScenario,
  runLayoverScenarioCorpus,
  type LayoverScenario,
} from "../services/layover/replay/layoverScenarioCorpus.js";
import {
  canonicalJson,
  compareToGolden,
  formatLayoverDiffReport,
  readLayoverGolden,
  writeLayoverGolden,
} from "../services/layover/replay/layoverDecisionGolden.js";

const byId = (id: string) => {
  const s = LAYOVER_SCENARIOS.find((x) => x.id === id);
  assert.ok(s, `scenario ${id} missing`);
  return s!;
};
const decide = (id: string) => decideScenario(byId(id));
const withScenario = (id: string, patch: (s: LayoverScenario) => LayoverScenario) =>
  LAYOVER_SCENARIOS.map((s) => (s.id === id ? patch(s) : s));

describe("the corpus", () => {
  it("is deterministic: two runs are byte-identical", () => {
    assert.equal(canonicalJson(runLayoverScenarioCorpus()), canonicalJson(runLayoverScenarioCorpus()));
  });

  it("has unique, stable ids", () => {
    const ids = LAYOVER_SCENARIOS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 20, `a decision diff over ${ids.length} scenarios proves little`);
  });

  it("covers every §21.1 row the engine can represent and NAMES the rest", () => {
    const sources = LAYOVER_SCENARIOS.map((s) => s.source).join("\n");
    const represented = ["2h domestic", "4h international", "6h visa-free", "self-transfer", "overnight",
      "arrival delay", "departure delay", "security spike", "traffic spike", "unknown entry permission"];
    for (const row of represented) assert.match(sources, new RegExp(row, "i"), `§21.1 row "${row}" has no scenario`);
    const named = UNREPRESENTED_SCENARIOS.map((u) => u.row);
    assert.deepEqual(named.sort(), ["Airport change", "Crew mixed departures", "Flight cancellation", "Offline after leaving", "Unknown baggage"]);
    // 10 represented + 5 named = §21.1's 15 rows; nothing silently dropped.
    assert.equal(represented.length + named.length, 15);
  });
});

describe("the corpus pairs hold §21.1's stated invariants", () => {
  const base = decide("s06-6h-visa-free").result;
  it("arrival delay → freedom shrinks", () => {
    assert.ok(decide("s09-arrival-delay").result.usableMinutes < base.usableMinutes);
  });
  it("departure delay → freedom expands after recompute", () => {
    assert.ok(decide("s10-departure-delay").result.usableMinutes > base.usableMinutes);
  });
  it("security spike → envelope contracts", () => {
    assert.ok(decide("s11-security-spike").result.usableMinutes < base.usableMinutes);
  });
  it("traffic spike → return deadline moves earlier", () => {
    assert.ok(Date.parse(decide("s12-traffic-spike").result.hardReturnTime) < Date.parse(base.hardReturnTime));
  });
  it("unknown entry costs the clock's yes; a refusal overrides it", () => {
    assert.equal(base.verdict, "yes");
    assert.equal(decide("s13-entry-unresolved").result.verdict, "entry_unverified");
    assert.equal(decide("s15-entry-not-resolved-by-caller").result.verdict, "entry_unverified");
    assert.equal(decide("s14-entry-refused").result.verdict, "no");
  });
  it("the return ladder walks NORMAL → RETURN_SOON → RETURN_NOW → CONNECTION_AT_RISK on one session", () => {
    assert.deepEqual(
      ["s06-6h-visa-free", "s17-return-soon", "s23-return-now", "s18-past-hard-return"].map((id) => decide(id).result.returnState),
      ["NORMAL", "RETURN_SOON", "RETURN_NOW", "CONNECTION_AT_RISK"],
    );
  });
  it("the curated airport model and the generic one answer the same session differently (census L220)", () => {
    assert.notEqual(decide("s04-5h-international-generic").result.verdict, decide("s05-5h-international-curated").result.verdict);
  });
});

describe("the golden agrees with the tree, and the CI check says so", () => {
  it("compares every scenario and finds nothing changed", () => {
    const golden = readLayoverGolden();
    assert.ok(golden, "layoverDecisionGolden.json must exist");
    assert.ok(golden!.note.length >= 12, "the golden carries its note");
    const r = compareToGolden(golden!.decisions, runLayoverScenarioCorpus());
    assert.equal(r.diff.compared, LAYOVER_SCENARIOS.length);
    assert.equal(r.ok, true, formatLayoverDiffReport(r));
  });

  it("check:layover-decision-diff exits 0 at HEAD and prints the count the guard registry reads", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx/esm", "src/scripts/checkLayoverDecisionDiff.ts"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`layover decision diff: ${LAYOVER_SCENARIOS.length} scenario\\(s\\) compared`));
  });
});

describe("the comparison goes red on every change a reviewer must see", () => {
  const golden = runLayoverScenarioCorpus();

  it("a deadline moved LATER is red, and is the first thing the report says", () => {
    const cand = runLayoverScenarioCorpus(withScenario("s06-6h-visa-free", (s) => ({
      ...s, airport: { ...s.airport, internationalBufferMin: s.airport.internationalBufferMin - 15 },
    })));
    const r = compareToGolden(golden, cand);
    assert.equal(r.ok, false);
    assert.deepEqual(r.diff.deadlineMovedLater, [{ sessionId: "corpus:s06-6h-visa-free", byMinutes: 15 }]);
    const lines = formatLayoverDiffReport(r).split("\n");
    assert.match(lines[1] ?? "", /deadline moved LATER .*s06-6h-visa-free \+15 min/);
  });

  it("a deadline moved earlier is red and classified as more conservative", () => {
    const cand = runLayoverScenarioCorpus(withScenario("s06-6h-visa-free", (s) => ({
      ...s, airport: { ...s.airport, internationalBufferMin: s.airport.internationalBufferMin + 15 },
    })));
    const r = compareToGolden(golden, cand);
    assert.equal(r.ok, false);
    assert.deepEqual(r.diff.deadlineMovedEarlier, [{ sessionId: "corpus:s06-6h-visa-free", byMinutes: 15 }]);
    assert.equal(r.diff.deadlineMovedLater.length, 0);
  });

  it("a verdict flip is red and named", () => {
    const cand = runLayoverScenarioCorpus(withScenario("s06-6h-visa-free", (s) => ({ ...s, entry: { state: "unresolved", reason: "no_data_for_corridor" } })));
    const r = compareToGolden(golden, cand);
    assert.equal(r.ok, false);
    assert.deepEqual(r.diff.verdictFlips, [{ sessionId: "corpus:s06-6h-visa-free", from: "yes", to: "entry_unverified" }]);
    assert.match(formatLayoverDiffReport(r), /verdict flip: corpus:s06-6h-visa-free yes → entry_unverified/);
  });

  it("a scenario added to the tree, or gone from it, is red", () => {
    const added = compareToGolden(golden.slice(1), golden);
    assert.equal(added.ok, false);
    assert.deepEqual(added.added, [golden[0]!.sessionId]);
    const removed = compareToGolden(golden, golden.slice(1));
    assert.equal(removed.ok, false);
    assert.deepEqual(removed.removed, [golden[0]!.sessionId]);
  });

  it("a comparison that lined nothing up is red, never 'nothing changed'", () => {
    const r = compareToGolden([], []);
    assert.equal(r.diff.vacuous, true);
    assert.equal(r.ok, false);
    assert.match(formatLayoverDiffReport(r), /VACUOUS/);
  });
});

describe("the golden is written only with a reason, and canonically", () => {
  it("refuses an update with no note", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "layover-golden-"));
    try {
      assert.throws(() => writeLayoverGolden(runLayoverScenarioCorpus(), "   ", null, path.join(dir, "g.json")), /note/);
      assert.throws(() => writeLayoverGolden(runLayoverScenarioCorpus(), "too short", null, path.join(dir, "g.json")), /note/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("writes sorted-key JSON that reads back to the same decisions, byte-identical on a rewrite", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "layover-golden-"));
    try {
      const f = path.join(dir, "g.json");
      writeLayoverGolden(runLayoverScenarioCorpus(), "a note long enough to explain", "abc123", f);
      const first = readFileSync(f, "utf8");
      writeLayoverGolden(runLayoverScenarioCorpus(), "a note long enough to explain", "abc123", f);
      assert.equal(readFileSync(f, "utf8"), first);
      const back = readLayoverGolden(f)!;
      assert.equal(compareToGolden(back.decisions, runLayoverScenarioCorpus()).ok, true);
      assert.ok(first.indexOf('"decisions"') < first.indexOf('"head"') && first.indexOf('"head"') < first.indexOf('"note"'), "keys are sorted");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * check:no-money-in-ranking can fail — and fails on exactly what
 * docs/architecture/08_Portava_Revenue_Model.md §6 and
 * 09_Payment_Architecture.md §10 refuse (PAY-019, PAY-074, PAY-080, REV-037).
 *
 * A guard that matches nothing and a correct guard are indistinguishable from a
 * green run. So each rule is driven red on a FIXTURE tree built here, the real
 * tree is asserted clean by the real script with no seam set, and the one
 * finding the check was written for — a buddy's list price on the Compass
 * front-load item — is reproduced from the line as it stood before PAY-074.
 *
 *   K1  the vocabulary: whole words, not substrings.
 *   K2  the real tree is clean, the open owner question is exactly the one
 *       pinned here, and the scan is not passing by reading nothing.
 *   K3  the real script, over the real tree, exits 0, prints its count — and
 *       EMITS THE WARNING for the open owner question: the question's text,
 *       where it is tracked, and a GitHub `::warning` annotation on the file.
 *   K4  a money identifier in a ranker, a feature vector, a graph builder or a
 *       feed payload fails — as a variable, a selected column, a table name.
 *   K5  the pre-PAY-074 front-load select fails; the closed projection passes.
 *   K6  comments never trip it; a string does; a URL cannot hide what follows.
 *   K7  the allowlist admits exactly the entry it names, and a stale or
 *       unjustified entry fails.
 *   K8  it cannot stop looking: an emptied scope entry fails, and so does a
 *       new file named like a ranker, a scorer or a graph builder that nothing
 *       classifies.
 *   K9  the script exits 1 on a fixture tree through its seam.
 *   K10 an open owner question is reported and does NOT fail the check — and
 *       is not an allowlist: it covers exactly the identifiers it names (a new
 *       money read in the same file fails, in a fixture and through the real
 *       script), and it is stale the moment it names more than the code reads.
 *   K11 THE RATCHET: the set of open questions is pinned here, tuple by tuple.
 *       Adding one, widening one, narrowing one or dropping one fails.
 *
 * Run: node --import tsx/esm --test src/test/noMoneyInRankingCheck.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST,
  OPEN_DECISIONS,
  OUT_OF_SCOPE,
  SCOPE,
  failureCount,
  filesOf,
  isRankingShapedName,
  moneyIdentifiersIn,
  moneyTermIn,
  openQuestionLines,
  runCheck,
  wordsOf,
  type Config,
  type ScopeEntry,
} from "../scripts/checkNoMoneyInRanking.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const REAL_SRC = resolve(__dir, "..");
const SCRIPT = "src/scripts/checkNoMoneyInRanking.ts";

/**
 * THE RATCHET. The open owner questions the check may report without failing, as (file, identifiers).
 * This list is a second signature on OPEN_DECISIONS: the script cannot gain an entry, widen one or
 * lose one without this literal being edited by someone who read it. It only ever SHRINKS, and an
 * entry leaves in one of two ways — its identifiers move to ALLOWLIST citing the owner's ruling, or
 * the code that reads them is removed. Unanswered as of 2026-10-04; tracked in PR #596's description.
 */
// EMPTY, and it only ever shrinks. It held one entry — the buddy scorer's five
// price identifiers — and the owner answered that question on 2026-10-04: a
// list price may NOT order the buddies a traveller is shown. The terms were
// removed from calculateCompatibilityScore and the entry deleted, which is the
// one exit this ratchet allows besides allowlisting under a ruling.
//
// Empty is the strongest state, not a weakened one: K11 proves that ADDING any
// entry is refused, so the next price-in-ranking exception cannot arrive
// quietly. The ratchet's other branches — widened, narrowed, dropped, moved —
// are proven against a FIXTURE pin, since there is no live entry to vary.
const PINNED_OPEN_DECISIONS: ReadonlyArray<readonly [file: string, identifiers: readonly string[]]> = [];

/** A pin to prove the ratchet's branches against, now that the live pin is empty. */
const FIXTURE_PIN: ReadonlyArray<readonly [file: string, identifiers: readonly string[]]> = [
  ["services/buddies/MatchScoreService.ts", ["budgetMaxUsd", "hourlyRateUsd"]],
];

/** Throws unless `decisions` is exactly the pinned set: same files, same identifiers, nothing added, nothing dropped. */
function assertOpenSetPinned(
  decisions: ReadonlyArray<{ file: string; identifiers: readonly string[] }>,
  pin: ReadonlyArray<readonly [file: string, identifiers: readonly string[]]> = PINNED_OPEN_DECISIONS,
): void {
  assert.deepEqual(
    decisions.map((d) => [d.file, [...d.identifiers].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    pin.map(([file, ids]) => [file, [...ids].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    "OPEN_DECISIONS is not the pinned set. An open owner question may not be added or widened to get a check green, " +
      "and may not be dropped quietly: move its identifiers to ALLOWLIST citing the owner's ruling, or remove the code, and then edit PINNED_OPEN_DECISIONS.",
  );
}

const scratch: string[] = [];
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

/** A fixture `src` tree: `files` maps a path relative to it to its content. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "no-money-in-ranking-"));
  scratch.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const ONE_OF_EACH: readonly ScopeEntry[] = [
  { path: "lib/portavaRank.ts", group: "ranker", why: "fixture ranker" },
  { path: "lib/features.ts", group: "feature-vector", why: "fixture feature vector" },
  { path: "compass/CompassGraphEngine.ts", group: "graph", why: "fixture graph builder" },
  { path: "compass/CompassFrontLoadEngine.ts", group: "feed-payload", why: "fixture feed payload" },
];
const CLEAN: Record<string, string> = {
  "lib/portavaRank.ts": "export const DEFAULT_WEIGHTS = { categoryAffinity: 0.4, actionability: 0.9 };\n",
  "lib/features.ts": "export const vector = (c: any) => [c.recency, c.socialProof, c.watchCompletionRate];\n",
  "compass/CompassGraphEngine.ts": "export const node = (p: any) => ({ node_type: 'place', city: p.city });\n",
  "compass/CompassFrontLoadEngine.ts": "export const cols = 'user_id, display_name, tagline, city, average_rating';\n",
};
const config = (over: Partial<Config> = {}): Config => ({ scope: ONE_OF_EACH, allowlist: [], outOfScope: [], ...over });

/** The file the owner's 2026-10-04 price-in-ranking ruling concerned. */
const SCORER = "services/rentBuddy/CompatibilityScoreService.ts";

describe("check:no-money-in-ranking", () => {
  it("K1. the vocabulary matches whole words of an identifier, never substrings", () => {
    assert.deepEqual(wordsOf("hourly_rate_usd"), ["hourly", "rate", "usd"]);
    assert.deepEqual(wordsOf("platformFeePercent"), ["platform", "fee", "percent"]);
    assert.deepEqual(wordsOf("PAYOUT_TOTAL"), ["payout", "total"]);
    for (const money of [
      "hourly_rate_usd", "total_usd", "platformFeePercent", "platform_revenue", "commissionRate", "payoutVolume",
      "tip_usd", "rent_buddy_tips", "rent_buddy_earnings_ledger", "creator_earning_entries", "creator_share_ledger",
      "priceLevel", "takeRate", "amount_minor", "cash_balance_usd", "isSponsored", "promoted_listing", "subscriptionTier",
    ]) {
      assert.notEqual(moneyTermIn(money), null, `${money} is a money identifier and was not recognised`);
    }
    for (const innocent of [
      "feed", "feedback", "negativeFeedback", "learning", "outcomeLearning", "tooltip", "cache", "forbid",
      "watchCompletionRate", "recent_rate", "explorationBudgetPct", "budgetStyle", "FEATURED_BOOST_MULTIPLIER",
      "earned_at", "CityConfidenceTier", "rent_buddy_bookings", "coffee", "prepaidness",
    ]) {
      assert.equal(moneyTermIn(innocent), null, `${innocent} is not a money identifier and was flagged`);
    }
  });

  it("K2. the tree as committed carries no finding and no open owner question, and the scan reads every group", () => {
    const r = runCheck(REAL_SRC);
    // The buddy scorer carries NO price identifier, by any route. The owner ruled on
    // 2026-10-04 that a buddy's list price must not influence the compatibility score
    // or the default order, so the ifNot branch was taken: the terms were removed and
    // the OPEN_DECISIONS entry deleted. It is neither open (the state before the
    // ruling) nor allowlisted (the branch the owner did NOT take — asserted below).
    //
    // These two name the file deliberately, and sit ABOVE the whole-tree assertion
    // that follows: `assert.deepEqual` is declared `asserts actual is T`, so that
    // line narrows `r.findings` to `never[]` and a per-file filter after it would be
    // unreachable rather than true. Kept because they still carry the ruling if the
    // whole-tree assertion is ever relaxed to admit a finding elsewhere.
    assert.deepEqual(r.findings.filter((f) => f.file === SCORER), [],
      "a money identifier is back in the buddy scorer");
    assert.deepEqual(r.open.filter((f) => f.file === SCORER), [],
      "the buddy scorer is still reported as an open decision after it was answered");
    assert.deepEqual(r.findings, [], "a money identifier is read by a ranker, a feature vector, a graph builder or a feed payload");
    assert.equal(failureCount(r), 0, JSON.stringify({ empty: r.emptyScope, stale: r.staleAllow, staleOpen: r.staleOpen, unclassified: r.unclassified, unjustified: r.unjustified, staleOut: r.staleOutOfScope }));
    // What is reported-not-failed is exactly what the pinned entries name, as the real tree carries it:
    // every pinned identifier is still read (else the entry is stale), and no other hit is counted open.
    assert.deepEqual(
      [...new Set(r.open.map((f) => `${f.file}:${f.identifier}`))].sort(),
      PINNED_OPEN_DECISIONS.flatMap(([file, ids]) => ids.map((id) => `${file}:${id}`)).sort(),
      "the money reads reported as an open owner question are not exactly the pinned ones",
    );
    assert.equal(PINNED_OPEN_DECISIONS.length, 0,
      "the pin is no longer empty — an open owner question was re-opened, which K11 is the place to justify");
    assert.deepEqual(r.open, [],
      "a money read is reported as an open owner question, yet no question is open: the scorer's was answered on 2026-10-04");
    // Vacuity: a scan that inspected nothing must not read as clean.
    assert.ok(r.scanned.size >= 90, `expected at least the 90 files in scope when this was written, scanned ${r.scanned.size}`);
    for (const g of ["ranker", "feature-vector", "graph", "feed-payload"] as const) {
      assert.ok([...r.scanned.values()].includes(g), `no ${g} file was scanned`);
    }
    for (const f of [
      "lib/portavaRank.ts", "lib/discoveryPde.ts", "compass/CompassRecommendationEngine.ts", "compass/CompassGraphEngine.ts", "compass/CompassFrontLoadEngine.ts",
      // The Compass pipeline, its item shape and the marketplace's buddy scorer: the scan once stopped short of all of them.
      "compass/CompassPipeline.ts", "compass/CompassScoringEngine.ts", "compass/CompassDiversityEngine.ts", "compass/types.ts",
      "services/rentBuddy/CompatibilityScoreService.ts",
    ]) {
      assert.ok(r.scanned.has(f), `${f} is not being scanned`);
    }
    // What the wider scan found is accounted for by name, not by leaving the file out.
    const allowedIn = (file: string) => [...new Set(r.allowed.filter((a) => a.file === file).map((a) => a.identifier))].sort();
    assert.deepEqual(allowedIn("compass/CompassDiversityEngine.ts"), ["PAID_NIGHTLIFE_CAP_RATIO", "applyNightlifePaidCap", "isNightlifeOrPaid", "isPaid"]);
    assert.deepEqual(allowedIn("compass/CompassScoringEngine.ts"), ["promoted"]);
    assert.deepEqual(allowedIn("compass/types.ts"), ["hasOffAppPaymentSignal"]);
    assert.deepEqual(allowedIn(SCORER), [],
      "the scorer's price inputs were allowlisted — that is the branch the owner did NOT take");
    // Every allowlist entry is in use and carries a real reason (staleAllow/unjustified are empty above); say how many.
    assert.equal(new Set(r.allowed.map((a) => `${a.file}:${a.identifier}`)).size, ALLOWLIST.length);
    assert.ok(SCOPE.every((e) => filesOf(REAL_SRC, e).length > 0));
    assert.ok(OUT_OF_SCOPE.length >= 1);
  });

  it("K3. CONTROL — the real script over the real tree exits 0, reports what it scanned, and emits NO open-question warning", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], { cwd: API_ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`.slice(0, 4000));
    const m = /(\d+) ranking, feature-vector, graph and feed-payload files scanned/.exec(r.stdout);
    assert.ok(m, "the inspection line check:guard-reachability reads is missing");
    assert.ok(Number(m![1]) >= 70, "the check is passing by scanning nothing");
    assert.match(r.stdout, /RESULT clean/);

    // NO open owner question is reported, because none is open: the buddy scorer's
    // was answered on 2026-10-04. This is asserted rather than left unsaid, because
    // the reporting path still exists for the next question and a silent run is the
    // only thing that distinguishes "nothing to report" from "the report broke".
    assert.equal(PINNED_OPEN_DECISIONS.length, 0, "the pin grew; this test no longer describes the tree");
    assert.deepEqual(r.stdout.match(/^::warning /gm), null,
      "an open-question annotation was emitted with no open question recorded");
    assert.doesNotMatch(r.stdout, /^ {2}OPEN {6}/m, "an open owner question is reported with none recorded");
    assert.match(r.stdout, /^RESULT clean$/m,
      "the result line still carries an open-question count after the question was answered");
    // The emitter those assertions prove ABSENT is proven PRESENT in K12, on a fixture.
  });

  it("K4. a money identifier fails in each kind of file: a variable, a selected column, a table name", () => {
    const cases: Array<[file: string, added: string, identifier: string]> = [
      ["lib/portavaRank.ts", "export const w = { ...DEFAULT_WEIGHTS, platformRevenue: 0.2 };\n", "platformRevenue"],
      ["lib/features.ts", "export const price = (c: any) => c.hourly_rate_usd;\n", "hourly_rate_usd"],
      ["compass/CompassGraphEngine.ts", "export const q = (db: any) => db.from('rent_buddy_payouts').select('buddy_id');\n", "rent_buddy_payouts"],
      ["compass/CompassFrontLoadEngine.ts", "export const cols2 = 'user_id, commission_rate';\n", "commission_rate"],
    ];
    for (const [file, added, identifier] of cases) {
      const r = runCheck(tree({ ...CLEAN, [file]: CLEAN[file] + added }), config());
      assert.ok(
        r.findings.some((f) => f.file === file && f.identifier === identifier && f.line === 2),
        `${identifier} in ${file} was not reported: ${JSON.stringify(r.findings)}`,
      );
      assert.ok(failureCount(r) > 0);
    }
    // The twin: the same four files with nothing added are clean.
    assert.equal(failureCount(runCheck(tree(CLEAN), config())), 0);
  });

  it("K5. the front-load select as it stood before PAY-074 fails; the closed projection passes", () => {
    const before = `.select("user_id, display_name, tagline, city, hourly_rate_usd, average_rating")`;
    assert.deepEqual(moneyIdentifiersIn(before).map((h) => h.identifier), ["hourly_rate_usd"]);
    const after = `.select("user_id, display_name, tagline, city, average_rating")`;
    assert.deepEqual(moneyIdentifiersIn(after), []);
  });

  it("K6. comments do not trip it; strings do; a URL in a string cannot hide the rest of its line", () => {
    assert.deepEqual(moneyIdentifiersIn("// never read hourly_rate_usd here\nconst a = 1; /* nor the payout */\n"), []);
    assert.deepEqual(moneyIdentifiersIn("const cols = `id, tip_usd`;\n").map((h) => h.identifier), ["tip_usd"]);
    // stripComments cuts at the `//` of the URL; the raw line is scanned instead.
    assert.deepEqual(
      moneyIdentifiersIn(`const u = "https://example.test/x" + row.payout_total;\n`).map((h) => h.identifier),
      ["payout_total"],
    );
  });

  it("K7. the allowlist admits exactly what it names; a stale or unjustified entry fails", () => {
    const files = { ...CLEAN, "lib/features.ts": CLEAN["lib/features.ts"] + "export const cls = (c: any) => c.source === 'sponsored';\n" };
    const why = "the disclosure class: reading it downgrades the claim, it never raises a score";
    const entry = { file: "lib/features.ts", identifier: "sponsored", why };

    const admitted = runCheck(tree(files), config({ allowlist: [entry] }));
    assert.equal(failureCount(admitted), 0, JSON.stringify(admitted.findings));
    assert.deepEqual(admitted.allowed.map((a) => a.identifier), ["sponsored"]);

    // The same identifier in ANOTHER file is not covered by that entry.
    const elsewhere = runCheck(
      tree({ ...files, "lib/portavaRank.ts": CLEAN["lib/portavaRank.ts"] + "export const s = 'sponsored';\n" }),
      config({ allowlist: [entry] }),
    );
    assert.deepEqual(elsewhere.findings.map((f) => `${f.file}:${f.identifier}`), ["lib/portavaRank.ts:sponsored"]);

    // A different identifier in the SAME file is not covered either.
    const other = runCheck(
      tree({ ...files, "lib/features.ts": files["lib/features.ts"] + "export const p = (c: any) => c.price;\n" }),
      config({ allowlist: [entry] }),
    );
    assert.deepEqual(other.findings.map((f) => f.identifier), ["price"]);

    // Stale: the entry outlives the code it excused.
    const stale = runCheck(tree(CLEAN), config({ allowlist: [entry] }));
    assert.deepEqual(stale.staleAllow.map((a) => a.identifier), ["sponsored"]);
    assert.ok(failureCount(stale) > 0);

    // Unjustified: a reason too short to be one.
    const thin = runCheck(tree(files), config({ allowlist: [{ ...entry, why: "ok" }] }));
    assert.equal(thin.unjustified.length, 1);
    assert.ok(failureCount(thin) > 0);
  });

  it("K8. it cannot stop looking: an empty scope entry fails, and so does an unclassified ranker or graph builder", () => {
    // The ranker is renamed; its scope entry now names nothing.
    const { ["lib/portavaRank.ts"]: _gone, ...rest } = CLEAN;
    const renamed = runCheck(tree({ ...rest, "lib/scoring.ts": CLEAN["lib/portavaRank.ts"]! }), config());
    assert.deepEqual(renamed.emptyScope.map((e) => e.path), ["lib/portavaRank.ts"]);
    assert.ok(failureCount(renamed) > 0);

    // A new file named like a ranker, and one named like a graph builder, arrive unclassified.
    const added = tree({ ...CLEAN, "services/buddies/buddyRanking.ts": "export const x = 1;\n", "lib/placeGraphBuilder.ts": "export const y = 1;\n" });
    const r = runCheck(added, config());
    assert.deepEqual(r.unclassified.sort(), ["lib/placeGraphBuilder.ts", "services/buddies/buddyRanking.ts"]);
    assert.ok(failureCount(r) > 0);

    // Classifying them — in scope, or out of scope with a reason — clears it.
    const classified = runCheck(added, config({
      scope: [...ONE_OF_EACH, { path: "services/buddies", group: "ranker", why: "fixture" }],
      outOfScope: [{ file: "lib/placeGraphBuilder.ts", why: "a fixture file that is deliberately not scanned, with a reason long enough" }],
    }));
    assert.equal(failureCount(classified), 0, JSON.stringify(classified.unclassified));

    // The name rule reads words: `telegraph` is not `graph`.
    assert.equal(isRankingShapedName("services/telegraph/telegraphSearch.ts"), false);
    assert.equal(isRankingShapedName("lib/portavaRank.ts"), true);
    assert.equal(isRankingShapedName("compass/CompassGraphEngine.ts"), true);

    // A SCORER is a ranker by another name: the buddy match's scorer and the Compass
    // scoring engine both sat outside the scan while the rule knew only "rank" and "graph".
    for (const name of ["services/rentBuddy/CompatibilityScoreService.ts", "compass/CompassScoringEngine.ts", "lib/trustScore.ts", "lib/placeScorer.ts", "services/x/scoredCandidates.ts", "lib/venueScores.ts"]) {
      assert.equal(isRankingShapedName(name), true, `${name} is named like a scorer and the rule does not see it`);
    }
    // …and it still reads words: a `scoreboard`, an `underscore` helper, a `core` module are not scorers.
    for (const name of ["lib/underscore.ts", "lib/scoreboard.ts", "lib/coreTypes.ts", "services/soccer/fixtures.ts"]) {
      assert.equal(isRankingShapedName(name), false, `${name} is not named like a scorer and was flagged`);
    }
    const scorer = runCheck(tree({ ...CLEAN, "services/buddies/MatchScoreService.ts": "export const x = 1;\n", "compass/FitScoringEngine.ts": "export const y = 1;\n" }), config());
    assert.deepEqual(scorer.unclassified.sort(), ["compass/FitScoringEngine.ts", "services/buddies/MatchScoreService.ts"]);
    assert.ok(failureCount(scorer) > 0);

    // An OUT_OF_SCOPE entry for a file that is gone is itself stale.
    const ghost = runCheck(tree(CLEAN), config({ outOfScope: [{ file: "lib/gone/graph.ts", why: "a file that no longer exists and so cannot be excused from anything" }] }));
    assert.deepEqual(ghost.staleOutOfScope, ["lib/gone/graph.ts"]);
  });

  it("K9. the script exits 1 on a tree that carries a money identifier, and names the file and line", () => {
    // The seam points the REAL scope at a fixture root, so every real scope entry
    // must exist there; build each one clean, then put a price into the ranker.
    const files: Record<string, string> = {};
    for (const e of SCOPE) {
      if (e.path.endsWith("*")) files[`${e.path.slice(0, -1)}Fixture.ts`] = "export const x = 1;\n";
      else if (e.path.endsWith(".ts")) files[e.path] = "export const x = 1;\n";
      else files[`${e.path}/fixture.ts`] = "export const x = 1;\n";
    }
    // Each allowlisted identifier must appear in its file, or its entry is stale and the clean control goes red.
    ALLOWLIST.forEach((a, i) => { files[a.file] = (files[a.file] ?? "") + `export const literal${i} = "${a.identifier}";\n`; });
    // …and each open decision's identifiers in its file, or that entry is stale.
    OPEN_DECISIONS.forEach((d, i) => d.identifiers.forEach((id, j) => { files[d.file] = (files[d.file] ?? "") + `export const open${i}_${j} = "${id}";\n`; }));
    for (const o of OUT_OF_SCOPE) files[o.file] = "export const x = 1;\n";

    const run = (root: string) => spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], {
      cwd: API_ROOT, encoding: "utf8", env: { ...process.env, NO_MONEY_IN_RANKING_SRC: root },
    });

    // Control for the fixture itself: clean, it passes — so the red below is the price and nothing else.
    // (It carries the open question's identifiers, so it warns, as the real tree does.)
    const clean = run(tree(files));
    assert.equal(clean.status, 0, `${clean.stderr}\n${clean.stdout}`.slice(0, 4000));
    assert.doesNotMatch(clean.stdout, /^ {2}(MONEY|EMPTY|UNCLASSIFIED|STALE|UNJUSTIFIED)\b/m, `the fixture is not clean:\n${clean.stdout}`.slice(0, 4000));
    assert.match(clean.stdout, /RESULT clean/);

    const dirty = run(tree({ ...files, "lib/portavaRank.ts": "export const x = 1;\nexport const bid = (c: any) => c.platform_fee_percent;\n" }));
    assert.equal(dirty.status, 1, `${dirty.stderr}\n${dirty.stdout}`.slice(0, 4000));
    assert.match(dirty.stdout, /MONEY\s+lib\/portavaRank\.ts:2\s+`platform_fee_percent` \(fee\) in a ranker file/);
    assert.match(dirty.stdout, /MONEY\s+lib\/portavaRank\.ts:2\s+`bid` \(bid\)/);
    assert.match(dirty.stdout, /RESULT failed$/m);

    // (a) A money read in the buddy scorer FAILS — through the real script, with the
    // real (empty) OPEN_DECISIONS. Before the 2026-10-04 ruling this file carried the
    // open question, so a price read there was reported and passed; now there is no
    // entry to cover it and a price is an ordinary finding, which is the whole point
    // of answering the question in code rather than allowlisting it.
    const esc = SCORER.replace(/[.]/g, "\\.");
    const priced = run(tree({ ...files, [SCORER]: files[SCORER]! + "export const fit = (b: any, p: any) => (b.hourlyRateUsd <= p.budgetMaxUsd ? 100 : 10);\n" }));
    assert.equal(priced.status, 1, `a price read in ${SCORER} passed:\n${priced.stdout}`.slice(0, 4000));
    assert.match(priced.stdout, new RegExp(`MONEY\\s+${esc}:\\d+\\s+\`hourlyRateUsd\` \\(usd\\)`));
    assert.match(priced.stdout, new RegExp(`MONEY\\s+${esc}:\\d+\\s+\`budgetMaxUsd\` \\(usd\\)`));
    assert.doesNotMatch(priced.stdout, /^::warning /m, "the answered question is still being reported as open");
    assert.match(priced.stdout, /RESULT failed$/m);
    // A commission read there fails the same way — nothing about that file is excused.
    const cut = run(tree({ ...files, [SCORER]: files[SCORER]! + "export const cut = (b: any) => b.commissionRate * b.platformFeePercent;\n" }));
    assert.equal(cut.status, 1, cut.stdout.slice(0, 4000));
    assert.match(cut.stdout, new RegExp(`MONEY\\s+${esc}:\\d+\\s+\`commissionRate\` \\(commission\\)`));
    // …and a price identifier read in ANOTHER in-scope file fails there.
    const moved = run(tree({ ...files, "lib/portavaRank.ts": "export const x = 1;\nexport const p = (b: any) => b.hourlyRateUsd;\n" }));
    assert.equal(moved.status, 1, moved.stdout.slice(0, 4000));
    assert.match(moved.stdout, /MONEY\s+lib\/portavaRank\.ts:2\s+`hourlyRateUsd` \(usd\)/);
  });

  it("K10. an open owner question is reported and does not fail — and covers exactly the identifiers it names", () => {
    const scorer = "services/buddies/MatchScoreService.ts";
    const scope = [...ONE_OF_EACH, { path: scorer, group: "ranker" as const, why: "fixture buddy scorer" }];
    const reads = "export const fit = (b: any, p: any) => (b.hourlyRateUsd <= p.budgetMaxUsd ? 100 : 10);\n";
    const decision = {
      file: scorer,
      identifiers: ["hourlyRateUsd", "budgetMaxUsd"],
      what: "the fixture scorer compares a list price with the viewer's stated budget",
      question: "may a list price be an input to the order in which buddies are shown?",
      ifAllowed: "move the identifiers to the allowlist, citing the ruling",
      ifNot: "remove the term from the score and delete this entry",
      askedOn: "2026-10-04",
      trackedIn: "a fixture: the description of the pull request that asked",
    };

    // Recorded, it is reported and the check passes — and it is NOT counted as allowed.
    const open = runCheck(tree({ ...CLEAN, [scorer]: reads }), config({ scope, openDecisions: [decision] }));
    assert.deepEqual(open.findings, []);
    assert.deepEqual(open.open.map((f) => f.identifier), ["hourlyRateUsd", "budgetMaxUsd"]);
    assert.deepEqual(open.allowed, [], "an open owner question was counted as allowed");
    assert.equal(failureCount(open), 0, "an open owner question failed the check");

    // Unrecorded, the same lines are ordinary findings and FAIL: reporting-not-failing is the entry's doing alone.
    const unrecorded = runCheck(tree({ ...CLEAN, [scorer]: reads }), config({ scope }));
    assert.deepEqual(unrecorded.findings.map((f) => f.identifier), ["hourlyRateUsd", "budgetMaxUsd"]);
    assert.equal(failureCount(unrecorded), 2);

    // It covers the identifiers it names and no other: a commission read arriving in the same file FAILS.
    const more = runCheck(tree({ ...CLEAN, [scorer]: reads + "export const cut = (b: any) => b.commissionRate;\n" }), config({ scope, openDecisions: [decision] }));
    assert.deepEqual(more.findings.map((f) => f.identifier), ["commissionRate"]);
    assert.equal(failureCount(more), 1);
    // …and the same identifiers in ANOTHER file are findings there.
    const elsewhere = runCheck(tree({ ...CLEAN, [scorer]: reads, "lib/portavaRank.ts": CLEAN["lib/portavaRank.ts"] + "export const p = (b: any) => b.hourlyRateUsd;\n" }), config({ scope, openDecisions: [decision] }));
    assert.deepEqual(elsewhere.findings.map((f) => `${f.file}:${f.identifier}`), ["lib/portavaRank.ts:hourlyRateUsd"]);
    assert.equal(failureCount(elsewhere), 1);

    // An entry may not be WIDER than the code: naming an identifier the file does not read is stale, and fails.
    const wide = runCheck(tree({ ...CLEAN, [scorer]: reads }), config({ scope, openDecisions: [{ ...decision, identifiers: [...decision.identifiers, "tipUsd"] }] }));
    assert.deepEqual(wide.staleOpen.map((d) => d.file), [scorer]);
    assert.ok(failureCount(wide) > 0, "an entry naming a money identifier nobody reads yet would excuse it the day somebody does");
    // Answered in code — the term removed — the entry is stale and fails until it is deleted.
    const answered = runCheck(tree({ ...CLEAN, [scorer]: "export const fit = () => 50;\n" }), config({ scope, openDecisions: [decision] }));
    assert.deepEqual(answered.staleOpen.map((d) => d.file), [scorer]);
    assert.ok(failureCount(answered) > 0);
    // An entry with no identifiers covers nothing and is not an entry.
    const empty = runCheck(tree({ ...CLEAN, [scorer]: reads }), config({ scope, openDecisions: [{ ...decision, identifiers: [] }] }));
    assert.equal(empty.staleOpen.length, 1);
    assert.deepEqual(empty.findings.map((f) => f.identifier), ["hourlyRateUsd", "budgetMaxUsd"]);

    // An entry that does not say what it asks, when it was asked or where it is tracked is not one.
    for (const thin of [{ question: "ok?" }, { trackedIn: "somewhere" }, { askedOn: "recently" }, { ifNot: "fix" }]) {
      const r = runCheck(tree({ ...CLEAN, [scorer]: reads }), config({ scope, openDecisions: [{ ...decision, ...thin }] }));
      assert.deepEqual(r.unjustified, [`OPEN_DECISIONS ${scorer}`], JSON.stringify(thin));
      assert.ok(failureCount(r) > 0);
    }
  });

  it("K11. THE RATCHET — the set of open owner questions is pinned EMPTY: none may be added, and no branch of the pin check has gone slack", () => {
    // The live set is the pinned set, and both are empty. That is the ruling, not an
    // omission: the one question there was is answered in code.
    assertOpenSetPinned(OPEN_DECISIONS);
    assert.deepEqual(OPEN_DECISIONS.map((d) => d.file), [],
      "an open decision is recorded again — if that is deliberate, this assertion is the place to say so");
    assert.equal(PINNED_OPEN_DECISIONS.length, 0,
      "the pin grew. It only shrinks: an owner question is answered, never joined by another to get a check green");

    const refused = (what: string, decisions: ReadonlyArray<{ file: string; identifiers: readonly string[] }>, pin?: typeof FIXTURE_PIN) =>
      assert.throws(() => assertOpenSetPinned(decisions, pin), /OPEN_DECISIONS is not the pinned set/, `${what} was not caught by the ratchet`);

    // THE LIVE PROTECTION: against an empty pin, ANY entry is an addition and is refused.
    // This is what stops the next price-in-ranking exception arriving as a green check.
    refused("a first open decision", [{ file: "lib/portavaRank.ts", identifiers: ["platformRevenue"] }]);
    refused("an entry re-opening the answered question", [{ file: SCORER, identifiers: ["hourlyRateUsd"] }]);
    refused("an entry with no identifiers", [{ file: SCORER, identifiers: [] }]);

    // The ratchet's OTHER branches have no live entry to vary, so they are proven
    // against a fixture pin — the alternative is four assertions that cannot fail.
    const real = { file: FIXTURE_PIN[0]![0], identifiers: FIXTURE_PIN[0]![1] };
    assertOpenSetPinned([real], FIXTURE_PIN);
    refused("a second open decision", [real, { file: "lib/portavaRank.ts", identifiers: ["platformRevenue"] }], FIXTURE_PIN);
    refused("a second open decision on the same file", [real, { file: real.file, identifiers: ["commissionRate"] }], FIXTURE_PIN);
    refused("a widened entry", [{ file: real.file, identifiers: [...real.identifiers, "commissionRate"] }], FIXTURE_PIN);
    refused("a narrowed entry", [{ file: real.file, identifiers: real.identifiers.slice(1) }], FIXTURE_PIN);
    refused("the entry dropped", [], FIXTURE_PIN);
    refused("the entry moved to another file", [{ file: "services/rentBuddy/OtherScore.ts", identifiers: real.identifiers }], FIXTURE_PIN);
    // The twin: the same set, in another order, is the same set.
    assertOpenSetPinned([{ file: real.file, identifiers: [...real.identifiers].reverse() }], FIXTURE_PIN);

    // The answered identifiers are not quietly allowlisted instead: that would be the
    // other branch of the ruling, and the owner did not take it.
    for (const id of ["budgetMinUsd", "budgetMaxUsd", "hourlyRateUsd", "halfDayRateUsd", "fullDayRateUsd"]) {
      assert.ok(!ALLOWLIST.some((a) => a.file === SCORER && a.identifier === id),
        `${SCORER} \`${id}\` was allowlisted rather than removed`);
    }
  });

  it("K12. the open-question reporter still works — proven on a fixture, because no real run reaches it any more", () => {
    // K3 proves the real run emits nothing. Without this, the reporter the next owner
    // question depends on would be dead code nobody could notice breaking.
    const scorer = "services/buddies/MatchScoreService.ts";
    const scope = [...ONE_OF_EACH, { path: scorer, group: "ranker" as const, why: "fixture buddy scorer" }];
    const decision = {
      file: scorer,
      identifiers: ["hourlyRateUsd", "budgetMaxUsd"],
      what: "the fixture scorer compares a list price with the viewer's stated budget",
      question: "may a list price be an input to the order in which buddies are shown?",
      ifAllowed: "move the identifiers to the allowlist, citing the ruling",
      ifNot: "remove the term from the score and delete this entry",
      askedOn: "2026-10-04",
      trackedIn: "a fixture: the description of the pull request that asked",
    };
    const reads = "export const x = 1;\nexport const fit = (b: any, p: any) => (b.hourlyRateUsd <= p.budgetMaxUsd ? 100 : 10);\n";
    const r = runCheck(tree({ ...CLEAN, [scorer]: reads }), config({ scope, openDecisions: [decision] }));
    const lines = openQuestionLines([decision], r);

    // One GitHub annotation, on the file and the first line that reads a named identifier.
    const warnings = lines.filter((l) => l.startsWith("::warning "));
    assert.equal(warnings.length, 1, "one annotation per open question, no more");
    const w = warnings[0]!;
    assert.match(w, new RegExp(`^::warning file=artifacts/api-server/src/${scorer.replace(/[.]/g, "\\.")},line=2,title=[^:,]+::OPEN OWNER QUESTION, asked 2026-10-04 and unanswered\\. `));
    assert.ok(w.includes(decision.question), "the annotation does not carry the question");
    assert.ok(w.includes(decision.trackedIn), "the annotation does not say where the question is tracked");
    assert.ok(w.includes("reported, not failed"), "the annotation does not say what a warning here means");
    for (const id of decision.identifiers) assert.ok(w.includes(`\`${id}\``), `the annotation does not name ${id}`);
    // …and the long form, for a reader of the log.
    assert.ok(lines.some((l) => l.startsWith(`  OPEN      ${scorer} reads a money input in a ranker.`)));
    assert.ok(lines.includes(`            The question: ${decision.question}`));
    assert.ok(lines.includes(`            Tracked in:   ${decision.trackedIn}.`));
    assert.ok(lines.includes(`            If it may stay: ${decision.ifAllowed}.`));
    assert.ok(lines.includes(`            If it may not:  ${decision.ifNot}.`));

    // A recorded question whose file reads none of its identifiers prints nothing — the
    // stale rule fails that run instead (K10), so the reporter must not also vouch for it.
    const silent = runCheck(tree({ ...CLEAN, [scorer]: "export const fit = () => 50;\n" }), config({ scope, openDecisions: [decision] }));
    assert.deepEqual(openQuestionLines([decision], silent), []);
    // And with nothing recorded — the real tree's state — it prints nothing at all.
    assert.deepEqual(openQuestionLines([], r), []);
  });
});

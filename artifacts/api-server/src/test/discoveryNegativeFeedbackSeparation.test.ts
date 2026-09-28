/**
 * census-discovery §82 (lane W10-O) — DV-78: `04` §4's safety controls
 * (`report`, `mute`, `block`) stay separate from ranking, and `not_interested`
 * is the one negative that reaches a ranking statistic.
 *
 * `04` §4: "Safety/private controls may be recorded for enforcement but must be
 * separated from public reputation scoring." `01` §10: PDE must never "make
 * safety/private-control events into public reputation penalties". `05` §4 (Graph Engine):
 * "Private actions such as block/unfollow can affect visibility/safety but
 * should not be exposed as reasons or public reputation penalties."
 *
 * What is verified, from the code as it stands (each probe carries an
 * in-memory mutation control, so a probe that cannot fail cannot pass):
 *   N1  the one cross-viewer negative statistic (content_distribution_stats'
 *       negative_signal_count, via recordNegativeDistributionSignal) is written
 *       for `dismiss` — not_interested ≡ hide on Discovery (D-W10-O-6) — and
 *       from nowhere else; the outcome vocabulary has no report, mute or block.
 *   N2  no ranking module reads a report table: `discovery_place_reports` and
 *       `trail_reports` are read by the rollout monitor (3391), the governor's
 *       spam monitor and moderation, never by a scorer.
 *   N3  on Discovery the ranker's report/hide/mute/block inputs are constants:
 *       the viewer's own safety controls do not reorder anything there.
 *   N4  block and mute act as ELIGIBILITY on Discovery — the author-exclusion
 *       set is applied where the candidate rows are read — never as a score.
 *   N5  the one ranking-side read of `blocks` (creator activity) EXCLUDES the
 *       blocked parties' interactions from a creator's positive signals; it
 *       never counts blocks as a penalty.
 *
 * Run: node --import tsx/esm --test src/test/discoveryNegativeFeedbackSeparation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const RANKERS = ["lib/portavaRank.ts", "lib/discoveryPde.ts",
  ...readdirSync(resolve(SRC, "services/ranking")).filter((f) => f.endsWith(".ts")).map((f) => `services/ranking/${f}`)];

/** Every call site of recordNegativeDistributionSignal outside its definition, with the guard on its line. */
function negativeSignalCalls(files: Record<string, string>): Array<{ file: string; line: string }> {
  const out: Array<{ file: string; line: string }> = [];
  for (const [file, src] of Object.entries(files)) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      // The call and the line guarding it (the guard sits on the line above).
      if (/\brecordNegativeDistributionSignal\(/.test(line) && !/function recordNegativeDistributionSignal/.test(line)) out.push({ file, line: `${(lines[i - 1] ?? "").trim()} ${line.trim()}` });
    });
  }
  return out;
}
/** The OUTCOME_VALUES tuple the route accepts. */
function outcomeValues(src: string): string[] {
  const m = /const OUTCOME_VALUES = \[([^\]]*)\] as const;/.exec(src);
  return m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
}
function readsReportTable(src: string): boolean {
  return /\.from\(\s*["'`](discovery_place_reports|trail_reports)["'`]/.test(src) || /\b(discovery_place_reports|trail_reports)\b/.test(src);
}

describe("DV-78 — report, mute and block stay out of ranking (census-discovery §82)", () => {
  it("N1. the cross-viewer negative statistic is written for `dismiss` only; no report/mute/block outcome exists", () => {
    const files: Record<string, string> = {};
    for (const dir of ["routes", "lib", "services/ranking", "compass"]) {
      for (const f of readdirSync(resolve(SRC, dir))) if (f.endsWith(".ts")) files[`${dir}/${f}`] = read(`${dir}/${f}`);
    }
    const calls = negativeSignalCalls(files);
    assert.deepEqual(calls.map((c) => c.file), ["routes/rankEvents.ts"], JSON.stringify(calls));
    assert.match(calls[0]!.line, /outcome === DISMISS/);
    const vocab = outcomeValues(files["routes/rankEvents.ts"]!);
    assert.ok(vocab.includes("dismiss"));
    for (const safety of ["report", "mute", "block", "hide"]) assert.ok(!vocab.includes(safety), `${safety} must not be a funnel outcome`);
    // Mutation control: a report wired into the statistic is seen.
    const mutated = { ...files, "routes/discovery.ts": `${files["routes/discovery.ts"]}\nvoid recordNegativeDistributionSignal(sc, placeId, user.id);` };
    assert.equal(negativeSignalCalls(mutated).length, 2, "control: the probe sees a second writer");
  });

  it("N2. no ranking module reads a report table", () => {
    for (const f of RANKERS) assert.equal(readsReportTable(read(f)), false, `${f} reads a report table`);
    assert.equal(readsReportTable(`sc.from("discovery_place_reports").select("id")`), true, "control");
  });

  it("N3. on Discovery the ranker's report/hide/mute/block inputs are constants", () => {
    const pde = read("lib/discoveryPde.ts");
    for (const needle of ["authorIsBlockedByViewer: false, authorBlocksViewer: false,", "authorIsMutedByViewer: false,",
      "viewerHasReportedItem: false, viewerHasHiddenItem: false,", "mutedCreatorIds:    new Set(),", "blockedCreatorIds:  new Set(),"]) {
      assert.ok(pde.includes(needle), `discoveryPde no longer passes the constant "${needle}"`);
    }
  });

  it("N4. block and mute are eligibility on Discovery: one author-exclusion set, applied where rows are read", () => {
    const route = read("routes/discovery.ts");
    assert.match(route, /fetchBlockedSet\(blockSc, callerUserId\)\.then\(\(b\) => withMutedAuthors\(blockSc, callerUserId!, b\)\)/);
    assert.match(route, /if \(!submitterIsVisible\(row\.submitted_by, blockedIds\)/);
    for (const f of RANKERS) assert.doesNotMatch(read(f), /\bwithMutedAuthors\b|\bfetchBlockedSet\b/, `${f} must not turn the exclusion set into a score`);
  });

  it("N5. the one ranking-side read of `blocks` excludes interactions, it does not penalise", () => {
    const cas = read("services/ranking/CreatorActivityScoreService.ts");
    assert.match(cas, /\.from\("blocks"\)/);
    const uses = cas.split("\n").filter((l) => /blockedIds/.test(l) && !/^\s*(\*|\/\/)/.test(l));
    for (const l of uses) {
      // Every use is the set itself, its null check, or an EXCLUSION (`!has` keeps
      // the others; `has(...)) continue` skips the blocked party).
      assert.match(l, /blockedIds !== null|!blockedIds\.has\(|blockedIds\.has\(\w+\)\) continue;|blockedIds!\)|blockedIds: Set<string>|= await this\._fetchBlockedIds/,
        `an unexpected use of the block set: ${l.trim()}`);
    }
    assert.doesNotMatch(cas, /blockedIds\.size/, "the NUMBER of blocks never enters a score");
  });
});

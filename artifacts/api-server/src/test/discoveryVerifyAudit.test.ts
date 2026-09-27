/**
 * discoveryVerifyAudit.test.ts — census-discovery §59 (verification lane P12):
 * the adversarial audit's negative inputs for rows moved to C in §46–§55, as
 * pure cases that run in the ordinary `npm test`. Each case is either a LIMIT
 * or DEFECT the lanes did not test, pinned so a fix turns it red and forces the
 * census to be updated, or a CONTROL that shows the probe itself is sound.
 *
 *   A1  DEFECT, pinned (DV-20): the Trail canonicaliser drops letters NFKD does
 *       not decompose — Đ, Ł, Ø — so "Đà Nẵng street food" and "Da Nang street
 *       food" are two canonical Trails, and CHECK 1's similarity (0.6) is below
 *       the duplicate bar. `02` §2's own example (#danang) is the city it breaks.
 *   A1c CONTROL: the repository's stored-fold search key (B01) folds both
 *       spellings to one key; the fold the Trail slug needs already exists.
 *   A2  DEFECT, pinned (DV-25): the shared momentum kernel weighs a `dismiss`
 *       ("Not interested", the ONE negative outcome, 2297) as a positive
 *       engagement — a place its viewers dismiss GAINS momentum over one they
 *       merely saw.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalTrailSlug, titleSimilarity, DUPLICATE_TITLE_SIMILARITY } from "../lib/discoveryTrailObject.js";
import { searchKey } from "../lib/canonicalLocations.js";
import { computeLocalMomentum } from "../lib/discoveryLocalMomentum.js";

describe("census-discovery §59 — adversarial negative inputs for §46–§55's C rows", () => {
  it("A1. DEFECT, pinned (DV-20): 'Đà Nẵng street food' and 'Da Nang street food' canonicalise to two Trails", () => {
    const native = "Đà Nẵng street food";
    const ascii = "Da Nang street food";
    assert.equal(canonicalTrailSlug(native), "a-nang-street-food", "Đ is not decomposed by NFKD, so the city loses its first letter");
    assert.equal(canonicalTrailSlug(ascii), "da-nang-street-food");
    assert.notEqual(canonicalTrailSlug(native), canonicalTrailSlug(ascii));
    assert.ok(titleSimilarity(native, ascii) < DUPLICATE_TITLE_SIMILARITY,
      `CHECK 1 does not catch it either: similarity ${titleSimilarity(native, ascii)} < ${DUPLICATE_TITLE_SIMILARITY}`);
    assert.equal(canonicalTrailSlug("Łódź murals"), "odz-murals");
    assert.equal(canonicalTrailSlug("Øresund cycling"), "resund-cycling");
  });

  it("A1c. CONTROL: the stored-fold search key already folds both spellings to one key", () => {
    assert.equal(searchKey("Đà Nẵng street food"), searchKey("Da Nang street food"));
    assert.equal(searchKey("Łódź murals"), searchKey("Lodz murals"));
    assert.equal(searchKey("Øresund cycling"), searchKey("Oresund cycling"));
  });

  it("A2. DEFECT, pinned (DV-25): a dismissed place gains momentum over one that was only seen", () => {
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const recent = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const rows = [];
    // Two rows each: two impressions (weight 2) stay under the 3-weight floor;
    // two DISMISSED impressions weigh 2 + 2×2 = 6 and cross it.
    for (let i = 0; i < 2; i++) {
      rows.push({ item_id: "db/seen-only", outcome: "impression", served_at: recent, outcome_at: null });
      rows.push({ item_id: "db/dismissed", outcome: "dismiss", served_at: recent, outcome_at: recent });
    }
    const m = computeLocalMomentum(rows as any, nowMs).values;
    const seen = m["db/seen-only"] ?? 0;
    const dismissed = m["db/dismissed"] ?? 0;
    assert.equal(seen, 0, "two plain impressions are below the momentum floor");
    assert.ok(dismissed > 0,
      `"Not interested" counted as engagement: dismissed=${dismissed}, seen-only=${seen}`);
  });
});

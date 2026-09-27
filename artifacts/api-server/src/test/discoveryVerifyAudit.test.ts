/**
 * discoveryVerifyAudit.test.ts — census-discovery §59 (verification lane P12):
 * the adversarial audit's negative inputs for rows moved to C in §46–§55, as
 * pure cases that run in the ordinary `npm test`. Each case is either a LIMIT
 * or DEFECT the lanes did not test, pinned so a fix turns it red and forces the
 * census to be updated, or a CONTROL that shows the probe itself is sound.
 *
 *   A1  FIXED (DV-20, §61; flipped in §61.14): the Trail canonicaliser now
 *       folds the letters NFKD does not decompose — Đ, Ł, Ø — so "Đà Nẵng
 *       street food" and "Da Nang street food" are ONE canonical Trail, and
 *       CHECK 1's similarity is at the duplicate bar. P12 pinned this as a
 *       DEFECT at 838f56cb5 (two slugs, similarity 0.6); reverting §61's fold
 *       turns it red.
 *   A1c CONTROL: the repository's stored-fold search key (B01) folds both
 *       spellings to one key, the same answer the Trail slug now gives.
 *   A2  FIXED (DV-25, §61; flipped in §61.14): the shared momentum kernel
 *       weighs a `dismiss` ("Not interested", the ONE negative outcome, 2297)
 *       as zero, so a place its viewers dismiss gains NO momentum over one
 *       they merely saw. A2c is the control: a save on the same rows does
 *       cross the floor, so A2 is not green because the floor is unreachable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalTrailSlug, titleSimilarity, DUPLICATE_TITLE_SIMILARITY } from "../lib/discoveryTrailObject.js";
import { searchKey } from "../lib/canonicalLocations.js";
import { computeLocalMomentum } from "../lib/discoveryLocalMomentum.js";

describe("census-discovery §59 — adversarial negative inputs for §46–§55's C rows", () => {
  it("A1. FIXED (DV-20, §61): 'Đà Nẵng street food' and 'Da Nang street food' canonicalise to ONE Trail", () => {
    const native = "Đà Nẵng street food";
    const ascii = "Da Nang street food";
    assert.equal(canonicalTrailSlug(native), "da-nang-street-food", "Đ is folded to D, so the city keeps its first letter");
    assert.equal(canonicalTrailSlug(ascii), "da-nang-street-food");
    assert.equal(canonicalTrailSlug(native), canonicalTrailSlug(ascii));
    assert.ok(titleSimilarity(native, ascii) >= DUPLICATE_TITLE_SIMILARITY,
      `CHECK 1 catches it as well: similarity ${titleSimilarity(native, ascii)} >= ${DUPLICATE_TITLE_SIMILARITY}`);
    assert.equal(canonicalTrailSlug("Łódź murals"), "lodz-murals");
    assert.equal(canonicalTrailSlug("Øresund cycling"), "oresund-cycling");
  });

  it("A1c. CONTROL: the stored-fold search key already folds both spellings to one key", () => {
    assert.equal(searchKey("Đà Nẵng street food"), searchKey("Da Nang street food"));
    assert.equal(searchKey("Łódź murals"), searchKey("Lodz murals"));
    assert.equal(searchKey("Øresund cycling"), searchKey("Oresund cycling"));
  });

  it("A2. FIXED (DV-25, §61): a dismissed place gains no momentum over one that was only seen", () => {
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const recent = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const rows = [];
    // Two rows each: two impressions (weight 2) stay under the 3-weight floor.
    // Two DISMISSED impressions weighed 2 + 2×2 = 6 before §61 and crossed it;
    // with a dismiss weighing zero they weigh 2, the same as seen-only.
    for (let i = 0; i < 2; i++) {
      rows.push({ item_id: "db/seen-only", outcome: "impression", served_at: recent, outcome_at: null });
      rows.push({ item_id: "db/dismissed", outcome: "dismiss", served_at: recent, outcome_at: recent });
    }
    const m = computeLocalMomentum(rows as any, nowMs).values;
    const seen = m["db/seen-only"] ?? 0;
    const dismissed = m["db/dismissed"] ?? 0;
    assert.equal(seen, 0, "two plain impressions are below the momentum floor");
    assert.equal(dismissed, 0,
      `"Not interested" must not count as engagement: dismissed=${dismissed}, seen-only=${seen}`);
  });

  it("A2c. CONTROL: the same two rows SAVED do cross the floor, so A2's zero is the dismiss weight, not an unreachable floor", () => {
    const nowMs = Date.parse("2026-09-27T12:00:00Z");
    const recent = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const rows = [0, 1].map(() => ({ item_id: "db/saved", outcome: "save", served_at: recent, outcome_at: recent }));
    const m = computeLocalMomentum(rows as any, nowMs).values;
    assert.ok((m["db/saved"] ?? 0) > 0, `two saves must cross the floor: ${m["db/saved"]}`);
  });
  it("A1d. DEFECT, pinned (DV-20, §66.11): 'Ǿresund' and 'Øresund' canonicalise to two Trails; the fold deletes 114 of 398 Latin letters", () => {
    // §61.7 claims the slug "folds every Latin letter NFKD cannot decompose". The stroke table runs
    // BEFORE NFD, so Ǿ (Ø + acute) is never looked up, and hooked/barred letters (Ƀ, Ƙ, …) have no entry.
    assert.equal(canonicalTrailSlug("Øresund cycling"), "oresund-cycling");
    assert.equal(canonicalTrailSlug("Ǿresund cycling"), "resund-cycling", "Ǿ is deleted, not folded to o");
    assert.equal(canonicalTrailSlug("Ƀerlin street art"), "erlin-street-art", "Ƀ (B with stroke) is deleted");
    let deleted = 0, letters = 0;
    for (let c = 0xc0; c <= 0x24f; c++) {
      const ch = String.fromCodePoint(c);
      if (!/\p{L}/u.test(ch)) continue;
      letters++;
      const k = canonicalTrailSlug(ch + "x");
      if (!k || k === "x") deleted++;
    }
    assert.equal(letters, 398);
    assert.equal(deleted, 114, "Latin-1 Supplement … Latin Extended-B letters the fold deletes outright");
  });
});

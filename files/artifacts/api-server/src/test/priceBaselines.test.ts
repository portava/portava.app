/**
 * Price baselines seed — generation invariants.
 *
 * The seed drives real budget numbers, so lock its shape: full category×tier
 * coverage globally and per country, positive tidy amounts, sane index scaling,
 * and monotonic tiers (budget < comfortable < upscale < luxury).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateBaselineRows,
  GLOBAL_BASELINE,
  COUNTRY_PRICE_INDEX,
  BASELINE_CATEGORIES,
  BASELINE_TIERS,
} from "../lib/priceBaselines.js";

describe("price baselines seed", () => {
  const rows = generateBaselineRows();

  it("covers every category × tier globally and per country", () => {
    const nCountries = Object.keys(COUNTRY_PRICE_INDEX).length;
    const perScope = BASELINE_CATEGORIES.length * BASELINE_TIERS.length; // 24
    assert.equal(rows.length, perScope * (1 + nCountries));

    // Global scope complete.
    const global = rows.filter((r) => r.country === null);
    assert.equal(global.length, perScope);
    for (const cat of BASELINE_CATEGORIES)
      for (const tier of BASELINE_TIERS)
        assert.ok(global.some((r) => r.category === cat && r.tier === tier), `missing global ${cat}/${tier}`);
  });

  it("all amounts are positive integers", () => {
    for (const r of rows) {
      assert.ok(Number.isInteger(r.dailyAmount), `${r.country}/${r.category}/${r.tier} not integer`);
      assert.ok(r.dailyAmount > 0, `${r.country}/${r.category}/${r.tier} not positive`);
    }
  });

  it("tiers are monotonic within each scope+category", () => {
    const scopes = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.country ?? "GLOBAL"}|${r.category}`;
      if (!scopes.has(k)) scopes.set(k, []);
      scopes.get(k)!.push(r);
    }
    for (const [k, group] of scopes) {
      const byTier = Object.fromEntries(group.map((r) => [r.tier, r.dailyAmount]));
      assert.ok(byTier.budget <= byTier.comfortable, `${k}: budget>comfortable`);
      assert.ok(byTier.comfortable <= byTier.upscale, `${k}: comfortable>upscale`);
      assert.ok(byTier.upscale <= byTier.luxury, `${k}: upscale>luxury`);
    }
  });

  it("cheap countries scale below global, expensive above", () => {
    const globalLodgingComfort = GLOBAL_BASELINE.lodging.comfortable;
    const cheap = rows.find((r) => r.country === "IN" && r.category === "lodging" && r.tier === "comfortable")!;
    const pricey = rows.find((r) => r.country === "CH" && r.category === "lodging" && r.tier === "comfortable")!;
    assert.ok(cheap.dailyAmount < globalLodgingComfort);
    assert.ok(pricey.dailyAmount > globalLodgingComfort);
  });

  it("indices are all in a sane range", () => {
    for (const [c, idx] of Object.entries(COUNTRY_PRICE_INDEX)) {
      assert.ok(idx >= 0.4 && idx <= 2.0, `${c} index ${idx} out of range`);
    }
  });
});

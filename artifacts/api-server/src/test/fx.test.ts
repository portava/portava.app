/**
 * FX conversion + refresh tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadFxTable,
  convert,
  convertBand,
  convertEstimate,
  refreshFxRates,
  FX_DISCLAIMER,
} from "../lib/fx.js";

// Fake fx_rates: EUR base. USD=1.10/EUR, GBP=0.85/EUR, THB=39/EUR, latest date 2026-07-24.
function makeSc(rows?: any[], opts: { upsertCapture?: any[] } = {}) {
  const data = rows ?? [
    { currency: "USD", rate: 1.10, rate_date: "2026-07-24" },
    { currency: "GBP", rate: 0.85, rate_date: "2026-07-24" },
    { currency: "THB", rate: 39, rate_date: "2026-07-24" },
    { currency: "EUR", rate: 1, rate_date: "2026-07-24" },
  ];
  return {
    from(_t: string) {
      const b: any = {
        _f: [] as Array<[string, any]>,
        select() { return b; },
        eq(k: string, v: any) { b._f.push([k, v]); return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle: async () => ({ data: { rate_date: "2026-07-24" }, error: null }),
        upsert(vals: any[]) { opts.upsertCapture?.push(...vals); return { then: (r: any) => r({ error: null }) }; },
        then(resolve: any) { resolve({ data, error: null }); },
      };
      return b;
    },
  } as any;
}

describe("fx conversion", () => {
  it("loads the latest table with the base identity", async () => {
    const t = await loadFxTable(makeSc());
    assert.equal(t.base, "EUR");
    assert.equal(t.rateDate, "2026-07-24");
    assert.equal(t.rates.get("EUR"), 1);
    assert.equal(t.rates.get("USD"), 1.10);
  });

  it("converts via the base pivot", async () => {
    const t = await loadFxTable(makeSc());
    // 110 USD → EUR: 110 / 1.10 = 100
    assert.equal(convert(110, "USD", "EUR", t), 100);
    // 100 EUR → THB: 100 * 39 = 3900
    assert.equal(convert(100, "EUR", "THB", t), 3900);
    // 110 USD → GBP: 110 * (0.85/1.10) = 85
    assert.equal(convert(110, "USD", "GBP", t), 85);
    // same currency identity
    assert.equal(convert(50, "USD", "USD", t), 50);
  });

  it("returns null for an unsupported currency (honest, not fabricated)", async () => {
    const t = await loadFxTable(makeSc());
    assert.equal(convert(100, "USD", "XYZ", t), null);
    assert.equal(convert(100, "ZZZ", "USD", t), null);
  });

  it("convertBand converts all three points", async () => {
    const t = await loadFxTable(makeSc());
    const b = convertBand({ low: 110, mid: 220, high: 330 }, "USD", "EUR", t);
    assert.deepEqual(b, { low: 100, mid: 200, high: 300 });
  });

  it("convertEstimate produces a labeled converted block; null for same/missing", async () => {
    const sc = makeSc();
    const conv = await convertEstimate(sc, "THB", "USD", { low: 390, mid: 780, high: 1170 }, { low: 3900, mid: 7800, high: 11700 });
    assert.ok(conv);
    assert.equal(conv!.currency, "USD");
    // 780 THB → USD: 780 * (1.10/39) = 22
    assert.equal(conv!.perDay.mid, 22);
    assert.equal(conv!.rateDate, "2026-07-24");
    assert.equal(conv!.disclaimer, FX_DISCLAIMER);

    assert.equal(await convertEstimate(sc, "USD", "USD", { low: 1, mid: 1, high: 1 }, { low: 1, mid: 1, high: 1 }), null);
    assert.equal(await convertEstimate(sc, "USD", "ZZ", { low: 1, mid: 1, high: 1 }, { low: 1, mid: 1, high: 1 }), null);
  });
});

describe("fx refresh", () => {
  const okFetch = (payload: any) => async (_url: string) => ({ ok: true, status: 200, json: async () => payload });

  it("upserts rows from a well-formed payload (+ base identity row)", async () => {
    const captured: any[] = [];
    const sc = makeSc(undefined, { upsertCapture: captured });
    const r = await refreshFxRates(sc, okFetch({ base: "EUR", date: "2026-07-25", rates: { USD: 1.09, GBP: 0.86 } }));
    assert.equal(r.ok, true);
    assert.equal(r.rateDate, "2026-07-25");
    // USD + GBP + EUR identity
    assert.equal(captured.length, 3);
    assert.ok(captured.some((x) => x.currency === "EUR" && x.rate === 1));
    assert.ok(captured.some((x) => x.currency === "USD" && x.rate === 1.09));
  });

  it("rejects a bad payload without upserting", async () => {
    const captured: any[] = [];
    const sc = makeSc(undefined, { upsertCapture: captured });
    const r = await refreshFxRates(sc, okFetch({ base: "EUR", date: "nope", rates: null }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bad_payload");
    assert.equal(captured.length, 0);
  });

  it("handles a non-200 response", async () => {
    const sc = makeSc();
    const r = await refreshFxRates(sc, async () => ({ ok: false, status: 503, json: async () => ({}) }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "http_503");
  });

  it("handles a fetch throw", async () => {
    const sc = makeSc();
    const r = await refreshFxRates(sc, async () => { throw new Error("dns"); });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /fetch_failed/);
  });
});

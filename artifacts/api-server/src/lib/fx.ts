/**
 * FX — currency conversion over the fx_rates table (Compass data).
 *
 * fx_rates holds ECB reference rates with base_currency='EUR': each row's
 * `rate` is "units of `currency` per 1 EUR" for a given rate_date. Cross-rate
 * conversion pivots through the base:
 *
 *     amount_to = amount_from * (rate[to] / rate[from])
 *
 * HONESTY CONTRACT:
 *   - Conversions are labeled with the rate_date and an "indicative" disclaimer
 *     (ECB reference rates ≠ the rate a traveler actually gets).
 *   - When either currency is missing from the table, convert() returns null —
 *     the caller shows the original amount, never a fabricated conversion.
 *
 * refreshFxRates() re-fetches the latest ECB rates (frankfurter.dev) and upserts
 * them; it is what the daily scheduler calls. fetch is injectable for tests.
 */

export const FX_DISCLAIMER =
  "Indicative conversion at ECB reference rates — the rate you actually pay may differ.";

export interface FxTable {
  base: string;
  rateDate: string | null;
  /** currency → units per 1 base. The base itself maps to 1. */
  rates: Map<string, number>;
}

export interface MoneyBand { low: number; mid: number; high: number }

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Load the most recent rate_date's rates into an in-memory table. Returns an
 * empty table (never throws) when fx_rates is missing/empty.
 */
export async function loadFxTable(sc: any, base = "EUR"): Promise<FxTable> {
  const table: FxTable = { base, rateDate: null, rates: new Map([[base, 1]]) };
  try {
    // Find the latest rate_date for this base.
    const { data: latest, error: e1 } = await sc
      .from("fx_rates")
      .select("rate_date")
      .eq("base_currency", base)
      .order("rate_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e1 || !latest) return table;
    const rateDate = (latest as any).rate_date as string;
    table.rateDate = rateDate;

    const { data, error } = await sc
      .from("fx_rates")
      .select("currency, rate")
      .eq("base_currency", base)
      .eq("rate_date", rateDate);
    if (error || !Array.isArray(data)) return table;
    for (const row of data as any[]) {
      const cur = String(row.currency ?? "").toUpperCase();
      const rate = Number(row.rate);
      if (cur && Number.isFinite(rate) && rate > 0) table.rates.set(cur, rate);
    }
  } catch {
    // return whatever we have (at least the base)
  }
  return table;
}

/** Convert an amount between currencies via the base pivot. Null if unsupported. */
export function convert(amount: number, from: string, to: string, table: FxTable): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return round2(amount);
  const rf = table.rates.get(f);
  const rt = table.rates.get(t);
  if (!rf || !rt) return null;
  return round2(amount * (rt / rf));
}

/** Convert a {low,mid,high} band. Null if unsupported. */
export function convertBand(band: MoneyBand, from: string, to: string, table: FxTable): MoneyBand | null {
  const low = convert(band.low, from, to, table);
  const mid = convert(band.mid, from, to, table);
  const high = convert(band.high, from, to, table);
  if (low === null || mid === null || high === null) return null;
  return { low, mid, high };
}

export interface ConvertedEstimate {
  currency: string;
  perDay: MoneyBand;
  total: MoneyBand;
  rateDate: string | null;
  disclaimer: string;
}

/**
 * Produce a converted view of a budget estimate's perDay/total bands in
 * `homeCurrency`. Returns null when conversion is unavailable (same currency,
 * missing rate, or no fx data) so the caller just omits the converted block.
 */
export async function convertEstimate(
  sc: any,
  fromCurrency: string,
  homeCurrency: string,
  perDay: MoneyBand,
  total: MoneyBand,
): Promise<ConvertedEstimate | null> {
  const from = (fromCurrency || "").toUpperCase();
  const home = (homeCurrency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(home) || from === home) return null;
  const table = await loadFxTable(sc);
  const pd = convertBand(perDay, from, home, table);
  const tot = convertBand(total, from, home, table);
  if (!pd || !tot) return null;
  return { currency: home, perDay: pd, total: tot, rateDate: table.rateDate, disclaimer: FX_DISCLAIMER };
}

// ── Refresh (daily scheduler target) ──────────────────────────────────────────

export const FX_SOURCE = "ECB reference rates via frankfurter.dev";
const FX_ENDPOINT = process.env.FX_REFRESH_URL?.trim() || "https://api.frankfurter.dev/v1/latest?base=EUR";

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface FxRefreshResult {
  ok: boolean;
  rateDate?: string;
  upserted?: number;
  reason?: string;
}

/**
 * Fetch the latest ECB rates and upsert into fx_rates (base EUR). Best-effort:
 * returns {ok:false, reason} instead of throwing. `fetchImpl` is injectable for
 * tests; defaults to global fetch with a timeout.
 */
export async function refreshFxRates(sc: any, fetchImpl?: FetchLike): Promise<FxRefreshResult> {
  const doFetch: FetchLike =
    fetchImpl ??
    ((url: string) => fetch(url, { signal: AbortSignal.timeout(8000) }) as any);

  let payload: any;
  try {
    const resp = await doFetch(FX_ENDPOINT);
    if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
    payload = await resp.json();
  } catch (e: any) {
    return { ok: false, reason: `fetch_failed:${e?.message ?? "error"}` };
  }

  const base = String(payload?.base ?? "EUR").toUpperCase();
  const rateDate = String(payload?.date ?? "").slice(0, 10);
  const rates = payload?.rates && typeof payload.rates === "object" ? payload.rates : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate) || !rates) return { ok: false, reason: "bad_payload" };

  const rows = Object.entries(rates)
    .filter(([cur, rate]) => /^[A-Za-z]{3}$/.test(cur) && Number(rate) > 0)
    .map(([cur, rate]) => ({
      base_currency: base,
      currency: String(cur).toUpperCase(),
      rate: Number(rate),
      rate_date: rateDate,
      source: FX_SOURCE,
    }));
  // Include the base→base identity row so loadFxTable always has it.
  rows.push({ base_currency: base, currency: base, rate: 1, rate_date: rateDate, source: FX_SOURCE });

  try {
    const { error } = await sc
      .from("fx_rates")
      .upsert(rows, { onConflict: "base_currency,currency,rate_date", ignoreDuplicates: false });
    if (error) return { ok: false, reason: `upsert_failed:${error.message}` };
  } catch (e: any) {
    return { ok: false, reason: `upsert_threw:${e?.message ?? "error"}` };
  }

  return { ok: true, rateDate, upserted: rows.length };
}

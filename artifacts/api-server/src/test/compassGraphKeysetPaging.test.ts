/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's residual "CompassGraphEngine offset
 * paging", D-W11X2-172): the graph's support reads page by KEY, so a write between two pages never skips a row that
 * existed throughout, and a skipped row is never read as "no support".
 *
 * CompassGraphEngine's readAllPages paged every support read by OFFSET (`.range(page * 500, …)` in `id` or `city`
 * order). A row deleted from an earlier page between two reads shifts every later row back by one, so the next page
 * starts one row late and the row at the boundary is never read — and the reconcile reads an absent row as an
 * unsupported one: retireUnsupportedCityRows retired the confidence row of a city whose model it had skipped. Round 21
 * ruled this class for the lists (B23: keyset, never an offset). Each page is now the first 500 rows AFTER the last key
 * received; a page with more rows than asked (a backend that ignores paging), a row without its key, or a row the cursor
 * already passed is not read whole.
 *
 *   KG0 CONTROL: 502 cities, nothing written meanwhile → nothing retired
 *   KG1 502 cities; another writer retires C000's model between the first and second page → C500's confidence row is
 *       kept (it was retired: the offset skipped C500's model)
 *   KG2 a backend that ignores `.range()` (every page is every row) → the read is not taken as whole; nothing retired
 *   KG3 every support read selects the key it is paged by (`id`), so the cursor is always known
 *
 * Harness: compassGraphRevocation's store-backed PostgREST fake (order, gt, range, like, delete), with a hook that runs
 * after a page is served.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retireUnsupportedCityRows } from "../compass/CompassGraphEngine.js";

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
interface Opts { ignoreRange?: Set<string>; afterPage?: (table: string, page: number, store: Store) => void }

function makeDb(store: Store, o: Opts = {}): SupabaseClient {
  const served: Record<string, number> = {};
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []; let orderKey: string | null = null; let rng: [number, number] | null = null; let del = false;
    const q: any = {
      select: () => q,
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; },
      in: (k: string, vs: readonly unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; },
      like: (k: string, p: string) => { const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`); filters.push((r) => re.test(String(r[k] ?? ""))); return q; },
      gt: (k: string, v: unknown) => { filters.push((r) => String(r[k] ?? "") > String(v)); return q; },
      order: (k: string) => { orderKey = k; return q; },
      range: (a: number, z: number) => { rng = [a, z]; return q; },
      delete: () => { del = true; return q; },
      then: (ok: any, bad: any) => {
        const rows = (store[table] ??= []);
        if (del) { store[table] = rows.filter((r) => !filters.every((f) => f(r))); return Promise.resolve({ data: null, error: null }).then(ok, bad); }
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (orderKey) { const k = orderKey; out = [...out].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0)); }
        if (rng && !o.ignoreRange?.has(table)) out = out.slice(rng[0], rng[1] + 1);
        const res = { data: out.map((r) => ({ ...r })), error: null };
        served[table] = (served[table] ?? 0) + 1; o.afterPage?.(table, served[table], store);
        return Promise.resolve(res).then(ok, bad);
      },
    };
    return q;
  };
  return { from } as unknown as SupabaseClient;
}
const city = (i: number) => `C${String(i).padStart(3, "0")}`;
function world(n: number): Store {
  const s: Store = { compass_city_models: [], compass_city_confidence: [], compass_graph_edges: [] };
  for (let i = 0; i < n; i++) {
    s.compass_city_models.push({ city: city(i) });
    s.compass_city_confidence.push({ city: city(i) });
    s.compass_graph_edges.push({ id: `e-${city(i)}`, src_type: "city", src_key: city(i), dst_type: "time", dst_key: "evening", edge_type: "active_during:evening" });
  }
  return s;
}
const confCities = (s: Store) => s.compass_city_confidence.map((r) => String(r.city));

describe("census-discovery §119 (residual): the graph's support reads page by key", () => {
  it("KG0 CONTROL: 502 cities, nothing written meanwhile → nothing retired", async () => {
    const s = world(502); const r = await retireUnsupportedCityRows(makeDb(s));
    assert.deepEqual({ models: r.modelsRetired, conf: r.confidenceRetired, unresolved: r.unresolved, kept: confCities(s).length }, { models: 0, conf: 0, unresolved: false, kept: 502 });
  });
  it("KG1 a model retired by another writer between the first and second page → C500's confidence row is kept", async () => {
    const s = world(502);
    const r = await retireUnsupportedCityRows(makeDb(s, { afterPage: (t, page, st) => { if (t === "compass_city_models" && page === 1) st.compass_city_models = st.compass_city_models.filter((x) => x.city !== "C000"); } }));
    assert.ok(confCities(s).includes("C500"), `a supported city's confidence row was retired over a skipped model: ${JSON.stringify(r)}`);
    assert.equal(r.confidenceRetired, 0, JSON.stringify(r));
  });
  it("KG2 a backend that ignores paging → not read whole; nothing retired", async () => {
    const s = world(502); s.compass_city_confidence.push({ city: "ORPHAN" });
    const r = await retireUnsupportedCityRows(makeDb(s, { ignoreRange: new Set(["compass_city_models"]) }));
    assert.deepEqual({ unresolved: r.unresolved, conf: r.confidenceRetired, models: r.modelsRetired }, { unresolved: true, conf: 0, models: 0 });
  });
  it("KG3 every support read selects the key it is paged by", () => {
    const src = readFileSync(new URL("../compass/CompassGraphEngine.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const supportReads = {"), src.indexOf("type GraphSourceTable"));
    const circles = src.slice(src.indexOf("function circleSourceRows"), src.indexOf("export const GRAPH_SOURCE_TABLES"));
    const selects = [...(block + circles).matchAll(/\.select\("([^"]*)"\)/g)].map((m) => m[1]);
    assert.ok(selects.length >= 7, `the scan found ${selects.length} support selects`);
    for (const cols of selects) assert.ok(cols.split(",").map((c) => c.trim()).includes("id"), `a support read pages by id but does not select it: "${cols}"`);
  });
});

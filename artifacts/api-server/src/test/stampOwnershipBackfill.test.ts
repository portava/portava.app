/**
 * backfillOwnershipCountries — ownership-row country backfill shared by the
 * manual script and the periodic XX-catalog sweep.
 *
 * Guards:
 *   - resolvable cities get their country set (batched per country)
 *   - unresolvable cities are left untouched and reported
 *   - rows with unresolvable cities can NEVER starve later resolvable rows
 *     (the per-run bound counts backfilled rows, and pagination scans on)
 *   - the maxBackfillsPerTable bound is respected
 *   - a throwing resolver doesn't abort the run
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  backfillOwnershipCountries,
  type CountryResolver,
} from "../lib/stamps/xxCatalogRepair.js";

type Row = { id: string; city: string | null; country: string | null };

/** Minimal fake Supabase client covering the query/update chains used. */
function makeFakeClient(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const state: any = { limit: null, gt: null, update: null, inIds: null };
      const builder: any = {
        select: () => builder,
        is: () => builder,       // only used for country IS NULL
        not: () => builder,      // only used for city NOT NULL
        order: () => builder,    // always id ascending
        gt: (_c: string, v: string) => { state.gt = v; return builder; },
        limit: (n: number) => { state.limit = n; return builder; },
        update: (vals: any) => { state.update = vals; return builder; },
        in: (_c: string, ids: string[]) => { state.inIds = ids; return builder; },
        then(resolve: (v: any) => void) {
          const rows = tables[table];
          if (!rows) return resolve({ data: null, error: { message: `relation "${table}" does not exist` } });
          if (state.update) {
            for (const r of rows) if (state.inIds.includes(r.id)) r.country = state.update.country;
            return resolve({ data: null, error: null });
          }
          let out = rows.filter((r) => r.country === null && r.city !== null);
          if (state.gt !== null) out = out.filter((r) => r.id > state.gt);
          out = [...out].sort((a, b) => (a.id < b.id ? -1 : 1));
          if (state.limit) out = out.slice(0, state.limit);
          return resolve({ data: out.map((r) => ({ id: r.id, city: r.city })), error: null });
        },
      };
      return builder;
    },
  } as any;
}

const silentLog = { info: () => {}, warn: () => {} };

const testResolver: CountryResolver = async ({ city }) => {
  const c = (city ?? "").toLowerCase();
  if (c === "london") return { country: "United Kingdom", countryCode: "GB" };
  if (c === "paris") return { country: "France", countryCode: "FR" };
  if (c === "boom") throw new Error("resolver blew up");
  return { country: null, countryCode: "XX" };
};

test("backfills resolvable rows and leaves unresolvable rows untouched", async () => {
  const tables = {
    user_stamps: [
      { id: "01", city: "London", country: null },
      { id: "02", city: "Nowhereville", country: null },
      { id: "03", city: "Paris", country: null },
    ],
    passport_stamps: [
      { id: "01", city: "london", country: null },
    ],
  };
  const stats = await backfillOwnershipCountries(makeFakeClient(tables), testResolver, {}, silentLog);
  assert.equal(stats.userStampsBackfilled, 2);
  assert.equal(stats.passportStampsBackfilled, 1);
  assert.deepEqual(stats.unresolvedCities, ["Nowhereville"]);
  assert.equal(tables.user_stamps[0].country, "United Kingdom");
  assert.equal(tables.user_stamps[1].country, null); // never guessed
  assert.equal(tables.user_stamps[2].country, "France");
  assert.equal(tables.passport_stamps[0].country, "United Kingdom");
});

test("unresolvable rows cannot starve later resolvable rows under the bound", async () => {
  // First 4 rows are unresolvable; the resolvable ones come after — with a
  // bound of 2 backfills they must still be reached (pagination scans on and
  // the bound counts only backfilled rows).
  const tables = {
    user_stamps: [
      { id: "01", city: "Ghost Town", country: null },
      { id: "02", city: "Ghost Town", country: null },
      { id: "03", city: "Mystery City", country: null },
      { id: "04", city: "Mystery City", country: null },
      { id: "05", city: "London", country: null },
      { id: "06", city: "Paris", country: null },
      { id: "07", city: "London", country: null },
    ],
    passport_stamps: [],
  };
  const stats = await backfillOwnershipCountries(
    makeFakeClient(tables),
    testResolver,
    { maxBackfillsPerTable: 2, pageSize: 3 }, // small pages force pagination
    silentLog,
  );
  assert.equal(stats.userStampsBackfilled, 2); // bound respected
  const backfilled = tables.user_stamps.filter((r) => r.country !== null);
  assert.equal(backfilled.length, 2);
  for (const r of backfilled) assert.ok(["London", "Paris"].includes(r.city!));
  // unresolvable rows untouched
  for (const r of tables.user_stamps.slice(0, 4)) assert.equal(r.country, null);
});

test("successive bounded runs make progress until everything resolvable is backfilled", async () => {
  const tables = {
    user_stamps: [
      { id: "01", city: "Ghost Town", country: null },
      { id: "02", city: "London", country: null },
      { id: "03", city: "Paris", country: null },
      { id: "04", city: "London", country: null },
    ],
    passport_stamps: [],
  };
  for (let i = 0; i < 3; i++) {
    await backfillOwnershipCountries(
      makeFakeClient(tables),
      testResolver,
      { maxBackfillsPerTable: 1, pageSize: 2 },
      silentLog,
    );
  }
  assert.equal(tables.user_stamps.filter((r) => r.country !== null).length, 3);
  assert.equal(tables.user_stamps[0].country, null);
});

test("a throwing resolver marks the city unresolved and does not abort the run", async () => {
  const tables = {
    user_stamps: [
      { id: "01", city: "Boom", country: null },
      { id: "02", city: "London", country: null },
    ],
    passport_stamps: [],
  };
  const stats = await backfillOwnershipCountries(makeFakeClient(tables), testResolver, {}, silentLog);
  assert.equal(stats.userStampsBackfilled, 1);
  assert.deepEqual(stats.unresolvedCities, ["Boom"]);
  assert.equal(tables.user_stamps[1].country, "United Kingdom");
});

test("a missing table is skipped without failing the other table", async () => {
  const tables = {
    user_stamps: [{ id: "01", city: "Paris", country: null }],
    // passport_stamps absent → read error
  } as Record<string, Row[]>;
  const stats = await backfillOwnershipCountries(makeFakeClient(tables), testResolver, {}, silentLog);
  assert.equal(stats.userStampsBackfilled, 1);
  assert.equal(stats.passportStampsBackfilled, 0);
});

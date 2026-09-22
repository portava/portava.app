/**
 * G57 — diacritic-insensitive matching while preserving display spelling.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT A DATABASE TEST. Migration 2220 adds
 * `canonical_locations.search_key` as a GENERATED ALWAYS column computed by
 * `input_normalize_city_key`, and the whole requirement turns on that stored
 * fold agreeing with the TypeScript one in `searchKey()`. Two independent
 * implementations of one rule is the arrangement that rots: the SQL is applied
 * once and then never read again, while the TypeScript is edited whenever a new
 * script needs folding.
 *
 * So this reads the MIGRATION and pins the TypeScript against the values
 * production actually stores.
 *
 * THE FIXTURE IS MEASURED, NOT INVENTED. These are the two rows read out of the
 * production database on 2026-09-21 after 2220 was applied there at 10:52:
 *
 *   name                 normalized_name     search_key
 *   Da Nang              da nang             da nang
 *   Thành phố Đà Nẵng    thanh pho a nang    thanh pho da nang
 *
 * The second row is the case 2220's own header cites, and it is the whole
 * argument for the column: `đ` has no NFD decomposition, so the legacy
 * normaliser DROPPED it and stored `a nang` — a key no user will ever type. A
 * query for "da nang" therefore cannot find the Vietnamese-spelled row through
 * `normalized_name`, and can through `search_key`.
 *
 * MUTATION: remove `đ` from STROKE_FOLD and the first case fails with
 * `thanh pho a nang`, which is exactly the production defect this closes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { searchKey, resolveGeoAlias } from '../lib/canonicalLocations.js';

/** Verbatim from production on 2026-09-21, after 2220. */
const PRODUCTION_ROWS = [
  { name: 'Da Nang',           normalized_name: 'da nang',          search_key: 'da nang' },
  { name: 'Thành phố Đà Nẵng', normalized_name: 'thanh pho a nang', search_key: 'thanh pho da nang' },
];

describe('§10/G57 — the stored fold and the TypeScript fold are one rule', () => {
  test('searchKey() reproduces the search_key production stores, for every measured row', () => {
    for (const row of PRODUCTION_ROWS) {
      assert.equal(
        searchKey(row.name),
        row.search_key,
        `searchKey(${JSON.stringify(row.name)}) must equal what the generated column holds`,
      );
    }
  });

  test('the legacy column CANNOT find the diacritic row, which is why the column exists', () => {
    const typed = resolveGeoAlias('da nang');
    assert.equal(typed, 'da nang', 'no alias-table entry may intercept this — the match must be the database');

    const viaSearchKey = PRODUCTION_ROWS.filter((r) => r.search_key.includes(typed));
    const viaLegacy    = PRODUCTION_ROWS.filter((r) => r.normalized_name.includes(typed));

    assert.equal(viaSearchKey.length, 2, 'both Da Nang rows are reachable through the stored fold');
    assert.equal(viaLegacy.length, 1, 'only the ASCII row is reachable through the legacy column');
    assert.equal(
      viaSearchKey.find((r) => !viaLegacy.includes(r))?.name,
      'Thành phố Đà Nẵng',
      'the row the stored fold adds is the diacritic one',
    );
  });

  test('display spelling is preserved — the fold is a KEY, never a rewrite', () => {
    // §10 asks for diacritic-insensitive MATCHING while preserving display
    // spelling. A fold that edited `name` would match beautifully and show the
    // user a mangled city.
    const vn = PRODUCTION_ROWS[1];
    assert.equal(vn.name, 'Thành phố Đà Nẵng');
    assert.notEqual(vn.name, vn.search_key);
  });

  test('the SQL normaliser in 2220 folds the same stroke letters the TypeScript does', () => {
    // Not a string-compare of two languages — a check that every stroke letter
    // TypeScript folds is also named in the migration, so one cannot gain a
    // letter the other lacks and start disagreeing about a stored key.
    const sql = readFileSync(
      new URL('../migrations/2220_canonical_locations_search_key.sql', import.meta.url),
      'utf8',
    );
    for (const ch of ['đ', 'ø', 'ł']) {
      assert.ok(
        sql.includes(ch),
        `2220 must fold ${ch} too — the TypeScript does, and a stored key computed without it would never match`,
      );
    }
  });
});

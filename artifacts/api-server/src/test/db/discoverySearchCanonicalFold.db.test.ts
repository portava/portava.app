/**
 * discoverySearchCanonicalFold.db — census-discovery B01 (§46), EXECUTED on
 * PostgreSQL 16 with migration 2220 applied by the harness's own chain replay.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoverySearchCanonicalFold.db.test.ts
 *      (or scripts/local-db/run-tests.sh). Skips without a database, like every
 *      src/test/db suite; run-tests.sh refuses a skipped run.
 *
 * What a fake cannot prove, and this does:
 *   K1  the GENERATED column stores the fold for rows inserted the way the app
 *       inserts them (normalized_name from the legacy TypeScript normaliser,
 *       search_key computed by the database, never written by anyone);
 *   K2  the real reader, over a PostgREST-shaped adapter that runs its exact
 *       statements: "zurich" → Zürich, "sao paulo" → São Paulo, "lodz" → Łódź,
 *       "da nang" → Thành phố Đà Nẵng, and a non-matching control → nothing;
 *   K3  the legacy normalized_name reader, same rows, same queries: Łódź is
 *       unreachable (the defect the stored fold closes, as a control);
 *   K4  the column ABSENT: PostgreSQL's own error (SQLSTATE 42703) is what the
 *       classifier sees, the reader degrades to the legacy key and MARKS the
 *       answer, and nothing throws; the column is then restored by re-running
 *       2220, which is idempotent, and then 3440 (§73), which recomputes it.
 *   K5  §73: input_normalize_city_key equals searchKey on every Latin letter in
 *       Unicode 17 (1453), alone, inside a word and before 'resund'.
 *   K6  §73: replacing the function does NOT rewrite a stored key; 3440's drop
 *       and re-add of the generated column does ('Ǿresund': 'resund' → 'oresund').
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, jsonLiteral, rows, scalar } from "./localDb.js";
import { psqlReadClient, type PsqlCall } from "./discoverySearchPsqlClient.js";
import { canonicalFoldOf, readCanonicalCitySuggestions, CANONICAL_FOLD_SOURCE, canonicalFoldFailures } from "../../lib/discoverySearchCanonical.js";
import { normalizeLocationName, searchKey, suggestCanonicalLocations } from "../../lib/canonicalLocations.js";
import { isMissingColumnError } from "../../lib/capability/schemaCapability.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const M2220 = resolve(__dir, "../../migrations/2220_canonical_locations_search_key.sql");
const M3440 = resolve(__dir, "../../migrations/3440_canonical_search_key_letter_fold.sql");
/** The fold as the chain leaves it: 2220 re-adds the column if absent, 3440 then recomputes it under §73's fold. */
const restoreFold = () => { exec(readFileSync(M2220, "utf8")); exec(readFileSync(M3440, "utf8")); };

const TAG = `p1fold-${randomUUID().slice(0, 8)}`;
const CITIES = [
  { name: "Zürich", country: "Switzerland" },
  { name: "São Paulo", country: "Brazil" },
  { name: "Łódź", country: "Poland" },
  { name: "Thành phố Đà Nẵng", country: "Vietnam" },
  { name: "Oslo", country: "Norway" },
];
const ids: string[] = [];

function q(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

describe("B01 — the stored diacritic fold on PostgreSQL 16 (2220 applied)", { skip: !HAVE_DB }, () => {
  before(() => {
    for (const c of CITIES) {
      const id = randomUUID();
      ids.push(id);
      // As the app writes a row: normalized_name from the TypeScript normaliser;
      // search_key is GENERATED and cannot be written.
      exec(
        `INSERT INTO public.canonical_locations (id, kind, name, normalized_name, display_name, country, lat, lng, aliases)
         VALUES ('${id}', 'city', ${q(c.name)}, ${q(normalizeLocationName(c.name))}, ${q(c.name)}, ${q(c.country)}, 1, 2, ARRAY[${q(TAG)}]);`,
      );
    }
  });

  after(() => {
    // Whatever K4 and K6 did, the column and the §73 fold are back before anyone else uses the database.
    restoreFold();
    exec(`DELETE FROM public.canonical_locations WHERE id IN (${ids.map((i) => `'${i}'`).join(", ")});`);
  });

  it("K1 — the generated column holds the fold; normalized_name holds what the legacy normaliser wrote", () => {
    const got = rows<{ name: string; normalized_name: string; search_key: string }>(
      `SELECT name, normalized_name, search_key FROM public.canonical_locations WHERE ${q(TAG)} = ANY(aliases) ORDER BY name`,
    );
    const by = new Map(got.map((r) => [r.name, r]));
    assert.equal(by.get("Łódź")!.normalized_name, "odz", "control: the legacy normaliser DELETES the stroke letter");
    assert.equal(by.get("Łódź")!.search_key, "lodz");
    assert.equal(by.get("Zürich")!.search_key, "zurich");
    assert.equal(by.get("São Paulo")!.search_key, "sao paulo");
    assert.equal(by.get("Thành phố Đà Nẵng")!.normalized_name, "thanh pho a nang", "production's own broken key, reproduced");
    assert.equal(by.get("Thành phố Đà Nẵng")!.search_key, "thanh pho da nang");
    assert.equal(
      scalar(`SELECT is_generated FROM information_schema.columns WHERE table_schema='public' AND table_name='canonical_locations' AND column_name='search_key'`),
      "ALWAYS",
    );
  });

  for (const [typed, expected] of [
    ["zurich", "Zürich"], ["Zurich", "Zürich"],
    ["sao paulo", "São Paulo"], ["São Paulo", "São Paulo"],
    ["lodz", "Łódź"], ["Łódź", "Łódź"],
    ["da nang", "Thành phố Đà Nẵng"],
  ] as const) {
    it(`K2 — the reader, over the real column: '${typed}' → ${expected}`, async () => {
      const log: PsqlCall[] = [];
      const got = await readCanonicalCitySuggestions(psqlReadClient(log), typed, 10);
      assert.ok(got.some((r) => r.name === expected), `${typed} did not reach ${expected}: ${JSON.stringify(got.map((r) => r.name))}`);
      assert.equal(canonicalFoldOf(got), "stored");
      assert.ok(log.every((c) => /search_key ILIKE/.test(c.sql)), "the match must come from the stored column");
    });
  }

  it("K2 — a non-matching control reaches nothing, and 'oslo' reaches Oslo alone", async () => {
    const none = await readCanonicalCitySuggestions(psqlReadClient(), "qqxyzzyqq", 10);
    assert.deepEqual(none, []);
    const oslo = await readCanonicalCitySuggestions(psqlReadClient(), "oslo", 10);
    assert.deepEqual(oslo.map((r) => r.name), ["Oslo"]);
  });

  it("K3 — the legacy reader over the same rows cannot reach Łódź (the defect, as a control)", async () => {
    const legacy = await suggestCanonicalLocations(psqlReadClient(), "lodz", 10);
    assert.ok(!legacy.some((r) => r.name === "Łódź"), "control failed: the legacy key reached Łódź, so K2 proves nothing");
  });

  it("K4 — the column ABSENT: PostgreSQL's 42703 is classified as missing, the reader degrades and MARKS it; restored after", async () => {
    exec(`DROP INDEX IF EXISTS public.canonical_locations_search_key_trgm_idx;\nALTER TABLE public.canonical_locations DROP COLUMN search_key;`);
    try {
      // The real error, as the adapter hands it over.
      const raw: any = await psqlReadClient().from("canonical_locations").select("*").ilike("search_key", "zurich%").limit(1);
      assert.equal(raw.error?.code, "42703", `expected PostgreSQL's undefined_column, got ${JSON.stringify(raw.error)}`);
      assert.equal(isMissingColumnError(raw.error), true, "the classifier does not recognise PostgreSQL's own error");

      const zurich = await readCanonicalCitySuggestions(psqlReadClient(), "zurich", 10);
      assert.ok(zurich.some((r) => r.name === "Zürich"), "the degrade must still serve a decomposable accent");
      assert.equal(canonicalFoldOf(zurich), "legacy");
      assert.deepEqual(canonicalFoldFailures(zurich), [CANONICAL_FOLD_SOURCE]);

      const lodz = await readCanonicalCitySuggestions(psqlReadClient(), "lodz", 10);
      assert.ok(!lodz.some((r) => r.name === "Łódź"));
      assert.equal(canonicalFoldOf(lodz), "legacy", "an unreadable fold index read exactly like 'no such city'");
    } finally {
      restoreFold();
    }
    assert.equal(scalar(`SELECT search_key FROM public.canonical_locations WHERE id = '${ids[2]}'`), "lodz", "2220 and 3440's re-run did not restore the fold");
  });

  it("K5 — §73 parity: the stored fold is searchKey on every one of the 1453 Latin letters, alone, inside a word and before 'resund'", () => {
    const letters: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) { if (cp === 0xd800) cp = 0xe000; const ch = String.fromCodePoint(cp); if (/^(?=\p{Script=Latin})\p{L}$/u.test(ch)) letters.push(ch); }
    const inputs = letters.flatMap((ch) => [ch, `x${ch}x`, `${ch}resund`]);
    const sql = JSON.parse(exec(`SELECT json_agg(public.input_normalize_city_key(v ->> 0) ORDER BY ord)::text
                                   FROM jsonb_array_elements(${jsonLiteral(inputs.map((s) => [s]))}) WITH ORDINALITY AS x(v, ord);`).join("\n")) as string[];
    const diff = inputs.flatMap((s, i) => (sql[i] === searchKey(s) ? [] : [`${s}: sql ${JSON.stringify(sql[i])} ts ${JSON.stringify(searchKey(s))}`]));
    assert.equal(letters.length, 1453, "every Latin letter in Unicode 17");
    assert.deepEqual(diff, []);
    assert.equal(sql[inputs.indexOf("Ǿresund")], "oresund");
  });

  it("K6 — §73: a replaced function leaves stored keys stale; 3440's drop and re-add recomputes them", () => {
    const id = randomUUID();
    ids.push(id);
    exec(readFileSync(M2220, "utf8")); // 2220's fold, as production has it today
    try {
      exec(`INSERT INTO public.canonical_locations (id, kind, name, normalized_name, display_name, country, lat, lng, aliases)
            VALUES ('${id}', 'city', 'Ǿresund', ${q(normalizeLocationName("Ǿresund"))}, 'Ǿresund', 'Denmark', 1, 2, ARRAY[${q(TAG)}]);`);
      const stored = () => scalar(`SELECT search_key FROM public.canonical_locations WHERE id = '${id}'`);
      assert.equal(stored(), "resund", "control: 2220's fold deletes the Ø inside Ǿ");
      const m = readFileSync(M3440, "utf8");
      const fnOnly = m.slice(m.indexOf("CREATE OR REPLACE FUNCTION public.input_normalize_city_key"), m.indexOf("$fn$;") + "$fn$;".length);
      exec(fnOnly);
      assert.equal(scalar(`SELECT public.input_normalize_city_key('Ǿresund')`), "oresund", "the new function folds");
      assert.equal(stored(), "resund", "…and the STORED key is unchanged: replacing the function is not enough");
      exec(m);
      assert.equal(stored(), "oresund", "3440 recomputed the stored key");
      assert.equal(scalar(`SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'canonical_locations_search_key_trgm_idx'`), "1");
    } finally {
      restoreFold();
    }
  });
});

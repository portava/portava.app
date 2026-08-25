/**
 * load-fsq-city.mjs — regression tests for the fail-closed FSQ ingest.
 *
 * The defect: `COPY (...) TO '/dev/stdout'` fails on Replit ("No such device or
 * address") but the run continued with zero rows and could still write a
 * misleading `fsq_city_ingests` success record. These prove the fixed contract:
 * DuckDB failure → no Supabase writes; a zero-row extraction fails closed unless
 * --allow-empty; a good extraction parses NDJSON; and the ingest ledger is
 * written ONLY after a successful upsert.
 *
 * The script is a `.mjs` with injectable deps; imported via a computed specifier
 * so the type-checker treats it as `any` (it ships no declarations).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";

const modPath = ["..", "..", "scripts", "load-fsq-city.mjs"].join("/");
const mod: any = await import(modPath);
const { buildExtractSql, parseNdjson, extractCityRows, ingestCity, runIngestFlow, SELECT_COLS } = mod;

const BBOX = { minLat: 16.0, minLng: 108.18, maxLat: 16.15, maxLng: 108.32 };
const BASE = { cityKey: "da-nang-vn", datasetDate: "2026-06-01", bbox: BBOX, parquet: "/data/fsq/places/*.parquet" };

/** Identity-ish transform so the tests exercise the flow, not fsqTransform internals. */
const idTransform = (r: any) =>
  r && r.fsq_place_id ? { fsq_id: r.fsq_place_id, name: r.name, category: r.category ?? "other" } : null;

/** Fake Supabase client: records every from(table).upsert(...) and can fail one table. */
function makeSc({ failTable = null as string | null } = {}) {
  const calls: { table: string; rows: any[] }[] = [];
  return {
    calls,
    from(table: string) {
      return {
        upsert: async (rows: any) => {
          calls.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
          return failTable === table ? { error: { message: `${table} boom` } } : { error: null };
        },
      };
    },
  };
}

/** A DuckDB stand-in that writes the given NDJSON lines to the temp outFile. */
const duckWriting = (lines: string[]) => (_sql: string, outFile: string) =>
  writeFileSync(outFile, lines.length ? lines.join("\n") + "\n" : "");
/** A DuckDB stand-in that fails the way Replit's /dev/stdout did. */
const duckThrowing = () => () => {
  throw new Error("IO Error: Cannot open file \"/dev/stdout\": No such device or address");
};
/** A DuckDB stand-in that "succeeds" but the bbox matched nothing (empty file). */
const duckEmpty = () => (_sql: string, outFile: string) => writeFileSync(outFile, "");

describe("load-fsq-city — extraction never uses /dev/stdout", () => {
  it("targets a temp file and preserves the bbox + date_closed semantics", () => {
    const sql = buildExtractSql({ selectCols: SELECT_COLS, parquet: "/data/*.parquet", bbox: BBOX, outFile: "/tmp/x/extract.ndjson" });
    assert.ok(!sql.includes("/dev/stdout"), "must not write to /dev/stdout");
    assert.ok(sql.includes("TO '/tmp/x/extract.ndjson'"), "writes to the temp file");
    assert.ok(sql.includes("FORMAT JSON, ARRAY false"));
    assert.ok(sql.includes("latitude BETWEEN 16 AND 16.15") && sql.includes("longitude BETWEEN 108.18 AND 108.32"), "bbox unchanged");
    assert.ok(sql.includes("date_closed IS NULL"), "dataset filter unchanged");
  });

  it("parseNdjson parses NDJSON, ignoring blank lines", () => {
    assert.deepEqual(parseNdjson('{"a":1}\n  \n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(parseNdjson(""), []);
  });
});

describe("load-fsq-city — DuckDB failure writes nothing to Supabase", () => {
  it("throws and performs zero Supabase writes when DuckDB fails", async () => {
    const sc = makeSc();
    await assert.rejects(
      runIngestFlow({ ...BASE, sc, runDuckDb: duckThrowing(), transform: idTransform }),
      /DuckDB extract failed/,
    );
    assert.equal(sc.calls.length, 0, "no fsq_places or fsq_city_ingests write after an extraction failure");
  });

  it("always deletes the unique temp dir — on success AND on failure", async () => {
    let okFile: string | null = null;
    await extractCityRows({ selectCols: "a", parquet: "/x", bbox: BBOX, runDuckDb: (_s: string, out: string) => { okFile = out; writeFileSync(out, '{"fsq_place_id":"1"}\n'); } });
    assert.ok(okFile && !existsSync(okFile), "temp extract file removed after success");

    let failFile: string | null = null;
    await assert.rejects(extractCityRows({ selectCols: "a", parquet: "/x", bbox: BBOX, runDuckDb: (_s: string, out: string) => { failFile = out; throw new Error("boom"); } }));
    assert.ok(failFile && !existsSync(failFile), "temp extract file removed after failure");
  });
});

describe("load-fsq-city — zero-row extraction fails closed", () => {
  it("refuses a 0-row extract and writes nothing", async () => {
    const sc = makeSc();
    await assert.rejects(
      runIngestFlow({ ...BASE, sc, runDuckDb: duckEmpty(), transform: idTransform }),
      /0 usable rows/,
    );
    assert.equal(sc.calls.length, 0, "a silent empty extract must never reach Supabase");
  });

  it("permits a 0-row ingest only with --allow-empty (diagnostic), and even then writes just the ledger", async () => {
    const sc = makeSc();
    const res = await runIngestFlow({ ...BASE, sc, runDuckDb: duckEmpty(), transform: idTransform, allowEmpty: true });
    assert.equal(res.placeCount, 0);
    assert.deepEqual(sc.calls.map((c) => c.table), ["fsq_city_ingests"], "no fsq_places batch, only the diagnostic ledger");
  });
});

describe("load-fsq-city — successful extraction parses NDJSON correctly", () => {
  it("reads the temp file and returns the parsed rows", async () => {
    const rows = await extractCityRows({
      selectCols: SELECT_COLS,
      parquet: "/x",
      bbox: BBOX,
      runDuckDb: duckWriting(['{"fsq_place_id":"1","name":"An Thuong Bar","latitude":16.044}', '{"fsq_place_id":"2","name":"My Khe Cafe","latitude":16.059}']),
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].fsq_place_id, "1");
    assert.equal(rows[1].name, "My Khe Cafe");
    assert.equal(rows[0].latitude, 16.044);
  });
});

describe("load-fsq-city — ingest ledger only after a successful upsert", () => {
  it("upserts fsq_places THEN writes the ledger on success", async () => {
    const sc = makeSc();
    const res = await runIngestFlow({
      ...BASE, sc, transform: idTransform,
      runDuckDb: duckWriting(['{"fsq_place_id":"1","name":"A","category":"bar"}', '{"fsq_place_id":"2","name":"B","category":"cafe"}']),
    });
    assert.equal(res.upserted, 2);
    assert.deepEqual(sc.calls.map((c) => c.table), ["fsq_places", "fsq_city_ingests"], "places upsert precedes the ledger");
    const ledger = sc.calls.find((c) => c.table === "fsq_city_ingests")!.rows[0];
    assert.equal(ledger.place_count, 2);
    assert.equal(ledger.city_key, "da-nang-vn");
  });

  it("does NOT write the ledger when a places batch fails", async () => {
    const sc = makeSc({ failTable: "fsq_places" });
    await assert.rejects(
      runIngestFlow({ ...BASE, sc, transform: idTransform, runDuckDb: duckWriting(['{"fsq_place_id":"1","name":"A"}']) }),
      /batch 1\/1 failed/,
    );
    assert.ok(sc.calls.some((c) => c.table === "fsq_places"), "the failing places upsert was attempted");
    assert.ok(!sc.calls.some((c) => c.table === "fsq_city_ingests"), "the ledger is NOT written after a batch failure");
  });

  it("batches at 500 and only ledgers once all batches succeed", async () => {
    const sc = makeSc();
    const many = Array.from({ length: 501 }, (_v, i) => `{"fsq_place_id":"${i}","name":"v${i}"}`);
    const res = await runIngestFlow({ ...BASE, sc, transform: idTransform, runDuckDb: duckWriting(many) });
    assert.equal(res.upserted, 501);
    const tables = sc.calls.map((c) => c.table);
    assert.deepEqual(tables, ["fsq_places", "fsq_places", "fsq_city_ingests"], "two 500-batches then one ledger write, in order");
  });
});

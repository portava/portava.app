/**
 * The capability registry — every entry is a REAL capability, not a comment.
 *
 * THE TRAP THIS CLOSES
 * ====================
 * This repository has several producers with no consumer: a readiness that is
 * computed and reported to nobody. A registry entry that declares a schema
 * requirement nobody checks on the failing path would be that mistake in a
 * new place — and it would LOOK like the fix. So every entry must satisfy,
 * mechanically:
 *
 *   1. its flag is seeded by a migration (else the gate is a wall, see
 *      flagPhantomReads.test.ts);
 *   2. every required object is declared by a migration in the tree (a typo
 *      in the registry would make the probe refuse forever);
 *   3. it names at least one consumer, and each consumer file exists, names
 *      the flag, and reaches lib/capability (directly or through a wrapper);
 *   4. the consumer is on the path that would otherwise fail silently — for
 *      Media, `recordMediaAssetDetailed` consults the guard BEFORE building
 *      its payload, which mediaCanonicalStore.test.ts proves by counting
 *      zero upserts under `refused_schema`.
 *
 * And the media wrapper must stay a rename over the generic contract, not a
 * second implementation: its column list IS the registry's, byte for byte.
 *
 * Run: node --import tsx/esm --test src/test/capabilityRegistry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, MEDIA_CANONICAL, MEDIA_CANONICAL_ASSET_COLUMNS, capabilityFor } from "../lib/capability/registry.js";
import { CANONICAL_ASSET_SCHEMA_COLUMNS } from "../lib/media/mediaSchemaCapability.js";
import { CANONICAL_ASSET_COLUMNS_ADDED_BY_2250 } from "../lib/mediaAssets.js";
import { buildCanonicalSchema, hasColumn, stripSqlComments } from "../scripts/lib/canonicalSchema.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(PKG_ROOT, "src");
const MIGRATIONS = join(SRC, "migrations");
const BASELINE = join(PKG_ROOT, "baseline", "20260819_baseline_structure.sql");

function seededFlags(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"))) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS, f), "utf8"));
    for (const m of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?feature_flags[\s\S]*?;/gi)) {
      for (const row of m[0].matchAll(/\(\s*'([A-Za-z0-9_]+)'\s*,/g)) out.add(row[1]!);
    }
  }
  return out;
}

describe("capability registry — every entry is consumed, seeded and declared", () => {
  const entries = Object.values(CAPABILITIES);

  it("has a subject (vacuity)", () => {
    assert.ok(entries.length >= 1);
    assert.equal(capabilityFor("media_canonical_enabled"), MEDIA_CANONICAL);
    assert.equal(capabilityFor("no_such_flag"), null);
  });

  it("keys equal flags, and every entry has providedBy, a note, and a non-empty requirement", () => {
    for (const [key, def] of Object.entries(CAPABILITIES)) {
      assert.equal(key, def.flag);
      assert.ok(def.providedBy.length > 0, `${key}: providedBy names the migration to apply`);
      assert.ok(def.note.length > 20, `${key}: the refusal note must say what refusing protects`);
      assert.ok(Object.keys(def.requires.tables).length + (def.requires.functions?.length ?? 0) > 0, `${key}: requires nothing — not a capability`);
    }
  });

  it("every flag is seeded by a migration", () => {
    const seeded = seededFlags();
    assert.ok(seeded.size > 150, `only ${seeded.size} seeded flags found — the scan has no subject`);
    for (const def of entries) assert.ok(seeded.has(def.flag), `${def.flag} is not seeded by any migration`);
  });

  it("every required table and column is declared by the repo's canonical schema", () => {
    const canon = buildCanonicalSchema(BASELINE, [join(PKG_ROOT, "migrations"), MIGRATIONS]);
    assert.ok(canon.columns.size > 300);
    for (const def of entries) {
      for (const [table, req] of Object.entries(def.requires.tables)) {
        assert.ok(canon.columns.has(table), `${def.flag}: ${table} is declared by no migration`);
        for (const c of req.columns) assert.ok(hasColumn(canon, table, c), `${def.flag}: ${table}.${c} is declared by no migration`);
      }
    }
  });

  it("every entry names a consumer that exists, names the flag, and reaches lib/capability", () => {
    for (const def of entries) {
      assert.ok(def.consumers.length > 0, `${def.flag}: a capability with no consumer guards nothing`);
      for (const rel of def.consumers) {
        const p = join(SRC, rel);
        assert.ok(existsSync(p), `${def.flag}: consumer ${rel} does not exist`);
        const src = readFileSync(p, "utf8");
        assert.ok(src.includes(def.flag), `${def.flag}: consumer ${rel} never names the flag`);
        assert.ok(
          /capability\/|SchemaCapability/.test(src),
          `${def.flag}: consumer ${rel} does not import lib/capability or a *SchemaCapability wrapper`,
        );
      }
    }
  });
});

describe("media: the wrapper is a rename over the contract, and the consumer is wired before the payload", () => {
  it("the three column lists are one list", () => {
    assert.deepEqual([...CANONICAL_ASSET_SCHEMA_COLUMNS], [...MEDIA_CANONICAL_ASSET_COLUMNS]);
    assert.deepEqual([...MEDIA_CANONICAL.requires.tables.media_assets!.columns], [...MEDIA_CANONICAL_ASSET_COLUMNS]);
    for (const c of CANONICAL_ASSET_COLUMNS_ADDED_BY_2250) {
      assert.ok((MEDIA_CANONICAL_ASSET_COLUMNS as readonly string[]).includes(c), `writer column ${c} is not in the requirement`);
    }
  });

  it("lib/mediaAssets.ts consults the guard before building its payload (source order)", () => {
    const src = readFileSync(join(SRC, "lib", "mediaAssets.ts"), "utf8");
    const guard = src.indexOf("await probeCanonicalAssetSchema(sc)");
    const payload = src.indexOf("captured_at: input.capturedAt");
    assert.ok(guard > 0 && payload > 0);
    assert.ok(guard < payload, "the probe must run before the 2250 columns are placed in the row");
    assert.ok(src.includes('"refused_schema"'), "the refusal is a legible outcome, not a null");
  });

  it("the wrapper carries no probe of its own — it delegates to schemaCapability", () => {
    const src = readFileSync(join(SRC, "lib", "media", "mediaSchemaCapability.ts"), "utf8");
    assert.ok(src.includes('from "../capability/schemaCapability.js"'));
    assert.ok(!src.includes('.from("media_assets")'), "a second probe implementation would drift from the first");
  });
});

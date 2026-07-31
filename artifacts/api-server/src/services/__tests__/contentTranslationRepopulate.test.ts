/**
 * contentTranslationRepopulate.test.ts
 *
 * Confirms that translateContentFields re-populates correctly after cache
 * invalidation — i.e. when no content_translations row exists (simulating the
 * state immediately after an edit clears the old entry), the function:
 *
 *   1. Detects the cache miss and calls the translation provider.
 *   2. Writes a fresh row with status = 'translated'.
 *   3. Returns translatedFields that contain the new content — not empty,
 *      not 'failed'.
 *
 * Uses node:test + fake Supabase client + SpyTranslationProvider.
 * No live database or real API key required.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/contentTranslationRepopulate.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  MockTranslationProvider,
  _setTestTranslationProvider,
  type TranslationProvider,
  type TranslateTextResult,
  type DetectLanguageResult,
} from "../../lib/translation.js";
import {
  translateContentFields,
  type ContentEntityType,
} from "../contentTranslation.js";

// ── UUID constants ─────────────────────────────────────────────────────────────

const ENTITY_ID = "aaaaaaaa-3197-0000-0000-000000000001";

// ── Spy provider ──────────────────────────────────────────────────────────────

class SpyTranslationProvider implements TranslationProvider {
  private inner = new MockTranslationProvider();
  public translateCallCount = 0;

  async detectLanguage(text: string): Promise<DetectLanguageResult> {
    return this.inner.detectLanguage(text);
  }

  async translateText(
    text: string,
    source: string,
    target: string,
  ): Promise<TranslateTextResult> {
    this.translateCallCount++;
    return this.inner.translateText(text, source, target);
  }
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface Row { [k: string]: any }
type FakeDb = Record<string, Row[]>;

function makeFakeClient(db: FakeDb) {
  function chain(tableName: string, initialRows: Row[]) {
    let filtered: Row[] = [...initialRows];
    let pendingOp: null | { type: "delete" } = null;
    const eqConditions: Array<{ col: string; val: any }> = [];

    const obj: any = {
      select()                   { return obj; },
      eq(col: string, val: any)  {
        filtered = filtered.filter((r) => r[col] === val);
        eqConditions.push({ col, val });
        return obj;
      },
      neq(col: string, val: any) { filtered = filtered.filter((r) => r[col] !== val); return obj; },
      is(col: string, val: any)  {
        filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val));
        return obj;
      },
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return obj; },
      or()      { return obj; },
      order()   { return obj; },
      limit(n: number) { filtered = filtered.slice(0, n); return obj; },
      not()     { return obj; },
      contains(){ return obj; },

      delete() { pendingOp = { type: "delete" }; return obj; },

      upsert(data: Row | Row[], _opts?: { onConflict?: string }) {
        const table = db[tableName] ?? (db[tableName] = []);
        const rows  = Array.isArray(data) ? data : [data];
        rows.forEach((r) => {
          const idx = table.findIndex(
            (row) =>
              r.entity_type      !== undefined &&
              row.entity_type    === r.entity_type &&
              row.entity_id      === r.entity_id &&
              row.target_language === r.target_language,
          );
          if (idx >= 0) Object.assign(table[idx], r);
          else table.push({ id: `fake-${tableName}-${Date.now()}`, ...r });
        });
        filtered = rows;
        pendingOp = null;
        return obj;
      },

      maybeSingle() {
        if (pendingOp) return executeOp().then((r: any) => ({ data: r.data?.[0] ?? null, error: r.error }));
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        if (pendingOp) return executeOp().then((r: any) => ({ data: r.data?.[0] ?? null, error: r.error }));
        const row = filtered[0] ?? null;
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "Not found" } });
      },
      then(resolve: any, reject: any) {
        return executeOp().then(resolve, reject);
      },
    };

    function executeOp(): Promise<{ data: Row[]; error: null }> {
      const table = db[tableName] ?? (db[tableName] = []);
      if (pendingOp?.type === "delete") {
        const toRemove = new Set(filtered.map((r) => r.id));
        db[tableName] = table.filter((r) => !toRemove.has(r.id));
        pendingOp = null;
        return Promise.resolve({ data: [], error: null });
      }
      pendingOp = null;
      return Promise.resolve({ data: filtered, error: null });
    }

    return obj;
  }

  return {
    from(tableName: string) {
      const table = db[tableName] ?? (db[tableName] = []);
      return chain(tableName, [...table]);
    },
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: "n/a" } }),
    },
  };
}

function makeDb(): FakeDb {
  return { content_translations: [] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("translateContentFields — re-populates after cache invalidation", () => {
  let spy: SpyTranslationProvider;
  let db: FakeDb;

  beforeEach(() => {
    spy = new SpyTranslationProvider();
    _setTestTranslationProvider(spy);
    db = makeDb();
    // content_translations is intentionally empty — no prior row exists,
    // exactly as it would be immediately after invalidateContentTranslations()
    // deletes the old entry on edit.
  });

  afterEach(() => {
    _setTestTranslationProvider(null);
  });

  it("calls the translation provider when no cache row exists (cache-miss after invalidation)", async () => {
    const sc = makeFakeClient(db) as any;

    assert.equal(
      db.content_translations.length,
      0,
      "pre-condition: no cache row (simulates post-invalidation state)",
    );

    await translateContentFields(sc, {
      entityType:     "post" as ContentEntityType,
      entityId:       ENTITY_ID,
      fields:         { content: "Hola mundo desde Portava" },
      sourceLanguage: "es",
      targetLanguage: "en",
    });

    assert.equal(
      spy.translateCallCount,
      1,
      "provider must be called exactly once on a cache miss",
    );
  });

  it("writes a fresh 'translated' row after the cache was cleared", async () => {
    const sc = makeFakeClient(db) as any;

    const result = await translateContentFields(sc, {
      entityType:     "post" as ContentEntityType,
      entityId:       ENTITY_ID,
      fields:         { content: "Hola mundo desde Portava" },
      sourceLanguage: "es",
      targetLanguage: "en",
    });

    // Return value must be 'translated', not 'failed' or 'skipped'.
    assert.equal(
      result.status,
      "translated",
      "result.status must be 'translated', not 'failed' or 'skipped'",
    );

    // A row must have been written to the cache.
    const written = db.content_translations.find(
      (r: Row) =>
        r.entity_type     === "post" &&
        r.entity_id       === ENTITY_ID &&
        r.target_language === "en",
    );
    assert.ok(written, "a content_translations row must be written after cache miss");
    assert.equal(
      written!.status,
      "translated",
      "the written cache row must have status = 'translated'",
    );
  });

  it("translated fields contain the new content — not empty or failed", async () => {
    const sc = makeFakeClient(db) as any;
    const newContent = "Hola mundo desde Portava";

    const result = await translateContentFields(sc, {
      entityType:     "post" as ContentEntityType,
      entityId:       ENTITY_ID,
      fields:         { content: newContent },
      sourceLanguage: "es",
      targetLanguage: "en",
    });

    // translatedFields must have the 'content' key populated.
    assert.ok(
      typeof result.translatedFields.content === "string" &&
        result.translatedFields.content.length > 0,
      "translatedFields.content must be a non-empty string",
    );

    // MockTranslationProvider prefixes with '[translated from <source>]',
    // so the result includes the original text — verify it is not a
    // verbatim copy (which would indicate a no-op / validation rejection).
    assert.notEqual(
      result.translatedFields.content,
      newContent,
      "translated content must differ from the original (not a no-op)",
    );

    // The persisted row must also carry the translated value.
    const written = db.content_translations.find(
      (r: Row) =>
        r.entity_type     === "post" &&
        r.entity_id       === ENTITY_ID &&
        r.target_language === "en",
    );
    assert.ok(written, "cache row must exist");
    assert.ok(
      written!.translated_fields?.content?.length > 0,
      "persisted translated_fields.content must be non-empty",
    );
  });

  it("re-populates all requested fields, not just the first", async () => {
    const sc = makeFakeClient(db) as any;

    const result = await translateContentFields(sc, {
      entityType:     "event" as ContentEntityType,
      entityId:       ENTITY_ID,
      fields:         { title: "Fiesta de verano", description: "Una gran celebración" },
      sourceLanguage: "es",
      targetLanguage: "en",
    });

    assert.equal(result.status, "translated");

    // Both fields must be present in the result.
    assert.ok(
      typeof result.translatedFields.title === "string" &&
        result.translatedFields.title.length > 0,
      "translatedFields.title must be populated",
    );
    assert.ok(
      typeof result.translatedFields.description === "string" &&
        result.translatedFields.description.length > 0,
      "translatedFields.description must be populated",
    );

    // Provider was called once per field (2 fields → 2 calls).
    assert.equal(spy.translateCallCount, 2, "provider must be called once per non-empty field");
  });

  it("does not land in a permanent error state — status is 'translated', not 'failed'", async () => {
    // This specifically guards against a partial-upsert or race leaving a
    // 'failed' row that would then be served as a cache hit on every future
    // request, permanently suppressing translation for that entity.
    const sc = makeFakeClient(db) as any;

    const result = await translateContentFields(sc, {
      entityType:     "trip" as ContentEntityType,
      entityId:       ENTITY_ID,
      fields:         { title: "Viaje a París", trip_notes: "Notas del viaje" },
      sourceLanguage: "es",
      targetLanguage: "fr",
    });

    assert.notEqual(
      result.status,
      "failed",
      "status must not be 'failed' when the provider succeeds — a permanent error state would block all future translations",
    );
    assert.equal(result.status, "translated");

    const written = db.content_translations.find(
      (r: Row) =>
        r.entity_type     === "trip" &&
        r.entity_id       === ENTITY_ID &&
        r.target_language === "fr",
    );
    assert.ok(written, "cache row must be written");
    assert.notEqual(
      written!.status,
      "failed",
      "persisted status must not be 'failed'",
    );
  });
});

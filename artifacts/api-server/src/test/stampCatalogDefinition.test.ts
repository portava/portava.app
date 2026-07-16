/**
 * Definition-scoped stamp catalog resolution — award-time artwork for
 * location-less stamps (badges / social / safety / trip achievements).
 *
 * Covers:
 *  A. resolveOrEnqueueForDefinition creates a "definition:{slug}" catalog
 *     entry (country Global / XX) and enqueues a generation job
 *  B. Second call reuses the existing entry and does not double-enqueue
 *  C. recalculateForUser sets catalog_id on re-created location-less rows
 *     using the definition-scoped entry
 *
 * Run: node --import tsx/esm --test src/test/stampCatalogDefinition.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveOrEnqueueForDefinition,
  _clearCatalogCache,
} from "../lib/stamps/StampCatalogService.js";
import { recalculateForUser } from "../services/passport/StampAwardEngine.js";

const ALICE_ID = "aaaaaaaa-0000-4000-8000-000000000011";
const DEF_ID   = "dddddddd-0000-4000-8000-000000000022";

// ── Minimal fake in-memory Supabase client ────────────────────────────────────

type DB = Record<string, any[]>;

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
}

function makeFakeClient(db: DB): SupabaseClient {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert: any = null;
    let _update: any = null;
    let _single = false;
    let _maybeSingle = false;

    const rows = () => (db[table] ?? []);

    const chain: any = {
      select() { return chain; },
      insert(data: any) { _insert = Array.isArray(data) ? data : [data]; return chain; },
      update(data: any) { _update = data; return chain; },
      eq(col: string, val: any) { _filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any) { _filters.push((r) => r[col] !== val); return chain; },
      is(col: string, val: any) {
        if (val === null) _filters.push((r) => r[col] == null);
        else _filters.push((r) => r[col] === val);
        return chain;
      },
      in(col: string, vals: any[]) { _filters.push((r) => vals.includes(r[col])); return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
      single() { _single = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },

      then(resolve: any) {
        return Promise.resolve().then(() => {
          if (!db[table]) db[table] = [];

          if (_insert) {
            // Unique constraint: one active queue job per catalog entry
            if (table === "stamp_generation_queue") {
              const dupe = rows().some(
                (r) => r.catalog_id === _insert[0].catalog_id && r.status === "queued",
              );
              if (dupe) return resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            }
            // Unique constraint: canonical_location_key + stamp_type
            if (table === "universal_stamp_catalog") {
              const dupe = rows().some(
                (r) =>
                  r.canonical_location_key === _insert[0].canonical_location_key &&
                  r.stamp_type === _insert[0].stamp_type,
              );
              if (dupe) return resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            }
            const inserted = _insert.map((r: any) => ({ id: nextId(), created_at: "now", updated_at: "now", ...r }));
            db[table].push(...inserted);
            const data = _single ? inserted[0] : inserted;
            return resolve({ data, error: null });
          }

          if (_update) {
            const matched = rows().filter((r) => _filters.every((f) => f(r)));
            for (const r of matched) Object.assign(r, _update);
            return resolve({ data: matched, error: null });
          }

          const matched = rows().filter((r) => _filters.every((f) => f(r)));
          if (_single || _maybeSingle) {
            return resolve({ data: matched[0] ?? null, error: null });
          }
          return resolve({ data: matched, error: null, count: matched.length });
        });
      },
    };
    return chain;
  }

  return { from: (table: string) => buildChain(table) } as unknown as SupabaseClient;
}

function freshDb(): DB {
  return {
    universal_stamp_catalog: [],
    stamp_generation_queue:  [],
    stamp_definitions: [
      {
        id: DEF_ID,
        slug: "helpful_buddy",
        name: "Helpful Buddy",
        stamp_type: "social",
        is_active: true,
        is_repeatable: false,
        visibility_default: "public",
      },
    ],
    stamp_award_events: [],
    user_stamps:        [],
  };
}

beforeEach(() => _clearCatalogCache());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("A. resolveOrEnqueueForDefinition — creates definition-scoped entry", () => {
  it("creates a definition:{slug} catalog entry and enqueues a job", async () => {
    const db = freshDb();
    const sc = makeFakeClient(db);

    const { catalogEntry, wasEnqueued } = await resolveOrEnqueueForDefinition(
      sc,
      { slug: "helpful_buddy", name: "Helpful Buddy", stamp_type: "social" },
      "user_stamp:test",
    );

    assert.equal(catalogEntry.canonical_location_key, "definition:helpful-buddy");
    assert.equal(catalogEntry.stamp_type, "social");
    assert.equal(catalogEntry.country, "Global");
    assert.equal(catalogEntry.country_code, "XX");
    assert.equal(catalogEntry.status, "pending_artwork");
    assert.equal(wasEnqueued, true);
    assert.equal(db.stamp_generation_queue.length, 1);
    assert.equal(db.stamp_generation_queue[0].catalog_id, catalogEntry.id);
  });
});

describe("B. resolveOrEnqueueForDefinition — idempotent reuse", () => {
  it("reuses the existing entry and does not double-enqueue", async () => {
    const db = freshDb();
    const sc = makeFakeClient(db);

    const first  = await resolveOrEnqueueForDefinition(sc, { slug: "helpful_buddy", name: "Helpful Buddy", stamp_type: "social" });
    const second = await resolveOrEnqueueForDefinition(sc, { slug: "helpful_buddy", name: "Helpful Buddy", stamp_type: "social" });

    assert.equal(second.catalogEntry.id, first.catalogEntry.id);
    assert.equal(db.universal_stamp_catalog.length, 1);
    assert.equal(db.stamp_generation_queue.length, 1);
    assert.equal(second.wasEnqueued, false);
  });
});

describe("C. recalculateForUser — sets catalog_id on re-created rows", () => {
  it("links the recreated location-less stamp to the definition-scoped catalog entry", async () => {
    const db = freshDb();
    // Awarded event with no matching user_stamp row (partial-failure scenario)
    db.stamp_award_events.push({
      id: nextId(),
      user_id: ALICE_ID,
      stamp_definition_id: DEF_ID,
      source_type: "system",
      source_id: null,
      status: "awarded",
      idempotency_key: `${ALICE_ID}:${DEF_ID}:system:none`,
      admin_id: null,
    });
    const sc = makeFakeClient(db);

    const result = await recalculateForUser(sc, ALICE_ID);

    assert.equal(result.awarded, 1);
    assert.equal(db.user_stamps.length, 1);
    assert.equal(db.universal_stamp_catalog.length, 1);
    assert.equal(db.user_stamps[0].catalog_id, db.universal_stamp_catalog[0].id);
    assert.equal(
      db.universal_stamp_catalog[0].canonical_location_key,
      "definition:helpful-buddy",
    );
    assert.equal(db.stamp_generation_queue.length, 1);
  });
});

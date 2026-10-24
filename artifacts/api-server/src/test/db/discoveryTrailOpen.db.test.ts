/**
 * discoveryTrailOpen.db.test.ts — census-discovery §133 (DV-78): the trail_open
 * row on real PostgreSQL, and 3923.
 *
 *   W1  the row lib/discoveryTrailOpen.ts writes satisfies every rank_events
 *       CHECK as service_role, and a retry (same token) lands nothing through
 *       2891's arbiter, exactly as the route's ON CONFLICT DO NOTHING upsert
 *   W2  no trend producer reads it: the original and 3920's canonical windows,
 *       place and area, carry no `trail/` key and no extra exposure
 *   W3  3923 re-applied is a no-op that keeps the flag's value; its rollback
 *       refuses while the flag is TRUE and, with it FALSE, removes only the row
 *
 * Controlled data on the harness only: no production claim. Rows are timed in
 * June 2033 so no other suite's rows can enter a window.
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, rows, scalar, psql, seedUser, deleteUser, jsonLiteral } from "./localDb.js";
import { trailOpenRowFor, TRAIL_OPEN_FLAG } from "../../lib/discoveryTrailOpen.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG_3923 = resolve(__dir, "../../migrations/3923_discovery_trail_open_telemetry_flag.sql");
const RB_3923 = resolve(__dir, "../../../../../db/rollback/2026-10-23-3923-discovery-trail-open-telemetry-flag-rollback.sql");
const P_NOW = "2033-06-15T00:00:00.000Z";
const AT = "2033-06-14T23:00:00.000Z";

describe("census-discovery §133 — DV-78: the trail_open row", { skip: !HAVE_DB }, () => {
  let viewer = "";
  const trailId = randomUUID();
  const CEID = randomUUID();
  /** PostgREST's insert: the columns sent, every other column its default. */
  const insert = (row: Record<string, unknown>) => {
    const cols = Object.keys(row).join(", ");
    return exec(`SET LOCAL ROLE service_role;
          WITH ins AS (INSERT INTO public.rank_events (${cols}) SELECT ${cols} FROM jsonb_populate_record(NULL::public.rank_events, ${jsonLiteral(row)})
                       ON CONFLICT (recommendation_id, outcome) DO NOTHING RETURNING 1)
          SELECT 'LANDED' || count(*) FROM ins;`, { single: true }).find((l) => l.startsWith("LANDED"));
  };

  before(() => { viewer = seedUser("trailopen"); });
  after(() => {
    exec(`DELETE FROM public.rank_events WHERE user_id = '${viewer}';`);
    deleteUser(viewer);
  });

  it("W1. the written row satisfies every CHECK, and a retry lands nothing", () => {
    const row = trailOpenRowFor(viewer, { trail_id: trailId, client_event_id: CEID }, AT);
    assert.equal(insert(row), "LANDED1");
    assert.equal(insert(row), "LANDED0", "the same open, retried: 2891's arbiter, DO NOTHING");
    assert.equal(insert(trailOpenRowFor(viewer, { trail_id: trailId, client_event_id: randomUUID() }, AT)), "LANDED1", "a new open is a new row");
    const stored = rows<Record<string, any>>(`SELECT event_type, outcome, item_id, item_kind, surface, privacy_class, retention_tier, schema_version
                                                FROM public.rank_events WHERE user_id = '${viewer}' ORDER BY id`);
    assert.equal(stored.length, 2);
    for (const r of stored) {
      assert.deepEqual(r, { event_type: "trail_open", outcome: "analytics", item_id: `trail/${trailId}`, item_kind: null, surface: "discovery",
        privacy_class: "raw_behavioral_event", retention_tier: "raw_recent", schema_version: 1 });
    }
  });

  it("W2. no trend producer reads it", () => {
    for (const fn of ["public.discovery_trend_windows_v2", "public.discovery_trend_windows_v2_canonical"]) {
      for (const level of ["place", "area"]) {
        const keys = rows<{ o_key: string | null }>(`SELECT o_key FROM ${fn}('${P_NOW}'::timestamptz, '${level}')`).map((r) => String(r.o_key));
        assert.ok(!keys.some((k) => k.startsWith("trail/")), `${fn} ${level}: ${keys.filter((k) => k.startsWith("trail/")).join(",")}`);
      }
    }
    assert.equal(scalar(`SELECT count(*) FROM public.rank_events WHERE user_id = '${viewer}' AND event_type IS NULL`), "0", "never part of the serve corpus");
  });

  it("W3. 3923 re-applied keeps the flag's value; the rollback refuses while TRUE and removes only the row", () => {
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${TRAIL_OPEN_FLAG}';`);
    try {
      const r = psql(readFileSync(MIG_3923, "utf8"));
      assert.equal(r.status, 0, r.stderr);
      assert.equal(scalar(`SELECT enabled FROM public.feature_flags WHERE flag = '${TRAIL_OPEN_FLAG}'`), "t");
      const refused = psql(readFileSync(RB_3923, "utf8"));
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /ROLLBACK REFUSED \(3923\)/);
      const body = readFileSync(RB_3923, "utf8").replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, "");
      const flagsBefore = scalar(`SELECT count(*) FROM public.feature_flags`);
      const out = exec(`BEGIN;\nUPDATE public.feature_flags SET enabled = false WHERE flag = '${TRAIL_OPEN_FLAG}';\n${body}\nSELECT 'FLAGS' || count(*) FROM public.feature_flags;\nROLLBACK;`);
      assert.ok(out.includes(`FLAGS${Number(flagsBefore) - 1}`), out.join("|"));
    } finally {
      exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${TRAIL_OPEN_FLAG}';`);
    }
  });
});

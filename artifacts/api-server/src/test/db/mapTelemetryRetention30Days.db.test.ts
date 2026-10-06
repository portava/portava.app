/**
 * mapTelemetryRetention30Days — migration 3701 against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/mapTelemetryRetention30Days.db.test.ts
 *      Skips without a database, like every src/test/db suite.
 *
 * The owner's Q11(a) ruling (docs/ops/owner-decisions-20261004.md): raw
 * behavioural rows are kept 30 days, then deleted. 2202 stamped per-user map
 * telemetry with a 90-day expiry; 3701 makes it 30, shortens any row already
 * stamped later, and leaves the existing 2960 sweep to delete on expires_at.
 *
 *   MT-1  a row written with the default expires 30 days after receipt (not 90),
 *         on both tables.
 *   MT-2  re-applying 3701 shortens a 90-day row to received_at + 30 days and
 *         leaves a row that already expires sooner exactly as it was.
 *   MT-3  under the rollback the default is 90 days again (the counter-proof);
 *         3701 re-applied restores 30.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, scalar } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3701_map_telemetry_retention_30_days.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-06-3701-map-telemetry-retention-30-days-rollback.sql");

const VIEWER = randomUUID();
const SESSION = `mt3701-${VIEWER.slice(0, 8)}`;
const days = (sql: string) => Number(scalar(sql));

describe("3701: per-user map telemetry is kept 30 days", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(() => {
    exec(`DELETE FROM public.map_telemetry_events WHERE map_session_id = '${SESSION}';
          DELETE FROM public.map_telemetry_drops WHERE map_session_id = '${SESSION}';`);
  });
  after(() => {
    exec(`DELETE FROM public.map_telemetry_events WHERE map_session_id = '${SESSION}';
          DELETE FROM public.map_telemetry_drops WHERE map_session_id = '${SESSION}';`);
  });

  it("MT-1 — a row written with the default expires 30 days after receipt, on both tables", () => {
    exec(`INSERT INTO public.map_telemetry_events (viewer_id, event_name, map_session_id, client_ts)
            VALUES ('${VIEWER}', 'map_opened', '${SESSION}', now());
          INSERT INTO public.map_telemetry_drops (viewer_id, map_session_id) VALUES ('${VIEWER}', '${SESSION}');`);
    assert.equal(days(`SELECT round(extract(epoch FROM (expires_at - received_at)) / 86400) FROM public.map_telemetry_events WHERE map_session_id = '${SESSION}' LIMIT 1`), 30);
    assert.equal(days(`SELECT round(extract(epoch FROM (expires_at - received_at)) / 86400) FROM public.map_telemetry_drops WHERE map_session_id = '${SESSION}' LIMIT 1`), 30);
  });

  it("MT-2 — re-applying 3701 shortens a 90-day row and leaves a sooner one as it was", () => {
    exec(`INSERT INTO public.map_telemetry_events (viewer_id, event_name, map_session_id, client_ts, received_at, expires_at)
            VALUES ('${VIEWER}', 'zone_selected', '${SESSION}', now(), now() - interval '1 day', now() + interval '89 days'),
                   ('${VIEWER}', 'place_opened',  '${SESSION}', now(), now() - interval '1 day', now() + interval '5 days');`);
    const r = psql(readFileSync(MIGRATION, "utf8"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(days(`SELECT round(extract(epoch FROM (expires_at - received_at)) / 86400) FROM public.map_telemetry_events WHERE map_session_id = '${SESSION}' AND event_name = 'zone_selected'`), 30);
    assert.equal(days(`SELECT round(extract(epoch FROM (expires_at - now())) / 86400) FROM public.map_telemetry_events WHERE map_session_id = '${SESSION}' AND event_name = 'place_opened'`), 5);
  });

  it("MT-3 — under the rollback the default is 90 days again; 3701 re-applied restores 30", () => {
    const rb = psql(readFileSync(ROLLBACK, "utf8"));
    assert.equal(rb.status, 0, rb.stderr);
    try {
      assert.match(String(scalar(`SELECT column_default FROM information_schema.columns WHERE table_name = 'map_telemetry_events' AND column_name = 'expires_at'`)), /90 days/);
    } finally {
      const re = psql(readFileSync(MIGRATION, "utf8"));
      assert.equal(re.status, 0, re.stderr);
    }
    assert.match(String(scalar(`SELECT column_default FROM information_schema.columns WHERE table_name = 'map_telemetry_events' AND column_name = 'expires_at'`)), /30 days/);
  });
});

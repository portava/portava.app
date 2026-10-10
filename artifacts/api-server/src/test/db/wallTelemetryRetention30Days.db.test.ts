/**
 * wallTelemetryRetention30Days — migration 3702 against real PostgreSQL.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/wallTelemetryRetention30Days.db.test.ts
 *      Skips without a database, like every src/test/db suite.
 *
 * OD-INPUT-2 (Q11(a) the analogue): per-user behavioural rows are kept 30 days, then deleted. 2308 stamped
 * wall_telemetry_events with a 90-day expiry that nothing enforced; 3702 makes
 * the default 30 days and shortens rows stamped later; the delete is
 * lib/wallTelemetryRetention.ts (unit-tested in intelRetentionScheduler.test.ts).
 *
 *   WT-1  a row written with the default expires 30 days after the event.
 *   WT-2  re-applying 3702 shortens a 90-day row and leaves a sooner one as it was.
 *   WT-3  the sweep's own predicate, run as service_role, deletes exactly the
 *         rows whose expiry has passed; a client role cannot delete at all.
 *   WT-4  under the rollback the default is 90 days again; 3702 re-applied
 *         restores 30.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser } from "./localDb.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3702_wall_telemetry_retention_30_days.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-10-06-3702-wall-telemetry-retention-30-days-rollback.sql");

let VIEWER = "";
const days = (sql: string) => Number(scalar(sql));
const ageOf = (name: string) =>
  days(`SELECT round(extract(epoch FROM (expires_at - occurred_at)) / 86400) FROM public.wall_telemetry_events WHERE viewer_id = '${VIEWER}' AND event_name = '${name}' LIMIT 1`);

describe("3702: Wall telemetry is kept 30 days", { skip: !HAVE_DB && "no LOCAL_DB_URL" }, () => {
  before(() => { VIEWER = seedUser("wt3702"); });
  after(() => {
    if (!VIEWER) return;
    exec(`DELETE FROM public.wall_telemetry_events WHERE viewer_id = '${VIEWER}';`);
    deleteUser(VIEWER);
  });

  it("WT-1 — a row written with the default expires 30 days after the event", () => {
    exec(`INSERT INTO public.wall_telemetry_events (viewer_id, event_name) VALUES ('${VIEWER}', 'wall_feed_open');`);
    assert.equal(ageOf("wall_feed_open"), 30);
  });

  it("WT-2 — re-applying 3702 shortens a 90-day row and leaves a sooner one as it was", () => {
    exec(`INSERT INTO public.wall_telemetry_events (viewer_id, event_name, occurred_at, expires_at)
            VALUES ('${VIEWER}', 'wall_mode_select', now() - interval '1 day', now() + interval '89 days'),
                   ('${VIEWER}', 'wall_impression',  now() - interval '1 day', now() + interval '5 days');`);
    const r = psql(readFileSync(MIGRATION, "utf8"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ageOf("wall_mode_select"), 30);
    assert.equal(days(`SELECT round(extract(epoch FROM (expires_at - now())) / 86400) FROM public.wall_telemetry_events WHERE viewer_id = '${VIEWER}' AND event_name = 'wall_impression'`), 5);
  });

  it("WT-3 — the sweep's predicate deletes exactly the expired rows as service_role; a client role cannot delete", () => {
    exec(`INSERT INTO public.wall_telemetry_events (viewer_id, event_name, occurred_at, expires_at)
            VALUES ('${VIEWER}', 'wall_action', now() - interval '31 days', now() - interval '1 day');`);
    const r = psql(`SET LOCAL ROLE service_role;\nDELETE FROM public.wall_telemetry_events WHERE viewer_id = '${VIEWER}' AND expires_at <= now();`, { single: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(scalar(`SELECT count(*) FROM public.wall_telemetry_events WHERE viewer_id = '${VIEWER}' AND event_name = 'wall_action'`), "0", "the expired row survived the sweep's delete");
    assert.equal(scalar(`SELECT count(*) FROM public.wall_telemetry_events WHERE viewer_id = '${VIEWER}' AND event_name = 'wall_feed_open'`), "1", "an unexpired row was deleted");
    const client = psql(`SET LOCAL ROLE authenticated;\nDELETE FROM public.wall_telemetry_events WHERE viewer_id = '${VIEWER}';`, { single: true });
    assert.notEqual(client.status, 0, "a client role deleted wall telemetry");
    assert.match(client.stderr, /permission denied/);
  });

  it("WT-4 — under the rollback the default is 90 days again; 3702 re-applied restores 30", () => {
    const rb = psql(readFileSync(ROLLBACK, "utf8"));
    assert.equal(rb.status, 0, rb.stderr);
    try {
      assert.match(String(scalar(`SELECT column_default FROM information_schema.columns WHERE table_name = 'wall_telemetry_events' AND column_name = 'expires_at'`)), /90 days/);
    } finally {
      const re = psql(readFileSync(MIGRATION, "utf8"));
      assert.equal(re.status, 0, re.stderr);
    }
    assert.match(String(scalar(`SELECT column_default FROM information_schema.columns WHERE table_name = 'wall_telemetry_events' AND column_name = 'expires_at'`)), /30 days/);
  });
});

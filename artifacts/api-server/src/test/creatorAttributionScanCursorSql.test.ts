import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { postconditionBlocks } from "../scripts/lib/migrationSqlBlocks.js";

const migrationUrl = new URL("../migrations/3989_creator_attribution_scan_cursor.sql", import.meta.url);
const bookingId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

test("3989 only adds private cursor state, not flags, attribution rules, retention or payment writes", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /ALTER TABLE public\.creator_attribution_scan_cursors ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /GRANT UPDATE \(after_booking_id, cycle_upper_id, revision\)/);
  assert.match(sql, /ON CONFLICT \(producer\) DO NOTHING/);
  assert.doesNotMatch(sql, /feature_flags|creator_rule_versions|creator_earning|rent_buddy_earning|DELETE FROM|SECURITY DEFINER|CREATE POLICY/i);
  assert.deepEqual([...new Set([...sql.matchAll(/public\.([a-z_]+)/g)].map((match) => match[1]))], ["creator_attribution_scan_cursors"]);
  const checks = postconditionBlocks(sql);
  assert.equal(checks.length, 1, "the repository certifier recognizes the assertion-only postcondition");
  assert.ok(sql.indexOf(checks[0]!.text) < sql.indexOf("COMMIT;"), "postconditions run before commit");
});

test("3989 executes with private grants, compare-and-set and durable circular scan state", { skip: !process.env.DISCOVERY_PGLITE_MODULE }, async (context) => {
  const { PGlite } = await import(process.env.DISCOVERY_PGLITE_MODULE!);
  const directory = await mkdtemp(join(tmpdir(), "creator-cursor-3989-"));
  let database = new PGlite(directory);
  const migration = await readFile(migrationUrl, "utf8");
  const readCursor = async () => (await database.query("SELECT * FROM public.creator_attribution_scan_cursors WHERE producer='travel_partner'")).rows[0];
  const checkpoint = (afterBookingId: string | null, cycleUpperId: string | null, expectedRevision: string, revision = randomUUID()) => database.query(
    "UPDATE public.creator_attribution_scan_cursors SET after_booking_id=$1, cycle_upper_id=$2, revision=$3 WHERE producer='travel_partner' AND revision=$4 RETURNING *",
    [afterBookingId, cycleUpperId, revision, expectedRevision],
  );
  const page = (afterBookingId: string | null, cycleUpperId: string, limit: number) => afterBookingId === null
    ? database.query("SELECT id FROM public.rent_buddy_bookings WHERE status='completed' AND id <= $1 ORDER BY id LIMIT $2", [cycleUpperId, limit])
    : database.query("SELECT id FROM public.rent_buddy_bookings WHERE status='completed' AND id > $1 AND id <= $2 ORDER BY id LIMIT $3", [afterBookingId, cycleUpperId, limit]);
  try {
    await database.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    `);
    await database.exec(migration);
    await context.test("transactional postconditions reject schema, seed, RLS and privilege drift", async () => {
      const checks = postconditionBlocks(migration)[0]!.text;
      const changes = [
        "ALTER TABLE public.creator_attribution_scan_cursors ADD COLUMN unexpected text",
        "ALTER TABLE public.creator_attribution_scan_cursors DROP CONSTRAINT creator_attribution_scan_cursor_bounds",
        "DELETE FROM public.creator_attribution_scan_cursors",
        "ALTER TABLE public.creator_attribution_scan_cursors DISABLE ROW LEVEL SECURITY",
        "REVOKE SELECT ON public.creator_attribution_scan_cursors FROM service_role",
        "REVOKE UPDATE (revision) ON public.creator_attribution_scan_cursors FROM service_role",
        "REVOKE UPDATE (cycle_upper_id) ON public.creator_attribution_scan_cursors FROM service_role",
        "GRANT UPDATE (producer) ON public.creator_attribution_scan_cursors TO service_role",
        "GRANT DELETE ON public.creator_attribution_scan_cursors TO service_role",
        "GRANT SELECT ON public.creator_attribution_scan_cursors TO PUBLIC",
        "GRANT SELECT (revision) ON public.creator_attribution_scan_cursors TO anon",
        "GRANT UPDATE (revision) ON public.creator_attribution_scan_cursors TO authenticated",
      ];
      for (const change of changes) {
        await database.exec("BEGIN");
        try {
          await database.exec(change);
          await assert.rejects(database.exec(checks), /3989:/, change);
        } finally {
          await database.exec("ROLLBACK");
        }
      }
      await database.exec(checks);
    });
    await context.test("seed is a single nullable position with RLS and no FK or client policy", async () => {
      const seed = await readCursor();
      assert.equal(seed.producer, "travel_partner");
      assert.equal(seed.after_booking_id, null);
      assert.equal(seed.cycle_upper_id, null);
      assert.match(seed.revision, /^[a-f0-9-]{36}$/);
      const catalog = (await database.query(`SELECT relrowsecurity FROM pg_class WHERE oid='public.creator_attribution_scan_cursors'::regclass`)).rows[0];
      assert.equal(catalog.relrowsecurity, true);
      assert.equal((await database.query("SELECT * FROM pg_policy WHERE polrelid='public.creator_attribution_scan_cursors'::regclass")).rows.length, 0);
      assert.equal((await database.query("SELECT * FROM pg_constraint WHERE conrelid='public.creator_attribution_scan_cursors'::regclass AND contype='f'")).rows.length, 0);
      await assert.rejects(database.query("INSERT INTO public.creator_attribution_scan_cursors (producer) VALUES ('local_expert')"), { code: "23514" });
    });

    await context.test("anon and authenticated cannot read or write even with permissive default grants", async () => {
      for (const role of ["anon", "authenticated"]) {
        await database.exec(`SET ROLE ${role}`);
        await assert.rejects(readCursor(), { code: "42501" });
        await assert.rejects(database.query("UPDATE public.creator_attribution_scan_cursors SET after_booking_id=NULL"), { code: "42501" });
        await assert.rejects(database.query("INSERT INTO public.creator_attribution_scan_cursors (producer) VALUES ('travel_partner')"), { code: "42501" });
        await database.exec("RESET ROLE");
      }
    });

    await context.test("service role atomically checkpoints position, bound and revision; invalid bounds and excess writes are refused", async () => {
      await database.exec("SET ROLE service_role");
      const seed = await readCursor();
      await assert.rejects(checkpoint(bookingId(1), null, seed.revision), { code: "23514" });
      await assert.rejects(checkpoint(bookingId(2), bookingId(1), seed.revision), { code: "23514" });
      const started = (await checkpoint(null, bookingId(5_503), seed.revision)).rows[0];
      assert.equal(started.after_booking_id, null);
      assert.equal(started.cycle_upper_id, bookingId(5_503));
      assert.equal((await checkpoint(null, bookingId(9_000), seed.revision)).rows.length, 0, "stale claim cannot widen a cycle");
      const saved = await checkpoint(bookingId(5_000), started.cycle_upper_id, started.revision);
      assert.equal(saved.rows.length, 1);
      assert.equal(saved.rows[0].after_booking_id, bookingId(5_000));
      assert.equal(saved.rows[0].cycle_upper_id, bookingId(5_503));
      await assert.rejects(database.query("DELETE FROM public.creator_attribution_scan_cursors"), { code: "42501" });
      await assert.rejects(database.query("UPDATE public.creator_attribution_scan_cursors SET producer='travel_partner'"), { code: "42501" });
      await assert.rejects(database.query("INSERT INTO public.creator_attribution_scan_cursors (producer) VALUES ('travel_partner')"), { code: "42501" });
      assert.equal((await checkpoint(null, null, seed.revision)).rows.length, 0);
      assert.deepEqual(await readCursor(), saved.rows[0]);
      await database.exec("RESET ROLE");
    });

    await context.test("migration replay and a closed/reopened database preserve the same position, bound and revision", async () => {
      const before = await readCursor();
      assert.equal(before.cycle_upper_id, bookingId(5_503));
      await database.exec(migration);
      assert.deepEqual(await readCursor(), before);
      await database.close();
      database = new PGlite(directory);
      await database.exec("SET ROLE service_role");
      assert.deepEqual(await readCursor(), before);
      await database.exec("RESET ROLE");
    });

    await context.test("higher UUID arrivals cannot extend a persisted PostgreSQL sweep or exclude lower-ID late completions next cycle", async () => {
      await database.exec(`
        CREATE TABLE public.rent_buddy_bookings (id uuid PRIMARY KEY, status text NOT NULL);
        INSERT INTO public.rent_buddy_bookings
          SELECT ('00000000-0000-4000-8000-' || lpad(sequence::text,12,'0'))::uuid,
                 CASE WHEN sequence=1 THEN 'pending' ELSE 'completed' END
          FROM generate_series(1,5503) sequence;
        SET ROLE service_role;
      `);
      const before = await readCursor();
      await database.exec(`INSERT INTO public.rent_buddy_bookings
        SELECT ('00000000-0000-4000-8000-' || lpad(sequence::text,12,'0'))::uuid, 'completed'
        FROM generate_series(5504,6503) sequence;`);
      const tail = await page(before.after_booking_id, before.cycle_upper_id, 500);
      assert.equal(tail.rows.length, 500);
      assert.equal(tail.rows[0].id, bookingId(5_001));
      const saved = (await checkpoint(tail.rows[499].id, before.cycle_upper_id, before.revision)).rows[0];
      assert.deepEqual((await page(saved.after_booking_id, saved.cycle_upper_id, 500)).rows.map((row: any) => row.id), [bookingId(5_501), bookingId(5_502), bookingId(5_503)]);
      const terminal = (await checkpoint(bookingId(5_503), saved.cycle_upper_id, saved.revision)).rows[0];
      await database.exec(`INSERT INTO public.rent_buddy_bookings
        SELECT ('00000000-0000-4000-8000-' || lpad(sequence::text,12,'0'))::uuid, 'completed'
        FROM generate_series(6504,7503) sequence;`);
      assert.deepEqual((await page(terminal.after_booking_id, terminal.cycle_upper_id, 500)).rows, []);
      await database.query("UPDATE public.rent_buddy_bookings SET status='completed' WHERE id=$1", [bookingId(1)]);
      const wrapped = (await checkpoint(null, null, terminal.revision)).rows[0];
      assert.equal(wrapped.after_booking_id, null);
      assert.equal(wrapped.cycle_upper_id, null);
      const upper = (await database.query("SELECT id FROM public.rent_buddy_bookings WHERE status='completed' ORDER BY id DESC LIMIT 1")).rows[0].id;
      const nextCycle = (await checkpoint(null, upper, wrapped.revision)).rows[0];
      assert.equal(nextCycle.cycle_upper_id, bookingId(7_503));
      assert.equal((await page(nextCycle.after_booking_id, nextCycle.cycle_upper_id, 500)).rows[0].id, bookingId(1));
      assert.equal((await checkpoint(bookingId(5_503), bookingId(9_000), terminal.revision)).rows.length, 0, "stale worker cannot replace a newer cycle");
      assert.deepEqual(await readCursor(), nextCycle);
    });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

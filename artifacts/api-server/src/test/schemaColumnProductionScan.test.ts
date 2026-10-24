/**
 * Every table, column and stored function production code names through
 * PostgREST exists in PRODUCTION — or is ledgered, with the reason it cannot
 * run there or the defect it is.
 *
 * Run: node --import tsx/esm --test src/test/schemaColumnProductionScan.test.ts
 *
 * WHY (2026-10-17, wave 5). The embed scan (selectEmbedForeignKeyScan.test.ts)
 * found eight reads production refused because no key backed a join. The next
 * class is a NAME production does not have. PostgREST fails the WHOLE statement
 * on one (42703/PGRST204 column, 42P01/PGRST205 table, PGRST202 function), and
 * most callers here read `{ data }` without `error`, so the failure arrives as an
 * empty list, a zero or a silent no-op. helpers/schemaColumnScan.ts reads every
 * select list (with its embeds' columns), filter column, write key, onConflict
 * column, `.from()` table and `.rpc()` name under src/ through the embed scan's
 * resolver, and grades each against the frozen PRODUCTION capture
 * (lib/capability/snapshots/current.ts) plus anything recorded applied after it,
 * plus the names a dated read-only catalog check OBSERVED in production after
 * the capture (fixtures/productionCatalogObservations.json):
 *   A        declared by no SQL anywhere in the repository — fails everywhere;
 *   dropped  declared only by the 2026-08-19 baseline or a migration production
 *            is recorded as having, and absent from production — fails there;
 *   B        declared only by SQL production has not applied — fails in
 *            production unless the path cannot run there.
 *
 * `check:schema-references` (static, canonical schema) and
 * `check:write-path-columns` (live) are not duplicated: neither can see a name
 * that only an UNAPPLIED migration declares (canonical says it exists), a
 * filter column, an embed's columns, a table name, an `.rpc()` name, or a
 * select resolved across files. This file asks those questions of production.
 *
 * WHAT THIS FAILS ON
 *   1. a NEW A / dropped name (not on KNOWN_DEAD_NAMES) — fix the name;
 *   2. a NEW B name (not on UNAPPLIED_SCHEMA_READS) — decide whether its path is
 *      gated in production (a flag that is FALSE there, a capability probe that
 *      fails closed, a schema marker) and ledger it with that gate, or it is a
 *      live defect: fix it (apply the migration, or make the path fail closed);
 *   3. more UNGATED names than UNGATED_CEILING (the live-defect count only shrinks);
 *   4. a ledger entry the scan no longer finds (every ledger is SHRINK-ONLY);
 *   5. a file whose unresolvable sites exceed UNRESOLVED_REFERENCE_CEILING;
 *   6. the scan missing any kind of planted name, or flagging a control.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanSchemaReferences, productionMismatches, productionSchema, provenance, mismatchKey,
  bareColumn, logicTreeColumns, selectListColumns, declarationsIn, catalogObservations, splitName, recordedAppliedMigrations,
  type SchemaRefScan, type Mismatch,
} from "./helpers/schemaColumnScan.js";
import { scanSelectEmbeds } from "./helpers/selectEmbedScan.js";

// ── Ledgers ──────────────────────────────────────────────────────────────────

/** `object name` as the scan reports it: `column t.c`, `table t`, `function f`. */
type Name = string;

/**
 * Class A and dropped names, per file: each is a query that fails in
 * production today (and, for A, everywhere). SHRINK-ONLY, and EXACT per file:
 * a new dead name in a listed file fails, and so does a fixed one left listed.
 * EMPTY since wave 5's follow-up (2026-10-17). Five were found; all are fixed:
 *   routes/adminCompass.ts   compass_abuse_flags.created_at → detected_at (9894cfa75)
 *   routes/tags.ts           trips(name, destination) → title, destination_city (9894cfa75)
 *   lib/fsq/fsqPlaces.ts     ten columns fsq_places never had → only its 0184 columns
 *                            (fsqPlacesProductionColumns.test.ts)
 *   routes/reviews.ts        rent_buddy_bookings.buddy_user_id → booking.buddy_id, then
 *                            rent_buddy_profiles.user_id (reviewsRentBuddyBookingEligibility.test.ts)
 *   lib/places/placeCollectionsWorker.ts  places.post_count → active posts counted from
 *                            posts (placeCollectionsStaleSweep.test.ts)
 * A new entry carries the catalog query that settles it.
 */
const KNOWN_DEAD_NAMES: ReadonlyArray<{ file: string; names: Name[]; finding: string }> = [];

/**
 * What a class-B statement does in production, judged from the code on
 * 2026-10-17 (wave 5) against production's flag values in the 2026-09-22
 * capture (a flag absent there reads OFF through lib/featureFlags.ts):
 *   gated       — every path to it is behind a flag that is FALSE/absent in
 *                 production, a schema/capability probe that fails closed, or a
 *                 schema marker: it is never sent there;
 *   unreachable — nothing production runs calls it (scripts, test-only code);
 *   masked      — reachable, but an earlier statement on the same path that names
 *                 another unapplied object always fails first, so it is never
 *                 sent TODAY (it becomes live if migrations are applied piecemeal);
 *   fail-soft   — it is sent and fails, and the code detects the absence and
 *                 still gives the correct answer (a probe, a legacy retry, an
 *                 empty answer that is exact because nothing can exist);
 *   UNGATED     — it is sent, fails, and the user or operator gets an error, a
 *                 wrong answer, a lost write or a false alarm: a LIVE DEFECT.
 */
type Verdict = "gated" | "unreachable" | "masked" | "fail-soft" | "UNGATED";

/**
 * Class B names, per file and verdict: declared only by SQL production has not
 * applied. SHRINK-ONLY and EXACT: every name the scan finds in a file is on
 * exactly one entry, and every listed name is still found. Kept as data
 * (fixtures/unappliedSchemaReads.json, one entry per line, each with its
 * finding: the lines, the gate or the outcome with file:line, and the reviewer's
 * confidence) because it is ~290 entries over ~180 files.
 *
 * 2026-10-17 correction: six entries came OUT because their names are in
 * production. The lead's read-only catalog check found `stories.deleted_at`,
 * `story_purge_queue` and `job_health.last_success_at` present; 2998 was
 * applied by hand after the 2026-09-22 capture (production's ledger has a
 * `manual` row whose checksum is the file's bytes) and was never recorded. So
 * lib/mediaAccess.ts's owner read, routes/storyArchive.ts and
 * services/stories/storyRetention.ts were NOT live defects (three UNGATED names),
 * and the two schedulers' job_health reads were not fail-soft but working.
 */
const UNAPPLIED_SCHEMA_READS: ReadonlyArray<{ file: string; names: Name[]; verdict: Verdict; why: string }> =
  JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/unappliedSchemaReads.json"), "utf8"));

/**
 * The live-defect count (UNGATED names). It may only go down. 81 at 9894cfa75;
 * 78 after the 2026-10-17 catalog observation (the three story reads above); 76
 * once both 3601 reads answer a stated 503 (rentBuddyFeeScheduleNotDeployed.test.ts).
 */
const UNGATED_CEILING = 1; // 76 -> 1 at the 2026-10-24 capability refresh: 75 UNGATED names are now in production (shrink-only)

/**
 * Sites the scan cannot resolve (a non-static table, column, list, body or
 * function name), per file, counted by line. A new one is a blind spot: make it
 * static, or raise its count here with a reason. Inspected 2026-10-17: schema
 * probes and drift checks that take the table as data, counter helpers keyed
 * by a spec, seed scripts, write bodies assembled row by row, and Telegraph
 * column lists forwarded through two helper hops.
 */
const UNRESOLVED_REFERENCE_CEILING: Readonly<Record<string, number>> = {
  "src/compass/CompassGraphEngine.ts": 1,
  "src/lib/canonicalLocations.ts": 1,
  "src/lib/capability/schemaCapability.ts": 1,
  "src/lib/contentOwner.ts": 1,
  "src/lib/discoveryCacheCleanup.ts": 1,
  "src/lib/feedReads.ts": 4,
  "src/lib/inputAssistance/duplicateDetection.ts": 1,
  "src/lib/inputAssistance/inputConsent.ts": 1,
  "src/lib/inputAssistance/telemetry.ts": 1,
  "src/lib/intelProjection.ts": 2,
  "src/lib/media/jobs/queue.ts": 1,
  "src/lib/mediaAssets.ts": 1,
  "src/lib/memoryCommandBus.ts": 1,
  "src/lib/moderationReportSnapshots.ts": 2,
  "src/lib/postCounters.ts": 2,
  "src/lib/rentBuddyLaunchControls.ts": 1,
  "src/lib/schemaDriftCheck.ts": 2,
  "src/lib/sensingAnonStore.ts": 1,
  "src/lib/sensingDifferencingGate.ts": 1,
  "src/lib/stamps/criteria/metrics.ts": 1,
  "src/lib/stamps/generationWorker.ts": 1,
  "src/lib/stamps/xxCatalogRepair.ts": 3,
  "src/lib/visuals/service.ts": 1,
  "src/routes/admin.ts": 2,
  "src/routes/adminFeatured.ts": 2,
  "src/routes/availability.ts": 1,
  "src/routes/compass.ts": 4,
  "src/routes/highlights.ts": 3,
  "src/routes/mapTelemetry.ts": 1,
  "src/routes/meetups.ts": 2,
  "src/routes/messaging.ts": 2,
  "src/routes/rankEvents.ts": 2,
  "src/routes/rentABuddy.ts": 3,
  "src/routes/telegraphChat.ts": 1,
  "src/routes/tripDecisions.ts": 2,
  "src/routes/tripReservations.ts": 1,
  "src/routes/wallTelemetry.ts": 1,
  "src/scripts/seed-demo-buddies.ts": 4,
  "src/scripts/seed-demo-city-events.ts": 1,
  "src/scripts/seed-demo-profile.ts": 3,
  "src/scripts/seed-demo-social.ts": 4,
  "src/services/accountDeletion/AccountDeletionService.ts": 1,
  "src/services/accountDeletion/DeletionDryRun.ts": 1,
  "src/services/accountDeletion/accountMediaDeletion.ts": 4,
  "src/services/highlights/highlightSchemaAvailability.ts": 1,
  "src/services/ledger/CanonicalShareReader.ts": 1,
  "src/services/media/MediaCleanupTransport.ts": 1,
  "src/services/media/MyWorldMemoryService.ts": 1,
  "src/services/memory/memoryEvidenceErasure.ts": 1,
  "src/services/telegraph/conversationSnapshots.ts": 1,
  "src/services/telegraph/inboxReads.ts": 1,
  "src/services/telegraph/proximityObservationBudget.ts": 1,
  "src/services/trails/TrailService.ts": 2,
};

// ── The scan, on the codebase ────────────────────────────────────────────────

let scan: SchemaRefScan;
let mismatches: Mismatch[];
before(() => {
  scan = scanSchemaReferences();
  mismatches = productionMismatches(scan);
});

/** `file → Set<name>` for one or more classes. */
function byFile(classes: ReadonlyArray<Mismatch["class"]>): Map<string, Set<Name>> {
  const out = new Map<string, Set<Name>>();
  for (const m of mismatches) {
    if (!classes.includes(m.class)) continue;
    for (const s of m.sites) {
      const set = out.get(s.file) ?? new Set<Name>();
      set.add(`${m.object} ${m.name}`);
      out.set(s.file, set);
    }
  }
  return out;
}

function sitesOf(file: string, name: Name): string {
  const m = mismatches.find((x) => `${x.object} ${x.name}` === name);
  const lines = [...new Set((m?.sites ?? []).filter((s) => s.file === file).map((s) => `:${s.line}${s.via ? ` (via ${s.via})` : ""} ${s.kind}/${s.method}`))];
  return `${lines.join(", ")}${m?.declaredBy.length ? ` — declared only by ${m.declaredBy.join(", ")}` : ""}`;
}

describe("the scan reached the codebase and production (not vacuous)", () => {
  it("resolves thousands of selects, filters and writes, and every rpc it can", () => {
    assert.ok(scan.sites.select > 4000, `selects: ${scan.sites.select}`);
    assert.ok(scan.sites.filter > 4000, `filters: ${scan.sites.filter}`);
    assert.ok(scan.sites.write > 1000, `writes: ${scan.sites.write}`);
    assert.ok(scan.sites.rpc > 100, `rpcs: ${scan.sites.rpc}`);
    assert.ok(scan.refs.length > 30000, `refs: ${scan.refs.length}`);
  });

  it("reads known-good names as good (a control on each kind)", () => {
    const has = (file: string, kind: string, table: string | null, name: string) =>
      scan.refs.some((r) => r.file === file && r.kind === kind && r.table === table && r.name === name);
    assert.ok(has("src/routes/follows.ts", "table", "user_follows", "user_follows"), "a table");
    assert.ok(has("src/routes/adminCompass.ts", "filter", "compass_abuse_flags", "detected_at"), "the fixed filter column");
    assert.ok(has("src/routes/tags.ts", "embed", "trips", "title"), "the fixed embed column, on the embed's table");
    assert.ok(has("src/lib/stampHelper.ts", "rpc", null, "upsert_city_stamp"), "an rpc");
    assert.ok(scan.refs.some((r) => r.kind === "write" && r.table === "messages" && r.name === "thread_id"), "a write key");
    const graded = new Set(mismatches.flatMap((m) => m.sites.map((s) => `${s.file}:${s.table}:${s.name}`)));
    assert.ok(!graded.has("src/routes/adminCompass.ts:compass_abuse_flags:detected_at"));
  });

  it("grades against the capture current.ts names, with the DDL of anything recorded applied after it", () => {
    const prod = productionSchema();
    assert.ok(prod.tables.size > 450 && prod.functions.size > 100, `${prod.tables.size} tables, ${prod.functions.size} functions`);
    assert.ok(prod.tables.get("trips")?.has("title") && !prod.tables.get("trips")?.has("name"));
    const prov = provenance();
    assert.ok(prov.columns.get("compass_abuse_flags.detected_at")?.includes("baseline/20260819_baseline_structure.sql"), "the baseline is read");
    assert.ok((prov.columns.get("messages.client_message_id") ?? []).some((f) => f.includes("2810_telegraph_message_kernel")), "migrations are read");
    assert.ok((prov.functions.get("count_content_stamps_received") ?? []).some((f) => f.startsWith("supabase/migrations/")), "frozen roots are read");
  });
});

describe("dated catalog observations: names production HAS that the capture predates", () => {
  const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("each observation carries its evidence, and every name it adds is declared by the migration it names", () => {
    const obs = catalogObservations();
    assert.ok(Array.isArray(obs), "the observations fixture is read (empty since the 2026-10-24 capture holds the 2026-10-17 names)");
    for (const o of obs) {
      assert.match(o.observedOn, /^\d{4}-\d{2}-\d{2}$/);
      for (const field of [o.by, o.why, o.settle, o.ledgerRow.source]) assert.ok(field.length >= 40, `${o.migration}: say how it was observed`);
      const file = path.join(SRC_DIR, "migrations", `${o.migration}.sql`);
      assert.ok(fs.existsSync(file), `${o.migration} is a migration in this repository`);
      // The ledger row production holds is THIS file's bytes: the evidence is checkable offline.
      assert.equal(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), o.ledgerRow.checksum,
        `${o.migration}: the production ledger row's checksum is not this file's sha256`);
      const d = declarationsIn(fs.readFileSync(file, "utf8"));
      for (const n of o.present) {
        const { object, name } = splitName(n);
        const declared = object === "function" ? d.functions.has(name)
          : object === "table" ? d.tables.has(name)
          : d.columns.get(name.slice(0, name.indexOf(".")))?.has(name.slice(name.indexOf(".") + 1)) === true;
        assert.ok(declared, `${n} is not declared by ${o.migration}`);
      }
      for (const [t, spec] of Object.entries(o.columnsOf ?? {})) {
        assert.ok(o.present.includes(`table ${t}`), `columnsOf ${t}: the table itself must be observed`);
        assert.equal(spec.from, o.migration);
        assert.ok(spec.why.length >= 40);
      }
    }
  });

  it("the 2026-10-17 observation is retired: 2998's three names are graded present FROM THE CAPTURE, and no observation re-adds what the capture holds", () => {
    const prod = productionSchema();
    assert.ok(prod.tables.get("stories")?.has("deleted_at"), "stories.deleted_at");
    assert.ok(prod.tables.get("job_health")?.has("last_success_at"), "job_health.last_success_at");
    assert.ok(prod.tables.get("story_purge_queue")?.has("next_attempt_at"), "story_purge_queue, with 2998's columns");
    assert.deepEqual([...prod.observedAfterCapture].sort(), [], "2026-10-24: the capture records these itself, so nothing is observed on top of it");
    assert.deepEqual(prod.observedButCaptured, [], "the capture current.ts names now records these: delete the observation (shrink-only)");
  });

  it("none of them is graded missing anywhere in the codebase (they were three UNGATED and three other ledger entries)", () => {
    const names = new Set(mismatches.map((m) => `${m.object} ${m.name}`));
    for (const n of ["column stories.deleted_at", "table story_purge_queue", "column job_health.last_success_at"]) {
      assert.ok(!names.has(n), `${n} is still graded missing`);
    }
    assert.ok(scan.refs.some((r) => r.file === "src/lib/mediaAccess.ts" && r.table === "stories" && r.name === "deleted_at"),
      "control: the scan still reads mediaAccess's stories.deleted_at");
  });
});

describe("class A / dropped: a name production lacks that no unapplied migration explains is on a shrink-only ledger", () => {
  it("no NEW dead name; every ledger entry is exactly what the scan finds in its file", () => {
    const found = byFile(["A", "dropped"]);
    const ledger = new Map(KNOWN_DEAD_NAMES.map((e) => [e.file, new Set(e.names)]));
    const fresh: string[] = [];
    for (const [file, names] of found) for (const n of names) if (!ledger.get(file)?.has(n)) fresh.push(`${file} → ${n} at ${sitesOf(file, n)}`);
    assert.deepEqual(fresh, [], `production has no such name, and no SQL in the repository declares it (or only the baseline did). The statement fails in production on every call:\n${fresh.join("\n")}`);
    const stale: string[] = [];
    for (const [file, names] of ledger) for (const n of names) if (!found.get(file)?.has(n)) stale.push(`${file} → ${n}`);
    assert.deepEqual(stale, [], "fixed: delete these from KNOWN_DEAD_NAMES");
  });

  it("the five fixed names stay fixed", () => {
    const found = byFile(["A", "dropped", "B"]);
    assert.ok(!found.get("src/routes/adminCompass.ts")?.has("column compass_abuse_flags.created_at"));
    for (const c of ["name", "destination"]) assert.ok(!found.get("src/routes/tags.ts")?.has(`column trips.${c}`));
    for (const c of ["tel", "website", "rating", "price", "stats", "photos", "hours", "features", "amenities", "photo_url"]) {
      assert.ok(!found.get("src/lib/fsq/fsqPlaces.ts")?.has(`column fsq_places.${c}`), c);
    }
    assert.ok(!found.get("src/routes/reviews.ts")?.has("column rent_buddy_bookings.buddy_user_id"));
    assert.ok(!found.get("src/lib/places/placeCollectionsWorker.ts")?.has("column places.post_count"));
    // Controls: the fixed reads are still read by the scan, on their real columns.
    const has = (file: string, table: string, name: string) => scan.refs.some((r) => r.file === file && r.table === table && r.name === name);
    assert.ok(has("src/lib/fsq/fsqPlaces.ts", "fsq_places", "dataset_date"));
    assert.ok(has("src/routes/reviews.ts", "rent_buddy_bookings", "buddy_id") && has("src/routes/reviews.ts", "rent_buddy_profiles", "user_id"));
    assert.ok(has("src/lib/places/placeCollectionsWorker.ts", "posts", "canonical_place_id"));
  });
});

describe("class B: a name only an unapplied migration declares is ledgered with its production gate", () => {
  it("every such name is on exactly one entry, and every entry is still found (shrink-only)", () => {
    const found = byFile(["B"]);
    const owners = new Map<string, number>();
    for (const e of UNAPPLIED_SCHEMA_READS) {
      for (const n of e.names) {
        const k = mismatchKey(e.file, { object: n.slice(0, n.indexOf(" ")) as Mismatch["object"], name: n.slice(n.indexOf(" ") + 1) });
        owners.set(k, (owners.get(k) ?? 0) + 1);
      }
    }
    const dup = [...owners].filter(([, c]) => c > 1).map(([k]) => k);
    assert.deepEqual(dup, [], "a name is on two entries");
    const fresh: string[] = [];
    for (const [file, names] of found) for (const n of names) if (!owners.has(`${file} → ${n}`)) fresh.push(`${file} → ${n} at ${sitesOf(file, n)}`);
    assert.deepEqual(fresh, [],
      "production does not have these; only SQL it has not applied declares them. If the path cannot run in production " +
      "(a flag FALSE there, a capability probe that fails closed, a schema marker), ledger it with that gate; otherwise it " +
      `fails in production today — fix it:\n${fresh.join("\n")}`);
    const stale: string[] = [];
    for (const e of UNAPPLIED_SCHEMA_READS) for (const n of e.names) if (!found.get(e.file)?.has(n)) stale.push(`${e.file} → ${n}`);
    assert.deepEqual(stale, [], "no longer found (applied in production, or the read changed): delete these from UNAPPLIED_SCHEMA_READS");
  });

  it("every entry says why, and the UNGATED (live-defect) count only goes down", () => {
    const verdicts: ReadonlySet<string> = new Set<Verdict>(["gated", "unreachable", "masked", "fail-soft", "UNGATED"]);
    for (const e of UNAPPLIED_SCHEMA_READS) {
      assert.ok(verdicts.has(e.verdict), `${e.file}: unknown verdict ${e.verdict}`);
      assert.ok(e.why.length >= 40, `${e.file}: say why`);
    }
    const ungated = UNAPPLIED_SCHEMA_READS.filter((e) => e.verdict === "UNGATED").reduce((n, e) => n + e.names.length, 0);
    assert.ok(ungated <= UNGATED_CEILING, `${ungated} UNGATED names > UNGATED_CEILING ${UNGATED_CEILING}: a new live defect`);
    assert.equal(ungated, UNGATED_CEILING, `fixed some: lower UNGATED_CEILING to ${ungated}`);
  });
});

describe("no new blind spot: every file's unresolvable sites stay at or under its ceiling", () => {
  it("per-file counts", () => {
    const per = new Map<string, Set<number>>();
    for (const u of scan.unresolved) per.set(u.file, (per.get(u.file) ?? new Set()).add(u.line));
    const over = [...per].filter(([f, lines]) => lines.size > (UNRESOLVED_REFERENCE_CEILING[f] ?? 0))
      .map(([f, lines]) => `${f}: ${lines.size} > ${UNRESOLVED_REFERENCE_CEILING[f] ?? 0} (${scan.unresolved.filter((u) => u.file === f).map((u) => `:${u.line} ${u.reason}: ${u.text}`).join(" | ")})`);
    assert.deepEqual(over, [], "a name the scan cannot read is a name nobody checks against production: make it static, or raise its ceiling with a reason");
  });
});

// ── The grammar pieces ───────────────────────────────────────────────────────

describe("the reader's grammar", () => {
  it("bareColumn strips casts, JSON paths, quotes and aggregates", () => {
    assert.equal(bareColumn("metadata->>kind"), "metadata");
    assert.equal(bareColumn("created_at::date"), "created_at");
    assert.equal(bareColumn('"order"'), "order");
    assert.equal(bareColumn("amount.sum()"), "amount");
    assert.equal(bareColumn("*"), null);
    assert.equal(bareColumn("count"), null);
  });

  it("logicTreeColumns reads columns through and()/or()/not., and marks a dynamic column", () => {
    assert.deepEqual(logicTreeColumns("a.eq.1,and(b.is.null,not.c.in.(x,y)),or(d.gt.2)"), ["a", "b", "c", "d"]);
    assert.deepEqual(logicTreeColumns("\u0000.eq.1,e.eq.\u0000"), [null, "e"]);
  });

  it("selectListColumns puts an embed's columns on the table the embed resolves to", () => {
    assert.deepEqual(selectListColumns("trip_members", "trip_id, t:trips(id, name:title)"), [
      { table: "trip_members", column: "trip_id", embed: false },
      { table: "trips", column: "id", embed: true },
      { table: "trips", column: "title", embed: true },
    ]);
  });

  it("declarationsIn reads CREATE TABLE, ADD COLUMN (also inside DO bodies), RENAME, views and functions", () => {
    const d = declarationsIn(`
      CREATE TABLE IF NOT EXISTS public.t1 (id uuid PRIMARY KEY, CONSTRAINT k CHECK (true), body text);
      ALTER TABLE public.t1 ADD COLUMN IF NOT EXISTS a int, ADD CONSTRAINT x UNIQUE (a), ADD COLUMN b text;
      ALTER TABLE t1 RENAME COLUMN b TO c;
      DO $$ BEGIN EXECUTE 'ALTER TABLE public.t2 ADD COLUMN d text'; END $$;
      CREATE OR REPLACE VIEW public.v1 WITH (security_invoker = true) AS SELECT 1;
      CREATE OR REPLACE FUNCTION public.f1(p uuid) RETURNS int LANGUAGE sql AS $f$ SELECT 1 $f$;
    `);
    assert.deepEqual([...d.columns.get("t1")!].sort(), ["a", "b", "body", "c", "id"]);
    assert.deepEqual([...d.columns.get("t2")!], ["d"]);
    assert.deepEqual([...d.views], ["v1"]);
    assert.deepEqual([...d.functions], ["f1"]);
  });
});

// ── The scan, on a planted tree ──────────────────────────────────────────────
//
// Graded against a FIXTURE production: the real capture with two real
// declarations removed (`messages.client_message_id`, which only migration 2810
// declares, and the view `memory_entity_links`, which only 3674 declares), so the
// B plants stay B whatever production applies next. A plants use names no SQL
// will ever declare.

describe("the scan finds each kind of plant", () => {
  let root: string;
  let planted: SchemaRefScan;
  let found: Map<string, Set<string>>;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "column-scan-"));
    const w = (name: string, text: string) => fs.writeFileSync(path.join(root, name), text);
    w("select.ts", `export async function a(sc: any) { return sc.from("places").select("id, name, zz_dead_select"); }\n`);
    w("filter.ts", `export async function a(sc: any, x: string) { return sc.from("compass_abuse_flags").select("id").gte("zz_dead_filter", x).order("detected_at"); }\n`);
    w("write.ts", `export async function a(sc: any, rows: any[]) {\n  await sc.from("posts").insert(rows.map((r) => ({ author_id: r.a, zz_dead_write: 1 })));\n  await sc.from("posts").upsert({ ...{ id: 1 }, zz_dead_spread: 2 }, { onConflict: "id,zz_dead_conflict" });\n}\n`);
    w("rpc.ts", `export async function a(sc: any) { await sc.rpc("upsert_city_stamp", {}); return sc.rpc("zz_dead_function", {}); }\n`);
    w("table.ts", `export async function a(sc: any) { return sc.from("zz_dead_table").select("id"); }\n`);
    w("embed.ts", `export async function a(sc: any) { return sc.from("trip_members").select("trip_id, trips(id, zz_dead_embed)"); }\n`);
    w("dotted.ts", `export async function a(sc: any, x: string) { return sc.from("trip_members").select("trip_id, t:trips!inner(id)").eq("t.zz_dead_dotted", x); }\n`);
    w("or.ts", `export async function a(sc: any, u: string) { return sc.from("rent_buddy_bookings").select("id").or(\`traveler_id.eq.\${u},zz_dead_or.eq.\${u}\`); }\n`);
    w("unapplied.ts", `export async function a(sc: any) { await sc.from("messages").select("id, client_message_id"); return sc.from("memory_entity_links").select("anything_at_all"); }\n`);
    w("shadow.ts", [
      `const row = { author_id: "x", zz_shadow_const: 1 };`,
      `export async function a(sc: any) { await sc.from("posts").insert(row); }`,
      `export async function b(sc: any, row: any) { await sc.from("trips").insert(row); }`,
      `export async function c(sc: any, rows: any[]) { for (const row of rows) await sc.from("events").insert(row); }`,
      `export async function d(sc: any) { const res = await sc.from("posts").select("id"); return res.data.filter((r: any) => r.id); }`,
      `export async function e(sc: any, file: Blob) { await sc.storage.from("avatars").update("p.png", file); return Array.from([1]); }`,
      ``,
    ].join("\n"));
    w("controls.ts", `export async function a(sc: any) { return sc.from("trips").select("id, title, destination_city").eq("owner_id", "x").order("created_at"); }\n`);
    w("push.ts", `export async function a(sc:any){const rows:any[]=[];const row={author_id:'x',zz_dead_push:1};rows.push(row);{const rows:any[]=[];rows.push({zz_other_scope:1});}await sc.from('posts').insert(rows);\nawait sc.from('posts').upsert(rows.map(row=>({...row,id:'x'})));}\n`);
    w("dynamic.ts", `export async function a(sc: any, col: () => string) { return sc.from("posts").select("id").eq(col(), 1); }\n`);
    w("skipped.test.ts", `export async function a(sc: any) { return sc.from("zz_dead_table_in_a_test").select("id"); }\n`);
    planted = scanSchemaReferences(root, scanSelectEmbeds(root));
    const real = productionSchema();
    const tables = new Map([...real.tables].map(([t, c]) => [t, new Set(c)]));
    tables.get("messages")!.delete("client_message_id");
    tables.delete("memory_entity_links");
    const ms = productionMismatches(planted, { tables, functions: real.functions }, new Set([...recordedAppliedMigrations()].filter((m) => !m.startsWith("2810_") && !m.startsWith("3674_")))); // 2026-10-24: 2810 and 3674 are now recorded as applied, so the fixture un-records them as well as removing their names
    found = new Map();
    for (const m of ms) for (const s of m.sites) {
      const k = `${m.class} ${s.file}`;
      found.set(k, (found.get(k) ?? new Set()).add(`${m.object} ${m.name}`));
    }
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const at = (cls: string, file: string) => [...(found.get(`${cls} ${file}`) ?? [])].sort();

  it("A: a select column, a filter column, a write key (map, spread, onConflict), an rpc, a table, an embed column, a dotted embed filter, an or() column", () => {
    assert.deepEqual(at("A", "select.ts"), ["column places.zz_dead_select"]);
    assert.deepEqual(at("A", "filter.ts"), ["column compass_abuse_flags.zz_dead_filter"]);
    assert.deepEqual(at("A", "write.ts"), ["column posts.zz_dead_conflict", "column posts.zz_dead_spread", "column posts.zz_dead_write"]);
    assert.deepEqual(at("A", "rpc.ts"), ["function zz_dead_function"]);
    assert.deepEqual(at("A", "table.ts"), ["table zz_dead_table"]);
    assert.deepEqual(at("A", "embed.ts"), ["column trips.zz_dead_embed"]);
    assert.deepEqual(at("A", "dotted.ts"), ["column trips.zz_dead_dotted"]);
    assert.deepEqual(at("A", "or.ts"), ["column rent_buddy_bookings.zz_dead_or"]);
  });

  it("B: a column and a view only an unapplied migration declares; a view's columns are not graded", () => {
    assert.deepEqual(at("B", "unapplied.ts"), ["column messages.client_message_id", "table memory_entity_links"]);
    assert.deepEqual(at("A", "unapplied.ts"), []);
  });

  it("LEXICAL SCOPE: a module const is read where it is in scope, never through a parameter or a loop variable of the same name", () => {
    assert.deepEqual(at("A", "shadow.ts"), ["column posts.zz_shadow_const"]);
    assert.ok(!planted.refs.some((r) => r.file === "shadow.ts" && (r.table === "trips" || r.table === "events") && r.kind === "write"),
      "a parameter / loop variable named like the const must not resolve to it");
  });
  it('array push and spread-map builders expose their write columns without leaking a shadowed array',()=>{
    assert.deepEqual(at('A','push.ts'),['column posts.zz_dead_push']);
    assert.equal(planted.refs.filter(r=>r.file==='push.ts'&&r.kind==='write'&&r.name==='zz_dead_push').length,2);
  });

  it("CONTROLS: live names pass; a result's .filter(cb), a Storage bucket and Array.from are not PostgREST; a test file is not production", () => {
    assert.deepEqual([...found.keys()].filter((k) => k.endsWith(" controls.ts")), []);
    assert.ok(!planted.refs.some((r) => r.file === "shadow.ts" && (r.table === "avatars" || r.method === "filter")));
    assert.ok(!planted.refs.some((r) => r.file === "skipped.test.ts"));
  });

  it("an unresolvable site is reported, not guessed", () => {
    assert.deepEqual(planted.unresolved.filter((u) => u.file === "dynamic.ts").map((u) => `${u.line} ${u.reason}`), ["1 filter column not statically resolvable"]);
    assert.deepEqual(planted.unresolved.filter((u) => u.file === "shadow.ts").map((u) => `${u.line} ${u.reason}`).sort(),
      ["3 write body not statically resolvable", "4 write body not statically resolvable"]);
  });
});

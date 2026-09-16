/**
 * The three retention passes this scheduler gained, and — the part that actually
 * fails in production — the proof that the scheduler RUNS them.
 *
 * A purge function with no caller is the defect this whole band exists to
 * prevent (see lib/sensingRetentionScheduler's header on migration 2315). A
 * purge function with a caller that is never reached from the timer is the same
 * defect wearing a better disguise, so `RETENTION_PASSES` is exported and the
 * timer iterates it: registration becomes a value a test can read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RETENTION_PASSES,
  runPresenceCleanup,
  runSensingCredentialCleanup,
  runMapTelemetryRetentionSweep,
  runIntelRetentionSweep,
  runIntelContributionRetentionSweep,
} from "../lib/intelRetentionScheduler.js";

// ── registration ─────────────────────────────────────────────────────────────

test("every retention pass is registered on the scheduler's timer", () => {
  const registered = new Set(RETENTION_PASSES.map((p) => p.name));
  for (const [name, fn] of Object.entries({
    intel_retention_sweep: runIntelRetentionSweep,
    intel_contribution_retention: runIntelContributionRetentionSweep,
    map_telemetry_retention: runMapTelemetryRetentionSweep,
    presence_cleanup: runPresenceCleanup,
    sensing_credential_cleanup: runSensingCredentialCleanup,
  })) {
    assert.ok(registered.has(name), `${name} is exported but nothing on the timer calls it`);
    assert.equal(RETENTION_PASSES.find((p) => p.name === name)!.run, fn);
  }
  assert.equal(RETENTION_PASSES.length, 5);
});

test("a registered pass survives its own rejection — one broken sweep cannot starve the others", async () => {
  const outcomes = await Promise.allSettled(
    RETENTION_PASSES.map((p) => p.run({ client: null } as any)),
  );
  assert.ok(outcomes.every((o) => o.status === "fulfilled"), "a pass rejected instead of reporting");
  for (const o of outcomes) {
    assert.equal((o as PromiseFulfilledResult<any>).value.reason, "no_client");
  }
});

// ── presence cleanup ─────────────────────────────────────────────────────────

function presenceClient(rows: any[], enabled = true, failures: Record<string, any> = {}) {
  const calls = { updated: [] as string[][], deleted: [] as string[][] };
  const client: any = {
    calls,
    from(table: string) {
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled }, error: null }) }) }) };
      }
      const q: any = {
        select: () => q, order: () => q, gt: () => q, lte: () => q, is: () => q,
        limit: () => (failures.read ? Promise.resolve(failures.read) : Promise.resolve({ data: rows, error: null })),
        update: () => ({ in: async (_c: string, ids: string[]) => { calls.updated.push(ids); return failures.update ?? { error: null }; } }),
        delete: () => ({ in: async (_c: string, ids: string[]) => { calls.deleted.push(ids); return failures.delete ?? { error: null }; } }),
      };
      return q;
    },
  };
  return client;
}

test("presence cleanup marks stale and erases expired rows", async () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const c = presenceClient([
    { id: "stale", last_seen_at: "2026-08-31T11:00:00Z", stale_after_secs: 60, expires_at: null },
    { id: "expired", last_seen_at: "2026-08-31T11:59:59Z", stale_after_secs: 3600, expires_at: "2026-08-31T11:00:00Z" },
    { id: "live", last_seen_at: "2026-08-31T11:59:59Z", stale_after_secs: 3600, expires_at: "2026-08-31T13:00:00Z" },
  ]);
  const result = await runPresenceCleanup({ client: c, now });
  assert.deepEqual(result, { markedStale: 1, deleted: 1, skipped: false, reason: null });
  assert.deepEqual(c.calls.updated, [["stale"]]);
  assert.deepEqual(c.calls.deleted, [["expired"]]);
});

test("presence cleanup is explicitly inert while presence_cleanup_enabled is off", async () => {
  // 2957 seeds this flag FALSE in BOTH live databases, deliberately. The sweep
  // must do nothing at all until an owner flips it — no reads, no writes.
  const c = presenceClient([{ id: "x", last_seen_at: "2020-01-01T00:00:00Z", stale_after_secs: 1, expires_at: "2020-01-01T00:00:00Z" }], false);
  const result = await runPresenceCleanup({ client: c });
  assert.deepEqual(result, { markedStale: 0, deleted: 0, skipped: true, reason: "disabled" });
  assert.deepEqual(c.calls.deleted, [], "deleted rows while the rollout flag was off");
});

test("presence cleanup reports storage failures rather than a false success", async () => {
  const read = await runPresenceCleanup({
    client: presenceClient([], true, { read: { data: null, error: { message: "down" } } }),
  });
  assert.deepEqual(read, { markedStale: 0, deleted: 0, skipped: true, reason: "error" });

  const del = await runPresenceCleanup({
    client: presenceClient(
      [{ id: "expired", last_seen_at: "2026-08-31T11:59:59Z", stale_after_secs: 3600, expires_at: "2020-01-01T00:00:00Z" }],
      true, { delete: { error: { message: "denied" } } },
    ),
    now: new Date("2026-08-31T12:00:00Z"),
  });
  assert.equal(del.reason, "error");
  assert.equal(del.deleted, 0, "counted rows the database refused to delete");
});

test("presence cleanup chunks its id lists — a single .in() of 1000 ids is an unsendable URL", async () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const rows = Array.from({ length: 450 }, (_, i) => ({
    id: `row-${i}`, last_seen_at: "2020-01-01T00:00:00Z", stale_after_secs: 60,
    expires_at: "2020-01-01T00:00:00Z",
  }));
  const c = presenceClient(rows);
  const result = await runPresenceCleanup({ client: c, now });
  assert.equal(result.markedStale, 450);
  assert.equal(result.deleted, 450);
  assert.ok(c.calls.deleted.length > 1, "sent every id in one request");
  for (const batch of [...c.calls.deleted, ...c.calls.updated]) {
    assert.ok(batch.length <= 200, `batch of ${batch.length} ids exceeds the safe URL bound`);
  }
});

test("presence cleanup never loops forever on a page it cannot advance past", async () => {
  // The keyset cursor comes from the last row's id. If a page comes back full but
  // without a usable id the loop must terminate, not re-request page one.
  const rows = Array.from({ length: 1000 }, () => ({
    id: null, last_seen_at: "2026-08-31T11:59:59Z", stale_after_secs: 3600, expires_at: null,
  }));
  const result = await runPresenceCleanup({ client: presenceClient(rows), now: new Date("2026-08-31T12:00:00Z") });
  assert.equal(result.skipped, false);
});

// ── sensing credential cleanup ───────────────────────────────────────────────

function credentialClient(rows: any[], failures: Record<string, any> = {}) {
  const calls = { deleted: [] as string[][] };
  return {
    calls,
    from(_table: string) {
      const q: any = {
        select: () => q, lt: () => q,
        limit: () => (failures.read ? Promise.resolve(failures.read) : Promise.resolve({ data: rows, error: null })),
        delete: () => ({ in: async (_c: string, ids: string[]) => { calls.deleted.push(ids); return failures.delete ?? { error: null }; } }),
      };
      return q;
    },
  };
}

test("expired sensing credentials are erased, and an empty store is a real pass not a skip", async () => {
  const c = credentialClient([{ id: "a" }, { id: "b" }]);
  const result = await runSensingCredentialCleanup({ client: c, now: new Date("2026-09-16T12:00:00Z") });
  assert.equal(result.deleted, 2);
  assert.equal(result.skipped, false);
  assert.deepEqual(c.calls.deleted, [["a", "b"]]);

  const empty = await runSensingCredentialCleanup({ client: credentialClient([]) });
  assert.deepEqual(empty, { deleted: 0, skipped: false, reason: null });
});

test("sensing credential cleanup tolerates a database without the 2956 tables", async () => {
  // 2956 is applied to both live databases, but a fresh/partial database may not
  // have it. An absent relation must not be reported as a successful erasure.
  const result = await runSensingCredentialCleanup({
    client: credentialClient([], { read: { data: null, error: { code: "42P01", message: "relation does not exist" } } }),
  });
  assert.equal(result.deleted, 0);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "error");
});

// ── map telemetry retention ──────────────────────────────────────────────────

function rpcClient(opts: { flag: boolean | null; purged?: number | string; rpcError?: boolean }) {
  const state = { rpcCalled: false, rpcName: "" };
  return {
    state,
    from(table: string) {
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: opts.flag === null ? null : { enabled: opts.flag }, error: null }) }) }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string) => {
      state.rpcCalled = true; state.rpcName = name;
      return opts.rpcError ? { data: null, error: { message: "boom" } } : { data: opts.purged ?? 0, error: null };
    },
  };
}

test("map telemetry retention goes through the declared purge function, not a raw delete", async () => {
  const c = rpcClient({ flag: true, purged: "12" });
  const result = await runMapTelemetryRetentionSweep({ client: c });
  assert.equal(result.purged, 12, "int8 arrives from PostgREST as a string");
  assert.equal(result.skipped, false);
  assert.equal(c.state.rpcName, "purge_expired_map_telemetry");
});

test("map telemetry retention has its OWN flag — turning collection off must not strand expired rows", async () => {
  const disabled = rpcClient({ flag: false, purged: 99 });
  assert.equal((await runMapTelemetryRetentionSweep({ client: disabled })).reason, "disabled");
  assert.equal(disabled.state.rpcCalled, false);

  const absent = rpcClient({ flag: null, purged: 99 });
  assert.equal((await runMapTelemetryRetentionSweep({ client: absent })).reason, "disabled");
  assert.equal(absent.state.rpcCalled, false, "purged with no flag row at all");

  const failed = await runMapTelemetryRetentionSweep({ client: rpcClient({ flag: true, rpcError: true }) });
  assert.equal(failed.reason, "error");
  assert.equal(failed.purged, 0);
});

// ── the registry and the registration must not drift apart ───────────────────

test("the location-purpose registry's presence note matches what is actually registered", async () => {
  // lib/locationPurposes is the tree's statement of what the system DOES with
  // location data. It said "NO sweeper runs" for circle_presence for a month
  // while that was true. A note and a registration that disagree is the same
  // defect in either direction, so tie them together here.
  const { LOCATION_PURPOSES } = await import("../lib/locationPurposes.js");
  const presence = LOCATION_PURPOSES.find((p: any) => p.tables?.includes("circle_presence"));
  assert.ok(presence, "no location purpose claims circle_presence");
  const note = String((presence as any).retentionNote ?? "");
  assert.match(note, /runPresenceCleanup/);
  assert.match(note, /presence_cleanup_enabled/);
  assert.doesNotMatch(note, /NO sweeper/i, "the note still says no sweeper runs");
  assert.ok(
    RETENTION_PASSES.some((p) => p.run === runPresenceCleanup),
    "the registry promises a sweeper that is not on the scheduler",
  );
  // And the gate the note names is the gate the pass declares.
  assert.equal(RETENTION_PASSES.find((p) => p.run === runPresenceCleanup)!.flag, "presence_cleanup_enabled");
});

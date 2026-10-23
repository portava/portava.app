/**
 * memoryOwnerControls.db.test.ts — the owner's three controls over a Memory,
 * EXECUTED on the full chain scripts/local-db/up.sh replays: the §21 deletion
 * (DELETE_MEMORY through the real `memory_kernel_execute`, then the five-step
 * lifecycle, its dead letter (3670) and the redrive), the §9 / §3.6 place
 * corrections (3673) and the readers that must honour them, and the §11
 * per-Memory controls (3671); and the §17 Highlight commands and events
 * (2993, 3001, 3677). census-highlights-memories §CA: H52, H193, H133, H153
 * (deletion), H28, H47, H48, H49, H73, H242 (corrections), H36, H88, H210
 * (controls), H142, H143, H145, H155–H159 (Highlights).
 *
 * WHY THIS FILE EXISTS. Until 2026-10-21 none of 3670, 3671 or 3673 was applied
 * anywhere, and every suite behind those rows ran its service over a hand-rolled
 * fake. Production now holds all three (schema_migration_ledger, 2026-10-21
 * 17:26–17:27Z) with a catalog object-for-object identical to this chain, and
 * `memory_kernel_enabled` / `memory_deletion_redrive_enabled` are ON (2026-10-23
 * 10:02Z). So the question a fake cannot answer is now the one that matters:
 * do the REAL services, against the REAL tables, triggers, grants and kernel
 * function, do what the fakes said? Every case below runs the production service
 * functions through ./memoryPostgrestBridge.ts as `service_role`, with every
 * trigger the chain installs on `memories` (the graph mirror, the snapshot,
 * video-segment and import-batch revokers, the keep-private guard) in place.
 *
 * FLAGS are answered in memory with production's values (the bridge never writes
 * `feature_flags`); the harness rows stay as their migrations seeded them.
 *
 *   K  §17: CREATE_MEMORY and DELETE_MEMORY cross the kernel — state, receipt,
 *      audit, domain event and outbox row in one transaction; a replay is one effect
 *   D  §21: the lifecycle runs all five states on the deleted Memory and purges
 *      its corrections and its kept-candidate evidence; a failing step is retried,
 *      dead-lettered as a durable row, and resolved by the redrive
 *   C  §9 / §4: a rejection and an assertion are recorded; a non-owner read shows
 *      the asserted place and never the rejected one; the guard and the
 *      append-only rule hold; the aggregate excludes a disputed place
 *   R  §11: the controls' storage rules, and the readers that consult them
 *   H  §17: CREATE / PIN / UNPIN / HIDE / UNHIDE_HIGHLIGHT cross the Highlight
 *      kernel and emit their events; the clock producer emits highlight.expired once
 *
 * Run: bash scripts/local-db/run-tests.sh (after up.sh), or with LOCAL_DB_URL set:
 *   node --import tsx/esm --test src/test/db/memoryOwnerControls.db.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, rows, scalar, seedUser, psql } from "./localDb.js";
import { memoryBridge } from "./memoryPostgrestBridge.js";
import { dispatchMemoryCommand } from "../../services/memory/MemoryDomainService.js";
import { runMemoryDeletionLifecycle } from "../../services/memory/memoryDeletionLifecycle.js";
import { runMemoryDeletionRedrivePass } from "../../lib/memoryDeletionRedriveScheduler.js";
import { placeCorrectionsForPatch, placesForViewer, recordPlaceCorrections } from "../../services/memory/memoryCorrections.js";
import { aggregateMemoryRows, canUseForPersonalization, excludedMemories } from "../../services/memory/memoryReaderGuard.js";
import { rebuildProjection } from "../../services/memoryProjections/derivativeRegistry.js";
import { runHighlightExpiryPass } from "../../lib/highlightExpiryEventScheduler.js";
// The kernel's event log and outbox are named through lib/memoryOutbox.ts, the one module check:memory-table-ownership lets name them.
import { MEMORY_EVENT_TABLE as EVENTS, MEMORY_OUTBOX_TABLE as OUTBOX } from "../../lib/memoryOutbox.js";

/** Production's values for every flag these paths read (feature_flags, 2026-10-23). */
const PROD_FLAGS: Record<string, boolean> = {
  memory_kernel_enabled: true,
  memory_deletion_redrive_enabled: true,
  memory_location_precision_enabled: true,
  memory_type_enabled: true,
  memory_place_occurrence_name_enabled: true,
  memory_resurfacing_policy_enabled: true,
  memory_projection: true,
  highlight_expiry_events_enabled: true,
};

const TAG = `moc${randomUUID().slice(0, 8)}`;
let owner = "";
let viewer = "";
const placeA = randomUUID();
const placeB = randomUUID();

const asService = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
/** A statement as service_role that is EXPECTED to fail: its stderr. */
function refusedAsService(sql: string): string {
  const r = psql(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
  assert.notEqual(r.status, 0, `expected a refusal, and the statement succeeded:\n${sql}`);
  return r.stderr;
}
function newMemory(cols: Record<string, string | null> = {}): string {
  const id = randomUUID();
  const keys = ["id", "owner_id", "title", ...Object.keys(cols)];
  const vals = [`'${id}'`, `'${owner}'`, `'${TAG}'`, ...Object.values(cols).map((v) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`))];
  asService(`INSERT INTO public.memories (${keys.join(", ")}) VALUES (${vals.join(", ")});`);
  return id;
}
const silentLog = { error: () => {}, warn: () => {}, info: () => {} };

describe("the owner's controls over a Memory, on the full chain (3670, 3671, 3673, 2710/2711)", { skip: !HAVE_DB }, () => {
  before(() => {
    owner = seedUser(`${TAG}o`);
    viewer = seedUser(`${TAG}v`);
    exec(`INSERT INTO public.places (id, name, normalized_name) VALUES
      ('${placeA}', 'Cafe A ${TAG}', 'cafe a ${TAG}'), ('${placeB}', 'Cafe B ${TAG}', 'cafe b ${TAG}');`);
  });
  after(() => {
    // Hard erasure, as account deletion does it: the cascades from auth.users take
    // the Memories, corrections, controls, dead letters and kernel rows with them.
    for (const id of [owner, viewer].filter(Boolean)) {
      exec(`DELETE FROM public.${EVENTS} WHERE actor_user_id = '${id}';
            DELETE FROM public.${OUTBOX} WHERE memory_id IN (SELECT id FROM public.memories WHERE owner_id = '${id}');
            DELETE FROM public.memory_command_audit WHERE actor_user_id = '${id}';
            DELETE FROM public.memory_command_receipts WHERE actor_user_id = '${id}';
            DELETE FROM public.memory_derivative_registry WHERE scope_key LIKE '%${id}%';
            DELETE FROM public.trips WHERE owner_id = '${id}';
            DELETE FROM public.memories WHERE owner_id = '${id}';
            DELETE FROM public.profiles WHERE id = '${id}';
            DELETE FROM auth.users WHERE id = '${id}';`);
    }
    exec(`DELETE FROM public.places WHERE id IN ('${placeA}', '${placeB}');`);
  });

  // ── K: §17, through the real kernel ────────────────────────────────────────
  describe("K — CREATE_MEMORY and DELETE_MEMORY cross memory_kernel_execute (H133, H153)", () => {
    let memoryId = "";
    let deleteKey = "";

    test("K1 a create through the kernel writes the Memory, its receipt, its audit row, memory.created and its outbox row", async () => {
      const sc = memoryBridge({ flags: PROD_FLAGS });
      const key = randomUUID();
      const out = await dispatchMemoryCommand<any>({
        sc, commandType: "CREATE_MEMORY", memoryId: null, actorUserId: owner, idempotencyKey: key,
        payload: { to_state: "ACTIVE", visibility: "only_me", write: { owner_id: owner, title: `${TAG} kept`, visibility: "only_me", state: "published", place_id: placeA }, select: "id" },
        legacy: async () => { throw new Error("the legacy write must not run with memory_kernel_enabled ON"); },
      });
      assert.equal(out.ok, true, JSON.stringify(out));
      if (!out.ok) return;
      assert.ok(out.eventId, "the kernel names the event it wrote");
      const created = rows<{ id: string; state: string; visibility: string }>(`SELECT id, state, visibility FROM public.memories WHERE owner_id = '${owner}' AND title = '${TAG} kept'`);
      assert.equal(created.length, 1);
      memoryId = created[0]!.id;
      assert.deepEqual([created[0]!.state, created[0]!.visibility], ["published", "only_me"]);
      assert.equal(scalar(`SELECT count(*) FROM public.memory_command_receipts WHERE actor_user_id = '${owner}' AND idempotency_key = '${key}' AND command_type = 'CREATE_MEMORY' AND memory_id = '${memoryId}'`), "1");
      assert.equal(scalar(`SELECT string_agg(type || '#' || sequence, ',' ORDER BY sequence) FROM public.${EVENTS} WHERE memory_id = '${memoryId}'`), "memory.created#1");
      assert.equal(scalar(`SELECT count(*) FROM public.${OUTBOX} o JOIN public.${EVENTS} e ON e.event_id = o.event_id WHERE e.memory_id = '${memoryId}' AND o.published_at IS NULL`), "1");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_command_audit WHERE memory_id = '${memoryId}' AND command_type = 'CREATE_MEMORY' AND outcome = 'accepted'`), "1");
    });

    test("K2 a stranger's DELETE_MEMORY is refused by the kernel: an audit row, and no event", async () => {
      const sc = memoryBridge({ flags: PROD_FLAGS });
      const out = await dispatchMemoryCommand<any>({
        sc, commandType: "DELETE_MEMORY", memoryId, actorUserId: viewer, idempotencyKey: randomUUID(),
        payload: { from_state: "ACTIVE", to_state: "DELETED" },
        legacy: async () => { throw new Error("legacy must not run"); },
      });
      assert.equal(out.ok, false);
      assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${memoryId}'`), "published");
      assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${memoryId}'`), "1");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_command_audit WHERE memory_id = '${memoryId}' AND actor_user_id = '${viewer}' AND outcome = 'rejected'`), "1");
    });

    test("K3 the owner's DELETE_MEMORY soft-deletes, emits memory.deleted at sequence 2, and a replay of its key is one effect", async () => {
      const sc = memoryBridge({ flags: PROD_FLAGS });
      deleteKey = randomUUID();
      const command = () => dispatchMemoryCommand<any>({
        sc, commandType: "DELETE_MEMORY", memoryId, actorUserId: owner, idempotencyKey: deleteKey,
        payload: { from_state: "ACTIVE", to_state: "DELETED" },
        legacy: async () => { throw new Error("legacy must not run"); },
      });
      const first = await command();
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${memoryId}'`), "deleted");
      assert.equal(scalar(`SELECT string_agg(type || '#' || sequence, ',' ORDER BY sequence) FROM public.${EVENTS} WHERE memory_id = '${memoryId}'`), "memory.created#1,memory.deleted#2");
      const replay = await command();
      assert.equal(replay.ok, true);
      if (replay.ok) assert.equal(replay.duplicate, true, "the receipt answers the replay");
      assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${memoryId}'`), "2");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_command_receipts WHERE actor_user_id = '${owner}' AND idempotency_key = '${deleteKey}'`), "1");
      assert.equal(scalar(`SELECT count(*) FROM public.${OUTBOX} o JOIN public.${EVENTS} e ON e.event_id = o.event_id WHERE e.memory_id = '${memoryId}'`), "2");
    });

    test("K4 the event log is append-only for the service role itself", () => {
      const err = refusedAsService(`UPDATE public.${EVENTS} SET type = type WHERE memory_id = '${memoryId}';`);
      assert.match(err, new RegExp(`${EVENTS} is append-only: UPDATE refused`));
    });
  });

  // ── D: §21, the lifecycle on the real stores ───────────────────────────────
  describe("D — the §21 lifecycle, its dead letter and the redrive (H52, H193)", () => {
    test("D1 all five states run on a deleted Memory; its correction and its kept-candidate evidence are purged and the episode retired", async () => {
      const m = newMemory({ visibility: "only_me", place_id: placeA });
      // What a kept candidate leaves behind (episodeCandidates.confirmCandidate), and an owner correction.
      const ep = randomUUID();
      asService(`INSERT INTO public.memory_episodes (id, user_id, episode_kind, started_at, ended_at, city, detection_reason, detector_version, detection_digest, significance, significance_basis, state, visibility)
                 VALUES ('${ep}', '${owner}', 'activity', now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'Hue', 'media_cluster', 1, '${TAG}-${ep}', 0.8, 'user_affirmed', 'confirmed', 'private');
                 INSERT INTO public.memory_evidence (episode_id, user_id, truth_level, source_class, source_table, source_id, observed_at, weight)
                 VALUES ('${ep}', '${owner}', 'observed', 'system', 'media_assets', '${randomUUID()}', now() - interval '2 days', 0.7),
                        ('${ep}', '${owner}', 'asserted', 'explicit', 'memories', '${m}', now(), 1);
                 INSERT INTO public.memory_corrections (memory_id, owner_id, field, kind, place_id, source) VALUES ('${m}', '${owner}', 'place', 'reject', '${placeA}', 'memory_edit');`);
      asService(`UPDATE public.memories SET state = 'deleted' WHERE id = '${m}';`);
      const report = await runMemoryDeletionLifecycle(memoryBridge({ flags: PROD_FLAGS }), {
        memoryId: m, ownerId: owner, actorUserId: owner, log: silentLog,
        previous: { visibility: "only_me", allowed_user_ids: [], hidden_user_ids: [], trip_id: null, state: "published" },
      });
      assert.deepEqual(report.steps.map((s) => `${s.step}:${s.outcome}`), [
        "DELETION_REQUESTED:done", "PUBLIC_REVOKED:done", "DERIVATIVES_PURGED:done", "RAW_EVIDENCE_PURGED:done", "DELETED:done",
      ], JSON.stringify(report.steps.map((s) => [s.step, s.outcome, s.detail])));
      assert.equal(report.completed, true);
      assert.equal(report.reachedState, "DELETED");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_corrections WHERE memory_id = '${m}'`), "0");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_evidence WHERE episode_id = '${ep}'`), "0");
      assert.equal(scalar(`SELECT state || '|' || coalesce(city, '<cleared>') || '|' || coalesce(significance::text, '<cleared>') FROM public.memory_episodes WHERE id = '${ep}'`), "deleted|<cleared>|<cleared>");
      // The evidence purge keeps a crash-safety receipt in this Memory's letter row while it unlinks the
      // episode (memoryEvidenceErasure's checkpoint); a run that completed leaves that row RESOLVED, never open.
      assert.equal(scalar(`SELECT count(*) FROM public.memory_deletion_dead_letters WHERE memory_id = '${m}' AND resolved_at IS NULL`), "0", "a run that completed leaves no open letter");
    });

    test("D2 a step that keeps failing is retried, then dead-lettered as a ROW; a second failure bumps it; the redrive resolves it", async () => {
      const m = newMemory({ visibility: "only_me", place_id: placeA });
      asService(`INSERT INTO public.memory_corrections (memory_id, owner_id, field, kind, place_id, source) VALUES ('${m}', '${owner}', 'place', 'reject', '${placeA}', 'memory_edit');
                 UPDATE public.memories SET state = 'deleted' WHERE id = '${m}';`);
      const failing = memoryBridge({ flags: PROD_FLAGS, failOn: (t, op) => t === "memory_corrections" && op === "delete" });
      const opts = { memoryId: m, ownerId: owner, actorUserId: owner, log: silentLog, previous: { visibility: "only_me", state: "published" } };
      const first = await runMemoryDeletionLifecycle(failing, opts);
      const step = first.steps.find((s) => s.step === "RAW_EVIDENCE_PURGED")!;
      assert.equal(step.outcome, "failed");
      assert.equal(step.attempts, 3, "MAX_STEP_ATTEMPTS");
      assert.equal(first.deadLettered, true);
      assert.equal(first.deadLetterDurable, true, `a letter is durable only on a confirmed row: ${first.deadLetterDetail}`);
      assert.equal(scalar(`SELECT letters || '|' || array_to_string(failed_steps, ',') || '|' || (resolved_at IS NULL) FROM public.memory_deletion_dead_letters WHERE memory_id = '${m}'`), "1|RAW_EVIDENCE_PURGED|true");
      await runMemoryDeletionLifecycle(failing, opts);
      assert.equal(scalar(`SELECT letters FROM public.memory_deletion_dead_letters WHERE memory_id = '${m}'`), "2");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_corrections WHERE memory_id = '${m}'`), "1", "nothing was purged while the step failed");

      const off = await runMemoryDeletionRedrivePass({ client: memoryBridge({ flags: { ...PROD_FLAGS, memory_deletion_redrive_enabled: false } }) });
      assert.equal(off.reason, "disabled", "the redrive is a no-op with its flag OFF");
      const pass = await runMemoryDeletionRedrivePass({ client: memoryBridge({ flags: PROD_FLAGS }) });
      assert.equal(pass.skipped, false);
      assert.ok(pass.considered >= 1);
      assert.ok(pass.resolved >= 1, JSON.stringify(pass));
      assert.equal(scalar(`SELECT resolved_at IS NOT NULL FROM public.memory_deletion_dead_letters WHERE memory_id = '${m}'`), "t");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_corrections WHERE memory_id = '${m}'`), "0", "the redrive finished the purge");
    });

    test("D3 a dead letter is stamped, never removed — even the service role cannot DELETE one — and it cascades with its Memory", () => {
      const m = newMemory({ visibility: "only_me" });
      asService(`UPDATE public.memories SET state = 'deleted' WHERE id = '${m}';
                 INSERT INTO public.memory_deletion_dead_letters (memory_id, owner_id, failed_steps, reached_state, detail, lifecycle_version) VALUES ('${m}', '${owner}', ARRAY['PUBLIC_REVOKED'], 'DELETION_REQUESTED', 'x', 'memory-deletion@1');`);
      assert.match(refusedAsService(`DELETE FROM public.memory_deletion_dead_letters WHERE memory_id = '${m}';`), /permission denied/);
      exec(`DELETE FROM public.memories WHERE id = '${m}';`);
      assert.equal(scalar(`SELECT count(*) FROM public.memory_deletion_dead_letters WHERE memory_id = '${m}'`), "0");
    });
  });

  // ── C: §9 / §4, corrections on the real store ──────────────────────────────
  describe("C — place corrections (H28, H47, H48, H49, H73, H242)", () => {
    let m = "";
    test("C1 an owner's edit from place A to B records a rejection of A and an assertion of B, as the PATCH route records them", async () => {
      m = newMemory({ visibility: "public", place_id: placeA });
      const rowsToRecord = placeCorrectionsForPatch({ place_id: placeA, canonical_location_id: null } as any, { placeId: placeB } as any);
      assert.deepEqual(rowsToRecord.map((r) => `${r.kind}:${r.place_id}`).sort(), [`assert:${placeB}`, `reject:${placeA}`].sort());
      const written = await recordPlaceCorrections(memoryBridge({ flags: PROD_FLAGS }), { memoryId: m, ownerId: owner, source: "memory_edit", rows: rowsToRecord });
      assert.deepEqual(written, { ok: true, recorded: 2 });
      assert.equal(scalar(`SELECT string_agg(kind || ':' || place_id, ',' ORDER BY kind) FROM public.memory_corrections WHERE memory_id = '${m}'`), `assert:${placeB},reject:${placeA}`);
    });

    test("C2 a non-owner is shown the ASSERTED place even while the stored row still names A; the owner's own read is the stored row (H-16)", async () => {
      const sc = memoryBridge({ flags: PROD_FLAGS });
      const stored = rows<any>(`SELECT id, owner_id, place_id, canonical_location_id FROM public.memories WHERE id = '${m}'`);
      assert.equal(stored[0].place_id, placeA, "the row has not been rewritten — only the corrections say B");
      const forViewer = await placesForViewer(sc, stored, viewer, new Date());
      assert.equal(forViewer.ok, true);
      if (forViewer.ok) assert.equal((forViewer.rows[0] as any).place_id, placeB, "the correction outranks the stored reference (§4)");
      const forOwner = await placesForViewer(sc, stored, owner, new Date());
      if (forOwner.ok) assert.equal((forOwner.rows[0] as any).place_id, placeA);
    });

    test("C3 a rejected place is never shown to a non-owner while the stored row still names it, and the aggregate drops it", async () => {
      const sc = memoryBridge({ flags: PROD_FLAGS });
      const m2 = newMemory({ visibility: "public", place_id: placeA });
      const r = await recordPlaceCorrections(sc, { memoryId: m2, ownerId: owner, source: "correction_route", rows: [{ kind: "reject", place_id: placeA, canonical_location_id: null }] as any });
      assert.equal(r.ok, true, JSON.stringify(r));
      const forViewer = await placesForViewer(sc, rows<any>(`SELECT id, owner_id, place_id, canonical_location_id FROM public.memories WHERE id = '${m2}'`), viewer, new Date());
      assert.equal(forViewer.ok, true);
      if (forViewer.ok) assert.equal((forViewer.rows[0] as any).place_id, null, "the rejected reference is stripped, not shown");
      // The aggregate (Discovery's place-trend count) drops the disputed stored place (OD-1012-PRIV-3).
      const counted = await aggregateMemoryRows(sc, [{ id: m2, owner_id: owner, place_id: placeA, canonical_location_id: null }]);
      assert.deepEqual(counted, []);
    });

    test("C4 corrections are append-only, and refused on a deleted Memory (3673's guard, lead ruling H-13)", () => {
      assert.match(refusedAsService(`UPDATE public.memory_corrections SET kind = 'assert' WHERE memory_id = '${m}';`), /permission denied|append-only/);
      assert.match(refusedAsService(`DELETE FROM public.memory_corrections WHERE memory_id = '${m}';`), /append-only/);
      const gone = newMemory({ visibility: "public", place_id: placeA });
      asService(`UPDATE public.memories SET state = 'deleted' WHERE id = '${gone}';`);
      assert.match(refusedAsService(`INSERT INTO public.memory_corrections (memory_id, owner_id, field, kind, place_id, source) VALUES ('${gone}', '${owner}', 'place', 'reject', '${placeA}', 'memory_edit');`), /deleted/);
    });

    test("C5 no client role can read or write a correction", () => {
      for (const role of ["anon", "authenticated"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.memory_corrections', 'SELECT') OR has_table_privilege('${role}', 'public.memory_corrections', 'INSERT')`), "f");
      }
    });
  });

  // ── R: §11, the per-Memory controls ────────────────────────────────────────
  describe("R — per-Memory controls (H36, H88)", () => {
    test("R1 KEEP_PRIVATE_FOREVER is refused on a Memory that is not only_me, and while it stands the Memory cannot be widened (lead ruling H-7)", () => {
      const pub = newMemory({ visibility: "public" });
      assert.match(refusedAsService(`INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control) VALUES ('${pub}', '${owner}', 'KEEP_PRIVATE_FOREVER');`), /make this Memory only_me first/);
      const priv = newMemory({ visibility: "only_me" });
      asService(`INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control) VALUES ('${priv}', '${owner}', 'KEEP_PRIVATE_FOREVER');`);
      assert.match(refusedAsService(`UPDATE public.memories SET visibility = 'public' WHERE id = '${priv}';`), /KEEP_PRIVATE_FOREVER|kept_private|only_me/i);
      assert.equal(scalar(`SELECT visibility FROM public.memories WHERE id = '${priv}'`), "only_me");
    });

    test("R2 a control is set or cleared, never edited in place; no client role can reach it; an off-vocabulary control is refused", () => {
      const mm = newMemory({ visibility: "only_me" });
      asService(`INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control) VALUES ('${mm}', '${owner}', 'DO_NOT_RESURFACE');`);
      assert.match(refusedAsService(`UPDATE public.memory_resurfacing_preferences SET control = 'DO_NOT_INCLUDE_IN_RECAPS' WHERE memory_id = '${mm}';`), /permission denied/);
      assert.match(refusedAsService(`INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control) VALUES ('${mm}', '${owner}', 'HIDE_FOREVER');`), /check constraint/);
      for (const role of ["anon", "authenticated"]) {
        assert.equal(scalar(`SELECT has_table_privilege('${role}', 'public.memory_resurfacing_preferences', 'SELECT')`), "f");
      }
    });

    test("R3 the readers consult the stored controls: Compass and the graph drop DO_NOT_RESURFACE, personalization drops RETAIN_BUT_DO_NOT_PERSONALIZE", async () => {
      const sc = memoryBridge({ flags: PROD_FLAGS });
      const quiet = newMemory({ visibility: "public" });
      const noPersonal = newMemory({ visibility: "public" });
      const plain = newMemory({ visibility: "public" });
      asService(`INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control) VALUES
                   ('${quiet}', '${owner}', 'DO_NOT_RESURFACE'), ('${noPersonal}', '${owner}', 'RETAIN_BUT_DO_NOT_PERSONALIZE');`);
      const refs = [quiet, noPersonal, plain].map((id) => ({ id, owner_id: owner }));
      const compass = await excludedMemories(sc, "compass_tools", refs);
      assert.equal(compass.ok, true, JSON.stringify(compass));
      if (compass.ok) assert.deepEqual([...compass.excluded].sort(), [quiet, noPersonal].sort());
      assert.equal(await canUseForPersonalization(sc, owner, noPersonal), false);
      assert.equal(await canUseForPersonalization(sc, owner, plain), true);
    });

    test("R4 the trip recap leaves out a Memory marked DO_NOT_INCLUDE_IN_RECAPS, and its registration is a real row (H88)", async () => {
      const sc = memoryBridge({ flags: PROD_FLAGS });
      const trip = randomUUID();
      exec(`INSERT INTO public.trips (id, owner_id, title, destination_city) VALUES ('${trip}', '${owner}', '${TAG} trip', 'Hue');`);
      const inRecap = newMemory({ visibility: "only_me", trip_id: trip, starts_at: "2026-09-01T10:00:00Z" });
      const keptOut = newMemory({ visibility: "only_me", trip_id: trip, starts_at: "2026-09-01T11:00:00Z" });
      asService(`INSERT INTO public.memory_resurfacing_preferences (memory_id, owner_id, control) VALUES ('${keptOut}', '${owner}', 'DO_NOT_INCLUDE_IN_RECAPS');`);
      try {
        const built = await rebuildProjection(sc, "TripMemoryProjection", { owner_id: owner, viewer_id: owner, trip_id: trip }, new Date());
        assert.equal(built.ok, true, JSON.stringify(built));
        if (built.ok) assert.deepEqual(built.value.rows.map((r: any) => r.memory_id), [inRecap]);
        assert.equal(scalar(`SELECT count(*) FROM public.memory_derivative_registry WHERE projection_id = 'TripMemoryProjection' AND scope_key LIKE '%${trip}%'`), "1");
      } finally {
        exec(`DELETE FROM public.memory_derivative_registry WHERE scope_key LIKE '%${trip}%'; UPDATE public.memories SET trip_id = NULL WHERE trip_id = '${trip}'; DELETE FROM public.trips WHERE id = '${trip}';`);
      }
    });
  });
  // ── H: §17, the Highlight commands and events ──────────────────────────────
  describe("H — the Highlight commands and their events (H142, H143, H145, H155–H159)", () => {
    let hl = "";
    const events = (id: string) => scalar(`SELECT string_agg(type || '#' || sequence || ':' || coalesce(payload_json->>'command_type', '-'), ',' ORDER BY sequence) FROM public.${EVENTS} WHERE highlight_id = '${id}'`);
    const outboxRows = (id: string) => scalar(`SELECT count(*) FROM public.${OUTBOX} WHERE highlight_id = '${id}' AND published_at IS NULL`);
    const command = (commandType: string, highlightId: string | null, payload: Record<string, unknown>, key = randomUUID()) =>
      dispatchMemoryCommand<any>({
        sc: memoryBridge({ flags: PROD_FLAGS }), commandType: commandType as any, memoryId: null, highlightId, actorUserId: owner, idempotencyKey: key, payload,
        fromKernelResult: (r: any) => r,
        legacy: async () => { throw new Error("the legacy write must not run with memory_kernel_enabled ON"); },
      });

    test("H1 CREATE_HIGHLIGHT writes the Highlight with highlight.created and highlight.published in the creating transaction, and a replay is one Highlight", async () => {
      const key = randomUUID();
      const payload = { media_url: `post-media/${owner}/${TAG}.jpg`, media_type: "image", video_duration_seconds: null, caption: TAG, location_name: null, location_city: null, location_country: null, visibility: "public", expires_in_hours: 24, lifetime_class: null, filter_id: null, filter_intensity: null };
      const out = await command("CREATE_HIGHLIGHT", null, payload, key);
      assert.equal(out.ok, true, JSON.stringify(out));
      if (!out.ok) return;
      hl = String(out.body?.id ?? "");
      assert.match(hl, /^[0-9a-f-]{36}$/);
      assert.equal(scalar(`SELECT owner_id || '|' || visibility || '|' || (expires_at > now()) FROM public.highlights WHERE id = '${hl}'`), `${owner}|public|true`);
      assert.equal(events(hl), "highlight.created#1:CREATE_HIGHLIGHT,highlight.published#2:CREATE_HIGHLIGHT");
      assert.equal(outboxRows(hl), "2");
      const replay = await command("CREATE_HIGHLIGHT", null, payload, key);
      assert.equal(replay.ok && replay.duplicate, true);
      assert.equal(scalar(`SELECT count(*) FROM public.highlights WHERE owner_id = '${owner}' AND caption = '${TAG}'`), "1");
    });

    test("H2 PIN and UNPIN cross the kernel and each emits highlight.pinned (H142, H143, H158)", async () => {
      assert.equal((await command("PIN_HIGHLIGHT", hl, {})).ok, true);
      assert.equal(scalar(`SELECT pinned_at IS NOT NULL FROM public.highlights WHERE id = '${hl}'`), "t");
      assert.equal((await command("UNPIN_HIGHLIGHT", hl, {})).ok, true);
      assert.equal(scalar(`SELECT pinned_at IS NULL FROM public.highlights WHERE id = '${hl}'`), "t");
      assert.equal(events(hl), "highlight.created#1:CREATE_HIGHLIGHT,highlight.published#2:CREATE_HIGHLIGHT,highlight.pinned#3:PIN_HIGHLIGHT,highlight.pinned#4:UNPIN_HIGHLIGHT");
    });

    test("H3 HIDE and UNHIDE cross the kernel and each emits highlight.hidden; the reversible hide never touches deleted_at (H145, H159)", async () => {
      assert.equal((await command("HIDE_HIGHLIGHT", hl, {})).ok, true);
      assert.equal(scalar(`SELECT (archived_at IS NOT NULL) || '|' || (deleted_at IS NULL) FROM public.highlights WHERE id = '${hl}'`), "true|true");
      assert.equal((await command("UNHIDE_HIGHLIGHT", hl, {})).ok, true);
      assert.equal(scalar(`SELECT archived_at IS NULL FROM public.highlights WHERE id = '${hl}'`), "t");
      assert.match(events(hl) ?? "", /highlight\.hidden#5:HIDE_HIGHLIGHT,highlight\.hidden#6:UNHIDE_HIGHLIGHT$/);
    });

    test("H4 a stranger's PIN is refused and leaves no event", async () => {
      const out = await dispatchMemoryCommand<any>({
        sc: memoryBridge({ flags: PROD_FLAGS }), commandType: "PIN_HIGHLIGHT", memoryId: null, highlightId: hl, actorUserId: viewer, idempotencyKey: randomUUID(), payload: {},
        legacy: async () => { throw new Error("legacy must not run"); },
      });
      assert.equal(out.ok, false);
      assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE highlight_id = '${hl}'`), "6");
    });

    test("H5 the clock producer emits highlight.expired ONCE for an expired Highlight, and never for a pinned one (H157)", async () => {
      const pinned = await command("CREATE_HIGHLIGHT", null, { media_url: `post-media/${owner}/${TAG}-p.jpg`, media_type: "image", video_duration_seconds: null, caption: `${TAG}-p`, location_name: null, location_city: null, location_country: null, visibility: "public", expires_in_hours: 24, lifetime_class: null, filter_id: null, filter_intensity: null });
      assert.equal(pinned.ok, true);
      const pinnedId = pinned.ok ? String(pinned.body?.id) : "";
      assert.equal((await command("PIN_HIGHLIGHT", pinnedId, {})).ok, true);
      asService(`UPDATE public.highlights SET expires_at = now() - interval '1 minute' WHERE id IN ('${hl}', '${pinnedId}');`);
      const off = await runHighlightExpiryPass({ client: memoryBridge({ flags: { ...PROD_FLAGS, highlight_expiry_events_enabled: false } }) });
      assert.equal(off.reason, "disabled");
      const first = await runHighlightExpiryPass({ client: memoryBridge({ flags: PROD_FLAGS }) });
      assert.equal(first.skipped, false, JSON.stringify(first));
      assert.ok(first.emitted >= 1);
      assert.match(events(hl) ?? "", /highlight\.expired#7:-$/);
      assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE highlight_id = '${pinnedId}' AND type = 'highlight.expired'`), "0");
      await runHighlightExpiryPass({ client: memoryBridge({ flags: PROD_FLAGS }) });
      assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE highlight_id = '${hl}' AND type = 'highlight.expired'`), "1", "once");
      exec(`DELETE FROM public.${OUTBOX} WHERE highlight_id IN ('${hl}', '${pinnedId}');
            DELETE FROM public.${EVENTS} WHERE highlight_id IN ('${hl}', '${pinnedId}');
            DELETE FROM public.highlights WHERE id IN ('${hl}', '${pinnedId}');`);
    });
  });
});

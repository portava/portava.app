/**
 * The trip screen's structure composer, executed on the real chain: the
 * client's OWN command builders (travel-buddy-standalone
 * src/features/trips/planning/tripStructurePayloads.ts — stageCommand,
 * legCommand, commitmentCommand, goalCommand, which tripStructureEntries.ts
 * sends for every tap) run through `trip_kernel_execute`, so what is asserted
 * here is the row the product's tap leaves in `trip_stages`, `trip_legs`,
 * `trip_commitments` and `trip_goals`, not a payload this suite re-typed by
 * hand. The builders module is pure (no imports), so it loads here without the
 * app's network or React Native layers.
 *
 * census-trips TR78 (`trip_stages`), TR79 (`trip_legs`), TR81
 * (`trip_commitments`), TR84 (`trip_goals`). The lead's ruling of 2026-10-17: a
 * TABLE row is correct only when a product surface populates it. The surface is
 * TripStructureComposer on app/trip/[id].tsx; this suite is that surface's
 * command, applied.
 *
 * The HTTP door between the two (POST /trips/:tripId/commands, unflagged) is
 * pinned separately by tripCommandsEndpoint.test.ts; this suite stands in for
 * it the way localDb.ts's `kernel()` stands in for the service client.
 *
 * Runs in CI's kernel-SQL job (scripts/local-db/run-tests.sh). It skips without
 * LOCAL_DB_URL, and run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";
import {
  stageCommand, legCommand, commitmentCommand, goalCommand, nextStageSequence, type StructureCommand,
} from "../../../../../travel-buddy-standalone/src/features/trips/planning/tripStructurePayloads.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

type KernelAnswer = { ok: boolean; duplicate?: boolean; reason?: string; result?: { id?: string } };

describe("the trip screen's structure composer on the real chain (TR78, TR79, TR81, TR84)", { skip: SKIP }, () => {
  let owner = ""; let alice = ""; let stranger = ""; let tripId = ""; let otherTrip = ""; let foreignStage = "";
  const cityLisbon = randomUUID(); const cityPorto = randomUUID();

  /** One tap: the client's command, as the acting user, with the tap's key. */
  function tap(actor: string, cmd: StructureCommand, key: string = randomUUID()): KernelAnswer {
    assert.equal(cmd.ok, true, `the client refused its own input: ${JSON.stringify(cmd)}`);
    if (!cmd.ok) return { ok: false };
    return kernel(command({ actor_user_id: actor, trip_id: tripId, type: cmd.type, payload: cmd.payload, idempotency_key: key })) as KernelAnswer;
  }
  function added(r: KernelAnswer): string {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(typeof r.result?.id, "string", `no row id in ${JSON.stringify(r)}`);
    return r.result!.id!;
  }
  function refused(reason: string, r: KernelAnswer) {
    assert.equal(r.ok, false, `ACCEPTED: ${JSON.stringify(r)}`);
    assert.equal(r.reason, reason, JSON.stringify(r));
  }
  const version = () => Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
  const lastEvent = () => rows<{ type: string; family: string; aggregate_version: number }>(
    `SELECT type, payload_json->>'family' AS family, aggregate_version FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`,
  )[0]!;
  const count = (table: string) => Number(scalar(`SELECT count(*) FROM public.${table} WHERE trip_id = '${tripId}'`));
  const nextSequence = () => nextStageSequence(rows<{ sequence: number }>(`SELECT sequence FROM public.trip_stages WHERE trip_id = '${tripId}'`));
  const firstStages = () => rows<{ id: string }>(`SELECT id FROM public.trip_stages WHERE trip_id = '${tripId}' ORDER BY sequence LIMIT 2`).map((r) => r.id);

  before(() => {
    owner = seedUser("ps_owner"); alice = seedUser("ps_alice"); stranger = seedUser("ps_stranger");
    tripId = randomUUID(); otherTrip = randomUUID();
    const ok = (a: string, t: string, over: Record<string, unknown>) => {
      const r = kernel(command({ actor_user_id: a, trip_id: t, ...over })) as KernelAnswer;
      assert.equal(r.ok, true, JSON.stringify(r));
      return r;
    };
    ok(owner, tripId, { type: "CREATE_TRIP", payload: { title: "structure", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } });
    ok(owner, tripId, { type: "ADD_PARTICIPANT", payload: { user_id: alice, role: "member" } });
    ok(stranger, otherTrip, { type: "CREATE_TRIP", payload: { title: "elsewhere", destination_city: "Porto", destination_country: "Portugal", visibility: "private" } });
    foreignStage = String(ok(stranger, otherTrip, { type: "ADD_STAGE", payload: { stage_type: "city", city_id: cityPorto, timezone: "Europe/Lisbon", sequence: 1 } }).result?.id);
  });
  after(() => { for (const u of [owner, alice, stranger]) if (u) deleteUser(u); });

  it("ADD_STAGE as the composer builds it: the city anchor, the time zone and the next free position land; state defaults to planned; one event at the next version (TR78)", () => {
    const before = version();
    const id = added(tap(alice, stageCommand({ stageType: "city", cityId: cityLisbon, timezone: "Europe/Lisbon", sequence: nextSequence() })));
    const row = rows(`SELECT stage_type, place_id, city_id::text AS city_id, timezone, state, sequence, starts_at, ends_at FROM public.trip_stages WHERE id = '${id}' AND trip_id = '${tripId}'`)[0];
    assert.deepEqual(row, { stage_type: "city", place_id: null, city_id: cityLisbon, timezone: "Europe/Lisbon", state: "planned", sequence: 1, starts_at: null, ends_at: null });
    assert.equal(version(), before + 1, "the aggregate version moves exactly once");
    assert.deepEqual(lastEvent(), { type: "trip.stage_added", family: "stage", aggregate_version: before + 1 });
    const second = added(tap(alice, stageCommand({ stageType: "lodging", cityId: cityPorto, timezone: "Europe/Lisbon", sequence: nextSequence() })));
    assert.equal(scalar(`SELECT sequence FROM public.trip_stages WHERE id = '${second}'`), "2");
  });

  it("a position someone else just took is refused TRIP_STAGE_SEQUENCE_TAKEN, and nothing is written", () => {
    const n = count("trip_stages"); const v = version();
    refused("TRIP_STAGE_SEQUENCE_TAKEN", tap(owner, stageCommand({ stageType: "excursion", cityId: cityLisbon, timezone: "Europe/Lisbon", sequence: 1 })));
    assert.equal(count("trip_stages"), n);
    assert.equal(version(), v);
  });

  it("a retry with THE SAME key is the kernel's receipt, not a second stage", () => {
    const key = `structure-entry:stage:${randomUUID()}`;
    const cmd = stageCommand({ stageType: "transit", cityId: cityPorto, timezone: "Europe/Lisbon", sequence: nextSequence() });
    const first = tap(owner, cmd, key);
    const firstId = added(first);
    const n = count("trip_stages"); const v = version();
    const again = tap(owner, cmd, key);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.duplicate, true, "the second send was not answered from the receipt");
    assert.equal(again.result?.id, firstId, "the receipt names the first stage");
    assert.equal(count("trip_stages"), n, "a retry added a second stage");
    assert.equal(version(), v);
  });

  it("ADD_LEG as the composer builds it joins two of THIS trip's stages; another trip's stage is TRIP_STAGE_NOT_FOUND (TR79)", () => {
    const [s1, s2] = firstStages();
    const before = version();
    const id = added(tap(alice, legCommand({ legType: "train", fromStageId: s1!, toStageId: s2! })));
    assert.deepEqual(rows(`SELECT from_stage_id::text AS f, to_stage_id::text AS t, leg_type, starts_at, ends_at, source_ref FROM public.trip_legs WHERE id = '${id}' AND trip_id = '${tripId}'`)[0],
      { f: s1, t: s2, leg_type: "train", starts_at: null, ends_at: null, source_ref: null });
    assert.deepEqual(lastEvent(), { type: "trip.leg_added", family: "leg", aggregate_version: before + 1 });
    const n = count("trip_legs");
    refused("TRIP_STAGE_NOT_FOUND", tap(alice, legCommand({ legType: "bus", fromStageId: s1!, toStageId: foreignStage })));
    assert.equal(count("trip_legs"), n);
  });

  it("ADD_COMMITMENT as the composer builds it: with a stage, without one, and the chosen flexibility (TR81)", () => {
    const [s1] = firstStages();
    const before = version();
    const withStage = added(tap(alice, commitmentCommand({ type: "event", flexibility: "fixed", stageId: s1! })));
    assert.deepEqual(lastEvent(), { type: "trip.commitment_added", family: "commitment", aggregate_version: before + 1 });
    const bare = added(tap(alice, commitmentCommand({ type: "lodging", flexibility: "flexible", stageId: null })));
    assert.deepEqual(rows(`SELECT id::text AS id, stage_id::text AS stage_id, type, flexibility FROM public.trip_commitments WHERE trip_id = '${tripId}' AND id IN ('${withStage}', '${bare}') ORDER BY type`), [
      { id: withStage, stage_id: s1, type: "event", flexibility: "fixed" },
      { id: bare, stage_id: null, type: "lodging", flexibility: "flexible" },
    ]);
    const n = count("trip_commitments");
    refused("TRIP_STAGE_NOT_FOUND", tap(alice, commitmentCommand({ type: "meeting", flexibility: "shiftable", stageId: foreignStage })));
    assert.equal(count("trip_commitments"), n);
  });

  it("ADD_GOAL as the composer builds it: type, priority and scope land; a personal goal is the actor's and only the actor reads it (TR84)", () => {
    const before = version();
    const personal = added(tap(alice, goalCommand({ type: "rest", priority: "high", scope: "personal" })));
    assert.deepEqual(lastEvent(), { type: "trip.goal_added", family: "goal", aggregate_version: before + 1 });
    const shared = added(tap(owner, goalCommand({ type: "budget", priority: "low", scope: "shared" })));
    assert.deepEqual(rows(`SELECT type, priority, status, scope, owner_user_id::text AS owner FROM public.trip_goals WHERE id = '${personal}'`)[0],
      { type: "rest", priority: "high", status: "open", scope: "personal", owner: alice });
    assert.deepEqual(rows(`SELECT type, priority, status, scope, owner_user_id::text AS owner FROM public.trip_goals WHERE id = '${shared}'`)[0],
      { type: "budget", priority: "low", status: "open", scope: "shared", owner: null });
    assert.equal(Number(asUser(owner, `SELECT count(*) FROM public.trip_goals WHERE id = '${personal}';`)[0]), 0, "another crew member read a personal goal");
    assert.equal(Number(asUser(alice, `SELECT count(*) FROM public.trip_goals WHERE id = '${personal}';`)[0]), 1);
    assert.equal(Number(asUser(alice, `SELECT count(*) FROM public.trip_goals WHERE id = '${shared}';`)[0]), 1);
  });

  it("a non-member's tap is refused TRIP_AUTH_NOT_CREW for all four, and nothing is written", () => {
    const tables = ["trip_stages", "trip_legs", "trip_commitments", "trip_goals"];
    const before = tables.map(count);
    const [s1, s2] = firstStages();
    refused("TRIP_AUTH_NOT_CREW", tap(stranger, stageCommand({ stageType: "city", cityId: cityLisbon, timezone: "Europe/Lisbon", sequence: 99 })));
    refused("TRIP_AUTH_NOT_CREW", tap(stranger, legCommand({ legType: "walk", fromStageId: s1!, toStageId: s2! })));
    refused("TRIP_AUTH_NOT_CREW", tap(stranger, commitmentCommand({ type: "other", flexibility: "flexible", stageId: null })));
    refused("TRIP_AUTH_NOT_CREW", tap(stranger, goalCommand({ type: "safety", priority: "normal", scope: "shared" })));
    assert.deepEqual(tables.map(count), before);
  });

  it("the unflagged /structure reader's exact select lists read back what the composer wrote, and crew — not a stranger — read the spine through RLS", () => {
    // routes/tripStructure.ts's three literals, through the service client.
    const stages = rows(`SELECT id, stage_type, place_id, city_id, timezone, starts_at, ends_at, state, sequence FROM public.trip_stages WHERE trip_id = '${tripId}' ORDER BY sequence`);
    const legs = rows(`SELECT id, from_stage_id, to_stage_id, leg_type, starts_at, ends_at, source_ref FROM public.trip_legs WHERE trip_id = '${tripId}'`);
    const commitments = rows(`SELECT id, stage_id, type, starts_at, required_arrival_at, place_id, lateness_tolerance, prep_duration, flexibility, confidence, source_ref FROM public.trip_commitments WHERE trip_id = '${tripId}'`);
    assert.ok(stages.length >= 3, `stages served: ${stages.length}`);
    assert.ok(legs.length >= 1 && commitments.length >= 2, `legs ${legs.length}, commitments ${commitments.length}`);
    for (const crew of [owner, alice]) {
      assert.equal(Number(asUser(crew, `SELECT count(*) FROM public.trip_stages WHERE trip_id = '${tripId}';`)[0]), stages.length);
      assert.equal(Number(asUser(crew, `SELECT count(*) FROM public.trip_legs WHERE trip_id = '${tripId}';`)[0]), legs.length);
    }
    assert.equal(Number(asUser(stranger, `SELECT count(*) FROM public.trip_stages WHERE trip_id = '${tripId}';`)[0]), 0);
    assert.equal(Number(asUser(stranger, `SELECT count(*) FROM public.trip_commitments WHERE trip_id = '${tripId}';`)[0]), 0);
  });
});

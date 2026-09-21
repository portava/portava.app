/**
 * census-compass CCL-13 — "revalidate expiring evidence when an action is
 * taken, rather than treating conversational history as current authority".
 *
 * Before this suite `applyProposal` re-verified the TRIP STATE at confirm —
 * settings, lock type, membership — and executed against whatever EVIDENCE
 * had motivated the proposal when it was created, however long ago. A timing
 * conflict that had already been resolved by hand, a meetup that had been
 * un-cancelled, a forecast that had cleared: the repair for it still ran.
 *
 * The rule pinned here: the issue the proposal repairs is RECOMPUTED at
 * confirm from live inputs, and the proposal executes only if that issue is
 * still present. Evidence that cannot be recomputed (a simulated disruption
 * has no live source) is reported as `not_revalidated`, never dressed up as
 * `holds`.
 *
 * Driven over the shared table-backed fake with the Trip Kernel flag ON and a
 * fake `trip_kernel_execute` (see withKernel below). It used to run with the
 * flag ABSENT, over the legacy direct write; census-compass CT-01 deleted that
 * write, so the kernel path is now the only way a change executes at all and
 * the flag has to be on for these cases to reach their own question. The
 * evidence gate still sits before the kernel gate, so an expired proposal is
 * refused for its evidence either way — pinned below and again in
 * compassAutopilotKernelPath.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassAutopilotRevalidation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyProposal } from "../compass/CompassAutopilotEngine.js";
import { makeClient } from "./highlightRouteHarness.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRIP = "11111111-0000-4000-8000-000000000001";
const USER = "22222222-0000-4000-8000-000000000002";
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const P = "cccccccc-0000-4000-8000-00000000000c";

function item(id: string, title: string, startsAt: string, endsAt: string) {
  return {
    id, trip_id: TRIP, title, category: "activity", status: "planned", lock_type: "flexible",
    day_date: "2026-10-01", starts_at: startsAt, ends_at: endsAt, location_name: null, lat: null, lng: null,
    source_type: "manual", source_id: null, sort_order: 0, removed_at: null,
  };
}

/** A (10:00–11:00) overlapped by B (10:30–11:30): the conflict `timing:A:B`, keyed on the proposal as `fix:timing:A:B`. */
function overlapping() {
  return [item(A, "Museum", "2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z"), item(B, "Lunch", "2026-10-01T10:30:00.000Z", "2026-10-01T11:30:00.000Z")];
}
/** The same two items with B already moved to 13:00 — the conflict is gone. */
function resolved() {
  return [item(A, "Museum", "2026-10-01T10:00:00.000Z", "2026-10-01T11:00:00.000Z"), item(B, "Lunch", "2026-10-01T13:00:00.000Z", "2026-10-01T14:00:00.000Z")];
}

/**
 * census-compass CT-01 removed applyProposal's direct `trip_plan_items` write,
 * so a change now EXECUTES only as a Trip Kernel command. The shared harness
 * does not model `trip_kernel_execute` (`rpc not modelled`), so this suite
 * wraps the client with a fake function that applies the command's patch to the
 * store — which is what the real kernel does, and what these cases need in
 * order to keep asserting that a live issue's repair actually runs. The flag is
 * seeded ON for the same reason: with it off every case below would be refused
 * for the flag and CCL-13's own question would never be reached.
 *
 * The flag-OFF refusal is pinned in compassAutopilotKernelPath.test.ts.
 */
function withKernel(sc: any) {
  sc.rpc = async (name: string, args: any) => {
    if (name !== "trip_kernel_execute") return { data: null, error: { message: "rpc not modelled" } };
    const cmd = args?.p_command ?? {};
    const patch = (cmd.payload?.patch ?? {}) as Record<string, unknown>;
    for (const r of sc._store.trip_plan_items ?? []) if (r.id === cmd.payload?.item_id) Object.assign(r, patch);
    return { data: { ok: true, duplicate: false, version: 2, event_id: "e1", sequence: 1, result: null, contract_version: 2 }, error: null };
  };
  return sc;
}

function state(items: any[]) {
  return {
    feature_flags: [{ flag: "trip_kernel_enabled", enabled: true }],
    trips: [{ id: TRIP, destination_city: null, start_date: "2026-10-01", end_date: "2026-10-03" }],
    trip_plan_items: items,
    trip_autopilot_settings: [],
    meetups: [],
  };
}

/** The repair a timing conflict produces: move B to 13:00. */
const MOVE_B = [{ itemId: B, title: "Lunch", lockType: "flexible", before: { startsAt: "2026-10-01T10:30:00.000Z" }, after: { startsAt: "2026-10-01T13:00:00.000Z", endsAt: "2026-10-01T14:00:00.000Z" } }];

describe("CCL-13 — the issue a proposal repairs is recomputed at confirm", () => {
  it("POSITIVE CONTROL: the conflict still holds → the change is applied", async () => {
    const sc = withKernel(makeClient(state(overlapping())));
    const r = await applyProposal(sc as any, { id: P, trip_id: TRIP, user_id: USER, issue_type: "timing_conflict", dedupe_key: `fix:timing:${A}:${B}`, changes: MOVE_B });
    assert.equal(r.applied, 1, JSON.stringify(r));
    assert.deepEqual(r.blocked, []);
    assert.equal(r.evidence, "holds");
    assert.equal(sc._store.trip_plan_items.find((i: any) => i.id === B)?.starts_at, "2026-10-01T13:00:00.000Z");
  });

  it("the conflict was resolved by hand since the proposal → NOTHING is applied, and the reason says why", async () => {
    const sc = withKernel(makeClient(state(resolved())));
    const before = JSON.stringify(sc._store.trip_plan_items);
    const r = await applyProposal(sc as any, { id: P, trip_id: TRIP, user_id: USER, issue_type: "timing_conflict", dedupe_key: `fix:timing:${A}:${B}`, changes: MOVE_B });
    assert.equal(r.applied, 0, JSON.stringify(r));
    assert.equal(r.evidence, "expired");
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0]!, /no longer holds/);
    assert.equal(JSON.stringify(sc._store.trip_plan_items), before, "a plan item was written on expired evidence");
  });

  it("a proposal whose evidence has no live source (simulated disruption) executes and SAYS it was not revalidated", async () => {
    const sc = withKernel(makeClient(state(overlapping())));
    const r = await applyProposal(sc as any, { id: P, trip_id: TRIP, user_id: USER, issue_type: "disruption_recovery", dedupe_key: `fix:cancelled:${A}`, changes: MOVE_B });
    assert.equal(r.applied, 1, JSON.stringify(r));
    assert.equal(r.evidence, "not_revalidated");
  });

  it("a proposal row written before the key existed (no dedupe_key) is not revalidated, and says so rather than pretending", async () => {
    const sc = withKernel(makeClient(state(resolved())));
    const r = await applyProposal(sc as any, { id: P, trip_id: TRIP, user_id: USER, issue_type: "timing_conflict", changes: MOVE_B });
    assert.equal(r.evidence, "not_revalidated");
  });

  it("the confirm route selects the key the revalidation needs and puts the verdict on the wire", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const route = strip(readFileSync(join(SRC, "routes", "compassAutopilot.ts"), "utf8"));
    assert.match(route, /select\("id, trip_id, user_id, issue_type, reason, changes, status, dedupe_key"\)/);
    assert.match(route, /evidence/);
  });
});

/*
 * ── MUTATION LOG (2026-09-19) ────────────────────────────────────────────────
 * Before the gate: 0 pass / 5 fail. After: 5 / 0, and compass-autopilot.test.ts
 * (which drives the same confirm route end to end) 12 / 0. Each applied alone:
 *   M1 the `expired` early-return removed .......... 1 red
 *   M2 every proposal reads as `holds` ............. 2 red
 *   M3 presence never recomputed (always true) ..... 1 red
 *   M4 the `fix:` prefix not stripped .............. 3 red (incl. the route suite's confirm)
 */

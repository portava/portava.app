/**
 * census-compass CT-01 — "No Compass component may independently invent
 * canonical trip state; consequential changes pass through the Trip Kernel."
 * (Trips spec `:12`.)
 *
 * THE RESIDUAL THIS SUITE CLOSES
 * ==============================
 * The row's evidence named three Compass write sites. Two of them —
 * `trip_autopilot_settings` and `trip_autopilot_proposals` — are COMPASS'S OWN
 * tables: writing them invents no canonical trip state and is not the
 * violation. The third was: `CompassAutopilotEngine.applyProposal` wrote
 * `trip_plan_items` — a canonical Trip aggregate table — directly, as the
 * flag-off twin of its kernel command.
 *
 * `trip_kernel_enabled` is FALSE on production and on CI, so that twin was not
 * a dormant fallback: it was THE path every confirm actually took. A kernel
 * command nobody reaches closes nothing. This suite pins the residual shut:
 *
 *   1. kernel ON  → every applied change is a trip_kernel_execute command and
 *      NOTHING touches trip_plan_items directly.
 *   2. kernel OFF → the confirm REFUSES, names the kernel as the reason, and
 *      writes no canonical row at all. There is no direct-write fallback,
 *      because that fallback IS the violation CT-01 names.
 *   3. the confirm route does not record a refused confirm as `confirmed`:
 *      the proposal stays `pending` and the response is a 503, so the user can
 *      retry the same confirm once an operator flips the flag.
 *   4. the guarantees that were already right stay right on the new path: the
 *      permission and lock-type re-verification at confirm, and the
 *      idempotency key `autopilot:<proposal>:<item>` handed to the KERNEL
 *      rather than re-invented beside it.
 *
 * WHY REFUSING IS SAFE TO SHIP WITH THE FLAG OFF
 * ==============================================
 * The census records "Production: 0 rows in both autopilot tables" — no live
 * user is mid-flight on this path, so no confirm that works today starts
 * failing. Refusing is strictly better than a silent direct write: the user is
 * told the truth, the proposal survives for a retry, and the canonical table is
 * never written by a component that is not the kernel.
 *
 * TEST-FIRST: every case below was written and watched FAIL before
 * CompassAutopilotEngine.ts / routes/compassAutopilot.ts were touched. The
 * MUTATION LOG at the foot of this file records what was then broken, one
 * mutation at a time, to prove each case still bites.
 *
 * Runtime: node:test + node:assert. No real DB, no network: the fake client
 * models exactly the reads applyProposal makes, plus `rpc(trip_kernel_execute)`,
 * and RECORDS every write, so "nothing was written" is an assertion and not an
 * absence of evidence.
 *
 * Run: cd artifacts/api-server && SUPABASE_URL=http://127.0.0.1:9 \
 *   SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test \
 *   src/test/compassAutopilotKernelPath.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pino from "pino";

import { applyProposal } from "../compass/CompassAutopilotEngine.js";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import compassAutopilotRouter from "../routes/compassAutopilot.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TRIP = "11111111-0000-4000-8000-000000000001";
const USER = "22222222-0000-4000-8000-000000000002";
const ITEM = "aaaaaaaa-0000-4000-8000-00000000000a";
const PROPOSAL = "cccccccc-0000-4000-8000-00000000000c";

/* ── Fake Supabase client ──────────────────────────────────────────────────── */
type Row = Record<string, unknown>;

interface Recorded {
  /** Every `.from(table).insert|update|upsert|delete` this run performed. */
  writes: Array<{ table: string; verb: string; payload: unknown }>;
  /** Every `rpc(name, args)` this run performed. */
  rpcs: Array<{ name: string; args: any }>;
}

interface FakeClient {
  from: (t: string) => any;
  rpc: (n: string, a: any) => Promise<{ data: any; error: any }>;
  auth: any;
  _rec: Recorded;
  _store: Record<string, Row[]>;
}

/**
 * The fake `trip_kernel_execute` applies the command's patch to the canonical
 * table ITSELF, so "the item moved" can be asserted on the kernel path while
 * the engine is proven never to have written a row — which is the whole point
 * of the row.
 */
function makeClient(store: Record<string, Row[]>, opts: { kernelOk?: boolean } = {}): FakeClient {
  const rec: Recorded = { writes: [], rpcs: [] };
  const kernelOk = opts.kernelOk !== false;

  function tbl(name: string): Row[] {
    if (!store[name]) store[name] = [];
    return store[name]!;
  }

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let pending: { verb: string; payload: any } | null = null;

    const matching = () => tbl(table).filter((r) => filters.every((f) => f(r)));

    function flush(): void {
      if (!pending) return;
      const { verb, payload } = pending;
      pending = null;
      if (verb === "insert" || verb === "upsert") {
        for (const row of Array.isArray(payload) ? payload : [payload]) tbl(table).push({ ...row });
      } else if (verb === "update") {
        for (const r of matching()) Object.assign(r, payload as Row);
      } else if (verb === "delete") {
        const doomed = new Set(matching());
        store[table] = tbl(table).filter((r) => !doomed.has(r));
      }
    }

    const api: any = {
      select: () => api,
      eq: (col: string, v: unknown) => { filters.push((r) => r[col] === v); return api; },
      neq: (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return api; },
      is: (col: string, v: unknown) => { filters.push((r) => (r[col] ?? null) === v); return api; },
      like: (col: string, pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
        filters.push((r) => re.test(String(r[col] ?? "")));
        return api;
      },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => { flush(); return { data: matching()[0] ?? null, error: null }; },
      single: async () => { flush(); return { data: matching()[0] ?? null, error: null }; },
      then: (ok: any, bad: any) => {
        flush();
        return Promise.resolve({ data: matching(), error: null }).then(ok, bad);
      },
    };
    for (const verb of ["insert", "update", "upsert", "delete"] as const) {
      api[verb] = (payload?: unknown) => {
        rec.writes.push({ table, verb, payload });
        pending = { verb, payload };
        return api;
      };
    }
    return api;
  }

  return {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: any) => {
      rec.rpcs.push({ name, args });
      if (name !== "trip_kernel_execute") return { data: null, error: { message: "rpc not modelled" } };
      if (!kernelOk) return { data: { ok: false, reason: "TRIP_AUTH_NOT_CREW", contract_version: 2 }, error: null };
      const cmd = args?.p_command ?? {};
      const patch = (cmd.payload?.patch ?? {}) as Row;
      for (const r of tbl("trip_plan_items")) if (r.id === cmd.payload?.item_id) Object.assign(r, patch);
      return {
        data: { ok: true, duplicate: false, version: 2, event_id: "evt-1", sequence: 1, result: null, contract_version: 2 },
        error: null,
      };
    },
    auth: { getUser: async (token: string) => (token === "valid-token" ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    _rec: rec,
    _store: store,
  };
}

function planItem(over: Row = {}): Row {
  return {
    id: ITEM, trip_id: TRIP, title: "Gallery", category: "activity", status: "planned",
    lock_type: "flexible", day_date: "2026-10-01", starts_at: "2026-10-01T10:00:00.000Z",
    ends_at: "2026-10-01T11:00:00.000Z", location_name: null, lat: null, lng: null,
    source_type: "manual", source_id: null, sort_order: 0, removed_at: null, ...over,
  };
}

/**
 * `trip_kernel_enabled` present and TRUE is the ONLY way the kernel path opens
 * (lib/featureFlags.isFlagEnabled is fail-closed). Absent = production and CI.
 */
function state(opts: { kernelFlag?: boolean; item?: Row; settings?: Row[] } = {}): Record<string, Row[]> {
  const feature_flags: Row[] = [{ flag: "COMPASS_ENABLED", enabled: true }];
  if (opts.kernelFlag !== undefined) feature_flags.push({ flag: "trip_kernel_enabled", enabled: opts.kernelFlag });
  return {
    feature_flags,
    trips: [{ id: TRIP, owner_id: USER, destination_city: null, start_date: "2026-10-01", end_date: "2026-10-03", plan_edit_permission: "all_members" }],
    trip_plan_items: [opts.item ?? planItem()],
    trip_autopilot_settings: opts.settings ?? [],
    trip_members: [{ trip_id: TRIP, user_id: USER, role: "owner", status: "accepted" }],
    meetups: [],
  };
}

/** Move the gallery to 13:00 — a MOVE_PLAN-shaped change, no status transition. */
const MOVE = [{
  itemId: ITEM, title: "Gallery", lockType: "flexible" as const,
  before: { startsAt: "2026-10-01T10:00:00.000Z" },
  after: { startsAt: "2026-10-01T13:00:00.000Z", endsAt: "2026-10-01T14:00:00.000Z" },
}];

/**
 * `disruption_recovery` has no live source to recompute, so CCL-13's evidence
 * gate answers `not_revalidated` and no case below turns on it — except the one
 * that deliberately does.
 */
const proposal = () => ({
  id: PROPOSAL, trip_id: TRIP, user_id: USER,
  issue_type: "disruption_recovery", dedupe_key: `fix:cancelled:${ITEM}`, changes: MOVE,
});

const canonicalWrites = (sc: FakeClient) => sc._rec.writes.filter((w) => w.table === "trip_plan_items");
const commands = (sc: FakeClient) => sc._rec.rpcs.filter((c) => c.name === "trip_kernel_execute");
const theItem = (sc: FakeClient) => sc._store.trip_plan_items!.find((r) => r.id === ITEM)!;

/* ── 1. Kernel ON: the command IS the write ────────────────────────────────── */

describe("CT-01 — with the kernel on, a confirmed proposal moves the item BY COMMAND", () => {
  it("issues trip_kernel_execute and writes no canonical row itself", async () => {
    const sc = makeClient(state({ kernelFlag: true }));
    const r = await applyProposal(sc as any, proposal() as any);

    assert.equal(r.applied, 1, JSON.stringify(r));
    assert.deepEqual(r.blocked, []);
    assert.equal(r.kernelAvailable, true);

    const cmds = commands(sc);
    assert.equal(cmds.length, 1, "exactly one command per changed item");
    assert.equal(cmds[0]!.args.p_command.type, "MOVE_PLAN", "a time change is §3.3's MOVE_PLAN");
    assert.equal(cmds[0]!.args.p_command.trip_id, TRIP);
    assert.equal(cmds[0]!.args.p_command.actor_user_id, USER, "the actor is the proposal's owner");
    assert.equal(cmds[0]!.args.p_command.payload.item_id, ITEM);

    assert.deepEqual(canonicalWrites(sc), [], "Compass wrote trip_plan_items directly — CT-01");
    // And the move really happened — through the kernel.
    assert.equal(theItem(sc).starts_at, "2026-10-01T13:00:00.000Z");
  });

  it("hands the KERNEL the idempotency key `autopilot:<proposal>:<item>` — not a second scheme", async () => {
    const sc = makeClient(state({ kernelFlag: true }));
    await applyProposal(sc as any, proposal() as any);
    assert.equal(
      commands(sc)[0]!.args.p_command.idempotency_key,
      `autopilot:${PROPOSAL}:${ITEM}`,
      "the key the census pins must reach trip_kernel_execute, where the receipt is persisted",
    );
  });

  it("a kernel REFUSAL is reported, never quietly retried as a direct write", async () => {
    const sc = makeClient(state({ kernelFlag: true }), { kernelOk: false });
    const r = await applyProposal(sc as any, proposal() as any);
    assert.equal(r.applied, 0, JSON.stringify(r));
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0]!, /TRIP_AUTH_NOT_CREW/);
    assert.deepEqual(canonicalWrites(sc), [], "a refused command fell back to a direct write — CT-01");
    assert.equal(theItem(sc).starts_at, "2026-10-01T10:00:00.000Z", "the item moved although the kernel refused");
  });
});

/* ── 2. Kernel OFF: honest refusal, never a direct write ───────────────────── */

describe("CT-01 — with the kernel off (production and CI today), the confirm REFUSES", () => {
  it("applies nothing, says the kernel is why, and writes no canonical row", async () => {
    const sc = makeClient(state()); // trip_kernel_enabled absent => fail-closed false
    const before = JSON.stringify(sc._store.trip_plan_items);
    const r = await applyProposal(sc as any, proposal() as any);

    assert.equal(r.applied, 0, JSON.stringify(r));
    assert.equal(r.kernelAvailable, false, "the refusal must be legible to the route, not inferred");
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0]!, /Trip Kernel/i, "the reason must name the kernel, not a generic failure");

    assert.deepEqual(
      canonicalWrites(sc), [],
      "the flag-off direct write to trip_plan_items is back — that fallback IS the CT-01 violation",
    );
    assert.equal(JSON.stringify(sc._store.trip_plan_items), before, "a canonical row changed with the kernel off");
    assert.deepEqual(commands(sc), [], "no command was issued either — there is no kernel to issue it to");
  });

  it("an EXPIRED proposal is still refused for its EVIDENCE, not for the flag", async () => {
    // CCL-13 keeps its own voice: the evidence gate runs before the kernel gate,
    // so the user is told the real reason.
    const sc = makeClient(state());
    const r = await applyProposal(sc as any, {
      ...proposal(), issue_type: "timing_conflict", dedupe_key: "fix:timing:x:y",
    } as any);
    assert.equal(r.evidence, "expired");
    assert.match(r.blocked[0]!, /no longer holds/);
    assert.deepEqual(canonicalWrites(sc), []);
  });
});

/* ── 3. The guarantees that were already right stay right ──────────────────── */

describe("CT-01 — confirm-time re-verification survives the move onto the kernel", () => {
  it("an item re-typed to FIXED since the proposal is refused for being Fixed — kernel ON", async () => {
    const sc = makeClient(state({ kernelFlag: true, item: planItem({ lock_type: "fixed" }) }));
    const r = await applyProposal(sc as any, proposal() as any);
    assert.equal(r.applied, 0, JSON.stringify(r));
    assert.match(r.blocked[0]!, /is Fixed/, "the lock-type re-check must still be what refuses this");
    assert.deepEqual(commands(sc), [], "a Fixed item must never reach the kernel at all");
  });

  it("a permission the user has since withdrawn is refused for the PERMISSION — kernel ON", async () => {
    const sc = makeClient(state({
      kernelFlag: true,
      settings: [{ trip_id: TRIP, user_id: USER, enabled: true, allow_move_flexible: false, allow_move_optional: true, allow_remove_optional: false }],
    }));
    const r = await applyProposal(sc as any, proposal() as any);
    assert.equal(r.applied, 0, JSON.stringify(r));
    assert.match(r.blocked[0]!, /not permitted by your autopilot settings/);
    assert.deepEqual(commands(sc), [], "an unpermitted move must never reach the kernel");
  });

  it("the same two re-checks are what refuse with the kernel OFF too, by their own names", async () => {
    // Without this, deleting the lock-type re-check would be invisible on the
    // path CI actually runs: with the flag off everything is refused anyway, so
    // the refusal has to be the RIGHT one.
    const fixed = makeClient(state({ item: planItem({ lock_type: "fixed" }) }));
    assert.match((await applyProposal(fixed as any, proposal() as any)).blocked[0]!, /is Fixed/,
      "the kernel gate short-circuited the lock-type re-check");

    const unpermitted = makeClient(state({
      settings: [{ trip_id: TRIP, user_id: USER, enabled: true, allow_move_flexible: false, allow_move_optional: true, allow_remove_optional: false }],
    }));
    assert.match((await applyProposal(unpermitted as any, proposal() as any)).blocked[0]!, /not permitted/,
      "the kernel gate short-circuited the permission re-check");
  });
});

/* ── 4. The route records a refused confirm honestly ───────────────────────── */

describe("CT-01 — a confirm the kernel could not carry out is not recorded as `confirmed`", () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = pino({ level: "silent" }); next(); });
  app.use("/api", compassAutopilotRouter);

  let server: Server;
  let base: string;
  let sc: FakeClient;

  before(async () => {
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });

  function seed(kernelFlag?: boolean): void {
    invalidateFlagsCache();
    const s = state(kernelFlag === undefined ? {} : { kernelFlag });
    s.trip_autopilot_proposals = [{
      id: PROPOSAL, trip_id: TRIP, user_id: USER, issue_type: "disruption_recovery",
      reason: "recovery", changes: MOVE, status: "pending", dedupe_key: `fix:cancelled:${ITEM}`,
    }];
    sc = makeClient(s, {});
    _setTestClient(sc, true);
  }

  const confirm = async () => {
    const res = await fetch(`${base}/autopilot/proposals/${PROPOSAL}/confirm`, {
      method: "POST",
      headers: { Authorization: "Bearer valid-token", "Content-Type": "application/json" },
      body: "{}",
    });
    return { status: res.status, json: (await res.json()) as any };
  };

  beforeEach(() => seed());

  it("kernel OFF → 503, the proposal stays PENDING, and no canonical row is touched", async () => {
    const r = await confirm();

    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.reason, "TRIP_KERNEL_UNAVAILABLE");
    assert.equal(r.json.status, "pending", "a confirm that changed nothing must not be recorded as confirmed");
    assert.equal(r.json.applied, 0);
    assert.match(String(r.json.blocked?.[0] ?? ""), /Trip Kernel/i);

    const row = sc._store.trip_autopilot_proposals![0]!;
    assert.equal(row.status, "pending", "the proposal was resolved although nothing was applied");
    assert.equal(row.resolved_at, undefined, "a resolved_at was stamped on a confirm that did nothing");
    assert.deepEqual(canonicalWrites(sc), [], "the confirm route reached a canonical table — CT-01");
  });

  it("kernel ON → 200, applied, and the proposal is resolved `confirmed`", async () => {
    seed(true);
    const r = await confirm();
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.status, "confirmed");
    assert.equal(r.json.applied, 1);
    assert.equal(commands(sc).length, 1, "the confirm went through the kernel");
    assert.deepEqual(canonicalWrites(sc), []);
    assert.equal(sc._store.trip_autopilot_proposals![0]!.status, "confirmed");
  });
});

/* ── 5. The write site the census named is gone from the source ────────────── */

describe("CT-01 — the direct canonical write no longer exists in the source", () => {
  it("CompassAutopilotEngine.ts writes no canonical Trip table directly", () => {
    const src = readFileSync(join(SRC, "compass", "CompassAutopilotEngine.ts"), "utf8");
    for (const table of ["trip_plan_items", "trips", "trip_members"]) {
      const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,240}?\\.(update|insert|upsert|delete)\\s*\\(`);
      assert.equal(re.test(src), false, `CompassAutopilotEngine writes ${table} directly — CT-01`);
    }
    assert.equal(src.includes("trip-kernel:legacy-path"), false,
      "the legacy-path marker outlived the legacy path it annotated");
  });

  it("routes/compassAutopilot.ts writes no canonical Trip table directly either", () => {
    const src = readFileSync(join(SRC, "routes", "compassAutopilot.ts"), "utf8");
    for (const table of ["trip_plan_items", "trips", "trip_members"]) {
      const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)[\\s\\S]{0,240}?\\.(update|insert|upsert|delete)\\s*\\(`);
      assert.equal(re.test(src), false, `routes/compassAutopilot writes ${table} directly — CT-01`);
    }
  });

  it("the §24 ratchet baseline records the autopilot engine at ZERO direct writes", () => {
    const baseline = readFileSync(join(SRC, "scripts", "tripKernelWriterBaseline.ts"), "utf8");
    assert.match(baseline, /"compass\/CompassAutopilotEngine\.ts":\s*\{\s*direct:\s*0/,
      "the baseline still allows a direct write the engine no longer has — lower it");
  });
});

/*
 * ── MUTATION LOG (2026-09-20) ────────────────────────────────────────────────
 * TEST-FIRST: written before the implementation. Red at the start — 8 pass /
 * 5 fail — on exactly the residual, and for the right reasons: `kernelAvailable`
 * absent, the flag-off path APPLYING the change through the direct write, the
 * confirm route answering 200 `confirmed` for a change it had not made, the
 * `.from("trip_plan_items").update(` still in the engine, and the ratchet
 * baseline still allowing it. Green after: 13 / 0.
 *
 * Each mutation applied ALONE to the restored source, the suites re-run, the
 * source restored before the next. Suites: K = this file,
 * A = compass-autopilot.test.ts, R = compassAutopilotRevalidation.test.ts,
 * T = tripKernel.test.ts.
 *
 *   M1  the direct `trip_plan_items` write reinstated as the flag-off
 *       fallback (the CT-01 violation itself) ....... RED  K 3, T 1 (A, R green)
 *   M2  the idempotency key replaced with randomUUID()
 *       instead of `autopilot:<proposal>:<item>` .... RED  K 1
 *   M3  the lock-type and permission re-verification
 *       at confirm deleted ......................... RED  K 3, A 1
 *   M4  the route's kernel-unavailable refusal
 *       skipped, so a confirm that changed nothing
 *       is recorded `confirmed` .................... RED  K 1
 *   M5  `kernelAvailable` hard-coded true ........... RED  K 2
 *   M6  the §24 ratchet baseline left at direct: 1 .. RED  K 1 — and T GREEN.
 *       Reported, not hidden: checkTripKernelWriters.judge() skips a file with
 *       zero writes before the `shrank` comparison, so a stale entry lands in
 *       `vanished`, which tripKernel.test.ts does not assert on and the check
 *       prints only as advice. K is the only thing that makes a stale baseline
 *       fail, which is why the assertion is there.
 *
 * None green. A, R and T are listed wherever they moved so it is visible which
 * guarantees they still carry and which ones only this suite holds.
 */

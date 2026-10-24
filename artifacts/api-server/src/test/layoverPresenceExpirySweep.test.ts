/**
 * census-layover L196, presence half — `lib/layoverPresenceExpiryScheduler.ts`
 * (layover lane 5, 2026-10-18).
 *
 * "Create presence/crew tables with restrictive policies and expiration jobs."
 * The crew job exists (layoverCrewExpirySweep.test.ts); this pins the presence
 * job over 3900's `layover_presence`. Both halves:
 *   - 3900 applied (the double carries the table): every row whose `expires_at`
 *     has passed is deleted, the unexpired ones are kept, the count is what the
 *     database confirmed, and the batch bound is honoured;
 *   - 3900 unapplied (production today): the probe answers absent and NOTHING
 *     beyond the probe is issued — no due-row read, no DELETE — and that resting
 *     state never counts as a failure.
 * And the registration: index.ts starts it, so it is not an exported function
 * nothing calls.
 *
 * Run: node --import tsx/esm --test src/test/layoverPresenceExpirySweep.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import {
  runLayoverPresenceExpirySweep,
  runLayoverPresenceExpiryTick,
  layoverPresenceExpiryFailureState,
  _resetLayoverPresenceExpiryFailureState,
  startLayoverPresenceExpiryScheduler,
  stopLayoverPresenceExpiryScheduler,
} from "../lib/layoverPresenceExpiryScheduler.js";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function presence(session_id: string, expiresInMin: number): Record<string, any> {
  return {
    session_id, user_id: `user-${session_id}`, visibility_scope: "intent", intents: ["food"],
    available_from: at(-120), available_until: at(expiresInMin), max_travel_minutes: null,
    precise_location_enabled: false, expires_at: at(expiresInMin), created_at: at(-120), updated_at: at(-120),
  };
}

/** Records every table and operation the sweep issues. */
function recorded(t: Record<string, any[]>, opts: Parameters<typeof makeLayoverDb>[1] = {}) {
  const db = makeLayoverDb(on(t), opts) as any;
  const ops: string[] = [];
  const wrap = (name: string) => {
    const b = db.from(name);
    for (const op of ["select", "delete", "insert", "update", "upsert"]) {
      const orig = b[op];
      b[op] = (...a: any[]) => { ops.push(`${name}:${op}`); return orig(...a); };
    }
    return b;
  };
  return { ops, db: { ...db, from: wrap } };
}

const ABSENT = { code: "PGRST205", message: "Could not find the table 'public.layover_presence' in the schema cache" };

describe("L196 presence — 3900 applied: expired presence leaves at expires_at", () => {
  it("deletes every row whose expiry has passed (the boundary included) and keeps every live one", async () => {
    const t: Record<string, any[]> = {
      layover_presence: [presence("s-expired-long", -600), presence("s-expired", -1), presence("s-boundary", 0), presence("s-live", 1), presence("s-live-long", 600)],
    };
    const out = await runLayoverPresenceExpirySweep({ client: makeLayoverDb(on(t)), now: NOW });
    assert.deepEqual(out, { outcome: "swept", reason: null, deleted: 3, complete: true });
    assert.deepEqual(t.layover_presence.map((r) => r.session_id).sort(), ["s-live", "s-live-long"]);
  });

  it("the cutoff is the exact complement of the readers' `expires_at > now`: the boundary row is one no reader can see", async () => {
    const t: Record<string, any[]> = { layover_presence: [presence("s-boundary", 0)] };
    await runLayoverPresenceExpirySweep({ client: makeLayoverDb(on(t)), now: NOW });
    assert.equal(t.layover_presence.length, 0);
  });

  it("nothing due is `idle` — a measurement — and nothing is deleted", async () => {
    const t: Record<string, any[]> = { layover_presence: [presence("s-live", 30)] };
    const { db, ops } = recorded(t);
    const out = await runLayoverPresenceExpirySweep({ client: db, now: NOW });
    assert.deepEqual(out, { outcome: "idle", reason: null, deleted: 0, complete: true });
    assert.ok(!ops.includes("layover_presence:delete"));
    assert.equal(t.layover_presence.length, 1);
  });

  it("bounded: a full batch deletes only the oldest-expiring rows and reports complete: false", async () => {
    const t: Record<string, any[]> = { layover_presence: [presence("a", -30), presence("b", -20), presence("c", -10)] };
    const out = await runLayoverPresenceExpirySweep({ client: makeLayoverDb(on(t)), now: NOW, batchSize: 2 });
    assert.deepEqual(out, { outcome: "swept", reason: null, deleted: 2, complete: false });
    assert.deepEqual(t.layover_presence.map((r) => r.session_id), ["c"]);
  });

  it("only the presence table is touched: the sweep writes no event per deleted row", async () => {
    const t: Record<string, any[]> = { layover_presence: [presence("s-expired", -5)], layover_events: [] };
    const { db, ops } = recorded(t);
    await runLayoverPresenceExpirySweep({ client: db, now: NOW });
    assert.equal(ops[0], "feature_flags:select", "the press is read first (3952)"); assert.ok(ops.slice(1).every((o) => o.startsWith("layover_presence:")), ops.join(","));
    assert.equal(t.layover_events.length, 0);
  });

  it("a row re-shared between the read and the DELETE is no longer due and is left alone", async () => {
    const t: Record<string, any[]> = { layover_presence: [presence("s-reshared", -5)] };
    const inner = makeLayoverDb(on(t)) as any;
    const racing = {
      ...inner,
      from: (name: string) => {
        const b = inner.from(name);
        const del = b.delete;
        b.delete = () => { t.layover_presence[0].expires_at = at(60); return del(); };
        return b;
      },
    };
    const out = await runLayoverPresenceExpirySweep({ client: racing, now: NOW });
    assert.equal(out.deleted, 0);
    assert.equal(t.layover_presence.length, 1);
  });
});

describe("L196 presence — 3900 unapplied (production today): inert, and not a failure", () => {
  beforeEach(() => _resetLayoverPresenceExpiryFailureState());

  it("the probe answers absent and NOTHING beyond the probe is issued", async () => {
    const t: Record<string, any[]> = {};
    const { db, ops } = recorded(t, { failures: { "layover_presence:select": ABSENT } });
    const out = await runLayoverPresenceExpirySweep({ client: db, now: NOW });
    assert.deepEqual(out, { outcome: "refused", reason: "table_absent", deleted: 0, complete: false });
    assert.deepEqual(ops, ["feature_flags:select", "layover_presence:select"], "the press, one probe, no due-row read, no DELETE");
  });

  it("a tick over an absent table neither escalates nor clears the failure ledger", async () => {
    const t: Record<string, any[]> = {};
    for (let i = 0; i < 4; i++) {
      await runLayoverPresenceExpiryTick({ client: makeLayoverDb(on(t), { failures: { "layover_presence:select": ABSENT } }), now: NOW });
    }
    assert.deepEqual(layoverPresenceExpiryFailureState(), { consecutiveFailures: 0, lastError: null });
  });

  it("no service client: refused no_client, and that IS counted — it is a misconfiguration", async () => {
    const out = await runLayoverPresenceExpiryTick({ client: null, now: NOW });
    assert.deepEqual(out, { outcome: "refused", reason: "no_client", deleted: 0, complete: false });
    assert.equal(layoverPresenceExpiryFailureState().consecutiveFailures, 1);
  });
});

describe("L196 presence — failures are failures, never a quiet zero", () => {
  beforeEach(() => _resetLayoverPresenceExpiryFailureState());

  it("the probe passes and the due-row read fails: read_failed, nothing deleted, counted", async () => {
    const t: Record<string, any[]> = { layover_presence: [presence("s-expired", -5)] };
    const inner = makeLayoverDb(on(t)) as any;
    let selects = 0;
    const db = {
      ...inner,
      from: (name: string) => {
        const b = inner.from(name);
        const sel = b.select;
        b.select = (...a: any[]) => {
          if (name === "layover_presence") selects += 1; // the 3952 flag read is not one of the sweep's own selects
          if (name === "layover_presence" && selects === 2) return makeLayoverDb({}, { failures: { "layover_presence:select": { message: "down" } } }).from("layover_presence").select(...a);
          return sel(...a);
        };
        return b;
      },
    };
    const out = await runLayoverPresenceExpiryTick({ client: db, now: NOW });
    assert.deepEqual(out, { outcome: "failed", reason: "read_failed", deleted: 0, complete: false });
    assert.equal(t.layover_presence.length, 1);
    assert.equal(layoverPresenceExpiryFailureState().consecutiveFailures, 1);
  });

  it("the DELETE is refused: delete_failed, the rows stay, counted; a later clean pass resets the ledger", async () => {
    const t: Record<string, any[]> = { layover_presence: [presence("s-expired", -5)] };
    const out = await runLayoverPresenceExpiryTick({ client: makeLayoverDb(on(t), { failures: { "layover_presence:delete": { message: "denied" } } }), now: NOW });
    assert.deepEqual(out, { outcome: "failed", reason: "delete_failed", deleted: 0, complete: false });
    assert.equal(t.layover_presence.length, 1);
    assert.equal(layoverPresenceExpiryFailureState().consecutiveFailures, 1);
    const clean = await runLayoverPresenceExpiryTick({ client: makeLayoverDb(on(t)), now: NOW });
    assert.equal(clean.outcome, "swept");
    assert.deepEqual(layoverPresenceExpiryFailureState(), { consecutiveFailures: 0, lastError: null });
  });
});

describe("L196 presence — it is a scheduled job, not an exported function nothing calls", () => {
  it("index.ts imports and starts it", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(index, /import \{ startLayoverPresenceExpiryScheduler \} from "\.\/lib\/layoverPresenceExpiryScheduler\.js";/);
    const calls = index.split("\n").filter((l) => !/^\s*import\b/.test(l) && /\bstartLayoverPresenceExpiryScheduler\(\);/.test(l));
    assert.equal(calls.length, 1);
  });

  it("start is idempotent and stop clears it (the timer never holds the process open)", () => {
    startLayoverPresenceExpiryScheduler();
    startLayoverPresenceExpiryScheduler();
    stopLayoverPresenceExpiryScheduler();
    stopLayoverPresenceExpiryScheduler();
  });
});

// ── 3952 (census-layover §84): deleting is the owner's press ──────────────────

const PRESENCE_FLAG = "layover_presence_expiry_enabled";
/** The press ON, unless the case states otherwise: the flag row 3952 seeds, turned on. */
function on(t: Record<string, any[]>, enabled: boolean | null = true): Record<string, any[]> {
  if (!t.feature_flags) t.feature_flags = enabled === null ? [] : [{ flag: PRESENCE_FLAG, enabled }];
  return t;
}

describe("L196 presence — 3952: deleting expired presence is the owner's press (seeded FALSE)", () => {
  beforeEach(() => _resetLayoverPresenceExpiryFailureState());

  for (const [label, enabled] of [["OFF", false], ["absent", null]] as const) {
    it(`flag ${label}: refused \`disabled\`, NOTHING is issued against layover_presence, the expired row stays, and it is not a failure`, async () => {
      const t: Record<string, any[]> = on({ layover_presence: [presence("s-expired", -600)] }, enabled);
      const { db, ops } = recorded(t);
      const out = await runLayoverPresenceExpirySweep({ client: db, now: NOW });
      assert.deepEqual(out, { outcome: "refused", reason: "disabled", deleted: 0, complete: false });
      assert.deepEqual(ops, ["feature_flags:select"], "the flag read, and no statement on the table");
      assert.equal(t.layover_presence.length, 1);
      await runLayoverPresenceExpiryTick({ client: makeLayoverDb(t), now: NOW });
      assert.deepEqual(layoverPresenceExpiryFailureState(), { consecutiveFailures: 0, lastError: null });
    });
  }

  it("flag unreadable: OFF (fail closed), and no statement on the table", async () => {
    const t: Record<string, any[]> = on({ layover_presence: [presence("s-expired", -600)] });
    const { db, ops } = recorded(t, { failures: { "feature_flags:select": { message: "down" } } });
    const out = await runLayoverPresenceExpirySweep({ client: db, now: NOW });
    assert.equal(out.reason, "disabled");
    assert.deepEqual(ops, ["feature_flags:select"]);
    assert.equal(t.layover_presence.length, 1);
  });

  it("3952 seeds the flag FALSE and asserts it ships OFF", () => {
    const sql = readFileSync(new URL("../migrations/3952_layover_presence_crew_expiry_flags.sql", import.meta.url), "utf8");
    assert.match(sql, /'layover_presence_expiry_enabled',\s*false,/);
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
    assert.match(sql, /POSTCONDITION FAILED \(3952\): a layover expiry flag is ON; both must ship OFF/);
  });

  it("the gate is read BEFORE the probe, by name, in the sweep itself", () => {
    const src = readFileSync(new URL("../lib/layoverPresenceExpiryScheduler.ts", import.meta.url), "utf8");
    assert.match(src, /if \(!\(await isFlagEnabled\(db, "layover_presence_expiry_enabled"\)\)\) return refused\("disabled"\); if \(!\(await presenceTablePresent\(db\)\)\) return refused\("table_absent"\);/);
  });
});

/**
 * Census T349 / SLO-04 — "expired precise-location leakage = 0", measured.
 *
 * WHAT THE ROW SAID, AND WHY IT WAS W. "The guarantee is genuinely enforced
 * (T216, T315) — but nothing measures it, so a regression would be silent."
 * §13.4 put it in BRANCH with the reason spelled out: "the emitter belongs in
 * `services/safeReturn/SafeReturnPrivacyGuard.ts` — another lane's file, not an
 * absent capability", and §12 recorded the same as a ceiling it could not pass.
 * That file is held here, and this is the emitter.
 *
 * WHAT IS COUNTED, and why each arm is a different fact. The shape follows
 * `lib/blockGuard.ts`, which SLO-05 and SLO-14 already share, because the
 * question is the same one: not "did a leak happen" — a counter cannot prove a
 * negative and is not asked to — but "is the gate running, and is it running
 * with knowledge".
 *
 *   ok         the expiry gate RAN and reached a conclusion: an expired or
 *              inactive share refused, or a live share admitted inside a window
 *              that actually bounds it.
 *   unknown    the share row could not be READ, so the refusal was issued
 *              without evaluating expiry at all. This is the rate at which the
 *              privacy gate is failing closed, which is invisible in any success
 *              metric and is the shape a leak begins as.
 *   violation  the gate ADMITTED a live-location share it cannot bound in time.
 *
 * THE VIOLATION ARM IS REACHABLE, AND THAT IS A FINDING, NOT A HYPOTHETICAL.
 * `safe_return_live_shares.expires_at` is NULLABLE in the live schema
 * (`baseline/20260819_baseline_structure.sql:9747#expires_at timestamp with time zone,`),
 * and the gate's expiry test is `if (s.expires_at && …)` — so an active share
 * with no `expires_at` passes the gate and keeps serving a recipient view
 * indefinitely. §30A.20 and T356 require every location share to carry an
 * expiry; this table does not enforce one, and until now nothing anywhere
 * noticed. The counter does not fix that (a NOT NULL is a migration, and this
 * lane applies none); it makes it visible, which is exactly what T349 asks for.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphExpiredLocationMeasured.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";

import { _setTestClient } from "../lib/http.js";
import { requireSafeReturnRecipient } from "../services/safeReturn/SafeReturnPrivacyGuard.js";
import {
  TELEGRAPH_SLOS,
  telegraphSloSnapshot,
  _resetTelegraphMetrics,
} from "../domain/telegraph/services/telegraphObservability.js";
import { makeFakeClient, call } from "./telegraphCertificationHarness.js";

const SHARE = "88880000-0000-4000-8000-000000000001";
const OWNER = "88880000-0000-4000-8000-000000000002";
const RECIPIENT = "88880000-0000-4000-8000-000000000003";
const STRANGER = "88880000-0000-4000-8000-000000000004";

const METRIC = "expired_precise_location_leakage";

function reading() {
  const r = telegraphSloSnapshot().find((s) => s.metric === METRIC);
  assert.ok(r, `${METRIC} is not a declared SLO`);
  return r!;
}

/**
 * Runs `body` against a one-route app carrying the real middleware.
 *
 * The server is closed in a `finally` deliberately: an assertion that throws
 * before an explicit close leaves a listening handle, and the node test runner
 * then hangs rather than reporting the failure. Measured — the first run of
 * this suite did exactly that.
 */
async function withShareApp(
  rows: any[],
  opts: Parameters<typeof makeFakeClient>[1] | undefined,
  body: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { error() {}, warn() {} }; next(); });
  app.get("/api/share/:shareId", requireSafeReturnRecipient, (req, res) => {
    res.status(200).json({ reached: true, share: (req as any).safeReturnRecipient?.share ?? null });
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  _setTestClient(
    makeFakeClient({ safe_return_live_shares: rows, profiles: [], feature_flags: [] }, opts),
    true,
  );
  try {
    await body(`http://127.0.0.1:${port}/api`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const live = {
  id: SHARE, user_id: OWNER, recipient_user_id: RECIPIENT, recipient_contact_id: null,
  status: "active", expires_at: "2099-01-01T00:00:00.000Z",
};

beforeEach(() => _resetTelegraphMetrics());

describe("SLO-04 is declared as measured and names the file that records it", () => {
  it("the declaration and the emitter agree", () => {
    const slo = TELEGRAPH_SLOS.find((s) => s.id === "SLO-04");
    assert.ok(slo);
    assert.equal(slo!.metric, METRIC);
    assert.equal(slo!.censusRow, "T349");
    assert.equal(slo!.severity, "privacy");
    assert.equal(
      slo!.status,
      "measured",
      "T349's whole remaining gap was that nothing counted this; a declaration that " +
        "still says 'unmeasurable' while an emitter exists is the two halves disagreeing",
    );
    assert.deepEqual(slo!.emitters, ["src/services/safeReturn/SafeReturnPrivacyGuard.ts"]);
  });
});

describe("T349 — the expiry gate is counted, not merely enforced", () => {
  it("CONTROL: nothing is recorded until the gate runs", () => {
    const r = reading();
    assert.equal(r.ok + r.violations + r.unknown, 0);
    assert.equal(r.meetsTarget, null, "no observation is not the same as meeting the target");
  });

  it("an EXPIRED share refused counts as ok — zero coordinates left", async () => {
    await withShareApp([{ ...live, expires_at: "2020-01-01T00:00:00.000Z" }], undefined, async (base) => {
      const r = await call(base, "GET", `/share/${SHARE}`, RECIPIENT);
      assert.equal(r.status, 404);
      assert.ok(!r.body.reached);
      assert.equal(reading().ok, 1);
      assert.equal(reading().violations, 0);
    });
  });

  it("a STOPPED share refused counts too — revocation is the same guarantee", async () => {
    await withShareApp([{ ...live, status: "stopped" }], undefined, async (base) => {
      const r = await call(base, "GET", `/share/${SHARE}`, RECIPIENT);
      assert.equal(r.status, 404);
      assert.equal(reading().ok, 1);
    });
  });

  it("a live share admitted inside a real window counts as ok", async () => {
    await withShareApp([live], undefined, async (base) => {
      const r = await call(base, "GET", `/share/${SHARE}`, RECIPIENT);
      assert.equal(r.status, 200);
      assert.equal(reading().ok, 1);
      assert.equal(reading().violations, 0);
    });
  });

  it("an UNREADABLE share table is 'unknown' — the gate denied without evaluating expiry", async () => {
    const opts = { errors: { safe_return_live_shares: { message: "permission denied", code: "42501" } } };
    await withShareApp([live], opts, async (base) => {
      const r = await call(base, "GET", `/share/${SHARE}`, RECIPIENT);
      assert.notEqual(r.status, 200);
      assert.equal(
        reading().unknown,
        1,
        "a refusal issued without reading the row is not the same event as a refusal " +
          "issued because the row said 'expired'",
      );
      assert.equal(reading().ok, 0);
    });
  });

  it("a share with NO expiry admitted is a VIOLATION — an unbounded live location", async () => {
    // `expires_at` is nullable in the live schema and the gate's test is
    // `if (s.expires_at && …)`, so this share is served forever. The target is
    // violations ≤ 0, so one of these makes the SLO read as failing, which is
    // the point: today nothing anywhere says this state exists.
    await withShareApp([{ ...live, expires_at: null }], undefined, async (base) => {
      const r = await call(base, "GET", `/share/${SHARE}`, RECIPIENT);
      assert.equal(r.status, 200, "behaviour is unchanged — this lane measures, it does not gate");
      assert.equal(reading().violations, 1);
      assert.equal(reading().meetsTarget, false);
    });
  });

  it("a non-recipient refusal is NOT counted — it is a different guarantee", async () => {
    // Recipient identity is authorization, not expiry. Folding it in would
    // inflate the privacy metric with events that say nothing about location
    // lifetime, and the count would then look healthiest on the traffic that
    // never reached the expiry test at all.
    await withShareApp([live], undefined, async (base) => {
      const r = await call(base, "GET", `/share/${SHARE}`, STRANGER);
      assert.equal(r.status, 403);
      assert.equal(reading().ok + reading().violations + reading().unknown, 0);
    });
  });
});

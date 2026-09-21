/**
 * A RE-DELIVERED VERIFICATION WEBHOOK MUST NOT AWARD TRUST TWICE.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * `TrustEventService.isDuplicate` opens with
 *
 *     if (!sourceId) return "new";
 *
 * so an emitter that passes NO `sourceId` has no idempotency key at all: every
 * call is a first call. The whole dedup apparatus — the 24 h window, the
 * fail-CLOSED "unverifiable" branch the census grades as C1 — is bypassed by
 * omission, silently, and the emitter still gets `{ ok: true }`.
 *
 * `routes/verification.ts#applyVerifiedProfile` emitted `identity_verified`
 * (+10 respect_safety) that way. Provider webhooks are at-least-once by
 * construction: Stripe Identity and Persona both retry until they see a 2xx,
 * and this handler returns 5xx on a persist failure ON PURPOSE so that they do
 * (audit H5). So the ONE path in this route that is designed to be re-entered
 * was the one path with no idempotency key, and each redelivery of the same
 * provider session charged another +10 until the daily earning cap absorbed it.
 *
 * The verified-foundation plan's V-1 Trust hook is defined per TRANSITION —
 * "on transition to `verified`, emit the existing trust event" — not per
 * delivery. Trust architecture upgrade v2 states the same bar twice: TRV2-04
 * ("duplicates and invalid signatures cannot create additional effects") and
 * TRV2-06 ("duplicate deliveries or crashes do not double-charge").
 *
 * ── WHAT THIS FILE MEASURES ─────────────────────────────────────────────────
 * Not the arguments — the OUTCOME. Test 2 seeds the `trust_events` row that a
 * first delivery leaves behind and then replays the identical webhook, and
 * asserts ZERO further inserts. That is red on the unkeyed emitter and green on
 * the keyed one, and it stays honest if someone changes which key is used, as
 * long as the replay still dedups.
 *
 * Test 1 is the control: a FIRST delivery must still award, or "no double
 * charge" would be trivially satisfiable by never charging at all.
 *
 * Test 3 pins the key's SHAPE, because the dedup read filters on `source_type`
 * as well as `source_id`: an emitter that passed the session id but left
 * `source_type` at its "system" default would look keyed and still never match
 * the row it wrote.
 *
 * Double: src/test/helpers/failClosedSupabase.ts. Its documented limit —
 * writes are RECORDED, not applied to `spec.rows` — is why the replay is
 * modelled by SEEDING the prior row rather than by calling persistResult twice;
 * a second call would not see the first call's insert, which would make the
 * test pass for a reason that has nothing to do with the fix.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationTrustIdempotency.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import { persistResult } from "../routes/verification.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import type { VerificationResult } from "../services/identityVerification/types.js";

const USER = "dd000000-0000-4000-a000-000000000077";
const SESSION = "mock_2f6f0a1e-0000-4000-a000-000000000001";
const VERIFIED_AT = "2026-09-01T00:00:00.000Z";

function verifiedResult(): VerificationResult {
  return {
    provider: "mock",
    providerSessionId: SESSION,
    status: "verified",
    isOver18: true,
    selfieMatch: true,
    documentCountry: "US",
    verifiedAt: VERIFIED_AT,
    providerVerificationRef: "mockref_1",
  } as unknown as VerificationResult;
}

/** Seed with the trust engine ON; `priorEvents` stands in for earlier deliveries. */
function spec(priorEvents: any[] = []): FakeClientSpec {
  return {
    rows: {
      feature_flags: [{ flag: "trust_engine_enabled", enabled: true }],
      trust_settings: [],
      trust_events: priorEvents,
      trust_caps: [],
      trust_profiles: [],
      identity_verifications: [
        { id: "iv1", user_id: USER, provider_session_id: SESSION, status: "processing" },
      ],
      profiles: [{ id: USER, verification_level: "none", verified_at: null }],
    },
  };
}

/** The row a FIRST delivery leaves in the ledger, keyed the way the fix keys it. */
function priorAward(): any {
  return {
    id: "te1",
    user_id: USER,
    event_type: "identity_verified",
    source_type: "identity_verification",
    source_id: SESSION,
    category: "respect_safety",
    delta: 10,
    severity: "minor",
    status: "applied",
    created_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

function trustInserts(s: FakeClientSpec): any[] {
  return s.inserted?.["trust_events"] ?? [];
}

describe("a re-delivered verification webhook does not award trust twice", () => {
  it("CONTROL: the FIRST delivery does award identity_verified", async () => {
    const s = spec();
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    await persistResult(client as any, verifiedResult(), USER);

    const inserts = trustInserts(s);
    assert.equal(
      inserts.length,
      1,
      "a first verification must still emit the trust event — otherwise 'no double charge' is satisfied by never charging",
    );
    assert.equal(inserts[0].event_type, "identity_verified");
    assert.equal(inserts[0].delta, 10);
  });

  it("THE DEFECT: replaying the SAME provider session emits NOTHING further", async () => {
    const s = spec([priorAward()]);
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    // Byte-identical to the delivery that produced priorAward(): this is what a
    // provider retry after a 5xx, or a duplicate at-least-once delivery, is.
    await persistResult(client as any, verifiedResult(), USER);

    assert.deepEqual(
      trustInserts(s),
      [],
      "the same provider session must charge respect_safety once, not once per webhook delivery",
    );
  });

  it("the emitted event carries a dedup key that MATCHES the read that looks for it", async () => {
    const s = spec();
    const client = makeFailClosedClient(s);
    _setTestServiceClient(client);

    await persistResult(client as any, verifiedResult(), USER);

    const row = trustInserts(s)[0];
    assert.ok(row, "expected one emitted trust event");
    assert.equal(
      row.source_id,
      SESSION,
      "source_id must be the provider session — isDuplicate returns 'new' for a missing one",
    );
    assert.equal(
      row.source_type,
      "identity_verification",
      "isDuplicate also filters on source_type; leaving it at the 'system' default cannot match this row",
    );
  });
});

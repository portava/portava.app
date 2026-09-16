import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeSensingCredential,
  issueSensingCredential,
  SENSING_CAPABILITY_VERSION,
} from "../lib/deviceContributionCredential.js";

test("sensing credentials reject malformed bearer and nonce before database access", async () => {
  let called = false;
  const result = await authorizeSensingCredential({ rpc: async () => { called = true; } }, "short", "short");
  assert.deepEqual(result, { ok: false, reason: "credential_malformed" });
  assert.equal(called, false);
});

test("sensing credential issuance is purpose/version scoped and expiry bounded", async () => {
  const rows: any[] = [];
  const db = {
    from() {
      return {
        insert(row: any) {
          rows.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "cred-1" }, error: null }) }) };
        },
      };
    },
  };
  const result = await issueSensingCredential(db, "actor-1", {
    purpose: "wrong-purpose",
    deviceId: "device-" + "a".repeat(32),
  });
  assert.deepEqual(result, { ok: false, reason: "credential_purpose_mismatch" });
  const issued = await issueSensingCredential(db, "actor-1", {
    capabilityVersion: SENSING_CAPABILITY_VERSION,
    ttlSeconds: 999999,
    deviceId: "device-" + "a".repeat(32),
  });
  assert.equal(issued.ok, true);
  if (issued.ok) {
    assert.equal(issued.credential.capabilityVersion, SENSING_CAPABILITY_VERSION);
    assert.ok(new Date(issued.credential.expiresAt).getTime() - Date.now() <= 15 * 60 * 1000 + 1000);
    assert.equal(rows[0].purpose, "intel_claim");
    assert.equal(rows[0].token_digest.length, 64);
  }
});

test("credential authorization exposes replay as distinct from idempotency", async () => {
  const db = {
    rpc: async () => ({
      data: [{ outcome: "replay", id: "cred-1", actor_id: "actor-1", device_id: "device", expires_at: new Date(Date.now() + 10000).toISOString(), capability_version: SENSING_CAPABILITY_VERSION }],
      error: null,
    }),
  };
  const result = await authorizeSensingCredential(db, "a".repeat(32), "b".repeat(32));
  assert.deepEqual(result, { ok: false, reason: "credential_replay" });
});
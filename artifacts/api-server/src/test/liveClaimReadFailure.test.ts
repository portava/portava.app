/**
 * census-discovery §94 (lane W11-X2), §79 F2 / §91.7 item 5 — the shared Live
 * claim read must not collapse an ERRORED read into "no claim".
 *
 * Sensing §20: "Schema/permission/infrastructure failure ≠ no activity".
 * `readLiveClaims` resolved `[]` for a snapshot read error, an unreadable
 * promoted-scope allowlist and a throw, exactly as it resolves `[]` for a
 * place with nothing live. Every consumer therefore graded a failed read as
 * `none`, and Discovery's §79 rule (a failed read fails CLOSED: the row keeps
 * its place and loses its "now" claim) could never fire for it.
 *
 * The fix keeps the value every existing caller receives (`[]`, so no other
 * consumer changes byte for byte) and makes the failure visible on it:
 * `liveClaimReadFailed(result)` is true for exactly those three cases, and
 * `readLiveClaimEnvelopes` carries the mark through. Discovery's live read
 * then grades the row `unreadable`, not `none`.
 *
 *   L1  snapshot read error → [] AND marked failed
 *   L2  unreadable promoted-scope allowlist → [] AND marked failed (and not cached)
 *   L3  a throw inside the snapshot read → [] AND marked failed
 *   L4  CONTROL: a readable, empty snapshot → [] NOT marked (a real absence)
 *   L5  CONTROL: gates closed (Live not servable) → [] NOT marked (Live is off, not a failed read)
 *   L6  CONTROL: an empty-but-readable allowlist → [] NOT marked (nothing promoted)
 *   L7  readLiveClaimEnvelopes carries the mark; a healthy read carries none
 *   D1  Discovery: an errored claim read grades the row `unreadable` (fails closed)
 *   D2  CONTROL: a readable empty read grades the row `none`
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/liveClaimReadFailure.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  readLiveClaims, readLiveClaimEnvelopes, liveClaimReadFailed, _clearPromotedScopeCache,
} from "../lib/liveClaimRead.js";
import { withDiscoveryLiveRank, invalidateLiveRankFlagCache } from "../lib/discoveryLiveRankRead.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const SUBJECT = "11111111-1111-4111-8111-111111111111";

interface World {
  flagsOn?: boolean;
  scopes?: "ok" | "error" | "empty";
  snapshots?: "ok" | "empty" | "error" | "throw";
}

function snapshotRow() {
  return {
    id: "snap-1", zone_id: "z1", claim_type: "crowd.level", value: { level: "busy" },
    confidence: 0.95, source_count: 12, observed_at: "2026-09-28T11:50:00.000Z",
    expires_at: "2026-09-28T13:00:00.000Z", privacy_eligible: true, conflict_state: "none",
    source_class: "firsthand_unverified", computed_at: "2026-09-28T11:55:00.000Z",
  };
}

function client(w: World) {
  const reads: string[] = [];
  const sc = {
    reads,
    from(table: string) {
      reads.push(table);
      if (table === "feature_flags") {
        let flag = "";
        const q: any = {
          select: () => q,
          eq: (_c: string, v: string) => { flag = v; return q; },
          maybeSingle: async () => ({
            // The kill switch is the one flag whose TRUE means "stop".
            data: { enabled: flag === "disable_intel_live_labels" ? false : (w.flagsOn ?? true) },
            error: null,
          }),
        };
        return q;
      }
      if (table === "intel_live_promoted_scopes") {
        const q: any = {
          select: () => q,
          then: (res: any) => res(
            w.scopes === "error" ? { data: null, error: { message: "allowlist unreadable" } }
            : w.scopes === "empty" ? { data: [], error: null }
            : { data: [{ scope_key: "z1|crowd.level", expires_at: null, withdrawn_at: null }], error: null },
          ),
        };
        return q;
      }
      if (table === "intel_state_snapshots") {
        const q: any = {
          select: () => q, eq: () => q, gt: () => q, in: () => q,
          then: (res: any, rej: any) => {
            if (w.snapshots === "throw") return rej(new Error("socket hang up"));
            return res(
              w.snapshots === "error" ? { data: null, error: { message: "claim read failed" } }
              : w.snapshots === "empty" ? { data: [], error: null }
              : { data: [snapshotRow()], error: null },
            );
          },
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sc;
}

beforeEach(() => { _clearPromotedScopeCache(); invalidateLiveRankFlagCache(); });

describe("readLiveClaims — an errored read is not 'no claim'", () => {
  it("L1 a snapshot read error answers [] and is marked failed", async () => {
    const out = await readLiveClaims(client({ snapshots: "error" }), SUBJECT, { now: NOW });
    assert.deepEqual(out, []);
    assert.equal(liveClaimReadFailed(out), true);
  });

  it("L2 an unreadable promoted-scope allowlist answers [] and is marked failed — and the failure is not cached", async () => {
    const sc = client({ scopes: "error" });
    const out = await readLiveClaims(sc, SUBJECT, { now: NOW });
    assert.deepEqual(out, []);
    assert.equal(liveClaimReadFailed(out), true);
    assert.equal(sc.reads.includes("intel_state_snapshots"), false, "no snapshot is read without an allowlist");
    // The allowlist recovers: the next read is a real one.
    const healthy = await readLiveClaims(client({}), SUBJECT, { now: NOW });
    assert.equal(healthy.length, 1);
    assert.equal(liveClaimReadFailed(healthy), false);
  });

  it("L3 a throw inside the snapshot read answers [] and is marked failed", async () => {
    const out = await readLiveClaims(client({ snapshots: "throw" }), SUBJECT, { now: NOW });
    assert.deepEqual(out, []);
    assert.equal(liveClaimReadFailed(out), true);
  });

  it("L4 CONTROL: a readable, empty snapshot is a real absence and is NOT marked", async () => {
    const out = await readLiveClaims(client({ snapshots: "empty" }), SUBJECT, { now: NOW });
    assert.deepEqual(out, []);
    assert.equal(liveClaimReadFailed(out), false);
  });

  it("L5 CONTROL: gates closed means Live is off, not a failed read — NOT marked", async () => {
    const out = await readLiveClaims(client({ flagsOn: false }), SUBJECT, { now: NOW });
    assert.deepEqual(out, []);
    assert.equal(liveClaimReadFailed(out), false);
  });

  it("L6 CONTROL: a readable allowlist with nothing promoted is NOT marked", async () => {
    const out = await readLiveClaims(client({ scopes: "empty" }), SUBJECT, { now: NOW });
    assert.deepEqual(out, []);
    assert.equal(liveClaimReadFailed(out), false);
  });

  it("L7 readLiveClaimEnvelopes carries the mark; a healthy read carries none", async () => {
    const failed = await readLiveClaimEnvelopes(client({ snapshots: "error" }), SUBJECT, { now: NOW });
    assert.deepEqual(failed, []);
    assert.equal(liveClaimReadFailed(failed), true);
    _clearPromotedScopeCache();
    const ok = await readLiveClaimEnvelopes(client({}), SUBJECT, { now: NOW });
    assert.equal(ok.length, 1);
    assert.equal(liveClaimReadFailed(ok), false);
  });
});

describe("Discovery's live read fails CLOSED on an errored claim read (§79's rule)", () => {
  const row = { id: "db/1", canonicalPlaceId: SUBJECT, distanceKm: 0.4 };

  it("D1 an errored claim read grades the row `unreadable`, not `none`", async () => {
    const outcome = await withDiscoveryLiveRank(client({ snapshots: "error" }), [row], { nowMs: NOW.getTime(), gatesOpen: async () => true });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.byId.get("db/1")?.evidence, "unreadable");
  });

  it("D2 CONTROL: a readable empty read grades the row `none`", async () => {
    const outcome = await withDiscoveryLiveRank(client({ snapshots: "empty" }), [row], { nowMs: NOW.getTime(), gatesOpen: async () => true });
    assert.equal(outcome.applied, true);
    assert.equal(outcome.byId.get("db/1")?.evidence, "none");
  });
});

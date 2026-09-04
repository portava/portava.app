/**
 * §10 material conflict on the SERVE side (IG unit I2, AT-07) — the read path,
 * the envelope, the legacy crowd string, the internal API projection and the
 * Wall strip item.
 *
 * THE PROPERTY: a materially-conflicted snapshot can still be READ (visible
 * conflict, not silent averaging) but can never be rendered as a strong Live
 * label, by any consumer of the read path — the band is capped below 'live'
 * before anything else sees it, the envelope state is 'emerging', a counts-only
 * {state, sidesCount, lastUpdated} block rides along, and the internal API
 * output is capped the same way. 'none'/'minor' and pre-2275 rows (no column)
 * are byte-for-byte unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readLiveClaims,
  readLiveCrowdLevel,
  readLiveClaimEnvelopes,
  toLiveClaimEnvelope,
  _clearPromotedScopeCache,
  type LiveClaim,
} from "../lib/liveClaimRead.js";
import { projectSnapshotForApi } from "../lib/intelApiProjection.js";
import { buildLiveForYou } from "../services/wall/LiveForYouService.js";
import { CONFIDENCE_BAND_FLOOR } from "../lib/intelContracts.js";
import { mayRedistribute } from "../lib/dataRights.js";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 30 * 60_000).toISOString();
const PAST = new Date(NOW.getTime() - 10 * 60_000).toISOString();
const COMPUTED = new Date(NOW.getTime() - 2 * 60_000).toISOString();

/** Serving fake: every gate open, the zoneless crowd.level scope promoted. */
function client(rows: any[]) {
  _clearPromotedScopeCache();
  return {
    from(table: string) {
      if (table === "intel_live_promoted_scopes") {
        const pq: any = { select: () => pq };
        return Object.assign(pq, { then: (res: any) => res({ data: [{ scope_key: "|crowd.level" }, { scope_key: "|queue.wait" }], error: null }) });
      }
      if (table === "feature_flags") {
        let flagName = "";
        const fq: any = {
          select: () => fq,
          eq: (k: string, v: unknown) => { if (k === "flag") flagName = String(v); return fq; },
          maybeSingle: async () => ({ data: { enabled: flagName !== "disable_intel_live_labels" }, error: null }),
        };
        return fq;
      }
      if (table === "intel_state_snapshots") {
        const q: any = { select: () => q, eq: () => q, gt: () => q, in: () => q };
        return Object.assign(q, { then: (res: any) => res({ data: rows, error: null }) });
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const strongRow = {
  id: "s1", claim_type: "crowd.level", value: { level: "packed" }, confidence: 0.92, source_count: 30,
  observed_at: PAST, expires_at: FUTURE, privacy_eligible: true, computed_at: COMPUTED,
};

describe("liveClaimRead — §10 material conflict caps the served band", () => {
  it("a 'material' snapshot serves as 'emerging' at most likely_current, never 'live', with a conflict block", async () => {
    const claims = await readLiveClaims(client([{ ...strongRow, conflict_state: "material" }]), "p1", { now: NOW });
    assert.equal(claims.length, 1, "still READ — a visible conflict is not a suppressed value");
    const c = claims[0];
    assert.equal(c.conflictState, "material");
    assert.equal(c.band, "likely_current");
    assert.ok(c.confidence !== null && c.confidence < CONFIDENCE_BAND_FLOOR.live);
    assert.deepEqual(c.value, { level: "packed" }, "the plurality value still serves — it is labelled, not hidden");

    const env = toLiveClaimEnvelope(c);
    assert.equal(env.state, "emerging");
    assert.equal(env.band, "likely_current");
    assert.equal(env.conflictState, "material");
    assert.deepEqual(env.conflict, { state: "material", sidesCount: 2, lastUpdated: COMPUTED });
    // Counts only: nothing about the sides' membership leaves.
    assert.ok(!("sides" in (env as any)));
  });

  it("'none', NULL (pre-2275) and 'minor' rows serve exactly as before", async () => {
    for (const conflict_state of ["none", null, undefined, "minor"]) {
      const claims = await readLiveClaims(client([{ ...strongRow, conflict_state }]), "p1", { now: NOW });
      assert.equal(claims.length, 1);
      assert.equal(claims[0].band, "strong", `conflict_state=${String(conflict_state)}`);
      assert.equal(claims[0].confidence, 0.92);
      const env = toLiveClaimEnvelope(claims[0]);
      assert.equal(env.state, "live");
      if (conflict_state === "minor") {
        assert.deepEqual(env.conflict, { state: "minor", sidesCount: 2, lastUpdated: COMPUTED });
      } else {
        assert.equal(env.conflictState, "none");
        assert.equal(env.conflict, null);
      }
    }
  });

  it("an unrecognised stored state is read as material (fail-closed for the Live label)", async () => {
    const claims = await readLiveClaims(client([{ ...strongRow, conflict_state: "future-vocabulary" }]), "p1", { now: NOW });
    assert.equal(claims[0].conflictState, "material");
    assert.equal(toLiveClaimEnvelope(claims[0]).state, "emerging");
    // The spec's own spelling of the middle state is honoured.
    const ctx = await readLiveClaims(client([{ ...strongRow, conflict_state: "contextualized" }]), "p1", { now: NOW });
    assert.equal(ctx[0].conflictState, "minor");
    assert.equal(toLiveClaimEnvelope(ctx[0]).state, "live");
  });

  it("the cap still clears the serve floor — a conflicted claim is not silently dropped", async () => {
    // A row that would be 'live' (0.8) is capped to likely_current and still served.
    const claims = await readLiveClaims(client([{ ...strongRow, confidence: 0.8, conflict_state: "material" }]), "p1", { now: NOW });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].band, "likely_current");
    // A row already below the floor stays dropped — the cap never raises anything.
    const low = await readLiveClaims(client([{ ...strongRow, confidence: 0.4, conflict_state: "material" }]), "p1", { now: NOW });
    assert.deepEqual(low, []);
  });

  it("the legacy crowdLevel string is NULL under a material conflict (no unlabelled plurality)", async () => {
    assert.equal(await readLiveCrowdLevel(client([{ ...strongRow, conflict_state: "material" }]), "p1", { now: NOW }), null);
    assert.equal(await readLiveCrowdLevel(client([{ ...strongRow, conflict_state: "minor" }]), "p1", { now: NOW }), "packed");
    assert.equal(await readLiveCrowdLevel(client([strongRow]), "p1", { now: NOW }), "packed");
    // …while the rich envelope still carries the value WITH its conflict block.
    const envs = await readLiveClaimEnvelopes(client([{ ...strongRow, conflict_state: "material" }]), "p1", { now: NOW });
    assert.equal(envs.length, 1);
    assert.deepEqual(envs[0].value, { level: "packed" });
    assert.equal(envs[0].conflict?.state, "material");
  });

  it("a hand-built LiveClaim without the field is 'none' — never an undefined state", () => {
    const c = {
      id: "x", claimType: "crowd.level", value: "busy", confidence: 0.9, band: "strong", sourceClass: "firsthand_unverified",
      sourceCount: 20, observedAt: PAST, expiresAt: FUTURE,
    } as unknown as LiveClaim;
    const env = toLiveClaimEnvelope(c);
    assert.equal(env.conflictState, "none");
    assert.equal(env.conflict, null);
    assert.equal(env.state, "live");
  });
});

describe("intelApiProjection — §10 prevents high-confidence external output under conflict", () => {
  const snapshot = {
    id: "snap-1", subject_id: "place-1", zone_id: "", claim_type: "crowd.level", value: { level: "packed" },
    confidence: 0.92, confidence_band: "strong", source_count: 30, distinct_actors: 30, privacy_eligible: true,
    observed_at: PAST, expires_at: FUTURE, computed_at: COMPUTED,
  };
  it("conflict_state is classified redistributable and the block is attached", () => {
    assert.equal(mayRedistribute("intel_state_snapshots", "conflict_state"), true);
    const proj = projectSnapshotForApi({ ...snapshot, conflict_state: "material" }, NOW)!;
    assert.equal(proj.conflict_state, "material");
    assert.deepEqual(proj.conflict, { state: "material", sidesCount: 2, lastUpdated: COMPUTED });
    assert.equal(proj.confidence_band, "likely_current");
    assert.ok(typeof proj.confidence === "number" && proj.confidence < CONFIDENCE_BAND_FLOOR.live);
    // Nothing about the sides leaves; the restricted columns stay restricted.
    assert.ok(!("distinct_actors" in proj));
    assert.ok(!("sides" in proj));
  });
  it("a non-conflicted snapshot is untouched (NULL reads as 'none')", () => {
    const proj = projectSnapshotForApi({ ...snapshot, conflict_state: null }, NOW)!;
    assert.equal(proj.conflict_state, "none");
    assert.equal(proj.conflict, null);
    assert.equal(proj.confidence, 0.92);
    assert.equal(proj.confidence_band, "strong");
  });
});

describe("LiveForYouService — the Wall strip item carries the conflict state", () => {
  it("a material item is 'emerging' with conflictState 'material'", async () => {
    const candidates = [{ liveObjectType: "place_state" as const, subjectId: "p1", subject: { placeId: "p1", name: "Bar" } as any }];
    const items = await buildLiveForYou(client([{ ...strongRow, conflict_state: "material" }]), candidates, { now: NOW });
    assert.equal(items.length, 1);
    assert.equal(items[0].state, "emerging");
    assert.equal(items[0].conflictState, "material");
    const plain = await buildLiveForYou(client([strongRow]), candidates, { now: NOW });
    assert.equal(plain[0].state, "live");
    assert.equal(plain[0].conflictState, "none");
  });
});

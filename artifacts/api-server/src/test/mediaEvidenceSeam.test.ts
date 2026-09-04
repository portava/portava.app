/**
 * mediaEvidenceSeam — the media→intel EVIDENCE seam (Media v2 Phase 5, §9/§35).
 *
 * The safety property under test is the FLAG-OFF INVARIANT: while
 * `media_evidence_enabled` is OFF (or unreadable), intelProjectionAggregator's
 * confidence output is BYTE-IDENTICAL to pre-seam main — hasEvidence is exactly
 * false, evidenceQuality stays 0.3, nothing in live intel serving moves. Only an
 * admin flipping the flag ON lets an evidence-eligible, linked media raise
 * hasEvidence (→ evidenceQuality 0.8).
 *
 * Proves:
 *   1. FLAG OFF ⇒ hasEvidence false ⇒ aggregator output byte-identical to the
 *      pre-seam value, EVEN WITH an eligible linked media present (the seam's
 *      only effect is evidenceQuality, and it is inert while off).
 *   2. FLAG ON + an evidence-eligible linked media ⇒ hasEvidence true ⇒
 *      evidenceQuality 0.8.
 *   3. An INELIGIBLE media (bad source / generative edit per §35) is REFUSED as
 *      evidence by the write adapter (no intel_evidence row) and, defence in
 *      depth, is NOT counted at read even if a stale link existed.
 *   4. Linking never blocks the social asset (media_assets is never written; a
 *      refusal is an evidence decision only).
 *   5. The flag read is FAIL-CLOSED (a feature_flags error ⇒ off ⇒ false).
 *
 * MUTATION-PROOFS (called out inline):
 *   • (1) make the flag-off branch return true ⇒ the "evidenceQuality 0.3 when
 *     off" assertion goes RED.
 *   • (3) bypass isEvidenceEligible in linkMediaEvidence ⇒ the "no intel_evidence
 *     row for ineligible media" assertion goes RED.
 *
 * No DB, no network — pure functions + a fake Supabase client. Run:
 *   node --import tsx/esm --test src/test/mediaEvidenceSeam.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assembleClaimInput, type ClaimRow } from "../lib/intelProjectionAggregator.js";
import {
  linkMediaEvidence,
  observationsHaveEligibleMediaEvidence,
  type EvidenceMediaAsset,
} from "../lib/media/mediaEvidenceLink.js";
import { invalidateFreshnessPolicyCache } from "../lib/freshnessPolicy.js";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const OBSERVED = new Date(NOW.getTime() - 15 * 60_000).toISOString(); // 15 min ago

// ── A minimal fake Supabase client covering exactly the chains this seam uses ──
interface DbCfg {
  flags?: Record<string, boolean>;
  /** feature_flags read errors ⇒ isFlagEnabled fail-closed to false. */
  flagError?: boolean;
  observations?: any[];
  confirmations?: any[];
  policies?: any[];
  consent?: any[];
  evidence?: any[];
  mediaAssets?: any[];
}

function makeDb(cfg: DbCfg) {
  const store: Record<string, any[]> = {
    intel_observations: (cfg.observations ?? []).map((o) => ({ moderation_state: "allowed", ...o })),
    intel_confirmations: cfg.confirmations ?? [],
    freshness_policies: cfg.policies ?? [],
    intel_contribution_consent: cfg.consent ?? [],
    intel_evidence: [...(cfg.evidence ?? [])],
    media_assets: cfg.mediaAssets ?? [],
    media_attachments: [],
  };
  const flags = cfg.flags ?? {};

  function from(table: string) {
    const eqs: [string, any][] = [];
    let inF: [string, any[]] | null = null;
    let op: "select" | "insert" | "upsert" = "select";
    let payload: any = null;

    const rows = () =>
      (store[table] ?? []).filter(
        (r) => eqs.every(([c, v]) => r[c] === v) && (!inF || inF[1].includes(r[inF[0]])),
      );

    const run = () => {
      if (table === "feature_flags") {
        if (cfg.flagError) return { data: null, error: { message: "boom" } };
        const f = eqs.find(([c]) => c === "flag")?.[1];
        return { data: { enabled: Boolean(flags[f]) }, error: null };
      }
      if (op === "insert") {
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (table === "intel_evidence" && row.media_asset_id != null) {
          const dup = store.intel_evidence.some(
            (r) => r.observation_id === row.observation_id && r.media_asset_id === row.media_asset_id,
          );
          if (dup) return { data: null, error: { code: "23505", message: "unique_violation" } };
        }
        const withId = { id: `${table}-${store[table].length + 1}`, ...row };
        store[table].push(withId);
        return { data: { id: withId.id }, error: null };
      }
      if (op === "upsert") {
        const row = Array.isArray(payload) ? payload[0] : payload;
        const key = (r: any) =>
          r.media_asset_id === row.media_asset_id &&
          r.entity_type === row.entity_type &&
          r.entity_id === row.entity_id;
        if (!store[table].some(key)) store[table].push({ id: `${table}-${store[table].length + 1}`, ...row });
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };

    const b: any = {
      select() { return b; },
      insert(row: any) { op = "insert"; payload = row; return b; },
      upsert(row: any) { op = "upsert"; payload = row; return Promise.resolve(run()); },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      is(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { inF = [c, v]; return b; },
      single() { return Promise.resolve(run()); },
      maybeSingle() { return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    return b;
  }
  return { from, _store: store } as unknown as SupabaseClient & { _store: typeof store };
}

// ── Shared fixture: a live claim with two fresh consented observers ───────────
const claim: ClaimRow = {
  id: "c1", subject_id: "place-1", zone_id: null, claim_type: "crowd.level",
  value: { level: "busy" }, status: "active", observed_at: OBSERVED,
};
const observations = [
  { id: "o1", actor_id: "a1", subject_id: "place-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: OBSERVED, value: { level: "busy" }, group_key: null },
  { id: "o2", actor_id: "a2", subject_id: "place-1", claim_type: "crowd.level", presence_level: "P0", source_class: "firsthand_unverified", expires_at: null, observed_at: OBSERVED, value: { level: "busy" }, group_key: null },
];
const consent = [
  { user_id: "a1", enabled: true, withdrawn_at: null },
  { user_id: "a2", enabled: true, withdrawn_at: null },
];
const policies = [{ claim_type: "crowd.level", ttl_seconds: 2700, note: null }];

// An EVIDENCE-ELIGIBLE media (first-party camera capture, no breaking edits).
const eligibleMedia = {
  id: "m1", media_type: "image", storage_path: "media/m1.jpg",
  source_type: "camera", captured_at: OBSERVED,
  provenance: { sourceType: "camera", capturedAt: OBSERVED, editHistory: [], hasLocation: false },
};
// An INELIGIBLE media (source 'generated' — synthetic, §35 social-only).
const ineligibleMedia: EvidenceMediaAsset = {
  id: "m2", media_type: "image", storage_path: "media/m2.jpg",
  source_type: "generated", captured_at: OBSERVED,
  provenance: { sourceType: "generated", capturedAt: OBSERVED, editHistory: [], hasLocation: false },
};
// A camera capture broken by a generative edit (§35 evidence_breaking).
const generativelyEditedMedia: EvidenceMediaAsset = {
  id: "m3", media_type: "image", storage_path: "media/m3.jpg",
  source_type: "camera", captured_at: OBSERVED,
  provenance: { sourceType: "camera", capturedAt: OBSERVED, hasLocation: false,
    editHistory: [{ op: "generative_fill", class: "evidence_breaking", at: OBSERVED }] },
};

/** A DB with the eligible media linked to observation o1. */
const linkedEvidence = [{ id: "ev1", observation_id: "o1", actor_id: "a1", media_asset_id: "m1", evidence_kind: "photo" }];

beforeEach(() => invalidateFreshnessPolicyCache());

// ─────────────────────────────────────────────────────────────────────────────
describe("mediaEvidenceSeam — (1) FLAG OFF ⇒ byte-identical, hasEvidence false", () => {
  it("evidenceQuality stays 0.3 even with an eligible linked media, and the seam's ONLY effect is that field", async () => {
    const base = { observations, consent, policies, evidence: linkedEvidence, mediaAssets: [eligibleMedia] };
    const off = await assembleClaimInput(makeDb({ ...base, flags: { media_evidence_enabled: false } }), claim, NOW);
    const on = await assembleClaimInput(makeDb({ ...base, flags: { media_evidence_enabled: true } }), claim, NOW);

    // BYTE-IDENTICAL-WHEN-OFF: pre-seam hasEvidence was hardcoded false ⇒
    // evidenceQuality 0.3. The fixture HAS an eligible linked media, so a leaking
    // flag-off branch would read 0.8 here.
    //   MUTATION-PROOF (1): flip the aggregator's flag-off branch to `true`
    //   (hasEvidence = ... : true) and this assertion goes RED (0.8 !== 0.3).
    assert.equal(off.components.evidenceQuality, 0.3, "flag OFF must keep the pre-seam evidenceQuality");

    // The seam's ONLY effect is evidenceQuality: `off` with that one field bumped
    // to the flag-ON value must equal the full flag-ON ProjectionInput. Any other
    // divergence (value, freshness, independence, penalties, …) fails here.
    assert.deepEqual({ ...off, components: { ...off.components, evidenceQuality: 0.8 } }, on);
  });

  it("with NO eligible media, flag ON and flag OFF are fully identical", async () => {
    const base = { observations, consent, policies, evidence: [], mediaAssets: [] };
    const off = await assembleClaimInput(makeDb({ ...base, flags: { media_evidence_enabled: false } }), claim, NOW);
    const on = await assembleClaimInput(makeDb({ ...base, flags: { media_evidence_enabled: true } }), claim, NOW);
    assert.deepEqual(on, off, "no linked evidence ⇒ ON changes nothing");
    assert.equal(off.components.evidenceQuality, 0.3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mediaEvidenceSeam — (2) FLAG ON + eligible linked media ⇒ hasEvidence true", () => {
  it("evidenceQuality is 0.8 when an eligible media backs an observation of the claim", async () => {
    const on = await assembleClaimInput(
      makeDb({ observations, consent, policies, evidence: linkedEvidence, mediaAssets: [eligibleMedia], flags: { media_evidence_enabled: true } }),
      claim, NOW,
    );
    assert.equal(on.components.evidenceQuality, 0.8, "eligible linked media ⇒ evidence-backed");
  });

  it("the read helper returns true for an eligible link, false with none", async () => {
    const db = makeDb({ evidence: linkedEvidence, mediaAssets: [eligibleMedia] });
    assert.equal(await observationsHaveEligibleMediaEvidence(db, ["o1", "o2"], NOW.getTime()), true);
    assert.equal(await observationsHaveEligibleMediaEvidence(db, ["o2"], NOW.getTime()), false, "o2 has no link");
    assert.equal(await observationsHaveEligibleMediaEvidence(db, [], NOW.getTime()), false, "empty cohort ⇒ false");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mediaEvidenceSeam — (3) ineligible media is never evidence (§35, fail-closed)", () => {
  it("the write adapter REFUSES an ineligible-source media — no intel_evidence row (flag ON)", async () => {
    const db = makeDb({ flags: { media_evidence_enabled: true } });
    const res = await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: ineligibleMedia });
    assert.equal(res.linked, false);
    assert.equal(res.reason, "ineligible");
    // MUTATION-PROOF (3): bypass isEvidenceEligible in linkMediaEvidence (e.g.
    // `if (false && !isEvidenceEligible(asset))`) and BOTH the linked:false above
    // and the "zero rows" below go RED — the ineligible media would get linked.
    assert.equal(db._store.intel_evidence.length, 0, "no evidence row for an ineligible media");
  });

  it("a camera capture broken by a generative edit is also refused", async () => {
    const db = makeDb({ flags: { media_evidence_enabled: true } });
    const res = await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: generativelyEditedMedia });
    assert.equal(res.linked, false);
    assert.equal(res.reason, "ineligible");
    assert.equal(db._store.intel_evidence.length, 0);
  });

  it("an eligible media IS linked (control): one intel_evidence row + a display attachment", async () => {
    const db = makeDb({ flags: { media_evidence_enabled: true } });
    const res = await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: eligibleMedia });
    assert.equal(res.linked, true);
    assert.ok(res.evidenceId);
    assert.equal(db._store.intel_evidence.length, 1);
    assert.equal(db._store.intel_evidence[0].media_asset_id, "m1");
    assert.equal(db._store.intel_evidence[0].evidence_kind, "photo");
    const disp = db._store.media_attachments.filter((r) => r.entity_type === "observation");
    assert.equal(disp.length, 1, "a display attachment row is written for the observation");
    assert.equal(disp[0].entity_id, "o1");
  });

  it("re-attaching the same eligible media is idempotent (23505 ⇒ alreadyLinked)", async () => {
    const db = makeDb({ flags: { media_evidence_enabled: true } });
    await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: eligibleMedia });
    const again = await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: eligibleMedia });
    assert.equal(again.linked, true);
    assert.equal(again.alreadyLinked, true);
    assert.equal(db._store.intel_evidence.length, 1, "no duplicate evidence row");
  });

  it("DEFENCE IN DEPTH: a stale link to an ineligible media is NOT counted at read", async () => {
    // As if a bad/older link existed: o1 → m2 (ineligible). Read re-verifies §35.
    const staleLink = [{ id: "ev2", observation_id: "o1", actor_id: "a1", media_asset_id: "m2", evidence_kind: "photo" }];
    const on = await assembleClaimInput(
      makeDb({ observations, consent, policies, evidence: staleLink, mediaAssets: [ineligibleMedia], flags: { media_evidence_enabled: true } }),
      claim, NOW,
    );
    assert.equal(on.components.evidenceQuality, 0.3, "an ineligible linked media must not count as evidence");
    const db = makeDb({ evidence: staleLink, mediaAssets: [ineligibleMedia] });
    assert.equal(await observationsHaveEligibleMediaEvidence(db, ["o1"], NOW.getTime()), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mediaEvidenceSeam — (4) linking never blocks the social asset", () => {
  it("a refusal is an EVIDENCE decision only; media_assets is never written", async () => {
    const mediaStore = [ineligibleMedia];
    const db = makeDb({ flags: { media_evidence_enabled: true }, mediaAssets: mediaStore });
    const res = await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: ineligibleMedia });
    assert.equal(res.linked, false);
    assert.equal(res.socialAssetUnaffected, true);
    assert.deepEqual(db._store.media_assets, mediaStore, "the social asset row is untouched");
    assert.equal(db._store.media_attachments.length, 0, "no display attachment for a refused evidence");
  });

  it("flag OFF refuses without any write, social asset still fine", async () => {
    const db = makeDb({ flags: { media_evidence_enabled: false } });
    const res = await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: eligibleMedia });
    assert.equal(res.linked, false);
    assert.equal(res.reason, "flag_disabled");
    assert.equal(res.socialAssetUnaffected, true);
    assert.equal(db._store.intel_evidence.length, 0, "seam is dark while the flag is off");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("mediaEvidenceSeam — (5) the flag read is fail-closed", () => {
  it("a feature_flags error ⇒ aggregator hasEvidence false (evidenceQuality 0.3)", async () => {
    const on = await assembleClaimInput(
      makeDb({ observations, consent, policies, evidence: linkedEvidence, mediaAssets: [eligibleMedia], flagError: true }),
      claim, NOW,
    );
    assert.equal(on.components.evidenceQuality, 0.3, "unreadable flag ⇒ seam OFF ⇒ pre-seam output");
  });

  it("a feature_flags error ⇒ the write adapter refuses (flag_disabled), no writes", async () => {
    const db = makeDb({ flagError: true });
    const res = await linkMediaEvidence(db, { observationId: "o1", actorId: "a1", asset: eligibleMedia });
    assert.equal(res.linked, false);
    assert.equal(res.reason, "flag_disabled");
    assert.equal(db._store.intel_evidence.length, 0);
  });
});

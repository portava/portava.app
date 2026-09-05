/**
 * mediaEvidenceEligibility — §35 Evidence-Safe Editing + §10 IntelligenceEligibility.
 *
 * Proves the §35 rule and the fail-closed posture that gates the FUTURE
 * media→intel evidence seam:
 *   - crop / brightness / rotate (non-semantic) ⇒ still evidence-eligible;
 *   - a generative alteration (generative_fill / object_add / source 'generated')
 *     ⇒ NOT evidence-eligible, but still a valid SOCIAL asset;
 *   - an unknown/unclassified edit ⇒ fail-closed NOT eligible;
 *   - edit lineage is APPENDED to provenance, never overwritten;
 *   - isEvidenceEligible returns the composite verdict the intel seam calls.
 *
 * Plus the write-side seam: recordMediaAsset stamps provenance + eligibility
 * (flag-gated), and recordMediaEdit appends lineage + recomputes eligibility.
 *
 * MUTATION-PROOFS (called out inline): classifying a generative edit as
 * "preserving" turns the "generative is not eligible" test RED; dropping the
 * fail-closed default turns the unknown-edit test RED.
 *
 * No DB, no network — pure functions + fake Supabase clients. Run:
 *   node --import tsx/esm --test src/test/mediaEvidenceEligibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEdit,
  normalizeEditOp,
  initProvenance,
  appendEdit,
  normalizeProvenance,
  computeIntelligenceEligibility,
  computeFreshnessClass,
  evaluateEvidenceEligibility,
  isEvidenceEligible,
  EVIDENCE_ELIGIBLE_SOURCE_TYPES,
  MIN_EVIDENCE_CONFIDENCE,
  type MediaProvenance,
} from "../lib/media/mediaEvidenceEligibility.js";
import { recordMediaAsset, recordMediaEdit } from "../lib/mediaAssets.js";

// A fixed clock so freshness is deterministic.
const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

// ── 1. Edit classification (§35 taxonomy) ─────────────────────────────────────

describe("classifyEdit — §35 evidence-preserving vs evidence-breaking", () => {
  it("crop / rotate / brightness / contrast / color-temp are evidence-preserving", () => {
    for (const op of [
      "crop",
      "rotate",
      "straighten",
      "flip",
      "brightness",
      "exposure",
      "contrast",
      "saturation",
      "white_balance",
      "color_temperature",
      "levels",
    ]) {
      assert.equal(classifyEdit(op), "evidence_preserving", `${op} must preserve evidence`);
    }
  });

  it("generative / object add-remove / AI-enhance / composite are evidence-breaking", () => {
    for (const op of [
      "generative_fill",
      "generative_expand",
      "inpaint",
      "outpaint",
      "object_add",
      "object_remove",
      "content_aware_fill",
      "ai_enhance",
      "ai_upscale",
      "face_swap",
      "background_replace",
      "sky_replace",
      "style_transfer",
      "composite",
    ]) {
      assert.equal(classifyEdit(op), "evidence_breaking", `${op} must break evidence`);
    }
  });

  it("an unrecognized op is 'unknown' (fail-closed), not silently preserving", () => {
    assert.equal(classifyEdit("frobnicate"), "unknown");
    assert.equal(classifyEdit(""), "unknown");
    assert.equal(classifyEdit("   "), "unknown");
  });

  it("op names are normalized (case / spaces / hyphens) before lookup", () => {
    assert.equal(normalizeEditOp("Generative-Fill"), "generative_fill");
    assert.equal(classifyEdit("Generative Fill"), "evidence_breaking");
    assert.equal(classifyEdit("COLOR-TEMPERATURE"), "evidence_preserving");
  });
});

// ── 2. Eligibility — the §35 gate ─────────────────────────────────────────────

const cameraFresh = () => ({
  sourceType: "camera",
  capturedAt: minutesAgo(5),
  now: NOW,
});

describe("computeIntelligenceEligibility — the §35 gate", () => {
  it("camera capture with crop + brightness is STILL evidence-eligible", () => {
    const prov = appendEdit(
      appendEdit(initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) }), "crop", { at: minutesAgo(4) }),
      "brightness",
      { at: minutesAgo(3) },
    );
    const e = computeIntelligenceEligibility({
      sourceType: prov.sourceType,
      capturedAt: prov.capturedAt,
      editHistory: prov.editHistory,
      now: NOW,
    });
    assert.equal(e.eligible, true, "crop + brightness keep an authentic capture eligible");
    assert.ok(e.reasons.includes("evidence_eligible"));
    assert.ok(e.provenanceConfidence >= MIN_EVIDENCE_CONFIDENCE);
    assert.ok(e.captureConfidence >= MIN_EVIDENCE_CONFIDENCE);
  });

  it("a GENERATIVE edit is NOT evidence-eligible (but is still valid social media)", () => {
    // MUTATION-PROOF: if classifyEdit('generative_fill') were 'evidence_preserving',
    // this asserts BOTH the classification AND the verdict — both go RED.
    assert.equal(classifyEdit("generative_fill"), "evidence_breaking", "guards the mutation");

    const prov = appendEdit(
      initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) }),
      "generative_fill",
      { at: minutesAgo(2) },
    );
    const e = computeIntelligenceEligibility({
      sourceType: prov.sourceType,
      capturedAt: prov.capturedAt,
      editHistory: prov.editHistory,
      now: NOW,
    });
    assert.equal(e.eligible, false, "a generative alteration cannot back a live claim");
    assert.ok(e.reasons.includes("evidence_breaking_edit"), "the reason names the breaking edit");
    assert.equal(e.provenanceConfidence, 0, "a possibly-synthesized image has zero provenance confidence");

    // §35 BOUNDARY: the eligibility object says NOTHING about social usability —
    // it carries no moderation/visibility/social-block field, so it cannot
    // downgrade the post. The asset stays fully postable social media.
    const keys = Object.keys(e);
    for (const forbidden of ["moderation_status", "visibility", "blockSocial", "hidden", "socialEligible"]) {
      assert.ok(!keys.includes(forbidden), `eligibility object must not carry a social field (${forbidden})`);
    }
  });

  it("object_add (generative content) is also NOT eligible", () => {
    const prov = appendEdit(initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) }), "object_add");
    const e = computeIntelligenceEligibility({
      sourceType: prov.sourceType,
      capturedAt: prov.capturedAt,
      editHistory: prov.editHistory,
      now: NOW,
    });
    assert.equal(e.eligible, false);
  });

  it("source_type 'generated' is NOT eligible regardless of edits", () => {
    const e = computeIntelligenceEligibility({ sourceType: "generated", capturedAt: minutesAgo(5), now: NOW });
    assert.equal(e.eligible, false, "a generated asset is social-only, never live evidence");
    assert.ok(e.reasons.some((r) => r.startsWith("source_not_observation")));
    assert.equal(e.provenanceConfidence, 0);
  });

  it("an UNKNOWN edit is fail-closed NOT eligible", () => {
    // MUTATION-PROOF: if the classifier defaulted unknown ops to 'preserving',
    // this test goes RED. Fail-closed is the whole point of §35.
    const prov = appendEdit(initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) }), "quantum_smooth");
    assert.equal(prov.editHistory[0].class, "unknown", "the unclassified op is recorded as unknown");
    const e = computeIntelligenceEligibility({
      sourceType: prov.sourceType,
      capturedAt: prov.capturedAt,
      editHistory: prov.editHistory,
      now: NOW,
    });
    assert.equal(e.eligible, false, "an unclassified edit must never back a live claim");
    assert.ok(e.reasons.includes("unclassified_edit_fail_closed"));
    assert.equal(e.provenanceConfidence, 0);
  });

  it("a fresh camera capture with NO edits is eligible (baseline)", () => {
    const e = computeIntelligenceEligibility(cameraFresh());
    assert.equal(e.eligible, true);
  });

  it("no capture time ⇒ capture confidence below threshold ⇒ NOT eligible", () => {
    const e = computeIntelligenceEligibility({ sourceType: "camera", capturedAt: null, now: NOW });
    assert.equal(e.eligible, false);
    assert.ok(e.reasons.includes("capture_confidence_below_threshold"));
  });
});

// ── 3. Source allowlist (fail-closed) ─────────────────────────────────────────

describe("source allowlist — only first-party captures are eligible", () => {
  it("camera / library / community are the eligible set", () => {
    assert.deepEqual([...EVIDENCE_ELIGIBLE_SOURCE_TYPES].sort(), ["camera", "community", "library"]);
  });

  it("camera, library, community are eligible; provider/official/user/screenshot/derivative/generated are not", () => {
    const eligible = ["camera", "library", "community"];
    const ineligible = ["provider", "official", "user", "screenshot", "derivative", "generated"];
    for (const s of eligible) {
      assert.equal(
        computeIntelligenceEligibility({ sourceType: s, capturedAt: minutesAgo(5), now: NOW }).eligible,
        true,
        `${s} must be eligible`,
      );
    }
    for (const s of ineligible) {
      assert.equal(
        computeIntelligenceEligibility({ sourceType: s, capturedAt: minutesAgo(5), now: NOW }).eligible,
        false,
        `${s} must NOT be eligible`,
      );
    }
  });

  it("an unrecognized source normalizes to legacy 'user' and is NOT eligible", () => {
    const e = computeIntelligenceEligibility({ sourceType: "martian_feed", capturedAt: minutesAgo(5), now: NOW });
    assert.equal(e.eligible, false);
  });
});

// ── 4. Freshness — capped at 'fresh', never 'live' ────────────────────────────

describe("AT-05: computeFreshnessClass — old media never manufactures 'live'", () => {
  it("< 1h ⇒ 'fresh' (NOT 'live')", () => {
    assert.equal(computeFreshnessClass(minutesAgo(5), NOW), "fresh");
  });
  it("1h–24h ⇒ 'recent'", () => {
    assert.equal(computeFreshnessClass(minutesAgo(120), NOW), "recent");
  });
  it("> 24h ⇒ 'historical'", () => {
    assert.equal(computeFreshnessClass(minutesAgo(60 * 30), NOW), "historical");
  });
  it("no / invalid capture time ⇒ 'historical' (fail-closed)", () => {
    assert.equal(computeFreshnessClass(null, NOW), "historical");
    assert.equal(computeFreshnessClass("not-a-date", NOW), "historical");
  });
  it("NEVER returns 'live' across a wide age sweep", () => {
    for (let m = -60; m <= 60 * 48; m += 37) {
      assert.notEqual(computeFreshnessClass(minutesAgo(m), NOW), "live");
    }
  });
});

// ── 5. Lineage is appended, never overwritten ─────────────────────────────────

describe("appendEdit — lineage is append-only and non-mutating", () => {
  it("appends to the end and preserves prior entries in order", () => {
    const p0 = initProvenance({ sourceType: "camera", capturedAt: minutesAgo(10) });
    const p1 = appendEdit(p0, "crop", { at: minutesAgo(9) });
    const p2 = appendEdit(p1, "brightness", { at: minutesAgo(8) });
    const p3 = appendEdit(p2, "generative_fill", { at: minutesAgo(7) });

    assert.deepEqual(
      p3.editHistory.map((e) => e.op),
      ["crop", "brightness", "generative_fill"],
      "history grows at the end, earlier edits retained",
    );
    assert.deepEqual(
      p3.editHistory.map((e) => e.class),
      ["evidence_preserving", "evidence_preserving", "evidence_breaking"],
    );
  });

  it("does NOT mutate the input provenance (pure)", () => {
    const p0 = initProvenance({ sourceType: "camera", capturedAt: minutesAgo(10) });
    const before = JSON.stringify(p0);
    const p1 = appendEdit(p0, "crop");
    assert.equal(p0.editHistory.length, 0, "the original lineage is untouched");
    assert.equal(JSON.stringify(p0), before, "input object unchanged");
    assert.equal(p1.editHistory.length, 1, "the returned lineage has the new entry");
    assert.notStrictEqual(p0, p1, "a new object is returned");
  });

  it("records rawOp when the supplied name is not already normalized", () => {
    const p = appendEdit(initProvenance({ sourceType: "camera" }), "Generative Fill");
    assert.equal(p.editHistory[0].op, "generative_fill");
    assert.equal(p.editHistory[0].rawOp, "Generative Fill");
  });

  it("normalizeProvenance re-derives class from the op (a mislabeled stored class cannot pass)", () => {
    // A tampered row claims a generative edit is 'evidence_preserving'.
    const tampered = {
      sourceType: "camera",
      capturedAt: minutesAgo(5),
      editHistory: [{ op: "generative_fill", class: "evidence_preserving", at: minutesAgo(4) }],
    };
    const p = normalizeProvenance(tampered)!;
    assert.equal(p.editHistory[0].class, "evidence_breaking", "class re-derived from the op name");
    const e = computeIntelligenceEligibility({
      sourceType: p.sourceType,
      capturedAt: p.capturedAt,
      editHistory: p.editHistory,
      now: NOW,
    });
    assert.equal(e.eligible, false, "the mislabel cannot smuggle the asset back into eligibility");
  });
});

// ── 6. isEvidenceEligible — the composite verdict the intel seam calls ────────

describe("isEvidenceEligible — the media→intel contract", () => {
  it("returns TRUE for a first-party capture with only preserving edits (row shape, snake_case)", () => {
    const prov: MediaProvenance = appendEdit(
      initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) }),
      "crop",
    );
    const row = { source_type: "camera", captured_at: minutesAgo(5), provenance: prov, now: NOW };
    assert.equal(isEvidenceEligible(row), true);
  });

  it("returns FALSE once a generative edit is in the lineage", () => {
    const prov: MediaProvenance = appendEdit(
      initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) }),
      "generative_fill",
    );
    const row = { source_type: "camera", captured_at: minutesAgo(5), provenance: prov, now: NOW };
    assert.equal(isEvidenceEligible(row), false);
  });

  it("provenance is authoritative over the row's top-level source_type", () => {
    // Row claims 'camera' but provenance records the true 'generated' source.
    const prov: MediaProvenance = initProvenance({ sourceType: "generated", capturedAt: minutesAgo(5) });
    const row = { source_type: "camera", provenance: prov, now: NOW };
    assert.equal(isEvidenceEligible(row), false, "the true (generated) provenance wins");
  });

  it("falls back to the row's source_type when provenance is absent", () => {
    assert.equal(isEvidenceEligible({ source_type: "camera", captured_at: minutesAgo(5), now: NOW }), true);
    assert.equal(isEvidenceEligible({ source_type: "generated", captured_at: minutesAgo(5), now: NOW }), false);
  });

  it("evaluateEvidenceEligibility exposes the full §10 object", () => {
    const e = evaluateEvidenceEligibility({ source_type: "camera", captured_at: minutesAgo(5), now: NOW });
    assert.equal(typeof e.eligible, "boolean");
    assert.ok(Array.isArray(e.reasons));
    assert.ok(["live", "fresh", "recent", "historical"].includes(e.freshnessClass));
    assert.equal(typeof e.provenanceConfidence, "number");
    assert.equal(typeof e.captureConfidence, "number");
    assert.equal(typeof e.locationConfidence, "number");
    assert.equal(e.expiresAt, undefined, "media side never stamps an operational expiry");
  });
});

// ── 7. Write seam — recordMediaAsset + recordMediaEdit ────────────────────────

interface Op {
  table: string;
  kind: "select" | "upsert" | "update";
  row?: any;
}

function makeFake(opts: { flagEnabled: boolean; asset?: Record<string, unknown> | null }) {
  const ops: Op[] = [];
  const client: any = {
    from(table: string) {
      return {
        select(_c: string) {
          ops.push({ table, kind: "select" });
          const b: any = {
            eq() {
              return b;
            },
            maybeSingle() {
              if (table === "feature_flags") {
                return Promise.resolve({ data: opts.flagEnabled ? { enabled: true } : null, error: null });
              }
              if (table === "media_assets") {
                return Promise.resolve({ data: opts.asset ?? null, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
            single() {
              return Promise.resolve({ data: null, error: null });
            },
          };
          return b;
        },
        upsert(row: any) {
          ops.push({ table, kind: "upsert", row });
          return {
            select() {
              return { single() { return Promise.resolve({ data: { id: "asset-1" }, error: null }); } };
            },
          };
        },
        update(row: any) {
          ops.push({ table, kind: "update", row });
          return { eq() { return Promise.resolve({ error: null }); } };
        },
      };
    },
  };
  return { client, ops };
}

describe("recordMediaAsset — stamps provenance + eligibility (flag-gated)", () => {
  const BASE = {
    ownerUserId: "u1",
    storageBucket: "post-media",
    storagePath: "u1/pic.jpg",
    publicUrl: "post-media/u1/pic.jpg",
    mediaType: "image" as const,
    mimeType: "image/jpeg",
    sizeBytes: 1000,
    width: 800,
    height: 600,
  };

  it("flag ON: the upsert row carries provenance (empty lineage) + intelligence_eligibility", async () => {
    const { client, ops } = makeFake({ flagEnabled: true });
    const id = await recordMediaAsset(client, { ...BASE, sourceType: "camera", capturedAt: minutesAgo(5) });
    assert.equal(id, "asset-1");
    const up = ops.find((o) => o.table === "media_assets" && o.kind === "upsert")!;
    assert.ok(up, "an asset upsert happened");
    assert.ok(up.row.provenance, "provenance is set");
    assert.equal(up.row.provenance.sourceType, "camera");
    assert.deepEqual(up.row.provenance.editHistory, [], "a fresh upload has no edits");
    assert.ok(up.row.intelligence_eligibility, "eligibility is computed and set");
    assert.equal(up.row.intelligence_eligibility.eligible, true, "a fresh camera capture is eligible");
  });

  it("flag ON, source generated: row is written but eligibility is false", async () => {
    const { client, ops } = makeFake({ flagEnabled: true });
    await recordMediaAsset(client, { ...BASE, sourceType: "generated" });
    const up = ops.find((o) => o.table === "media_assets" && o.kind === "upsert")!;
    assert.equal(up.row.intelligence_eligibility.eligible, false);
  });

  it("flag OFF: writes nothing (no provenance computation reaches the DB)", async () => {
    const { client, ops } = makeFake({ flagEnabled: false });
    const id = await recordMediaAsset(client, { ...BASE, sourceType: "camera" });
    assert.equal(id, null);
    assert.equal(ops.filter((o) => o.table === "media_assets" && o.kind === "upsert").length, 0);
  });
});

describe("recordMediaEdit — appends lineage + recomputes eligibility", () => {
  it("a preserving edit keeps eligibility true and appends to existing lineage", async () => {
    const existing = initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) });
    const { client, ops } = makeFake({
      flagEnabled: true,
      asset: { source_type: "camera", captured_at: minutesAgo(5), provenance: existing },
    });
    const res = await recordMediaEdit(client, "asset-1", "crop", { at: minutesAgo(2) });
    assert.ok(res);
    assert.equal(res!.recorded, true);
    assert.equal(res!.evidenceEligible, true);
    const upd = ops.find((o) => o.table === "media_assets" && o.kind === "update")!;
    assert.equal(upd.row.provenance.editHistory.length, 1, "the edit was appended");
    assert.equal(upd.row.provenance.editHistory[0].op, "crop");
    assert.equal(upd.row.intelligence_eligibility.eligible, true);
  });

  it("a generative edit flips eligibility to FALSE (social-only) and still records the lineage", async () => {
    const existing = appendEdit(initProvenance({ sourceType: "camera", capturedAt: minutesAgo(5) }), "crop", {
      at: minutesAgo(4),
    });
    const { client, ops } = makeFake({
      flagEnabled: true,
      asset: { source_type: "camera", captured_at: minutesAgo(5), provenance: existing },
    });
    const res = await recordMediaEdit(client, "asset-1", "generative_fill", { at: minutesAgo(1) });
    assert.equal(res!.evidenceEligible, false, "the generative edit removes live-evidence eligibility");
    const upd = ops.find((o) => o.table === "media_assets" && o.kind === "update")!;
    assert.deepEqual(
      upd.row.provenance.editHistory.map((e: any) => e.op),
      ["crop", "generative_fill"],
      "prior crop retained; generative edit appended (lineage not overwritten)",
    );
    assert.equal(upd.row.intelligence_eligibility.eligible, false);
  });

  it("flag OFF: records nothing (returns null)", async () => {
    const { client, ops } = makeFake({ flagEnabled: false });
    const res = await recordMediaEdit(client, "asset-1", "crop");
    assert.equal(res, null);
    assert.equal(ops.filter((o) => o.kind === "update").length, 0);
  });

  it("asset missing: returns null, writes nothing", async () => {
    const { client, ops } = makeFake({ flagEnabled: true, asset: null });
    const res = await recordMediaEdit(client, "nope", "crop");
    assert.equal(res, null);
    assert.equal(ops.filter((o) => o.kind === "update").length, 0);
  });
});

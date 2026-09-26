/**
 * mediaCanonicalLayers — census-media §20 (Lane B), the unit half.
 *
 * The DB half — the constraints and the version trigger — is
 * src/test/db/mediaCanonicalContract.db.test.ts, executed against PostgreSQL.
 * Everything here runs with no database: pure functions, and the service paths
 * through a recording fake whose every table answer is stated in the test.
 *
 * Rows under test, and the assertion group that carries each:
 *   MD36  §6 MediaAsset contract ........... "MD36 — toMediaAsset"
 *   MD38  version / compare-and-set ........ "MD38 — casUpdateMediaAsset"
 *   MD43  visibilityOverride ............... "MD43 — the override rule"
 *   MD44  one asset, many objects .......... "MD44 — recordPostMediaAttachments"
 *   MD57 / MD60 / MD343  provenance layer .. "MD57 — the §8 provenance layer"
 *   MD73  locationConfidence ............... "MD73 — locationConfidence"
 *   MD75  expiresAt ........................ "MD75 — the operational lifetime"
 *   MD76 / MD78  MediaTemporalState ........ "MD76 — MediaTemporalState"
 *   MD339 / MD429  canonical read path ..... "MD339 — the canonical asset on the read path"
 *   MD369 POST /media/:id/attachments ...... "MD369 — POST /media/:id/attachments, over HTTP"
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  computeIntelligenceEligibility,
  evaluateEvidenceEligibility,
  initProvenance,
  appendEdit,
  isOperationalEvidenceAt,
  locationBasisFromPost,
  LOCATION_CONFIDENCE_BY_BASIS,
  INTELLIGENCE_OPERATIONAL_WINDOW_MS,
} from "../lib/media/mediaEvidenceEligibility.js";
import { observationsHaveEligibleMediaEvidence } from "../lib/media/mediaEvidenceLink.js";
import { resolveMediaTemporalState, intelligenceExpired } from "../lib/media/mediaTemporalState.js";
import {
  toMediaAsset,
  toCanonicalModerationStatus,
  toStoredMediaVisibility,
} from "../lib/media/mediaAssetContract.js";
import {
  toMediaProjection,
  applyLocationDisclosure,
  type MediaCandidateRow,
} from "../lib/media/mediaProjection.js";
import { mayViewUnderOverride, authorizeMediaAttachment } from "../lib/mediaVisibility.js";
import {
  casUpdateMediaAsset,
  recordMediaEditWithRetry,
  recordPostMediaAttachments,
  recordEntityMedia,
} from "../lib/mediaAssets.js";
import { resetCanonicalSchemaMemo } from "../lib/media/mediaSchemaCapability.js";
import {
  prepareCanonicalRows,
  projectCandidatesProtected,
  type ViewerResolved,
} from "../services/media/MediaProjectionService.js";
import type { MediaPlaceDisclosure } from "../lib/mediaLocationVisibility.js";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaActionsRouter from "../routes/mediaActions.js";

// ── A recording fake. Every answer is the handler's; nothing is implied. ─────

type Filter = [op: string, col: string, val: unknown];
interface Call {
  table: string;
  op: "select" | "update" | "upsert" | "insert" | "delete";
  columns?: string;
  payload?: any;
  filters: Filter[];
}
type Answer = { data: any; error: any };

function makeDb(handler: (c: Call) => Answer) {
  const calls: Call[] = [];
  const client: any = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const done = (): Promise<Answer> => {
        calls.push(call);
        return Promise.resolve(handler(call));
      };
      const b: any = {
        select(cols?: string) {
          if (call.op === "select") call.columns = cols;
          return b;
        },
        update(p: any) { call.op = "update"; call.payload = p; return b; },
        upsert(p: any) { call.op = "upsert"; call.payload = p; return b; },
        insert(p: any) { call.op = "insert"; call.payload = p; return b; },
        delete() { call.op = "delete"; return b; },
        eq(c: string, v: unknown) { call.filters.push(["eq", c, v]); return b; },
        neq(c: string, v: unknown) { call.filters.push(["neq", c, v]); return b; },
        in(c: string, v: unknown) { call.filters.push(["in", c, v]); return b; },
        is(c: string, v: unknown) { call.filters.push(["is", c, v]); return b; },
        gte(c: string, v: unknown) { call.filters.push(["gte", c, v]); return b; },
        lte(c: string, v: unknown) { call.filters.push(["lte", c, v]); return b; },
        order() { return b; },
        limit() { return b; },
        maybeSingle: done,
        single: done,
        then(res: (a: Answer) => unknown, rej?: (e: unknown) => unknown) {
          return done().then(res, rej);
        },
      };
      return b;
    },
  };
  return { client, calls };
}

const eqOf = (c: Call, col: string) => c.filters.find((f) => f[0] === "eq" && f[1] === col)?.[2];
const inOf = (c: Call, col: string) => c.filters.find((f) => f[0] === "in" && f[1] === col)?.[2] as unknown[] | undefined;

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60 * 1000;

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";
const POST = "33333333-3333-4333-8333-333333333333";
const MOMENT = "44444444-4444-4444-8444-444444444444";
const TRIP = "55555555-5555-4555-8555-555555555555";

function viewer(over: Partial<ViewerResolved> = {}): ViewerResolved {
  return {
    viewerId: VIEWER,
    viewerCountry: null,
    viewerAge: null,
    followedCreatorIds: new Set<string>(),
    viewerTripIds: new Set<string>(),
    ...over,
  };
}

/** A canonical media_assets row as the canonical read embeds it. */
function assetRow(over: Record<string, unknown> = {}) {
  return {
    id: "ma-1",
    owner_user_id: OWNER,
    uploader_user_id: OWNER,
    storage_bucket: "post-media",
    storage_path: `${OWNER}/a.jpg`,
    mime_type: "image/jpeg",
    size_bytes: 1234,
    created_at: ago(2 * HOUR),
    media_type: "image",
    public_url: "post-media/canonical.jpg",
    thumbnail_url: null,
    width: 800,
    height: 600,
    duration_ms: null,
    captured_at: ago(HOUR),
    processing_status: "ready",
    moderation_status: "approved",
    source_type: "camera",
    visibility: "inherit",
    location_visibility: "place",
    provenance: initProvenance({ sourceType: "camera", capturedAt: ago(HOUR) }),
    intelligence_eligibility: null,
    version: 3,
    position: 0,
    is_cover: true,
    visibility_override: null,
    ...over,
  };
}

function postRow(over: Partial<MediaCandidateRow> = {}): MediaCandidateRow {
  return {
    id: POST,
    author_id: OWNER,
    created_at: ago(3 * HOUR),
    location_name: "Cafe",
    location_city: "Lisbon",
    location_country: "PT",
    location_source: "gps",
    location_verified: true,
    geotag_verified: false,
    post_media: [{
      id: "pm-1", media_type: "image", public_url: "post-media/legacy.jpg", thumbnail_url: null,
      width: 100, height: 100, sort_order: 0, processing_status: "ready", moderation_status: "approved",
    }],
    profiles: { id: OWNER, username: "owner", verified: true, is_official: false },
    ...over,
  };
}

// ── MD75 ─────────────────────────────────────────────────────────────────────

describe("MD75 — the operational lifetime (§10 expiresAt), stamped and enforced", () => {
  it("an ELIGIBLE asset expires exactly INTELLIGENCE_OPERATIONAL_WINDOW_MS after capture", () => {
    const e = computeIntelligenceEligibility({ sourceType: "camera", capturedAt: ago(HOUR), now: NOW });
    assert.equal(e.eligible, true);
    assert.equal(e.expiresAt, new Date(NOW - HOUR + INTELLIGENCE_OPERATIONAL_WINDOW_MS).toISOString());
    assert.equal(INTELLIGENCE_OPERATIONAL_WINDOW_MS, 24 * HOUR, "the instant freshnessClass turns 'historical'");
  });

  it("an INELIGIBLE asset has no operational value, so nothing to expire", () => {
    for (const input of [
      { sourceType: "generated", capturedAt: ago(HOUR) },
      { sourceType: "user", capturedAt: ago(HOUR) },
      { sourceType: "camera", capturedAt: null },
    ]) {
      const e = computeIntelligenceEligibility({ ...input, now: NOW });
      assert.equal(e.eligible, false);
      assert.equal(e.expiresAt, undefined, JSON.stringify(input));
    }
  });

  it("isOperationalEvidenceAt: true inside the lifetime, false past it — eligibility itself does not decay", () => {
    const asset = { source_type: "camera", captured_at: ago(HOUR) };
    assert.equal(isOperationalEvidenceAt(asset, NOW), true);
    const later = NOW + 24 * HOUR; // capture + 25 h
    assert.equal(isOperationalEvidenceAt(asset, later), false, "a photograph of a past 'now' cannot back a current claim");
    assert.equal(
      evaluateEvidenceEligibility({ ...asset, now: later }).eligible,
      true,
      "§35 eligibility is a property of source and lineage and must NOT decay (PresenceVerifier relies on it)",
    );
  });

  it("the evidence READ side refuses an expired asset and accepts a fresh one", async () => {
    const make = (capturedAt: string) =>
      makeDb((c) => {
        if (c.table === "intel_evidence") return { data: [{ media_asset_id: "ma-1" }], error: null };
        if (c.table === "media_assets") {
          return { data: [{ id: "ma-1", source_type: "camera", captured_at: capturedAt, provenance: null }], error: null };
        }
        return { data: null, error: null };
      }).client;
    assert.equal(await observationsHaveEligibleMediaEvidence(make(ago(HOUR)), ["o1"], NOW), true);
    assert.equal(
      await observationsHaveEligibleMediaEvidence(make(ago(30 * HOUR)), ["o1"], NOW),
      false,
      "an asset 30 h past capture is outside its operational lifetime",
    );
  });
});

// ── MD73 ─────────────────────────────────────────────────────────────────────

describe("MD73 — locationConfidence distinguishes a verified GPS fix from a hand-typed venue", () => {
  it("derives the basis from the post's own server-decided columns, never a coordinate", () => {
    assert.equal(locationBasisFromPost({ location_source: "gps", location_verified: true }), "verified_gps");
    assert.equal(locationBasisFromPost({ location_source: "gps", geotag_verified: true }), "verified_gps");
    assert.equal(locationBasisFromPost({ location_source: "gps", location_verified: false }), "gps");
    assert.equal(locationBasisFromPost({ location_source: "manual", location_verified: true }), "manual",
      "a typed place is never promoted by a verified flag");
    assert.equal(locationBasisFromPost({ location_source: "none" }), "none");
    assert.equal(locationBasisFromPost({ location_source: "satellite" }), "none", "unknown ⇒ weakest");
    assert.equal(locationBasisFromPost(null), "none");
  });

  it("the classifier gives the two a DIFFERENT scalar", () => {
    const at = (basis: "verified_gps" | "manual") =>
      computeIntelligenceEligibility({ sourceType: "camera", capturedAt: ago(HOUR), locationBasis: basis, now: NOW })
        .locationConfidence;
    assert.equal(at("verified_gps"), LOCATION_CONFIDENCE_BY_BASIS.verified_gps);
    assert.equal(at("manual"), LOCATION_CONFIDENCE_BY_BASIS.manual);
    assert.ok(at("verified_gps") > at("manual"));
  });

  it("rows written before the basis existed read exactly as before", () => {
    const withLoc = computeIntelligenceEligibility({ sourceType: "camera", capturedAt: ago(HOUR), hasLocation: true, now: NOW });
    const noLoc = computeIntelligenceEligibility({ sourceType: "camera", capturedAt: ago(HOUR), hasLocation: false, now: NOW });
    assert.equal(withLoc.locationConfidence, 0.7);
    assert.equal(noLoc.locationConfidence, 0.2);
  });

  it("a stored basis survives the provenance round trip; a forged one is dropped", () => {
    const prov = initProvenance({ sourceType: "camera", capturedAt: ago(HOUR), locationBasis: "verified_gps" });
    assert.equal(evaluateEvidenceEligibility({ provenance: prov, now: NOW }).locationConfidence, 0.9);
    const forged = { ...prov, locationBasis: "satellite_certified" };
    assert.equal(evaluateEvidenceEligibility({ provenance: forged, now: NOW }).locationConfidence, 0.7,
      "an unknown basis is not trusted; hasLocation's value applies");
  });
});

// ── MD76 / MD78 ──────────────────────────────────────────────────────────────

describe("MD76 — MediaTemporalState, served, with the intelligence lifetime its own", () => {
  it("resolves intelligenceExpiresAt from an eligible asset only", () => {
    const e = computeIntelligenceEligibility({ sourceType: "camera", capturedAt: ago(HOUR), now: NOW });
    assert.deepEqual(resolveMediaTemporalState({ eligibility: e }), { intelligenceExpiresAt: e.expiresAt });
    assert.deepEqual(resolveMediaTemporalState({ eligibility: null }), {});
    assert.deepEqual(
      resolveMediaTemporalState({ eligibility: { eligible: false, expiresAt: e.expiresAt } }),
      {},
      "a stale expiresAt on an ineligible asset is not a lifetime",
    );
  });

  it("MD78 — a canonical camera capture is SERVED with its intelligence lifetime", () => {
    const p = toMediaProjection(postRow({ canonical_media: [assetRow()] }), NOW);
    assert.ok(p);
    assert.equal(p.url, "post-media/canonical.jpg");
    assert.equal(p.temporal.intelligenceExpiresAt, new Date(NOW - HOUR + 24 * HOUR).toISOString());
    assert.equal(intelligenceExpired(p.temporal, NOW), false);
    assert.equal(intelligenceExpired(p.temporal, NOW + 24 * HOUR), true);
  });

  it("§11 independence — a generative edit ends the intelligence lifetime and NOTHING else", () => {
    const prov = appendEdit(initProvenance({ sourceType: "camera", capturedAt: ago(HOUR) }), "generative_fill", { at: ago(HOUR) });
    const p = toMediaProjection(postRow({ canonical_media: [assetRow({ provenance: prov })] }), NOW);
    assert.ok(p, "the item is still served — social life is untouched");
    assert.deepEqual(p.temporal, {}, "no operational intelligence value, so no intelligence lifetime");
    assert.equal(p.provenance.edits.evidenceBreaking, 1);
  });

  it("a legacy item carries no provenance, hence no intelligence lifetime", () => {
    const p = toMediaProjection(postRow(), NOW);
    assert.ok(p);
    assert.deepEqual(p.temporal, {});
  });
});

// ── MD57 / MD60 / MD343 ──────────────────────────────────────────────────────

describe("MD57 — the §8 provenance layer is on every served media object", () => {
  it("canonical: declared source, capture clock, lineage counts, §36 moderation, trust", () => {
    const prov = appendEdit(
      appendEdit(initProvenance({ sourceType: "camera", capturedAt: ago(HOUR) }), "crop", { at: ago(HOUR), detail: { box: [1, 2, 3, 4] } }),
      "mystery_filter",
      { at: ago(HOUR) },
    );
    const p = toMediaProjection(postRow({ canonical_media: [assetRow({ provenance: prov })] }), NOW);
    assert.ok(p);
    assert.equal(p.provenance.basis, "canonical");
    assert.equal(p.provenance.sourceType, "camera");
    assert.equal(p.provenance.capturedAt, ago(HOUR));
    assert.deepEqual(p.provenance.edits, { count: 2, evidenceBreaking: 0, unclassified: 1 });
    assert.equal(p.provenance.moderation, "active", "legacy 'approved' is presented as §36 'active'");
    assert.deepEqual(p.provenance.trust, { verifiedContributor: true, officialSource: false });
    assert.equal(p.provenance.locationBasis, "verified_gps");
    assert.equal(p.provenance.locationConfidence, 0.9);
    assert.equal(JSON.stringify(p).includes("box"), false, "edit parameters are never served");
  });

  it("legacy: the layer says it has no provenance rather than inventing one", () => {
    const p = toMediaProjection(postRow({ location_source: "manual", location_verified: false }), NOW);
    assert.ok(p);
    assert.equal(p.provenance.basis, "legacy");
    assert.equal(p.provenance.sourceType, "undeclared");
    assert.equal(p.provenance.capturedAt, null);
    assert.deepEqual(p.provenance.edits, { count: 0, evidenceBreaking: 0, unclassified: 0 });
    assert.equal(p.provenance.moderation, "active", "post_media 'approved'");
    assert.equal(p.provenance.locationBasis, "manual");
    assert.equal(p.provenance.locationConfidence, 0.3);
  });

  it("the legacy 0191 default source 'user' is served as 'undeclared'", () => {
    const p = toMediaProjection(postRow({
      canonical_media: [assetRow({ source_type: "user", provenance: initProvenance({ sourceType: "user" }) })],
    }), NOW);
    assert.ok(p);
    assert.equal(p.provenance.sourceType, "undeclared");
  });

  it("the location half is WITHHELD when the choke point hides the location", () => {
    const p = toMediaProjection(postRow(), NOW)!;
    const hidden: MediaPlaceDisclosure = {
      visibility: "hidden", precision: "none" as any, name: null, neighborhood: null, city: null, country: null,
      lat: null, lng: null, coordsAreExact: false, mayDisclosePlaceId: false,
    };
    const out = applyLocationDisclosure(p, hidden);
    assert.equal(out.provenance.locationBasis, null);
    assert.equal(out.provenance.locationConfidence, null);
    const city: MediaPlaceDisclosure = { ...hidden, visibility: "city", city: "Lisbon" };
    assert.equal(applyLocationDisclosure(p, city).provenance.locationBasis, "verified_gps");
  });
});

// ── MD36 ─────────────────────────────────────────────────────────────────────

describe("MD36 — toMediaAsset produces the §6 contract from a media_assets row", () => {
  it("maps every §6 member", () => {
    const a = toMediaAsset(assetRow({ thumbnail_path: `${OWNER}/a.thumb.jpg`, duration_ms: 1500 }));
    assert.ok(a);
    assert.equal(a.id, "ma-1");
    assert.equal(a.ownerUserId, OWNER);
    assert.equal(a.uploaderUserId, OWNER);
    assert.equal(a.mediaType, "image");
    assert.equal(a.storageBucket, "post-media");
    assert.equal(a.storagePath, `${OWNER}/a.jpg`);
    assert.equal(a.thumbnailPath, `${OWNER}/a.thumb.jpg`);
    assert.equal(a.mimeType, "image/jpeg");
    assert.equal(a.width, 800);
    assert.equal(a.height, 600);
    assert.equal(a.durationMs, 1500);
    assert.equal(a.sizeBytes, 1234);
    assert.equal(a.capturedAt, ago(HOUR));
    assert.equal(a.uploadedAt, ago(2 * HOUR));
    assert.equal(a.sourceType, "camera");
    assert.equal(a.processingStatus, "ready");
    assert.equal(a.moderationStatus, "active");
    assert.equal(a.visibility, "inherit");
    assert.equal(a.locationVisibility, "place");
    assert.equal(a.provenance?.sourceType, "camera");
    assert.equal(a.version, 3);
  });

  it("reads both moderation vocabularies in §36 terms, and refuses to guess", () => {
    assert.equal(toCanonicalModerationStatus("pending"), "processing");
    assert.equal(toCanonicalModerationStatus("approved"), "active");
    assert.equal(toCanonicalModerationStatus("flagged"), "limited");
    assert.equal(toCanonicalModerationStatus("owner_deleted"), "owner_deleted");
    assert.equal(toCanonicalModerationStatus("banana"), null);
  });

  it("an unknown stored visibility is read as private (fail-closed)", () => {
    assert.equal(toStoredMediaVisibility("followers"), "followers");
    assert.equal(toStoredMediaVisibility("friends_only"), "private");
  });

  it("a row without its identity cannot become a MediaAsset", () => {
    assert.equal(toMediaAsset({ ...assetRow(), owner_user_id: null }), null);
    assert.equal(toMediaAsset({ ...assetRow(), storage_path: "" }), null);
    assert.equal(toMediaAsset({ ...assetRow(), media_type: "audio" }), null);
  });
});

// ── MD43 ─────────────────────────────────────────────────────────────────────

describe("MD43 — the override rule, one definition for bytes and projection", () => {
  const follows = (rows: Array<{ follower_id: string; following_id: string }>) =>
    makeDb((c) => {
      if (c.table === "user_follows") {
        const hit = rows.find((r) => r.follower_id === eqOf(c, "follower_id") && r.following_id === eqOf(c, "following_id"));
        return { data: hit ?? null, error: null };
      }
      return { data: null, error: null };
    }).client;

  it("inherit narrows NOTHING (it used to make an attachment owner-only)", async () => {
    assert.equal(await mayViewUnderOverride(follows([]), VIEWER, OWNER, "inherit"), true);
  });

  it("private is the owner only; public narrows nothing; unknown is denied", async () => {
    assert.equal(await mayViewUnderOverride(follows([]), VIEWER, OWNER, "private"), false);
    assert.equal(await mayViewUnderOverride(follows([]), OWNER, OWNER, "private"), true);
    assert.equal(await mayViewUnderOverride(follows([]), VIEWER, OWNER, "public"), true);
    assert.equal(await mayViewUnderOverride(follows([]), VIEWER, OWNER, "friends_only"), false);
  });

  it("followers / following resolve in their own directions", async () => {
    const db = follows([{ follower_id: VIEWER, following_id: OWNER }]);
    assert.equal(await mayViewUnderOverride(db, VIEWER, OWNER, "followers"), true);
    assert.equal(await mayViewUnderOverride(db, VIEWER, OWNER, "following"), false);
  });

  it("shared_moment is the MOMENT's accepted members, through an APPROVED contribution", async () => {
    const db = (opts: { contributionStatus: string; member: boolean }) =>
      makeDb((c) => {
        if (c.table === "shared_moment_contributions") {
          return {
            data: eqOf(c, "status") === opts.contributionStatus && opts.contributionStatus === "approved"
              ? [{ moment_id: MOMENT }]
              : [],
            error: null,
          };
        }
        if (c.table === "shared_moment_memberships") {
          const ok = opts.member && eqOf(c, "user_id") === VIEWER && eqOf(c, "status") === "accepted"
            && (inOf(c, "moment_id") ?? []).includes(MOMENT);
          return { data: ok ? [{ moment_id: MOMENT }] : [], error: null };
        }
        if (c.table === "trip_members") return { data: { user_id: VIEWER, role: "member", status: "accepted" }, error: null };
        return { data: null, error: null };
      }).client;
    const entity = { entityType: "post", entityId: POST };
    const trip = { contextType: "trip" as const, contextId: TRIP };
    assert.equal(await mayViewUnderOverride(db({ contributionStatus: "approved", member: true }), VIEWER, OWNER, "shared_moment", { entity, context: trip }), true);
    assert.equal(
      await mayViewUnderOverride(db({ contributionStatus: "approved", member: false }), VIEWER, OWNER, "shared_moment", { entity, context: trip }),
      false,
      "trip crew who are not in the Moment are NOT its audience",
    );
    assert.equal(
      await mayViewUnderOverride(db({ contributionStatus: "pending", member: true }), VIEWER, OWNER, "shared_moment", { entity, context: trip }),
      false,
      "a pending contribution does not put the post in the Moment",
    );
    assert.equal(
      await mayViewUnderOverride(db({ contributionStatus: "approved", member: true }), VIEWER, OWNER, "shared_moment", {
        entity: { entityType: "shared_moment", entityId: MOMENT },
      }),
      true,
      "an attachment ON the Moment resolves to the Moment",
    );
  });

  it("the byte path (authorizeMediaAttachment) uses the same rule", async () => {
    const db = makeDb((c) => {
      if (c.table === "media_attachments") return { data: { visibility_override: "inherit" }, error: null };
      return { data: null, error: null };
    }).client;
    assert.equal(await authorizeMediaAttachment(db, VIEWER, OWNER, "ma-1", { entityType: "post", entityId: POST }), true);
  });

  it("any read error denies", async () => {
    const db = makeDb(() => ({ data: null, error: { code: "57P01", message: "down" } })).client;
    assert.equal(await mayViewUnderOverride(db, VIEWER, OWNER, "followers"), false);
    assert.equal(await mayViewUnderOverride(db, VIEWER, OWNER, "shared_moment", { entity: { entityType: "post", entityId: POST } }), false);
  });
});

// ── MD339 / MD429 / MD36 read path ───────────────────────────────────────────

describe("MD339 — the canonical asset on the read path, and the override on the SERVED item", () => {
  const db = (opts: { readFlag: boolean; attachments: any[] }) =>
    makeDb((c) => {
      if (c.table === "feature_flags") {
        return { data: eqOf(c, "flag") === "media_canonical_read_enabled" && opts.readFlag ? { enabled: true } : null, error: null };
      }
      if (c.table === "media_attachments") return { data: opts.attachments, error: null };
      if (c.table === "user_follows") return { data: null, error: null };
      return { data: [], error: null };
    });

  const attachment = (over: Record<string, unknown> = {}) => ({
    entity_id: POST, position: 0, is_cover: true, visibility_override: null, media_assets: assetRow(), ...over,
  });

  it("read flag OFF: no attachment query, the legacy media is served exactly as before", async () => {
    const { client, calls } = db({ readFlag: false, attachments: [attachment()] });
    const out = await projectCandidatesProtected(client, viewer(), [postRow()], NOW);
    assert.equal(calls.some((c) => c.table === "media_attachments"), false, "the gate precedes the query");
    assert.equal(out.length, 1);
    assert.equal(out[0]!.url, "post-media/legacy.jpg");
    assert.equal(out[0]!.provenance.basis, "legacy");
  });

  it("read flag ON: the projection serves the CANONICAL asset and its provenance", async () => {
    const { client, calls } = db({ readFlag: true, attachments: [attachment()] });
    const out = await projectCandidatesProtected(client, viewer(), [postRow()], NOW);
    const read = calls.find((c) => c.table === "media_attachments")!;
    assert.ok(read, "the canonical read ran");
    assert.ok(String(read.columns).includes("visibility_override"), "the attachment's override is read");
    assert.ok(String(read.columns).includes("provenance"), "the asset's provenance is read");
    assert.equal(out.length, 1);
    assert.equal(out[0]!.url, "post-media/canonical.jpg");
    assert.equal(out[0]!.provenance.basis, "canonical");
    assert.equal(out[0]!.capturedAt, ago(HOUR), "the §6 capture clock, not the publish clock");
  });

  it("a PRIVATE attachment withholds the item from a non-owner — with no fallback to the same file in post_media", async () => {
    const { client } = db({ readFlag: true, attachments: [attachment({ visibility_override: "private" })] });
    const out = await projectCandidatesProtected(client, viewer(), [postRow()], NOW);
    assert.equal(out.length, 0, "the legacy branch must not serve what the override withheld");
  });

  it("…and the owner still sees it", async () => {
    const { client } = db({ readFlag: true, attachments: [attachment({ visibility_override: "private" })] });
    const out = await projectCandidatesProtected(client, viewer({ viewerId: OWNER }), [postRow()], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.url, "post-media/canonical.jpg");
  });

  it("a narrowed attachment next to an open one serves the open one", async () => {
    const { client } = db({
      readFlag: true,
      attachments: [
        attachment({ position: 0, visibility_override: "private", media_assets: assetRow({ id: "ma-private", public_url: "post-media/private.jpg" }) }),
        attachment({ position: 1, visibility_override: null, media_assets: assetRow({ id: "ma-open", public_url: "post-media/open.jpg" }) }),
      ],
    });
    const out = await projectCandidatesProtected(client, viewer(), [postRow()], NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.url, "post-media/open.jpg");
  });

  it("when the only surviving canonical asset is not servable, the item is DROPPED — never served from post_media", async () => {
    // Found by mutation M10: with the legacy branches left in place, this row
    // fell through to post_media and served a file the override had withheld.
    const { client } = db({
      readFlag: true,
      attachments: [
        attachment({ position: 0, visibility_override: "private", media_assets: assetRow({ id: "ma-private" }) }),
        attachment({ position: 1, visibility_override: null, media_assets: assetRow({ id: "ma-processing", processing_status: "processing" }) }),
      ],
    });
    const out = await projectCandidatesProtected(client, viewer(), [postRow()], NOW);
    assert.equal(out.length, 0, "post_media holds the same file the private attachment withheld");
  });

  it("does not mutate the caller's rows beyond the attach", async () => {
    const { client } = db({ readFlag: true, attachments: [attachment({ visibility_override: "private" })] });
    const rows = [postRow()];
    await prepareCanonicalRows(client, viewer(), rows);
    assert.equal((rows[0]!.post_media as any[]).length, 1, "the caller's row keeps its legacy media");
  });
});

// ── MD38 ─────────────────────────────────────────────────────────────────────

describe("MD38 — casUpdateMediaAsset: compare-and-set on version", () => {
  it("writes version+1 filtered on the version it read, and reports a zero-row match as a conflict", async () => {
    const matched = makeDb(() => ({ data: [{ id: "ma-1", version: 4 }], error: null }));
    assert.equal(await casUpdateMediaAsset(matched.client, "ma-1", 3, { provenance: {} }), "written");
    const up = matched.calls[0]!;
    assert.equal(up.op, "update");
    assert.equal(up.payload.version, 4);
    assert.equal(eqOf(up, "version"), 3, "the update is filtered on the version read");
    const lost = makeDb(() => ({ data: [], error: null }));
    assert.equal(await casUpdateMediaAsset(lost.client, "ma-1", 3, {}), "conflict",
      "PostgREST reports a zero-row UPDATE as success; the row count is what tells");
  });

  it("refuses to write blind when no version was read", async () => {
    const { client, calls } = makeDb(() => ({ data: [{ id: "ma-1" }], error: null }));
    assert.equal(await casUpdateMediaAsset(client, "ma-1", null, {}), "failed");
    assert.equal(calls.length, 0);
  });

  it("a lost race is re-read and re-applied, so BOTH edits survive in the §35 lineage", async () => {
    resetCanonicalSchemaMemo();
    // The stored row: one edit at version 1. A concurrent writer lands 'rotate'
    // between our first read and our first update.
    let stored = {
      source_type: "camera",
      captured_at: ago(HOUR),
      provenance: appendEdit(initProvenance({ sourceType: "camera", capturedAt: ago(HOUR) }), "crop", { at: ago(HOUR) }),
      version: 1,
    };
    let reads = 0;
    const { client } = makeDb((c) => {
      if (c.table === "feature_flags") return { data: { enabled: true }, error: null };
      if (c.table === "media_assets" && c.op === "select" && eqOf(c, "id") === "00000000-0000-0000-0000-000000000000") {
        return { data: null, error: null }; // schema probe sentinel: present
      }
      if (c.table === "media_assets" && c.op === "select") {
        reads++;
        const snapshot = { ...stored };
        if (reads === 1) {
          // The concurrent writer commits right after this read.
          stored = {
            ...stored,
            provenance: appendEdit(stored.provenance, "rotate", { at: ago(HOUR) }),
            version: 2,
          };
        }
        return { data: snapshot, error: null };
      }
      if (c.table === "media_assets" && c.op === "update") {
        if (eqOf(c, "version") !== stored.version) return { data: [], error: null };
        stored = { ...stored, provenance: c.payload.provenance, version: stored.version + 1 };
        return { data: [{ id: "ma-1", version: stored.version }], error: null };
      }
      return { data: null, error: null };
    });
    const res = await recordMediaEditWithRetry(client, "ma-1", "brightness", { at: ago(HOUR) });
    assert.ok(res);
    assert.equal(res.recorded, true);
    assert.deepEqual(stored.provenance.editHistory.map((e) => e.op), ["crop", "rotate", "brightness"],
      "the concurrent 'rotate' must not be lost");
    assert.equal(stored.version, 3);
  });
});

// ── MD44 ─────────────────────────────────────────────────────────────────────

describe("MD44 — recordPostMediaAttachments: the post joins its file's ONE asset", () => {
  beforeEach(() => resetCanonicalSchemaMemo());

  const db = (opts: { flag: boolean; schemaPresent: boolean; existingOwner: string | null }) =>
    makeDb((c) => {
      if (c.table === "feature_flags") {
        return { data: opts.flag && eqOf(c, "flag") === "media_canonical_enabled" ? { enabled: true } : null, error: null };
      }
      if (c.table === "media_assets" && c.op === "select" && String(c.columns).includes("captured_at")) {
        return opts.schemaPresent
          ? { data: null, error: null }
          : { data: null, error: { code: "42703", message: 'column media_assets.captured_at does not exist' } };
      }
      if (c.table === "media_assets" && c.op === "select") {
        return { data: opts.existingOwner ? { id: "ma-existing", owner_user_id: opts.existingOwner } : null, error: null };
      }
      if (c.table === "media_attachments" && c.op === "upsert") return { data: { id: `att-${c.payload.position}` }, error: null };
      if (c.table === "media_assets" && c.op === "upsert") return { data: { id: "ma-new" }, error: null };
      return { data: null, error: null };
    });

  it("links each storage-backed file to the post, reusing the upload's asset — no second asset row", async () => {
    const { client, calls } = db({ flag: true, schemaPresent: true, existingOwner: OWNER });
    const n = await recordPostMediaAttachments(client, {
      postId: POST, authorId: OWNER,
      mediaUrls: [`post-media/${OWNER}/a.jpg`, "https://elsewhere.example/x.jpg", `post-media/${OWNER}/b.jpg`],
    });
    assert.equal(n, 2, "the external URL is ignored, never guessed at");
    assert.equal(calls.filter((c) => c.table === "media_assets" && c.op === "upsert").length, 0,
      "the file already has its asset — the post reuses it");
    const links = calls.filter((c) => c.table === "media_attachments" && c.op === "upsert").map((c) => c.payload);
    assert.deepEqual(links.map((l) => [l.entity_type, l.entity_id, l.media_asset_id, l.position, l.is_cover]), [
      ["post", POST, "ma-existing", 0, true],
      ["post", POST, "ma-existing", 2, false],
    ]);
  });

  it("writes NOTHING where the canonical writer cannot (production today: flag on, schema missing)", async () => {
    const { client, calls } = db({ flag: true, schemaPresent: false, existingOwner: OWNER });
    assert.equal(await recordPostMediaAttachments(client, { postId: POST, authorId: OWNER, mediaUrls: [`post-media/${OWNER}/a.jpg`] }), 0);
    assert.equal(calls.some((c) => c.op !== "select"), false);
  });

  it("writes nothing with the canonical flag off", async () => {
    const { client, calls } = db({ flag: false, schemaPresent: true, existingOwner: OWNER });
    assert.equal(await recordPostMediaAttachments(client, { postId: POST, authorId: OWNER, mediaUrls: [`post-media/${OWNER}/a.jpg`] }), 0);
    assert.equal(calls.some((c) => c.op !== "select"), false);
  });

  it("refuses to attach a storage key someone else owns", async () => {
    const { client, calls } = db({ flag: true, schemaPresent: true, existingOwner: VIEWER });
    const r = await recordEntityMedia(client, {
      ownerUserId: OWNER, publicUrl: `post-media/${VIEWER}/theirs.jpg`, entityType: "post", entityId: POST,
    });
    assert.deepEqual(r, { assetId: null, attachmentId: null });
    assert.equal(calls.some((c) => c.table === "media_attachments"), false);
  });

  it("an unreadable asset lookup is not 'no asset' — nothing is created", async () => {
    const { client, calls } = makeDb((c) => {
      if (c.table === "feature_flags") return { data: { enabled: true }, error: null };
      if (c.table === "media_assets" && c.op === "select") return { data: null, error: { code: "57P01", message: "down" } };
      return { data: null, error: null };
    });
    const r = await recordEntityMedia(client, {
      ownerUserId: OWNER, publicUrl: `post-media/${OWNER}/a.jpg`, entityType: "post", entityId: POST,
    });
    assert.deepEqual(r, { assetId: null, attachmentId: null });
    assert.equal(calls.some((c) => c.op === "upsert"), false);
  });
});

// ── MD369 ────────────────────────────────────────────────────────────────────

describe("MD369 — POST /media/:id/attachments, over HTTP", () => {
  const ASSET = "66666666-6666-4666-8666-666666666666";
  let close: (() => Promise<void>) | null = null;
  beforeEach(async () => { await close?.(); close = null; });

  async function call(
    opts: { flag: boolean; assetOwner: string | null; postAuthor: string | null; auth?: boolean },
    body: unknown,
  ) {
    const { client, calls } = makeDb((c) => {
      if (c.table === "profiles") return { data: { account_status: "active" }, error: null };
      if (c.table === "feature_flags") {
        return { data: opts.flag && eqOf(c, "flag") === "media_canonical_enabled" ? { enabled: true } : null, error: null };
      }
      if (c.table === "media_assets") {
        return { data: opts.assetOwner ? { id: ASSET, owner_user_id: opts.assetOwner } : null, error: null };
      }
      if (c.table === "posts") {
        return { data: opts.postAuthor ? { id: POST, author_id: opts.postAuthor } : null, error: null };
      }
      if (c.table === "media_attachments" && c.op === "upsert") return { data: { id: "att-1" }, error: null };
      return { data: null, error: null };
    });
    client.auth = { getUser: async (t: string) => (t === "tok" ? { data: { user: { id: OWNER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) };
    _setTestClient(client, true);
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    app.use("/", mediaActionsRouter);
    const srv = createServer(app);
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
    srv.unref();
    close = () => new Promise<void>((res) => { srv.closeAllConnections?.(); srv.close(() => res()); });
    const { port } = srv.address() as { port: number };
    const r = await fetch(`http://127.0.0.1:${port}/media/${ASSET}/attachments`, {
      method: "POST",
      headers: { ...(opts.auth === false ? {} : { Authorization: "Bearer tok" }), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const writes = calls.filter((c) => c.table === "media_attachments" && c.op === "upsert");
    return { status: r.status, body: (await r.json()) as any, writes };
  }

  const BODY = { entity_type: "post", entity_id: POST, position: 1, is_cover: true, visibility_override: "followers" };

  it("links an owned asset to an owned entity, carrying the §6.1 fields", async () => {
    const r = await call({ flag: true, assetOwner: OWNER, postAuthor: OWNER }, BODY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { id: "att-1", mediaAssetId: ASSET, entityType: "post", entityId: POST });
    assert.equal(r.writes.length, 1);
    assert.deepEqual(
      [r.writes[0]!.payload.entity_type, r.writes[0]!.payload.position, r.writes[0]!.payload.is_cover, r.writes[0]!.payload.visibility_override],
      ["post", 1, true, "followers"],
    );
  });

  it("refuses without authentication", async () => {
    const r = await call({ flag: true, assetOwner: OWNER, postAuthor: OWNER, auth: false }, BODY);
    assert.equal(r.status, 401);
    assert.equal(r.writes.length, 0);
  });

  it("someone else's asset, or someone else's entity, is one probe-safe not_found — and writes nothing", async () => {
    const notMyAsset = await call({ flag: true, assetOwner: VIEWER, postAuthor: OWNER }, BODY);
    assert.equal(notMyAsset.status, 404);
    assert.equal(notMyAsset.writes.length, 0);
    const notMyPost = await call({ flag: true, assetOwner: OWNER, postAuthor: VIEWER }, BODY);
    assert.equal(notMyPost.status, 404);
    assert.equal(notMyPost.writes.length, 0);
    assert.deepEqual(notMyAsset.body, notMyPost.body, "neither half leaks which one failed");
  });

  it("with the canonical layer off it reports not_found, never a success it did not write", async () => {
    const r = await call({ flag: false, assetOwner: OWNER, postAuthor: OWNER }, BODY);
    assert.equal(r.status, 404);
    assert.equal(r.writes.length, 0);
  });

  it("refuses an audience outside inherit + §33, and an unknown entity type", async () => {
    const badAudience = await call({ flag: true, assetOwner: OWNER, postAuthor: OWNER }, { ...BODY, visibility_override: "friends_only" });
    assert.equal(badAudience.status, 400);
    const badEntity = await call({ flag: true, assetOwner: OWNER, postAuthor: OWNER }, { ...BODY, entity_type: "story" });
    assert.equal(badEntity.status, 400);
    assert.equal(badAudience.writes.length + badEntity.writes.length, 0);
  });
});

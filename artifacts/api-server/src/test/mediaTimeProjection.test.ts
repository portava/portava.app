/**
 * mediaTimeProjection — Media v2 Phase 7 (Time) §17 four-band architecture.
 *
 * Proves, with fake Supabase clients only (no DB, no network, no HTTP listen):
 *   1. The four bands (Earlier / Now / Typical / Likely-Next) populate from the
 *      RIGHT sources: Earlier from observed media, Now from the gated live read,
 *      Typical from intel historical_pattern, Likely-Next from intel
 *      portava_prediction.
 *   2. A predicted item is NEVER labeled live (mutation-proof: tag a prediction
 *      live and findNeverLiveViolations goes non-empty; strip the guard and the
 *      "no predicted-as-live" assertion goes red).
 *   3. A forecast without confidence is OMITTED (mutation-proof: strip the
 *      confidence and the Likely-Next count drops to 0).
 *   4. Now is empty when the gated live state is unavailable — never fabricated.
 *   5. Earlier / Typical / Likely-Next carry DISTINCT render/source classes.
 *   6. An empty substrate yields well-formed EMPTY bands, not an error.
 *   7. The intel substrate read is fail-closed: blocked / private / expired rows
 *      never reach a band.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaTimeProjection.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLocationSafe } from "../lib/media/mediaLocationSafety.js";
import {
  resolveViewer,
  buildTimelineProjection,
} from "../services/media/MediaProjectionService.js";
import {
  assembleTimeBands,
  readIntelTimeSubstrate,
  toPredictedItem,
  findNeverLiveViolations,
  enforceNeverLive,
  extractForecastConfidence,
  type IntelTimeRow,
  type MediaTimeBands,
} from "../lib/media/mediaTimeBands.js";
import { mayRenderAsLive } from "../lib/intelContracts.js";

// ── A capable, filtering fake Supabase client (eq/in/ilike/gt) ───────────────

type Dataset = Record<string, any[]>;

function makeSc(data: Dataset) {
  const resolveRows = (table: string, filters: any[]): any[] => {
    let rows = (data[table] ?? []).map((r) => ({ ...r }));
    for (const f of filters) {
      if (f.op === "eq") rows = rows.filter((r) => String(r[f.col]) === String(f.val));
      else if (f.op === "in")
        rows = rows.filter((r) => (f.val as any[]).map(String).includes(String(r[f.col])));
      else if (f.op === "ilike") {
        const needle = String(f.val).replace(/%/g, "").toLowerCase();
        rows = rows.filter((r) => String(r[f.col] ?? "").toLowerCase().includes(needle));
      } else if (f.op === "gt") rows = rows.filter((r) => r[f.col] != null && r[f.col] > f.val);
    }
    return rows;
  };

  const builder = (table: string): any => {
    const filters: any[] = [];
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push({ op: "eq", col, val }); return b; },
      in(col: string, val: any) { filters.push({ op: "in", col, val }); return b; },
      ilike(col: string, val: any) { filters.push({ op: "ilike", col, val }); return b; },
      gt(col: string, val: any) { filters.push({ op: "gt", col, val }); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      maybeSingle() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      single() { return Promise.resolve({ data: resolveRows(table, filters)[0] ?? null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: resolveRows(table, filters), error: null }).then(onF, onR);
      },
    };
    return b;
  };

  return { from(table: string) { return builder(table); } } as any;
}

const VIEWER = "11111111-1111-1111-1111-111111111111";
const AUTHOR_A = "22222222-2222-2222-2222-222222222222";
const PLACE_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}
function isoAhead(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

let seq = 0;
function makePost(o: { createdAt?: string } = {}): any {
  const id = `post-${++seq}`;
  return {
    id,
    author_id: AUTHOR_A,
    trip_id: null,
    content: "",
    visibility: "public",
    status: "active",
    post_status: "published",
    moderation_status: null,
    publish_at: null,
    expires_at: null,
    created_at: o.createdAt ?? isoAgo(10 * 60 * 1000),
    category: "nightlife",
    media_urls: [],
    has_video: false,
    location_name: "An Thuong Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
    canonical_place_id: PLACE_1,
    // Precise coords on the fixture so the no-precise-location assertions mean something.
    location_lat: 16.0544,
    location_lng: 108.2497,
    post_media: [
      {
        id: `${id}-m1`,
        media_type: "image",
        public_url: `https://cdn.example/${id}.jpg`,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: null,
      },
    ],
    profiles: {
      id: AUTHOR_A,
      username: "maya",
      full_name: "Maya",
      name: "Maya",
      display_name: "Maya",
      avatar_url: null,
      verified: true,
      is_official: false,
      account_status: "active",
    },
  };
}

interface ObsOverrides {
  id?: string;
  source_class: string;
  claim_type?: string;
  value?: unknown;
  visibility?: string;
  moderation_state?: string;
  observed_at?: string;
  expires_at?: string | null;
  subject_id?: string;
}
function makeObs(o: ObsOverrides): any {
  return {
    id: o.id ?? `obs-${++seq}`,
    actor_id: null,
    subject_kind: "experience",
    subject_id: o.subject_id ?? PLACE_1,
    zone_id: null,
    claim_type: o.claim_type ?? "crowd.trajectory",
    value: o.value ?? { note: "x" },
    source_class: o.source_class,
    visibility: o.visibility ?? "aggregate_only",
    moderation_state: o.moderation_state ?? "allowed",
    observed_at: o.observed_at ?? isoAgo(2 * 60 * 60 * 1000),
    captured_at: null,
    expires_at: o.expires_at === undefined ? isoAhead(60 * 60 * 1000) : o.expires_at,
  };
}

function baseData(extra: Dataset = {}): Dataset {
  return {
    profiles: [{ id: VIEWER, location_country: "VN", date_of_birth: "1990-01-01", account_status: "active" }],
    blocks: [],
    user_mutes: [],
    user_follows: [],
    trip_members: [],
    trips: [],
    feature_flags: [], // all flags off → gated live is fail-closed OFF
    intel_live_promoted_scopes: [],
    intel_observations: [],
    ...extra,
  };
}

// ── 1. Four bands from the right sources ─────────────────────────────────────

describe("§17 four-band time projection — sources", () => {
  it("Earlier=media, Typical=historical_pattern, Likely-Next=portava_prediction(+confidence), Now=gated(empty)", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost({ createdAt: isoAgo(5 * 60 * 1000) }), makePost({ createdAt: isoAgo(5 * 60 * 60 * 1000) })],
        intel_observations: [
          makeObs({ source_class: "historical_pattern", claim_type: "crowd.level", value: { level: "busy" } }),
          makeObs({ source_class: "portava_prediction", claim_type: "crowd.trajectory", value: { trajectory: "building", confidence: 0.62 } }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const t = await buildTimelineProjection(sc, viewer, { placeId: PLACE_1, nowMs: Date.now() });
    const b = t.bands;

    // Earlier: observed media, never live.
    assert.ok(b.earlier.count >= 2, "earlier carries the observed media");
    assert.equal(b.earlier.renderClass, "observed");
    assert.equal(b.earlier.live, false);
    assert.ok(b.earlier.items.every((it) => it.itemKind === "media" && it.live === false));

    // Now: gated live is OFF (no flags) → empty, no now label.
    assert.equal(b.now.count, 0, "now empty when live unavailable");
    assert.equal(b.now.live, false, "no fabricated now label");

    // Typical: from historical_pattern, never live.
    assert.equal(b.typical.count, 1);
    assert.equal(b.typical.renderClass, "typical");
    assert.equal(b.typical.live, false);
    assert.equal(b.typical.items[0].intelSourceClass, "historical_pattern");
    assert.equal(b.typical.items[0].live, false);

    // Likely-Next: from portava_prediction, forecast, carries a confidence band, never live.
    assert.equal(b.likelyNext.count, 1);
    assert.equal(b.likelyNext.renderClass, "predicted");
    assert.equal(b.likelyNext.forecast, true);
    assert.equal(b.likelyNext.live, false);
    const pred = b.likelyNext.items[0];
    assert.equal(pred.intelSourceClass, "portava_prediction");
    assert.equal(pred.live, false);
    assert.equal(typeof pred.confidence, "number");
    assert.ok(pred.confidenceBand, "forecast carries a confidence band (§17)");

    // Distinct source classes across the past/typical/predicted rails (§46).
    assert.notEqual(b.earlier.renderClass, b.typical.renderClass);
    assert.notEqual(b.typical.renderClass, b.likelyNext.renderClass);

    // No precise location anywhere in the response.
    assert.equal(isLocationSafe(t), true);
  });
});

// ── 2. Predicted is NEVER live (mutation-proof) ──────────────────────────────

describe("§17 truth boundary — predicted/typical never live", () => {
  it("real bands are clean; a prediction tagged live is caught (non-vacuous)", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        intel_observations: [
          makeObs({ source_class: "portava_prediction", value: { trajectory: "peaking", confidence: 0.8 } }),
          makeObs({ source_class: "historical_pattern", value: { level: "quiet" } }),
        ],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const t = await buildTimelineProjection(sc, viewer, { placeId: PLACE_1, nowMs: Date.now() });

    // Real output: no truth-boundary violation, and the Now band has NO predicted item.
    assert.deepEqual(findNeverLiveViolations(t.bands), [], "real bands carry no predicted-as-live");
    assert.ok(
      t.bands.now.items.every((it) => it.intelSourceClass !== "portava_prediction" && it.intelSourceClass !== "historical_pattern"),
      "Now never contains a prediction/pattern",
    );

    // MUTATION: tag the prediction as live. The guard must catch it (else red).
    const mutated: MediaTimeBands = JSON.parse(JSON.stringify(t.bands));
    mutated.likelyNext.items[0].live = true;
    const violations = findNeverLiveViolations(mutated);
    assert.ok(violations.length > 0, "tagging a prediction live MUST be flagged");
    assert.ok(violations.some((v) => v.band === "likelyNext"), "the violation names the likelyNext band");

    // MUTATION: move a prediction into the Now band → still caught.
    const mutated2: MediaTimeBands = JSON.parse(JSON.stringify(t.bands));
    mutated2.now.items.push({ ...t.bands.likelyNext.items[0], live: true });
    mutated2.now.count = mutated2.now.items.length;
    assert.ok(findNeverLiveViolations(mutated2).length > 0, "a prediction marked live in Now MUST be flagged");

    // The contract predicate itself: neither non-observation class may render live.
    assert.equal(mayRenderAsLive("portava_prediction"), false);
    assert.equal(mayRenderAsLive("historical_pattern"), false);
  });

  it("enforceNeverLive drops a live-tagged prediction fail-closed", () => {
    const badBands = assembleTimeBands({
      media: [],
      now: { available: false, liveClaims: [], crowdLabel: null },
      substrate: {
        typicalRows: [],
        predictedRows: [{ id: "p1", claimType: "crowd.trajectory", value: { confidence: 0.7 }, sourceClass: "portava_prediction", observedAt: isoAgo(1000), capturedAt: null, expiresAt: null }],
      },
    }).bands;
    // Forcibly corrupt: mark the prediction live, then re-run the enforcement.
    badBands.likelyNext.items[0].live = true;
    const { bands, removed } = enforceNeverLive(badBands);
    assert.ok(removed >= 1, "the corrupted live prediction is removed");
    assert.deepEqual(findNeverLiveViolations(bands), [], "output is clean after enforcement");
  });
});

// ── 3. Forecast without confidence is OMITTED (mutation-proof) ───────────────

describe("§17 forecasts carry confidence", () => {
  it("prediction WITH confidence surfaces; WITHOUT confidence is omitted", async () => {
    const withConf = makeSc(
      baseData({
        intel_observations: [makeObs({ source_class: "portava_prediction", value: { trajectory: "building", confidence: 0.55 } })],
      }),
    );
    const viewer = await resolveViewer(withConf, VIEWER, { needFollows: false });
    const t1 = await buildTimelineProjection(withConf, viewer, { placeId: PLACE_1, nowMs: Date.now() });
    assert.equal(t1.bands.likelyNext.count, 1, "a prediction with confidence surfaces");

    // MUTATION: strip the confidence from the same prediction → it must vanish.
    const noConf = makeSc(
      baseData({
        intel_observations: [makeObs({ source_class: "portava_prediction", value: { trajectory: "building" } })],
      }),
    );
    const t2 = await buildTimelineProjection(noConf, viewer, { placeId: PLACE_1, nowMs: Date.now() });
    assert.equal(t2.bands.likelyNext.count, 0, "a forecast without confidence is omitted (§17)");

    // The item builder itself: null confidence ⇒ null item.
    const row: IntelTimeRow = { id: "x", claimType: "crowd.trajectory", value: { trajectory: "building" }, sourceClass: "portava_prediction", observedAt: isoAgo(1000), capturedAt: null, expiresAt: null };
    assert.equal(extractForecastConfidence(row), null);
    assert.equal(toPredictedItem(row), null);
    // With confidence it builds and carries a band.
    const rowC: IntelTimeRow = { ...row, value: { trajectory: "building", confidence: 0.9 } };
    const item = toPredictedItem(rowC);
    assert.ok(item && item.confidenceBand && item.live === false);
  });

  it("out-of-range or non-finite confidence is rejected", () => {
    for (const bad of [NaN, Infinity, -0.1, 1.5, "0.5", null]) {
      const row: IntelTimeRow = { id: "x", claimType: "crowd.trajectory", value: { confidence: bad as any }, sourceClass: "portava_prediction", observedAt: isoAgo(1000), capturedAt: null, expiresAt: null };
      assert.equal(toPredictedItem(row), null, `confidence ${String(bad)} must be rejected`);
    }
  });
});

// ── 4. Now empty when live unavailable; prediction present doesn't leak in ────

describe("§17 Now is gated, never fabricated", () => {
  it("prediction present but Now stays empty with live off", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        intel_observations: [makeObs({ source_class: "portava_prediction", value: { confidence: 0.7 } })],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const t = await buildTimelineProjection(sc, viewer, { placeId: PLACE_1, nowMs: Date.now() });
    assert.equal(t.bands.now.live, false);
    assert.equal(t.bands.now.count, 0);
    // The prediction went to Likely-Next, not Now.
    assert.equal(t.bands.likelyNext.count, 1);
  });
});

// ── 5. Empty substrate ⇒ well-formed empty bands ─────────────────────────────

describe("§17 empty substrate", () => {
  it("no media, no intel ⇒ four well-formed empty bands (place-scoped)", async () => {
    const sc = makeSc(baseData());
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: false });
    const t = await buildTimelineProjection(sc, viewer, { placeId: PLACE_1, nowMs: Date.now() });
    for (const band of [t.bands.earlier, t.bands.now, t.bands.typical, t.bands.likelyNext]) {
      assert.equal(band.count, 0);
      assert.equal(band.items.length, 0);
    }
    assert.equal(t.bands.now.live, false);
    assert.equal(t.bands.likelyNext.forecast, true, "the forecast band exists even when empty");
    assert.equal(t.bands.typical.live, false);
    assert.deepEqual(findNeverLiveViolations(t.bands), []);
    assert.equal(isLocationSafe(t), true);
  });

  it("no placeId ⇒ intel bands empty, Earlier still carries media", async () => {
    const sc = makeSc(
      baseData({
        posts: [makePost()],
        user_follows: [{ follower_id: VIEWER, following_id: AUTHOR_A }],
        // Even if intel existed for some place, no placeId subject ⇒ not read.
        intel_observations: [makeObs({ source_class: "portava_prediction", value: { confidence: 0.7 } })],
      }),
    );
    const viewer = await resolveViewer(sc, VIEWER, { needFollows: true });
    const t = await buildTimelineProjection(sc, viewer, { placeId: null, nowMs: Date.now() });
    assert.equal(t.bands.typical.count, 0);
    assert.equal(t.bands.likelyNext.count, 0);
    assert.equal(t.bands.now.count, 0);
    assert.ok(t.bands.earlier.count >= 1, "following-feed media still fills Earlier");
  });
});

// ── 6. Intel substrate read is fail-closed ───────────────────────────────────

describe("readIntelTimeSubstrate — fail-closed gating", () => {
  it("splits by source_class and drops blocked / private / expired / wrong-subject rows", async () => {
    const now = Date.now();
    const sc = makeSc({
      intel_observations: [
        makeObs({ source_class: "historical_pattern", value: { level: "busy" } }), // keep → typical
        makeObs({ source_class: "portava_prediction", value: { confidence: 0.5 } }), // keep → predicted
        makeObs({ source_class: "portava_prediction", moderation_state: "blocked", value: { confidence: 0.5 } }), // drop: moderation
        makeObs({ source_class: "historical_pattern", visibility: "private" }), // drop: visibility
        makeObs({ source_class: "portava_prediction", expires_at: isoAgo(60 * 1000), value: { confidence: 0.5 } }), // drop: expired
        makeObs({ source_class: "historical_pattern", subject_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }), // drop: other place
        makeObs({ source_class: "firsthand_unverified" }), // drop: not a time-substrate class
      ],
    });
    const sub = await readIntelTimeSubstrate(sc, PLACE_1, now);
    assert.equal(sub.typicalRows.length, 1, "one historical_pattern kept");
    assert.equal(sub.predictedRows.length, 1, "one portava_prediction kept");
    assert.equal(sub.typicalRows[0].sourceClass, "historical_pattern");
    assert.equal(sub.predictedRows[0].sourceClass, "portava_prediction");
  });

  it("null placeId ⇒ empty substrate, never throws", async () => {
    const sc = makeSc({ intel_observations: [makeObs({ source_class: "portava_prediction", value: { confidence: 0.5 } })] });
    const sub = await readIntelTimeSubstrate(sc, null, Date.now());
    assert.deepEqual(sub, { typicalRows: [], predictedRows: [] });
  });
});

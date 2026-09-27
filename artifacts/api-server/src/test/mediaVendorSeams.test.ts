/**
 * mediaVendorSeams — census-media §37: the four vendor seams (vision, moderation
 * classifier, transcoder, caption source), their refusing defaults, the
 * fail-closed decisions at their points of use, and the upload-path stages.
 *
 * Every adapter here is a TEST DOUBLE. Nothing in this file is evidence that
 * any vendor works: it is evidence that the seam refuses without one, that a
 * vendor's answer is validated before it is used, and that each stage is off
 * until its flag is on. The wire-level wiring (routes) is asserted in
 * mediaVideoTransport.test.ts and mediaWorldProjection.test.ts, at their tails.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/mediaVendorSeams.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { callVendor, selectVendor, refused, type VendorAnswer } from "../lib/media/vendors/vendorCommon.js";
import {
  REFUSING_VISION_PROVIDER,
  IMPLEMENTED_VISION_PROVIDERS,
  deriveVisualEvidenceCandidates,
  validateSimilarMedia,
  candidateLooksSocial,
  sceneCandidatesFor,
  similarMediaFor,
  selectMediaVisionProvider,
  type MediaVisionProvider,
} from "../lib/media/vendors/mediaVisionProvider.js";
import {
  REFUSING_MODERATION_CLASSIFIER,
  IMPLEMENTED_MODERATION_CLASSIFIERS,
  decidePreDistribution,
  postMediaStatusFor,
  selectMediaModerationClassifier,
  type MediaModerationClassifier,
  type ClassifierAnswer,
  type ModerationSubject,
} from "../lib/media/vendors/mediaModerationClassifier.js";
import {
  REFUSING_TRANSCODER,
  IMPLEMENTED_TRANSCODERS,
  validateRenditionLadder,
  submitForTranscode,
  adaptiveLadderFor,
  type MediaTranscoder,
} from "../lib/media/vendors/mediaTranscoder.js";
import {
  REFUSING_CAPTION_SOURCE,
  IMPLEMENTED_CAPTION_SOURCES,
  parseWebVtt,
  captionTrackFor,
  captionTrackPathFor,
  MAX_VTT_BYTES,
  type MediaCaptionSource,
} from "../lib/media/vendors/mediaCaptionSource.js";
import {
  runMediaVendorIngest,
  preDistributionPostMediaStatus,
  moderateVideoOnFrame,
  MEDIA_VISION_STAGE_FLAG,
  MEDIA_MODERATION_STAGE_FLAG,
  MEDIA_TRANSCODE_STAGE_FLAG,
  MEDIA_CAPTIONS_STAGE_FLAG,
  type MediaVendorAdapters,
} from "../lib/media/vendors/mediaVendorStages.js";
import { resetCanonicalSchemaMemo } from "../lib/media/mediaSchemaCapability.js";

const A = "a0000000-0000-4000-a000-000000000001";
const B = "b0000000-0000-4000-a000-000000000002";
const C = "c0000000-0000-4000-a000-000000000003";
const SEED = "d0000000-0000-4000-a000-000000000004";

// ── vendorCommon ─────────────────────────────────────────────────────────────

describe("§37 vendorCommon — a vendor call never throws and never hangs", () => {
  it("a throw is `error`, a non-answer is `invalid_answer`, a slow call is `timeout`", async () => {
    const threw = await callVendor(async () => { throw new Error("boom"); });
    assert.deepEqual(threw.ok ? null : threw.reason, "error");
    const junk = await callVendor(async () => "yes" as unknown as VendorAnswer<number>);
    assert.deepEqual(junk.ok ? null : junk.reason, "invalid_answer");
    const slow = await callVendor(() => new Promise<VendorAnswer<number>>((r) => setTimeout(() => r({ ok: true, value: 1 }), 200)), 20);
    assert.deepEqual(slow.ok ? null : slow.reason, "timeout");
    const fine = await callVendor(async () => ({ ok: true as const, value: 7 }), 1000);
    assert.deepEqual(fine, { ok: true, value: 7 });
  });

  it("an env value that names no implemented adapter selects the REFUSING default, and says it was a typo", () => {
    const refusing = { name: "none" };
    const real = { name: "real" };
    assert.equal(selectVendor(undefined, { real: () => real }, refusing).adapter, refusing);
    assert.equal(selectVendor("  ", { real: () => real }, refusing).adapter, refusing);
    const typo = selectVendor("reall", { real: () => real }, refusing);
    assert.equal(typo.adapter, refusing);
    assert.equal(typo.configuredButUnknown, true);
    assert.equal(selectVendor("real", { real: () => real }, refusing).adapter, real);
    // "toString" is on every object's prototype — it must not count as an implemented adapter.
    assert.equal(selectVendor("toString", {}, refusing).adapter, refusing);
  });

  it("no vendor is chosen in this tree: every IMPLEMENTED table is empty and every env selection refuses", () => {
    for (const table of [IMPLEMENTED_VISION_PROVIDERS, IMPLEMENTED_MODERATION_CLASSIFIERS, IMPLEMENTED_TRANSCODERS, IMPLEMENTED_CAPTION_SOURCES]) {
      assert.deepEqual(Object.keys(table), []);
    }
    const env = { MEDIA_VISION_PROVIDER: "google", MEDIA_MODERATION_CLASSIFIER: "rekognition" } as NodeJS.ProcessEnv;
    assert.equal(selectMediaVisionProvider(env).adapter, REFUSING_VISION_PROVIDER);
    assert.equal(selectMediaModerationClassifier(env).adapter, REFUSING_MODERATION_CLASSIFIER);
  });
});

// ── MD63 / MD289 / MD293 — vision ────────────────────────────────────────────

describe("MD63 — the evidence-extraction stage yields CANDIDATES, never facts", () => {
  it("keeps only asked-about ids, the closed vocabulary and a confidence in [0,1]; verified is always false", () => {
    const { candidates, dropped } = deriveVisualEvidenceCandidates(
      "fake",
      [
        { mediaId: A, kind: "crowd_level", value: "social", confidence: 0.9, verified: true },
        { mediaId: C, kind: "crowd_level", value: "social", confidence: 0.9 }, // not asked about
        { mediaId: B, kind: "crowd_level", value: "rowdy", confidence: 0.9 }, // not in the vocabulary
        { mediaId: B, kind: "weapon", value: "busy", confidence: 0.9 }, // not a known kind
        { mediaId: B, kind: "crowd_level", value: "busy", confidence: 1.5 }, // out of range
        { mediaId: B, kind: "crowd_level", value: "quiet", confidence: Number.NaN },
      ],
      new Set([A, B]),
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.mediaId, A);
    assert.equal(candidates[0]!.verified, false, "a provider cannot mark visual inference verified");
    assert.equal(candidates[0]!.eligibleAsObservation, false);
    assert.equal(candidates[0]!.basis, "visual_inference");
    assert.equal(dropped, 5);
  });

  it("one candidate per media — the most confident", () => {
    const { candidates } = deriveVisualEvidenceCandidates(
      "fake",
      [
        { mediaId: A, kind: "crowd_level", value: "quiet", confidence: 0.4 },
        { mediaId: A, kind: "crowd_level", value: "social", confidence: 0.8 },
      ],
      new Set([A]),
    );
    assert.deepEqual(candidates.map((c) => [c.value, c.confidence]), [["social", 0.8]]);
  });

  it("MD289 'looks social' is the owner's threshold: busy/social at ≥ 0.6", () => {
    const c = (value: any, confidence: number) =>
      ({ mediaId: A, kind: "crowd_level", value, confidence, provider: "f", basis: "visual_inference", verified: false, eligibleAsObservation: false }) as const;
    assert.equal(candidateLooksSocial(c("social", 0.6)), true);
    assert.equal(candidateLooksSocial(c("busy", 0.95)), true);
    assert.equal(candidateLooksSocial(c("social", 0.59)), false);
    assert.equal(candidateLooksSocial(c("quiet", 0.99)), false);
  });

  it("the refusing default answers `not_configured` for scene signals and the index, and ingests nothing", async () => {
    const s = await sceneCandidatesFor(REFUSING_VISION_PROVIDER, [{ mediaId: A, storageKey: null }]);
    assert.equal(s.ok ? null : s.reason, "not_configured");
    const i = await similarMediaFor(REFUSING_VISION_PROVIDER, { mediaId: A, storageKey: null }, 10);
    assert.equal(i.ok ? null : i.reason, "not_configured");
    const g = await REFUSING_VISION_PROVIDER.ingest({ assetId: A, mediaType: "image", bucket: "b", path: "p", framePath: null });
    assert.equal(g.ok ? null : g.reason, "not_configured");
  });
});

describe("MD293 — the index PROPOSES; its answer is validated before anything reads it", () => {
  it("excludes the seed, drops malformed ids and scores, dedupes, orders by score and caps", () => {
    const { ids, dropped } = validateSimilarMedia(
      [
        { mediaId: B, score: 0.5 },
        { mediaId: SEED, score: 0.99 }, // the seed is not its own neighbour
        { mediaId: "not-a-uuid", score: 0.9 },
        { mediaId: C, score: 0.8 },
        { mediaId: B, score: 0.7 }, // a duplicate keeps its best score
        { mediaId: A, score: -1 },
      ],
      SEED,
      2,
    );
    assert.deepEqual(ids, [C, B]);
    assert.equal(dropped, 3);
  });

  it("a provider with scene signals but no index is `unsupported`, not `not_configured`", async () => {
    const p: MediaVisionProvider = {
      name: "scenes-only",
      capabilities: { sceneSignals: true, similarMedia: false, ingest: false },
      async sceneSignals() { return { ok: true, value: [] }; },
      async similarMedia() { throw new Error("must not be called"); },
      async ingest() { return refused("unsupported"); },
    };
    const r = await similarMediaFor(p, { mediaId: SEED, storageKey: null }, 10);
    assert.equal(r.ok ? null : r.reason, "unsupported");
  });
});

// ── MD269 / MD283 — moderation ───────────────────────────────────────────────

function classifier(
  caps: MediaModerationClassifier["capabilities"],
  answer: VendorAnswer<ClassifierAnswer> | (() => Promise<VendorAnswer<ClassifierAnswer>>),
  calls: Array<{ target: string }> = [],
): MediaModerationClassifier {
  return {
    name: "fake-classifier",
    capabilities: caps,
    async classify(input) {
      calls.push({ target: input.target });
      return typeof answer === "function" ? answer() : answer;
    },
  };
}
const IMAGE: ModerationSubject = { mediaType: "image", bucket: "post-media", path: "u/1.jpg", framePath: null };
const VIDEO: ModerationSubject = { mediaType: "video", bucket: "post-media", path: "u/1.mp4", framePath: null };
const VIDEO_WITH_FRAME: ModerationSubject = { ...VIDEO, framePath: "u/1.mp4.poster.jpg" };
const allow: VendorAnswer<ClassifierAnswer> = { ok: true, value: { verdict: "allow", labels: [], confidence: 0.99 } };
const block: VendorAnswer<ClassifierAnswer> = { ok: true, value: { verdict: "block", labels: ["x"], confidence: 0.99 } };
const restrict: VendorAnswer<ClassifierAnswer> = { ok: true, value: { verdict: "restrict", labels: [], confidence: 0.7 } };

describe("MD269 — a decision stands between upload and distribution, and every non-answer HOLDS", () => {
  it("stage OFF decides nothing and the postcard write stays 'approved' (the seed)", async () => {
    const calls: Array<{ target: string }> = [];
    const d = await decidePreDistribution({ stageOn: false, classifier: classifier({ image: true, video: true, videoFrame: true }, block, calls), subject: IMAGE });
    assert.deepEqual(d, { stage: "off" });
    assert.equal(postMediaStatusFor(d), "approved");
    assert.equal(calls.length, 0, "an off stage must not call the vendor");
  });

  it("stage ON with NO classifier is a staffed hold: flag → post_media 'flagged' (never 'pending', which a READY row distributes)", async () => {
    const d = await decidePreDistribution({ stageOn: true, classifier: REFUSING_MODERATION_CLASSIFIER, subject: IMAGE });
    assert.equal(d.stage === "on" && d.decision, "flag");
    assert.equal(d.stage === "on" && d.basis, "hold_no_classifier");
    assert.equal(postMediaStatusFor(d), "flagged");
  });

  it("the classifier decides an image: allow → approved, restrict → flagged, block → rejected", async () => {
    const caps = { image: true, video: false, videoFrame: false };
    assert.equal(postMediaStatusFor(await decidePreDistribution({ stageOn: true, classifier: classifier(caps, allow), subject: IMAGE })), "approved");
    assert.equal(postMediaStatusFor(await decidePreDistribution({ stageOn: true, classifier: classifier(caps, restrict), subject: IMAGE })), "flagged");
    assert.equal(postMediaStatusFor(await decidePreDistribution({ stageOn: true, classifier: classifier(caps, block), subject: IMAGE })), "rejected");
  });

  it("a refusal, a throw and a malformed verdict all HOLD — none of them is an allow", async () => {
    const caps = { image: true, video: true, videoFrame: true };
    for (const a of [
      refused<ClassifierAnswer>("error"),
      async () => { throw new Error("vendor down"); },
      { ok: true, value: { verdict: "ok", labels: [], confidence: 1 } } as unknown as VendorAnswer<ClassifierAnswer>,
      { ok: true, value: { verdict: "allow", labels: [], confidence: 7 } } as VendorAnswer<ClassifierAnswer>,
    ]) {
      const d = await decidePreDistribution({ stageOn: true, classifier: classifier(caps, a as any), subject: IMAGE });
      assert.equal(d.stage === "on" && d.decision, "flag");
      assert.equal(d.stage === "on" && d.basis, "hold_classifier_failed");
    }
  });

  it("a classifier that cannot read images holds an image", async () => {
    const d = await decidePreDistribution({ stageOn: true, classifier: classifier({ image: false, video: true, videoFrame: false }, allow), subject: IMAGE });
    assert.equal(d.stage === "on" && d.basis, "hold_unsupported");
  });
});

describe("MD283 — a classifier decides video; one frame can reject or hold a clip, never approve it", () => {
  it("a VIDEO-capable classifier reads the whole file and can approve", async () => {
    const calls: Array<{ target: string }> = [];
    const d = await decidePreDistribution({ stageOn: true, classifier: classifier({ image: true, video: true, videoFrame: false }, allow, calls), subject: VIDEO });
    assert.equal(d.stage === "on" && d.decision, "approve");
    assert.deepEqual(calls, [{ target: "file" }]);
  });

  it("a FRAME-only classifier: allow holds (hold_frame_only), block rejects, and no frame yet holds", async () => {
    const caps = { image: true, video: false, videoFrame: true };
    const a = await decidePreDistribution({ stageOn: true, classifier: classifier(caps, allow), subject: VIDEO_WITH_FRAME });
    assert.equal(a.stage === "on" && a.decision, "flag");
    assert.equal(a.stage === "on" && a.basis, "hold_frame_only");
    const b = await decidePreDistribution({ stageOn: true, classifier: classifier(caps, block), subject: VIDEO_WITH_FRAME });
    assert.equal(b.stage === "on" && b.decision, "reject");
    const calls: Array<{ target: string }> = [];
    const n = await decidePreDistribution({ stageOn: true, classifier: classifier(caps, allow, calls), subject: VIDEO });
    assert.equal(n.stage === "on" && n.basis, "hold_unsupported");
    assert.equal(calls.length, 0);
  });
});

// ── MD277 — transcoder ───────────────────────────────────────────────────────

describe("MD277 — a rendition LADDER is what a transcoder's answer must be", () => {
  const good = {
    protocol: "hls",
    manifestUrl: "https://stream.example/v/abc/master.m3u8?token=t",
    renditions: [{ height: 720, bitrateKbps: 2500 }, { height: 360, bitrateKbps: 800 }],
  };

  it("accepts an https HLS master with two distinct rungs, sorted by height", () => {
    const l = validateRenditionLadder(good);
    assert.ok(l);
    assert.deepEqual(l!.renditions.map((r) => r.height), [360, 720]);
  });

  it("refuses one rung, plain http, a suffix that is not the claimed protocol, duplicate or bad rungs", () => {
    assert.equal(validateRenditionLadder({ ...good, renditions: [good.renditions[0]] }), null, "one rung is a re-encode, not a ladder");
    assert.equal(validateRenditionLadder({ ...good, manifestUrl: "http://stream.example/v/master.m3u8" }), null);
    assert.equal(validateRenditionLadder({ ...good, protocol: "dash" }), null, ".m3u8 is not a DASH manifest");
    assert.equal(validateRenditionLadder({ ...good, renditions: [good.renditions[0], good.renditions[0]] }), null);
    assert.equal(validateRenditionLadder({ ...good, renditions: [{ height: 0, bitrateKbps: 1 }, { height: 360, bitrateKbps: 800 }] }), null);
    assert.equal(validateRenditionLadder({ ...good, manifestUrl: "not a url" }), null);
    assert.ok(validateRenditionLadder({ ...good, protocol: "dash", manifestUrl: "https://s.example/v/manifest.mpd" }));
  });

  it("the refusing default submits nothing; a vendor's junk job id and junk ladder are refused", async () => {
    const r = await submitForTranscode(REFUSING_TRANSCODER, { assetId: A, bucket: "b", path: "p.mp4", durationMs: 1000 });
    assert.equal(r.ok ? null : r.reason, "not_configured");
    const t: MediaTranscoder = {
      name: "fake-transcoder",
      capabilities: { hls: true, dash: false, signedPlayback: true },
      async submit() { return { ok: true, value: { jobId: "" } }; },
      async ladder() { return { ok: true, value: { ...good, renditions: [good.renditions[0]!] } as any }; },
    };
    const s = await submitForTranscode(t, { assetId: A, bucket: "b", path: "p.mp4", durationMs: 1000 });
    assert.equal(s.ok ? null : s.reason, "invalid_answer");
    const l = await adaptiveLadderFor(t, A);
    assert.equal(l.ok ? null : l.reason, "invalid_answer");
  });
});

// ── MD280 — captions ─────────────────────────────────────────────────────────

const VTT = [
  "WEBVTT - generated",
  "",
  "NOTE this block is skipped",
  "",
  "1",
  "00:00.000 --> 00:01.500 align:start",
  "Hello there",
  "",
  "00:00:01.500 --> 00:00:03.000",
  "Two lines",
  "of text",
  "",
].join("\n");

describe("MD280 — a caption track is kept only if it is valid WebVTT, whole", () => {
  it("parses identifiers, both timestamp forms, NOTE blocks, cue settings and multi-line text", () => {
    const p = parseWebVtt(VTT, 3000);
    assert.ok(p.ok);
    assert.deepEqual(p.ok && p.track.cues, [
      { startMs: 0, endMs: 1500, text: "Hello there" },
      { startMs: 1500, endMs: 3000, text: "Two lines\nof text" },
    ]);
  });

  it("refuses: no header, end ≤ start, out of order, beyond the measured duration, an empty cue, no cues, too large", () => {
    const r = (s: string, d: number | null = null) => { const p = parseWebVtt(s, d); return p.ok ? "ok" : p.reason; };
    assert.equal(r("00:00.000 --> 00:01.000\nx\n"), "no_header");
    assert.equal(r("WEBVTT\n\n00:02.000 --> 00:01.000\nx\n"), "bad_timing");
    assert.equal(r("WEBVTT\n\n00:01.000 --> 00:01.000\nx\n"), "bad_timing");
    assert.equal(r("WEBVTT\n\n00:05.000 --> 00:06.000\nb\n\n00:01.000 --> 00:02.000\na\n"), "out_of_order");
    assert.equal(r("WEBVTT\n\n00:01.000 --> 00:09.000\nx\n", 3000), "beyond_duration");
    assert.equal(r("WEBVTT\n\n00:01.000 --> 00:02.000\n"), "empty_cue");
    assert.equal(r("WEBVTT\n"), "no_cues");
    assert.equal(r("WEBVTT\n\n" + "x".repeat(MAX_VTT_BYTES)), "too_large");
    assert.equal(r("WEBVTT\n\n00:61.000 --> 00:62.000\nx\n"), "bad_timing", "seconds are 00–59");
  });

  it("the track path is derived from the video, like its poster", () => {
    assert.equal(captionTrackPathFor("u/123.mp4"), "u/123.mp4.captions.vtt");
  });

  it("the refusing default transcribes nothing; a vendor's malformed VTT is refused, not stored", async () => {
    const subject = { assetId: A, bucket: "b", path: "p.mp4", durationMs: 3000 };
    const r = await captionTrackFor(REFUSING_CAPTION_SOURCE, subject);
    assert.equal(r.ok ? null : r.reason, "not_configured");
    const bad: MediaCaptionSource = {
      name: "fake-asr",
      capabilities: { transcribe: true },
      async transcribe() { return { ok: true, value: { vtt: "WEBVTT\n\n00:02.000 --> 00:01.000\nx\n", language: "en" } }; },
    };
    const b = await captionTrackFor(bad, subject);
    assert.equal(b.ok ? null : b.reason, "invalid_answer");
  });
});

// ── The stages on the upload path ────────────────────────────────────────────

type Row = Record<string, any>;

/** In-memory store: feature_flags, media_assets (with the §36 schema probe answering "present"), and Storage. */
function makeStore(flags: Record<string, boolean>, assets: Row[] = []) {
  const uploads: Array<{ bucket: string; path: string; body: string; upsert: boolean }> = [];
  const updates: Array<{ table: string; patch: Row }> = [];
  const flagReads: string[] = [];
  function chain(name: string) {
    const eqs: Array<[string, unknown]> = [];
    let update: Row | null = null;
    const rows = (): Row[] =>
      name === "feature_flags" ? Object.entries(flags).map(([flag, enabled]) => ({ flag, enabled })) : name === "media_assets" ? assets : [];
    const match = (r: Row) => eqs.every(([c, v]) => r[c] === v);
    async function resolve(single: boolean) {
      if (name === "feature_flags") {
        const f = eqs.find(([c]) => c === "flag");
        if (f) flagReads.push(String(f[1]));
      }
      if (update) {
        const hit = rows().filter(match);
        for (const r of hit) Object.assign(r, update, { version: (r.version ?? 1) + 1 });
        updates.push({ table: name, patch: update });
        return { data: single ? hit[0] ?? null : hit, error: null };
      }
      const hit = rows().filter(match);
      return { data: single ? hit[0] ?? null : hit, error: null };
    }
    const b: any = {
      select() { return b; },
      update(u: Row) { update = u; return b; },
      eq(c: string, v: unknown) { eqs.push([c, v]); return b; },
      in() { return b; }, limit() { return b; }, order() { return b; }, is() { return b; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(f: any, r: any) { return resolve(false).then(f, r); },
    };
    return b;
  }
  const sc = {
    from: (t: string) => chain(t),
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, body: Buffer, opts: { upsert: boolean }) {
            uploads.push({ bucket, path, body: body.toString("utf8"), upsert: opts.upsert });
            return { error: null };
          },
        };
      },
    },
  };
  return { sc, uploads, updates, flagReads };
}

function spyAdapters(): { adapters: MediaVendorAdapters; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    adapters: {
      classifier: {
        name: "spy-classifier",
        capabilities: { image: true, video: true, videoFrame: true },
        async classify(i) { calls.push(`classify:${i.target}`); return allow; },
      },
      vision: {
        name: "spy-vision",
        capabilities: { sceneSignals: true, similarMedia: true, ingest: true },
        async sceneSignals() { calls.push("scene"); return { ok: true, value: [] }; },
        async similarMedia() { calls.push("similar"); return { ok: true, value: [] }; },
        async ingest(i) { calls.push(`ingest:${i.path}`); return { ok: true, value: { accepted: true } }; },
      },
      transcoder: {
        name: "spy-transcoder",
        capabilities: { hls: true, dash: false, signedPlayback: true },
        async submit(i) { calls.push(`transcode:${i.path}`); return { ok: true, value: { jobId: "job-1" } }; },
        async ladder() { return refused("unsupported"); },
      },
      captions: {
        name: "spy-asr",
        capabilities: { transcribe: true },
        async transcribe(i) { calls.push(`transcribe:${i.path}`); return { ok: true, value: { vtt: VTT, language: "en" } }; },
      },
    },
  };
}

const ASSET_ROW = (moderation = "processing"): Row => ({
  id: A, storage_bucket: "post-media", storage_path: "u/1.mp4", moderation_status: moderation, version: 1,
  // The §36 schema probe selects these; present ⇒ the canonical CHECK is assumed present.
  location_visibility: "hidden", captured_at: null,
});

describe("§37 stages — every stage is OFF until its own flag is on", () => {
  afterEach(() => resetCanonicalSchemaMemo());

  it("all four flags off (the seed): four flag reads, no vendor call, no write", async () => {
    const store = makeStore({});
    const { adapters, calls } = spyAdapters();
    const report = await runMediaVendorIngest(store.sc, { assetId: A, bucket: "post-media", path: "u/1.mp4", mediaType: "video", durationMs: 3000 }, adapters);
    assert.deepEqual(calls, []);
    assert.deepEqual(store.updates, []);
    assert.deepEqual(store.uploads, []);
    assert.deepEqual(store.flagReads.sort(), [MEDIA_CAPTIONS_STAGE_FLAG, MEDIA_MODERATION_STAGE_FLAG, MEDIA_TRANSCODE_STAGE_FLAG, MEDIA_VISION_STAGE_FLAG].sort());
    assert.deepEqual(report, { moderation: { state: "off" }, vision: { state: "off" }, transcode: { state: "off" }, captions: { state: "off" } });
  });

  it("each flag turns on exactly its own stage", async () => {
    for (const [flag, expected] of [
      [MEDIA_VISION_STAGE_FLAG, ["ingest:u/1.mp4"]],
      [MEDIA_TRANSCODE_STAGE_FLAG, ["transcode:u/1.mp4"]],
      [MEDIA_CAPTIONS_STAGE_FLAG, ["transcribe:u/1.mp4"]],
      [MEDIA_MODERATION_STAGE_FLAG, ["classify:file"]],
    ] as const) {
      const store = makeStore({ [flag]: true }, [ASSET_ROW()]);
      const { adapters, calls } = spyAdapters();
      await runMediaVendorIngest(store.sc, { assetId: A, bucket: "post-media", path: "u/1.mp4", mediaType: "video", durationMs: 3000 }, adapters);
      assert.deepEqual(calls, expected, flag);
      resetCanonicalSchemaMemo();
    }
  });

  it("moderation ON with no classifier HOLDS the canonical row: processing → limited, through MediaModerationService", async () => {
    const asset = ASSET_ROW();
    const store = makeStore({ [MEDIA_MODERATION_STAGE_FLAG]: true }, [asset]);
    const { adapters } = spyAdapters();
    const report = await runMediaVendorIngest(
      store.sc,
      { assetId: A, bucket: "post-media", path: "u/1.mp4", mediaType: "video", durationMs: 3000 },
      { ...adapters, classifier: REFUSING_MODERATION_CLASSIFIER },
    );
    assert.equal(asset.moderation_status, "limited", "a held file is non-distributable (§36 limited)");
    assert.equal(report.moderation.state === "ran" && report.moderation.result.recorded, "applied");
  });

  it("moderation ON holds the row BEFORE the classifier is asked, then applies its verdict (limited → active)", async () => {
    const asset = ASSET_ROW();
    const store = makeStore({ [MEDIA_MODERATION_STAGE_FLAG]: true }, [asset]);
    const { adapters } = spyAdapters();
    const seenWhileDeciding: string[] = [];
    const deciding: MediaModerationClassifier = {
      name: "slow-classifier",
      capabilities: { image: true, video: true, videoFrame: false },
      async classify() {
        seenWhileDeciding.push(asset.moderation_status);
        return allow;
      },
    };
    await runMediaVendorIngest(store.sc, { assetId: A, bucket: "post-media", path: "u/1.mp4", mediaType: "video", durationMs: 3000 }, { ...adapters, classifier: deciding });
    assert.deepEqual(seenWhileDeciding, ["limited"], "the file is not distributable while the classifier decides");
    assert.equal(asset.moderation_status, "active");
  });

  it("transcode and captions are video-only; an image never reaches them", async () => {
    const store = makeStore({ [MEDIA_TRANSCODE_STAGE_FLAG]: true, [MEDIA_CAPTIONS_STAGE_FLAG]: true });
    const { adapters, calls } = spyAdapters();
    await runMediaVendorIngest(store.sc, { assetId: A, bucket: "post-media", path: "u/1.jpg", mediaType: "image", durationMs: null }, adapters);
    assert.deepEqual(calls, []);
  });

  it("captions ON: a valid track is stored at the DERIVED path and never overwrites (upsert false); an invalid one is not stored", async () => {
    const store = makeStore({ [MEDIA_CAPTIONS_STAGE_FLAG]: true });
    const { adapters } = spyAdapters();
    const report = await runMediaVendorIngest(store.sc, { assetId: A, bucket: "post-media", path: "u/1.mp4", mediaType: "video", durationMs: 3000 }, adapters);
    assert.deepEqual(store.uploads.map((u) => [u.bucket, u.path, u.upsert]), [["post-media", "u/1.mp4.captions.vtt", false]]);
    assert.equal(report.captions.state === "ran" && report.captions.result.ok, true);

    const store2 = makeStore({ [MEDIA_CAPTIONS_STAGE_FLAG]: true });
    const bad = spyAdapters();
    bad.adapters.captions = { ...bad.adapters.captions, async transcribe() { return { ok: true, value: { vtt: "not vtt", language: null } }; } };
    await runMediaVendorIngest(store2.sc, { assetId: A, bucket: "post-media", path: "u/1.mp4", mediaType: "video", durationMs: 3000 }, bad.adapters);
    assert.deepEqual(store2.uploads, []);
  });

  it("a stage with no canonical asset id refuses rather than sending an unaddressable file", async () => {
    const store = makeStore({ [MEDIA_VISION_STAGE_FLAG]: true, [MEDIA_TRANSCODE_STAGE_FLAG]: true });
    const { adapters, calls } = spyAdapters();
    const report = await runMediaVendorIngest(store.sc, { assetId: null, bucket: "post-media", path: "u/1.mp4", mediaType: "video", durationMs: null }, adapters);
    assert.deepEqual(calls, []);
    assert.equal(report.vision.state === "ran" && !report.vision.result.ok, true);
  });
});

describe("§37 postcard /complete value and the general-video frame", () => {
  afterEach(() => resetCanonicalSchemaMemo());

  it("preDistributionPostMediaStatus: flag off → 'approved' and the classifier is never asked", async () => {
    const calls: Array<{ target: string }> = [];
    const v = await preDistributionPostMediaStatus(makeStore({}).sc, IMAGE, classifier({ image: true, video: true, videoFrame: true }, block, calls));
    assert.equal(v, "approved");
    assert.equal(calls.length, 0);
  });

  it("preDistributionPostMediaStatus: flag on → the decision, and a hold with no classifier", async () => {
    const on = makeStore({ [MEDIA_MODERATION_STAGE_FLAG]: true }).sc;
    assert.equal(await preDistributionPostMediaStatus(on, IMAGE, REFUSING_MODERATION_CLASSIFIER), "flagged");
    assert.equal(await preDistributionPostMediaStatus(on, IMAGE, classifier({ image: true, video: false, videoFrame: false }, block)), "rejected");
    assert.equal(await preDistributionPostMediaStatus(on, IMAGE, classifier({ image: true, video: false, videoFrame: false }, allow)), "approved");
  });

  it("moderateVideoOnFrame only TIGHTENS: a frame's block rejects the canonical row; a frame's allow changes nothing", async () => {
    const caps = { image: true, video: false, videoFrame: true };
    const held = ASSET_ROW("limited");
    const s1 = makeStore({ [MEDIA_MODERATION_STAGE_FLAG]: true }, [held]);
    const r1 = await moderateVideoOnFrame(s1.sc, { bucket: "post-media", path: "u/1.mp4", framePath: "u/1.mp4.poster.jpg" }, classifier(caps, allow));
    assert.equal(held.moderation_status, "limited");
    assert.equal(r1.state === "ran" && r1.recorded, "not_applied");
    resetCanonicalSchemaMemo();
    const s2 = makeStore({ [MEDIA_MODERATION_STAGE_FLAG]: true }, [held]);
    const r2 = await moderateVideoOnFrame(s2.sc, { bucket: "post-media", path: "u/1.mp4", framePath: "u/1.mp4.poster.jpg" }, classifier(caps, block));
    assert.equal(held.moderation_status, "rejected");
    assert.equal(r2.state === "ran" && r2.recorded, "applied");
    const off = await moderateVideoOnFrame(makeStore({}).sc, { bucket: "post-media", path: "u/1.mp4", framePath: "f" }, classifier(caps, block));
    assert.deepEqual(off, { state: "off" });
  });
});

// ── census-media §37.8 (MD269 (c)): the canonical row is BORN held ─────────────
import { canonicalModerationAtBirth } from "../lib/media/vendors/mediaVendorStages.js";
import { recordMediaAssetDetailed, MEDIA_SOURCE_UNDECLARED } from "../lib/mediaAssets.js";

/** feature_flags + the §6 schema probe + media_assets upserts, as recordMediaAssetDetailed calls them. */
function canonicalWriteClient(flags: Record<string, boolean>, probe: "present" | "missing" = "present") {
  const upserts: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_c: string, val: string) {
              return {
                maybeSingle() {
                  if (table === "feature_flags") return Promise.resolve({ data: flags[val] ? { enabled: true } : null, error: null });
                  if (table === "media_assets" && probe === "missing") {
                    return Promise.resolve({ data: null, error: { code: "PGRST204", message: "Could not find the 'provenance' column of 'media_assets' in the schema cache" } });
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        upsert(row: Record<string, unknown>) {
          upserts.push({ ...row });
          return { select() { return { single: () => Promise.resolve({ data: { id: "asset-born" }, error: null }) }; } };
        },
      };
    },
  };
  return { client: client as any, upserts };
}

const BORN_INPUT = {
  ownerUserId: "u1", storageBucket: "post-media", storagePath: "u1/1.mp4", publicUrl: "post-media/u1/1.mp4",
  mediaType: "video" as const, mimeType: "video/mp4", sizeBytes: 10, width: 64, height: 48, sourceType: MEDIA_SOURCE_UNDECLARED,
};

describe("§37.8 — MD269 (c): born held while the stage is on, byte-identical while it is off", () => {
  afterEach(() => resetCanonicalSchemaMemo());

  it("canonicalModerationAtBirth: stage off → {} (spreads to nothing); on → { moderationStatus: 'limited' }", async () => {
    assert.deepEqual(await canonicalModerationAtBirth(makeStore({}).sc), {});
    assert.deepEqual(await canonicalModerationAtBirth(makeStore({ [MEDIA_MODERATION_STAGE_FLAG]: true }).sc), { moderationStatus: "limited" });
  });

  it("the canonical insert: no moderation_status key without it; exactly 'limited' with it — one write either way", async () => {
    const off = canonicalWriteClient({ media_canonical_enabled: true });
    await recordMediaAssetDetailed(off.client, { ...BORN_INPUT, ...(await canonicalModerationAtBirth(makeStore({}).sc)) });
    assert.equal(off.upserts.length, 1);
    assert.equal("moderation_status" in off.upserts[0]!, false, "stage off: the payload is what it always was");
    resetCanonicalSchemaMemo();
    const on = canonicalWriteClient({ media_canonical_enabled: true });
    await recordMediaAssetDetailed(on.client, { ...BORN_INPUT, moderationStatus: "limited" });
    assert.equal(on.upserts.length, 1, "born held in ONE write, not written then held");
    assert.equal(on.upserts[0]!.moderation_status, "limited");
    const { moderation_status: _m, ...rest } = on.upserts[0]!;
    assert.deepEqual(rest, off.upserts[0], "nothing else about the insert changes");
  });

  it("a pre-2250 database (degraded write): the hold is dropped rather than failing a CHECK that has no §36 values", async () => {
    const d = canonicalWriteClient({ media_canonical_enabled: true, media_canonical_schema_fallback_enabled: true }, "missing");
    const r = await recordMediaAssetDetailed(d.client, { ...BORN_INPUT, moderationStatus: "limited" });
    assert.equal(r.outcome, "written_degraded");
    assert.equal("moderation_status" in d.upserts[0]!, false);
    assert.ok(r.droppedColumns.includes("moderation_status"), "the drop is reported, not silent");
  });
});

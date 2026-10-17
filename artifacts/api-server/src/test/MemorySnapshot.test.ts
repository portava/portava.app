import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMemorySnapshot, parseMemorySnapshot, replayMemorySnapshot,
  MEMORY_SNAPSHOT_ENGINES, type MemorySnapshot, type MemorySnapshotSource,
} from "../services/memory/MemorySnapshot.js";
import { normalizeEvidence, evaluateEligibility } from "../services/memoryProjections/evidence.js";
import { detectEpisodes, featureFromEvidence } from "../services/memoryProjections/episodeDetection.js";

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const MEMORY = "22222222-2222-4222-8222-222222222222";
export const SNAPSHOT = "33333333-3333-4333-8333-333333333333";

export function source(): MemorySnapshotSource {
  return {
    memory_id: MEMORY, owner_id: OWNER,
    source_version: "2026-10-15T12:00:00.123456Z", source_token: "a".repeat(64),
    captured_at: "2026-10-16T12:00:00.000Z", command_cursor: "9007199254740993",
    facts: { title: "  Đà Nẵng 🌊  ", caption: "Nguyên bản\nnot translated", original_language: "und",
      starts_at: "2026-10-15T01:00:00.000Z", ends_at: null, place_id: null,
      location_city: "Đà Nẵng", location_country: "VN" },
    signals: [
      { owner_id: OWNER, source_type: "CAMERA_CAPTURE", source_id: "capture-1",
        assertion_type: "CAPTURED_MEDIA", observed_at: "2026-10-15T01:00:00.000Z",
        assertion_json: { capture_provenance: "camera", place_id: "beach", original_text: "  biển  " },
        provenance_json: { original_language: "vi" }, confidence: 0.7 },
      { owner_id: OWNER, source_type: "CAMERA_CAPTURE", source_id: "capture-2",
        assertion_type: "CAPTURED_MEDIA", observed_at: "2026-10-15T02:00:00.000Z",
        assertion_json: { capture_provenance: "camera", place_id: "beach" }, confidence: 0.7 },
    ],
    detector_context: { visited_place_ids: [], user_splits: [], user_merges: [], thresholds: {} },
    eligibility_context: { mode: "USER_INITIATED", suppressed_classes: [] },
  };
}

describe("MemorySnapshot immutable replay envelope", () => {
  it("uses the existing normalizer, eligibility and detector without rewriting original facts", () => {
    const original = source();
    const before = structuredClone(original);
    const snapshot = buildMemorySnapshot(original);
    assert.ok(snapshot.ok);
    const replay = replayMemorySnapshot(snapshot.value);
    assert.ok(replay.ok);
    const evidence = original.signals.map((signal) => {
      const normalized = normalizeEvidence(signal, new Date(original.captured_at));
      assert.ok(normalized.ok);
      return normalized.evidence;
    });
    assert.deepEqual(replay.value.detection, detectEpisodes(evidence.map(featureFromEvidence)));
    assert.deepEqual(replay.value.eligibility, evaluateEligibility(evidence, { mode: "USER_INITIATED" }));
    assert.deepEqual(replay.value.facts, original.facts);
    assert.equal(snapshot.value.source.command_cursor, "9007199254740993");
    assert.deepEqual(original, before);
    original.facts.title = "changed later";
    assert.equal(snapshot.value.source.facts.title, before.facts.title);
  });

  it("serializes and replays deterministically, including thresholds and corrections", () => {
    const original = source();
    original.detector_context.user_splits = ["CAMERA_CAPTURE:capture-2"];
    original.detector_context.user_merges = ["CAMERA_CAPTURE:capture-2"];
    const snapshot = buildMemorySnapshot(original);
    assert.ok(snapshot.ok);
    const restored = parseMemorySnapshot(JSON.parse(JSON.stringify(snapshot.value)));
    assert.ok(restored.ok);
    assert.deepEqual(replayMemorySnapshot(restored.value), replayMemorySnapshot(snapshot.value));
    const replay = replayMemorySnapshot(snapshot.value);
    assert.ok(replay.ok);
    assert.equal(replay.value.detection.episodes.length, 2);
    const reordered = source();
    reordered.signals.reverse();
    const first = buildMemorySnapshot(source());
    const second = buildMemorySnapshot(reordered);
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.content_hash, second.value.content_hash);
  });

  it("refuses changed evidence, facts, clock, scope and forged digests", () => {
    const built = buildMemorySnapshot(source());
    assert.ok(built.ok);
    for (const mutate of [
      (value: any) => { value.source.facts.caption = "fabricated"; },
      (value: any) => { value.source.signals[0].observed_at = "2026-01-01T00:00:00Z"; },
      (value: any) => { value.source.captured_at = "2027-01-01T00:00:00Z"; },
      (value: any) => { value.source.owner_id = MEMORY; },
      (value: any) => { value.content_hash = "0".repeat(64); },
    ]) {
      const changed: MemorySnapshot = structuredClone(built.value);
      mutate(changed);
      assert.equal(parseMemorySnapshot(changed).ok, false);
    }
  });

  it("does not silently run a historical snapshot through different engines", () => {
    const built = buildMemorySnapshot(source());
    assert.ok(built.ok);
    for (const engine of Object.keys(MEMORY_SNAPSHOT_ENGINES)) {
      const changed: MemorySnapshot = structuredClone(built.value);
      (changed.engine_versions as Record<string, string>)[engine] = "future@2";
      assert.deepEqual(replayMemorySnapshot(changed), { ok: false, reason: "unsupported_version" });
    }
    assert.deepEqual(replayMemorySnapshot({ ...built.value, schema_version: 2 }), { ok: false, reason: "unsupported_version" });
  });

  it("rejects foreign, duplicate, expired, malformed and future source signals rather than losing evidence", () => {
    for (const mutate of [
      (value: MemorySnapshotSource) => { value.signals[0].owner_id = MEMORY; },
      (value: MemorySnapshotSource) => { value.signals.push(structuredClone(value.signals[0])); },
      (value: MemorySnapshotSource) => { value.signals[0].expires_at = value.captured_at; },
      (value: MemorySnapshotSource) => { value.signals[0].observed_at = "not a timestamp"; },
      (value: MemorySnapshotSource) => { value.signals[0].observed_at = "2030-01-01T00:00:00Z"; },
      (value: MemorySnapshotSource) => { value.detector_context.thresholds.time_gap_minutes = -1; },
      (value: MemorySnapshotSource) => { value.detector_context.user_merges = ["missing"]; },
    ]) {
      const changed = source();
      mutate(changed);
      assert.equal(buildMemorySnapshot(changed).ok, false);
    }
  });

  it("preserves rejected eligibility instead of promoting planned facts to occurrence", () => {
    const planned = source();
    planned.signals = [{ owner_id: OWNER, source_type: "TRIP_OUTCOME", source_id: "plan",
      assertion_type: "PLANNED", observed_at: "2026-10-15T01:00:00Z" }];
    const built = buildMemorySnapshot(planned);
    assert.ok(built.ok);
    const replay = replayMemorySnapshot(built.value);
    assert.ok(replay.ok);
    assert.equal(replay.value.eligibility.eligible, false);
    assert.equal(replay.value.eligibility.reason, "PLANNED_OR_SAVED_ONLY");
  });
});

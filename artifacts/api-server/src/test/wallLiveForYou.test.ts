/**
 * LiveForYouService — the bounded (≤4) personalized live strip (spec §4).
 *
 * Proves: bounded size, dedup against the feed, stale claims excluded, and the
 * fail-closed degrade-to-empty when Live intelligence is not servable — driven
 * through the REAL lib/liveClaimRead gate path with a faithful fake client so the
 * strip inherits every freshness/privacy guarantee rather than re-implementing it.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveForYou,
  type LiveForYouCandidate,
} from "../services/wall/LiveForYouService.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const FUTURE = new Date(NOW.getTime() + 3600_000).toISOString(); // +1h
const PAST = new Date(NOW.getTime() - 3600_000).toISOString(); // -1h

/** All gate flags ON, kill switch disengaged — Live is servable. */
const FLAGS_ON: Record<string, boolean> = {
  intel_live_label_crowd: true,
  intel_claim_projection_crowd: true,
  intel_capture_quick_signal: true,
  intel_limited_live: true,
  disable_intel_live_labels: false,
};

function snapshot(subjectId: string, opts: { confidence?: number; expiresAt?: string } = {}) {
  return {
    id: `snap-${subjectId}`,
    zone_id: "z1",
    claim_type: "crowd.level",
    value: "busy",
    confidence: opts.confidence ?? 0.8, // 'live' band
    source_count: 30,
    observed_at: NOW.toISOString(),
    expires_at: opts.expiresAt ?? FUTURE,
    privacy_eligible: true,
  };
}

/**
 * Faithful fake of the readLiveClaims dependency surface:
 *   feature_flags(.eq(flag).maybeSingle), intel_live_promoted_scopes(select),
 *   intel_state_snapshots(.eq(subject_id).eq(privacy_eligible).gt(expires_at)[.in]).
 */
function liveClient(cfg: {
  flags: Record<string, boolean>;
  promotedScopes: string[];
  snapshotsBySubject: Record<string, any[]>;
}) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const b: any = {
        select() {
          return b;
        },
        eq(col: string, val: unknown) {
          filters[col] = val;
          return b;
        },
        gt() {
          return b;
        },
        in() {
          return b;
        },
        maybeSingle() {
          if (table === "feature_flags") {
            const flag = String(filters["flag"]);
            return Promise.resolve({ data: { enabled: !!cfg.flags[flag] }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(onF: any, onR: any) {
          let data: any[] = [];
          if (table === "intel_live_promoted_scopes") {
            data = cfg.promotedScopes.map((k) => ({ scope_key: k }));
          } else if (table === "intel_state_snapshots") {
            data = cfg.snapshotsBySubject[String(filters["subject_id"])] ?? [];
          }
          return Promise.resolve({ data, error: null }).then(onF, onR);
        },
      };
      return b;
    },
  };
}

function cand(subjectId: string): LiveForYouCandidate {
  return { subjectId, liveObjectType: "place_state", subject: { placeId: subjectId, name: subjectId } };
}

describe("LiveForYouService", () => {
  beforeEach(() => _clearPromotedScopeCache());

  it("returns live items for relevant subjects, bounded to ≤ 4", async () => {
    const subjects = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const snapshotsBySubject: Record<string, any[]> = {};
    for (const s of subjects) snapshotsBySubject[s] = [snapshot(s)];
    const sc = liveClient({ flags: FLAGS_ON, promotedScopes: ["z1|crowd.level"], snapshotsBySubject });

    const out = await buildLiveForYou(sc, subjects.map(cand), { limit: 10, now: NOW });
    assert.ok(out.length <= 4, "strip is bounded to at most 4");
    assert.equal(out.length, 4);
    assert.equal(out[0].state, "live");
    assert.equal(out[0].freshness, "live");
    assert.equal(out[0].subjectId, "s1"); // deterministic candidate order
    assert.ok(out[0].action?.type === "see_place");
  });

  it("dedupes against subjects already shown in the feed", async () => {
    const sc = liveClient({
      flags: FLAGS_ON,
      promotedScopes: ["z1|crowd.level"],
      snapshotsBySubject: { s1: [snapshot("s1")], s2: [snapshot("s2")] },
    });
    const out = await buildLiveForYou(sc, [cand("s1"), cand("s2")], {
      now: NOW,
      dedupeSubjectIds: new Set(["s1"]),
    });
    assert.deepEqual(out.map((x) => x.subjectId), ["s2"], "s1 is not repeated in the strip");
  });

  it("excludes stale claims (belt-and-braces past-expiry filter)", async () => {
    const sc = liveClient({
      flags: FLAGS_ON,
      promotedScopes: ["z1|crowd.level"],
      snapshotsBySubject: {
        fresh: [snapshot("fresh")],
        stale: [snapshot("stale", { expiresAt: PAST })],
      },
    });
    const out = await buildLiveForYou(sc, [cand("stale"), cand("fresh")], { now: NOW });
    assert.deepEqual(out.map((x) => x.subjectId), ["fresh"]);
  });

  it("degrades to an EMPTY strip when Live intelligence is not servable", async () => {
    const sc = liveClient({
      flags: { ...FLAGS_ON, intel_live_label_crowd: false }, // one gate off ⇒ nothing servable
      promotedScopes: ["z1|crowd.level"],
      snapshotsBySubject: { s1: [snapshot("s1")] },
    });
    const out = await buildLiveForYou(sc, [cand("s1")], { now: NOW });
    assert.deepEqual(out, [], "a live-subsystem gate off yields no live labels, never a fabricated one");
  });

  it("degrades to empty when no candidates are relevant", async () => {
    const sc = liveClient({ flags: FLAGS_ON, promotedScopes: ["z1|crowd.level"], snapshotsBySubject: {} });
    assert.deepEqual(await buildLiveForYou(sc, [], { now: NOW }), []);
  });

  it("never throws when the read path errors — returns fewer/zero items", async () => {
    const throwing = {
      from() {
        throw new Error("intel down");
      },
    };
    const out = await buildLiveForYou(throwing, [cand("s1")], { now: NOW });
    assert.deepEqual(out, []);
  });
});

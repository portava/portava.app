/**
 * `06` §8 Ecosystem Governor — the MONITOR half only (census-discovery DV-80,
 * §58). Pure: every reading from fixture read outcomes.
 *
 * Pinned: the monitors are `06` §8's seven in its order plus `12` Phase 13's
 * duplicate saturation; a monitor with no input is UNMEASURED and carries no
 * number; a failed read is UNREADABLE / INPUT ABSENT, never 0 and never clear;
 * a zero denominator is insufficient_sample, never 0 %; concentration is P9's
 * producer read through P9's parser; hidden-gem exposure uses P6's exposure
 * definition; every read is read-only and returns no user id; and the ADJUST
 * half does not exist.
 *
 * Run: node --import tsx/esm --test src/test/discoveryEcosystemGovernor.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as governor from "../lib/discoveryEcosystemGovernor.js";
import {
  buildEcosystemReport, renderEcosystemReport, ECOSYSTEM_MONITORS, ECOSYSTEM_READS,
  ECOSYSTEM_REPEATS_SQL, readConcentration, readRepeats, readSpam, readTrailFreshness,
  readHiddenGemExposure, readDuplicateSaturation,
  type EcosystemInputs, type ReadOutcome,
} from "../lib/discoveryEcosystemGovernor.js";
import { WRITE_KEYWORDS } from "../lib/discoveryTraceRead.js";
import { DiscoveryServePoint } from "../lib/discoveryServeLog.js";

const UNTIL = "2031-04-08T00:00:00.000Z";
const UNTIL_MS = Date.parse(UNTIL);
const ok = (value: unknown): ReadOutcome => ({ ok: true, value: JSON.stringify(value) });
const err: ReadOutcome = { ok: false, error: "psql exited 1" };

/** 3391's body, as discovery_stop_measurements returns it. */
const STOP = {
  reports_hides: { state: "measured", exposures: 50, hides: 1, place_reports: 0, trail_reports: null },
  creator_concentration: { state: "measured", exposures: 50, resolved: 20, creators: 3, hhi: 0.82, top_creator_share: 0.9 },
  attribution_double_count: { state: "input_absent" },
  rls_leak: { state: "measured", deviations: 0, detail: [] },
};

const exposure = (sp: number) => ({ outcome: "impression", event_type: null, features: { servePoint: sp } });

const INPUT = (): EcosystemInputs => ({
  window: { since: "2031-04-01T00:00:00.000Z", until: UNTIL },
  stop: ok(STOP),
  corpus: {
    ok: true,
    rows: [
      exposure(DiscoveryServePoint.HIDDEN_GEMS), exposure(DiscoveryServePoint.FEED),
      exposure(DiscoveryServePoint.CACHE_A_L1), exposure(DiscoveryServePoint.SEARCH),
      // Not exposures: an attention row and ranker bookkeeping, both on the hidden-gems point.
      { outcome: "analytics", event_type: "place_dwell", features: { servePoint: DiscoveryServePoint.HIDDEN_GEMS } },
      { outcome: "analytics", event_type: null, features: { servePoint: DiscoveryServePoint.HIDDEN_GEMS } },
    ],
  },
  repeats: ok({ exposures: 10, viewer_item_pairs: 6, repeated_pairs: 3, viewers: 2, max_per_pair: 3 }),
  spam: ok({ served_community_places: 20, served_places_spam_reported: 3, spam_reports_in_window: 2, reports_in_window: 5 }),
  trails: ok({
    trails: 4, with_snapshot: 3,
    snapshots: [
      { captured_at: "2031-04-07T00:00:00.000Z", content_freshness: 0.5, stale_object_ratio: 0.1, duplicate_density: 0 },
      { captured_at: "2031-04-06T00:00:00.000Z", content_freshness: null, stale_object_ratio: 0.2, duplicate_density: 0.5 },
      { captured_at: "2031-04-05T00:00:00.000Z", content_freshness: 0.25, stale_object_ratio: null, duplicate_density: 0.25 },
    ],
  }),
  pages: ok({ pages: 5, pages_with_duplicates: 1, served_items: 40, duplicate_items: 2 }),
});

const reading = (r: ReturnType<typeof buildEcosystemReport>, id: string) => r.monitors.find((m) => m.id === id)!.reading;

describe("DV-80 — the monitors are the specification's, in its order", () => {
  it("1. `06` §8's seven in order, then `12` Phase 13's one extra; every Phase 13 item is covered once", () => {
    assert.deepEqual(ECOSYSTEM_MONITORS.filter((m) => m.spec06).map((m) => m.spec06), [
      "concentration", "new-creator success", "stale content", "repeated recommendations",
      "spam rate", "Trail freshness", "hidden-gem exposure",
    ]);
    assert.deepEqual(ECOSYSTEM_MONITORS.map((m) => m.phase13).filter(Boolean).sort(), [
      "creator concentration", "duplicate saturation", "new creator opportunity",
      "repeat recommendations", "spam", "Trail staleness",
    ].sort());
  });

  it("2. exactly two have no input in the tree; they are UNMEASURED with the missing input named, and carry no number", () => {
    const r = buildEcosystemReport(INPUT());
    const unmeasured = r.monitors.filter((m) => m.reading.state === "unmeasured");
    assert.deepEqual(unmeasured.map((m) => m.id), ["new_creator_success", "stale_content"]);
    for (const m of unmeasured) {
      assert.ok((m.reading as any).missingInput.length > 40);
      assert.equal((m.reading as any).value, undefined);
    }
  });
});

describe("DV-80 — each measured monitor, from fixture reads", () => {
  it("3. concentration is P9's HHI through P9's parser, with its coverage", () => {
    const c = readConcentration(ok(STOP), UNTIL_MS);
    assert.equal(c.state, "measured");
    assert.equal((c as any).value, 0.82);
    assert.equal((c as any).sample, 20);
    assert.equal((c as any).detail.coverage, 0.4);
    const none = readConcentration(ok({ ...STOP, creator_concentration: { state: "measured", exposures: 7, resolved: 0, creators: 0, hhi: null, top_creator_share: null } }), UNTIL_MS);
    assert.equal(none.state, "insufficient_sample", "nothing resolved to a creator is not concentration 0");
    assert.equal(readConcentration(ok({}), UNTIL_MS).state, "unreadable");
  });

  it("4. repeated recommendations: repeats per exposure; empty is insufficient; incoherent is unreadable", () => {
    const r = readRepeats(ok({ exposures: 10, viewer_item_pairs: 6, repeated_pairs: 3, viewers: 2, max_per_pair: 3 }));
    assert.equal((r as any).value, 0.4);
    assert.equal((r as any).sample, 10);
    assert.equal(readRepeats(ok({ exposures: 0, viewer_item_pairs: 0, repeated_pairs: 0, viewers: 0, max_per_pair: 0 })).state, "insufficient_sample");
    assert.equal(readRepeats(ok({ exposures: 3, viewer_item_pairs: 4, repeated_pairs: 0, viewers: 1, max_per_pair: 1 })).state, "unreadable");
  });

  it("5. spam: reported-spam share of served community places, with the limit named", () => {
    const s = readSpam(ok({ served_community_places: 20, served_places_spam_reported: 3, spam_reports_in_window: 2, reports_in_window: 5 }));
    assert.equal((s as any).value, 0.15);
    assert.match((s as any).detail.limit, /REPORTED spam only/);
    assert.equal(readSpam(ok({ served_community_places: 0, served_places_spam_reported: 0, spam_reports_in_window: 0, reports_in_window: 0 })).state, "insufficient_sample");
  });

  it("6. Trail freshness: the mean over measured snapshots only; a null metric is counted as unmeasured, not 0", () => {
    const t = readTrailFreshness(INPUT().trails, UNTIL_MS);
    assert.equal(t.state, "measured");
    assert.equal((t as any).value, 0.375);
    assert.equal((t as any).sample, 2);
    assert.deepEqual((t as any).detail.contentFreshness, { n: 2, mean: 0.375, min: 0.25, max: 0.5, unmeasured: 1 });
    assert.equal((t as any).detail.trailsWithoutSnapshot, 1);
    assert.deepEqual((t as any).detail.snapshotAgeMs, { newest: 86_400_000, oldest: 3 * 86_400_000 });
  });

  it("7. hidden-gem exposure counts P6's exposures only — an attention row or bookkeeping on that serve point is not one", () => {
    const h = readHiddenGemExposure(INPUT().corpus);
    assert.equal((h as any).value, 0.25);
    assert.equal((h as any).sample, 4);
  });

  it("8. duplicate saturation: repeated places per served item, with the Trail density beside it", () => {
    const d = readDuplicateSaturation(INPUT().pages, INPUT().trails);
    assert.equal((d as any).value, 0.05);
    assert.equal((d as any).detail.trailDuplicateDensity.n, 3);
  });
});

describe("DV-80 — failure is a reading, never a zero", () => {
  it("9. every read failed ⇒ every measured monitor is unreadable or input_absent, none carries a value", () => {
    const r = buildEcosystemReport({
      ...INPUT(),
      stop: err, repeats: err, spam: err,
      trails: { ok: false, absent: "2910 unapplied" },
      pages: { ok: false, absent: "3376 unapplied" },
      corpus: { ok: false, error: "rank_events read failed" },
    });
    for (const m of r.monitors) {
      assert.ok(["unreadable", "input_absent", "unmeasured"].includes(m.reading.state), `${m.id} read ${m.reading.state}`);
      assert.equal((m.reading as any).value, undefined, m.id);
    }
    assert.equal(reading(r, "trail_freshness").state, "input_absent");
    assert.equal(reading(r, "duplicate_saturation").state, "input_absent");
    const text = renderEcosystemReport(r);
    assert.match(text, /UNREADABLE \(psql exited 1\) — not 0, not clear/);
    assert.match(text, /INPUT ABSENT on this database \(2910 unapplied\) — not 0/);
  });

  it("10. a malformed body is unreadable on its own monitor and does not blank the others", () => {
    const r = buildEcosystemReport({ ...INPUT(), spam: ok({ served_community_places: "many" }) });
    assert.equal(reading(r, "spam_rate").state, "unreadable");
    assert.equal(reading(r, "repeated_recommendations").state, "measured");
  });
});

describe("DV-80 — measurement only: read-only, no user id out, and no adjust half", () => {
  it("11. no read contains a write keyword", () => {
    for (const sql of ECOSYSTEM_READS) assert.equal(WRITE_KEYWORDS.test(sql), false, sql.slice(0, 80));
  });

  it("12. the repeat read groups by viewer INSIDE the database and returns counts only", () => {
    const out = /json_build_object\(([\s\S]*)\)::text/.exec(ECOSYSTEM_REPEATS_SQL)![1]!;
    assert.ok(!/user_id'/.test(out) && !/'user/.test(out), "a user id is a key of the output");
    assert.match(out, /count\(DISTINCT user_id\)/);
  });

  it("13. the report states it adjusts nothing and rules nothing, and the module exports no adjuster", () => {
    const r = buildEcosystemReport(INPUT());
    assert.match(r.adjust, /^not built/);
    assert.match(r.verdict, /^none/);
    const names = Object.keys(governor);
    assert.deepEqual(names.filter((n) => /adjust|bound|apply|propose|policy/i.test(n)), []);
  });
});

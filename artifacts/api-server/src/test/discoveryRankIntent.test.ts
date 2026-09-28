/**
 * census-discovery §78 (lane W10-R2) — A18: explicit current intent weighs more
 * than generic interests, inside the ranker. Controlled data.
 *
 *   I1  all eight §8 modes resolve from INTENT_MODE_PROFILES — consumed, not restated
 *   I2  THE ROW: a full intent fit outranks a full generic-interest match
 *       (interestTag + categoryAffinity stacked), all else equal
 *   I3  the request's mode wins over the viewer's window; a window answers
 *       when the request names none
 *   I4  only EXPLICIT, ACTIVE windows count; plan-derived and expired do not
 *   I5  no intent ⇒ no `intentMatch` key at all
 *   I6  compatibility modes read their keywords; an axis the candidate cannot
 *       show is left out, not scored 0
 *   I7  `intentMatch` never becomes a public reason
 *   I8  the window-intent map is total over OpenToPlansService INTENT_TYPES
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryRankIntent.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveIntentMode, intentFromRequestMode, intentFromWindowIntents, loadViewerIntent,
  MODE_KEYWORDS, WINDOW_INTENT_TO_RANK,
} from "../lib/discoveryRankIntent.js";
import { INTENT_MODE_PROFILES } from "../lib/discoveryLiveRank.js";
import { INTENT_MODES } from "../lib/intentModes.js";
import {
  rankCandidates, scoreCandidate, intentModeFit, INTENT_TERM_WEIGHT, DEFAULT_WEIGHTS,
  type RankCandidate, type ViewerContext,
} from "../lib/portavaRank.js";
import { reasonCodeForSignal, UNMAPPED_SIGNALS } from "../lib/discoveryReasonCodes.js";
import { INTENT_TYPES } from "../services/passport/OpenToPlansService.js";
import { newWorld, worldClient } from "./helpers/fakeDiscoveryWorld.js";

const NOW = Date.UTC(2026, 8, 28, 18);
const H = 3_600_000;
const V = "dddd0000-0000-4000-8000-00000000000d";

describe("A18 — explicit current intent as a ranking term", () => {
  it("I1 all eight modes resolve from INTENT_MODE_PROFILES, weight for weight", () => {
    assert.equal(INTENT_MODES.length, 8);
    for (const m of INTENT_MODES) {
      const r = resolveIntentMode(m);
      assert.deepEqual(r.weights, INTENT_MODE_PROFILES[m].weights, `${m}: the profile is consumed, not restated`);
      if (INTENT_MODE_PROFILES[m].weights.compatibility > 0) assert.ok((MODE_KEYWORDS[m] ?? []).length > 0, `${m} weights compatibility, so it needs keywords`);
      else assert.equal(MODE_KEYWORDS[m], undefined, `${m} does not weight compatibility; a keyword list would be read by nothing`);
    }
  });

  it("I2 a full intent fit outranks a full generic-interest match, all else equal", () => {
    assert.ok(INTENT_TERM_WEIGHT > DEFAULT_WEIGHTS.interestTag + DEFAULT_WEIGHTS.categoryAffinity);
    const ctx: ViewerContext = {
      userId: "v", nowMs: NOW,
      interestTags: new Set(["rooftop"]), categoryAffinities: { nightlife: 1 },
      intent: intentFromRequestMode("quiet")!,
    };
    // No createdAt, distance or start time: `compatibility` is the only axis Quiet
    // weights that either candidate can show, so each fit is exactly its keyword
    // match — 1 for the museum, 0 for the rooftop bar — and the comparison is the
    // term's weight against the interests' weight, which is what the row states.
    const generic: RankCandidate = { id: "generic", kind: "place", category: "nightlife", tags: ["rooftop"] };
    const intended: RankCandidate = { id: "intended", kind: "place", category: "culture", tags: ["museum"] };
    const out = rankCandidates([generic, intended], ctx, { exploration: false, diversity: false });
    assert.deepEqual(out.map((s) => s.candidate.id), ["intended", "generic"]);
    const g = out.find((s) => s.candidate.id === "generic")!.features;
    const i = out.find((s) => s.candidate.id === "intended")!.features;
    assert.equal(g.interestTag + g.categoryAffinity, 0.7, "the generic match is FULL");
    assert.equal(i.intentMatch, INTENT_TERM_WEIGHT, "a full fit is the whole weight");
    assert.equal(g.intentMatch, 0, "no fit, no intent credit");
    // Control: without the intent the generic match wins, so the term is what moved it.
    const ctl = rankCandidates([generic, intended], { ...ctx, intent: null }, { exploration: false, diversity: false });
    assert.deepEqual(ctl.map((s) => s.candidate.id), ["generic", "intended"]);
  });

  it("I3 the request's mode wins; a window answers only when the request names none", async () => {
    const world = newWorld({ tables: { availability_windows: [
      { id: "w1", user_id: V, type: "one_time", start_at: new Date(NOW - H).toISOString(), end_at: new Date(NOW + 3 * H).toISOString(),
        expires_at: null, intents: ["Nightlife"], source: "explicit", open_to_plans: true, visibility: "private" },
    ] } });
    const sc = worldClient(world);
    const fromReq = await loadViewerIntent(sc, V, "quiet", NOW);
    assert.equal(fromReq.source, "request");
    assert.deepEqual(fromReq.intent!.modes.map((m) => m.mode), ["quiet"]);
    assert.ok(!world.reads.includes("availability_windows"), "a request mode needs no window read");
    const fromWin = await loadViewerIntent(sc, V, undefined, NOW);
    assert.equal(fromWin.source, "passport_window");
    assert.deepEqual(fromWin.intent!.modes.map((m) => m.mode), ["high_energy"]);
    assert.deepEqual(fromWin.intent!.categoryHints, ["nightlife"]);
    const junk = await loadViewerIntent(sc, V, "bogus-mode", NOW);
    assert.equal(junk.source, "passport_window", "an unknown request mode is ignored, never a 400 and never guessed");
  });

  it("I4 plan-derived and expired windows are not explicit current intent", async () => {
    const base = { type: "one_time", open_to_plans: true, visibility: "private", expires_at: null };
    const world = newWorld({ tables: { availability_windows: [
      { ...base, id: "a", user_id: V, start_at: new Date(NOW - H).toISOString(), end_at: new Date(NOW + H).toISOString(), intents: ["Food"], source: "plan_derived" },
      { ...base, id: "b", user_id: V, start_at: new Date(NOW - 5 * H).toISOString(), end_at: new Date(NOW - H).toISOString(), intents: ["Drinks"], source: "explicit" },
      { ...base, id: "c", user_id: "someone-else", start_at: new Date(NOW - H).toISOString(), end_at: new Date(NOW + H).toISOString(), intents: ["Explore"], source: "explicit" },
    ] } });
    const r = await loadViewerIntent(worldClient(world), V, null, NOW);
    assert.deepEqual(r, { intent: null, source: "none" });
  });

  it("I5 no intent ⇒ no `intentMatch` key, and the score is unchanged", () => {
    const c: RankCandidate = { id: "x", kind: "place", category: "food", distanceKm: 1 };
    const plain = scoreCandidate(c, { userId: "v", nowMs: NOW });
    const nul = scoreCandidate(c, { userId: "v", nowMs: NOW, intent: null });
    assert.ok(!("intentMatch" in plain.features));
    assert.ok(!("intentMatch" in nul.features));
    assert.equal(nul.score, plain.score);
  });

  it("I6 keywords for compatibility modes, and unobservable axes left out", () => {
    const ctx: ViewerContext = { userId: "v", nowMs: NOW, seenIds: new Set(["seen"]), categoryAffinities: { food: 1 } };
    const quiet = resolveIntentMode("quiet");
    const museum: RankCandidate = { id: "m", kind: "place", tags: ["museum"] };
    const club: RankCandidate = { id: "c", kind: "place", category: "nightlife" };
    // Only `compatibility` is observable for these two (no distance, no createdAt, no startsAt except durability,
    // which quiet weights 0), so the fit is exactly the keyword match.
    assert.equal(intentModeFit(museum, quiet, ctx, NOW), 1);
    assert.equal(intentModeFit(club, quiet, ctx, NOW), 0);
    const tonight = resolveIntentMode("tonight");
    const soon: RankCandidate = { id: "soon", kind: "event", startsAt: new Date(NOW + 2 * H).toISOString() };
    const later: RankCandidate = { id: "later", kind: "event", startsAt: new Date(NOW + 30 * H).toISOString() };
    assert.ok(intentModeFit(soon, tonight, ctx, NOW) > intentModeFit(later, tonight, ctx, NOW), "Tonight: forecast is its heaviest axis");
    const nearby = resolveIntentMode("nearby");
    assert.ok(intentModeFit({ id: "n", kind: "place", distanceKm: 0.2 }, nearby, ctx, NOW)
      > intentModeFit({ id: "f", kind: "place", distanceKm: 15 }, nearby, ctx, NOW));
    assert.equal(intentModeFit({ id: "none", kind: "place" }, nearby, ctx, NOW), 0, "nothing observable ⇒ 0, not a guess");
  });

  it("I7 `intentMatch` is never a public reason", () => {
    assert.equal(reasonCodeForSignal("intentMatch"), null);
    assert.match(UNMAPPED_SIGNALS.intentMatch ?? "", /^NO CODE/);
  });

  it("I8 the window-intent map is total over INTENT_TYPES", () => {
    assert.deepEqual(Object.keys(WINDOW_INTENT_TO_RANK).sort(), [...INTENT_TYPES].sort());
    assert.equal(intentFromWindowIntents([]), null);
    assert.deepEqual(intentFromWindowIntents(["Food"])!.categoryHints, ["food", "restaurant", "cafe"]);
  });
});

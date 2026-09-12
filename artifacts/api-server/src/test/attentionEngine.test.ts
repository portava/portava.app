/**
 * Sensing §15 — the Attention Engine (census-sensing S102).
 *
 * Every factor the row names is pinned on its own: relevance, novelty,
 * urgency, half-life, availability, interruption cost, attention budget —
 * and the four routes they lead to. Availability UNKNOWN is never read as
 * available; a safety activation overrides availability and budget for a
 * viewer with a real relation to the place, and never novelty.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTENTION_BUDGET_PER_WINDOW,
  ATTENTION_ROUTES,
  HALF_LIFE_STALE_RATIO,
  routeAttention,
  type AttentionViewer,
} from "../lib/attentionEngine.js";
import type { WallMoment, WallTransitionKind } from "../lib/wallMoments.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-12T20:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

function moment(kind: WallTransitionKind, over: Partial<WallMoment> = {}): WallMoment {
  return {
    id: `moment:place:${kind}`,
    subject: { kind: "place", id: "place" },
    transition: { kind, claimType: "crowd.level", from: "busy", to: "packed" },
    occurredAt: iso(-5),
    relevanceWindow: { from: iso(-5), until: iso(25) },
    reason: { code: kind, text: kind },
    truthClass: "observed",
    confidence: "live",
    freshness: "live",
    coverage: "few",
    expiresAt: iso(25),
    claimRef: "snap-1",
    ...over,
  };
}
const viewer = (over: Partial<AttentionViewer> = {}): AttentionViewer => ({
  relevance: "saved",
  seenMomentIds: new Set(),
  available: true,
  notifiesInWindow: 0,
  ...over,
});

describe("vocabulary and purity", () => {
  it("is NOTIFY / WALL / SILENT / IGNORE", () => {
    assert.deepEqual([...ATTENTION_ROUTES], ["NOTIFY", "WALL", "SILENT", "IGNORE"]);
  });
  it("reads no clock, no database and sends nothing", () => {
    const code = readFileSync(join(SRC, "lib", "attentionEngine.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /Date\.now\(|new Date\(\)/);
    assert.doesNotMatch(code, /supabase|getServiceClient|\.from\(|sendPush|NotificationService/);
  });
  it("every decision carries every factor the spec names", () => {
    const d = routeAttention(moment("peaking"), viewer(), NOW);
    assert.deepEqual(Object.keys(d.factors).sort(), ["availability", "budget", "halfLife", "interruptionCost", "novelty", "relevance", "urgency"]);
  });
});

describe("novelty", () => {
  it("a moment the viewer has seen is IGNORE, whatever else is true — even a safety activation", () => {
    const seen = viewer({ seenMomentIds: new Set(["moment:place:safety_notice_activated"]) });
    const d = routeAttention(moment("safety_notice_activated"), seen, NOW);
    assert.equal(d.route, "IGNORE");
    assert.deepEqual(d.reasons, ["already_seen"]);
    assert.equal(d.factors.novelty, false);
  });
});

describe("half-life", () => {
  it("past its relevance window a moment is IGNORE", () => {
    const d = routeAttention(moment("peaking", { relevanceWindow: { from: iso(-60), until: iso(-1) } }), viewer(), NOW);
    assert.equal(d.route, "IGNORE");
    assert.deepEqual(d.reasons, ["expired"]);
    assert.ok(d.factors.halfLife > 1);
  });
  it("most of the way through its window it is stale news: SILENT for a relevant viewer, IGNORE for a weak one", () => {
    const late = { from: iso(-24), until: iso(6) }; // 0.8 of the window
    const d = routeAttention(moment("peaking", { relevanceWindow: late }), viewer(), NOW);
    assert.equal(d.route, "SILENT");
    assert.deepEqual(d.reasons, ["decayed"]);
    assert.ok(d.factors.halfLife > HALF_LIFE_STALE_RATIO && d.factors.halfLife < 1);
    assert.equal(routeAttention(moment("peaking", { relevanceWindow: late }), viewer({ relevance: "nearby" }), NOW).route, "IGNORE");
  });
});

describe("relevance", () => {
  it("no relation to the place is IGNORE", () => {
    const d = routeAttention(moment("safety_notice_activated"), viewer({ relevance: "none" }), NOW);
    assert.equal(d.route, "IGNORE");
    assert.deepEqual(d.reasons, ["not_relevant"]);
  });
  it("a saved place or trip stop may reach NOTIFY; a followed place goes to the WALL; merely nearby is SILENT unless urgent", () => {
    assert.equal(routeAttention(moment("peaking"), viewer({ relevance: "trip_stop" }), NOW).route, "NOTIFY");
    assert.equal(routeAttention(moment("peaking"), viewer({ relevance: "followed" }), NOW).route, "WALL");
    assert.equal(routeAttention(moment("vibe_change"), viewer({ relevance: "nearby" }), NOW).route, "SILENT");
    assert.equal(routeAttention(moment("peaking"), viewer({ relevance: "nearby" }), NOW).route, "WALL");
  });
});

describe("urgency, availability, interruption cost and budget", () => {
  it("urgent + relevant + novel + available + budget ⇒ NOTIFY; a low-urgency change ⇒ WALL", () => {
    assert.deepEqual(routeAttention(moment("peaking"), viewer(), NOW).reasons, ["urgent_relevant_available"]);
    assert.equal(routeAttention(moment("peaking"), viewer(), NOW).route, "NOTIFY");
    assert.equal(routeAttention(moment("cooling"), viewer(), NOW).route, "WALL");
    assert.deepEqual(routeAttention(moment("cooling"), viewer(), NOW).reasons, ["relevant"]);
  });
  it("quiet hours or push off defer an urgent change to the WALL, never drop it", () => {
    const d = routeAttention(moment("peaking"), viewer({ available: false }), NOW);
    assert.equal(d.route, "WALL");
    assert.deepEqual(d.reasons, ["unavailable_deferred_to_wall"]);
  });
  it("UNKNOWN availability is not availability: an unreadable consent defers to the WALL", () => {
    const d = routeAttention(moment("peaking"), viewer({ available: null }), NOW);
    assert.equal(d.route, "WALL");
    assert.deepEqual(d.reasons, ["availability_unknown_deferred_to_wall"]);
  });
  it("the attention budget: the interruptions already delivered in the window exhaust it", () => {
    const ok = routeAttention(moment("peaking"), viewer({ notifiesInWindow: ATTENTION_BUDGET_PER_WINDOW - 1 }), NOW);
    assert.equal(ok.route, "NOTIFY");
    const spent = routeAttention(moment("peaking"), viewer({ notifiesInWindow: ATTENTION_BUDGET_PER_WINDOW }), NOW);
    assert.equal(spent.route, "WALL");
    assert.deepEqual(spent.reasons, ["budget_exhausted_deferred_to_wall"]);
    assert.equal(spent.factors.interruptionCost, ATTENTION_BUDGET_PER_WINDOW);
    assert.equal(routeAttention(moment("peaking"), viewer({ notifiesInWindow: 10, budgetPerWindow: 20 }), NOW).route, "NOTIFY");
  });
});

describe("safety", () => {
  it("a safety activation for a saved place is NOTIFY through quiet hours, through an unknown consent read and past the budget", () => {
    for (const v of [viewer({ available: false }), viewer({ available: null }), viewer({ notifiesInWindow: 99 })]) {
      const d = routeAttention(moment("safety_notice_activated"), v, NOW);
      assert.equal(d.route, "NOTIFY");
      assert.deepEqual(d.reasons, ["safety_override"]);
    }
  });
  it("but not for a viewer merely nearby or one who only follows the place — those reach the WALL — and never when already seen or expired", () => {
    assert.equal(routeAttention(moment("safety_notice_activated"), viewer({ relevance: "nearby" }), NOW).route, "WALL");
    assert.equal(routeAttention(moment("safety_notice_activated"), viewer({ relevance: "followed" }), NOW).route, "WALL");
    assert.equal(routeAttention(moment("safety_notice_activated", { relevanceWindow: { from: iso(-60), until: iso(-1) } }), viewer(), NOW).route, "IGNORE");
  });
});

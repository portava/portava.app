/**
 * census-discovery §57 — A11 (Trips `:185`): *"Discovery, Compass, Saved
 * Ideas, and Buddy matching consume these [Temporal Freedom] windows rather
 * than independently calculating 'free time'."*
 *
 * The row's last statement names the duplicate as `lib/portavaRank.ts`'s
 * `availableMinutes` (`:99`) — `availabilityFitScore`'s "must start within the
 * window" arithmetic. That file is ranking code under the ranker hold and is
 * NOT changed here. The brief allowed replacing the duplicate with a read of
 * the windows only if the result is provably identical on every input; it is
 * not replaceable that way (a caller-supplied scalar minute budget and a set
 * of Temporal Freedom windows are different inputs, so no read of the windows
 * can equal it "on every input"). What CAN be proved, and is proved here, is
 * the narrower fact that decides what the row may claim about DISCOVERY:
 *
 *   1. No Discovery candidate can ever reach that arithmetic. lib/discoveryPde
 *      maps places to RankCandidates with no `startsAt`, and
 *      `availabilityFitScore` answers 0 for a candidate with no start before it
 *      reads either free-time field. PROPERTY: over seeded random
 *      Discovery-shaped candidate sets and viewer contexts, every free-time
 *      value (none, 0, positive, huge, negative, `availableNow` either way)
 *      yields the SAME scores, the same feature vectors and the same order.
 *   2. No Discovery module supplies either field (source guard), and the
 *      Discovery candidate mapping carries no `startsAt` (source guard).
 *   3. The property is not vacuous: a candidate that DOES carry a start moves
 *      with `availableMinutes` (control).
 *
 * So the duplicate is dead on every Discovery path — which is evidence for the
 * row's second half, not a closure of it: the arithmetic still exists in a
 * shared ranker (Events and Pulse also call `rankCandidates`, though no caller
 * in this tree sets either field), and removing it is the ranker owner's call.
 *
 * Run: node --import tsx/esm --test src/test/discoveryFreeTimeDuplicate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { rankCandidates, availabilityFitScore, type RankCandidate, type ViewerContext } from "../lib/portavaRank.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

/** mulberry32 — a seeded PRNG so a failure is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES = ["night_market", "cafe", "museum", "bar", "park", null] as const;
const TAGS = ["food", "art", "nightlife", "quiet", "view"] as const;

/**
 * A candidate exactly as lib/discoveryPde's `rankForViewer` builds one: the
 * fields it sets and NO others — in particular no `startsAt`, no `createdAt`,
 * no `authorId` (source guard G2 pins that mapping).
 */
function discoveryCandidate(rand: () => number, i: number): RankCandidate {
  const db = rand() < 0.5;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  return {
    id: db ? `db/${i}` : `node/${i}`,
    kind: db ? "gem" : "place",
    city: pick(["da nang", "hoi an", null] as const),
    neighborhood: pick(["hai chau", "son tra", null] as const),
    category: pick(CATEGORIES),
    distanceKm: rand() < 0.2 ? null : Math.round(rand() * 400) / 10,
    verified: db ? true : null,
    likeCount: rand() < 0.3 ? null : Math.floor(rand() * 50),
    tags: TAGS.filter(() => rand() < 0.3),
    placeId: db ? `db/${i}` : `node/${i}`,
  } as RankCandidate;
}

function viewer(rand: () => number): ViewerContext {
  return {
    userId: "v",
    city: rand() < 0.5 ? "da nang" : null,
    followedIds: new Set(),
    interestTags: new Set(TAGS.filter(() => rand() < 0.4)),
    categoryAffinities: rand() < 0.5 ? { night_market: rand(), cafe: rand() } : undefined,
    seenIds: new Set(rand() < 0.5 ? ["db/1", "node/2"] : []),
    nowMs: NOW,
  };
}

/** Every free-time value the duplicate could be handed, including nonsense. */
const FREE_TIME: Array<Pick<ViewerContext, "availableMinutes" | "availableNow">> = [
  {},
  { availableMinutes: null },
  { availableMinutes: 0 },
  { availableMinutes: 1 },
  { availableMinutes: 45 },
  { availableMinutes: 90 },
  { availableMinutes: 100_000 },
  { availableMinutes: -30 },
  { availableNow: true },
  { availableNow: false },
  { availableMinutes: 60, availableNow: true },
];

const fingerprint = (xs: ReturnType<typeof rankCandidates>) =>
  xs.map((s) => ({ id: s.candidate.id, score: s.score, features: s.features }));

describe("§57 A11 — Discovery never reaches the ranker's own free-time arithmetic", () => {
  it("P1 PROPERTY: for Discovery-shaped candidates, no free-time input changes a score, a feature or the order (400 seeded cases)", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = prng(seed);
      const n = 1 + Math.floor(rand() * 25);
      const cands = Array.from({ length: n }, (_, i) => discoveryCandidate(rand, i));
      const ctx = viewer(rand);
      const base = fingerprint(rankCandidates(cands, ctx));
      for (const extra of FREE_TIME) {
        const got = fingerprint(rankCandidates(cands, { ...ctx, ...extra }));
        assert.deepEqual(got, base, `seed ${seed}: free time ${JSON.stringify(extra)} changed a Discovery ranking`);
      }
      for (const s of rankCandidates(cands, { ...ctx, availableMinutes: 30, availableNow: true })) {
        assert.equal(s.features.availabilityFit, 0, `seed ${seed}: ${s.candidate.id} carried an availability fit`);
      }
    }
  });

  it("P2 CONTROL: a candidate that carries a start DOES move with availableMinutes — so P1 is not vacuous", () => {
    const timed: RankCandidate = { id: "event/1", kind: "event", startsAt: new Date(NOW + 30 * 60_000).toISOString() } as RankCandidate;
    const ctx: ViewerContext = { userId: "v", nowMs: NOW };
    assert.equal(availabilityFitScore(timed, { ...ctx, availableMinutes: 60 }, NOW), 1);
    assert.equal(availabilityFitScore(timed, { ...ctx, availableMinutes: 10 }, NOW), -0.5);
    assert.equal(availabilityFitScore({ id: "db/1", kind: "gem" } as RankCandidate, { ...ctx, availableMinutes: 10 }, NOW), 0,
      "a Discovery candidate (no start) answers 0 before either free-time field is read");
  });

  it("G1 SOURCE GUARD: the ONE Discovery module that builds a ranker context is lib/discoveryPde, and its context carries neither free-time field", () => {
    // Narrow on purpose. Other Discovery modules may say "availableMinutes" for
    // reasons of their own (a Layover budget is not the ranker's field); what
    // matters is whether a free-time value can reach `rankCandidates`. So the
    // guard pins WHO builds a ViewerContext, and WHAT that context carries.
    const dirs: Array<[string, RegExp]> = [
      [path.join(SRC, "lib"), /^(discovery|mapDiscovery).*\.ts$/],
      [path.join(SRC, "routes"), /^discovery.*\.ts$/],
    ];
    const files = dirs.flatMap(([dir, re]) => readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)));
    files.push(path.join(SRC, "services", "location", "DiscoveryLocationContext.ts"));
    files.push(path.join(SRC, "lib", "inputAssistance", "searchCandidates.ts")); // Discovery search's searchers (census-discovery §70)
    assert.ok(files.length > 20, "the Discovery file set must actually be scanned");
    const builders: string[] = [];
    for (const f of files) {
      const code = readFileSync(f, "utf8").split("\n")
        .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*\*.*$/, ""))
        .join("\n");
      if (/\brankCandidates\(|:\s*ViewerContext\b/.test(code)) builders.push(path.relative(SRC, f));
    }
    // Restated by census-discovery §78 (lane W10-R2): lib/discoveryRankDesigns.ts
    // MERGES the §78 design inputs onto the context discoveryPde builds, so it is
    // a second module that touches a ViewerContext. It is pinned here by name,
    // and below it is held to the same rule — it must never add a free-time field.
    assert.deepEqual(builders, [path.join("lib", "discoveryPde.ts"), path.join("lib", "discoveryRankDesigns.ts")], `another Discovery module builds a ranker context: ${builders.join(", ")}`);
    const designs = readFileSync(path.join(SRC, "lib", "discoveryRankDesigns.ts"), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "")).join("\n");
    assert.equal(/\bavailable(Minutes|Now)\b/.test(designs), false, "the §78 design hook hands the ranker a free-time input");

    const pde = readFileSync(path.join(SRC, "lib", "discoveryPde.ts"), "utf8");
    const at = pde.indexOf("const viewerContext: ViewerContext = {");
    assert.ok(at > 0, "discoveryPde's ranker context moved — re-point this guard, do not delete it");
    const block = pde.slice(at, pde.indexOf("\n  };", at));
    assert.ok(block.includes("interestTags:") && block.includes("seenIds:"), "the guard must be reading the context itself");
    assert.equal(/\bavailable(Minutes|Now)\b/.test(block.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n")), false,
      "Discovery now hands the ranker a free-time input — A11's duplicate calculation is live on Discovery");
  });

  it("G2 SOURCE GUARD: lib/discoveryPde's candidate mapping carries no `startsAt` — the one field that would open the arithmetic", () => {
    const pde = readFileSync(path.join(SRC, "lib", "discoveryPde.ts"), "utf8");
    const start = pde.indexOf("const candidates: PlaceCandidate<T>[] = places.map(");
    assert.ok(start > 0, "the Discovery candidate mapping moved — re-point this guard, do not delete it");
    const end = pde.indexOf("}));", start);
    const block = pde.slice(start, end);
    assert.ok(block.includes("distanceKm:") && block.includes("category:"), "the guard must be reading the mapping itself");
    assert.equal(/\bstartsAt\b/.test(block), false, "a Discovery candidate now carries a start — A11's duplicate is reachable from Discovery");
  });
});

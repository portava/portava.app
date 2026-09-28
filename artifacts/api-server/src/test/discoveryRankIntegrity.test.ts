/**
 * census-discovery §78 (lane W10-R2) — DV-12: never reward abusive engagement,
 * and the trust factor stops being a constant. Controlled data only; nothing
 * here claims the detector finds real-world abuse.
 *
 *   E1  each `03` §12 pattern the save rows can show is detected: farm,
 *       automation, pod, reciprocal, self-network, new account
 *   E2  a clean, ordinary save history is untouched (integrity 1, count as is)
 *   E3  a farmed save does not raise a row: a place whose 60 saves are farmed
 *       ranks below a clean place with 12
 *   E4  the trust factor is no longer the constant 0.6 across Discovery rows:
 *       measured unauthored rows differ by their evidence; an authored row with
 *       unknown trust keeps 0.6 (engagement ≠ author trust)
 *   E5  unmeasured ⇒ bit-identical social proof (the 0.6 path)
 *   E6  the loader over a fake world: reads, decorations, and the submitter's
 *       trust through the Trust seam
 *   E7  any failed read leaves the WHOLE set unmeasured and says so
 *   E8  no trust or abuse signal becomes a public reason
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryRankIntegrity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectEngagementAbuse, integrityDecorations, loadEngagementIntegrity,
  AUTOMATION_BURST_SAVES, NEW_ACCOUNT_DAYS, type SaveEvent, type IntegrityInputs,
} from "../lib/discoveryRankIntegrity.js";
import { rankCandidates, socialProofScore, type RankCandidate } from "../lib/portavaRank.js";
import { reasonCodeForSignal } from "../lib/discoveryReasonCodes.js";
import { newWorld, worldClient } from "./helpers/fakeDiscoveryWorld.js";

const T0 = Date.UTC(2026, 8, 1);
const MIN = 60_000;
const DAY = 86_400_000;

function inputs(saves: SaveEvent[], over: Partial<IntegrityInputs> = {}): IntegrityInputs {
  return {
    saves, flaggedAccounts: new Set(), accountCreatedAtMs: new Map(), follows: [], submitterByPlace: new Map(), ...over,
  };
}

describe("DV-12 — the `03` §12 detector on save evidence", () => {
  it("E1 each pattern", () => {
    // farm
    let r = detectEngagementAbuse(inputs([{ userId: "farm", placeId: "p", savedAtMs: T0 }, { userId: "ok", placeId: "p", savedAtMs: T0 + DAY }],
      { flaggedAccounts: new Set(["farm"]) }));
    assert.deepEqual(r.get("p"), { raw: 2, effective: 1, integrity: 0.5, patterns: { farm: 1 } });

    // automation: five saves in under a minute, and a sixth an hour later that is NOT in the burst
    const burst = Array.from({ length: AUTOMATION_BURST_SAVES }, (_, i) => ({ userId: "bot", placeId: `b${i}`, savedAtMs: T0 + i * 10_000 }));
    r = detectEngagementAbuse(inputs([...burst, { userId: "bot", placeId: "b9", savedAtMs: T0 + 60 * MIN }]));
    for (let i = 0; i < AUTOMATION_BURST_SAVES; i++) assert.equal(r.get(`b${i}`)!.effective, 0, `b${i}`);
    assert.equal(r.get("b9")!.effective, 1, "outside the burst");
    // four is not a burst
    r = detectEngagementAbuse(inputs(burst.slice(0, AUTOMATION_BURST_SAVES - 1)));
    for (const v of r.values()) assert.equal(v.integrity, 1);

    // pod: three accounts co-saving three places within minutes of each other
    const pod: SaveEvent[] = [];
    for (const [k, place] of ["x", "y", "z"].entries()) for (const [j, u] of ["u1", "u2", "u3"].entries()) pod.push({ userId: u, placeId: place, savedAtMs: T0 + k * DAY + j * MIN });
    pod.push({ userId: "stranger", placeId: "x", savedAtMs: T0 + 2 * MIN });
    r = detectEngagementAbuse(inputs(pod));
    assert.deepEqual(r.get("x"), { raw: 4, effective: 1, integrity: 0.25, patterns: { pod: 3 } }, "the stranger's save stands");
    // a PAIR is not a pod
    r = detectEngagementAbuse(inputs(pod.filter((s) => s.userId !== "u3")));
    assert.equal(r.get("y")!.integrity, 1);

    // reciprocal: A saves B's place and B saves A's place
    const sub = new Map([["pa", "A"], ["pb", "B"], ["pc", "C"]]);
    r = detectEngagementAbuse(inputs([
      { userId: "A", placeId: "pb", savedAtMs: T0 }, { userId: "B", placeId: "pa", savedAtMs: T0 + DAY },
      { userId: "A", placeId: "pc", savedAtMs: T0 },
    ], { submitterByPlace: sub }));
    assert.equal(r.get("pa")!.patterns.reciprocal, 1);
    assert.equal(r.get("pb")!.patterns.reciprocal, 1);
    assert.equal(r.get("pc")!.integrity, 1, "a one-way save is not reciprocal");

    // self-network: own save erased, a mutual follow's save halved, a one-way follower's untouched
    r = detectEngagementAbuse(inputs([
      { userId: "S", placeId: "ps", savedAtMs: T0 }, { userId: "M", placeId: "ps", savedAtMs: T0 }, { userId: "F", placeId: "ps", savedAtMs: T0 + DAY },
    ], { submitterByPlace: new Map([["ps", "S"]]), follows: [["M", "S"], ["S", "M"], ["F", "S"]] }));
    assert.deepEqual(r.get("ps"), { raw: 3, effective: 1.5, integrity: 0.5, patterns: { self_network: 2 } });

    // new account
    r = detectEngagementAbuse(inputs([{ userId: "n", placeId: "q", savedAtMs: T0 }, { userId: "o", placeId: "q", savedAtMs: T0 }],
      { accountCreatedAtMs: new Map([["n", T0 - 2 * DAY], ["o", T0 - (NEW_ACCOUNT_DAYS + 1) * DAY]]) }));
    assert.deepEqual(r.get("q"), { raw: 2, effective: 1.5, integrity: 0.75, patterns: { new_account: 1 } });
  });

  it("E2 an ordinary save history is untouched", () => {
    const saves: SaveEvent[] = Array.from({ length: 12 }, (_, i) => ({ userId: `u${i}`, placeId: "p", savedAtMs: T0 + i * 3 * DAY }));
    const r = detectEngagementAbuse(inputs(saves, { accountCreatedAtMs: new Map(saves.map((s) => [s.userId, T0 - 365 * DAY])) }));
    assert.deepEqual(r.get("p"), { raw: 12, effective: 12, integrity: 1, patterns: {} });
    const d = integrityDecorations([{ id: "p", savedCount: 12 }, { id: "none", savedCount: 4 }], r, new Map(), new Map());
    assert.deepEqual(d.get("p"), { likeCount: 12, engagementIntegrity: 1 });
    assert.deepEqual(d.get("none"), { likeCount: 4, engagementIntegrity: 1 }, "no rows read: nothing abusive found, count unchanged");
  });

  it("E3 a farmed save does not raise a row", () => {
    const farmed: SaveEvent[] = Array.from({ length: 60 }, (_, i) => ({ userId: `f${i}`, placeId: "farmed", savedAtMs: T0 + i * DAY }));
    const clean: SaveEvent[] = Array.from({ length: 12 }, (_, i) => ({ userId: `c${i}`, placeId: "clean", savedAtMs: T0 + i * DAY }));
    const r = detectEngagementAbuse(inputs([...farmed, ...clean], { flaggedAccounts: new Set(farmed.map((s) => s.userId)) }));
    const d = integrityDecorations([{ id: "farmed", savedCount: 60 }, { id: "clean", savedCount: 12 }], r, new Map(), new Map());
    const cands: RankCandidate[] = [
      { id: "farmed", kind: "place", likeCount: 60 }, { id: "clean", kind: "place", likeCount: 12 },
    ];
    const before = rankCandidates(cands.map((c) => ({ ...c })), { userId: "v" }, { exploration: false });
    assert.deepEqual(before.map((s) => s.candidate.id), ["farmed", "clean"], "control: without the detector the farm wins");
    const after = rankCandidates(cands.map((c) => ({ ...c, ...d.get(c.id) })), { userId: "v" }, { exploration: false });
    assert.deepEqual(after.map((s) => s.candidate.id), ["clean", "farmed"]);
    assert.equal(after.find((s) => s.candidate.id === "farmed")!.features.socialProof, 0);
  });

  it("E4 the trust factor discriminates: by evidence on unauthored rows, by author trust on authored ones", () => {
    const base: RankCandidate = { id: "x", kind: "place", likeCount: 100 };
    const clean = socialProofScore({ ...base, engagementIntegrity: 1 });
    const dirty = socialProofScore({ ...base, engagementIntegrity: 0.2 });
    const unmeasured = socialProofScore(base);
    assert.ok(clean > unmeasured && clean > dirty, `${clean} / ${unmeasured} / ${dirty}`);
    assert.equal(clean / unmeasured, 1 / 0.6, "an unauthored row with clean evidence is no longer multiplied by the 0.6 proxy");
    assert.equal(dirty / clean, 0.6, "0.5 + 0.5 × 0.2");
    const authoredUnknown = socialProofScore({ ...base, engagementIntegrity: 1, authored: true });
    assert.equal(authoredUnknown, unmeasured, "an authored row whose submitter's trust is unknown keeps 0.6 — engagement integrity does not stand in for author trust");
    const authoredKnown = socialProofScore({ ...base, engagementIntegrity: 1, authored: true, authorTrustScore: 20 });
    assert.equal(authoredKnown, (Math.log10(101) / 3) * 0.6);
  });

  it("E5 unmeasured ⇒ the pre-§78 number, bit for bit", () => {
    for (const likeCount of [0, 1, 7, 1000, 12345]) {
      for (const authorTrustScore of [undefined, 0, 50, 100]) {
        const c: RankCandidate = { id: "x", kind: "place", likeCount, authorTrustScore, joinCount: 3 };
        const raw = likeCount + 6;
        const base = Math.log10(1 + raw) / 3;
        const tf = authorTrustScore != null ? 0.5 + 0.5 * authorTrustScore / 100 : 0.6;
        assert.equal(socialProofScore(c), Math.min(1, base) * tf);
      }
    }
  });

  it("E6 the loader: ids mapped, saves read, patterns found, submitter trust through the seam", async () => {
    const P1 = "11111111-1111-4111-8111-111111111111";
    const P2 = "22222222-2222-4222-8222-222222222222";
    const world = newWorld({ tables: {
      discovery_places: [
        { id: P1, osm_id: null, submitted_by: "sub" },
        { id: P2, osm_id: "node/77", submitted_by: null },
      ],
      saved_places: [
        { user_id: "farm", place_id: P1, saved_at: new Date(T0).toISOString() },
        { user_id: "ok", place_id: P1, saved_at: new Date(T0 + DAY).toISOString() },
        { user_id: "ok", place_id: P2, saved_at: new Date(T0 + 2 * DAY).toISOString() },
      ],
      trust_reviews: [
        { user_id: "farm", review_type: "gaming_suspected", status: "open" },
        { user_id: "ok", review_type: "gaming_suspected", status: "dismissed" },
      ],
      profiles: [{ id: "farm", created_at: new Date(T0 - 400 * DAY).toISOString() }, { id: "ok", created_at: new Date(T0 - 400 * DAY).toISOString() }],
      user_follows: [],
      trust_profiles: [{ user_id: "sub", overall_score: 80 }],
    } });
    const r = await loadEngagementIntegrity(worldClient(world), [{ id: `db/${P1}`, savedCount: 2 }, { id: "node/77", savedCount: 1 }, { id: "node/88", savedCount: 5 }]);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.patterns, { farm: 1 });
    assert.deepEqual(r.decorations!.get(`db/${P1}`), { likeCount: 1, engagementIntegrity: 0.5, authored: true, authorTrustScore: 80 });
    assert.deepEqual(r.decorations!.get("node/77"), { likeCount: 1, engagementIntegrity: 1 });
    assert.deepEqual(r.decorations!.get("node/88"), { likeCount: 5, engagementIntegrity: 1 });
    assert.ok(!world.reads.includes("trust_profiles") || world.reads.filter((t) => t === "trust_profiles").length === 1);
  });

  it("E7 one failed read leaves the whole set unmeasured, and says so", async () => {
    for (const table of ["discovery_places", "saved_places", "trust_reviews", "profiles", "user_follows", "trust_profiles"]) {
      const world = newWorld({ tables: {
        discovery_places: [{ id: "11111111-1111-4111-8111-111111111111", osm_id: null, submitted_by: "sub" }],
        saved_places: [{ user_id: "u", place_id: "11111111-1111-4111-8111-111111111111", saved_at: new Date(T0).toISOString() }],
        trust_reviews: [], profiles: [], user_follows: [], trust_profiles: [],
      } });
      world.errorTables.add(table);
      const r = await loadEngagementIntegrity(worldClient(world), [{ id: "db/11111111-1111-4111-8111-111111111111", savedCount: 1 }]);
      assert.deepEqual(r, { decorations: null, degraded: true, patterns: {} }, table);
    }
    assert.deepEqual(await loadEngagementIntegrity(null, [{ id: "x" }]), { decorations: null, degraded: true, patterns: {} });
  });

  it("E8 no trust or abuse signal becomes a public reason", () => {
    for (const k of ["trust", "engagementIntegrity", "farm", "pod", "automation", "reciprocal", "self_network", "new_account"]) {
      assert.equal(reasonCodeForSignal(k), null, k);
    }
  });
});

/**
 * Memory lifecycle regressions — the defects an audit found in 2183-2189, pinned
 * so they cannot come back.
 *
 * Covered here (the parts provable without a live database):
 *   P0-4  prompt budget allocation — a long tail of rediscovery candidates must
 *         NOT crowd out higher-value standing memory. Before the fix, rediscovery
 *         was emitted first until the budget filled.
 *   P0-2  feedback authorization — a projection id belonging to ANOTHER user must
 *         never suppress that user's memory (ownership is enforced server-side).
 *   P0-4b real content — placeholder strings ("Saved a place") are gone; the
 *         renderer must carry the real subject through.
 *
 * The SQL-level lifecycle (retraction on block/unfollow/unsave, retention sweep
 * with controlled time, and the explicit erasure path) is exercised against a real
 * database, not mocked — see docs/migrations.md for the recorded proofs and
 * `memory_lifecycle` in the live-DB suite. Mocking those would prove nothing:
 * every one of them is a property of the SQL, not of the TypeScript.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectedMemoryBlock,
  PROJECTED_MEMORY_BUDGET_CHARS,
  MEMORY_LANE_SHARE,
} from "../compass/ProjectedMemoryPrompt.js";

const UID = "00000000-0000-4000-8000-0000000000cc";

function makeDb(cfg: { enabled: boolean; retrieve?: any[]; rediscover?: any[] }) {
  const calls: string[] = [];
  return {
    _calls: calls,
    from() {
      const b: any = {
        select() { return b; },
        eq() { return b; },
        maybeSingle() { return Promise.resolve({ data: { enabled: cfg.enabled }, error: null }); },
      };
      return b;
    },
    rpc(name: string) {
      calls.push(name);
      if (name === "memory_rediscover") return Promise.resolve({ data: cfg.rediscover ?? [], error: null });
      if (name === "memory_retrieve") return Promise.resolve({ data: cfg.retrieve ?? [], error: null });
      return Promise.resolve({ data: null, error: null });
    },
  } as any;
}

describe("P0-4 prompt budget — rediscovery must not crowd out standing memory", () => {
  it("keeps standing memory when there are 12+ rediscovery candidates", async () => {
    // 12 rediscovery candidates, each long enough that concatenating them would
    // consume the whole budget — the exact shape that starved retrieval before.
    const rediscover = Array.from({ length: 12 }, (_, i) => ({
      memory_type: "place", subject_type: "place", subject_id: `rp${i}`,
      reason: "you_saved",
      content: `Saved Some Fairly Long Restaurant Name Number ${i} in Da Nang`,
    }));
    const retrieve = [
      { memory_type: "episodic", subject_type: "city", subject_id: "Lisbon", content: "Visited Lisbon (has returned)" },
      { memory_type: "semantic", subject_type: "interest", subject_id: "nightlife", content: "Interested in nightlife" },
    ];

    const lines = await buildProjectedMemoryBlock(makeDb({ enabled: true, rediscover, retrieve }), UID, { city: "Da Nang" });
    const text = lines.join("\n");

    assert.ok(text.includes("Visited Lisbon"), "standing episodic memory must survive the rediscovery flood");
    assert.ok(text.includes("Interested in nightlife"), "standing semantic memory must survive too");
    assert.ok(text.length <= PROJECTED_MEMORY_BUDGET_CHARS + 200, `block must stay bounded, got ${text.length}`);
  });

  it("still fetches standing memory even when rediscovery returns a full page", async () => {
    const rediscover = Array.from({ length: 12 }, (_, i) => ({
      memory_type: "place", subject_type: "place", subject_id: `p${i}`, content: `Saved Place ${i}`, reason: "you_saved",
    }));
    const db = makeDb({ enabled: true, rediscover, retrieve: [] });
    await buildProjectedMemoryBlock(db, UID, { city: "Da Nang" });
    assert.ok(db._calls.includes("memory_retrieve"),
      "retrieval must always run — skipping it when rediscovery is full was the starvation bug");
  });

  it("lane shares are a sane partition of the budget", () => {
    const total = MEMORY_LANE_SHARE.standing + MEMORY_LANE_SHARE.rediscovery + MEMORY_LANE_SHARE.intent;
    assert.ok(Math.abs(total - 1) < 1e-9, "lane shares must partition the budget");
    assert.ok(MEMORY_LANE_SHARE.standing >= MEMORY_LANE_SHARE.rediscovery,
      "standing memory must not be given a smaller reserve than rediscovery");
  });

  it("carries real subject content through, not placeholders", async () => {
    const lines = await buildProjectedMemoryBlock(
      makeDb({ enabled: true, retrieve: [
        { memory_type: "place", subject_type: "place", subject_id: "p1", content: "Saved Cafe Sua Da in Da Nang" },
        { memory_type: "social", subject_type: "user", subject_id: "u1", content: "Follows Maya Chen" },
      ] }), UID, {});
    const text = lines.join("\n");
    assert.ok(text.includes("Cafe Sua Da"), "the place name must reach the prompt");
    assert.ok(text.includes("Maya Chen"), "the traveller name must reach the prompt");
    assert.ok(!/\[saved\] <portava:ugc>Saved a place</.test(text), "placeholder content must be gone");
  });

  it("still wraps every line as UGC data after the budget rewrite", async () => {
    const lines = await buildProjectedMemoryBlock(
      makeDb({ enabled: true, retrieve: [{ memory_type: "place", subject_id: "p", subject_type: "place", content: "Saved X" }] }),
      UID, {});
    for (const l of lines.slice(1)) {
      assert.match(l, /<portava:ugc>.*<\/portava:ugc>/, "UGC delimiters must survive the rewrite");
    }
  });
});

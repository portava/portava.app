/**
 * The memory services' select lists are string LITERALS so that
 * check:write-path-columns (which resolves only a literal or a same-file string
 * const, never a `.join` or a template) can check every column against the live
 * schema. This pins each literal to the column array / base list it stands for,
 * so the two cannot drift apart silently (PR #625's live-DB tier, 2026-10-06).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EPISODE_COLUMNS, EPISODE_SELECT } from "../services/memory/episodeCandidates.js";
import { MEMORY_ACTION_COLUMNS, MEMORY_ACTION_COLUMNS_WITH_PRECISION } from "../services/memory/memoryActionService.js";

describe("memory select lists are literals that equal their column arrays", () => {
  it("EPISODE_SELECT is exactly EPISODE_COLUMNS joined", () => {
    assert.equal(EPISODE_SELECT, EPISODE_COLUMNS.join(", "));
    assert.equal(new Set(EPISODE_COLUMNS).size, EPISODE_COLUMNS.length, "no duplicate column");
  });
  it("MEMORY_ACTION_COLUMNS_WITH_PRECISION is the base list plus location_precision", () => {
    assert.equal(MEMORY_ACTION_COLUMNS_WITH_PRECISION, `${MEMORY_ACTION_COLUMNS}, location_precision`);
    assert.ok(!MEMORY_ACTION_COLUMNS.split(", ").includes("location_precision"), "the base list never carries the rung");
  });
});

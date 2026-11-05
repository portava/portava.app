/**
 * census-telegraph T370 (lane TELEGRAPH batch 3) — reactions are READ, so a client can show them.
 *
 * ADD_REACTION / REMOVE_REACTION wrote `message_reactions` and nothing read it. The thread read now
 * serves, per message, `reactions: [{ emoji, count, mine }]` (services/telegraph/platformReadDecorations.ts
 * decorateReactions, called by GET /threads/:id/messages). Pinned:
 *   - the aggregate: counts per emoji, most-used first, `mine` for the viewer's own, never WHO reacted;
 *   - a reaction by a person the viewer has blocked (either direction) is not counted;
 *   - the reactions table OR the block list unreadable → `reactions: null` (unavailable), never [];
 *   - kernel flag OFF (2811's gate, as on the command door) → nothing served at all;
 *   - a deleted message carries no reactions;
 *   - the read route calls it, after the platform decorations.
 *
 * MUTANTS (tgprod/mutants-b3.txt): RX1 blocked reactions counted; RX2 an unreadable read served as [];
 * RX3 the flag ignored; RX4 who-reacted leaked (user ids on the wire); RX5 the route never decorates.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphReactionsRead.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decorateReactions, REACTION_DISPLAY_LIMIT } from "../services/telegraph/platformReadDecorations.js";
import { makeFakeClient } from "./telegraphCertificationHarness.js";

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const BEA = "bbbbbbbb-0000-4000-8000-000000000002";
const CAL = "cccccccc-0000-4000-8000-000000000003"; // blocked by ME
const M1 = "11111111-0000-4000-8000-000000000001";
const M2 = "11111111-0000-4000-8000-000000000002";
const GONE = "11111111-0000-4000-8000-000000000003";

const r = (message_id: string, user_id: string, emoji: string, at: string) => ({ message_id, user_id, emoji, created_at: `2026-10-24T00:00:${at}.000Z` });

function world(over: { kernel?: boolean; reactions?: any[]; blocks?: any[] } = {}) {
  return {
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: over.kernel !== false }],
    message_reactions: over.reactions ?? [
      r(M1, BEA, "👍", "01"), r(M1, ME, "👍", "02"), r(M1, BEA, "❤️", "03"), r(M1, CAL, "😂", "04"), r(M1, CAL, "👍", "05"),
      r(M2, ME, "🙏", "06"), r(GONE, BEA, "👍", "07"),
    ],
    blocks: over.blocks ?? [{ blocker_id: ME, blocked_id: CAL }],
  };
}
const rows = () => [{ id: M1, deleted_at: null }, { id: M2, deleted_at: null }, { id: GONE, deleted_at: "2026-10-24T01:00:00.000Z" }];
const page = () => rows().map((x) => ({ id: x.id })) as Array<Record<string, any>>;

describe("T370 — the thread read serves reactions a client can draw", () => {
  it("counts per emoji, most-used first, `mine` marked, never who reacted; a blocked person is not counted", async () => {
    const msgs = page();
    await decorateReactions(makeFakeClient(world()) as any, rows(), msgs, ME);
    assert.deepEqual(msgs[0]!.reactions, [{ emoji: "👍", count: 2, mine: true }, { emoji: "❤️", count: 1, mine: false }]);
    assert.deepEqual(msgs[1]!.reactions, [{ emoji: "🙏", count: 1, mine: true }]);
    assert.equal(msgs[2]!.reactions, undefined, "a deleted message carries no reactions");
    assert.equal(JSON.stringify(msgs).includes(BEA), false, "no reactor id on the wire");
  });

  it("a message nobody reacted to carries an empty list (a real 'none')", async () => {
    const msgs = page();
    await decorateReactions(makeFakeClient(world({ reactions: [] })) as any, rows(), msgs, ME);
    assert.deepEqual(msgs[0]!.reactions, []);
  });

  it("the person who blocked the viewer is not counted either", async () => {
    const msgs = page();
    await decorateReactions(makeFakeClient(world({ blocks: [{ blocker_id: BEA, blocked_id: ME }] })) as any, rows(), msgs, ME);
    assert.deepEqual(msgs[0]!.reactions, [{ emoji: "👍", count: 2, mine: true }, { emoji: "😂", count: 1, mine: false }]);
  });

  for (const table of ["message_reactions", "blocks"]) {
    it(`${table} unreadable → reactions: null (unavailable), never [] and never a count`, async () => {
      const msgs = page();
      await decorateReactions(makeFakeClient(world(), { errors: { [table]: { code: "57014", message: "timeout" } } }) as any, rows(), msgs, ME);
      assert.equal(msgs[0]!.reactions, null);
      assert.equal(msgs[1]!.reactions, null);
    });
  }

  it("kernel flag OFF: nothing is read and nothing served", async () => {
    const msgs = page();
    const c = makeFakeClient(world({ kernel: false }));
    await decorateReactions(c as any, rows(), msgs, ME);
    assert.equal(msgs[0]!.reactions, undefined);
    assert.equal(c._observed.selects.some((s) => s.table === "message_reactions"), false);
  });

  it(`at most ${REACTION_DISPLAY_LIMIT} distinct emoji per message`, async () => {
    const many = Array.from({ length: 12 }, (_, i) => r(M1, BEA, `e${i}`, String(10 + i)));
    const msgs = page();
    await decorateReactions(makeFakeClient(world({ reactions: many, blocks: [] })) as any, rows(), msgs, ME);
    assert.equal(msgs[0]!.reactions.length, REACTION_DISPLAY_LIMIT);
  });

  it("GET /threads/:id/messages decorates the page with reactions, as the viewer", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../routes/messaging.ts"), "utf8");
    assert.match(src, /await decoratePlatformReads\([^;]*\); await decorateReactions\(sc, rows, messages as Array<Record<string, any>>, user\.id, req\.log\);/);
  });
});

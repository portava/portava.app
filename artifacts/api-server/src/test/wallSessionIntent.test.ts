/**
 * WallSessionIntentService — temporary typed intent (spec §17). Proves mode
 * detection + keyword extraction (with entity resolution disabled by passing
 * sc = null), and the set / get / clear persistence round-trip against a fake
 * single-row store. The intent is always session-scoped and never a saved
 * preference.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseIntent,
  getStoredIntent,
  setStoredIntent,
  clearStoredIntent,
} from "../services/wall/WallSessionIntentService.js";
import type { StructuredIntent } from "../lib/wallProjection.js";

describe("WallSessionIntentService.parseIntent", () => {
  it("extracts mode phrases and keeps residual keywords (no entity resolution)", async () => {
    // sc = null ⇒ the Global Input Intelligence entity resolution is skipped, so
    // only mode-phrase detection + keyword extraction run.
    const intent = await parseIntent(null, "u1", "just friends random Bangkok food");
    const modes = intent.filters.filter((f) => f.kind === "mode").map((f) => f.value);
    assert.ok(modes.includes("just_friends"));
    assert.ok(modes.includes("random"));
    assert.equal(intent.sessionScoped, true);
    // "just friends" / "random" are consumed as modes and do not leak into keywords.
    assert.ok(!intent.keywords.includes("just"));
    assert.ok(!intent.keywords.includes("random"));
    assert.ok(intent.keywords.includes("bangkok"));
    assert.ok(intent.keywords.includes("food"));
  });

  it("returns a keyword-only intent for a plain phrase", async () => {
    const intent = await parseIntent(null, "u1", "funny travel stories");
    assert.equal(intent.filters.length, 0);
    assert.deepEqual(intent.keywords, ["funny", "travel", "stories"]);
  });

  it("returns an empty intent for empty text", async () => {
    const intent = await parseIntent(null, "u1", "   ");
    assert.deepEqual(intent.filters, []);
    assert.deepEqual(intent.keywords, []);
    assert.equal(intent.sessionScoped, true);
  });
});

/** Fake single-row wall_session_intents store. */
function intentStore() {
  let stored: StructuredIntent | null = null;
  let deleteCalls = 0;
  const sc: any = {
    from(_table: string) {
      const b: any = {
        select() {
          return b;
        },
        eq() {
          return b;
        },
        maybeSingle() {
          return Promise.resolve({
            data: stored ? { structured_intent: stored } : null,
            error: null,
          });
        },
        upsert(row: any) {
          stored = row.structured_intent as StructuredIntent;
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq() {
              deleteCalls++;
              stored = null;
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return b;
    },
  };
  return { sc, deleteCalls: () => deleteCalls, current: () => stored };
}

describe("WallSessionIntentService persistence", () => {
  it("sets, reads back, then clears the session intent", async () => {
    const store = intentStore();
    assert.equal(await getStoredIntent(store.sc, "u1"), null, "no intent initially");

    const intent = await parseIntent(null, "u1", "just friends");
    const ok = await setStoredIntent(store.sc, "u1", intent, "just friends");
    assert.equal(ok, true);

    const got = await getStoredIntent(store.sc, "u1");
    assert.ok(got);
    assert.deepEqual(
      got!.filters.map((f) => f.value),
      intent.filters.map((f) => f.value),
    );
    assert.equal(got!.sessionScoped, true);

    const cleared = await clearStoredIntent(store.sc, "u1");
    assert.equal(cleared, true);
    assert.equal(store.deleteCalls(), 1);
    assert.equal(await getStoredIntent(store.sc, "u1"), null, "cleared intent restores empty state");
  });

  it("fail-soft: a store error returns false / null rather than throwing", async () => {
    const failing: any = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          maybeSingle() {
            return Promise.resolve({ data: null, error: { message: "db down" } });
          },
          upsert() {
            return Promise.resolve({ error: { message: "db down" } });
          },
          delete() {
            return { eq: () => Promise.resolve({ error: { message: "db down" } }) };
          },
        };
      },
    };
    const intent = await parseIntent(null, "u1", "random");
    assert.equal(await setStoredIntent(failing, "u1", intent, "random"), false);
    assert.equal(await getStoredIntent(failing, "u1"), null);
    assert.equal(await clearStoredIntent(failing, "u1"), false);
  });
});

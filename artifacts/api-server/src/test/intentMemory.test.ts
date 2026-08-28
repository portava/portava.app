/**
 * Intent memory (spec §5.5, §9) — the request-time producer for layer L5.
 *
 * Proves: the classifier is deterministic and specific-beats-broad; no intent is
 * invented from a question that expresses none; capture is flag-gated at the SQL
 * boundary and fire-and-forget (never throws); the raw question never becomes the
 * stored content (only a derived label); and the caller cannot smuggle a durable
 * retention class or unbounded TTL through the call (§24) — the params sent are
 * always the ephemeral, TTL-bounded shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyIntent,
  recordIntentFromQuery,
  INTENT_TTL_MINUTES,
} from "../lib/intentMemory.js";

const UID = "00000000-0000-4000-8000-0000000000bb";

function makeDb(cfg: { ok?: boolean; error?: boolean; throws?: boolean } = {}) {
  const calls: Array<{ name: string; params: any }> = [];
  const db: any = {
    rpc(name: string, params: any) {
      calls.push({ name, params });
      if (cfg.throws) throw new Error("boom");
      if (cfg.error) return Promise.resolve({ data: null, error: { message: "nope" } });
      return Promise.resolve({ data: cfg.ok ?? true, error: null });
    },
    _calls: calls,
  };
  return db;
}

describe("classifyIntent", () => {
  it("classifies the common travel intents", () => {
    assert.equal(classifyIntent("where should I go for drinks tonight?"), "nightlife");
    assert.equal(classifyIntent("I'm hungry, best seafood around?"), "food");
    assert.equal(classifyIntent("any good hiking nearby"), "outdoors");
    assert.equal(classifyIntent("is there a museum worth seeing"), "culture");
    assert.equal(classifyIntent("where can I get a massage"), "wellness");
    assert.equal(classifyIntent("how do i get to the airport"), "transit");
  });

  it("prefers the specific category over the broader one", () => {
    // "coffee" must not be swallowed by the broader food vocabulary
    assert.equal(classifyIntent("where's good coffee near me"), "coffee");
  });

  it("returns null when the question expresses no intent", () => {
    assert.equal(classifyIntent("who are you?"), null);
    assert.equal(classifyIntent(""), null);
    assert.equal(classifyIntent("   "), null);
    assert.equal(classifyIntent(null), null);
    assert.equal(classifyIntent(undefined), null);
  });

  it("is case-insensitive and deterministic", () => {
    assert.equal(classifyIntent("NIGHTLIFE?"), "nightlife");
    assert.equal(classifyIntent("nightlife?"), classifyIntent("NightLife?"));
  });
});

describe("recordIntentFromQuery", () => {
  it("sends the ephemeral, TTL-bounded shape (§9/§24 cannot be overridden by a caller)", async () => {
    const db = makeDb();
    const ok = await recordIntentFromQuery(db, UID, "where should I get drinks", { city: "Lisbon" });
    assert.equal(ok, true);
    assert.equal(db._calls.length, 1);
    const { name, params } = db._calls[0];
    assert.equal(name, "record_intent_memory");
    assert.equal(params.p_user_id, UID);
    assert.equal(params.p_intent_type, "nightlife");
    assert.equal(params.p_ttl_minutes, INTENT_TTL_MINUTES, "a bounded TTL is always sent");
    assert.equal(params.p_enforce_flag, true, "the flag gate is never bypassed from the ask path");
  });

  it("stores a derived label, never the raw question", async () => {
    const db = makeDb();
    const raw = "my email is a@b.com, where should I get drinks in Lisbon";
    await recordIntentFromQuery(db, UID, raw, { city: "Lisbon" });
    const content = db._calls[0].params.p_content as string;
    assert.equal(content, "Looking for nightlife in Lisbon");
    assert.ok(!content.includes("a@b.com"), "raw question detail must not reach stored memory");
  });

  it("omits the city cleanly when unknown", async () => {
    const db = makeDb();
    await recordIntentFromQuery(db, UID, "hungry", {});
    assert.equal(db._calls[0].params.p_content, "Looking for food");
  });

  it("no intent in the question → no RPC at all", async () => {
    const db = makeDb();
    const ok = await recordIntentFromQuery(db, UID, "who are you?");
    assert.equal(ok, false);
    assert.deepEqual(db._calls, []);
  });

  it("an RPC error is swallowed → false, never throws", async () => {
    const db = makeDb({ error: true });
    assert.equal(await recordIntentFromQuery(db, UID, "drinks?"), false);
  });

  it("a thrown client error is swallowed → false, never throws", async () => {
    const db = makeDb({ throws: true });
    assert.equal(await recordIntentFromQuery(db, UID, "drinks?"), false);
  });

  it("flag off at the SQL boundary (data=false) → reports false", async () => {
    const db = makeDb({ ok: false });
    assert.equal(await recordIntentFromQuery(db, UID, "drinks?"), false);
  });
});

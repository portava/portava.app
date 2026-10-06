/**
 * Telegraph §2.3 — the NOW layer is ACTIVE coordination, bounded in time, so a
 * client that draws the partition can never hide an old message (above all an
 * old SAFETY message) from the conversation stream.
 *
 * Pure: `projectSemanticLayers` over literal rows. The route serves exactly this
 * projection (`GET /threads/:id/layers`).
 *
 * Run: node --import tsx/esm --test src/test/telegraphLayersNowBound.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NOW_LAYER_WINDOW_MINUTES,
  nowItemIsCurrent,
  projectSemanticLayers,
  type LayerInputRow,
} from "../services/telegraph/layers.js";

const NOW = Date.parse("2026-10-05T20:00:00.000Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ahead = (min: number) => new Date(NOW + min * 60_000).toISOString();
const A = "aaaaaaaa-0000-4000-8000-000000000001";

const kind = (id: string, k: string, payload: unknown, created_at: string): LayerInputRow => ({
  id, sender_id: A, created_at, msg_type: k.toLowerCase(), subtype: null,
  body: JSON.stringify({ kind: k, envelopeVersion: "1", payload }),
});
const safety = (id: string, created_at: string) => kind(id, "SAFETY", { kind: "need_help", label: "Need help" }, created_at);
const quick = (id: string, created_at: string) => kind(id, "COORDINATION", { state: "ON_MY_WAY" }, created_at);
const location = (id: string, created_at: string, expiresAt?: string) =>
  kind(id, "LOCATION", { label: "Pier 2", precision: "area", ...(expiresAt ? { expiresAt } : {}) }, created_at);

function layers(rows: LayerInputRow[]) {
  const p = projectSemanticLayers({ threadId: "t", viewerId: A, rows, nowMs: NOW });
  return { now: p.now.map((i) => i.messageId), talk: p.talk, plan: p.plan.map((i) => i.messageId) };
}

describe("§2.3 NOW is bounded in time — an old message is never lifted out of the stream", () => {
  it("THE POINT: a SAFETY message from three hours ago is in TALK, not NOW", () => {
    const r = layers([safety("s-old", ago(180))]);
    assert.deepEqual(r.now, []);
    assert.deepEqual(r.talk, ["s-old"]);
  });

  it("a SAFETY message sent inside the window is NOW", () => {
    assert.deepEqual(layers([safety("s-new", ago(5))]).now, ["s-new"]);
  });

  it("the boundary is NOW_LAYER_WINDOW_MINUTES: just inside is NOW, just outside is TALK", () => {
    assert.deepEqual(layers([quick("q-in", ago(NOW_LAYER_WINDOW_MINUTES - 1))]).now, ["q-in"]);
    assert.deepEqual(layers([quick("q-out", ago(NOW_LAYER_WINDOW_MINUTES + 1))]).talk, ["q-out"]);
  });

  it("a scoped LOCATION share is NOW while it is live, however long ago it started", () => {
    assert.deepEqual(layers([location("l-live", ago(240), ahead(30))]).now, ["l-live"]);
  });

  it("an expired LOCATION share is TALK even if it was sent a minute ago", () => {
    assert.deepEqual(layers([location("l-done", ago(1), ago(0.5))]).talk, ["l-done"]);
  });

  it("a LOCATION pin (no expiry) follows the ordinary window", () => {
    assert.deepEqual(layers([location("pin-old", ago(120))]).talk, ["pin-old"]);
    assert.deepEqual(layers([location("pin-new", ago(10))]).now, ["pin-new"]);
  });

  it("an unparseable send time is treated as OLD — the stream keeps the message", () => {
    assert.deepEqual(layers([safety("s-bad", "not-a-date")]).talk, ["s-bad"]);
    assert.equal(nowItemIsCurrent("not-a-date", "SAFETY", null, NOW), false);
  });

  it("the partition still holds: every message in exactly one layer", () => {
    const rows = [safety("s-old", ago(180)), safety("s-new", ago(5)), quick("q", ago(2)), location("l", ago(240), ahead(30))];
    const r = layers(rows);
    const all = [...r.now, ...r.talk, ...r.plan].sort();
    assert.deepEqual(all, rows.map((x) => x.id).sort());
    assert.equal(new Set(all).size, rows.length);
  });
});

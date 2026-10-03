/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; sweep SW30): GET /events/:id serves the viewer's own saved state,
 * measured, or says it could not read it.
 *
 * The event screen drew its bookmark from `isSaved` on GET /events/:id, which the route never served: `!!undefined`, so
 * every event the viewer had saved was drawn "not saved" on its own screen. The route now measures it with the events
 * lists' read (`viewerSavedEventIds`: event_saves and the viewer's event collections); a failed read serves
 * `isSaved: null` and names `event_saves` beside the other reads it names, and the rest of the event is served whole.
 *
 *   ED0 saved → isSaved true, nothing named
 *   ED1 the event_saves read FAILS → 200, isSaved null, `event_saves` named
 *   ED2 CONTROL: not saved → isSaved false, nothing named
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, VIEWER, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

async function get(saved: boolean, fail = false) {
  world({ ev: { state: "open", visibility: "public" }, extra: { event_saves: saved ? [{ user_id: VIEWER, event_id: EVENT, saved_at: "2026-09-01T00:00:00Z" }] : [], collections: [], collection_items: [] }, rsvps: [], failOn: fail ? (c: any) => (c.table === "event_saves" ? ERR : null) : undefined });
  const s = await eventsServer();
  try { const r = await s.req("t-viewer", "GET", `/events/${EVENT}`); return { status: r.status, isSaved: r.body?.isSaved, failedSources: r.body?.failedSources ?? null, text: r.text }; } finally { s.close(); }
}

describe("census-discovery §122 (SW30): GET /events/:id serves the viewer's saved state, or names the read", () => {
  after(() => _setTestClient(null as any, false));
  it("ED0 saved → isSaved true, nothing named", async () => {
    const r = await get(true);
    assert.deepEqual({ status: r.status, isSaved: r.isSaved, failedSources: r.failedSources }, { status: 200, isSaved: true, failedSources: null }, r.text);
  });
  it("ED1 the event_saves read FAILS → isSaved null, event_saves named", async () => {
    const r = await get(true, true);
    assert.deepEqual({ status: r.status, isSaved: r.isSaved, failedSources: r.failedSources }, { status: 200, isSaved: null, failedSources: ["event_saves"] }, r.text);
  });
  it("ED2 CONTROL: not saved → isSaved false, nothing named", async () => {
    const r = await get(false);
    assert.deepEqual({ status: r.status, isSaved: r.isSaved, failedSources: r.failedSources }, { status: 200, isSaved: false, failedSources: null }, r.text);
  });
});

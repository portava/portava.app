/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B35): every events list that feeds the events tab serves
 * the viewer's own saved state, measured from the store the tab's bookmark writes, or refuses.
 *
 * The events tab drew every bookmark from `savedIds`, page 1 of GET /events/saved, kept over a failed read (B35). Its
 * fix draws each card's `isSaved` from the list body. That needs every list to measure it from `event_saves`, the store
 * the bookmark toggles (POST/DELETE /events/:id/save): GET /events read only event collections, and /following,
 * /circles and /me served no saved state at all. GET /events now counts `event_saves` beside the collections it already
 * read; /following, /circles and /me measure both and refuse (503) when either read fails, as each already refuses over
 * the viewer's own RSVP (§118 B28, §119 B33); /saved lists only saved events, each `isSaved: true`.
 *
 *   SS0 GET /events: the event is in event_saves → isSaved true
 *   SS1 GET /events: the event_saves read FAILS → 503, never `isSaved: false`
 *   SF0/SC0/SM0 /following, /circles, /me: saved → isSaved true; SF1/SC1/SM1 the event_saves read FAILS → 503
 *   SV0 /saved: every listed event isSaved true
 *   SK0 /following: the event is in one of the viewer's collections → isSaved true; SK1/SK2 the collections /
 *       collection_items read FAILS → 503 (the helper reads both stores); SK3 the event_saves read THROWS → 503
 *   SN  CONTROL on GET /events, /following, /circles, /me: not saved → isSaved false
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, HOST, VIEWER, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const SAVE = { user_id: VIEWER, event_id: EVENT, saved_at: "2026-09-01T00:00:00Z" };
const extra = (saved: boolean) => ({ user_follows: [{ follower_id: VIEWER, following_id: HOST }], circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "active" }], event_saves: saved ? [SAVE] : [], collections: [], collection_items: [] });
function throwingBuilder(): any {
  const b: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? (_res: unknown, rej: (e: Error) => void) => rej(new Error("socket hang up")) : () => b) });
  return b;
}
async function get(path: string, saved: boolean, failSaves: boolean | string = false, more: Record<string, any[]> = {}, throwTable?: string) {
  const failTable = failSaves === true ? "event_saves" : failSaves || null;
  const w = world({ ev: { state: "open", circle_id: HOST, starts_at: "2030-01-05T18:00:00.000Z" }, extra: { ...extra(saved), ...more }, rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }], failOn: failTable ? (c: any) => (c.table === failTable ? ERR : null) : undefined });
  if (throwTable) { const from = w.client.from.bind(w.client); w.client.from = (t: string) => (t === throwTable ? throwingBuilder() : from(t)); }
  const s = await eventsServer();
  try { const r = await s.req("t-viewer", "GET", path); const ev = (r.body?.events ?? []).find((e: any) => e.id === EVENT); return { status: r.status, listed: Boolean(ev), isSaved: ev ? ev.isSaved : "(not listed)", text: r.text }; } finally { s.close(); }
}
const LISTS = [["GET /events", "/events?limit=10"], ["/following", "/events/following"], ["/circles", "/events/circles"], ["/me", "/events/me"]] as const;

describe("census-discovery §122 (B35): the events lists serve the viewer's measured saved state, or refuse", () => {
  after(() => _setTestClient(null as any, false));
  for (const [name, path] of LISTS) {
    it(`${name}: saved in event_saves → isSaved true`, async () => {
      const r = await get(path, true);
      assert.deepEqual({ status: r.status, listed: r.listed, isSaved: r.isSaved }, { status: 200, listed: true, isSaved: true }, r.text);
    });
    it(`${name}: the event_saves read FAILS → 503, never isSaved false`, async () => {
      const r = await get(path, true, true);
      assert.equal(r.status, 503, r.text);
    });
    it(`SN CONTROL ${name}: not saved → isSaved false`, async () => {
      const r = await get(path, false);
      assert.deepEqual({ status: r.status, listed: r.listed, isSaved: r.isSaved }, { status: 200, listed: true, isSaved: false }, r.text);
    });
  }
  it("SV0 /saved: every listed event isSaved true", async () => {
    const r = await get("/events/saved", true);
    assert.deepEqual({ status: r.status, listed: r.listed, isSaved: r.isSaved }, { status: 200, listed: true, isSaved: true }, r.text);
  });
  const COL = "77777777-7777-4777-8777-777777777777";
  const inCollection = { collections: [{ id: COL, owner_id: VIEWER }], collection_items: [{ collection_id: COL, entity_type: "event", entity_id: EVENT }] };
  it("SK0 /following: in one of the viewer's collections → isSaved true", async () => {
    const r = await get("/events/following", false, false, inCollection);
    assert.deepEqual({ status: r.status, listed: r.listed, isSaved: r.isSaved }, { status: 200, listed: true, isSaved: true }, r.text);
  });
  it("SK1 /following: the collections read FAILS → 503", async () => {
    const r = await get("/events/following", false, "collections", inCollection);
    assert.equal(r.status, 503, r.text);
  });
  it("SK2 /following: the collection_items read FAILS → 503", async () => {
    const r = await get("/events/following", false, "collection_items", inCollection);
    assert.equal(r.status, 503, r.text);
  });
  it("SK3 /following: the event_saves read THROWS → 503", async () => {
    const r = await get("/events/following", true, false, {}, "event_saves");
    assert.equal(r.status, 503, r.text);
  });
});

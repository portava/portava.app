/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B36): GET /discovery/community never serves the viewer's
 * own saved state over a failed read as measured.
 *
 * The route read the viewer's `collections` and then `collection_items` with no error bound, inside
 * `try { … } catch { /* non-fatal *\/ }`, and served `isSaved: savedPlaceIds.has(i.id)`: `false` on every card ("you saved
 * none of these") although the read never answered. The cards are still served (the save state decides nothing shown),
 * but `isSaved` is now `null` on every card and the read that failed is named in the body's `failedSources`.
 *
 *   CS0 CONTROL: the viewer saved p1 → isSaved true, nothing named
 *   CSU1 the collection_items read FAILS → p1 served, isSaved null, `collection_items` named
 *   CSU2 the collections read FAILS → p1 served, isSaved null, `collections` named
 *   CSU3 the collections read THROWS → p1 served, isSaved null, `collections` named
 *   CS4 CONTROL: the viewer saved nothing → isSaved false, nothing named
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import discoveryRouter, { _clearTestCompassCache } from "../routes/discovery.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { newWorld, worldClient, communityRow, profileRow, type WorldState } from "./helpers/fakeDiscoveryWorld.js";

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const VIEWER = "a1110000-0000-4000-8000-000000000001";
const SUB = "b1000000-0000-4000-8000-000000000001";
const P1 = "c1000000-0000-4000-8000-000000000001";
const COL = "d1000000-0000-4000-8000-000000000001";
function world(saved = true): WorldState {
  return newWorld({
    users: { "tok-viewer": VIEWER },
    tables: {
      feature_flags: [],
      discovery_places: [communityRow(P1, { submitted_by: SUB })],
      profiles: [profileRow(VIEWER), profileRow(SUB)],
      collections: [{ id: COL, owner_id: VIEWER }],
      collection_items: saved ? [{ collection_id: COL, entity_type: "place", entity_id: P1 }] : [],
      user_follows: [], blocks: [], user_mutes: [], profile_privacy_settings: [], identity_verifications: [], rank_events: [],
    },
  });
}
/** A builder whose every call chains and whose await rejects, as a dropped socket does. */
function throwingBuilder(): any {
  const b: any = new Proxy(function () {}, {
    get: (_t, k) => (k === "then" ? (_res: unknown, rej: (e: Error) => void) => rej(new Error("socket hang up")) : () => b),
  });
  return b;
}
function use(w: WorldState, throwTable?: string) {
  const c: any = worldClient(w);
  const client = throwTable ? { ...c, from: (t: string) => (t === throwTable ? throwingBuilder() : c.from(t)) } : c;
  _setTestServiceClient(client as any); _setTestClient(client as any, true);
}
let server: Server; let base = "";
before(async () => {
  server = createServer(express().use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); }).use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { globalThis.fetch = _originalFetch; _setTestServiceClient(null); _setTestClient(null as any, false); await new Promise<void>((r) => server.close(() => r())); });
async function served(opts: { failTable?: string; throwTable?: string; saved?: boolean } = {}) {
  _clearTestCompassCache?.();
  const w = world(opts.saved ?? true); if (opts.failTable) w.errorTables.add(opts.failTable); use(w, opts.throwTable);
  const res = await fetch(`${base}/discovery/community?city=Miami&limit=50`, { headers: { authorization: "Bearer tok-viewer" } });
  const body = await res.json() as any;
  const it = (body.items ?? []).find((i: any) => i.id === P1);
  return { status: res.status, listed: Boolean(it), isSaved: it ? it.isSaved : "(not listed)", failedSources: body.failedSources ?? null, refusal: body.refusal ?? null };
}

describe("census-discovery §122 (B36): GET /discovery/community never serves isSaved over a failed saved read", () => {
  it("CS0 CONTROL: the viewer saved p1 → isSaved true, nothing named", async () => {
    assert.deepEqual(await served(), { status: 200, listed: true, isSaved: true, failedSources: null, refusal: null });
  });
  it("CSU1 the collection_items read FAILS → p1 served, isSaved null, `collection_items` named", async () => {
    assert.deepEqual(await served({ failTable: "collection_items" }), { status: 200, listed: true, isSaved: null, failedSources: ["collection_items"], refusal: null });
  });
  it("CSU2 the collections read FAILS → p1 served, isSaved null, `collections` named", async () => {
    assert.deepEqual(await served({ failTable: "collections" }), { status: 200, listed: true, isSaved: null, failedSources: ["collections"], refusal: null });
  });
  it("CSU3 the collections read THROWS → p1 served, isSaved null, `collections` named", async () => {
    assert.deepEqual(await served({ throwTable: "collections" }), { status: 200, listed: true, isSaved: null, failedSources: ["collections"], refusal: null });
  });
  it("CS4 CONTROL: the viewer saved nothing → isSaved false, nothing named", async () => {
    assert.deepEqual(await served({ saved: false }), { status: 200, listed: true, isSaved: false, failedSources: null, refusal: null });
  });
});

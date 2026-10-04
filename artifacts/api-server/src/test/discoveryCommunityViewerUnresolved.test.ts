/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B42, probes CV1–CV3): GET
 * /discovery/community never serves a viewer whose token could not be RESOLVED as an anonymous one.
 *
 * The route resolved its optional viewer with `const { data } = await auth.getUser(token)` inside a comment-only catch:
 * a lookup that threw, or that Supabase Auth could not answer, left the viewer id null, exactly as for a caller with no
 * token. The signed-in viewer was then served as anonymous: their blocks and mutes were NOT applied, so a place
 * submitted by someone they blocked was served with that person's byline (a safety fail-open), and every card said
 * `isSaved: false`. §94.11 recorded the path as known; the round-23 verifier ruled it inside DV-83.
 *
 * A token that Auth REJECTED is still an anonymous caller (D-W11X2-21's one classifier, `authServiceUnreachable`). A
 * token nobody evaluated leaves the viewer UNRESOLVED: the author set is unknown, so authored rows are withheld
 * (fail-closed, as over an unreadable block set), every served card's `isSaved` is null, the body names `viewer`, and
 * the answer is the D11 envelope (`upstream_unavailable` / `community_viewer_unresolved`, `partial` or `nothing`).
 *
 *   CV0  CONTROL: the viewer resolves → the blocked submitter's place is withheld, the venue fact served and saved
 *   CV1  the lookup THROWS → the blocked submitter's place is NOT served; the venue fact is, `isSaved: null`; `viewer` named; partial
 *   CV2  Auth cannot answer (AuthRetryableFetchError, status 0) → the same
 *   CV3  Auth answers 503 → the same
 *   CV4  an error with no status and no known name → the same (D-W11X2-21: not a verdict)
 *   CV5  CONTROL: Auth REJECTS the token (401, `bad_jwt`) → an anonymous caller: both places, `isSaved: false`, nothing named
 *   CV6  CONTROL: no token → the same as CV5
 *   CV7  unresolved, and the city holds only venue facts → served whole with `isSaved: null` and `viewer` named, no refusal
 *   CV8  unresolved, and the city holds only authored rows → `nothing`, no items
 *   CV9  unresolved, `ageFilter=open_to_me` → never "your date of birth is missing"; `viewer` named, refused
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
const BLOCKED = "b1000000-0000-4000-8000-000000000001";
const AUTHORED = "c1000000-0000-4000-8000-000000000001";  // submitted by the person the viewer blocked
const VENUE = "c1000000-0000-4000-8000-000000000002";     // a venue fact: no submitter
const COL = "d1000000-0000-4000-8000-000000000001";

type Auth = "resolves" | "throws" | "unreachable" | "503" | "statusless" | "rejected";
function world(rows: "both" | "venue" | "authored" = "both"): WorldState {
  const places = [
    ...(rows !== "venue" ? [communityRow(AUTHORED, { submitted_by: BLOCKED })] : []),
    ...(rows !== "authored" ? [communityRow(VENUE)] : []),
  ];
  return newWorld({
    users: { "tok-viewer": VIEWER },
    tables: {
      feature_flags: [],
      discovery_places: places,
      profiles: [profileRow(VIEWER), profileRow(BLOCKED)],
      collections: [{ id: COL, owner_id: VIEWER }],
      collection_items: [{ collection_id: COL, entity_type: "place", entity_id: VENUE }],
      blocks: [{ blocker_id: VIEWER, blocked_id: BLOCKED }],
      user_follows: [], user_mutes: [], profile_privacy_settings: [], identity_verifications: [], rank_events: [],
    },
  });
}
function use(w: WorldState, auth: Auth) {
  const c: any = worldClient(w);
  const getUser = async (token: string) => {
    if (auth === "throws") throw new Error("socket hang up");
    if (auth === "unreachable") return { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } };
    if (auth === "503") return { data: { user: null }, error: { name: "AuthApiError", status: 503, message: "upstream unavailable" } };
    if (auth === "statusless") return { data: { user: null }, error: { message: "something went wrong" } };
    if (auth === "rejected") return { data: { user: null }, error: { name: "AuthApiError", status: 401, code: "bad_jwt", message: "invalid JWT" } };
    return c.auth.getUser(token);
  };
  const client = { ...c, auth: { getUser } };
  _setTestServiceClient(client as any); _setTestClient(client as any, true);
}
let server: Server; let base = "";
before(async () => {
  server = createServer(express().use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); }).use(discoveryRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { globalThis.fetch = _originalFetch; _setTestServiceClient(null); _setTestClient(null as any, false); await new Promise<void>((r) => server.close(() => r())); });

async function served(auth: Auth, opts: { rows?: "both" | "venue" | "authored"; token?: boolean; query?: string } = {}) {
  _clearTestCompassCache?.();
  use(world(opts.rows ?? "both"), auth);
  const res = await fetch(`${base}/discovery/community?city=Miami&limit=50${opts.query ?? ""}`, opts.token === false ? undefined : { headers: { authorization: "Bearer tok-viewer" } });
  const body = await res.json() as any;
  const item = (id: string) => (body.items ?? []).find((i: any) => i.id === id);
  return {
    status: res.status,
    authoredServed: Boolean(item(AUTHORED)),
    venueSaved: item(VENUE) ? item(VENUE).isSaved : "(not listed)",
    failedSources: body.failedSources ?? null,
    refusal: body.refusal ? { class: body.refusal.class, code: body.refusal.code, coverage: body.refusal.coverage, failedSources: body.refusal.failedSources ?? null } : null,
    body,
  };
}
const pick = (r: Awaited<ReturnType<typeof served>>) => ({ status: r.status, authoredServed: r.authoredServed, venueSaved: r.venueSaved, failedSources: r.failedSources, refusal: r.refusal });
const UNRESOLVED_PARTIAL = {
  status: 200, authoredServed: false, venueSaved: null, failedSources: ["viewer"],
  refusal: { class: "upstream_unavailable", code: "community_viewer_unresolved", coverage: "partial", failedSources: ["viewer"] },
};
const ANONYMOUS = { status: 200, authoredServed: true, venueSaved: false, failedSources: null, refusal: null };

describe("census-discovery §123 (B42): GET /discovery/community never serves an unresolved viewer as anonymous", () => {
  it("CV0 CONTROL: the viewer resolves → the blocked submitter's place is withheld, the venue fact served and saved", async () => {
    assert.deepEqual(pick(await served("resolves")), { status: 200, authoredServed: false, venueSaved: true, failedSources: null, refusal: null });
  });
  it("CV1 the lookup THROWS → the blocked submitter's place is not served, isSaved is null, `viewer` named, partial", async () => {
    assert.deepEqual(pick(await served("throws")), UNRESOLVED_PARTIAL);
  });
  it("CV2 Auth cannot answer (AuthRetryableFetchError) → the same", async () => {
    assert.deepEqual(pick(await served("unreachable")), UNRESOLVED_PARTIAL);
  });
  it("CV3 Auth answers 503 → the same", async () => {
    assert.deepEqual(pick(await served("503")), UNRESOLVED_PARTIAL);
  });
  it("CV4 an error with no status and no known name → the same (not a verdict on the token)", async () => {
    assert.deepEqual(pick(await served("statusless")), UNRESOLVED_PARTIAL);
  });
  it("CV5 CONTROL: Auth REJECTS the token (401 bad_jwt) → an anonymous caller, nothing named", async () => {
    assert.deepEqual(pick(await served("rejected")), ANONYMOUS);
  });
  it("CV6 CONTROL: no token → an anonymous caller, nothing named", async () => {
    assert.deepEqual(pick(await served("throws", { token: false })), ANONYMOUS);
  });
  it("CV7 unresolved over venue facts alone → served whole, isSaved null, `viewer` named, no refusal", async () => {
    assert.deepEqual(pick(await served("throws", { rows: "venue" })), { status: 200, authoredServed: false, venueSaved: null, failedSources: ["viewer"], refusal: null });
  });
  it("CV8 unresolved over authored rows alone → nothing, no items", async () => {
    const r = await served("throws", { rows: "authored" });
    assert.deepEqual(r.body.items, []);
    assert.deepEqual(r.refusal, { class: "upstream_unavailable", code: "community_viewer_unresolved", coverage: "nothing", failedSources: ["viewer"] });
  });
  it("CV9 unresolved with ageFilter=open_to_me → never 'date of birth missing'; refused, `viewer` named", async () => {
    const r = await served("throws", { rows: "venue", query: "&ageFilter=open_to_me" });
    assert.equal(r.body.ageFilterMeta?.callerDobMissing, false, JSON.stringify(r.body.ageFilterMeta));
    assert.deepEqual(r.refusal, { class: "upstream_unavailable", code: "community_viewer_unresolved", coverage: "partial", failedSources: ["viewer"] });
    assert.equal(r.venueSaved, null);
  });
  it("CV9c CONTROL: a resolved viewer with ageFilter=open_to_me is not refused", async () => {
    const r = await served("resolves", { rows: "venue", query: "&ageFilter=open_to_me" });
    assert.equal(r.refusal, null, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.venueSaved, true);
  });
});

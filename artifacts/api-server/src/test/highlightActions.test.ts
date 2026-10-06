/**
 * §12 Highlight actions — GET /highlights/:id/actions, over the real router and
 * the Highlights route harness. Census H102.
 *
 * WHAT THESE TESTS HOLD
 *   - A Highlight's venue is the place of the Memory it projects
 *     (`highlight_sources`), and the venue actions are that Memory's actions
 *     under the MEMORY's read gate for this viewer. Seeing the Highlight is not
 *     the owner sharing where it was: a Memory the viewer may not read yields
 *     no venue and no Memory id.
 *   - To a NON-OWNER, "sourceless", "its Memory is not shared with you" and
 *     "its Memory was deleted" are ONE answer (NO_SHARED_SOURCE): a person the
 *     owner hid from a Memory must not learn that it exists (verifier finding
 *     3). The owner is told which it is (NO_SOURCE_MEMORY / SOURCE_DELETED).
 *   - A sourceless Highlight says so to its owner; an unreadable source link, or an
 *     undeployed one, or an unreadable Memory, are each their own reason —
 *     never "no source".
 *   - ASK follows the recipient's messaging rules, the same verdict the reply
 *     route enforces; an unreadable verdict is not a "no".
 *   - The view gate is resolveViewAccess: blocked or invisible is the same 404.
 *   - Nothing is written.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightActions.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";
import { RESURFACING_TABLE } from "../services/highlights/highlightResurfacing.js";
import { PROJECTION_POLICY_TABLE } from "../services/highlights/highlightProjectionPolicy.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";
import { _setMemoryActionDeps } from "../services/memory/memoryActionService.js";
import { makeClient, type FakeClient } from "./highlightRouteHarness.js";

const OWNER = "11111111-0000-4000-8000-000000000001";
const VIEWER = "22222222-0000-4000-8000-000000000002";
const BLOCKED = "33333333-0000-4000-8000-000000000003";

const H_SOURCED = "aaaaaaaa-0000-4000-8000-00000000000a";
const H_PRIVATE_SOURCE = "bbbbbbbb-0000-4000-8000-00000000000b";
const H_SOURCELESS = "cccccccc-0000-4000-8000-00000000000c";
const H_CLOSED = "dddddddd-0000-4000-8000-00000000000d";
const H_PRIVATE = "eeeeeeee-0000-4000-8000-00000000000e";

const MEM_PUBLIC = "10000000-0000-4000-8000-000000000001";
const MEM_ONLY_ME = "10000000-0000-4000-8000-000000000002";
const MEM_CLOSED = "10000000-0000-4000-8000-000000000003";
const PLACE_OPEN = "20000000-0000-4000-8000-000000000001";
const PLACE_CLOSED = "20000000-0000-4000-8000-000000000002";

function highlight(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, media_url: `post-media/${OWNER}/highlights/${id}.jpg`, media_type: "image", caption: "dinner",
    visibility: "public", location_name: "Din Tai Fung, Xinyi", location_city: "Taipei", location_country: "Taiwan",
    created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
    deleted_at: null, archived_at: null, pinned_at: null, ...over,
  };
}
function memory(id: string, over: Record<string, unknown>) {
  return {
    id, owner_id: OWNER, title: "Dumplings", visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, place_id: PLACE_OPEN, canonical_location_id: null, location_city: "Taipei", location_country: "Taiwan",
    location_lat: 25.033, location_lng: 121.565, starts_at: "2026-09-09T11:00:00.000Z", ends_at: null,
    state: "published", created_at: "2026-09-09T12:00:00.000Z", ...over,
  };
}
const source = (highlightId: string, memoryId: string) =>
  ({ highlight_id: highlightId, source_type: "MEMORY", source_id: memoryId, provenance: "OWNER_SELECTED", created_at: "2026-09-10T00:00:00.000Z" });

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: OWNER, handle: "owner", name: "Owner", avatar_url: null },
      { id: VIEWER, handle: "viewer", name: "Viewer", avatar_url: null },
      { id: BLOCKED, handle: "blocked", name: "Blocked", avatar_url: null },
    ],
    blocks: [{ blocker_id: OWNER, blocked_id: BLOCKED }],
    highlights: [
      highlight(H_SOURCED), highlight(H_PRIVATE_SOURCE), highlight(H_SOURCELESS), highlight(H_CLOSED),
      highlight(H_PRIVATE, { visibility: "private" }),
    ],
    highlight_sources: [source(H_SOURCED, MEM_PUBLIC), source(H_PRIVATE_SOURCE, MEM_ONLY_ME), source(H_CLOSED, MEM_CLOSED)],
    memories: [
      memory(MEM_PUBLIC, {}),
      memory(MEM_ONLY_ME, { visibility: "only_me" }),
      memory(MEM_CLOSED, { place_id: PLACE_CLOSED }),
    ],
    places: [
      { id: PLACE_OPEN, name: "Din Tai Fung Xinyi", primary_category: "food", latitude: 25.033, longitude: 121.565, address: "No. 194", city: "Taipei", country_code: "TW", status: "active", merged_into_place_id: null, canonical_location_id: null },
      { id: PLACE_CLOSED, name: "Gone Noodles", primary_category: "food", latitude: 25.04, longitude: 121.56, address: null, city: "Taipei", country_code: "TW", status: "closed", merged_into_place_id: null, canonical_location_id: null },
    ],
    hidden_gems: [],
    memory_saves: [],
    user_message_settings: [],
    user_friendships: [],
    user_follows: [],
    circle_memberships: [],
    trip_members: [],
    highlight_views: [], highlight_likes: [], highlight_replies: [], highlight_reports: [],
    [RESURFACING_TABLE]: [],
    [PROJECTION_POLICY_TABLE]: [],
  };
}

let server: Server | null = null;
let client: FakeClient | null = null;
afterEach(async () => {
  _setMemoryActionDeps(null);
  if (server) await new Promise<void>((r) => { server!.closeAllConnections(); server!.close(() => r()); });
  server = null;
});

async function start(opts: { errors?: Record<string, { message: string; code?: string }>; mutate?: (s: Record<string, any[]>) => void } = {}) {
  resetHighlightSchemaMemo();
  const s = seed();
  opts.mutate?.(s);
  client = makeClient(s, { errors: opts.errors });
  _setTestClient(client as any, true);
  _setMemoryActionDeps({ liveStatus: async () => null });
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", highlightsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

async function menu(base: string, highlightId: string, actor: string) {
  const before = JSON.stringify(client!._store);
  const res = await fetch(`${base}/api/highlights/${highlightId}/actions`, { headers: { Authorization: `Bearer ${actor}`, connection: "close" } });
  const body = await res.json().catch(() => null);
  assert.equal(JSON.stringify(client!._store), before, "the actions route is read-only");
  return { status: res.status, body, by: Object.fromEntries(((body?.menu?.actions ?? []) as any[]).map((a) => [a.action, a])) };
}

describe("GET /highlights/:id/actions — §12's verbs on the Memory the Highlight projects", () => {
  it("a viewer of a Highlight whose Memory they may read gets DO THIS / ADD TO TRIP / VIEW PLACE / SAVE / ASK; MEET is refused by name", async () => {
    const base = await start();
    const r = await menu(base, H_SOURCED, VIEWER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const a of ["DO_THIS", "ADD_TO_TRIP", "VIEW_PLACE", "SAVE", "ASK"]) assert.equal(r.by[a].available, true, `${a}: ${JSON.stringify(r.by[a])}`);
    assert.deepEqual([r.by.MEET.available, r.by.MEET.reason], [false, "CONSUMER_UNAVAILABLE"]);
    assert.equal(r.body.menu.sourceMemoryId, MEM_PUBLIC);
    assert.equal(r.body.menu.place.id, PLACE_OPEN);
    assert.equal(r.body.menu.actions.length, 6, "§12's six");
  });

  it("seeing the Highlight is not being shown the Memory: a private source yields no venue and no Memory id", async () => {
    const base = await start();
    const r = await menu(base, H_PRIVATE_SOURCE, VIEWER);
    assert.equal(r.status, 200);
    for (const a of ["DO_THIS", "ADD_TO_TRIP", "VIEW_PLACE", "SAVE"]) assert.equal(r.by[a].reason, "NO_SHARED_SOURCE", a);
    assert.equal(r.body.menu.sourceMemoryId, null);
    assert.equal(r.body.menu.place, null);
    assert.ok(!JSON.stringify(r.body).includes(PLACE_OPEN), "the place id must not appear anywhere in the response");
  });

  it("the owner gets the venue of their own private source, and is not offered ASK or SAVE on their own", async () => {
    const base = await start();
    const r = await menu(base, H_PRIVATE_SOURCE, OWNER);
    assert.equal(r.by.DO_THIS.available, true);
    assert.equal(r.by.ASK.reason, "OWN_HIGHLIGHT");
    assert.equal(r.by.SAVE.reason, "OWN_MEMORY");
    assert.equal(r.body.menu.sourceMemoryId, MEM_ONLY_ME);
  });

  it("a sourceless Highlight says so to its owner — Portava does not guess a place from its location text", async () => {
    const base = await start();
    const own = await menu(base, H_SOURCELESS, OWNER);
    for (const a of ["DO_THIS", "ADD_TO_TRIP", "VIEW_PLACE", "SAVE"]) assert.equal(own.by[a].reason, "NO_SOURCE_MEMORY", a);
    const r = await menu(base, H_SOURCELESS, VIEWER);
    for (const a of ["DO_THIS", "ADD_TO_TRIP", "VIEW_PLACE", "SAVE"]) assert.equal(r.by[a].reason, "NO_SHARED_SOURCE", a);
    assert.equal(r.by.ASK.available, true, "ASK does not depend on a source");
    assert.equal(r.body.menu.place, null);
  });

  it("FINDING 3: a viewer the owner HID from the Memory gets exactly the sourceless answer — the hidden Memory's existence does not leak", async () => {
    const venueOf = (r: Awaited<ReturnType<typeof menu>>) =>
      JSON.stringify(["DO_THIS", "ADD_TO_TRIP", "VIEW_PLACE", "SAVE"].map((a) => [r.by[a].available, r.by[a].reason, r.by[a].message]))
      + JSON.stringify([r.body.menu.sourceMemoryId, r.body.menu.place]);
    const base = await start({ mutate: (s) => { s.memories.find((m) => m.id === MEM_PUBLIC).hidden_user_ids = [VIEWER]; } });
    const hidden = await menu(base, H_SOURCED, VIEWER);
    const sourceless = await menu(base, H_SOURCELESS, VIEWER);
    const notShared = await menu(base, H_PRIVATE_SOURCE, VIEWER);
    assert.equal(hidden.status, 200);
    assert.equal(venueOf(hidden), venueOf(sourceless), "hidden-from must read as sourceless");
    assert.equal(venueOf(notShared), venueOf(sourceless), "not-shared must read as sourceless");
    assert.ok(!JSON.stringify(hidden.body).includes(MEM_PUBLIC));
  });

  it("FINDING 3: a DELETED source tells its owner it was deleted — never 'not shared' — and tells everyone else the sourceless answer", async () => {
    const base = await start({ mutate: (s) => { s.memories.find((m) => m.id === MEM_PUBLIC).state = "deleted"; } });
    const own = await menu(base, H_SOURCED, OWNER);
    for (const a of ["DO_THIS", "ADD_TO_TRIP", "VIEW_PLACE", "SAVE"]) assert.equal(own.by[a].reason, "SOURCE_DELETED", a);
    assert.equal(own.body.menu.place, null, "a deleted Memory's place is not offered to act on");
    const other = await menu(base, H_SOURCED, VIEWER);
    const sourceless = await menu(base, H_SOURCELESS, VIEWER);
    for (const a of ["DO_THIS", "ADD_TO_TRIP", "VIEW_PLACE", "SAVE"]) {
      assert.equal(other.by[a].reason, "NO_SHARED_SOURCE", a);
      assert.equal(other.by[a].message, sourceless.by[a].message, a);
    }
  });

  it("a closed place carries the Memory's own refusal", async () => {
    const base = await start();
    const r = await menu(base, H_CLOSED, VIEWER);
    assert.equal(r.by.DO_THIS.reason, "PLACE_CLOSED");
    assert.equal(r.by.ADD_TO_TRIP.reason, "PLACE_CLOSED");
  });

  it("unreadable links, undeployed links and an unreadable Memory are three different reasons — none of them NO_SOURCE_MEMORY", async () => {
    let base = await start({ errors: { highlight_sources: { message: "timeout", code: "57014" } } });
    let r = await menu(base, H_SOURCED, VIEWER);
    assert.equal(r.status, 200);
    assert.equal(r.by.DO_THIS.reason, "SOURCE_UNREADABLE");
    await new Promise<void>((res) => { server!.closeAllConnections(); server!.close(() => res()); }); server = null;

    base = await start({ errors: { highlight_sources: { message: 'relation "public.highlight_sources" does not exist', code: "42P01" } } });
    r = await menu(base, H_SOURCED, VIEWER);
    assert.equal(r.by.DO_THIS.reason, "SOURCE_STORE_UNAVAILABLE");
    await new Promise<void>((res) => { server!.closeAllConnections(); server!.close(() => res()); }); server = null;

    base = await start({ errors: { memories: { message: "timeout", code: "57014" } } });
    r = await menu(base, H_SOURCED, VIEWER);
    assert.equal(r.by.DO_THIS.reason, "SOURCE_UNREADABLE");
    assert.equal(r.body.menu.sourceMemoryId, null);
  });

  it("ASK follows the recipient's messaging rules; an unreadable rule is not a no", async () => {
    let base = await start({ mutate: (s) => { s.user_message_settings.push({ user_id: OWNER, message_privacy: "no_one", allow_message_requests: false, allow_trip_member_messages: false, allow_circle_member_messages: false }); } });
    let r = await menu(base, H_SOURCED, VIEWER);
    assert.equal(r.by.ASK.reason, "MESSAGING_NOT_ALLOWED");
    await new Promise<void>((res) => { server!.closeAllConnections(); server!.close(() => res()); }); server = null;

    base = await start({ mutate: (s) => { s.user_message_settings.push({ user_id: OWNER, message_privacy: "followers", allow_message_requests: true, allow_trip_member_messages: false, allow_circle_member_messages: false }); } });
    r = await menu(base, H_SOURCED, VIEWER);
    assert.equal(r.by.ASK.reason, "MESSAGE_REQUEST_REQUIRED");
    await new Promise<void>((res) => { server!.closeAllConnections(); server!.close(() => res()); }); server = null;

    base = await start({ errors: { user_message_settings: { message: "timeout", code: "57014" } } });
    r = await menu(base, H_SOURCED, VIEWER);
    assert.equal(r.by.ASK.reason, "MESSAGING_UNREADABLE");
  });

  it("a Highlight the viewer may not see is 404 — blocked, or private", async () => {
    const base = await start();
    assert.equal((await menu(base, H_SOURCED, BLOCKED)).status, 404);
    assert.equal((await menu(base, H_PRIVATE, VIEWER)).status, 404);
    assert.equal((await menu(base, "ffffffff-0000-4000-8000-00000000000f", VIEWER)).status, 404);
  });
});

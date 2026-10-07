/**
 * census-telegraph T291 / T292 / T293 / T294 / T295 — §24's projections, and the
 * three client bypass sites the thread screen still had.
 *
 * §24: "Mobile clients consume server-built projections instead of independently
 * joining raw tables and reimplementing authorization/business logic."
 *
 * WHAT IS EXERCISED
 *   1. REGISTRY HONESTY, BOTH WAYS. `TELEGRAPH_PROJECTIONS` said four of six were
 *      absent after three of them had been built and their census rows (T13–T21,
 *      T66, T85) had moved to C. This suite probes the tree for each projection's
 *      route independently of the registry, and fails when the registry calls a
 *      served projection `absent` — or calls one `built`/`partial` whose builder
 *      module, route literal or router mount is missing.
 *   2. THE FACTS THE SCREEN USED TO READ ITSELF. `GET /threads/:id/capabilities`
 *      now carries `conversation.{memberCount,isE2ee}` (server/telegraph/
 *      conversationFacts.ts), for an ACTIVE MEMBER only. The count is EXACT past
 *      PostgREST's row cap; an unreadable read is `null` + `degraded`, never 0 or
 *      false; a non-member gets the same nulls as a thread that does not exist.
 *   3. THE CLIENT TREE. Zero `.from()` reads of a raw messaging table remain on
 *      either chat screen (the ratchet in check:telegraph-slos is lowered to 0
 *      in the same commit, and the registry's bypass list is empty).
 *
 * SHOWN RED (recorded in the T2 lane report): PRJ-06 put back to `absent`
 * turns test 1 red; `memberCount` taken from a roster page instead of an exact
 * count turns the row-cap test red; the error branch of the count read dropped
 * turns the degraded test red.
 *
 * Run: node --import tsx/esm --test src/test/telegraphProjectionRegistryHonesty.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import capabilityRouter from "../server/telegraph/capabilityRoute.js";
import { readConversationFacts } from "../server/telegraph/conversationFacts.js";
import {
  TELEGRAPH_PROJECTIONS,
  TELEGRAPH_PROJECTION_BYPASSES,
} from "../domain/telegraph/projections/projectionRegistry.js";
import { makeFakeClient, startRouter, call, type RouterHarness } from "./telegraphCertificationHarness.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const asSc = (c: unknown) => c as SupabaseClient;

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(PKG, "../..");
const read = (rel: string) => readFileSync(join(PKG, rel), "utf8");
const routesIndex = read("src/routes/index.ts");

/**
 * The §24 projection → the route that would serve it, probed independently of
 * the registry. A route that exists and is mounted makes `absent` a false claim.
 */
const SPEC_PROBES: Record<string, { module: string; path: string }> = {
  "PRJ-01": { module: "src/routes/messaging.ts", path: "/me/threads" },
  "PRJ-02": { module: "src/routes/messaging.ts", path: "/threads/:threadId/messages" },
  "PRJ-03": { module: "src/routes/telegraphSharedContext.ts", path: "/threads/:threadId/shared-context" },
  "PRJ-04": { module: "src/routes/nearbyReachable.ts", path: "/nearby/reachable" },
  "PRJ-05": { module: "src/routes/telegraphCoordination.ts", path: "/threads/:threadId/coordination" },
  "PRJ-06": { module: "src/routes/telegraphKinds.ts", path: "/threads/:threadId/drawer" },
};

function routeExists(module: string, path: string): boolean {
  if (!existsSync(join(PKG, module))) return false;
  const src = read(module);
  const literal = src.includes(`"${path}"`) || src.includes(`'${path}'`);
  const base = module.replace(/^src\/routes\//, "").replace(/\.ts$/, "");
  const mounted =
    module.startsWith("src/routes/") &&
    new RegExp(`from ["']\\./${base}(\\.js)?["']`).test(routesIndex);
  return literal && mounted;
}

describe("§24 registry — honest in both directions", () => {
  it("names the six §24 projections, once each", () => {
    assert.deepEqual(TELEGRAPH_PROJECTIONS.map((p) => p.id), Object.keys(SPEC_PROBES));
  });

  for (const [id, probe] of Object.entries(SPEC_PROBES)) {
    it(`${id}: a mounted route serving it means the registry may not say 'absent'`, () => {
      const entry = TELEGRAPH_PROJECTIONS.find((p) => p.id === id)!;
      const served = routeExists(probe.module, probe.path);
      if (served) {
        assert.notEqual(entry.status, "absent", `${id} is served at ${probe.module} ${probe.path} and the registry says absent`);
      }
      if (entry.status !== "absent") {
        assert.ok(served, `${id} is '${entry.status}' but ${probe.module} does not serve ${probe.path}`);
        assert.ok(entry.builtBy && existsSync(join(PKG, entry.builtBy)), `${id}.builtBy does not exist`);
        assert.ok(entry.servedAt && entry.servedAt.startsWith(probe.module) && entry.servedAt.endsWith(probe.path),
          `${id}.servedAt does not name ${probe.module} … ${probe.path}`);
      } else {
        assert.equal(entry.builtBy, null);
        assert.equal(entry.servedAt, null);
      }
      if (entry.status === "partial") {
        assert.ok(entry.note.length > 120, `${id} is partial and its note must state the gap`);
      }
    });
  }

  it("the builders named are the ones that build: each builtBy exports the projection's builder", () => {
    const exportsOf = (rel: string) => read(rel);
    assert.match(exportsOf("src/services/telegraph/sharedContext.ts"), /export async function buildSharedContextProjection\(/);
    assert.match(exportsOf("src/services/telegraph/reachablePeople.ts"), /export function projectReachablePerson\(/);
    assert.match(exportsOf("src/services/telegraph/coordination.ts"), /export function projectCoordinationSession\(/);
    assert.match(exportsOf("src/routes/telegraphKinds.ts"), /"\/threads\/:threadId\/drawer"/);
  });

  it("the client bypass list is empty — §24's closing rule holds on both chat screens", () => {
    assert.deepEqual(TELEGRAPH_PROJECTION_BYPASSES, []);
    const baseline = JSON.parse(read("src/scripts/TELEGRAPH_OBSERVABILITY_BASELINE.json")).counts;
    assert.equal(baseline.clientBypassSites, 0);
    assert.equal(baseline.absentProjections, TELEGRAPH_PROJECTIONS.filter((p) => p.status === "absent").length);
  });

  it("no client file reads a raw messaging table (re-derived, not trusted)", () => {
    const tables = ["message_thread_members", "message_threads", "messages", "message_requests", "message_translations", "saved_messages"];
    const hits: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        // Same exclusions as check:telegraph-slos: a test that NAMES a forbidden read is not one.
        if (name === "node_modules" || name === "__tests__" || name.includes(".test.")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) {
          const src = readFileSync(p, "utf8");
          for (const t of tables) if (new RegExp(`\\.from\\(\\s*["']${t}["']`).test(src)) hits.push(`${p}:${t}`);
        }
      }
    };
    walk(join(REPO, "travel-buddy-standalone/src"));
    walk(join(REPO, "travel-buddy-standalone/app"));
    assert.deepEqual(hits, []);
  });

  // census-telegraph T295 (lane T, 2026-10-07): §45c left ONE raw read on the conversation
  // surface — useReaderAvatars' `profiles.avatar_url`. The receipt now carries the faces
  // (GET /threads/:id/receipts → readerFaces, src/test/telegraphReaderFaces.test.ts), and on
  // the conversation surface `profiles` counts as a raw table too.
  it("no conversation-surface client file reads `profiles` either (re-derived, not trusted)", () => {
    const surface = [
      "travel-buddy-standalone/src/features/telegraph",
      "travel-buddy-standalone/app/messages",
      "travel-buddy-standalone/src/components/telegraph",
      "travel-buddy-standalone/src/components/GroupChatScreen.tsx",
      "travel-buddy-standalone/src/components/TelegraphInboxScreen.tsx",
    ];
    const hits: string[] = [];
    let files = 0;
    const visit = (p: string) => {
      if (!existsSync(p)) return;
      if (statSync(p).isDirectory()) {
        for (const name of readdirSync(p)) {
          if (name === "node_modules" || name === "__tests__" || name.includes(".test.")) continue;
          visit(join(p, name));
        }
      } else if (/\.tsx?$/.test(p)) {
        files += 1;
        if (/\.from\(\s*["']profiles["']/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    for (const s of surface) visit(join(REPO, s));
    assert.ok(files > 50, `only ${files} conversation-surface files read`);
    assert.deepEqual(hits, []);
    // The chips' hook reads the server's answer, not a table.
    const hook = readFileSync(join(REPO, "travel-buddy-standalone/src/features/telegraph/lifecycle/useReaderAvatars.ts"), "utf8");
    assert.doesNotMatch(hook, /supabase/);
    assert.match(hook, /readerFace\(/);
  });
});

// ── the facts, through the real route ─────────────────────────────────────────

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";
const DANA = "dddddddd-0000-4000-8000-000000000004";
const TRIP_THREAD = "00000000-0000-4000-8000-00000000000c";
const E2EE_DM = "00000000-0000-4000-8000-00000000000e";

function seed(): Record<string, Record<string, unknown>[]> {
  return {
    feature_flags: [],
    message_threads: [
      { id: TRIP_THREAD, thread_type: "circle", status: "active", trip_id: null, circle_owner_id: ALICE, is_e2ee: false },
      { id: E2EE_DM, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: true },
    ],
    message_thread_members: [
      { thread_id: TRIP_THREAD, user_id: ALICE, role: "member", left_at: null },
      { thread_id: TRIP_THREAD, user_id: BOB, role: "member", left_at: null },
      { thread_id: TRIP_THREAD, user_id: CARL, role: "member", left_at: null },
      // Departed: never counted.
      { thread_id: TRIP_THREAD, user_id: DANA, role: "member", left_at: "2026-09-01T00:00:00.000Z" },
      { thread_id: E2EE_DM, user_id: ALICE, role: "member", left_at: null },
      { thread_id: E2EE_DM, user_id: BOB, role: "member", left_at: null },
    ],
    blocks: [],
    trust_restrictions: [],
    user_privacy_settings: [],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
  };
}

describe("GET /threads/:id/capabilities — the conversation facts (T295)", () => {
  let h: RouterHarness;
  before(async () => { h = await startRouter(capabilityRouter); });
  after(async () => { _setTestClient(null, false); await h.close(); });

  it("a member gets the active member count and the E2EE flag from the server", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const group = await call(h.base, "GET", `/threads/${TRIP_THREAD}/capabilities`, ALICE);
    assert.equal(group.status, 200);
    assert.deepEqual(group.body.conversation, { memberCount: 3, isE2ee: false, transportClass: "SMALL_GROUP", degraded: false });
    const dm = await call(h.base, "GET", `/threads/${E2EE_DM}/capabilities`, ALICE);
    assert.deepEqual(dm.body.conversation, { memberCount: 2, isE2ee: true, transportClass: "PRIVATE_CONVERSATION", degraded: false });
  });

  it("the count is EXACT past PostgREST's row cap — not the length of a capped page", async () => {
    _setTestClient(makeFakeClient(seed(), { maxRows: 2 }), true);
    const r = await call(h.base, "GET", `/threads/${TRIP_THREAD}/capabilities`, ALICE);
    assert.equal(r.body.conversation.memberCount, 3);
  });

  it("a NON-member, a departed member and a nonexistent thread all get the same nulls (no oracle)", async () => {
    _setTestClient(makeFakeClient(seed()), true);
    const departed = await call(h.base, "GET", `/threads/${TRIP_THREAD}/capabilities`, DANA);
    const outsider = await call(h.base, "GET", `/threads/${E2EE_DM}/capabilities`, CARL);
    const missing = await call(h.base, "GET", `/threads/00000000-0000-4000-8000-0000000000ff/capabilities`, ALICE);
    for (const r of [departed, outsider, missing]) {
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.conversation, { memberCount: null, isE2ee: null, transportClass: null, degraded: false });
    }
  });

  it("an unreadable count is null + degraded — never 0", async () => {
    // afterOps: 1 — the facts' own-row read (op 1) succeeds, the count (op 2) fails.
    const healthy = await readConversationFacts(asSc(makeFakeClient(seed())), TRIP_THREAD, ALICE);
    assert.equal(healthy.memberCount, 3, "the control: the same world, healthy, counts three");
    const failing = makeFakeClient(seed(), { errors: { message_thread_members: { message: "count blew up", afterOps: 1 } } });
    const facts = await readConversationFacts(asSc(failing), TRIP_THREAD, ALICE);
    assert.equal(facts.memberCount, null);
    assert.equal(facts.degraded, true);
  });

  it("an unreadable is_e2ee is null + degraded — never 'not encrypted'", async () => {
    const failing = makeFakeClient(seed(), { errors: { message_threads: { message: "thread row blew up" } } });
    const facts = await readConversationFacts(asSc(failing), E2EE_DM, ALICE);
    assert.equal(facts.isE2ee, null);
    assert.equal(facts.degraded, true);
    assert.equal(facts.memberCount, 2, "the healthy read still answers");
  });

  it("an unreadable own-membership read discloses nothing and says it degraded", async () => {
    const failing = makeFakeClient(seed(), { errors: { message_thread_members: { message: "roster blew up" } } });
    const facts = await readConversationFacts(asSc(failing), TRIP_THREAD, ALICE);
    assert.deepEqual(facts, { memberCount: null, isE2ee: null, degraded: true });
  });
});

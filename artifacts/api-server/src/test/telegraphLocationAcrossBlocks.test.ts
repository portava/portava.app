/**
 * PR-TREL-5 (census-telegraph §76) — a LOCATION message never crosses a block on
 * the READ path. Every surface that serialises a message body is driven over the
 * real routers with the certification harness's fake, for three viewers:
 *
 *   BOB    in a block with the sender ALICE (each direction), and with block
 *          state UNREADABLE — must see only the placeholder;
 *   CARL   unblocked member — full content;
 *   ALICE  the sender — full content.
 *
 * The fixture's location is EXACT precision with coordinates, a label, an
 * approximate label and a place id; "leaked" means any one of them appears
 * anywhere in the response.
 *
 * Run: node --import tsx/esm --test src/test/telegraphLocationAcrossBlocks.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import kindsRouter from "../routes/telegraphKinds.js";
import coordinationRouter from "../routes/telegraphCoordination.js";
import memoryRouter from "../routes/telegraphMemory.js";
import { searchConversations } from "../services/telegraphSearch.js";
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1";
const BOB = "bbbbbbbb-0000-4000-8000-0000000000b2";
const CARL = "cccccccc-0000-4000-8000-0000000000c3";
const GROUP = "00000000-0000-4000-8000-0000000000e1";
const LOC = "11111111-0000-4000-8000-0000000000f1";
const REPLY = "11111111-0000-4000-8000-0000000000f2";
const NOW = Date.now();
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const SECRETS = ["Café Secret", "Old Quarter", "place-secret-123", "16.0611", "108.2208"];
const LOC_BODY = JSON.stringify({ kind: "LOCATION", envelopeVersion: "1", payload: {
  label: "Café Secret", approximateLabel: "Old Quarter", placeId: "place-secret-123", precision: "exact",
  lat: 16.0611, lng: 108.2208, caption: null, expiresAt: at(-60), purpose: "presence_in_context",
} });
type Block = { blocker_id: string; blocked_id: string };

function world(blocks: Block[]): Record<string, unknown[]> {
  const m = (user_id: string) => ({ thread_id: GROUP, user_id, role: "member", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null, joined_at: at(600) });
  const msg = (id: string, sender_id: string, body: string, msg_type: string, subtype: string | null, minAgo: number, extra: Record<string, unknown> = {}) => ({
    id, thread_id: GROUP, sender_id, body, msg_type, subtype, created_at: at(minAgo), deleted_at: null, edited_at: null,
    original_language: null, media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null, ciphertext: null, ...extra,
  });
  return {
    feature_flags: [], blocks,
    message_threads: [{ id: GROUP, thread_type: "group", status: "active", title: "Crew", trip_id: null, circle_owner_id: null, is_e2ee: false, created_at: at(600), updated_at: at(1), last_message_at: at(1) }],
    message_thread_members: [m(ALICE), m(BOB), m(CARL)],
    messages: [
      msg(REPLY, CARL, "see you there", "text", null, 2, { reply_to_id: LOC }),
      msg(LOC, ALICE, LOC_BODY, "location", "exact", 1),
    ],
    message_edits: [{ message_id: LOC, version: 1, previous_body: LOC_BODY, editor_id: ALICE, edited_at: at(1) }],
    saved_messages: [{ user_id: BOB, message_id: LOC, saved_at: at(1) }, { user_id: CARL, message_id: LOC, saved_at: at(1) }],
    profiles: [ALICE, BOB, CARL].map((id) => ({ id, handle: id.slice(0, 5), name: id.slice(0, 5), avatar_url: null, is_private: false, account_status: "active" })),
    message_translations: [], user_friendships: [], memories: [],
  };
}

const VIEWS: Array<[string, Block[], FakeDbOptions]> = [
  ["BOB blocked ALICE", [{ blocker_id: BOB, blocked_id: ALICE }], {}],
  ["ALICE blocked BOB", [{ blocker_id: ALICE, blocked_id: BOB }], {}],
  ["block state UNREADABLE", [], { errors: { blocks: { message: "blocks: timeout" } } }],
];

/**
 * `shows`: the surface serialises the location's text today (CARL must see it — the control that makes BOB's case
 * non-vacuous). The others carry ids, kinds and counts only; for them BOB's case pins that it stays that way.
 */
const SURFACES: Array<{ name: string; router: () => express.Router; method: "GET" | "POST"; path: string; body?: unknown; shows: boolean }> = [
  { name: "thread page (body + quoted reply)", router: () => messagingRouter, method: "GET", path: `/threads/${GROUP}/messages`, shows: true },
  { name: "inbox preview", router: () => messagingRouter, method: "GET", path: `/me/threads`, shows: true },
  { name: "saved messages", router: () => messagingRouter, method: "GET", path: `/me/saved-messages`, shows: true },
  { name: "edit history", router: () => messagingRouter, method: "GET", path: `/threads/${GROUP}/messages/${LOC}/edits`, shows: true },
  { name: "content drawer", router: () => kindsRouter, method: "GET", path: `/threads/${GROUP}/drawer`, shows: true },
  { name: "in-thread search", router: () => kindsRouter, method: "GET", path: `/threads/${GROUP}/search?q=Secret`, shows: true },
  { name: "layers", router: () => coordinationRouter, method: "GET", path: `/threads/${GROUP}/layers`, shows: true },
  { name: "catch-up", router: () => coordinationRouter, method: "GET", path: `/threads/${GROUP}/catch-up`, shows: false },
  { name: "safety mode", router: () => coordinationRouter, method: "GET", path: `/threads/${GROUP}/safety-mode`, shows: false },
  { name: "memory draft", router: () => memoryRouter, method: "POST", path: `/me/memory-drafts`, body: { messageId: LOC }, shows: false },
];

const harnesses = new Map<express.Router, RouterHarness>();
before(async () => {
  for (const s of SURFACES) { const r = s.router(); if (!harnesses.has(r)) harnesses.set(r, await startRouter(r)); }
});
after(async () => { _setTestClient(null as any, false); for (const h of harnesses.values()) await h.close(); });

async function view(s: (typeof SURFACES)[number], viewer: string, blocks: Block[], opts: FakeDbOptions) {
  const client = makeFakeClient(world(blocks), opts);
  _setTestClient(client as any, true);
  const r = await call(harnesses.get(s.router())!.base, s.method, s.path, viewer, s.body);
  // The memory draft's TITLE is written to the store, not only answered: read both.
  const stored = JSON.stringify((client as any)._store.memories ?? []);
  return { status: r.status, text: JSON.stringify(r.body) + stored };
}
const leaks = (text: string) => SECRETS.filter((x) => text.includes(x));

for (const s of SURFACES) {
  describe(`PR-TREL-5 — ${s.name}`, () => {
    it(s.shows ? "CONTROL: an unblocked member (CARL) sees the location's text" : "CONTROL: the surface answers CARL (it carries no place text for anyone)", async () => {
      const r = await view(s, CARL, [{ blocker_id: BOB, blocked_id: ALICE }], {});
      assert.ok(r.status < 300, `${r.status} ${r.text.slice(0, 300)}`);
      if (s.shows) assert.ok(leaks(r.text).length > 0, `CARL should see it: ${r.text.slice(0, 400)}`);

    });
    for (const [why, blocks, opts] of VIEWS) {
      it(`${why}: BOB sees no label, approximate label, place id or coordinates`, async () => {
        const r = await view(s, BOB, blocks, opts);
        assert.ok(r.status < 300 || r.status === 404, `${r.status} ${r.text.slice(0, 300)}`);
        assert.deepEqual(leaks(r.text), [], `${s.name} leaked to BOB (${why}): ${r.text.slice(0, 600)}`);
      });
    }
  });
}

describe("PR-TREL-5 — the sender and unblocked members keep full content on the thread page", () => {
  for (const viewer of [ALICE, CARL]) {
    it(`${viewer === ALICE ? "ALICE (sender)" : "CARL"} reads the exact coordinates`, async () => {
      const r = await view(SURFACES[0]!, viewer, [{ blocker_id: BOB, blocked_id: ALICE }], {});
      assert.deepEqual(leaks(r.text).sort(), [...SECRETS].sort());
    });
  }
  it("BOB's page shows the placeholder in place of the location, and the reply's quote is the placeholder too", async () => {
    const r = await view(SURFACES[0]!, BOB, [{ blocker_id: BOB, blocked_id: ALICE }], {});
    assert.ok(r.text.includes("Location shared"));
    const body = JSON.parse(r.text.slice(0, r.text.lastIndexOf("[]")));
    const loc = body.messages.find((m: any) => m.id === LOC);
    assert.ok(loc, "the message is still there (the kind is kept)");
    assert.match(String(loc.body), /Location shared/);
  });
});

describe("PR-TREL-5 — cross-conversation search drops the row (the match was against the withheld place)", () => {
  for (const [why, blocks, opts] of VIEWS) {
    it(`${why}: no hit for BOB`, async () => {
      const r = await searchConversations(makeFakeClient(world(blocks), opts) as any, BOB, "Secret");
      assert.deepEqual(leaks(JSON.stringify(r)), []);
      assert.equal(JSON.stringify(r).includes(LOC), false);
    });
  }
  it("CONTROL: CARL finds it", async () => {
    const r = await searchConversations(makeFakeClient(world([{ blocker_id: BOB, blocked_id: ALICE }])) as any, CARL, "Secret");
    assert.ok(JSON.stringify(r).includes(LOC), JSON.stringify(r).slice(0, 400));
  });
});

describe("PR-TREL-5 — the surfaces that carry NO body, pinned so they stay that way", () => {
  it("stream replay frames and the typed-message realtime event never select or publish a body", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const stream = readFileSync(join(src, "routes/telegraphStream.ts"), "utf8");
    for (const m of stream.matchAll(/\.from\("messages"\)\s*\.select\("([^"]*)"\)/g)) {
      assert.equal(/\bbody\b/.test(m[1]!), false, `stream replay selects a body: ${m[1]}`);
    }
    const env = readFileSync(join(src, "services/telegraph/threadEnvelopeWrites.ts"), "utf8");
    const ev = env.slice(env.indexOf('type: "message.created"'), env.indexOf('type: "message.created"') + 200);
    assert.equal(/\bbody\b/.test(ev), false, `the LOCATION write's realtime event carries a body: ${ev}`);
  });
});

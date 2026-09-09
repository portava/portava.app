/**
 * engagementLikerRosterUnreadable — GET /api/engagement/likes must not answer
 * "the likes table could not be read" with "nobody liked this".
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `getLikerIds` ended with:
 *
 *     const { data: rows, error } = await q;
 *     if (error) return { userIds: [], likedAts: new Map(), … };
 *
 * The error WAS bound and WAS read — and the branch still produced the
 * permissive, confident answer. The route then saw `userIds.length === 0` and
 * replied `200 { ok: true, users: [], hasMore: false }`. Nothing on that
 * response distinguishes it from a genuinely unliked post, so the client
 * renders and caches a false statement about how people responded to someone's
 * content.
 *
 * That is the exact argument this file already makes, in a comment forty lines
 * further down, about the BLOCK set:
 *
 *     • `users: []` is a false statement that nobody liked this, which the
 *       client renders and caches as fact.
 *
 * …and it refuses there with `degraded_unavailable`. The roster read two
 * functions earlier did the thing that comment condemns.
 *
 * ── HOW THIS IS MEASURED, NOT ASSUMED ───────────────────────────────────────
 * WHAT ELSE COULD MAKE A 503 PASS HERE? Three traps, all closed:
 *
 *  1. `requireUser` answers an unreadable `profiles.account_status` with the
 *     SAME 503 `degraded_unavailable`. So the failure is injected ONLY on
 *     `content_stamps` filtered to this post — `profiles` stays healthy — and
 *     every assertion checks the `message`, which differs between the two
 *     refusals ("Reactions are temporarily unavailable" vs "Could not verify
 *     account status. Please try again.").
 *  2. A crash-500 would also be `status !== 200`. So the status is asserted to
 *     be exactly 503 and the code exactly `degraded_unavailable`, and the app
 *     under test is the real `app.js`, which installs the real `req.log`.
 *  3. An empty fixture would make "no likers" trivially true. So the healthy
 *     control runs the SAME client seed with no injected failure and asserts a
 *     liker is actually returned — the roster is provably non-empty.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";

const VIEWER = "00000000-0000-0000-0000-000000000001";
const AUTHOR = "00000000-0000-0000-0000-000000000002";
const LIKER = "00000000-0000-0000-0000-000000000010";
const POST = "10000000-0000-0000-0000-000000000001";
const TOKEN = "tok-viewer";

const SEED = {
  profiles: [
    { id: VIEWER, username: "viewer", display_name: "Viewer", avatar_url: null, account_status: "active", verified: false, is_private: false },
    { id: AUTHOR, username: "author", display_name: "Author", avatar_url: null, account_status: "active", verified: false, is_private: false },
    { id: LIKER, username: "liker", display_name: "Liker", avatar_url: null, account_status: "active", verified: false, is_private: false },
  ],
  posts: [{ id: POST, author_id: AUTHOR, visibility: "public", status: "active", trip_id: null }],
  // A real liker: without this the "no likers" answer would be true anyway.
  content_stamps: [
    { user_id: LIKER, entity_type: "post", entity_id: POST, created_at: "2026-01-02T00:00:00Z" },
  ],
  blocks: [],
  user_follows: [],
  friend_requests: [],
  profile_privacy_settings: [],
};

/**
 * @param failRoster fail ONLY the liker read for THIS post. `profiles` is left
 *   healthy on purpose so `requireUser` cannot be the thing that refuses.
 */
function client(failRoster: boolean) {
  return makeFailClosedClient({
    rows: SEED,
    users: { [TOKEN]: VIEWER },
    failOn: (c) =>
      failRoster && c.table === "content_stamps" && c.eq("entity_id") === POST
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null,
  });
}

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

async function getLikes(): Promise<{ status: number; body: any }> {
  const r = await fetch(
    `${baseUrl}/api/engagement/likes?targetType=post_like&targetId=${POST}`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("1. a healthy roster read returns the liker (the fixture CAN produce one)", async () => {
  _setTestClient(client(false), true);
  const { status, body } = await getLikes();
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true);
  assert.equal(body.users.length, 1, "the seeded liker is reachable by this viewer");
  assert.equal(body.users[0].id, LIKER);
});

test("2. an unreadable likes table refuses instead of reporting an empty roster", async () => {
  _setTestClient(client(true), true);
  const { status, body } = await getLikes();

  // Exactly 503 — not merely "not 200", which a crash-500 would also satisfy.
  assert.equal(status, 503, `expected 503, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, "degraded_unavailable");
  assert.equal(body.retryable, true, "the client is told to retry, not to give up");

  // And it is THIS refusal, not requireUser's identically-coded one.
  assert.equal(
    body.message, "Reactions are temporarily unavailable",
    "the 503 must come from the liker read, not from the account-status gate",
  );
  assert.notEqual(body.message, "Could not verify account status. Please try again.");

  // The thing that must never be served.
  assert.equal(body.ok, undefined, "no success envelope");
  assert.equal(body.users, undefined, "and above all, no empty roster presented as fact");
});

test("3. a genuinely unliked post is still a truthful, successful empty roster", async () => {
  _setTestClient(
    makeFailClosedClient({
      rows: { ...SEED, content_stamps: [] },
      users: { [TOKEN]: VIEWER },
    }),
    true,
  );
  const { status, body } = await getLikes();
  assert.equal(status, 200, "an empty table is a real answer and must not be a 503");
  assert.equal(body.ok, true);
  assert.deepEqual(body.users, []);
  assert.equal(body.hasMore, false);
});

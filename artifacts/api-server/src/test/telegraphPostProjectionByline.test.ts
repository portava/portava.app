/**
 * census-telegraph T413 / T448, server half — the POST share projection carries
 * the author's CURRENT handle, so the legacy post card can say whose post it is
 * without drawing the sender's snapshot of it.
 *
 * WHAT IS EXERCISED: the real `resolveShareProjections` → `loadPost` over the
 * certification harness's PostgREST fake.
 *   - a public post resolves with `subtitle: "@<current handle>"`;
 *   - a renamed author shows the NEW handle (the snapshot's is never consulted);
 *   - an unreadable `profiles` read leaves the subtitle null and the post still
 *     AVAILABLE — a byline failure never revokes a post, and never invents a name;
 *   - a deleted post still carries nothing, byline included.
 *   - (verifier finding 1, 2026-10-05) a block EITHER WAY between the viewer and
 *     the author refuses the post — the posts routes' own bidirectional rule —
 *     so a blocker's handle never reaches the person they blocked; an unreadable
 *     block read is `unknown`, never "no block"; a banned / suspended / deleted
 *     author is never named in a byline (loadProfile degrades that account).
 *
 * SHOWN RED (T2 lane report): the profiles read's error branch dropped (an error
 * read as a handle) turns the unreadable case red; the byline removed turns the
 * first two red.
 *
 * Run: node --import tsx/esm --test src/test/telegraphPostProjectionByline.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveShareProjections } from "../services/telegraph/shareables.js";
import { makeFakeClient } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const POST_OK = "11110000-0000-4000-8000-000000000001";
const POST_GONE = "11110000-0000-4000-8000-000000000002";

function seed(handle: string): Record<string, Record<string, unknown>[]> {
  return {
    posts: [
      { id: POST_OK, author_id: BOB, content: "A bar with no sign", visibility: "public", status: "active",
        deleted_at: null, media_urls: [], updated_at: "2026-05-01T00:00:00.000Z" },
      { id: POST_GONE, author_id: BOB, content: "Gone", visibility: "public", status: "deleted",
        deleted_at: "2026-05-02T00:00:00.000Z", media_urls: [], updated_at: "2026-05-02T00:00:00.000Z" },
    ],
    profiles: [{ id: BOB, handle }],
  };
}

async function resolvePost(c: unknown, postId: string) {
  const [r] = await resolveShareProjections(c as SupabaseClient, ALICE, THREAD, [{ objectType: "POST", objectId: postId }]);
  return r!;
}

describe("POST projection byline", () => {
  it("a public post carries its author's current handle", async () => {
    const r = await resolvePost(makeFakeClient(seed("bob")), POST_OK);
    assert.equal(r.available, true);
    assert.equal(r.available && r.projection.subtitle, "@bob");
  });

  it("a renamed author shows the NEW handle — nothing stored at share time is consulted", async () => {
    const r = await resolvePost(makeFakeClient(seed("bob_renamed")), POST_OK);
    assert.equal(r.available && r.projection.subtitle, "@bob_renamed");
  });

  it("an unreadable profiles read leaves the byline null and the post AVAILABLE", async () => {
    const c = makeFakeClient(seed("bob"), { errors: { profiles: { message: "profiles unreadable" } } });
    const r = await resolvePost(c, POST_OK);
    assert.equal(r.available, true, "a byline failure must not revoke the post");
    assert.equal(r.available && r.projection.subtitle, null, "a failed read is not a handle");
  });

  it("a deleted post carries nothing, byline included", async () => {
    const r = await resolvePost(makeFakeClient(seed("bob")), POST_GONE);
    assert.equal(r.available, false);
    assert.equal(r.projection, null);
    assert.ok(!JSON.stringify(r).includes("@bob"));
  });
});

/* ── verifier finding 1 (independent verification of 9920f0c83d) ─────────────
 * Reproduction, as the verifier wrote it: Bob blocked Alice and posted publicly.
 * The PROFILE card was refused to Alice; the POST card said "@bob". Any thread
 * member can ask `POST /threads/:id/share-projections` for any post id, and the
 * route reads with the service client, so profile RLS does not stand between. */

function blocked(over: Partial<Record<string, Record<string, unknown>[]>> = {}): Record<string, Record<string, unknown>[]> {
  return {
    posts: [{ id: POST_OK, author_id: BOB, content: "A bar with no sign", visibility: "public", status: "active",
      deleted_at: null, media_urls: [], updated_at: "2026-05-01T00:00:00.000Z" }],
    profiles: [{ id: BOB, handle: "bob", name: "Bob", account_status: "active", avatar_url: null, updated_at: null }],
    blocks: [{ blocker_id: BOB, blocked_id: ALICE }],
    ...over,
  };
}

describe("verifier finding 1 — a block, and an account that is not active", () => {
  it("CONTROL: the blocker's PROFILE is refused to the person they blocked (loadProfile, unchanged)", async () => {
    const [r] = await resolveShareProjections(makeFakeClient(blocked()) as unknown as SupabaseClient, ALICE, THREAD, [{ objectType: "PROFILE", objectId: BOB }]);
    assert.equal(r!.available, false);
  });

  it("the blocker's POST is refused too, and carries no handle", async () => {
    const r = await resolvePost(makeFakeClient(blocked()), POST_OK);
    assert.equal(r.available, false, JSON.stringify(r));
    assert.equal(!r.available && r.reason, "unauthorized");
    assert.ok(!JSON.stringify(r).includes("@bob"), `the blocker's handle reached the blocked viewer: ${JSON.stringify(r)}`);
  });

  it("the other direction too: a viewer who blocked the author is not served the author's post", async () => {
    const r = await resolvePost(makeFakeClient(blocked({ blocks: [{ blocker_id: ALICE, blocked_id: BOB }] })), POST_OK);
    assert.equal(r.available, false, JSON.stringify(r));
  });

  it("an unreadable blocks read is unknown — never 'no block'", async () => {
    const c = makeFakeClient(blocked({ blocks: [] }), { errors: { blocks: { message: "blocks unreadable" } } });
    const r = await resolvePost(c, POST_OK);
    assert.equal(r.available, false);
    assert.equal(!r.available && r.reason, "unknown");
  });

  it("a SUSPENDED author is not named: the post stays, the byline is withheld", async () => {
    const c = makeFakeClient(blocked({ blocks: [], profiles: [{ id: BOB, handle: "bob", account_status: "suspended" }] }));
    const r = await resolvePost(c, POST_OK);
    assert.equal(r.available, true);
    assert.equal(r.available && r.projection.subtitle, null, JSON.stringify(r));
  });

  it("CONTROL: the author reads their own post whatever the blocks say", async () => {
    const [r] = await resolveShareProjections(makeFakeClient(blocked()) as unknown as SupabaseClient, BOB, THREAD, [{ objectType: "POST", objectId: POST_OK }]);
    assert.equal(r!.available, true);
  });
});

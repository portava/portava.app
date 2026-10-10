/**
 * A shared POST card's `projectionVersion` never dates its author's departure.
 *
 * Found by lane M (mission 4, 2026-10-07): `loadPost` handed `posts.updated_at` to every
 * thread member as the card's `projectionVersion`. `trg_posts_updated` sets `updated_at` on
 * every UPDATE, and a "Publish after I leave" (`delayed_until_exit`) post is UPDATEd at the
 * geofence exit and again at release — so on a released post that value is the moment the
 * author left the place. Lane M's rule (`updatedAtForViewer`, PR #649) is inlined in
 * shareables.ts until #649 merges: anyone but the author gets the post's creation instant on
 * a delayed_until_exit row, and on a row whose mode was not read (fail closed); every other
 * post's `updated_at` is an edit time and is served as it is; the author's own card keeps it.
 *
 * WHAT IS EXERCISED: the real `resolveShareProjections` → `loadPost` over the certification
 * harness's PostgREST fake (which returns whole rows, so the select list is pinned separately).
 *
 * Run: node --import tsx/esm --test src/test/telegraphPostVersionReleaseTiming.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveShareProjections } from "../services/telegraph/shareables.js";
import { makeFakeClient } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // a thread member, not the author
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // the author
const THREAD = "dddddddd-0000-4000-8000-00000000000d";
const POST_DELAYED = "11110000-0000-4000-8000-000000000001";
const POST_ORDINARY = "11110000-0000-4000-8000-000000000002";
const POST_MODE_UNREAD = "11110000-0000-4000-8000-000000000003";
const POST_TIMED = "11110000-0000-4000-8000-000000000004";

const CREATED = "2026-05-01T09:00:00.000Z";
const LEFT_AT = "2026-05-01T21:47:00.000Z"; // the release UPDATE: when BOB left the place
const EDITED = "2026-05-02T08:15:00.000Z";

function post(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id, author_id: BOB, content: "A bar with no sign", visibility: "public", status: "active",
    post_status: "published", deleted_at: null, media_urls: [], created_at: CREATED, ...extra,
  };
}

function seed(): Record<string, Record<string, unknown>[]> {
  const unread = post(POST_MODE_UNREAD, { updated_at: LEFT_AT });
  return {
    posts: [
      post(POST_DELAYED, { location_privacy_mode: "delayed_until_exit", updated_at: LEFT_AT }),
      post(POST_ORDINARY, { location_privacy_mode: "none", updated_at: EDITED }),
      unread, // no location_privacy_mode key at all: the mode was not read
      post(POST_TIMED, { location_privacy_mode: "delayed_until_time", updated_at: EDITED }),
    ],
    profiles: [{ id: BOB, handle: "bob", account_status: "active" }],
    blocks: [],
  };
}

async function versionFor(viewer: string, postId: string, client = makeFakeClient(seed())) {
  const [r] = await resolveShareProjections(client as unknown as SupabaseClient, viewer, THREAD, [
    { objectType: "POST", objectId: postId },
  ]);
  assert.ok(r && r.available, `post ${postId} resolves for ${viewer}`);
  return r.available ? r.projection.projectionVersion : undefined;
}

describe("POST share card — projectionVersion never carries a departure instant", () => {
  it("a released 'Publish after I leave' post: another member is given its CREATION instant, not the release", async () => {
    const v = await versionFor(ALICE, POST_DELAYED);
    assert.equal(v, CREATED);
    assert.notEqual(v, LEFT_AT, "the release UPDATE's updated_at dates when the author left");
  });

  it("the AUTHOR's own card keeps updated_at", async () => {
    assert.equal(await versionFor(BOB, POST_DELAYED), LEFT_AT);
  });

  it("a row whose mode was not read is treated as delayed (fail closed)", async () => {
    assert.equal(await versionFor(ALICE, POST_MODE_UNREAD), CREATED);
  });

  it("an ordinary post keeps its edit time for every member (the rule is not a blanket rewrite)", async () => {
    assert.equal(await versionFor(ALICE, POST_ORDINARY), EDITED);
    assert.equal(await versionFor(ALICE, POST_TIMED), EDITED, "delayed_until_time releases at a time the author chose, not a departure");
  });

  it("the loader reads the two columns the rule needs (the fake returns whole rows, so the select is pinned here)", async () => {
    const client = makeFakeClient(seed());
    await versionFor(ALICE, POST_ORDINARY, client);
    const sel = client._observed.selects.find((s) => s.table === "posts")?.sel ?? "";
    const cols = sel.split(",").map((c) => c.trim());
    assert.ok(cols.includes("location_privacy_mode"), `posts select names location_privacy_mode: ${sel}`);
    assert.ok(cols.includes("created_at"), `posts select names created_at: ${sel}`);
  });
});

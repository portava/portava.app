/**
 * Telegraph §7.2 / census T79 — a deleted message's MEDIA is removed from
 * normal retrieval, not just its caption.
 *
 * Spec (v1 and v1_1, §7.2 "Unsend / delete"):
 *   "Remove from normal retrieval, search and projections."
 *
 * The census scored T79 W with a precise finding: `routes/messaging.ts`
 * suppressed `body` on `deleted_at` and returned `media_url`,
 * `media_thumbnail_url`, `media_type` and `media_duration_seconds`
 * unconditionally, so deleting a photo redacted the caption and left the asset
 * addressable. The URL is a directly fetchable object; a redaction that leaves
 * it in the payload is not a redaction.
 *
 * What is asserted here is the behaviour of the REAL route, driven end to end
 * through the certification harness:
 *
 *   - a deleted media message comes back as a tombstone with all four media
 *     fields null, and with the field PRESENT and null rather than absent — an
 *     absent field and a null one are different contracts to an older client,
 *     and a test that accepts `undefined` cannot tell a fix from a deletion;
 *   - the tombstone still says a message was here: `deleted: true`, its id, its
 *     sender and its time survive, because §7.2 removes the CONTENT and not the
 *     fact;
 *   - a LIVE media message in the same read is untouched, so the redaction is
 *     conditioned on deletion and not on the route having lost the columns;
 *   - the deleted row's media is absent from the whole serialized response, by
 *     scanning the raw JSON for the asset path. A field-by-field assertion
 *     passes if the URL leaks through some other key; this one does not.
 *
 * SHOWN RED before green (5 pass / 0 fail): the four `isDeleted ? null : …`
 * guards in routes/messaging.ts reverted to the unconditional reads the census
 * found — `mediaUrl: (m as any).media_url ?? null` and its three neighbours.
 * Result 3 pass / 2 fail: the field assertion and the payload scan. The other
 * three stay green on purpose and the count is recorded rather than rounded up
 * — the tombstone and the live-media cases are controls, and a mutation that
 * turned THEM red would mean the guard had eaten the wrong rows. The file was
 * restored afterwards and compared byte-for-byte with `cmp` against a
 * pre-mutation copy.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphDeletedMediaRedaction.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import {
  makeFakeClient,
  startRouter,
  call,
  resetFakeIds,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "00000000-0000-4000-8000-00000000000a";

const M_DELETED_MEDIA = "11111111-0000-4000-8000-000000000001";
const M_LIVE_MEDIA = "22222222-0000-4000-8000-000000000002";
const M_DELETED_TEXT = "33333333-0000-4000-8000-000000000003";

/** The asset the census called "still addressable". */
const DELETED_ASSET = "https://cdn.example.test/telegraph/deleted-photo.jpg";
const DELETED_THUMB = "https://cdn.example.test/telegraph/deleted-photo-thumb.jpg";
const LIVE_ASSET = "https://cdn.example.test/telegraph/live-photo.jpg";
const LIVE_THUMB = "https://cdn.example.test/telegraph/live-photo-thumb.jpg";

function mediaMsg(
  id: string,
  created_at: string,
  deleted_at: string | null,
  url: string | null,
  thumb: string | null,
): Record<string, unknown> {
  return {
    id,
    thread_id: THREAD,
    sender_id: ALICE,
    body: "at the pier",
    created_at,
    deleted_at,
    edited_at: null,
    original_language: null,
    msg_type: "media",
    subtype: null,
    media_url: url,
    media_type: url ? "image" : null,
    media_thumbnail_url: thumb,
    media_duration_seconds: url ? 12 : null,
    reply_to_id: null,
  };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
    ],
    blocks: [],
    message_threads: [
      {
        id: THREAD,
        thread_type: "direct",
        trip_id: null,
        circle_owner_id: null,
        title: null,
        status: "active",
        is_e2ee: false,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-03-11T00:00:00.000Z",
        last_message_at: "2026-03-11T00:00:00.000Z",
      },
    ],
    message_thread_members: [
      {
        thread_id: THREAD, user_id: ALICE, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
      },
      {
        thread_id: THREAD, user_id: BOB, role: "member",
        joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
        last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
      },
    ],
    messages: [
      mediaMsg(M_DELETED_MEDIA, "2026-03-10T00:00:00.000Z", "2026-03-10T01:00:00.000Z",
        DELETED_ASSET, DELETED_THUMB),
      mediaMsg(M_LIVE_MEDIA, "2026-03-11T00:00:00.000Z", null, LIVE_ASSET, LIVE_THUMB),
    ],
    message_translations: [],
  };
}

let harness: RouterHarness;

function use(state: Record<string, any[]>): FakeClient {
  const c = makeFakeClient(state);
  _setTestClient(c, true);
  return c;
}

before(async () => {
  harness = await startRouter(messagingRouter);
});
after(async () => {
  await harness.close();
});
beforeEach(() => {
  resetFakeIds();
});

describe("§7.2 T79 — deleting a photo removes the photo, not only the caption", () => {
  it("returns all four media fields as null on a deleted message, PRESENT and null", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    assert.equal(r.status, 200);

    const gone = (r.body.messages as any[]).find((m) => m.id === M_DELETED_MEDIA);
    assert.ok(gone, "the tombstone must still be returned");

    for (const field of ["mediaUrl", "mediaType", "mediaThumbnailUrl", "mediaDurationSeconds"]) {
      assert.ok(field in gone, `${field} must be PRESENT on the tombstone, not dropped from the payload`);
      assert.equal(
        gone[field], null,
        "EXPECTED BY §7.2: a deleted message is removed from normal retrieval. " +
          `ACTUAL: ${field} = ${JSON.stringify(gone[field])} — the asset is still addressable.`,
      );
    }
  });

  it("keeps the tombstone itself — §7.2 removes the content, not the fact", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    const gone = (r.body.messages as any[]).find((m) => m.id === M_DELETED_MEDIA);
    assert.equal(gone.deleted, true);
    assert.equal(gone.body, null);
    assert.equal(gone.senderId, ALICE);
    assert.equal(gone.createdAt, "2026-03-10T00:00:00.000Z");
  });

  it("leaves a LIVE media message in the same read untouched", async () => {
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    const live = (r.body.messages as any[]).find((m) => m.id === M_LIVE_MEDIA);
    assert.ok(live, "the live message must still be returned");
    assert.equal(live.mediaUrl, LIVE_ASSET);
    assert.equal(live.mediaType, "image");
    assert.equal(live.mediaThumbnailUrl, LIVE_THUMB);
    assert.equal(live.mediaDurationSeconds, 12);
  });

  it("the deleted asset appears NOWHERE in the serialized response", async () => {
    // Field-by-field assertions pass if the URL leaks through a different key
    // — a preview, a reply context, a projection. The payload is the contract,
    // so the payload is what is scanned.
    use(seed());
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    const wire = JSON.stringify(r.body);
    assert.equal(
      wire.includes("deleted-photo"), false,
      "the deleted message's asset path is still somewhere in the response body",
    );
    assert.equal(
      wire.includes("live-photo"), true,
      "sanity: the live asset IS in the same response, so the scan can tell them apart",
    );
  });

  it("a deleted NON-media message is unaffected by the guard", async () => {
    // The guard is conditioned on deletion, not on media. A text tombstone
    // carried nulls before this change and must still carry them.
    const s = seed();
    s.messages.push({
      ...mediaMsg(M_DELETED_TEXT, "2026-03-09T00:00:00.000Z", "2026-03-09T01:00:00.000Z", null, null),
      msg_type: "text",
    });
    use(s);
    const r = await call(harness.base, "GET", `/threads/${THREAD}/messages`, BOB);
    const t = (r.body.messages as any[]).find((m) => m.id === M_DELETED_TEXT);
    assert.equal(t.deleted, true);
    assert.equal(t.mediaUrl, null);
  });
});

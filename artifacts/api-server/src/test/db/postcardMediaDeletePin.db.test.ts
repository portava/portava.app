/**
 * The service-client door and the database's own pin agree (2026-10-24).
 *
 * DELETE /postcards/:id/media/:mediaId runs on the SERVICE client, which 3909's
 * RLS policy post_media_owner_delete does not bind. The route now applies that
 * pin itself (routes/postcards.ts isModerationPinnedPostMedia). This suite holds
 * the two to ONE answer on the replayed chain: for every moderation_status the
 * table's CHECK admits, an owner DELETE under RLS removes the row exactly when
 * the route's predicate says the row is NOT pinned. (The chain's authenticated
 * role holds no DELETE on post_media at all, so the policy is read inside a
 * rolled-back transaction that grants it — which also shows the service-client
 * routes are the only delete door, and why the route must pin.) A future verdict value that
 * the database pins and the route does not (or the reverse) turns this red.
 *
 * It also pins the columns account deletion's collect_post_media_url_paths
 * names (posts.media_urls text[], posts.media_thumbnail_url): an unknown column
 * would fail that step on every deletion.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/postcardMediaDeletePin.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, scalar, seedUser, deleteUser } from "./localDb.js";
import { isModerationPinnedPostMedia } from "../../routes/postcards.js";

const CANDIDATES = ["pending", "approved", "flagged", "rejected", "processing", "active", "limited", "removed", "owner_deleted"];

const asOwner = (uid: string) =>
  `DO $p$ BEGIN PERFORM set_config('request.jwt.claim.sub', '${uid}', true); PERFORM set_config('request.jwt.claim.role', 'authenticated', true); END $p$;\nSET LOCAL ROLE authenticated;\n`;

let OWNER = "";
let POST = "";

describe("postcard media DELETE — the route's pin is the database's pin", { skip: !HAVE_DB }, () => {
  before(() => {
    OWNER = seedUser("pcpin-owner");
    POST = randomUUID();
    exec(`INSERT INTO public.posts (id, author_id, content, visibility, status) VALUES ('${POST}', '${OWNER}', 'pcpin post', 'public', 'active');`);
  });

  after(() => {
    if (!OWNER) return;
    exec(`DELETE FROM public.post_media WHERE user_id = '${OWNER}';
          DELETE FROM public.post_media_moderation_ledger WHERE subject_user_id = '${OWNER}';
          DELETE FROM public.posts WHERE author_id = '${OWNER}';`);
    deleteUser(OWNER);
  });

  it("P1 — for every status the CHECK admits, RLS lets the owner delete exactly when the route does", () => {
    let admitted = 0;
    let pinned = 0;
    for (const status of CANDIDATES) {
      const key = `${OWNER}/pcpin-${status}-${randomUUID()}.jpg`;
      // The server path: the service role writes the row (pinned to its default),
      // then a moderator sets the verdict. All rolled back.
      const r = psql(`BEGIN;
        SET LOCAL ROLE service_role;
        INSERT INTO public.post_media (post_id, user_id, media_type, mime_type, storage_path) VALUES ('${POST}', '${OWNER}', 'image', 'image/jpeg', '${key}');
        UPDATE public.post_media SET moderation_status = '${status}' WHERE storage_path = '${key}';
        RESET ROLE;
        -- On the chain (as on production) authenticated holds NO table DELETE on
        -- post_media, so the service-client routes are the ONLY delete door and the
        -- policy is never consulted for a client. To read the policy's answer,
        -- grant DELETE inside this rolled-back transaction only.
        GRANT DELETE ON public.post_media TO authenticated;
        ${asOwner(OWNER)}WITH d AS (DELETE FROM public.post_media WHERE storage_path = '${key}' RETURNING 1) SELECT 'deleted=' || count(*) FROM d;
        ROLLBACK;`);
      if (r.status !== 0 && /check constraint/i.test(r.stderr)) continue; // not a value this chain admits
      assert.equal(r.status, 0, `${status}: ${r.stderr}`);
      admitted += 1;
      const dbDeleted = /deleted=1/.test(r.stdout);
      const routePinned = isModerationPinnedPostMedia(status);
      if (routePinned) pinned += 1;
      assert.equal(dbDeleted, !routePinned, `'${status}': the database ${dbDeleted ? "lets the owner delete it" : "pins it"}, the route ${routePinned ? "pins it" : "deletes it"}`);
    }
    assert.ok(admitted >= 4, `anti-vacuity: at least 0103's four statuses ran (${admitted})`);
    assert.ok(pinned >= 2, `anti-vacuity: rejected and flagged were both exercised (${pinned})`);
  });

  it("P2 — the columns collect_post_media_url_paths reads exist with the shape it assumes", () => {
    assert.equal(scalar(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attname = 'media_urls' AND NOT attisdropped`), "text[]");
    assert.equal(scalar(`SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'public.posts'::regclass AND attname = 'media_thumbnail_url' AND NOT attisdropped`), "text");
  });
});

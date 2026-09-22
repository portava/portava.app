/**
 * Bucket privacy — object-level authorization matrix + /media/file endpoint.
 * Run: node --import tsx/esm --test src/test/mediaAccess.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { authorizeMediaAccess, ownerFromPath, _clearMediaAccessCache } from "../lib/mediaAccess.js";
import { authorizeMediaAttachment, authorizeMediaContext } from "../lib/mediaVisibility.js";
import mediaFileRouter from "../routes/mediaFile.js";
import { PUBLISHED_STORY_RETENTION } from "../services/stories/storyRetentionPolicy.js";

const SB = "http://sb.example.test";
const OLD_SUPABASE_URL = process.env.SUPABASE_URL;

const OWNER  = "a1000000-0000-4000-a000-000000000001";
const VIEWER = "a1000000-0000-4000-a000-000000000002";
const TRIP   = "b1000000-0000-4000-a000-000000000001";
const THREAD = "c1000000-0000-4000-a000-000000000001";
const TOKEN  = "media-access-token";

const pub = (path: string) => `${SB}/storage/v1/object/public/post-media/${path}`;

interface FakeState {
  flags?: Record<string, boolean>;
  blocks?: any[];
  posts?: any[];
  postMedia?: any[];
  messages?: any[];
  threadMembers?: any[];
  stories?: any[];
  highlights?: any[];
  trips?: any[];
  tripMembers?: any[];
  closeFriends?: any[];
  mediaAssets?: any[];
  // profile-media authorization
  profiles?: any[];
  profilePrivacySettings?: any[];
  userAccountStates?: any[];
  userFriendships?: any[];
  userFollows?: any[];
  // generated-visual authorization
  generatedVisuals?: any[];
  events?: any[];
  eventRsvps?: any[];
  eventRoles?: any[];
  // contextual visibility (lib/mediaVisibility)
  visibilityOverrides?: any[];
  attachments?: any[];
  /**
   * Per-table read failure, in the shape PostgREST RESOLVES with rather than
   * throws. A branch that cannot read its table must decide what that means,
   * and the only way to test that decision is to make the read fail.
   */
  tableErrors?: Record<string, { code?: string; message: string }>;
}

/**
 * Tables whose SELECT LIST this fake enforces against the LIVE column set.
 *
 * A mock that ignores `select()` answers a query naming a column the table does
 * not have exactly as it answers a correct one, so it cannot fail on the single
 * most common defect in this tree: a read spelled against a column that is not
 * there. PostgREST does not throw for that — it RESOLVES `{ data: null, error:
 * 42703 }`, which every `!error && Boolean(data)` site in the codebase then
 * reads as a clean "no row". Naming a column outside the set below therefore
 * produces that exact shape here.
 *
 * `user_follows` is the one that matters right now: it is
 * (follower_id, following_id, created_at) in BOTH production and CI, with no
 * `id`, and lib/mediaVisibility used to select one.
 */
const LIVE_COLUMNS: Record<string, readonly string[]> = {
  user_follows: ["follower_id", "following_id", "created_at"],
  // `post_media` has NO `media_asset_id`. Naming one here would fail the whole
  // 3a read, and 3a binds its error and denies — so the mistake would take
  // every post-media object with it rather than degrading quietly.
  post_media: [
    "id", "post_id", "user_id", "media_type", "mime_type", "storage_bucket",
    "storage_path", "public_url", "thumbnail_storage_path", "thumbnail_url",
    "feed_storage_path", "feed_url", "width", "height", "duration_seconds",
    "file_size_bytes", "sort_order", "moderation_status", "processing_status",
    "phash", "dedup_processed", "canonical_place_id", "stamp_overlay",
    "created_at", "updated_at",
  ],
  media_attachments: [
    "id", "media_asset_id", "entity_type", "entity_id",
    "position", "is_cover", "visibility_override", "created_at",
  ],
  circle_member_visibility_overrides: [
    "id", "user_id", "target_user_id", "context_type",
    "context_id", "direction", "hidden", "created_at",
  ],
};

/** The PostgREST shape for "column does not exist" — resolved, never thrown. */
function undefinedColumn(table: string, column: string) {
  return {
    data: null,
    error: {
      code: "42703",
      message: `column ${table}.${column} does not exist`,
    },
  };
}

function makeClient(state: FakeState = {}) {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const src = () =>
      table === "feature_flags" ? Object.entries(state.flags ?? {}).map(([flag, enabled]) => ({ flag, enabled })) :
      table === "blocks" ? state.blocks ?? [] :
      table === "posts" ? state.posts ?? [] :
      table === "post_media" ? state.postMedia ?? [] :
      table === "messages" ? state.messages ?? [] :
      table === "message_thread_members" ? state.threadMembers ?? [] :
      table === "stories" ? state.stories ?? [] :
      table === "highlights" ? state.highlights ?? [] :
      table === "trips" ? state.trips ?? [] :
      table === "trip_members" ? state.tripMembers ?? [] :
      table === "close_friends" ? state.closeFriends ?? [] :
      table === "media_assets" ? state.mediaAssets ?? [] :
      table === "profiles" ? state.profiles ?? [] :
      table === "profile_privacy_settings" ? state.profilePrivacySettings ?? [] :
      table === "user_account_states" ? state.userAccountStates ?? [] :
      table === "user_friendships" ? state.userFriendships ?? [] :
      table === "user_follows" ? state.userFollows ?? [] :
      table === "generated_visuals" ? state.generatedVisuals ?? [] :
      table === "events" ? state.events ?? [] :
      table === "event_rsvps" ? state.eventRsvps ?? [] :
      table === "event_roles" ? state.eventRoles ?? [] :
      table === "circle_member_visibility_overrides" ? state.visibilityOverrides ?? [] :
      table === "media_attachments" ? state.attachments ?? [] : [];
    // Column projection for "profiles" only: the avatar-gating tests below
    // must actually exercise the SELECT string in mediaAccess.ts, not just
    // the row data — a mock that ignores select() and always returns full
    // rows would keep passing even if the code stopped selecting the column
    // it gates on. Other tables aren't projected (nothing here reads a
    // column via select() and checks its own row shape beyond truthiness).
    let profileCols: string[] | null = null;
    /** Set when this query named a column the live table does not have. */
    let unknownColumn: string | null = null;
    const rows = () => {
      const base = src().filter((r: any) => filters.every((f) => f(r)));
      if (table !== "profiles" || !profileCols) return base;
      return base.map((r: any) =>
        Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])),
      );
    };
    const b: any = {
      select(cols?: string) {
        if (typeof cols === "string" && cols !== "*") {
          const named = cols.split(",").map((c) => c.trim()).filter(Boolean);
          if (table === "profiles") profileCols = named;
          const live = LIVE_COLUMNS[table];
          if (live) {
            unknownColumn = named.find((c) => !live.includes(c)) ?? null;
          }
        }
        return b;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      is(col: string, val: any) { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      contains(col: string, vals: any[]) {
        filters.push((r) => Array.isArray(r[col]) && vals.every((v) => r[col].includes(v)));
        return b;
      },
      // Array overlap: true when the row's array shares ANY element with vals.
      // (`contains` above is the all-of variant; PostgREST spells them cs/ov.)
      overlaps(col: string, vals: any[]) {
        filters.push((r) => Array.isArray(r[col]) && vals.some((v) => r[col].includes(v)));
        return b;
      },
      // Splits on TOP-LEVEL commas only, so an `in.("a","b")` list is not torn
      // apart by the comma inside its own parentheses. The previous parser split
      // on every comma and silently produced garbage filters for any operand
      // carrying one — which is why mediaAccess's message branch could not be
      // tested with an `in` list until now.
      or(expr: string) {
        const clauses: string[] = [];
        let depth = 0, cur = "";
        for (const ch of expr) {
          if (ch === "(") depth++;
          if (ch === ")") depth--;
          if (ch === "," && depth === 0) { clauses.push(cur); cur = ""; continue; }
          cur += ch;
        }
        if (cur.trim()) clauses.push(cur);

        const preds = clauses.map((c) => {
          const m = c.trim().match(/^(\w+)\.(\w+)\.(.*)$/);
          if (!m) return () => false;
          const [, col, op, rawVal] = m;
          if (op === "in") {
            const vals = (rawVal.match(/"((?:[^"\\]|\\.)*)"/g) ?? [])
              .map((q) => q.slice(1, -1).replace(/\\"/g, '"'));
            return (r: any) => vals.includes(String(r[col]));
          }
          return (r: any) => String(r[col]) === rawVal;
        });
        filters.push((r) => preds.some((f) => f(r)));
        return b;
      },
      limit() { return b; }, not() { return b; }, order() { return b; },
      maybeSingle() {
        if (unknownColumn) return Promise.resolve(undefinedColumn(table, unknownColumn));
        const injected = state.tableErrors?.[table];
        if (injected) return Promise.resolve({ data: null, error: injected });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      then(onF: any, onR: any) {
        if (unknownColumn) return Promise.resolve(undefinedColumn(table, unknownColumn)).then(onF, onR);
        const injected = state.tableErrors?.[table];
        if (injected) return Promise.resolve({ data: null, error: injected }).then(onF, onR);
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from: builder,
    storage: {
      from(bucket: string) {
        return {
          createSignedUrl: async (path: string, ttl: number) => ({
            data: { signedUrl: `${SB}/storage/v1/object/sign/${bucket}/${path}?token=signed&ttl=${ttl}` },
            error: null,
          }),
        };
      },
    },
    auth: {
      getUser: async (t: string) => t === TOKEN
        ? { data: { user: { id: VIEWER } }, error: null }
        : { data: { user: null }, error: { message: "bad" } },
    },
  } as any;
}

before(() => { process.env.SUPABASE_URL = SB; });
after(() => { process.env.SUPABASE_URL = OLD_SUPABASE_URL; });
beforeEach(() => _clearMediaAccessCache());

describe("ownerFromPath", () => {
  it("extracts owner from all path conventions", () => {
    assert.equal(ownerFromPath(`${OWNER}/123.jpg`), OWNER);
    assert.equal(ownerFromPath(`stories/${OWNER}/x.jpg`), OWNER);
    assert.equal(ownerFromPath(`memories/${OWNER}/y.jpg`), OWNER);
    assert.equal(ownerFromPath("weird/prefix/z.jpg"), null);
  });
});

// ── Canonicalized (bare-key) column values ───────────────────────────────────
//
// RED-PROOF for the regression that 2081_canonicalize_absolute_storage_urls.sql
// caused and that this suite did not catch.
//
// Branches 3b-3f decide access by finding the object's URL in a column. They
// matched only the ABSOLUTE `<origin>/storage/v1/object/public/<bucket>/<path>`
// form. 2081 rewrote those durable columns to the canonical BARE KEY
// `<bucket>/<path>`, so the lookups stopped matching, every branch fell
// through, and the deny-by-default at the end of the chain took over.
//
// The effect on production was narrow and total: three live PUBLIC posts whose
// media loaded for their author (branch 1's path-owner shortcut fires before
// any of this) and for nobody else. Every existing test in this file stored the
// absolute form via pub(), so the whole matrix stayed green.
//
// Each test below is paired: the absolute form (the pre-2081 encoding, which a
// database without that migration still holds) and the bare key (post-2081).
// Both must authorize, because both name the same object.
describe("authorizeMediaAccess — bare-key column values (post-2081)", () => {
  const path = `${OWNER}/1785019420319.jpg`;
  const bare = `post-media/${path}`;
  const publicPost = (urls: string[]) => ({
    author_id: OWNER, visibility: "public", status: "active",
    post_status: "published", trip_id: null, media_urls: urls,
  });

  it("3b posts.media_urls — absolute form authorizes", async () => {
    const sc = makeClient({ posts: [publicPost([pub(path)])] });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
  });

  it("3b posts.media_urls — BARE KEY authorizes", async () => {
    const sc = makeClient({ posts: [publicPost([bare])] });
    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", path), true,
      "a post whose media_urls holds the canonical bare key must still authorize its viewers",
    );
  });

  it("AT-16: 3b — a bare key in a PRIVATE post still denies", async () => {
    // The fix must widen which encodings are recognised, never which objects
    // are reachable. If this ever passes, the fix has become a fail-open.
    const sc = makeClient({
      posts: [{ ...publicPost([bare]), visibility: "private" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false);
  });

  it("3d stories.media_url — bare key authorizes a public story", async () => {
    const sc = makeClient({
      stories: [{ owner_id: OWNER, state: "active", visibility: "public", close_friends_only: false, expires_at: null, media_url: bare }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
  });

  it("3e highlights.media_url — bare key authorizes a public highlight", async () => {
    const sc = makeClient({
      highlights: [{ owner_id: OWNER, visibility: "public", expires_at: null, media_url: bare }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
  });

  it("3e a public highlight pointing at ANOTHER user's object is DENIED (owner mismatch)", async () => {
    // Attacker makes a public highlight whose media_url is OWNER's private key.
    // The object owner (from the key) is OWNER, but the highlight is owned by the
    // attacker, so it must not republish OWNER's bytes on its own authority.
    const ATTACKER = "99999999-9999-4999-8999-999999999999";
    const sc = makeClient({
      highlights: [{ owner_id: ATTACKER, visibility: "public", expires_at: null, media_url: bare }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false);
  });

  it("3b a post whose media_urls holds ANOTHER user's object does NOT authorize its author (MEDIA-1)", async () => {
    // The attacker (VIEWER) puts OWNER's private storage key in their OWN public
    // post's media_urls, then requests the object. The object's owner (from the
    // key) is OWNER; the post is the attacker's, so it must not republish OWNER's
    // bytes on its own authority — the exact trap 3d/3e already guard.
    const sc = makeClient({
      posts: [{
        author_id: VIEWER, visibility: "public", status: "active",
        post_status: "published", trip_id: null, media_urls: [bare],
      }],
    });
    assert.equal(
      await authorizeMediaAccess(sc, VIEWER, "post-media", path), false,
      "an attacker's own post carrying a victim's storage key must not authorize the attacker",
    );
  });

  it("3f trips.cover_url — bare key authorizes a trip member", async () => {
    const sc = makeClient({
      trips: [{ id: TRIP, owner_id: OWNER, cover_url: bare }],
      tripMembers: [{ trip_id: TRIP, user_id: VIEWER, role: "member" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
  });

  it("3c messages.media_url — bare key authorizes a thread member", async () => {
    // `sender_id` is OWNER because `path` is OWNER's key and `messages.sender_id`
    // is NOT NULL: a row where the sender did not own the object it carries is the
    // attack below, not a shape this fixture should have modelled.
    const sc = makeClient({
      messages: [{ thread_id: THREAD, sender_id: OWNER, media_url: bare, media_thumbnail_url: null }],
      threadMembers: [{ thread_id: THREAD, user_id: VIEWER, left_at: null }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
  });

  it("3c a message carrying ANOTHER user's object does NOT authorize the thread (MEDIA-2)", async () => {
    // The last of the four branches to get the ownership test 3b/3d/3e carry.
    // ATTACKER writes a message into a thread they are in, whose media_url is
    // OWNER's private storage key, then asks for the object. `post-media` is a
    // PRIVATE bucket, so what is at stake is the BYTES, not a preview.
    const ATTACKER = "99999999-9999-4999-8999-999999999999";
    const sc = makeClient({
      messages: [{ thread_id: THREAD, sender_id: ATTACKER, media_url: bare, media_thumbnail_url: null }],
      threadMembers: [
        { thread_id: THREAD, user_id: ATTACKER, left_at: null },
        { thread_id: THREAD, user_id: VIEWER, left_at: null },
      ],
    });
    assert.equal(await authorizeMediaAccess(sc, ATTACKER, "post-media", path), false);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false);
  });

  it("3c an UNATTRIBUTABLE object is denied rather than given the benefit of the doubt", async () => {
    // No media_assets row and a path whose first segment is not a uuid, so
    // `owner` is null. 3d and 3e already deny that; 3c now agrees.
    const orphan = "misc/no-owner-here.jpg";
    const sc = makeClient({
      messages: [{ thread_id: THREAD, sender_id: OWNER, media_url: `${SB}/storage/v1/object/public/post-media/${orphan}`, media_thumbnail_url: null }],
      threadMembers: [{ thread_id: THREAD, user_id: VIEWER, left_at: null }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", orphan), false);
  });

  it("an object referenced by nothing is still denied in either encoding", async () => {
    const sc = makeClient({});
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false);
  });
});

describe("authorizeMediaAccess — the matrix", () => {
  it("owner always allowed (path-prefix ownership)", async () => {
    const sc = makeClient();
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", `${OWNER}/a.jpg`), true);
  });

  // ── the owner's own bytes, after the owner deleted the story ─────────────
  // The owner asked for this to be closed, 2026-09-22: "Owner access must
  // still respect deletion/recovery state, account deletion, permanent purge,
  // and other authorization rules. 'No audience-expiry deadline' must not mean
  // unrestricted access."
  //
  // The short-circuit above used to be unconditional, which was right while
  // expiry deleted the file — there was nothing left to serve. Expired stories
  // are now kept for the owner's archive, so the bytes survive a deletion that
  // used to take them, and "deleted" has to keep meaning deleted.

  // The windows come from services/stories/storyRetentionPolicy.ts. These
  // fixtures place `deleted_at` relative to them rather than hard-coding a
  // number of days, so changing a published window moves these tests with it
  // instead of quietly making them assert the old policy.
  const DAY = 86_400_000;
  const RECOVERY_DAYS = PUBLISHED_STORY_RETENTION.deletedRecoveryDays;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  it("serves the owner a deleted story INSIDE its recovery window", async () => {
    // The archive's Deleted tab renders each recoverable story's thumbnail.
    // Denying here blanks every row and asks the owner to choose what to
    // restore from a list of grey squares — a disclosed recovery window the
    // owner cannot see into is not the window that was published.
    const path = `${OWNER}/story-recoverable.jpg`;
    const sc = makeClient({
      stories: [{
        owner_id: OWNER, state: "deleted", media_url: pub(path),
        expires_at: ago(2), deleted_at: ago(1),
      }],
    });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), true);
  });

  it("denies the owner their own bytes once the recovery window has CLOSED", async () => {
    // The gap this branch exists for: the window is over and the hourly job
    // has not reached the row yet. Nothing else withholds the object in that
    // gap, so without this the last promise the copy makes about a deleted
    // story is kept only by a scheduler's timing.
    const path = `${OWNER}/story-del.jpg`;
    const sc = makeClient({
      stories: [{
        owner_id: OWNER, state: "deleted", media_url: pub(path),
        expires_at: ago(RECOVERY_DAYS + 5), deleted_at: ago(RECOVERY_DAYS + 1),
      }],
    });
    assert.equal(
      await authorizeMediaAccess(sc, OWNER, "post-media", path),
      false,
      "the owner deleted this and the window has closed; serving it makes 'deleted' mean 'unlisted'",
    );
  });

  it("denies a deleted story whose deleted_at is missing, rather than guessing a window", async () => {
    // 2998's trigger sets `deleted_at` on every transition into 'deleted', so
    // a null here is a row the trigger never touched or a trigger that failed.
    // Either way the window cannot be established, and a branch that cannot
    // decide denies.
    const path = `${OWNER}/story-noclock.jpg`;
    const sc = makeClient({
      stories: [{
        owner_id: OWNER, state: "deleted", media_url: pub(path),
        expires_at: ago(2), deleted_at: null,
      }],
    });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), false);
  });

  it("closes the window at the ARCHIVE deadline when that comes first", async () => {
    // retentionDatesFor caps the recovery window at the archive deadline, so a
    // story deleted close to that deadline has a shorter window than the
    // nominal one. The relay has to enforce the date the archive PRINTED, not
    // the nominal number, or the two halves disagree about the same row.
    const path = `${OWNER}/story-capped.jpg`;
    const beyondArchive = PUBLISHED_STORY_RETENTION.archiveRetentionDays + 1;
    const sc = makeClient({
      stories: [{
        owner_id: OWNER, state: "deleted", media_url: pub(path),
        expires_at: ago(beyondArchive),   // archive deadline already past
        deleted_at: ago(0),               // deleted just now: nominally 30 days left
      }],
    });
    assert.equal(
      await authorizeMediaAccess(sc, OWNER, "post-media", path),
      false,
      "a fresh deletion cannot buy a window past the archive deadline it already had",
    );
  });

  it("still serves the owner an EXPIRED story — expiry is an audience boundary, not an owner one", async () => {
    // This is the archive. If expiry denied the owner too there would be
    // nothing to build an archive out of.
    const path = `${OWNER}/story-exp.jpg`;
    const sc = makeClient({
      stories: [{
        owner_id: OWNER, state: "expired", media_url: pub(path),
        expires_at: ago(5),
      }],
    });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), true);
  });

  it("serves the owner a story again once it is recovered", async () => {
    // Recovery writes state='expired'; the media route must follow the row
    // rather than remember the refusal. Nothing caches post-media decisions,
    // and this is the test that says so.
    const path = `${OWNER}/story-rec.jpg`;
    const deleted = makeClient({
      stories: [{
        owner_id: OWNER, state: "deleted", media_url: pub(path),
        expires_at: ago(RECOVERY_DAYS + 5), deleted_at: ago(RECOVERY_DAYS + 1),
      }],
    });
    assert.equal(await authorizeMediaAccess(deleted, OWNER, "post-media", path), false);

    const recovered = makeClient({
      stories: [{
        owner_id: OWNER, state: "expired", media_url: pub(path),
        expires_at: ago(RECOVERY_DAYS + 5), deleted_at: null,
      }],
    });
    assert.equal(
      await authorizeMediaAccess(recovered, OWNER, "post-media", path),
      true,
      "recovery must restore the owner's access, not leave a story they can see listed but not open",
    );
  });

  it("denies the owner when the stories table cannot be read", async () => {
    // A read that failed has not established that the story is live. The
    // audience side of this same boundary answers an unreadable row with the
    // most restrictive deadline; the owner side answering "sure, here it is"
    // would be the two halves of one rule disagreeing. The cost — the owner's
    // media does not serve while `stories` is down — is real and accepted: a
    // deletion promise that holds only while the database is healthy is not a
    // promise.
    const path = `${OWNER}/story-err.jpg`;
    const sc = makeClient({
      stories: [{ owner_id: OWNER, state: "expired", media_url: pub(path), expires_at: null }],
      tableErrors: { stories: { code: "57014", message: "statement timeout" } },
    });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), false);
  });

  it("does not let someone else's deleted story revoke the object owner's access", async () => {
    // A row claiming "this is my media" while pointing at another user's key is
    // exactly what branch 3d refuses in the other direction. It must not work
    // as a way to blank an object out of its owner's own archive either.
    const path = `${OWNER}/story-hijack.jpg`;
    const sc = makeClient({
      stories: [{
        owner_id: VIEWER, state: "deleted", media_url: pub(path),
        expires_at: ago(RECOVERY_DAYS + 5), deleted_at: ago(RECOVERY_DAYS + 1),
      }],
    });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), true);
  });

  it("leaves the owner's non-story media alone", async () => {
    // Post photos, memory photos: no story row points at them, so the lookup
    // finds nothing and the short-circuit stands. This is the case that would
    // regress into a whole-app outage if "no row" were read as "cannot tell".
    const sc = makeClient({ stories: [] });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", `${OWNER}/post.jpg`), true);
  });

  it("profile-media: owner always accesses own files", async () => {
    const sc = makeClient();
    assert.equal(await authorizeMediaAccess(sc, OWNER, "profile-media", `avatars/${OWNER}/a.webp`), true);
  });

  it("profile-media: public profile readable by any authenticated viewer", async () => {
    const sc = makeClient({
      profiles: [{ id: OWNER, is_private: false, passport_visibility: "public", account_status: "active" }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "public" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), true);
  });

  it("profile-media: private profile denied to a stranger (no follow/friend)", async () => {
    const sc = makeClient({
      profiles: [{ id: OWNER, is_private: true, passport_visibility: "private", account_status: "active" }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "private" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), false);
  });

  // ── avatar gating by show_profile_picture_publicly ─────────────────────────
  // Only the "avatars/" path prefix is gated by this flag — cover photos and
  // everything else on the profile stay governed by resolveProfileVisibility
  // alone, same as before.

  it("profile-media: public profile, flag=false → avatar denied to a stranger", async () => {
    const sc = makeClient({
      profiles: [{
        id: OWNER, is_private: false, passport_visibility: "public", account_status: "active",
        show_profile_picture_publicly: false,
      }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "public" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), false);
  });

  it("profile-media: public profile, flag=false → COVER photo still allowed to a stranger", async () => {
    // The gate only restricts "avatars/" paths — this proves it didn't widen
    // to cover photos too.
    const sc = makeClient({
      profiles: [{
        id: OWNER, is_private: false, passport_visibility: "public", account_status: "active",
        show_profile_picture_publicly: false,
      }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "public" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `covers/${OWNER}/a.webp`), true);
  });

  it("profile-media: public profile, flag=false, viewer follows owner → avatar allowed", async () => {
    const sc = makeClient({
      profiles: [{
        id: OWNER, is_private: false, passport_visibility: "public", account_status: "active",
        show_profile_picture_publicly: false,
      }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "public" }],
      userFollows: [{ follower_id: VIEWER, following_id: OWNER }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), true);
  });

  it("profile-media: public profile, flag=false, viewer is a friend → avatar allowed", async () => {
    const sc = makeClient({
      profiles: [{
        id: OWNER, is_private: false, passport_visibility: "public", account_status: "active",
        show_profile_picture_publicly: false,
      }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "public" }],
      userFriendships: [{ user_a: OWNER, user_b: VIEWER }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), true);
  });

  it("profile-media: public profile, flag=true (default) → avatar allowed to a stranger", async () => {
    const sc = makeClient({
      profiles: [{
        id: OWNER, is_private: false, passport_visibility: "public", account_status: "active",
        show_profile_picture_publicly: true,
      }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "public" }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), true);
  });

  it("profile-media: private profile, flag=false, approved viewer → avatar allowed (private bypass)", async () => {
    // resolveProfileVisibility already proved a follow/friend relationship to
    // reach "followers_only" for a private profile — the is_private bypass
    // must not re-demand a SEPARATE follow/friend check on top of that.
    const sc = makeClient({
      profiles: [{
        id: OWNER, is_private: true, passport_visibility: "private", account_status: "active",
        show_profile_picture_publicly: false,
      }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "private" }],
      userFriendships: [{ user_a: OWNER, user_b: VIEWER }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), true);
  });

  it("profile-media: owner always sees their own avatar, even with the flag off", async () => {
    const sc = makeClient({
      profiles: [{
        id: OWNER, is_private: false, passport_visibility: "public", account_status: "active",
        show_profile_picture_publicly: false,
      }],
    });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "profile-media", `avatars/${OWNER}/a.webp`), true);
  });

  it("profile-media: blocked viewer denied even for a public profile", async () => {
    const sc = makeClient({
      profiles: [{ id: OWNER, is_private: false, passport_visibility: "public", account_status: "active" }],
      profilePrivacySettings: [{ user_id: OWNER, profile_visibility: "public" }],
      blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "profile-media", `avatars/${OWNER}/a.webp`), false);
  });

  it("blocked viewer denied even for a public post's media", async () => {
    const path = `${OWNER}/p1.jpg`;
    const sc = makeClient({
      blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }],
      posts: [{ author_id: OWNER, visibility: "public", status: "active", post_status: "published", trip_id: null, media_urls: [pub(path)] }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false);
  });

  it("public published post media → allowed for a stranger", async () => {
    const path = `${OWNER}/p2.jpg`;
    const sc = makeClient({
      posts: [{ author_id: OWNER, visibility: "public", status: "active", post_status: "published", trip_id: null, media_urls: [pub(path)] }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
  });

  it("DELAYED post media denied to non-owner (audit 1e fix)", async () => {
    const path = `${OWNER}/p3.jpg`;
    const sc = makeClient({
      posts: [{ author_id: OWNER, visibility: "public", status: "active", post_status: "scheduled", trip_id: null, media_urls: [pub(path)] }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false);
  });

  it("trip_only post media: member allowed, stranger denied", async () => {
    const path = `${OWNER}/p4.jpg`;
    const mk = (members: any[]) => makeClient({
      posts: [{ author_id: OWNER, visibility: "trip_only", status: "active", post_status: "published", trip_id: TRIP, media_urls: [pub(path)] }],
      trips: [{ id: TRIP, owner_id: OWNER }],
      tripMembers: members,
    });
    assert.equal(await authorizeMediaAccess(mk([{ trip_id: TRIP, user_id: VIEWER, role: "member" }]), VIEWER, "post-media", path), true);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(mk([]), VIEWER, "post-media", path), false);
  });

  /**
   * The circle override binds on EVERY post attached to a trip, not only on
   * `trip_only` ones. Both directions, through the full decide() path.
   */
  it("a PUBLIC post attached to a trip is denied when either circle override is set", async () => {
    const path = `${OWNER}/p5.jpg`;
    const post = {
      author_id: OWNER, visibility: "public", status: "active",
      post_status: "published", trip_id: TRIP, media_urls: [pub(path)],
    };
    const hideFromMe = makeClient({
      posts: [post],
      visibilityOverrides: [{
        user_id: VIEWER, target_user_id: OWNER, context_type: "trip",
        context_id: TRIP, direction: "hide_from_me", hidden: true,
      }],
    });
    assert.equal(await authorizeMediaAccess(hideFromMe, VIEWER, "post-media", path), false);
    _clearMediaAccessCache();
    const hideMeFrom = makeClient({
      posts: [post],
      visibilityOverrides: [{
        user_id: OWNER, target_user_id: VIEWER, context_type: "trip",
        context_id: TRIP, direction: "hide_me_from", hidden: true,
      }],
    });
    assert.equal(await authorizeMediaAccess(hideMeFrom, VIEWER, "post-media", path), false);
    _clearMediaAccessCache();
    // Positive control: with no override row the same public post authorizes,
    // so the two denials above are the override and not the trip_id.
    assert.equal(await authorizeMediaAccess(makeClient({ posts: [post] }), VIEWER, "post-media", path), true);
  });

  /**
   * MUTATION-PROOF for the allow-cache scoping. `post-media` decisions depend on
   * override rows a DIFFERENT process writes, so they must not be cached: a
   * cached allow would keep serving the bytes after the owner hid themselves.
   * Re-enable caching for this bucket and the second assertion goes green for
   * the wrong reason.
   */
  it("a post-media allow is NOT cached, so a later override takes effect immediately", async () => {
    const path = `${OWNER}/p6.jpg`;
    const post = {
      author_id: OWNER, visibility: "public", status: "active",
      post_status: "published", trip_id: TRIP, media_urls: [pub(path)],
    };
    assert.equal(await authorizeMediaAccess(makeClient({ posts: [post] }), VIEWER, "post-media", path), true);
    // NO _clearMediaAccessCache() here — that is the whole point.
    const hidden = makeClient({
      posts: [post],
      visibilityOverrides: [{
        user_id: OWNER, target_user_id: VIEWER, context_type: "trip",
        context_id: TRIP, direction: "hide_me_from", hidden: true,
      }],
    });
    assert.equal(await authorizeMediaAccess(hidden, VIEWER, "post-media", path), false);
  });

  /**
   * A `private` §6.1 attachment narrows a PUBLIC post. The attachment is keyed
   * by the canonical `media_assets.id`, which branch 3a reads off the
   * `post_media` row (falling back to the asset looked up by storage key).
   */
  it("a private attachment override denies a non-owner a public post's media", async () => {
    const path = `${OWNER}/post10/m1.jpg`;
    const asset = "d2000000-0000-4000-a000-000000000001";
    const base = {
      mediaAssets: [{ id: asset, owner_user_id: OWNER, storage_bucket: "post-media", storage_path: path }],
      postMedia: [{ storage_path: path, post_id: "post10", moderation_status: "approved", processing_status: "ready" }],
      posts: [{ id: "post10", author_id: OWNER, visibility: "public", status: "active", post_status: "published", trip_id: null }],
    };
    assert.equal(await authorizeMediaAccess(makeClient(base), VIEWER, "post-media", path), true);
    _clearMediaAccessCache();
    const narrowed = {
      ...base,
      attachments: [{ media_asset_id: asset, entity_type: "post", entity_id: "post10", visibility_override: "private" }],
    };
    assert.equal(await authorizeMediaAccess(makeClient(narrowed), VIEWER, "post-media", path), false);
  });

  /**
   * REGRESSION for the shape of branch 3a, not for a rule.
   *
   * The contextual checks were slotted in ahead of the loop's `allow`/`trip`
   * arms. Written as a straight-line sequence they leave `deny` — a private or
   * unpublished parent post — falling past both arms into the attachment check,
   * which answers TRUE when there is no attachment to narrow by. That turns a
   * private post's media into public bytes. The loop keeps `deny` as a
   * `continue` and lets the `decidable` gate answer.
   */
  it("a PRIVATE parent post still denies its media once the contextual checks are in the loop", async () => {
    const path = `${OWNER}/post11/m1.jpg`;
    const asset = "d2000000-0000-4000-a000-000000000002";
    const mk = (visibility: string, postStatus = "published") => makeClient({
      mediaAssets: [{ id: asset, owner_user_id: OWNER, storage_bucket: "post-media", storage_path: path }],
      postMedia: [{ storage_path: path, post_id: "post11", moderation_status: "approved", processing_status: "ready" }],
      posts: [{ id: "post11", author_id: OWNER, visibility, status: "active", post_status: postStatus, trip_id: null }],
    });
    assert.equal(await authorizeMediaAccess(mk("private"), VIEWER, "post-media", path), false);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(mk("followers"), VIEWER, "post-media", path), false);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(mk("public", "scheduled"), VIEWER, "post-media", path), false);
  });

  it("postcard media follows the parent post; rejected media denied outright", async () => {
    const path = `${OWNER}/post9/m1.jpg`;
    const base = {
      postMedia: [{ storage_path: path, post_id: "post9", moderation_status: "approved", processing_status: "ready" }],
      posts: [{ id: "post9", author_id: OWNER, visibility: "public", status: "active", post_status: "published", trip_id: null }],
    };
    assert.equal(await authorizeMediaAccess(makeClient(base), VIEWER, "post-media", path), true);
    _clearMediaAccessCache();
    const rejected = { ...base, postMedia: [{ ...base.postMedia[0], moderation_status: "rejected" }] };
    assert.equal(await authorizeMediaAccess(makeClient(rejected), VIEWER, "post-media", path), false);
  });

  it("message media: thread member allowed, outsider denied", async () => {
    const path = `${OWNER}/dm1.jpg`;
    const mk = (members: any[]) => makeClient({
      messages: [{ thread_id: THREAD, sender_id: OWNER, media_url: pub(path), media_thumbnail_url: null }],
      threadMembers: members,
    });
    assert.equal(await authorizeMediaAccess(mk([{ thread_id: THREAD, user_id: VIEWER, left_at: null }]), VIEWER, "post-media", path), true);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(mk([]), VIEWER, "post-media", path), false);
  });

  it("story media: public allowed; close-friends only for close friends; expired denied", async () => {
    const path = `stories/${OWNER}/s1.jpg`;
    const future = new Date(Date.now() + 3600_000).toISOString();
    const mkStory = (over: any, cf: any[] = []) => makeClient({
      stories: [{ owner_id: OWNER, state: "active", visibility: "public", close_friends_only: false, expires_at: future, media_url: pub(path), ...over }],
      closeFriends: cf,
    });
    assert.equal(await authorizeMediaAccess(mkStory({}), VIEWER, "post-media", path), true);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(
      // FIXTURE REPAIRED. This row said `{ user_id, friend_id }`, the same
      // non-existent column names the production read carried — so the double
      // agreed with the code while the real table (owner_id, friend_user_id)
      // would have failed the query 42703 and denied every close friend their
      // own close-friends story. routes/stories.ts has always spelled these
      // correctly; the fixture and mediaAccess.ts now match it.
      mkStory({ close_friends_only: true }, [{ owner_id: OWNER, friend_user_id: VIEWER }]), VIEWER, "post-media", path), true);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(mkStory({ close_friends_only: true }), VIEWER, "post-media", path), false);
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(
      mkStory({ state: "expired", expires_at: new Date(Date.now() - 1000).toISOString() }), VIEWER, "post-media", path), false);
  });

  // ── The owner archive and the audience window are SEPARATE boundaries ──────
  //
  // Asked separately at the owner's request (2026-09-22), because they are two
  // different questions and one fixture answering both hides which of them a
  // change actually moved. Expiry ends the AUDIENCE's access. It does not end
  // the owner's, and since the sweeper stopped deleting the bytes the owner's
  // access is the only thing keeping an expired story from being unreachable
  // garbage.
  describe("an expired story: the owner keeps it, the audience does not", () => {
    const path = `stories/${OWNER}/archived.jpg`;
    const past = new Date(Date.now() - 60_000).toISOString();
    const expiredStory = () => makeClient({
      stories: [{
        owner_id: OWNER, state: "expired", visibility: "public",
        close_friends_only: false, expires_at: past, media_url: pub(path),
      }],
    });

    it("OWNER: the archive is readable after expiry", async () => {
      assert.equal(
        await authorizeMediaAccess(expiredStory(), OWNER, "post-media", path), true,
        "the owner's own expired story must still be served — that is what the archive IS",
      );
    });

    it("AUDIENCE: the same object, the same moment, is denied", async () => {
      _clearMediaAccessCache();
      assert.equal(
        await authorizeMediaAccess(expiredStory(), VIEWER, "post-media", path), false,
        "expiry ends the audience's access",
      );
    });
  });

  // ── A Highlight reference must not reopen the Story ────────────────────
  //
  // Owner ruling 2026-09-22, point 6: retention must not delete media a saved
  // Highlight still references, "neither should such a reference restore
  // audience access to the expired Story". The two halves pull in opposite
  // directions — keeping the bytes for the Highlight is exactly what could hand
  // them back to the Story's audience — so the second half is measured here
  // rather than argued.
  describe("a saved Highlight does not reopen an expired Story to its audience", () => {
    const path = `stories/${OWNER}/kept.jpg`;
    const past = new Date(Date.now() - 60_000).toISOString();

    it("an EXPIRED story whose media a Highlight also references stays denied", async () => {
      _clearMediaAccessCache();
      const sc = makeClient({
        stories: [{
          owner_id: OWNER, state: "expired", visibility: "public",
          close_friends_only: false, expires_at: past, media_url: pub(path),
          saved_to_highlight_id: "h-1",
        }],
      });
      assert.equal(
        await authorizeMediaAccess(sc, VIEWER, "post-media", path), false,
        "the Highlight is its own object with its own audience; it does not vouch for the Story",
      );
    });

    it("and the owner still reaches it", async () => {
      _clearMediaAccessCache();
      const sc = makeClient({
        stories: [{
          owner_id: OWNER, state: "expired", visibility: "public",
          close_friends_only: false, expires_at: past, media_url: pub(path),
          saved_to_highlight_id: "h-1",
        }],
      });
      assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), true);
    });

    it("A `saved` story IS served past expires_at — and that is the Highlight, not the Story", async () => {
      // THE DISTINCTION, RECORDED BECAUSE IT IS EASY TO READ AS THE DEFECT
      // ABOVE. Branch 3d's `live` test admits `state === "saved"` regardless of
      // `expires_at`, so this row authorizes an audience member after the 24h
      // window. That is not the expired Story coming back: saving to a Highlight
      // REPUBLISHES the media as a Highlight, the sweeper deliberately skips
      // these rows (`.is("saved_to_highlight_id", null)`) so they never become
      // `expired` in the first place, and the audience cannot widen — 3d serves
      // at the STORY's own visibility, and resolveHighlightVisibilityForStory
      // refuses any Story whose audience a Highlight cannot carry faithfully.
      //
      // The two rows differ by ONE field, `state`, which is the whole point: an
      // `expired` row is a Story whose window closed, a `saved` row is a
      // Highlight. mediaAccessDeadline agrees with this branch exactly — it
      // returns no deadline for a `saved` story — so the clamp cannot contradict
      // the authorization.
      _clearMediaAccessCache();
      const sc = makeClient({
        stories: [{
          owner_id: OWNER, state: "saved", visibility: "public",
          close_friends_only: false, expires_at: past, media_url: pub(path),
          saved_to_highlight_id: "h-1",
        }],
      });
      assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
    });

    it("a `saved` story that was never public is STILL not public", async () => {
      // The republication is not a promotion to everyone. If it were, saving to
      // a Highlight would be a way to widen a close-friends Story's audience.
      _clearMediaAccessCache();
      const sc = makeClient({
        stories: [{
          owner_id: OWNER, state: "saved", visibility: "close_friends",
          close_friends_only: true, expires_at: past, media_url: pub(path),
          saved_to_highlight_id: "h-1",
        }],
        closeFriends: [],
      });
      assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false);
    });
  });

  it("orphan/unknown object → DENY by default", async () => {
    const sc = makeClient();
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", `${OWNER}/nothing-references-this.jpg`), false);
  });

  // ── Generated visual block checks (3g branch) ────────────────────────────────
  // ownerFromPath() returns null for generated-visual paths, so the global block
  // gate is skipped. These tests confirm the per-branch block check fires.

  const EVENT_ID2 = "d2000000-0000-4000-a000-000000000001";
  const VIS_ID2   = "e2000000-0000-4000-a000-000000000001";
  const gvEventPath = `generated-visuals/event/${EVENT_ID2}/${VIS_ID2}/hero.webp`;

  it("blocked viewer denied access to generated event visual — even for a public event", async () => {
    // VIEWER is blocked by OWNER (the host). The event is public and active.
    // Without the per-branch block check, this would incorrectly return true.
    const sc = makeClient({
      generatedVisuals: [{
        hero_path: gvEventPath,
        entity_type: "event",
        entity_id: EVENT_ID2,
        owner_user_id: OWNER,
        status: "ready",
      }],
      events: [{ id: EVENT_ID2, host_id: OWNER, visibility: "public", state: "live" }],
      blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", gvEventPath), false);
  });

  const TRIP2        = "b2000000-0000-4000-a000-000000000001";
  const VIS_ID3      = "e3000000-0000-4000-a000-000000000001";
  const gvTripPath   = `generated-visuals/trip/${TRIP2}/${VIS_ID3}/hero.webp`;

  it("blocked viewer denied access to generated trip visual — even when they are a trip member", async () => {
    // VIEWER is a trip member but OWNER (trip owner) has blocked them.
    // Without the per-branch block check, membership would incorrectly allow access.
    const sc = makeClient({
      generatedVisuals: [{
        hero_path: gvTripPath,
        entity_type: "trip",
        entity_id: TRIP2,
        owner_user_id: OWNER,
        status: "ready",
      }],
      trips: [{ id: TRIP2, owner_id: OWNER }],
      tripMembers: [{ trip_id: TRIP2, user_id: VIEWER, role: "member" }],
      blocks: [{ blocker_id: OWNER, blocked_id: VIEWER }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", gvTripPath), false);
  });
});

describe("MD43 — attachment and circle visibility overrides", () => {
  const ASSET  = "d1000000-0000-4000-a000-000000000001";
  const POST   = "e1000000-0000-4000-a000-000000000001";

  it("honors hide_from_me and hide_me_from in either direction", async () => {
    const context = { contextType: "trip" as const, contextId: TRIP };
    assert.equal(await authorizeMediaContext(makeClient({
      visibilityOverrides: [{
        user_id: VIEWER, target_user_id: OWNER, context_type: "trip", context_id: TRIP,
        direction: "hide_from_me", hidden: true,
      }],
    }) as any, VIEWER, OWNER, context), false);
    assert.equal(await authorizeMediaContext(makeClient({
      visibilityOverrides: [{
        user_id: OWNER, target_user_id: VIEWER, context_type: "trip", context_id: TRIP,
        direction: "hide_me_from", hidden: true,
      }],
    }) as any, VIEWER, OWNER, context), false);
    assert.equal(await authorizeMediaContext(makeClient({
      visibilityOverrides: [{
        user_id: VIEWER, target_user_id: OWNER, context_type: "trip", context_id: TRIP,
        direction: "hide_from_me", hidden: false,
      }],
    }) as any, VIEWER, OWNER, context), true);
  });

  it("applies attachment private/public overrides while preserving owner access", async () => {
    const sc = makeClient({
      attachments: [{
        media_asset_id: ASSET, entity_type: "post", entity_id: POST,
        visibility_override: "private",
      }],
    }) as any;
    assert.equal(await authorizeMediaAttachment(
      sc, VIEWER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), false);
    assert.equal(await authorizeMediaAttachment(
      sc, OWNER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), true);
  });

  /**
   * REGRESSION, and the reason this fake now enforces a select list.
   *
   * `authorizeMediaAttachment` resolved the `followers` and `following`
   * audiences with `.from("user_follows").select("id")`. `user_follows` is
   * (follower_id, following_id, created_at) in production AND in CI — there is
   * no `id`. PostgREST RESOLVED that as `{ data: null, error: 42703 }`, and
   * `return !error && Boolean(data)` turned it into FALSE for every viewer, so
   * a genuine follower was denied a `followers` attachment and the audience
   * resolved for NOBODY.
   *
   * It failed CLOSED, so it was never a leak — which is exactly why nothing
   * noticed. Restore `select("id")` and the first two assertions below go red.
   */
  it("resolves the followers/following audiences against the real user_follows columns", async () => {
    const follows = [{ follower_id: VIEWER, following_id: OWNER }];
    const attachment = (override: string) => ({
      attachments: [{
        media_asset_id: ASSET, entity_type: "post", entity_id: POST,
        visibility_override: override,
      }],
      userFollows: follows,
    });

    // VIEWER follows OWNER → OWNER's `followers` attachment is visible.
    assert.equal(await authorizeMediaAttachment(
      makeClient(attachment("followers")) as any,
      VIEWER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), true, "a genuine follower must see a `followers` attachment");

    // `following` asks the opposite direction: OWNER follows VIEWER. The one
    // row above is VIEWER→OWNER, so this must still deny.
    assert.equal(await authorizeMediaAttachment(
      makeClient(attachment("following")) as any,
      VIEWER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), false, "`following` is the other direction and must not be satisfied by a reverse follow");

    // …and it resolves when the row IS the other direction.
    assert.equal(await authorizeMediaAttachment(
      makeClient({
        ...attachment("following"),
        userFollows: [{ follower_id: OWNER, following_id: VIEWER }],
      }) as any,
      VIEWER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), true);

    // A non-follower is denied — the fix widens nothing.
    assert.equal(await authorizeMediaAttachment(
      makeClient({ ...attachment("followers"), userFollows: [] }) as any,
      VIEWER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), false, "a non-follower must still be denied");
  });

  it("denies an override this module does not model rather than guessing", async () => {
    const sc = makeClient({
      attachments: [{
        media_asset_id: ASSET, entity_type: "post", entity_id: POST,
        visibility_override: "friends_only",
      }],
    }) as any;
    assert.equal(await authorizeMediaAttachment(
      sc, VIEWER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), false);
  });

  it("treats a missing attachment as nothing-to-narrow-by, not as a denial", async () => {
    assert.equal(await authorizeMediaAttachment(
      makeClient() as any, VIEWER, OWNER, ASSET, { entityType: "post", entityId: POST },
    ), true, "legacy media with no canonical attachment keeps the post's own rules");
    assert.equal(await authorizeMediaAttachment(
      makeClient() as any, VIEWER, OWNER, null, { entityType: "post", entityId: POST },
    ), true, "a null asset id means the canonical layer is dark, not that access is denied");
  });

  it("fails closed when override resolution errors and never treats a storage key as ownership", async () => {
    const errorClient = {
      from() {
        const b: any = {
          select() { return b; }, eq() { return b; }, maybeSingle() {
            return Promise.resolve({ data: null, error: new Error("db unavailable") });
          },
        };
        return b;
      },
    } as any;
    assert.equal(await authorizeMediaContext(errorClient, VIEWER, OWNER, {
      contextType: "event", contextId: TRIP,
    }), false);
    assert.equal(await authorizeMediaAttachment(errorClient, VIEWER, OWNER, "asset", {
      entityType: "post", entityId: TRIP,
    }), false);
  });
});

// ── Endpoint modes ────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function setClients(c: any) { _setTestClient(c, true); _setTestServiceClient(c); }

function req(method: string, path: string, body?: any): Promise<{ status: number; body: any; location?: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : null;
    const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    if (payload) headers["content-length"] = String(Buffer.byteLength(payload));
    const r = http.request({ hostname: url.hostname, port: Number(url.port), path: url.pathname, method, headers }, (res) => {
      let raw = ""; res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let p: any; try { p = JSON.parse(raw); } catch { p = raw; }
        resolve({ status: res.statusCode ?? 0, body: p, location: res.headers.location as string | undefined });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

describe("GET /api/media/file — public vs signed mode", () => {
  before(() => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    app.use("/api", mediaFileRouter);
    return new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${(server.address() as any).port}`; resolve(); }); });
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const path = `${OWNER}/pub1.jpg`;
  const publicPost = {
    posts: [{ author_id: OWNER, visibility: "public", status: "active", post_status: "published", trip_id: null, media_urls: [pub(path)] }],
  };

  it("authorized viewer → always 302 to a SIGNED url (buckets permanently private)", async () => {
    setClients(makeClient(publicPost));
    const r = await req("GET", `/api/media/file/post-media/${path}`);
    assert.equal(r.status, 302);
    assert.ok(r.location?.includes("/object/sign/post-media/"), r.location);
    assert.ok(r.location?.includes("token=signed"));
  });

  it("unauthorized object → 403", async () => {
    _clearMediaAccessCache();
    setClients(makeClient());
    const r = await req("GET", `/api/media/file/post-media/${OWNER}/orphan.jpg`);
    assert.equal(r.body.error, "forbidden");
  });

  it("disallowed bucket and traversal → 400", async () => {
    setClients(makeClient());
    const r1 = await req("GET", `/api/media/file/stamp-artwork/x.png`);
    assert.equal(r1.body.error, "invalid_payload");
  });

  it("batch /media/sign: authorized url signed, foreign + unauthorized null", async () => {
    _clearMediaAccessCache();
    setClients(makeClient(publicPost));
    const r = await req("POST", "/api/media/sign", {
      urls: [pub(path), "https://evil.example.com/x.jpg", pub(`${OWNER}/orphan2.jpg`)],
    });
    assert.equal(r.status, 200);
    assert.ok(String(r.body.signed[pub(path)]).includes("token=signed"));
    assert.equal(r.body.signed["https://evil.example.com/x.jpg"], null);
    assert.equal(r.body.signed[pub(`${OWNER}/orphan2.jpg`)], null);
  });

  it("batch /media/sign: bare path for AI-generated cover image returns a non-null signed URL", async () => {
    // Bare paths are what the AI visuals service stores after upload
    // (e.g. "post-media/generated-visuals/event/<uuid>/<uuid>/hero.webp").
    // appStorageUrlInfo() was fixed (task 2616) to parse these; this test
    // exercises the full POST /media/sign handler call chain with a bare-path
    // input so that a future regression in the chain is caught immediately.
    const EVENT_UUID = "f1000000-0000-4000-a000-000000000001";
    const VIS_UUID   = "f2000000-0000-4000-a000-000000000001";
    const gvRelPath  = `generated-visuals/event/${EVENT_UUID}/${VIS_UUID}/hero.webp`;
    const barePath   = `post-media/${gvRelPath}`;        // bare input sent by client
    const fullUrl    = pub(gvRelPath);                   // full-URL format for same object

    _clearMediaAccessCache();
    setClients(makeClient({
      generatedVisuals: [{
        hero_path: gvRelPath,
        entity_type: "event",
        entity_id: EVENT_UUID,
        owner_user_id: OWNER,
        status: "ready",
      }],
      events: [{ id: EVENT_UUID, host_id: OWNER, visibility: "public", state: "live" }],
      posts: [
        // full-URL entry re-uses the same post-media path so authorizeMediaAccess
        // also resolves the full-URL format via post_media or generated_visuals.
        { author_id: OWNER, visibility: "public", status: "active", post_status: "published", trip_id: null, media_urls: [fullUrl] },
      ],
    }));

    const r = await req("POST", "/api/media/sign", {
      urls: [barePath, fullUrl],
    });

    assert.equal(r.status, 200);

    // Bare path must resolve to a signed URL — not null.
    const bareResult = r.body.signed[barePath];
    assert.ok(bareResult !== null && bareResult !== undefined,
      `expected a signed URL for bare path, got: ${bareResult}`);
    assert.ok(String(bareResult).includes("token=signed"),
      `expected signed token in URL, got: ${bareResult}`);

    // Full-URL format must still work too.
    const fullResult = r.body.signed[fullUrl];
    assert.ok(fullResult !== null && fullResult !== undefined,
      `expected a signed URL for full URL, got: ${fullResult}`);
    assert.ok(String(fullResult).includes("token=signed"),
      `expected signed token in URL, got: ${fullResult}`);
  });

  // ── show_header_publicly generic-cover fallback ─────────────────────────────

  const EVENT_ID = "d1000000-0000-4000-a000-000000000001";
  const VIS_ID   = "e1000000-0000-4000-a000-000000000001";
  const gvPath   = `generated-visuals/event/${EVENT_ID}/${VIS_ID}/hero.webp`;

  // A public event visible to any authenticated viewer but with header hidden
  // from non-attendees.
  function privateHeaderState(extras: Partial<FakeState> = {}): FakeState {
    return {
      generatedVisuals: [{
        hero_path: gvPath,
        entity_type: "event",
        entity_id: EVENT_ID,
        owner_user_id: OWNER,
        status: "ready",
      }],
      events: [{
        id: EVENT_ID,
        host_id: OWNER,
        visibility: "public",
        state: "live",
        show_header_publicly: false,
      }],
      ...extras,
    };
  }

  it("outsider on event with show_header_publicly=false → generic cover redirect", async () => {
    // VIEWER (TOKEN) is authenticated but has no RSVP/role → gets generic cover.
    _clearMediaAccessCache();
    setClients(makeClient(privateHeaderState()));
    const r = await req("GET", `/api/media/file/post-media/${gvPath}`);
    assert.equal(r.status, 302);
    assert.ok(r.location?.includes("generic"), `expected generic cover, got: ${r.location}`);
  });

  it("host with show_header_publicly=false → real signed URL", async () => {
    // Authenticate as the host: reuse TOKEN which maps to VIEWER; make VIEWER the host.
    _clearMediaAccessCache();
    setClients(makeClient({
      generatedVisuals: [{
        hero_path: gvPath,
        entity_type: "event",
        entity_id: EVENT_ID,
        owner_user_id: VIEWER,
        status: "ready",
      }],
      events: [{ id: EVENT_ID, host_id: VIEWER, visibility: "public", state: "live", show_header_publicly: false }],
    }));
    const r = await req("GET", `/api/media/file/post-media/${gvPath}`);
    assert.equal(r.status, 302);
    assert.ok(r.location?.includes("token=signed"), `expected signed URL, got: ${r.location}`);
  });

  it("RSVP holder with show_header_publicly=false → real signed URL", async () => {
    _clearMediaAccessCache();
    setClients(makeClient({
      ...privateHeaderState(),
      eventRsvps: [{ event_id: EVENT_ID, user_id: VIEWER, status: "going" }],
    }));
    const r = await req("GET", `/api/media/file/post-media/${gvPath}`);
    assert.equal(r.status, 302);
    assert.ok(r.location?.includes("token=signed"), `expected signed URL, got: ${r.location}`);
  });

  it("show_header_publicly=true → real signed URL for any authorized viewer", async () => {
    _clearMediaAccessCache();
    setClients(makeClient({
      generatedVisuals: [{
        hero_path: gvPath,
        entity_type: "event",
        entity_id: EVENT_ID,
        owner_user_id: OWNER,
        status: "ready",
      }],
      events: [{ id: EVENT_ID, host_id: OWNER, visibility: "public", state: "live", show_header_publicly: true }],
    }));
    const r = await req("GET", `/api/media/file/post-media/${gvPath}`);
    assert.equal(r.status, 302);
    assert.ok(r.location?.includes("token=signed"), `expected signed URL, got: ${r.location}`);
  });

  it("trip member with show_header_publicly=false → real signed URL", async () => {
    const tripGvPath = `generated-visuals/trip/${TRIP}/${VIS_ID}/hero.webp`;
    _clearMediaAccessCache();
    setClients(makeClient({
      generatedVisuals: [{
        hero_path: tripGvPath,
        entity_type: "trip",
        entity_id: TRIP,
        owner_user_id: OWNER,
        status: "ready",
      }],
      trips: [{ id: TRIP, owner_id: OWNER, show_header_publicly: false }],
      tripMembers: [{ trip_id: TRIP, user_id: VIEWER, role: "member" }],
    }));
    const r = await req("GET", `/api/media/file/post-media/${tripGvPath}`);
    assert.equal(r.status, 302);
    assert.ok(r.location?.includes("token=signed"), `expected signed URL, got: ${r.location}`);
  });
});

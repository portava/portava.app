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
import mediaFileRouter from "../routes/mediaFile.js";

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
      table === "event_roles" ? state.eventRoles ?? [] : [];
    // Column projection for "profiles" only: the avatar-gating tests below
    // must actually exercise the SELECT string in mediaAccess.ts, not just
    // the row data — a mock that ignores select() and always returns full
    // rows would keep passing even if the code stopped selecting the column
    // it gates on. Other tables aren't projected (nothing here reads a
    // column via select() and checks its own row shape beyond truthiness).
    let profileCols: string[] | null = null;
    const rows = () => {
      const base = src().filter((r: any) => filters.every((f) => f(r)));
      if (table !== "profiles" || !profileCols) return base;
      return base.map((r: any) =>
        Object.fromEntries(profileCols!.filter((c) => c in r).map((c) => [c, r[c]])),
      );
    };
    const b: any = {
      select(cols?: string) {
        if (table === "profiles" && typeof cols === "string" && cols !== "*") {
          profileCols = cols.split(",").map((c) => c.trim());
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
      maybeSingle() { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      then(onF: any, onR: any) { return Promise.resolve({ data: rows(), error: null }).then(onF, onR); },
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
    const sc = makeClient({
      messages: [{ thread_id: THREAD, media_url: bare, media_thumbnail_url: null }],
      threadMembers: [{ thread_id: THREAD, user_id: VIEWER, left_at: null }],
    });
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), true);
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
      messages: [{ thread_id: THREAD, media_url: pub(path), media_thumbnail_url: null }],
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

  it("an EXPIRED story\u2019s media stays reachable by its OWNER — the archive rests on this", async () => {
    // The story sweep no longer deletes bucket objects on expiry, because an
    // expired story is now ARCHIVED and its owner can re-post it. That is only
    // safe because authorization, not destruction, is what withholds the bytes:
    // a viewer is denied by branch 3d (asserted in the test above) while the
    // owner passes the ownership short-circuit that runs before it.
    //
    // If this ever inverts, keeping the bytes becomes a leak rather than an
    // archive — so it is pinned here next to the denial it pairs with.
    const path = `stories/${OWNER}/archived.jpg`;
    const sc = makeClient({
      stories: [{
        owner_id: OWNER, state: "expired", visibility: "public", close_friends_only: false,
        expires_at: new Date(Date.now() - 1000).toISOString(), media_url: pub(path),
      }],
    });
    assert.equal(await authorizeMediaAccess(sc, OWNER, "post-media", path), true,
      "the owner can still see the media behind their own archived story");
    _clearMediaAccessCache();
    assert.equal(await authorizeMediaAccess(sc, VIEWER, "post-media", path), false,
      "and nobody else can — keeping the bytes must not widen who may read them");
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

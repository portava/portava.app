/**
 * Two corrections the independent verifier required on census-media MD79
 * (verification of 487c803f19, findings F1 and F6):
 *
 *   F1. The author always sees their own place (lead ruling D-26f). The global
 *       feed (GET /api/posts) and the following feed (GET /api/posts?feed=following)
 *       applied the Wall's redactor to EVERY row, the caller's own included, so a
 *       day after release the author lost their own venue and pin. They now
 *       bypass the author, as the trip feed and the single read always did.
 *
 *   F6. For a "Publish after I leave" post, `published_at` (the release instant),
 *       `publish_eligible_at` and `publish_after_exit` date the author's exit.
 *       No door serves them to anyone but the author:
 *         - the four post doors in routes/posts.ts (global, following, trip, one
 *           post) null them for everyone else;
 *         - the Wall shows, orders and pages a non-author by the post's creation
 *           instant instead of its release (wallPublishedAtForViewer).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/postReleaseTimingAndAuthor.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { startApp, BEARER, type FakeState } from "./helpers.js";
import { withholdReleaseTiming, wallPublishedAtForViewer, RELEASE_TIMING_FIELDS } from "../lib/postLocationDisclosureLifetime.js";

const AUTHOR = "a0000000-0000-4000-8000-0000000000a1";
const STRANGER = "a0000000-0000-4000-8000-0000000000b2";
const CREATED = "2026-10-05T09:00:00.000Z";
const H = 3_600_000;

function released(id: string, hoursAgo: number) {
  return {
    id, author_id: AUTHOR, trip_id: null, content: `post ${id}`, media_urls: [], visibility: "public", status: "active",
    post_status: "published", created_at: CREATED, updated_at: CREATED,
    location_name: "Bamboo 2 Bar", location_city: "Da Nang", location_country: "Vietnam",
    location_privacy_mode: "delayed_until_exit", public_lat: 16.0544, public_lng: 108.2497, public_location_label: "Bamboo 2 Bar",
    publish_after_exit: true, publish_after_time: null, publish_eligible_at: new Date(Date.now() - (hoursAgo + 0.1) * H).toISOString(),
    published_at: new Date(Date.now() - hoursAgo * H).toISOString(),
  };
}

function state(posts: any[]): FakeState {
  return {
    users: { "tok-author": { id: AUTHOR }, "tok-stranger": { id: STRANGER } },
    trips: new Set(), members: [], posts,
    user_follows: [{ follower_id: STRANGER, following_id: AUTHOR }, { follower_id: AUTHOR, following_id: AUTHOR }],
    profiles: [{ id: AUTHOR, handle: "author", name: "Author", is_private: false }, { id: STRANGER, handle: "stranger", is_private: false }],
  };
}

async function feed(token: string, posts: any[], query = "") {
  const { baseUrl, close } = await startApp(state(posts));
  try {
    const res = await fetch(`${baseUrl}/api/posts${query}`, { headers: { Authorization: BEARER(token), connection: "close" } });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as any;
    return new Map<string, any>((body.posts as any[]).map((p) => [p.id, p]));
  } finally {
    await close();
  }
}

describe("F1. the author is never capped on their own feeds", () => {
  for (const [name, query] of [["global feed", ""], ["following feed", "?feed=following"]] as const) {
    it(`${name}: 25 h after release the author still gets the venue and the exact point; a stranger gets the city`, async () => {
      const mine = await feed("tok-author", [released("p1", 25)], query);
      const own = mine.get("p1");
      assert.ok(own, "the author's own post is on the page");
      assert.equal(own.location_name, "Bamboo 2 Bar");
      assert.equal(own.public_lat, 16.0544);
      assert.equal(own.public_location_label, "Bamboo 2 Bar");
      const theirs = await feed("tok-stranger", [released("p1", 25)], query);
      const other = theirs.get("p1");
      assert.ok(other, "the post is on the stranger's page");
      assert.equal(other.location_name, null);
      assert.equal(other.public_lat, null);
      assert.equal(other.public_location_label, "Da Nang, Vietnam");
    });
  }
});

describe("F6. the release instant is the author's alone", () => {
  for (const [name, query] of [["global feed", ""], ["following feed", "?feed=following"]] as const) {
    it(`${name}: a stranger receives published_at, publish_eligible_at and publish_after_exit as null; the author receives them`, async () => {
      const theirs = (await feed("tok-stranger", [released("p1", 1)], query)).get("p1");
      for (const k of RELEASE_TIMING_FIELDS) assert.equal(theirs[k], null, `stranger: ${k}`);
      assert.equal(theirs.location_name, "Bamboo 2 Bar", "inside the window the place itself is still shown");
      const mine = (await feed("tok-author", [released("p1", 1)], query)).get("p1");
      assert.equal(mine.publish_after_exit, true);
      assert.ok(Number.isFinite(Date.parse(mine.published_at)));
      assert.ok(Number.isFinite(Date.parse(mine.publish_eligible_at)));
    });
  }

  it("withholdReleaseTiming: the author's row is the same object; anyone else's carries the three fields as null and gains no key", () => {
    const row = released("p1", 1);
    assert.equal(withholdReleaseTiming(row, AUTHOR), row);
    const out = withholdReleaseTiming(row, STRANGER) as any;
    for (const k of RELEASE_TIMING_FIELDS) assert.equal(out[k], null);
    assert.equal(out.publish_after_time, row.publish_after_time);
    const { published_at: _a, publish_eligible_at: _b, publish_after_exit: _c, ...bare } = row;
    assert.deepEqual(Object.keys(withholdReleaseTiming(bare, STRANGER) as any).sort(), Object.keys(bare).sort());
    assert.equal(withholdReleaseTiming(row, null) === row, false, "an anonymous viewer is never the author");
  });

  it("wallPublishedAtForViewer: others see a 'Publish after I leave' post at its creation instant (also when the mode was not read); the author sees the release", () => {
    const row = released("p1", 1);
    assert.equal(wallPublishedAtForViewer(row, AUTHOR), row.published_at);
    assert.equal(wallPublishedAtForViewer(row, STRANGER), CREATED);
    const { location_privacy_mode: _m, ...unread } = row;
    assert.equal(wallPublishedAtForViewer(unread, STRANGER), CREATED, "mode not read ⇒ treated as delayed (fail closed)");
    assert.equal(wallPublishedAtForViewer({ ...row, location_privacy_mode: "none" }, STRANGER), row.published_at, "an ordinary post keeps its publication clock");
  });
});

/**
 * census-media MD79 — a published item's location disclosure can END: a
 * non-owner stops seeing the place after `locationDisclosureExpiresAt`.
 *
 * The rule is lead rulings D-26f and D-26g (docs/ops/lead-rulings-20261007-media.md,
 * proposed by lane M under the owner's 2026-10-06 delegation): only a "Publish
 * after I leave" post (`delayed_until_exit`) has a lifetime. Once released, others
 * see its place for 24 hours after `published_at`, then the CITY. A released row
 * whose release time cannot be read — null, unparseable, or not selected — has
 * ended (fail closed). The author is never capped.
 *
 *   A. the producer (lib/postLocationDisclosureLifetime): which rows have a
 *      lifetime, and the instant it ends;
 *   B. the Wall's redactor (lib/postSchemas.mapPublicPost, and so postPlaceWithheld):
 *      the venue, its label and the exact public point go at 24 h; the city stays;
 *   C. the media choke point (services/media/MediaProjectionService.disclosureForRow,
 *      the World views, action rail and Compass): the same end, the same tier,
 *      and no canonical place id after it; never for the owner;
 *   D. the two paths agree at every instant;
 *   E. the readers that carry the window SELECT published_at — and the instant is
 *      never served (it would date the author's exit; 3362 withholds published_at
 *      from every client role for that reason).
 *
 * Run: node --import tsx/esm --test src/test/mediaLocationDisclosureLifetime.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AFTER_LOCATION_DISCLOSURE_TIER,
  LOCATION_DISCLOSURE_END_UNREADABLE,
  RELEASED_DELAYED_PLACE_WINDOW_MS,
  postLocationDisclosureEnded,
  postLocationDisclosureExpiresAt,
} from "../lib/postLocationDisclosureLifetime.js";
import { mapPublicPost, postPlaceWithheld, locationPrivacyMode } from "../lib/postSchemas.js";
import { disclosureForRow } from "../services/media/MediaProjectionService.js";
import { MEDIA_PROJECTION_POST_COLUMNS } from "../lib/media/mediaProjection.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

const OWNER = "a0000000-0000-4000-8000-000000000001";
const VIEWER = "b0000000-0000-4000-8000-000000000002";
const RELEASED = Date.parse("2026-10-07T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const OPEN_GEMS = { gems: [], determined: true };

function released(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: "p-exit",
    author_id: OWNER,
    location_privacy_mode: "delayed_until_exit",
    post_status: "published",
    published_at: new Date(RELEASED).toISOString(),
    location_name: "Bamboo 2 Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
    public_location_label: "Bamboo 2 Bar",
    public_lat: 16.0544,
    public_lng: 108.2497,
    canonical_place_id: "place-bamboo",
    ...over,
  };
}

describe("A. the producer — only a released 'Publish after I leave' post has a lifetime", () => {
  it("is the release time plus 24 hours, and the window is exactly 24 hours (D-26f)", () => {
    assert.equal(RELEASED_DELAYED_PLACE_WINDOW_MS, 24 * HOUR);
    assert.equal(postLocationDisclosureExpiresAt(released()), new Date(RELEASED + 24 * HOUR).toISOString());
    assert.equal(postLocationDisclosureExpiresAt(released({ published_at: new Date(RELEASED) })), new Date(RELEASED + 24 * HOUR).toISOString(), "a Date is read too");
    assert.equal(AFTER_LOCATION_DISCLOSURE_TIER, "city", "D-26g: the place falls to the city");
  });

  it("no other mode, and no unreleased post, has one — over every mode × status", () => {
    const modes = [...locationPrivacyMode.options, null, undefined, "", "some_future_mode"];
    const statuses = ["published", "pending_location_exit", "pending_delay", "pending_safety_review", null, undefined];
    let some = 0;
    for (const mode of modes) for (const status of statuses) {
      const end = postLocationDisclosureExpiresAt({ location_privacy_mode: mode, post_status: status, published_at: new Date(RELEASED).toISOString() });
      if (mode === "delayed_until_exit" && status === "published") { assert.notEqual(end, null); some++; }
      else assert.equal(end, null, `${String(mode)} / ${String(status)}`);
    }
    assert.equal(some, 1, "precondition: the one lifetime case is exercised");
  });

  it("FAILS CLOSED: a released row whose release time is null, unparseable or not selected has ENDED", () => {
    const { published_at: _drop, ...unselected } = released();
    for (const row of [released({ published_at: null }), released({ published_at: "" }), released({ published_at: "yesterday-ish" }), unselected]) {
      assert.equal(postLocationDisclosureExpiresAt(row), LOCATION_DISCLOSURE_END_UNREADABLE);
      assert.equal(postLocationDisclosureEnded(row, RELEASED), true);
    }
    assert.ok(!Number.isFinite(Date.parse(LOCATION_DISCLOSURE_END_UNREADABLE)), "the marker is not a date, so the §11 member never serves it");
  });

  it("ends at exactly 24 h, not before", () => {
    assert.equal(postLocationDisclosureEnded(released(), RELEASED), false);
    assert.equal(postLocationDisclosureEnded(released(), RELEASED + 24 * HOUR - 1), false);
    assert.equal(postLocationDisclosureEnded(released(), RELEASED + 24 * HOUR), true);
    assert.equal(postLocationDisclosureEnded(null), false);
  });
});

describe("B. the Wall's redactor (mapPublicPost / postPlaceWithheld)", () => {
  it("inside the window the row is returned UNCHANGED — the place, its label and the released point", () => {
    const row = released();
    assert.equal(mapPublicPost(row, RELEASED + 23 * HOUR), row);
    assert.equal(postPlaceWithheld({ ...row, published_at: new Date(Date.now() - HOUR).toISOString() }), false);
  });

  it("after it, the venue, its label and the EXACT public point go; the city and country stay", () => {
    const out = mapPublicPost(released(), RELEASED + 24 * HOUR);
    assert.equal(out.location_name, null);
    assert.equal(out.public_location_label, "Da Nang, Vietnam");
    assert.equal(out.public_lat, null, "delayedPostPublisher set the EXACT point on release");
    assert.equal(out.public_lng, null);
    assert.equal(out.location_city, "Da Nang");
    assert.equal(out.location_country, "Vietnam");
    assert.ok(!JSON.stringify(out).includes("Bamboo 2 Bar"), "the venue appears nowhere");
    assert.equal(postPlaceWithheld({ ...released(), published_at: new Date(Date.now() - 25 * HOUR).toISOString() }), true);
  });

  it("adds no key the row did not carry", () => {
    const { public_location_label: _a, public_lat: _b, public_lng: _c, ...bare } = released();
    const out = mapPublicPost(bare, RELEASED + 48 * HOUR);
    assert.deepEqual(Object.keys(out).sort(), Object.keys(bare).sort());
    assert.equal(out.location_name, null);
  });

  it("'Publish at a time' and every other released mode are untouched by the lifetime", () => {
    const time = released({ location_privacy_mode: "delayed_until_time" });
    assert.equal(mapPublicPost(time, RELEASED + 48 * HOUR), time);
    const none = released({ location_privacy_mode: "none" });
    assert.equal(mapPublicPost(none, RELEASED + 48 * HOUR), none);
  });
});

describe("C. the media choke point (disclosureForRow)", () => {
  it("a non-owner sees the place inside the window, and the city — with no canonical place id — after it", () => {
    // disclosureForRow reads the clock itself; the row's release is set relative to now.
    const inside = disclosureForRow(released({ published_at: new Date(Date.now() - HOUR).toISOString() }) as any, VIEWER, OPEN_GEMS);
    assert.equal(inside.name, "Bamboo 2 Bar");
    assert.equal(inside.mayDisclosePlaceId, true);
    const after = disclosureForRow(released({ published_at: new Date(Date.now() - 25 * HOUR).toISOString() }) as any, VIEWER, OPEN_GEMS);
    assert.equal(after.visibility, "city");
    assert.equal(after.name, null);
    assert.equal(after.city, "Da Nang");
    assert.equal(after.mayDisclosePlaceId, false);
  });

  it("an unreadable release time has ended", () => {
    const d = disclosureForRow(released({ published_at: null }) as any, VIEWER, OPEN_GEMS);
    assert.equal(d.name, null);
    assert.equal(d.mayDisclosePlaceId, false);
  });

  it("the OWNER is never capped", () => {
    const d = disclosureForRow(released({ published_at: new Date(Date.now() - 48 * HOUR).toISOString() }) as any, OWNER, OPEN_GEMS);
    assert.equal(d.name, "Bamboo 2 Bar");
    assert.equal(d.mayDisclosePlaceId, true);
  });
});

describe("D. the two paths agree at every instant", () => {
  it("mapPublicPost withholds the venue exactly when the media choke point does", () => {
    for (const ageH of [0.5, 12, 23.9, 24.1, 30, 240]) {
      const row = released({ published_at: new Date(Date.now() - ageH * HOUR).toISOString() });
      const wall = mapPublicPost({ ...row }).location_name === null;
      const media = disclosureForRow(row as any, VIEWER, OPEN_GEMS).name === null;
      assert.equal(wall, media, `${ageH} h after release`);
      assert.equal(wall, ageH >= 24, `${ageH} h after release`);
    }
  });
});

describe("E. who reads the window, and that nobody is served it", () => {
  it("the media projection, the Watch feed and the grid SELECT published_at", () => {
    assert.match(MEDIA_PROJECTION_POST_COLUMNS, /\bpublished_at\b/);
    const feed = readFileSync(join(SRC, "routes", "mediaFeed.ts"), "utf8");
    const constant = (name: string) => {
      const m = feed.match(new RegExp(`const ${name} =([\\s\\S]*?);`));
      assert.ok(m, `${name} is still declared in routes/mediaFeed.ts`);
      return m![1];
    };
    assert.match(constant("FEED_POST_COLUMNS"), /\bpublished_at\b/);
    assert.match(constant("GRID_POST_COLUMNS"), /\bpublished_at\b/);
  });

  it("routes/posts.ts's POST_COLUMNS (the Wall, trip posts, a single post) carries it", () => {
    const posts = readFileSync(join(SRC, "routes", "posts.ts"), "utf8");
    const m = posts.match(/const POST_COLUMNS =([\s\S]*?);/);
    assert.ok(m);
    assert.match(m![1], /\bpublished_at\b/);
  });

  it("the §11 instant is handed only to the choke point — never to the temporal-state member a client receives", () => {
    for (const rel of [join("routes", "mediaFeed.ts"), join("services", "media", "MediaProjectionService.ts")]) {
      const src = readFileSync(join(SRC, rel), "utf8");
      assert.match(src, /locationDisclosureExpiresAt: postLocationDisclosureExpiresAt\(row/, `${rel} supplies the producer`);
      assert.match(src, /afterLocationDisclosureExpiry: AFTER_LOCATION_DISCLOSURE_TIER/, `${rel} falls to the ruled tier`);
      assert.doesNotMatch(src, /resolveMediaTemporalState\([^)]*locationDisclosureExpiresAt/, `${rel} must not serve the instant`);
    }
  });
});

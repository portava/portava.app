/**
 * The client's privacy words against the server's privacy behaviour
 * (census-media MD321, §22).
 *
 * `travel-buddy-standalone/src/services/media/mediaPrivacy.ts` is what the post
 * composer now reads to tell a person what each location choice does. Its
 * DISCLOSURE table is a transcription of three server functions, and a
 * transcription drifts. This test runs the table against those functions for
 * every mode, so a server change that widens or narrows disclosure turns this
 * file red until the client's words are changed with it — and so does a client
 * edit that promises more than the server does.
 *
 *   placeName / city / country  ⇔  lib/postSchemas.mapPublicPost on a pre-release row
 *   tier                        ⇔  lib/mediaLocationVisibility.locationPrivacyModeToCeiling
 *   effectiveMode(m, true)      ⇔  what routes/posts.ts applies to what the composer sends:
 *                                  the sent mode, else defaultPrivacyMode(source, sensitivity)
 *   anyAudienceSeesMore = false ⇔  mapPublicPost takes the row and nothing about the viewer
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultPrivacyMode,
  mapPublicPost,
  sensitivityLevel,
} from "../lib/postSchemas.js";
import { locationPrivacyModeToCeiling } from "../lib/mediaLocationVisibility.js";
import {
  COMPOSER_LOCATION_MODES,
  DISCLOSURE,
  RELEASED_PLACE_WINDOW_HOURS,
  effectiveMode,
  locationPrivacyHint,
  locationRequestFields,
} from "../../../../travel-buddy-standalone/src/services/media/mediaPrivacy.ts";
import { RELEASED_DELAYED_PLACE_WINDOW_MS } from "../lib/postLocationDisclosureLifetime.js";

/** The post_status a freshly created post of this mode carries (routes/posts.ts create). */
function createdStatus(mode: string): string {
  if (mode === "delayed_until_exit") return "pending_location_exit";
  if (mode === "delayed_until_time") return "pending_delay";
  return "published";
}

function row(mode: string) {
  return {
    location_privacy_mode: mode,
    post_status: createdStatus(mode),
    location_name: "Bamboo 2 Bar",
    location_city: "Da Nang",
    location_country: "Vietnam",
  };
}

describe("client DISCLOSURE ⇔ server mapPublicPost", () => {
  for (const mode of COMPOSER_LOCATION_MODES) {
    it(`${mode}: what a non-author receives`, () => {
      const out = mapPublicPost(row(mode));
      const d = DISCLOSURE[mode];
      assert.equal(out.location_name !== null, d.placeName, "place name");
      assert.equal(out.location_city !== null, d.city, "city");
      assert.equal(out.location_country !== null, d.country, "country");
    });
  }
  it("a delayed post, once RELEASED, discloses the place — which is what the client says 'delayed' means", () => {
    const releasedAt = Date.parse("2026-10-07T10:00:00.000Z");
    for (const mode of ["delayed_until_exit", "delayed_until_time"]) {
      const out = mapPublicPost({ ...row(mode), post_status: "published", published_at: new Date(releasedAt).toISOString() }, releasedAt + 60_000);
      assert.equal(out.location_name, "Bamboo 2 Bar", mode);
    }
  });
  it("…and an 'After I leave' place is shown for the window the client names, then only the city (census-media MD79, lead ruling D-26f)", () => {
    assert.equal(RELEASED_PLACE_WINDOW_HOURS * 60 * 60 * 1000, RELEASED_DELAYED_PLACE_WINDOW_MS, "the client's words name the server's window");
    const releasedAt = Date.parse("2026-10-07T10:00:00.000Z");
    const after = releasedAt + RELEASED_DELAYED_PLACE_WINDOW_MS;
    const exit = mapPublicPost({ ...row("delayed_until_exit"), post_status: "published", published_at: new Date(releasedAt).toISOString() }, after);
    assert.equal(exit.location_name, null, "the place is no longer named");
    assert.equal(exit.location_city, "Da Nang", "the city stays, as the hint says");
    assert.equal(exit.location_country, "Vietnam", "and the country");
    const time = mapPublicPost({ ...row("delayed_until_time"), post_status: "published", published_at: new Date(releasedAt).toISOString() }, after);
    assert.equal(time.location_name, "Bamboo 2 Bar", "'At a time' has no window: the ruling names only 'After I leave'");
    assert.match(locationPrivacyHint("delayed_until_exit", { hasPlace: true }), new RegExp(`${RELEASED_PLACE_WINDOW_HOURS} hours`), "the composer says so");
  });
  it("no audience sees more: the redactor reads the row and nothing about who is looking", () => {
    assert.equal(mapPublicPost.length, 1, "a viewer parameter here would make `anyAudienceSeesMore` a claim to re-check");
    for (const mode of COMPOSER_LOCATION_MODES) assert.equal(DISCLOSURE[mode].anyAudienceSeesMore, false);
  });
});

describe("client tier ⇔ server locationPrivacyModeToCeiling", () => {
  for (const mode of COMPOSER_LOCATION_MODES) {
    it(`${mode}`, () => {
      const ceiling = locationPrivacyModeToCeiling(mode, createdStatus(mode));
      assert.equal(ceiling ?? "place", DISCLOSURE[mode].tier);
    });
  }
});

describe("client effectiveMode ⇔ what the create route applies to what the composer sends", () => {
  // PulseCreate sends a place with locationSource 'gps' or 'manual' and no venueName,
  // so the server's sensitivity is sensitivityLevel(null).
  for (const source of ["gps", "manual"]) {
    for (const mode of COMPOSER_LOCATION_MODES) {
      it(`${source} · ${mode}`, () => {
        const sent = locationRequestFields(mode, new Date("2026-09-26T21:30:00.000Z")).locationPrivacyMode;
        const applied = sent ?? defaultPrivacyMode(source, sensitivityLevel(null));
        assert.equal(effectiveMode(mode, true), applied);
      });
    }
  }
});

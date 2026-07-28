/**
 * bucketClassifier.test.ts
 *
 * Unit tests for classifyBuckets() — the pure keyword-matching function that
 * classifies a post into one or more place coverage bucket types.
 *
 * Runtime: node:test + tsx/esm
 * Run: node --import tsx/esm --test src/test/bucketClassifier.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyBuckets, type BucketType } from "../lib/places/bucketClassifier.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function captionPost(caption: string) {
  return { caption, tags: [], category: null, metadata: null };
}

function tagPost(tags: string[]) {
  return { caption: null, tags, category: null, metadata: null };
}

function categoryPost(category: string) {
  return { caption: null, tags: [], category, metadata: null };
}

// ── Empty input ───────────────────────────────────────────────────────────────

describe("classifyBuckets — empty input", () => {
  it("returns [] for empty post", () => {
    assert.deepEqual(classifyBuckets({}), []);
  });

  it("returns [] when all fields are null", () => {
    assert.deepEqual(
      classifyBuckets({ caption: null, tags: null, category: null, metadata: null }),
      [],
    );
  });

  it("returns [] when no keywords match", () => {
    assert.deepEqual(
      classifyBuckets({ caption: "Beautiful day at the beach house", tags: [], category: null }),
      [],
    );
  });
});

// ── Drone bucket ──────────────────────────────────────────────────────────────

describe("classifyBuckets — drone", () => {
  it("matches 'drone' in caption", () => {
    const result = classifyBuckets(captionPost("Shot with my drone over the valley"));
    assert.ok(result.includes("drone"), `expected drone, got ${JSON.stringify(result)}`);
  });

  it("matches 'aerial' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Aerial view of the city at dusk")).includes("drone"));
  });

  it("matches 'dji' tag (case-insensitive)", () => {
    assert.ok(classifyBuckets(tagPost(["DJI", "travel"])).includes("drone"));
  });

  it("matches 'fpv' tag", () => {
    assert.ok(classifyBuckets(tagPost(["fpv", "racing"])).includes("drone"));
  });
});

// ── Night bucket ──────────────────────────────────────────────────────────────

describe("classifyBuckets — night", () => {
  it("matches 'night' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Night vibes in the city")).includes("night"));
  });

  it("matches 'midnight' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Midnight walk downtown")).includes("night"));
  });

  it("matches 'moonlight' tag", () => {
    assert.ok(classifyBuckets(tagPost(["moonlight", "portrait"])).includes("night"));
  });

  it("does not match 'daylight' alone", () => {
    assert.equal(classifyBuckets(captionPost("Beautiful daylight photo")).includes("night"), false);
  });
});

// ── Sunrise bucket ────────────────────────────────────────────────────────────

describe("classifyBuckets — sunrise", () => {
  it("matches 'sunrise' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Caught the sunrise at 5 AM")).includes("sunrise"));
  });

  it("matches 'golden hour'", () => {
    assert.ok(classifyBuckets(captionPost("Golden hour magic")).includes("sunrise"));
  });

  it("matches 'sunset' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Perfect sunset views here")).includes("sunrise"));
  });

  it("matches 'dawn' tag", () => {
    assert.ok(classifyBuckets(tagPost(["dawn", "photography"])).includes("sunrise"));
  });
});

// ── Underwater bucket ─────────────────────────────────────────────────────────

describe("classifyBuckets — underwater", () => {
  it("matches 'underwater' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Amazing underwater photos from the reef")).includes("underwater"));
  });

  it("matches 'scuba' tag", () => {
    assert.ok(classifyBuckets(tagPost(["scuba", "ocean"])).includes("underwater"));
  });

  it("matches 'snorkeling' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Snorkeling was incredible today")).includes("underwater"));
  });
});

// ── Adventure bucket ──────────────────────────────────────────────────────────

describe("classifyBuckets — adventure", () => {
  it("matches 'hiking' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Hiking to the peak was worth it")).includes("adventure"));
  });

  it("matches 'trekking' tag", () => {
    assert.ok(classifyBuckets(tagPost(["trekking", "mountains"])).includes("adventure"));
  });

  it("matches category 'adventure'", () => {
    assert.ok(classifyBuckets(categoryPost("adventure")).includes("adventure"));
  });
});

// ── Food nearby bucket ────────────────────────────────────────────────────────

describe("classifyBuckets — food_nearby", () => {
  it("matches 'street food' in caption", () => {
    assert.ok(classifyBuckets(captionPost("The street food here is amazing")).includes("food_nearby"));
  });

  it("matches 'restaurant' tag", () => {
    assert.ok(classifyBuckets(tagPost(["restaurant", "travel"])).includes("food_nearby"));
  });

  it("matches category 'food'", () => {
    assert.ok(classifyBuckets(categoryPost("food")).includes("food_nearby"));
  });
});

// ── Hidden angles bucket ──────────────────────────────────────────────────────

describe("classifyBuckets — hidden_angles", () => {
  it("matches 'hidden gem' in caption", () => {
    assert.ok(classifyBuckets(captionPost("This is a hidden gem most tourists miss")).includes("hidden_angles"));
  });

  it("matches 'secret' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Secret entrance to the cave")).includes("hidden_angles"));
  });

  it("matches 'underrated' tag", () => {
    assert.ok(classifyBuckets(tagPost(["underrated", "spots"])).includes("hidden_angles"));
  });
});

// ── Tips bucket ───────────────────────────────────────────────────────────────

describe("classifyBuckets — tips", () => {
  it("matches 'pro tip' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Pro tip: come before 7 AM to avoid crowds")).includes("tips"));
  });

  it("matches 'best time' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Best time to visit is November")).includes("tips"));
  });

  it("matches 'insider' tag", () => {
    assert.ok(classifyBuckets(tagPost(["insider", "guide"])).includes("tips"));
  });
});

// ── Rainy season bucket ───────────────────────────────────────────────────────

describe("classifyBuckets — rainy_season", () => {
  it("matches 'monsoon' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Monsoon season makes the waterfalls incredible")).includes("rainy_season"));
  });

  it("matches 'misty' tag", () => {
    assert.ok(classifyBuckets(tagPost(["misty", "morning"])).includes("rainy_season"));
  });

  it("matches 'rainy season' phrase", () => {
    assert.ok(classifyBuckets(captionPost("Rainy season views are underrated")).includes("rainy_season"));
  });
});

// ── Festival bucket ───────────────────────────────────────────────────────────

describe("classifyBuckets — festival", () => {
  it("matches 'festival' in caption", () => {
    assert.ok(classifyBuckets(captionPost("Festival season is magical here")).includes("festival"));
  });

  it("matches 'fireworks' tag", () => {
    assert.ok(classifyBuckets(tagPost(["fireworks", "celebration"])).includes("festival"));
  });

  it("matches 'lantern' in caption", () => {
    assert.ok(classifyBuckets(captionPost("The lantern festival was breathtaking")).includes("festival"));
  });
});

// ── Multi-bucket matching ─────────────────────────────────────────────────────

describe("classifyBuckets — multi-bucket", () => {
  it("returns both drone and sunrise for a drone sunrise shot", () => {
    const result = classifyBuckets(captionPost("Drone footage at golden hour — absolute perfection"));
    assert.ok(result.includes("drone"),   `missing drone in ${JSON.stringify(result)}`);
    assert.ok(result.includes("sunrise"), `missing sunrise in ${JSON.stringify(result)}`);
  });

  it("returns both night and tips for a night photography guide", () => {
    const result = classifyBuckets(captionPost("Pro tip for night photography: use a tripod"));
    assert.ok(result.includes("night"), `missing night in ${JSON.stringify(result)}`);
    assert.ok(result.includes("tips"),  `missing tips in ${JSON.stringify(result)}`);
  });

  it("returns no duplicates", () => {
    const result = classifyBuckets(captionPost("festival festival festival"));
    const festivalCount = result.filter((b) => b === "festival").length;
    assert.equal(festivalCount, 1);
  });
});

// ── Metadata field ────────────────────────────────────────────────────────────

describe("classifyBuckets — metadata field", () => {
  it("classifies from metadata.description", () => {
    const result = classifyBuckets({
      caption: null,
      tags: [],
      category: null,
      metadata: { description: "Drone shot over the jungle" },
    });
    assert.ok(result.includes("drone"));
  });

  it("classifies from metadata.keywords array", () => {
    const result = classifyBuckets({
      caption: null,
      tags: [],
      category: null,
      metadata: { keywords: ["sunset", "travel"] },
    });
    assert.ok(result.includes("sunrise"));
  });
});

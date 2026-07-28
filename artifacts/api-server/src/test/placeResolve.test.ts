/**
 * Unit tests for placeResolve — resolveCanonicalPlaceImage and toCanonicalPlace.
 *
 * Pure functions only; no DB, no network, no fake client needed.
 *
 * Run: node --import tsx/esm --test src/test/placeResolve.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCanonicalPlaceImage,
  toCanonicalPlace,
  type PlaceImageRef,
  type PlaceLike,
} from "../lib/places/placeResolve.js";

// ── resolveCanonicalPlaceImage ────────────────────────────────────────────────

describe("resolveCanonicalPlaceImage", () => {
  const place: PlaceLike = {
    name: "Test Place",
    latitude: 10.0,
    longitude: 123.0,
  };

  it("returns null when refs is empty", () => {
    assert.equal(resolveCanonicalPlaceImage(place, []), null);
  });

  it("returns null when refs contains no image URLs", () => {
    const refs: PlaceImageRef[] = [
      { provider: "fsq", photo_url: null, image_url: null },
    ];
    assert.equal(resolveCanonicalPlaceImage(place, refs), null);
  });

  it("tier 1: returns verified Portava image_url first", () => {
    const refs: PlaceImageRef[] = [
      { provider: "fsq", photo_url: "https://fsq.example.com/photo.jpg" },
      { provider: "portava", image_url: "https://portava.example.com/verified.jpg", verified: true },
      { provider: "user", photo_url: "https://user.example.com/upload.jpg", approved: true },
    ];
    assert.equal(
      resolveCanonicalPlaceImage(place, refs),
      "https://portava.example.com/verified.jpg",
    );
  });

  it("tier 1: skips unverified Portava image", () => {
    const refs: PlaceImageRef[] = [
      { provider: "portava", image_url: "https://portava.example.com/unverified.jpg", verified: false },
      { provider: "fsq", photo_url: "https://fsq.example.com/photo.jpg" },
    ];
    assert.equal(
      resolveCanonicalPlaceImage(place, refs),
      "https://fsq.example.com/photo.jpg",
    );
  });

  it("tier 2: falls back to provider photo_url when no verified Portava image", () => {
    const refs: PlaceImageRef[] = [
      { provider: "portava", image_url: null, verified: false },
      { provider: "fsq", photo_url: "https://fsq.example.com/photo.jpg" },
      { provider: "user", photo_url: "https://user.example.com/upload.jpg", approved: true },
    ];
    assert.equal(
      resolveCanonicalPlaceImage(place, refs),
      "https://fsq.example.com/photo.jpg",
    );
  });

  it("tier 2: skips user refs for provider tier", () => {
    const refs: PlaceImageRef[] = [
      { provider: "user", photo_url: "https://user.example.com/upload.jpg", approved: true },
    ];
    // User photo should not be picked at tier 2
    // It should fall through to tier 3
    assert.equal(
      resolveCanonicalPlaceImage(place, refs),
      "https://user.example.com/upload.jpg",
    );
  });

  it("tier 3: approved user-contributed photo when no provider photo exists", () => {
    const refs: PlaceImageRef[] = [
      { provider: "user", photo_url: "https://user.example.com/approved.jpg", approved: true },
    ];
    assert.equal(
      resolveCanonicalPlaceImage(place, refs),
      "https://user.example.com/approved.jpg",
    );
  });

  it("tier 3: skips unapproved user photo", () => {
    const refs: PlaceImageRef[] = [
      { provider: "user", photo_url: "https://user.example.com/pending.jpg", approved: false },
    ];
    assert.equal(resolveCanonicalPlaceImage(place, refs), null);
  });

  it("returns null when no tier yields a result", () => {
    const refs: PlaceImageRef[] = [
      { provider: "portava", image_url: null, verified: false },
      { provider: "fsq", photo_url: null },
      { provider: "user", photo_url: "https://user.example.com/pending.jpg", approved: false },
    ];
    assert.equal(resolveCanonicalPlaceImage(place, refs), null);
  });
});

// ── toCanonicalPlace ──────────────────────────────────────────────────────────

describe("toCanonicalPlace", () => {
  const PLACE_ID = "place-abc-123";

  const richFsqPlace = {
    id: PLACE_ID,
    name: "Café Lechon",
    primary_category: "food",
    latitude: 10.317,
    longitude: 123.891,
    status: "active",
    // Address
    address: "1 Colon Street",
    address_line1: "1 Colon Street",
    address_line2: null,
    formatted_address: "1 Colon Street, Cebu City, Cebu 6000, PH",
    postal_code: "6000",
    region: "Cebu",
    city: "Cebu City",
    neighborhood: "Downtown",
    country_code: "PH",
    // Contact
    tel: "+63321234567",
    international_phone: "+63 32 123 4567",
    website: "https://cafelechen.example.com",
    booking_url: "https://book.example.com/cafelechen",
    // Ratings & pricing
    provider_rating: 8.7,
    review_count: 423,
    price: 2,                              // FSQ price tier 2 → "moderate"
    // Hours
    opening_hours: [
      { dayOfWeek: 1, open: "07:00", close: "22:00" },
      { dayOfWeek: 2, open: "07:00", close: "22:00" },
    ],
    is_open_now: true,
    // Amenities
    amenities: ["wifi", "outdoor_seating"],
    // Gallery
    gallery_images: ["https://img.example.com/g1.jpg", "https://img.example.com/g2.jpg"],
    field_freshness: { name: "2026-01-01", coordinates: "2026-01-01" },
  };

  const refs = [
    {
      provider: "fsq",
      attribution: "Powered by Foursquare",
      photo_url: "https://img.example.com/fsq-photo.jpg",
    },
    {
      provider: "portava",
      attribution: "Portava",
      image_url: "https://portava.example.com/main.jpg",
      verified: true,
    },
  ];

  it("populates required fields", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.equal(cp.id, PLACE_ID);
    assert.equal(cp.name, "Café Lechon");
    assert.equal(cp.category, "food");
    assert.equal(cp.status, "active");
    assert.equal(cp.detailRoute, `/place/${PLACE_ID}`);
  });

  it("populates coordinates", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.ok(cp.coordinates);
    assert.equal(cp.coordinates!.lat, 10.317);
    assert.equal(cp.coordinates!.lng, 123.891);
  });

  it("populates all address fields", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.equal(cp.address, "1 Colon Street");
    assert.equal(cp.addressLine1, "1 Colon Street");
    assert.equal(cp.addressLine2, null);
    assert.equal(cp.formattedAddress, "1 Colon Street, Cebu City, Cebu 6000, PH");
    assert.equal(cp.postalCode, "6000");
    assert.equal(cp.region, "Cebu");
    assert.equal(cp.city, "Cebu City");
    assert.equal(cp.neighborhood, "Downtown");
    assert.equal(cp.countryCode, "PH");
  });

  it("populates contact fields", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.equal(cp.phone, "+63321234567");
    assert.equal(cp.internationalPhone, "+63 32 123 4567");
    assert.equal(cp.website, "https://cafelechen.example.com");
    assert.equal(cp.bookingUrl, "https://book.example.com/cafelechen");
  });

  it("populates ratings and pricing", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.equal(cp.rating, 8.7);
    assert.equal(cp.reviewCount, 423);
    assert.equal(cp.priceLevel, "moderate"); // FSQ price 2 → moderate
  });

  it("populates opening hours and isOpenNow", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.equal(cp.isOpenNow, true);
    assert.ok(Array.isArray(cp.openingHours));
    assert.equal(cp.openingHours!.length, 2);
    assert.deepEqual(cp.openingHours![0], { dayOfWeek: 1, open: "07:00", close: "22:00" });
  });

  it("populates amenities", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.deepEqual(cp.amenities, ["wifi", "outdoor_seating"]);
  });

  it("sets headerImageUrl via resolveCanonicalPlaceImage (Portava wins)", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.equal(cp.headerImageUrl, "https://portava.example.com/main.jpg");
  });

  it("collects galleryImages from refs photo_urls and place gallery_images", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    // fsq photo_url is in gallery (not used as headerImageUrl)
    assert.ok(cp.galleryImages.includes("https://img.example.com/fsq-photo.jpg"));
    // place.gallery_images also included
    assert.ok(cp.galleryImages.includes("https://img.example.com/g1.jpg"));
    assert.ok(cp.galleryImages.includes("https://img.example.com/g2.jpg"));
  });

  it("deduplicates and collects attribution from refs", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.ok(cp.attribution.includes("Powered by Foursquare"));
    assert.ok(cp.attribution.includes("Portava"));
  });

  it("collects sources from refs", () => {
    const cp = toCanonicalPlace(richFsqPlace, refs);
    assert.ok(cp.sources.includes("fsq"));
    assert.ok(cp.sources.includes("portava"));
  });

  it("returns nulls for absent fields — no invented values", () => {
    const minimal = {
      id: "min-1",
      name: "Minimal Place",
      primary_category: "other",
      latitude: 0,
      longitude: 0,
      status: "active",
    };
    const cp = toCanonicalPlace(minimal, []);
    assert.equal(cp.address, null);
    assert.equal(cp.addressLine1, null);
    assert.equal(cp.addressLine2, null);
    assert.equal(cp.formattedAddress, null);
    assert.equal(cp.postalCode, null);
    assert.equal(cp.region, null);
    assert.equal(cp.phone, null);
    assert.equal(cp.internationalPhone, null);
    assert.equal(cp.website, null);
    assert.equal(cp.bookingUrl, null);
    assert.equal(cp.rating, null);
    assert.equal(cp.reviewCount, null);
    assert.equal(cp.priceLevel, null);
    assert.equal(cp.openingHours, null);
    assert.equal(cp.isOpenNow, null);
    assert.equal(cp.headerImageUrl, null);
    assert.deepEqual(cp.amenities, []);
    assert.deepEqual(cp.galleryImages, []);
    assert.deepEqual(cp.attribution, []);
    assert.deepEqual(cp.sources, []);
  });

  it("maps FSQ price tier 1 to inexpensive", () => {
    const p = { ...richFsqPlace, price: 1 };
    assert.equal(toCanonicalPlace(p, []).priceLevel, "inexpensive");
  });

  it("maps FSQ price tier 3 to expensive", () => {
    const p = { ...richFsqPlace, price: 3 };
    assert.equal(toCanonicalPlace(p, []).priceLevel, "expensive");
  });

  it("maps FSQ price tier 4 to very_expensive", () => {
    const p = { ...richFsqPlace, price: 4 };
    assert.equal(toCanonicalPlace(p, []).priceLevel, "very_expensive");
  });

  it("uses explicit price_level string when present", () => {
    const p = { ...richFsqPlace, price_level: "free", price: 1 };
    assert.equal(toCanonicalPlace(p, []).priceLevel, "free");
  });

  it("rejects malformed opening_hours — returns null", () => {
    const p = { ...richFsqPlace, opening_hours: [{ dayOfWeek: 8, open: "bad" }] };
    assert.equal(toCanonicalPlace(p, []).openingHours, null);
  });

  it("reads isOpenNow as false when explicitly false", () => {
    const p = { ...richFsqPlace, is_open_now: false };
    assert.equal(toCanonicalPlace(p, []).isOpenNow, false);
  });

  it("reads tel field as phone when phone is absent", () => {
    const p = { ...richFsqPlace, tel: "+1234567890", phone: undefined };
    assert.equal(toCanonicalPlace(p, []).phone, "+1234567890");
  });
});

// ── Wrong-place rejection scenarios ──────────────────────────────────────────
// Covers the four canonical wrong-place scenarios from the real-place accuracy spec:
//   1. Different canonical_place_id → rejected by resolveHeaderImage canonical guard
//   2. Coordinates differ beyond threshold → isSamePlace returns false
//   3. Nearby hotel sharing the same city block → different category family → isSamePlace false
//   4. Different chain branch → different canonical_place_id → rejected by canonical guard

import {
  isSamePlace,
  haversineKm,
  nameSimilarity,
  isLandmark,
  normalizeLandmarkName,
  LANDMARK_CATEGORY_FAMILIES,
  type PlaceLike,
} from "../lib/places/placeResolve.js";
import { resolveHeaderImage } from "../lib/visuals/priority.js";

describe("wrong-place: different canonical_place_id rejected even with similar names", () => {
  it("resolveHeaderImage rejects an image whose canonicalPlaceId does not match the entity", () => {
    // Two places with similar names ("Cebu Falls" vs "Kawasan Falls") but different IDs
    const result = resolveHeaderImage(
      [
        {
          url: "https://cdn.example.com/cebu-falls.jpg",
          source: "official" as const,
          canonicalPlaceId: "place-cebu-falls-002",  // different place
        },
      ],
      { canonicalPlaceId: "place-kawasan-001" },
    );
    assert.equal(result, null, "Image with mismatched canonicalPlaceId must be rejected");
  });

  it("resolveHeaderImage accepts an image when canonicalPlaceId matches exactly", () => {
    const result = resolveHeaderImage(
      [
        {
          url: "https://cdn.example.com/kawasan.jpg",
          source: "official" as const,
          canonicalPlaceId: "place-kawasan-001",
        },
      ],
      { canonicalPlaceId: "place-kawasan-001" },
    );
    assert.ok(result !== null);
    assert.equal(result!.url, "https://cdn.example.com/kawasan.jpg");
  });
});

describe("wrong-place: Cebu waterfall image rejected for a place in a different province", () => {
  const kawasanFalls: PlaceLike = {
    name: "Kawasan Falls",
    latitude: 9.8697,     // Cebu province — Badian
    longitude: 123.3966,
    primary_category: "attraction",
  };

  const tumarionFalls: PlaceLike = {
    name: "Kawasan Falls",   // same name, different province
    latitude: 7.9845,        // Bukidnon — >200 km away
    longitude: 125.1012,
    primary_category: "attraction",
  };

  it("haversineKm reports > MERGE_DISTANCE_KM (0.075) between the two locations", () => {
    const dist = haversineKm(
      kawasanFalls.latitude!,
      kawasanFalls.longitude!,
      tumarionFalls.latitude!,
      tumarionFalls.longitude!,
    );
    assert.ok(dist > 0.075, `Expected distance > 0.075 km, got ${dist}`);
  });

  it("isSamePlace returns false — coordinates differ beyond the merge threshold", () => {
    assert.equal(
      isSamePlace(tumarionFalls, kawasanFalls),
      false,
      "Two waterfalls in different provinces must not be merged",
    );
  });

  it("nameSimilarity is high but distance check prevents merging", () => {
    // Names are identical → similarity = 1.0
    assert.ok(nameSimilarity(kawasanFalls.name, tumarionFalls.name) >= 0.8);
    // But isSamePlace is still false due to coordinates
    assert.equal(isSamePlace(tumarionFalls, kawasanFalls), false);
  });
});

describe("wrong-place: nearby hotel image rejected for a different venue on the same city block", () => {
  const hotelA: PlaceLike = {
    name: "Grand Hotel Cebu",
    latitude: 10.3157,
    longitude: 123.8854,
    primary_category: "hotel",
  };

  // Different venue — same block, different name, different category
  const rooftopBarA: PlaceLike = {
    name: "Sky Lounge",
    latitude: 10.3157,   // same coordinates (same building)
    longitude: 123.8854,
    primary_category: "bar",
  };

  // Same block, slightly different position, very different name
  const restaurantA: PlaceLike = {
    name: "Harbor Kitchen",
    latitude: 10.3158,
    longitude: 123.8855,
    primary_category: "restaurant",
  };

  it("hotel and its rooftop bar are not merged — different category families", () => {
    assert.equal(
      isSamePlace(rooftopBarA, hotelA),
      false,
      "Hotel and its rooftop bar must NOT be merged even when co-located",
    );
  });

  it("hotel and a nearby restaurant are not merged — different names AND category families", () => {
    assert.equal(
      isSamePlace(restaurantA, hotelA),
      false,
      "Hotel and a nearby restaurant must NOT be merged",
    );
  });

  it("two hotels with the same name at the same location ARE merged (positive control)", () => {
    const hotelB: PlaceLike = {
      name: "Grand Hotel Cebu",    // identical name
      latitude: 10.31572,          // within 0.075 km
      longitude: 123.88541,
      primary_category: "hotel",
    };
    assert.equal(
      isSamePlace(hotelB, hotelA),
      true,
      "Same hotel at the same location must be merged",
    );
  });
});

describe("wrong-place: different branch of the same chain rejected when canonical_place_id differs", () => {
  it("resolveHeaderImage rejects branch-B image when entity is branch-A", () => {
    // Two SM Malls — same chain, different canonical IDs
    const result = resolveHeaderImage(
      [
        {
          url: "https://cdn.example.com/sm-manila.jpg",
          source: "official" as const,
          canonicalPlaceId: "place-sm-mall-manila",   // branch in Manila
        },
      ],
      { canonicalPlaceId: "place-sm-mall-cebu" },     // entity is in Cebu
    );
    assert.equal(result, null, "Branch image with different canonicalPlaceId must be rejected");
  });

  it("isSamePlace returns false for two chain branches with far-apart coordinates", () => {
    const smCebu: PlaceLike = {
      name: "SM City Mall",
      latitude: 10.3115,
      longitude: 123.9175,
      primary_category: "mall",
    };
    const smManila: PlaceLike = {
      name: "SM City Mall",
      latitude: 14.5547,   // Manila — hundreds of km away
      longitude: 121.0244,
      primary_category: "mall",
    };
    assert.equal(
      isSamePlace(smManila, smCebu),
      false,
      "Two branches of the same chain must NOT be merged — they are far apart",
    );
  });
});

// ── isSamePlace: zero-token fallback ─────────────────────────────────────────

describe("isSamePlace — zero-token landmark name fallback", () => {
  // "Boracay Beach" → normalizeLandmarkName → [] (both tokens are descriptors/qualifiers)
  const boracayBeachA: PlaceLike = {
    name: "Boracáy Beach",
    latitude: 11.9674,
    longitude: 121.9248,
    primary_category: "beach",
  };
  const boracayBeachB: PlaceLike = {
    name: "Boracay Beach",   // no diacritic — same place, slightly different spelling
    latitude: 11.9675,       // within 300 m
    longitude: 121.9249,
    primary_category: "beach",
  };
  const differentBeach: PlaceLike = {
    name: "White Beach",     // normalizes to ['white'] — non-empty
    latitude: 11.9676,
    longitude: 121.9250,
    primary_category: "beach",
  };
  const farBeach: PlaceLike = {
    name: "Boracay Beach",
    latitude: 11.9800,       // > 300 m away
    longitude: 121.9400,
    primary_category: "beach",
  };

  it("merges two nearby zero-token names that are identical after normalization", () => {
    assert.equal(
      isSamePlace(boracayBeachA, boracayBeachB),
      true,
      "'Boracáy Beach' and 'Boracay Beach' within 300 m must merge via zero-token fallback",
    );
  });

  it("does NOT merge when distance exceeds 300 m even with identical zero-token names", () => {
    assert.equal(
      isSamePlace(boracayBeachA, farBeach),
      false,
      "Zero-token match must still respect the 300 m distance threshold",
    );
  });

  it("does NOT merge when one side has tokens and the other does not", () => {
    // boracayBeachA → [], differentBeach → ['white']: asymmetric → no merge
    assert.equal(
      isSamePlace(boracayBeachA, differentBeach),
      false,
      "Asymmetric zero-token case (one side empty, other non-empty) must not merge",
    );
  });

  it("does NOT merge two different beaches that both reduce to zero tokens", () => {
    // Two different all-qualifier names that happen to be near each other but aren't the same
    const otherAllQualifierBeach: PlaceLike = {
      name: "Palawan Beach",   // 'palawan'=qualifier, 'beach'=descriptor → []
      latitude: 11.9675,
      longitude: 121.9249,
      primary_category: "beach",
    };
    // normalizeLocationName("Boracay Beach") !== normalizeLocationName("Palawan Beach")
    assert.equal(
      isSamePlace(boracayBeachA, otherAllQualifierBeach),
      false,
      "Two differently-named zero-token beaches at the same coords must not merge",
    );
  });
});

// ── normalizeLandmarkName ─────────────────────────────────────────────────────

describe("normalizeLandmarkName", () => {
  it("strips 'Falls' from 'Kawasan Falls' → ['kawasan']", () => {
    assert.deepEqual(normalizeLandmarkName("Kawasan Falls"), ["kawasan"]);
  });

  it("strips 'Waterfalls' from 'Kawasan Waterfalls' → ['kawasan']", () => {
    assert.deepEqual(normalizeLandmarkName("Kawasan Waterfalls"), ["kawasan"]);
  });

  it("strips 'Falls' and 'Cebu' from 'Kawasan Falls Cebu' → ['kawasan']", () => {
    assert.deepEqual(normalizeLandmarkName("Kawasan Falls Cebu"), ["kawasan"]);
  });

  it("strips 'Main' and 'Falls' from 'Kawasan Main Falls' → ['kawasan']", () => {
    assert.deepEqual(normalizeLandmarkName("Kawasan Main Falls"), ["kawasan"]);
  });

  it("strips 'Upper' and 'Falls' from 'Upper Kawasan Falls' → ['kawasan']", () => {
    assert.deepEqual(normalizeLandmarkName("Upper Kawasan Falls"), ["kawasan"]);
  });

  it("strips 'Beach' from 'White Beach' → ['white']", () => {
    assert.deepEqual(normalizeLandmarkName("White Beach"), ["white"]);
  });

  it("strips 'Mountain' from 'Apo Mountain' → ['apo']", () => {
    assert.deepEqual(normalizeLandmarkName("Apo Mountain"), ["apo"]);
  });

  it("strips 'Mount' from 'Mount Apo' → ['apo']", () => {
    assert.deepEqual(normalizeLandmarkName("Mount Apo"), ["apo"]);
  });

  it("handles diacritics — 'Boracáy Beach' → [] (both tokens are now descriptor/qualifier tokens)", () => {
    // 'boracay' is a geographic qualifier; 'beach' is a type noun — both stripped.
    assert.deepEqual(normalizeLandmarkName("Boracáy Beach"), []);
  });

  it("handles hyphenated names — 'El Nido-Beach' → ['el', 'nido']", () => {
    const tokens = normalizeLandmarkName("El Nido-Beach");
    assert.ok(tokens.includes("el") && tokens.includes("nido"),
      `expected 'el' and 'nido' in ${JSON.stringify(tokens)}`);
    assert.ok(!tokens.includes("beach"));
  });

  it("strips ordinal 'ii' from 'Tumalog Falls II' → ['tumalog']", () => {
    assert.deepEqual(normalizeLandmarkName("Tumalog Falls II"), ["tumalog"]);
  });

  it("returns empty array for a name composed entirely of descriptor tokens", () => {
    assert.deepEqual(normalizeLandmarkName("Upper Falls"), []);
  });

  // ── Extended geographic-qualifier blocklist ─────────────────────────────────
  it("strips 'Palawan' from 'Palawan Underground River' → ['underground']", () => {
    assert.deepEqual(normalizeLandmarkName("Palawan Underground River"), ["underground"]);
  });

  it("strips 'Boracay' from 'Boracay Puka Beach' → ['puka']", () => {
    assert.deepEqual(normalizeLandmarkName("Boracay Puka Beach"), ["puka"]);
  });

  it("strips 'Bohol' from 'Chocolate Hills Bohol' → ['chocolate', 'hills']", () => {
    const tokens = normalizeLandmarkName("Chocolate Hills Bohol");
    assert.ok(tokens.includes("chocolate") && tokens.includes("hills"),
      `expected 'chocolate' and 'hills' in ${JSON.stringify(tokens)}`);
    assert.ok(!tokens.includes("bohol"));
  });

  it("strips 'Philippines' from 'Mayon Volcano Philippines' → ['mayon', 'volcano']", () => {
    const tokens = normalizeLandmarkName("Mayon Volcano Philippines");
    assert.ok(tokens.includes("mayon") && tokens.includes("volcano"),
      `expected 'mayon' and 'volcano' in ${JSON.stringify(tokens)}`);
    assert.ok(!tokens.includes("philippines"));
  });

  it("strips 'Bali' from 'Bali Rice Terraces' → ['rice', 'terraces']", () => {
    const tokens = normalizeLandmarkName("Bali Rice Terraces");
    assert.ok(tokens.includes("rice") && tokens.includes("terraces"),
      `expected 'rice' and 'terraces' in ${JSON.stringify(tokens)}`);
    assert.ok(!tokens.includes("bali"));
  });
});

// ── isLandmark ────────────────────────────────────────────────────────────────

describe("isLandmark", () => {
  it("returns true for 'waterfall'", () => assert.equal(isLandmark("waterfall"), true));
  it("returns true for 'falls'", () => assert.equal(isLandmark("falls"), true));
  it("returns true for 'mountain'", () => assert.equal(isLandmark("mountain"), true));
  it("returns true for 'beach'", () => assert.equal(isLandmark("beach"), true));
  it("returns true for 'viewpoint'", () => assert.equal(isLandmark("viewpoint"), true));
  it("returns true for 'park'", () => assert.equal(isLandmark("park"), true));
  it("returns true for 'cave'", () => assert.equal(isLandmark("cave"), true));
  it("returns true for 'lake'", () => assert.equal(isLandmark("lake"), true));
  it("returns true for 'river'", () => assert.equal(isLandmark("river"), true));
  it("returns true for 'trail'", () => assert.equal(isLandmark("trail"), true));
  it("returns true for 'island'", () => assert.equal(isLandmark("island"), true));
  it("returns false for 'hotel'", () => assert.equal(isLandmark("hotel"), false));
  it("returns false for 'restaurant'", () => assert.equal(isLandmark("restaurant"), false));
  it("returns false for 'attraction'", () => assert.equal(isLandmark("attraction"), false));
  it("returns false for null", () => assert.equal(isLandmark(null), false));
  it("returns false for empty string", () => assert.equal(isLandmark(""), false));
  it("LANDMARK_CATEGORY_FAMILIES has correct size", () => assert.equal(LANDMARK_CATEGORY_FAMILIES.size, 10));
});

// ── isSamePlace — landmark branch ────────────────────────────────────────────

describe("isSamePlace: landmark relaxed heuristics", () => {
  // All four Kawasan variants at essentially the same coordinates.
  const BASE_LAT = 9.8697;
  const BASE_LNG = 123.3966;

  const kawasanFalls: PlaceLike = {
    name: "Kawasan Falls",
    latitude: BASE_LAT,
    longitude: BASE_LNG,
    primary_category: "waterfall",
  };
  const kawasanWaterfalls: PlaceLike = {
    name: "Kawasan Waterfalls",
    latitude: BASE_LAT + 0.0001,    // ~11 m away
    longitude: BASE_LNG,
    primary_category: "waterfall",
  };
  const kawasanFallsCebu: PlaceLike = {
    name: "Kawasan Falls Cebu",
    latitude: BASE_LAT,
    longitude: BASE_LNG + 0.0002,   // ~22 m away
    primary_category: "waterfall",
  };
  const kawasanMainFalls: PlaceLike = {
    name: "Kawasan Main Falls",
    latitude: BASE_LAT + 0.0015,    // ~167 m away — within 300 m landmark radius
    longitude: BASE_LNG,
    primary_category: "waterfall",
  };

  it("merges 'Kawasan Falls' and 'Kawasan Waterfalls' (same core token)", () => {
    assert.equal(isSamePlace(kawasanFalls, kawasanWaterfalls), true);
  });

  it("merges 'Kawasan Falls' and 'Kawasan Falls Cebu' (geographic qualifier stripped)", () => {
    assert.equal(isSamePlace(kawasanFalls, kawasanFallsCebu), true);
  });

  it("merges 'Kawasan Falls' and 'Kawasan Main Falls' (positional modifier stripped)", () => {
    assert.equal(isSamePlace(kawasanFalls, kawasanMainFalls), true);
  });

  it("merges 'Kawasan Waterfalls' and 'Kawasan Main Falls'", () => {
    assert.equal(isSamePlace(kawasanWaterfalls, kawasanMainFalls), true);
  });

  it("does NOT merge a waterfall and a mountain at the same coordinates (different sub-family)", () => {
    const mountain: PlaceLike = {
      name: "Kawasan Peak",
      latitude: BASE_LAT,
      longitude: BASE_LNG,
      primary_category: "mountain",
    };
    assert.equal(
      isSamePlace(kawasanFalls, mountain),
      false,
      "waterfall and mountain must not merge even when co-located",
    );
  });

  it("does NOT merge landmarks more than 300 m apart", () => {
    const far: PlaceLike = {
      name: "Kawasan Falls",
      latitude: BASE_LAT + 0.004,   // ~445 m — beyond 300 m landmark radius
      longitude: BASE_LNG,
      primary_category: "waterfall",
    };
    assert.equal(
      isSamePlace(kawasanFalls, far),
      false,
      "landmarks more than 300 m apart must not merge",
    );
  });

  it("does NOT merge fully dissimilar waterfall names at the same spot", () => {
    const different: PlaceLike = {
      name: "Tumalog Falls",
      latitude: BASE_LAT,
      longitude: BASE_LNG,
      primary_category: "waterfall",
    };
    assert.equal(
      isSamePlace(kawasanFalls, different),
      false,
      "waterfalls with unrelated core names must not merge",
    );
  });

  it("landmark branch does NOT fire for standard categories — hotel still uses 75 m / 0.8 rule", () => {
    const hotelA: PlaceLike = {
      name: "Grand Hotel Cebu",
      latitude: 10.3157,
      longitude: 123.8854,
      primary_category: "hotel",
    };
    // ~200 m away — within landmark radius but outside standard 75 m
    const hotelB: PlaceLike = {
      name: "Grand Hotel Cebu",
      latitude: 10.3157 + 0.0018,
      longitude: 123.8854,
      primary_category: "hotel",
    };
    assert.equal(
      isSamePlace(hotelA, hotelB),
      false,
      "hotels 200 m apart must not merge (75 m standard rule applies)",
    );
  });

  it("beach variants within 300 m are merged — 'boracay' geographic qualifier stripped", () => {
    const whiteBeach: PlaceLike = {
      name: "White Beach",
      latitude: 11.9674,
      longitude: 121.9209,
      primary_category: "beach",
    };
    const whiteBeachBoracay: PlaceLike = {
      name: "White Beach Boracay",
      latitude: 11.9674 + 0.001,  // ~111 m
      longitude: 121.9209,
      primary_category: "beach",
    };
    // "boracay" is now in the descriptor blocklist, so both names reduce to ["white"].
    // Jaccard = 1.0 ≥ 0.6 threshold → should merge.
    assert.equal(
      isSamePlace(whiteBeach, whiteBeachBoracay),
      true,
      "'White Beach' vs 'White Beach Boracay' — 'boracay' stripped, core tokens match",
    );
  });

  it("mountain variants within 300 m are merged", () => {
    const mountApo: PlaceLike = {
      name: "Mount Apo",
      latitude: 6.9888,
      longitude: 125.2701,
      primary_category: "mountain",
    };
    const apoMountain: PlaceLike = {
      name: "Apo Mountain",
      latitude: 6.9888 + 0.001,   // ~111 m
      longitude: 125.2701,
      primary_category: "mountain",
    };
    assert.equal(isSamePlace(mountApo, apoMountain), true);
  });

  // ── Tile-boundary regression ────────────────────────────────────────────────
  // The dedup sweep groups places into 0.003° tiles (~333 m). Two variants that
  // sit on opposite sides of a tile edge (different tile integers) but are still
  // within the 300 m merge radius would be missed by a same-tile-only strategy.
  //
  // The sweep now expands to the 3×3 neighbourhood of each place's tile, so
  // those cross-boundary pairs are always evaluated. These tests confirm that
  // isSamePlace itself correctly merges such pairs — proving that the fix is
  // complete once the sweep finds them.
  //
  // Tile boundary example (TILE_DEG = 0.003):
  //   - tile row 3333 covers lat 9.999–10.002
  //   - A is at lat 10.001 (tile 3333), B at lat 10.003 (tile 3334)
  //   - distance ≈ 222 m — within 300 m landmark radius but in adjacent tiles

  it("tile-boundary: two waterfalls ~222 m apart across a tile edge are merged", () => {
    const TILE_DEG = 0.003;
    // Place A just inside tile row N, place B just inside tile row N+1.
    const tileEdgeLat = Math.ceil(9.0 / TILE_DEG) * TILE_DEG; // exact tile boundary
    const a: PlaceLike = {
      name: "Tumalog Falls",
      latitude: tileEdgeLat - 0.0005,   // inside tile N
      longitude: 123.5,
      primary_category: "waterfall",
    };
    const b: PlaceLike = {
      name: "Tumalog Waterfalls",
      latitude: tileEdgeLat + 0.0015,   // inside tile N+1, ~222 m from A
      longitude: 123.5,
      primary_category: "waterfall",
    };
    // Confirm they ARE in different tiles (boundary case is real).
    const taTile = Math.floor(a.latitude! / TILE_DEG);
    const tbTile = Math.floor(b.latitude! / TILE_DEG);
    assert.notEqual(taTile, tbTile, "test setup: A and B must be in different tiles");
    // Confirm isSamePlace merges them despite the tile boundary.
    const distKm = haversineKm(a.latitude!, a.longitude!, b.latitude!, b.longitude!);
    assert.ok(distKm < 0.300, `distance ${distKm.toFixed(3)} km must be < 0.300`);
    assert.equal(
      isSamePlace(a, b),
      true,
      "cross-tile-boundary waterfall variants within 300 m must merge",
    );
  });

  // ── Extended geographic-qualifier merge tests ───────────────────────────────

  it("merges 'Palawan Underground River' and 'Underground River' — 'palawan' stripped", () => {
    const palawanRiver: PlaceLike = {
      name: "Palawan Underground River",
      latitude: 10.1780,
      longitude: 118.9117,
      primary_category: "cave",
    };
    const undergroundRiver: PlaceLike = {
      name: "Underground River",
      latitude: 10.1780 + 0.001,  // ~111 m
      longitude: 118.9117,
      primary_category: "cave",
    };
    // Both reduce to ["underground"] after stripping "palawan" / "river" / "cave" tokens.
    assert.equal(
      isSamePlace(palawanRiver, undergroundRiver),
      true,
      "'Palawan Underground River' vs 'Underground River' must merge with 'palawan' in blocklist",
    );
  });

  it("merges 'Boracay Puka Beach' and 'Puka Beach' — 'boracay' stripped", () => {
    const boracayPuka: PlaceLike = {
      name: "Boracay Puka Beach",
      latitude: 11.9925,
      longitude: 121.9440,
      primary_category: "beach",
    };
    const pukaBeach: PlaceLike = {
      name: "Puka Beach",
      latitude: 11.9925 + 0.001,  // ~111 m
      longitude: 121.9440,
      primary_category: "beach",
    };
    // Both reduce to ["puka"] after stripping "boracay" / "beach".
    assert.equal(
      isSamePlace(boracayPuka, pukaBeach),
      true,
      "'Boracay Puka Beach' vs 'Puka Beach' must merge with 'boracay' in blocklist",
    );
  });

  it("tile-boundary: two mountains ~111 m apart on opposite sides of a longitude tile edge are merged", () => {
    const TILE_DEG = 0.003;
    const tileEdgeLng = Math.ceil(125.0 / TILE_DEG) * TILE_DEG;
    const a: PlaceLike = {
      name: "Mount Kanlaon",
      latitude: 10.412,
      longitude: tileEdgeLng - 0.0002,  // inside tile col M
      primary_category: "mountain",
    };
    const b: PlaceLike = {
      name: "Kanlaon Mountain",
      latitude: 10.412,
      longitude: tileEdgeLng + 0.0008,  // inside tile col M+1, ~111 m away
      primary_category: "mountain",
    };
    const taTile = Math.floor(a.longitude! / TILE_DEG);
    const tbTile = Math.floor(b.longitude! / TILE_DEG);
    assert.notEqual(taTile, tbTile, "test setup: A and B must be in different tiles");
    assert.equal(
      isSamePlace(a, b),
      true,
      "cross-tile-boundary mountain variants within 300 m must merge",
    );
  });
});

// ── LANDMARK_DESCRIPTOR_TOKENS blocklist addition invariants ──────────────────
//
// Each pair below is a real-world landmark expressed with two name variants
// that MUST still merge whenever LANDMARK_DESCRIPTOR_TOKENS is changed.
//
// These tests are the regression guard called out in the checklist comment
// above LANDMARK_DESCRIPTOR_TOKENS in placeResolve.ts.  If a proposed new
// blocklist token causes any case here to fail, do NOT add the token.
//
// Table columns: [nameA, nameB, category, lat, description]
// Both variants are placed at the same coordinates so only name-matching is
// under test; distance is always 0 km (well within any threshold).

describe("LANDMARK_DESCRIPTOR_TOKENS blocklist addition invariants", () => {
  interface MustMergeCase {
    nameA: string;
    nameB: string;
    category: string;
    lat: number;
    lng: number;
    note: string;
  }

  const MUST_MERGE: MustMergeCase[] = [
    // Type-noun variants
    {
      nameA: "Kawasan Falls", nameB: "Kawasan Waterfalls",
      category: "waterfall", lat: 9.8697, lng: 123.3966,
      note: "type noun variant: falls / waterfalls",
    },
    {
      nameA: "Kawasan Main Falls", nameB: "Kawasan Falls",
      category: "waterfall", lat: 9.8697, lng: 123.3966,
      note: "positional modifier stripped",
    },
    {
      nameA: "Tumalog Falls", nameB: "Tumalog Waterfall",
      category: "waterfall", lat: 9.9203, lng: 123.2867,
      note: "singular vs plural type noun",
    },
    {
      nameA: "Mount Apo", nameB: "Apo Mountain",
      category: "mountain", lat: 6.9888, lng: 125.2701,
      note: "mount / mountain type noun variants",
    },
    {
      nameA: "Mount Pulag", nameB: "Mt Pulag",
      category: "mountain", lat: 16.5858, lng: 120.8889,
      note: "mount / mt abbreviation",
    },
    {
      nameA: "Mount Kitanglad", nameB: "Kitanglad Peak",
      category: "mountain", lat: 8.1800, lng: 124.8800,
      note: "mount stripped, peak stripped — core token 'kitanglad' shared",
    },
    // Geographic-qualifier variants
    {
      nameA: "Kawasan Falls", nameB: "Kawasan Falls Cebu",
      category: "waterfall", lat: 9.8697, lng: 123.3966,
      note: "'cebu' geographic qualifier stripped",
    },
    {
      nameA: "White Beach", nameB: "White Beach Boracay",
      category: "beach", lat: 11.9674, lng: 121.9209,
      note: "'boracay' geographic qualifier stripped",
    },
    {
      nameA: "Boracay Puka Beach", nameB: "Puka Beach",
      category: "beach", lat: 11.9925, lng: 121.9440,
      note: "'boracay' prefix qualifier stripped",
    },
    {
      nameA: "Chocolate Hills Bohol", nameB: "Chocolate Hills",
      category: "viewpoint", lat: 9.9019, lng: 124.1708,
      note: "'bohol' province qualifier stripped",
    },
    {
      nameA: "Palawan Underground River", nameB: "Underground River",
      category: "cave", lat: 10.1780, lng: 118.9117,
      note: "'palawan' province qualifier stripped",
    },
    // Zero-token fallback: both sides reduce to [] — identical normalised names must still merge
    {
      nameA: "Boracay Beach", nameB: "Boracáy Beach",
      category: "beach", lat: 11.9674, lng: 121.9248,
      note: "zero-token fallback — diacritic variant, both reduce to []",
    },
  ];

  for (const c of MUST_MERGE) {
    it(`merges "${c.nameA}" ↔ "${c.nameB}" [${c.note}]`, () => {
      const placeA: PlaceLike = {
        name: c.nameA,
        latitude: c.lat,
        longitude: c.lng,
        primary_category: c.category,
      };
      const placeB: PlaceLike = {
        name: c.nameB,
        latitude: c.lat,      // identical coordinates — distance = 0
        longitude: c.lng,
        primary_category: c.category,
      };
      assert.equal(
        isSamePlace(placeA, placeB),
        true,
        `"${c.nameA}" and "${c.nameB}" must still merge — check LANDMARK_DESCRIPTOR_TOKENS`,
      );
    });
  }
});

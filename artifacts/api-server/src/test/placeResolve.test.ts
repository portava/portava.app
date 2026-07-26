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

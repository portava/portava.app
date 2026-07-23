/**
 * Stamp Wave 1 — composition engine tests.
 *
 * Covers: identity resolution (seed match, deterministic fallback), the
 * composition engine (families, rarity treatments, manifest, text layers),
 * hero-art prompt v2 (no-text guarantees), candidate URL classification
 * (the gpt-image-1 b64 fix), and rasterization + QC (real sharp).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import {
  SEED_IDENTITIES,
  matchSeedIdentity,
  fallbackIdentity,
  resolveIdentity,
  stableHash,
} from "../lib/stamps/composition/identities.js";
import {
  composeStamp,
  templateFamilyForType,
  normalizeRarity,
  RARITY_TREATMENTS,
  TEMPLATE_FAMILIES,
  COMPOSITION_ENGINE_VERSION,
} from "../lib/stamps/composition/compositor.js";
import {
  rasterizeStamp,
  validateHeroBuffer,
  validateComposedPng,
} from "../lib/stamps/composition/rasterize.js";
import { buildHeroArtPrompt, buildStampPrompt, HERO_PROMPT_VERSION } from "../lib/stamps/artDirection.js";
import { classifyCandidateUrl, decodeDataImageUrl } from "../lib/stamps/generationWorker.js";

const CEBU = { ...SEED_IDENTITIES["cebu-ph"], source: "seed" as const };

const ENTRY = {
  id: "00000000-0000-0000-0000-000000000001",
  display_name: "Cebu",
  country: "Philippines",
  country_code: "PH",
  city: "Cebu",
  region: null,
  neighborhood: null,
  stamp_type: "city",
  canonical_location_key: "city:cebu:ph",
};

// ── Identity resolution ──────────────────────────────────────────────────────

describe("identity resolution", () => {
  it("matches seed identities by city + country code", () => {
    const m = matchSeedIdentity({ city: "cebu", country_code: "ph" });
    assert.ok(m);
    assert.equal(m!.identityKey, "cebu-ph");
    assert.equal(m!.source, "seed");
  });

  it("falls back to a deterministic curated palette for unknown destinations", () => {
    const a = fallbackIdentity({ canonical_location_key: "city:medellin:co", display_name: "Medellín" });
    const b = fallbackIdentity({ canonical_location_key: "city:medellin:co", display_name: "Medellín" });
    assert.deepEqual(a.palette, b.palette); // same destination → same palette, always
    assert.equal(a.source, "fallback");
    assert.equal(a.motif, "generic");
  });

  it("different destinations can get different fallback palettes (hash spread)", () => {
    const keys = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const distinct = new Set(keys.map((k) => fallbackIdentity({ canonical_location_key: k }).palette.primary));
    assert.ok(distinct.size > 1);
  });

  it("stableHash is deterministic", () => {
    assert.equal(stableHash("portava"), stableHash("portava"));
    assert.notEqual(stableHash("portava"), stableHash("portava2"));
  });

  it("resolveIdentity prefers DB rows, degrades to seed on DB error, and works with null client", async () => {
    // Null client → seed match.
    const viaSeed = await resolveIdentity(null, { city: "Tokyo", country_code: "JP" });
    assert.equal(viaSeed.identityKey, "tokyo-jp");
    assert.equal(viaSeed.source, "seed");

    // Fake DB with an identity row → db source wins.
    const dbRow = {
      identity_key: "tokyo-jp", city: "Tokyo", country: "Japan", country_code: "JP",
      palette: CEBU.palette, motif: "tokyo", wide_focus: 0.48,
    };
    const fakeSc = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
          ilike: () => ({
            eq: () => ({ limit: () => ({ eq: () => ({ maybeSingle: async () => ({ data: dbRow }) }), maybeSingle: async () => ({ data: dbRow }) }) }),
          }),
        }),
      }),
    };
    const viaDb = await resolveIdentity(fakeSc, { city: "Tokyo", country_code: "JP" });
    assert.equal(viaDb.source, "db");

    // Throwing DB → silent seed fallback.
    const throwingSc = { from: () => { throw new Error("boom"); } };
    const degraded = await resolveIdentity(throwingSc, { city: "Tokyo", country_code: "JP" });
    assert.equal(degraded.source, "seed");
  });
});

// ── Composition engine ───────────────────────────────────────────────────────

describe("composition engine", () => {
  it("derives template families from stamp types", () => {
    assert.equal(templateFamilyForType("city"), "seal");
    assert.equal(templateFamilyForType("country"), "portrait");
    assert.equal(templateFamilyForType("region"), "landscape");
    assert.equal(templateFamilyForType("neighborhood"), "square");
    assert.equal(templateFamilyForType("special_event"), "pennant");
    assert.equal(templateFamilyForType("anything_else"), "seal");
  });

  it("normalizes rarity to the 5-tier enum", () => {
    assert.equal(normalizeRarity("epic"), "epic");
    assert.equal(normalizeRarity("LEGENDARY"), "legendary");
    assert.equal(normalizeRarity("weird"), "common");
    assert.equal(normalizeRarity(null), "common");
  });

  it("composes every family × every rarity without throwing, with correct manifest", () => {
    for (const family of Object.keys(TEMPLATE_FAMILIES) as (keyof typeof TEMPLATE_FAMILIES)[]) {
      for (const rarity of Object.keys(RARITY_TREATMENTS) as (keyof typeof RARITY_TREATMENTS)[]) {
        const out = composeStamp({
          identity: CEBU, title: "CEBU", subtitle: "PHILIPPINES",
          family, rarity, uid: `t-${family}-${rarity}`,
        });
        assert.ok(out.svg.startsWith("<svg"));
        assert.equal(out.manifest.engine, COMPOSITION_ENGINE_VERSION);
        assert.equal(out.manifest.family, family);
        assert.equal(out.manifest.rarity, rarity);
        assert.equal(out.manifest.hero, "procedural"); // no AI art supplied
        assert.ok(out.manifest.layers.includes("typography"));
        // Rarity drives the frame: metals/sheen only above common.
        if (rarity === "common") {
          assert.ok(!out.svg.includes("sheen-"));
        } else {
          assert.ok(out.svg.includes(`ring-t-${family}-${rarity}`));
        }
      }
    }
  });

  it("is deterministic for identical inputs", () => {
    const a = composeStamp({ identity: CEBU, title: "CEBU", subtitle: "PHILIPPINES", family: "seal", rarity: "epic", uid: "same" });
    const b = composeStamp({ identity: CEBU, title: "CEBU", subtitle: "PHILIPPINES", family: "seal", rarity: "epic", uid: "same" });
    assert.equal(a.svg, b.svg);
  });

  it("renders title letters and authenticity micro-text as vector layers", () => {
    const out = composeStamp({ identity: CEBU, title: "CEBU", subtitle: "PHILIPPINES", family: "seal", uid: "txt" });
    for (const ch of ["C", "E", "B", "U"]) assert.ok(out.svg.includes(`>${ch}</text>`));
    // Micro-text renders letter-by-letter along the arc — assert its letters exist.
    for (const ch of ["P", "O", "R", "T", "V"]) assert.ok(out.svg.includes(`>${ch}</text>`));
  });

  it("embeds AI hero art as an image layer when provided", () => {
    const dataUrl = "data:image/png;base64,AAAA";
    const out = composeStamp({ identity: CEBU, title: "CEBU", subtitle: "PHILIPPINES", family: "portrait", heroImageDataUrl: dataUrl, uid: "ai" });
    assert.equal(out.manifest.hero, "ai");
    assert.ok(out.svg.includes(`href="${dataUrl}"`));
    assert.ok(out.manifest.layers.includes("hero:ai"));
  });

  it("labels limited editions from definition fields (no per-user data in shared art)", () => {
    const out = composeStamp({
      identity: CEBU, title: "CEBU", subtitle: "PHILIPPINES", family: "seal",
      rarity: "legendary", isLimited: true, editionSize: 25, uid: "ed",
    });
    assert.ok(out.manifest.edition.includes("LIMITED EDITION OF 25"));
    assert.ok(!/N[ºo]\s*\d/.test(out.manifest.edition)); // never a per-user edition number
  });
});

// ── Hero prompt v2 ───────────────────────────────────────────────────────────

describe("hero art prompt v2", () => {
  it("forbids text and injects the identity palette", () => {
    const prompt = buildHeroArtPrompt(ENTRY, CEBU as any);
    assert.ok(/NO TEXT/i.test(prompt));
    assert.ok(prompt.includes(CEBU.palette.primary));
    assert.ok(prompt.includes(CEBU.palette.accent));
    // The legacy prompt's typography instructions must NOT leak in.
    assert.ok(!/serif font|Typography:|name in bold/i.test(prompt));
    assert.ok(!prompt.includes("transparent PNG background"));
  });

  it("legacy prompt still asks for full stamp (unchanged behavior when flag off)", () => {
    const prompt = buildStampPrompt(ENTRY);
    assert.ok(/Typography/i.test(prompt));
  });

  it("exposes a hero prompt version for metadata", () => {
    assert.match(HERO_PROMPT_VERSION, /^hero-v/);
  });
});

// ── Candidate URL classification (gpt-image-1 b64 fix) ───────────────────────

describe("candidate URL classification", () => {
  it("classifies placeholder SVG, base64 raster, and remote URLs correctly", () => {
    assert.equal(classifyCandidateUrl("data:image/svg+xml,%3Csvg%3E"), "placeholder");
    assert.equal(classifyCandidateUrl("data:image/png;base64,AAAA"), "data_image");
    assert.equal(classifyCandidateUrl("https://example.com/x.png"), "remote");
  });

  it("decodes base64 data URLs into buffers", () => {
    const payload = Buffer.from("portava").toString("base64");
    const buf = decodeDataImageUrl(`data:image/png;base64,${payload}`);
    assert.equal(buf.toString(), "portava");
    assert.throws(() => decodeDataImageUrl("data:image/png,notbase64"));
  });
});

// ── Rasterization + QC (real sharp) ──────────────────────────────────────────

describe("rasterization and QC", () => {
  it("hero QC passes a valid 1024² PNG and fails small or corrupt buffers", async () => {
    const good = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
    const goodQc = await validateHeroBuffer(good);
    assert.equal(goodQc.passed, true);
    assert.equal(goodQc.width, 1024);

    const tiny = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const tinyQc = await validateHeroBuffer(tiny);
    assert.equal(tinyQc.passed, false);
    assert.equal(tinyQc.checks.min_size, false);

    const corrupt = await validateHeroBuffer(Buffer.from("not an image"));
    assert.equal(corrupt.passed, false);
    assert.equal(corrupt.checks.decodable, false);
  });

  it("rasterizes a composed stamp to dual PNG assets that pass composed QC", async () => {
    const composed = composeStamp({ identity: CEBU, title: "CEBU", subtitle: "PHILIPPINES", family: "seal", rarity: "epic", uid: "raster" });
    const raster = await rasterizeStamp(composed.svg);

    const fullMeta = await sharp(raster.full).metadata();
    assert.equal(fullMeta.format, "png");
    assert.equal(fullMeta.width, 1024);

    const thumbMeta = await sharp(raster.thumbnail).metadata();
    assert.equal(thumbMeta.width, 256);

    const qc = await validateComposedPng(raster.full);
    assert.equal(qc.passed, true, qc.reason ?? "expected composed QC to pass");
  });
});

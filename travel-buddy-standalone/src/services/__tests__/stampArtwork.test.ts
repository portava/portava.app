/**
 * Stamp artwork resolver + validation unit tests.
 * Run with: node --import tsx/esm --test src/services/__tests__/stampArtwork.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveArtwork,
  rarityForKind,
} from "../../lib/stampArtworkResolver.ts";

import { STAMP_RARITY_LABELS } from "../../types/stampArtwork.ts";

import {
  validateSvgContent,
  validateAccessibilityLabel,
  validateArtworkImageUrl,
  validateArtworkAsset,
} from "../../lib/stampArtworkValidation.ts";

import type { PassportStamp } from "../../types/models.ts";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function makeStamp(overrides: Partial<PassportStamp> = {}): PassportStamp {
  return {
    id: "test-id",
    kind: "city",
    label: "Manila",
    sublabel: undefined,
    earnedAt: "2024-01-01T00:00:00Z",
    locked: false,
    ...overrides,
  } as unknown as PassportStamp;
}

/* ── resolveArtwork — shape ───────────────────────────────────────────────── */

describe("resolveArtwork — shape", () => {
  it("city stamps render as oval", () => {
    const art = resolveArtwork(makeStamp({ kind: "city" }));
    assert.equal(art.shape, "oval");
  });

  it("plan stamps render as rect", () => {
    const art = resolveArtwork(makeStamp({ kind: "plan" }));
    assert.equal(art.shape, "rect");
  });

  it("gem stamps render as hexagon", () => {
    const art = resolveArtwork(makeStamp({ kind: "gem" }));
    assert.equal(art.shape, "hexagon");
  });

  it("safe stamps render as round", () => {
    const art = resolveArtwork(makeStamp({ kind: "safe" }));
    assert.equal(art.shape, "round");
  });

  it("host stamps render as rect", () => {
    const art = resolveArtwork(makeStamp({ kind: "host" }));
    assert.equal(art.shape, "rect");
  });

  it("perk stamps render as round", () => {
    const art = resolveArtwork(makeStamp({ kind: "perk" }));
    assert.equal(art.shape, "round");
  });
});

/* ── resolveArtwork — rarity ─────────────────────────────────────────────── */

describe("resolveArtwork — rarity", () => {
  it("city stamps are rare", () => {
    const art = resolveArtwork(makeStamp({ kind: "city" }));
    assert.equal(art.rarity, "rare");
  });

  it("plan stamps are uncommon", () => {
    const art = resolveArtwork(makeStamp({ kind: "plan" }));
    assert.equal(art.rarity, "uncommon");
  });

  it("gem stamps are rare", () => {
    const art = resolveArtwork(makeStamp({ kind: "gem" }));
    assert.equal(art.rarity, "rare");
  });

  it("safe stamps are uncommon", () => {
    const art = resolveArtwork(makeStamp({ kind: "safe" }));
    assert.equal(art.rarity, "uncommon");
  });

  it("host stamps are epic", () => {
    const art = resolveArtwork(makeStamp({ kind: "host" }));
    assert.equal(art.rarity, "epic");
  });

  it("perk stamps are common", () => {
    const art = resolveArtwork(makeStamp({ kind: "perk" }));
    assert.equal(art.rarity, "common");
  });

  it("rarityForKind matches resolveArtwork rarity", () => {
    const kinds: PassportStamp["kind"][] = ["city", "plan", "gem", "safe", "host", "perk"];
    for (const kind of kinds) {
      const art = resolveArtwork(makeStamp({ kind }));
      assert.equal(rarityForKind(kind), art.rarity, `rarity mismatch for ${kind}`);
    }
  });
});

/* ── resolveArtwork — shimmer & glow ─────────────────────────────────────── */

describe("resolveArtwork — shimmer & glow", () => {
  it("epic stamps have shimmer", () => {
    const art = resolveArtwork(makeStamp({ kind: "host" }));
    assert.equal(art.hasShimmer, true);
  });

  it("common stamps have no shimmer", () => {
    const art = resolveArtwork(makeStamp({ kind: "perk" }));
    assert.equal(art.hasShimmer, false);
  });

  it("rare stamps have no shimmer", () => {
    const art = resolveArtwork(makeStamp({ kind: "city" }));
    assert.equal(art.hasShimmer, false);
  });
});

/* ── resolveArtwork — category accent colors ─────────────────────────────── */

describe("resolveArtwork — category accent colors", () => {
  it("city stamps use teal accent", () => {
    const art = resolveArtwork(makeStamp({ kind: "city" }));
    assert.equal(art.accent, "#0A3D4A");
  });

  it("plan stamps use signal red accent", () => {
    const art = resolveArtwork(makeStamp({ kind: "plan" }));
    assert.equal(art.accent, "#FF4D2E");
  });

  it("gem stamps use purple accent", () => {
    const art = resolveArtwork(makeStamp({ kind: "gem" }));
    assert.equal(art.accent, "#7A4DBF");
  });

  it("safe stamps use green accent", () => {
    const art = resolveArtwork(makeStamp({ kind: "safe" }));
    assert.equal(art.accent, "#2E7D5B");
  });

  it("host stamps use near-black accent", () => {
    const art = resolveArtwork(makeStamp({ kind: "host" }));
    assert.equal(art.accent, "#11110F");
  });

  it("perk stamps use amber accent", () => {
    const art = resolveArtwork(makeStamp({ kind: "perk" }));
    assert.equal(art.accent, "#C8851A");
  });
});

/* ── resolveArtwork — locked state ──────────────────────────────────────── */

describe("resolveArtwork — locked state", () => {
  it("locked stamps use grayscale accent", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", locked: true }));
    assert.equal(art.accent, "#D1D5DB");
  });

  it("locked stamps use grayscale background", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", locked: true }));
    assert.equal(art.background, "#F3F4F6");
  });

  it("locked stamps have no shimmer", () => {
    const art = resolveArtwork(makeStamp({ kind: "host", locked: true }));
    assert.equal(art.hasShimmer, false);
  });

  it("locked flag is reflected in the def", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", locked: true }));
    assert.equal(art.locked, true);
  });

  it("unlocked stamps have locked=false", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", locked: false }));
    assert.equal(art.locked, false);
  });

  it("locked stamps use solid pattern", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", locked: true }));
    assert.equal(art.pattern, "solid");
  });
});

/* ── resolveArtwork — accessibility label ────────────────────────────────── */

describe("resolveArtwork — accessibility label", () => {
  it("unlocked label includes stamp label and category", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", label: "Tokyo" }));
    assert.match(art.accessibilityLabel, /Tokyo/);
    assert.match(art.accessibilityLabel, /CITY/i);
  });

  it("locked label says locked", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", label: "Tokyo", locked: true }));
    assert.match(art.accessibilityLabel.toLowerCase(), /locked/);
  });

  it("label is non-empty for all kinds", () => {
    const kinds: PassportStamp["kind"][] = ["city", "plan", "gem", "safe", "host", "perk"];
    for (const kind of kinds) {
      const art = resolveArtwork(makeStamp({ kind }));
      assert.ok(art.accessibilityLabel.length > 0, `empty label for ${kind}`);
    }
  });
});

/* ── resolveArtwork — city caption ──────────────────────────────────────── */

describe("resolveArtwork — city caption", () => {
  it("cebu stamp gets DIVING caption", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", label: "Cebu" }));
    assert.equal(art.captionText, "DIVING");
  });

  it("bangkok stamp gets STREET FOOD caption", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", label: "Bangkok" }));
    assert.equal(art.captionText, "STREET FOOD");
  });

  it("unknown city gets no caption", () => {
    const art = resolveArtwork(makeStamp({ kind: "city", label: "Atlantis" }));
    assert.equal(art.captionText, undefined);
  });

  it("non-city stamps do not get captions", () => {
    const art = resolveArtwork(makeStamp({ kind: "plan", label: "Bangkok" }));
    assert.equal(art.captionText, undefined);
  });
});

/* ── resolveArtwork — border style by rarity ─────────────────────────────── */

describe("resolveArtwork — border style by rarity", () => {
  it("common stamps use single border", () => {
    const art = resolveArtwork(makeStamp({ kind: "perk" }));
    assert.equal(art.borderStyle, "single");
  });

  it("uncommon stamps use double border", () => {
    const art = resolveArtwork(makeStamp({ kind: "plan" }));
    assert.equal(art.borderStyle, "double");
  });

  it("rare stamps use sawtooth border", () => {
    const art = resolveArtwork(makeStamp({ kind: "city" }));
    assert.equal(art.borderStyle, "sawtooth");
  });

  it("epic stamps use wave border with heavier weight", () => {
    const art = resolveArtwork(makeStamp({ kind: "host" }));
    assert.equal(art.borderStyle, "wave");
    assert.ok(art.borderWeight >= 3);
  });
});

/* ── validateSvgContent — safety ─────────────────────────────────────────── */

describe("validateSvgContent — safety", () => {
  const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';

  it("accepts safe SVG", () => {
    const result = validateSvgContent(SAFE_SVG);
    assert.equal(result.valid, true);
  });

  it("rejects <script> tag", () => {
    const result = validateSvgContent('<svg><script>alert(1)</script></svg>');
    assert.equal(result.valid, false);
  });

  it("rejects onclick event handler", () => {
    const result = validateSvgContent('<svg><circle onclick="alert(1)" r="10"/></svg>');
    assert.equal(result.valid, false);
  });

  it("rejects javascript: URI", () => {
    const result = validateSvgContent('<svg><a href="javascript:alert(1)"><circle/></a></svg>');
    assert.equal(result.valid, false);
  });

  it("rejects <iframe>", () => {
    const result = validateSvgContent('<svg><iframe src="evil.com"/></svg>');
    assert.equal(result.valid, false);
  });

  it("rejects external xlink:href", () => {
    const result = validateSvgContent('<svg><use xlink:href="https://evil.com/sprite.svg#icon"/></svg>');
    assert.equal(result.valid, false);
  });

  it("allows fragment xlink:href (#local)", () => {
    const result = validateSvgContent('<svg><use xlink:href="#local-icon"/></svg>');
    assert.equal(result.valid, true);
  });
});

/* ── validateAccessibilityLabel ─────────────────────────────────────────── */

describe("validateAccessibilityLabel", () => {
  it("accepts a valid label", () => {
    const result = validateAccessibilityLabel("Tokyo city stamp");
    assert.equal(result.valid, true);
  });

  it("rejects empty string", () => {
    const result = validateAccessibilityLabel("");
    assert.equal(result.valid, false);
  });

  it("rejects whitespace-only string", () => {
    const result = validateAccessibilityLabel("   ");
    assert.equal(result.valid, false);
  });

  it("rejects undefined", () => {
    const result = validateAccessibilityLabel(undefined as any);
    assert.equal(result.valid, false);
  });

  it("rejects too-short label", () => {
    const result = validateAccessibilityLabel("ab");
    assert.equal(result.valid, false);
  });
});

/* ── validateArtworkImageUrl ─────────────────────────────────────────────── */

describe("validateArtworkImageUrl", () => {
  it("accepts .png URL", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/stamp.png");
    assert.equal(result.valid, true);
  });

  it("accepts .webp URL", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/stamp.webp");
    assert.equal(result.valid, true);
  });

  it("accepts .svg URL", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/stamp.svg");
    assert.equal(result.valid, true);
  });

  it("rejects .gif URL without MIME", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/stamp.gif");
    assert.equal(result.valid, false);
  });

  it("rejects .exe URL", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/malware.exe");
    assert.equal(result.valid, false);
  });

  it("accepts unknown extension when valid MIME type provided", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/stamp.bin", "image/png");
    assert.equal(result.valid, true);
  });

  it("rejects when MIME type is not in allow-list", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/stamp.bin", "text/html");
    assert.equal(result.valid, false);
  });

  it("strips query params when checking extension", () => {
    const result = validateArtworkImageUrl("https://cdn.example.com/stamp.png?v=2");
    assert.equal(result.valid, true);
  });
});

/* ── validateArtworkAsset — combined ─────────────────────────────────────── */

describe("validateArtworkAsset — combined", () => {
  it("fails when SVG is unsafe and label is missing", () => {
    const result = validateArtworkAsset({
      svgContent: "<svg><script>bad</script></svg>",
      accessibilityLabel: "",
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 2);
  });

  it("passes when SVG is safe and label is present", () => {
    const result = validateArtworkAsset({
      svgContent: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>',
      accessibilityLabel: "Safe stamp artwork",
    });
    assert.equal(result.valid, true);
  });

  it("fails on bad image URL with valid label", () => {
    const result = validateArtworkAsset({
      imageUrl: "https://cdn.example.com/bad.exe",
      accessibilityLabel: "A stamp",
    });
    assert.equal(result.valid, false);
  });
});

/* ── STAMP_RARITY_LABELS ─────────────────────────────────────────────────── */

describe("STAMP_RARITY_LABELS", () => {
  it("has a label for every rarity", () => {
    const rarities = ["common", "uncommon", "rare", "epic"] as const;
    for (const r of rarities) {
      assert.ok(
        typeof STAMP_RARITY_LABELS[r] === "string" && STAMP_RARITY_LABELS[r].length > 0,
        `missing label for rarity ${r}`
      );
    }
  });
});

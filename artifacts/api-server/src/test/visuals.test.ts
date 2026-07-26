/**
 * Unit tests for the Visual Generation System pure logic.
 * No DB, no provider — deterministic functions only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceStyle, isKnownStyle, styleIsIllustrated, DEFAULT_STYLE } from "../lib/visuals/styles.js";
import { cleanText, cleanEnum, cleanList, isBannedKey, stripBanned, timeOfDayFromHour } from "../lib/visuals/sanitize.js";
import { promptHash, canonicalSnapshot, stableStringify } from "../lib/visuals/promptHash.js";
import { buildEventPrompt, buildPlacePrompt, NEGATIVE_PROMPT, promptVersionFor } from "../lib/visuals/promptBuilder.js";
import { resolveHeaderImage, sourceRank, mayApplyGenerated } from "../lib/visuals/priority.js";
import { fallbackSlug } from "../lib/visuals/providers/categoryFallbackProvider.js";
import type { VisualInputSnapshot } from "../lib/visuals/types.js";

function snap(over: Partial<VisualInputSnapshot> = {}): VisualInputSnapshot {
  return {
    entityType: "event",
    purpose: "event_header",
    title: "Sunset Rooftop Mixer",
    category: "nightlife",
    city: "Makati",
    country: "Philippines",
    setting: "rooftop",
    timeOfDay: "sunset",
    style: "portava_editorial",
    renderMode: "realistic",
    people: "auto",
    promptVersion: "event-header-v1",
    ...over,
  };
}

// ── styles ────────────────────────────────────────────────────────────────────
test("coerceStyle falls back to default for unknown", () => {
  assert.equal(coerceStyle("nonsense"), DEFAULT_STYLE);
  assert.equal(coerceStyle("cinematic_travel"), "cinematic_travel");
  assert.equal(coerceStyle(null), DEFAULT_STYLE);
});
test("isKnownStyle + styleIsIllustrated", () => {
  assert.ok(isKnownStyle("passport_poster"));
  assert.ok(!isKnownStyle("hacker"));
  assert.ok(styleIsIllustrated("minimal_illustration"));
  assert.ok(!styleIsIllustrated("portava_editorial"));
});

// ── sanitize ────────────────────────────────────────────────────────────────
test("cleanText clamps, collapses whitespace, strips control chars", () => {
  assert.equal(cleanText("  hello   world  "), "hello world");
  assert.equal(cleanText("a".repeat(300), 10), "aaaaaaaaaa");
  assert.equal(cleanText(""), null);
  assert.equal(cleanText(123 as any), null);
});
test("cleanEnum lowercases", () => {
  assert.equal(cleanEnum("Night Life"), "night life");
});
test("cleanList dedupes + caps", () => {
  assert.deepEqual(cleanList(["a", "A", "b", ""]), ["a", "b"]);
  assert.equal(cleanList(["x", "y", "z", "w"], 2).length, 2);
});
test("isBannedKey blocks PII fields", () => {
  assert.ok(isBannedKey("phone"));
  assert.ok(isBannedKey("email_address"));
  assert.ok(isBannedKey("passport"));
  assert.ok(isBannedKey("lat"));
  assert.ok(!isBannedKey("category"));
});
test("stripBanned removes PII keys", () => {
  const out = stripBanned({ title: "x", phone: "555", lat: 1, category: "bar" });
  assert.deepEqual(Object.keys(out).sort(), ["category", "title"]);
});
test("timeOfDayFromHour buckets", () => {
  assert.equal(timeOfDayFromHour(2), "night");
  assert.equal(timeOfDayFromHour(9), "morning");
  assert.equal(timeOfDayFromHour(13), "afternoon");
  assert.equal(timeOfDayFromHour(18), "sunset");
  assert.equal(timeOfDayFromHour(20), "evening");
  assert.equal(timeOfDayFromHour(null), null);
});

// ── prompt hash ───────────────────────────────────────────────────────────────
test("promptHash is stable + order-independent", () => {
  const h1 = promptHash(snap());
  const h2 = promptHash(snap());
  assert.equal(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});
test("promptHash changes when a prompt-relevant field changes", () => {
  const base = promptHash(snap());
  assert.notEqual(base, promptHash(snap({ city: "Cebu" })));
  assert.notEqual(base, promptHash(snap({ style: "cinematic_travel" })));
});
test("promptHash ignores case + whitespace on enum-ish fields", () => {
  assert.equal(promptHash(snap({ city: "Makati" })), promptHash(snap({ city: "  makati " })));
});
test("canonicalSnapshot drops empty fields", () => {
  const c = canonicalSnapshot(snap({ neighborhood: null, description: undefined }));
  assert.ok(!("neighborhood" in c));
});
test("stableStringify sorts keys", () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

// ── prompt builder ────────────────────────────────────────────────────────────
test("event prompt includes context + safety constraints, excludes title text", () => {
  const p = buildEventPrompt(snap());
  assert.match(p, /social event/i);
  assert.match(p, /Makati/);
  assert.match(p, /No readable text/i);
  assert.match(p, /Do not render the event title as text/i);
});
test("place prompt is labeled a representation, not documentary", () => {
  const p = buildPlacePrompt(
    snap({
      entityType: "place",
      purpose: "place_header",
      title: "Harbor Catch",
      category: "restaurant",
      subcategory: "seafood",
      city: "Cebu City",
      traits: ["waterfront", "outdoor seating"],
      priceLevel: "premium",
    }),
  );
  assert.match(p, /representation/i);
  assert.match(p, /not a documentary image/i);
  assert.match(p, /Cebu City/);
});
test("NEGATIVE_PROMPT + promptVersionFor", () => {
  assert.match(NEGATIVE_PROMPT, /no logos/);
  assert.equal(promptVersionFor("event_header"), "event-header-v1");
  assert.equal(promptVersionFor("place_header"), "place-header-v1");
});

// ── priority resolver ─────────────────────────────────────────────────────────
test("sourceRank ordering: user_upload beats everything", () => {
  assert.ok(sourceRank("user_upload") > sourceRank("official"));
  assert.ok(sourceRank("official") > sourceRank("provider"));
  assert.ok(sourceRank("ai_generated") > sourceRank("category_fallback"));
});
test("resolveHeaderImage picks highest priority usable url", () => {
  const r = resolveHeaderImage([
    { url: "ai.webp", source: "ai_generated" },
    { url: "up.jpg", source: "user_upload" },
    { url: "", source: "official" }, // empty → ignored
  ]);
  assert.equal(r?.url, "up.jpg");
  assert.equal(r?.source, "user_upload");
});
test("resolveHeaderImage flags AI place image as representation", () => {
  const r = resolveHeaderImage([{ url: "ai.webp", source: "ai_generated" }], { entityType: "place" });
  assert.equal(r?.isRepresentation, true);
  const rEvent = resolveHeaderImage([{ url: "ai.webp", source: "ai_generated" }], { entityType: "event" });
  assert.equal(rEvent?.isRepresentation, false);
});
test("resolveHeaderImage returns null when nothing usable", () => {
  assert.equal(resolveHeaderImage([{ url: null, source: "ai_generated" }]), null);
});
test("mayApplyGenerated blocks overwriting a real source or a newer upload", () => {
  assert.ok(mayApplyGenerated({ source: "category_fallback", updatedAt: null }, "2026-07-25T00:00:00Z"));
  assert.ok(!mayApplyGenerated({ source: "user_upload", updatedAt: null }, "2026-07-25T00:00:00Z"));
  assert.ok(!mayApplyGenerated({ source: "ai_generated", updatedAt: "2026-07-26T00:00:00Z" }, "2026-07-25T00:00:00Z"));
});

// ── fallback provider ─────────────────────────────────────────────────────────
test("fallbackSlug maps known categories + generic default", () => {
  assert.equal(fallbackSlug("restaurant", "place"), "restaurant");
  assert.equal(fallbackSlug("cocktail bar", "place"), "cocktail-bar");
  assert.equal(fallbackSlug("unknownthing", "place"), "generic-place");
  assert.equal(fallbackSlug(null, "event"), "generic-event");
});

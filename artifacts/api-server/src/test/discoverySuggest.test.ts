/**
 * Unit tests for the /api/discovery/suggest pure helpers:
 * group ordering (exact > prefix > contains), canonical city merging,
 * and canonical→SearchResult mapping (public fields only).
 *
 * Run: npx tsx --test src/test/discoverySuggest.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderSuggestGroups,
  mergeCitySuggestions,
  canonicalToCityResult,
  type SuggestGroupPayload,
  type SearchResult,
} from "../routes/discoverySearch";
import type { CanonicalRow } from "../lib/canonicalLocations";

function result(over: Partial<SearchResult>): SearchResult {
  return {
    id: over.id ?? Math.random().toString(36).slice(2),
    type: over.type ?? "travelers",
    title: over.title ?? "Test",
    subtitle: null,
    avatarUrl: null,
    imageUrl: null,
    fallbackInitials: "T",
    locationPreview: null,
    matchedReason: null,
    actionState: null,
    privacyState: null,
    accessState: { canAccess: true },
    destinationRoute: null,
    metadata: null,
    createdAt: null,
    startsAt: null,
    ...over,
  };
}

function group(type: SuggestGroupPayload["type"], label: string, titles: string[]): SuggestGroupPayload {
  return { type, label, items: titles.map((title, i) => result({ id: `${type}-${i}`, type, title })) };
}

const canonicalRow = (over: Partial<CanonicalRow>): CanonicalRow => ({
  id: "c1",
  kind: "city",
  name: "Bali",
  normalized_name: "bali",
  display_name: "Bali, Indonesia",
  city: null,
  region: null,
  country: "Indonesia",
  country_code: "ID",
  postal_code: null,
  lat: -8.34,
  lng: 115.09,
  provider_ids: {},
  aliases: [],
  ...over,
});

// ── orderSuggestGroups ────────────────────────────────────────────────────────

test("group with an exact title match outranks earlier prefix-only groups", () => {
  const groups = [
    group("travelers", "Travelers", ["Balim Explorer", "Balina Smith"]), // prefix matches
    group("cities", "Cities", ["Bali"]),                                  // exact match
  ];
  const ordered = orderSuggestGroups(groups, "bali");
  assert.equal(ordered[0].type, "cities");
  assert.equal(ordered[1].type, "travelers");
});

test("equal best tiers keep plan order (stable sort)", () => {
  const groups = [
    group("travelers", "Travelers", ["Bali Guide Ana"]),
    group("events", "Events", ["Bali Beach Party"]),
  ];
  const ordered = orderSuggestGroups(groups, "bali");
  assert.equal(ordered[0].type, "travelers");
  assert.equal(ordered[1].type, "events");
});

test("contains-only groups sink below prefix groups", () => {
  const groups = [
    group("posts", "Posts", ["My trip to Bali was great"]), // contains
    group("cities", "Cities", ["Balikpapan"]),              // prefix
  ];
  const ordered = orderSuggestGroups(groups, "bali");
  assert.equal(ordered[0].type, "cities");
});

// ── mergeCitySuggestions ──────────────────────────────────────────────────────

test("canonical city wins over profile-derived duplicate (case-insensitive)", () => {
  const canonical = [canonicalToCityResult(canonicalRow({}))];
  const profile = [
    result({ id: "city:bali", type: "cities", title: "BALI", subtitle: null }),
    result({ id: "city:ubud", type: "cities", title: "Ubud" }),
  ];
  const merged = mergeCitySuggestions(canonical, profile, 4);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].title, "Bali");
  assert.equal((merged[0].metadata as any)?.source, "canonical");
  assert.equal(merged[1].title, "Ubud");
});

test("merge respects the limit", () => {
  const canonical = [
    canonicalToCityResult(canonicalRow({ id: "c1", name: "Bali", normalized_name: "bali" })),
    canonicalToCityResult(canonicalRow({ id: "c2", name: "Balikpapan", normalized_name: "balikpapan" })),
  ];
  const profile = [
    result({ id: "city:baltimore", type: "cities", title: "Baltimore" }),
    result({ id: "city:balestier", type: "cities", title: "Balestier" }),
  ];
  assert.equal(mergeCitySuggestions(canonical, profile, 3).length, 3);
});

test("blank titles are dropped, not deduped into a phantom entry", () => {
  const profile = [
    result({ id: "city:x", type: "cities", title: "  " }),
    result({ id: "city:y", type: "cities", title: "Bali" }),
  ];
  const merged = mergeCitySuggestions([], profile, 4);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "Bali");
});

// ── canonicalToCityResult ─────────────────────────────────────────────────────

test("canonical mapping exposes only public geo fields", () => {
  const r = canonicalToCityResult(canonicalRow({}));
  assert.equal(r.type, "cities");
  assert.equal(r.id, "city:bali");
  assert.equal(r.title, "Bali");
  assert.equal(r.subtitle, "Indonesia");
  assert.equal(r.destinationRoute, "/city/bali");
  assert.equal(r.avatarUrl, null);
  assert.equal(r.privacyState, null);
  assert.deepEqual(r.accessState, { canAccess: true });
  // Metadata carries only registry geo data — no user linkage of any kind
  assert.deepEqual(Object.keys(r.metadata ?? {}).sort(), ["canonicalId", "lat", "lng", "source"]);
});

test("city route slug is lowercased and URL-encoded", () => {
  const r = canonicalToCityResult(canonicalRow({ name: "São Paulo", normalized_name: "sao paulo" }));
  assert.equal(r.destinationRoute, `/city/${encodeURIComponent("são paulo")}`);
});

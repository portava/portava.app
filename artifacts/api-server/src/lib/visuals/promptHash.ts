/**
 * Deterministic prompt hashing + cache key.
 *
 * The hash is computed over a normalized snapshot of ONLY prompt-relevant fields,
 * so the same entity + style + version always maps to the same hash and a completed
 * image can be reused instead of paying for another generation.
 */
import { createHash } from "node:crypto";
import type { VisualInputSnapshot } from "./types.js";

/**
 * Build the canonical object that feeds the hash. Excludes private data (already
 * stripped upstream), volatile timestamps, and anything not affecting the image.
 * Enum-ish fields are lowercased; arrays are sorted; empties are removed.
 */
export function canonicalSnapshot(s: VisualInputSnapshot): Record<string, unknown> {
  const norm = (v: string | null | undefined) =>
    v == null ? undefined : String(v).trim().toLowerCase() || undefined;
  const list = (v: string[] | undefined) =>
    v && v.length ? [...v].map((x) => x.trim().toLowerCase()).filter(Boolean).sort() : undefined;

  const obj: Record<string, unknown> = {
    entityType: s.entityType,
    purpose: s.purpose,
    title: norm(s.title),
    category: norm(s.category),
    subcategory: norm(s.subcategory),
    // description is used as the "Activity" line in event prompts and must be
    // included so that editing an event's description invalidates the hash and
    // triggers a fresh generation instead of reusing a stale image.
    description: norm(s.description),
    city: norm(s.city),
    neighborhood: norm(s.neighborhood),
    country: norm(s.country),
    venue: norm(s.venue),
    setting: norm(s.setting),
    timeOfDay: norm(s.timeOfDay),
    priceLevel: norm(s.priceLevel),
    amenities: list(s.amenities),
    traits: list(s.traits),
    style: s.style,
    renderMode: s.renderMode,
    people: s.people,
    promptVersion: s.promptVersion,
  };
  // Drop undefined keys so absent fields don't change the hash.
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

/** Stable JSON stringify with sorted keys (so key order never affects the hash). */
export function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

export function promptHash(s: VisualInputSnapshot): string {
  const canonical = stableStringify(canonicalSnapshot(s));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Gem submission wizard — pure validation and payload logic.
 *
 * Extracted from app/gems/submit.tsx so that the step-gating rules and
 * submit-payload shape can be exercised without mounting a React Native
 * component. Lives outside app/ so Expo Router does not treat it as a route.
 */

import type { GemCategory, GemSensitivity } from '../../services/hiddenGems';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Subset of FormState fields that validation and payload-building depend on. */
export interface WizardFormState {
  name: string;
  category: GemCategory | '';
  city: string;
  country: string;
  neighborhood: string;
  description: string;
  gpsLat: number | undefined;
  gpsLng: number | undefined;
  gpsLabel: string | undefined;
  vibeTags: string;
  priceRange: string;
  safetyNotes: string;
  bestTimeToGo: string;
  layoverSafe: boolean;
  minimumLayoverMinutes: string;
  sensitivityLevel: GemSensitivity;
}

// ── Step count (0-indexed) ────────────────────────────────────────────────────

/** Total number of wizard steps. */
export const WIZARD_STEP_COUNT = 4;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Returns true when the "Next / Submit" button should be enabled.
 *
 * Step 0 — Location: city is required (GPS alone is not enough).
 * Step 1 — Details: name and category are both required.
 * Step 2 — Privacy: always passable (has a sensible default).
 * Step 3 — Review:  always passable (final submit guard in buildSubmitPayload).
 */
export function canNext(step: number, form: WizardFormState): boolean {
  if (step === 0) return form.city.trim().length > 0;
  if (step === 1) return form.name.trim().length > 0 && form.category.length > 0;
  return true;
}

// ── Payload builder ───────────────────────────────────────────────────────────

/** Shape returned by buildSubmitPayload — matches the submitGem() parameter type. */
export interface GemSubmitPayload {
  name: string;
  category: GemCategory;
  city: string;
  country: string | undefined;
  neighborhood: string | undefined;
  description: string | undefined;
  latitude: number | undefined;
  longitude: number | undefined;
  vibeTags: string[] | undefined;
  priceRange: string | undefined;
  safetyNotes: string | undefined;
  bestTimeToGo: string | undefined;
  layoverSafe: boolean;
  minimumLayoverMinutes: number | undefined;
  sensitivityLevel: GemSensitivity;
}

/**
 * Builds the submitGem() payload from the current form state.
 *
 * Returns null when required fields (name, category, city) are missing so
 * callers can show a validation alert instead of calling the API.
 */
export function buildSubmitPayload(form: WizardFormState): GemSubmitPayload | null {
  if (!form.name.trim() || !form.category || !form.city.trim()) {
    return null;
  }

  const tags = form.vibeTags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    name:                  form.name.trim(),
    category:              form.category as GemCategory,
    city:                  form.city.trim(),
    country:               form.country.trim() || undefined,
    neighborhood:          form.neighborhood.trim() || undefined,
    description:           form.description.trim() || undefined,
    latitude:              form.gpsLat,
    longitude:             form.gpsLng,
    vibeTags:              tags.length > 0 ? tags : undefined,
    priceRange:            form.priceRange || undefined,
    safetyNotes:           form.safetyNotes.trim() || undefined,
    bestTimeToGo:          form.bestTimeToGo.trim() || undefined,
    layoverSafe:           form.layoverSafe,
    minimumLayoverMinutes: form.minimumLayoverMinutes
      ? parseInt(form.minimumLayoverMinutes, 10)
      : undefined,
    sensitivityLevel:      form.sensitivityLevel,
  };
}

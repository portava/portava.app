/**
 * Global Input Intelligence — Phase 3 (Global Search): field registration.
 *
 * §5/§52: a field joins the platform by registering a policy, not by building a
 * new engine. This registers the canonical fieldId for the global search bar so
 * its policy (mode `search`, entity types, `public` privacy, `recent_only`
 * offline, telemetry) resolves from the registry rather than an ephemeral
 * default. Mirrors `geographic/geoFields.ts`.
 *
 * `registerSearchFields()` is idempotent and safe to call at module load or on
 * any screen mount. Pure registry operation (no React/network) — unit-testable.
 */
import type { InputContext } from '../types/inputContext.ts';
import { registerField, isFieldRegistered } from '../contexts/fieldRegistry.ts';

/**
 * Canonical fieldIds for the search surfaces. Stable keys shared by the
 * registry, cache, and telemetry. `discovery.search` matches the id used in the
 * client audit's §50 field table for the global search bar.
 */
export const SEARCH_FIELD_IDS = {
  globalSearch: 'discovery.search',
} as const;

export type SearchFieldId = (typeof SEARCH_FIELD_IDS)[keyof typeof SEARCH_FIELD_IDS];

/** fieldId → InputContext for every search field. */
export const SEARCH_FIELD_CONTEXTS: Record<SearchFieldId, InputContext> = {
  [SEARCH_FIELD_IDS.globalSearch]: 'global_search',
};

let done = false;

/**
 * Register every search field's policy. Idempotent — repeated calls are a no-op
 * after the first, and a field already registered (e.g. by a test) is left
 * untouched.
 */
export function registerSearchFields(): void {
  if (done) return;
  for (const [fieldId, context] of Object.entries(SEARCH_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) registerField(fieldId, context);
  }
  done = true;
}

/** Test-only: reset the idempotency latch so registration can be re-exercised. */
export function _resetSearchRegistration(): void {
  done = false;
}

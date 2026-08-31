/**
 * Global Input Intelligence — the field registry (spec §5, §52).
 *
 * A process-global map of `fieldId → InputFieldPolicy`. Screens register a
 * field once (module load or first render) and every primitive/hook resolves
 * the field's policy from here. This is the mechanism that makes "one platform
 * layer" real: a new field is added by registering a policy, not by building a
 * new engine (§2, §52).
 *
 * Pure module — no React, no network — so it is unit-testable under node:test.
 */
import type { InputContext } from '../types/inputContext.ts';
import type { InputFieldPolicy } from '../types/fieldPolicy.ts';
import { buildDefaultPolicy } from './inputPolicies.ts';

const REGISTRY = new Map<string, InputFieldPolicy>();

/**
 * Register (or replace) a field's policy. Returns the resolved policy so a
 * caller can register-and-use in one expression.
 *
 * Two call shapes:
 *   registerField('trip.destination', 'trip_destination')            // defaults
 *   registerField('username', 'username', { validationRules: [...] }) // + overrides
 */
export function registerField(
  fieldId: string,
  context: InputContext,
  overrides?: Partial<InputFieldPolicy>,
): InputFieldPolicy {
  const policy = buildDefaultPolicy(fieldId, context, overrides);
  REGISTRY.set(fieldId, policy);
  return policy;
}

/** Register a fully-formed policy object (advanced — most callers use registerField). */
export function registerPolicy(policy: InputFieldPolicy): InputFieldPolicy {
  REGISTRY.set(policy.fieldId, policy);
  return policy;
}

/** True when a fieldId has an explicit registered policy. */
export function isFieldRegistered(fieldId: string): boolean {
  return REGISTRY.has(fieldId);
}

/**
 * Resolve a field's policy.
 *
 * If the field was never registered but a `fallbackContext` is supplied, an
 * ephemeral default policy for that context is returned (NOT stored) so a
 * primitive can render safely during the migration period without every screen
 * having to pre-register. When neither is available, returns `null` and the
 * caller must degrade to a plain, unassisted input (fail-safe, never throw).
 */
export function resolveFieldPolicy(
  fieldId: string,
  fallbackContext?: InputContext,
): InputFieldPolicy | null {
  const existing = REGISTRY.get(fieldId);
  if (existing) return existing;
  if (fallbackContext) return buildDefaultPolicy(fieldId, fallbackContext);
  return null;
}

/** Remove a field's registration. Primarily for tests + hot-reload hygiene. */
export function unregisterField(fieldId: string): void {
  REGISTRY.delete(fieldId);
}

/** Snapshot of all registered fieldIds (stable order = insertion order). */
export function registeredFieldIds(): string[] {
  return [...REGISTRY.keys()];
}

/** Clear the whole registry. Tests only — never call from app code. */
export function _resetRegistry(): void {
  REGISTRY.clear();
}

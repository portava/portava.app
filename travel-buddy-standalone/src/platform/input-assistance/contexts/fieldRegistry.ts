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

/**
 * fieldId → what the screen DECLARED, not the policy that was derived from it.
 *
 * ── WHY THIS HOLDS A DECLARATION AND NOT A POLICY (2026-09-21, G340) ─────────
 *
 * It used to hold the built `InputFieldPolicy`. `registerField` called
 * `buildDefaultPolicy` once and stored the result, and `resolveFieldPolicy`
 * handed that object back forever after.
 *
 * That was fine while the context descriptors were a constant table compiled
 * into the bundle — the snapshot could never go out of date, because there was
 * nothing for it to go out of date WITH. G340 changed exactly that: descriptors
 * now come from the authority, and they change when the authority is fetched,
 * when it is refetched under a new `policyVersion`, when the account switches,
 * and when the snapshot expires.
 *
 * A stored policy would have missed every one of those. Every field in the app
 * is registered once at boot (`registerGeographicFields()` and friends, from
 * `app/_layout.tsx`), which is BEFORE the first policy fetch can land — so each
 * one would have frozen the conservative cold-start policy and kept it for the
 * life of the process. The feature would have appeared to work in tests that
 * seed before registering, and done nothing at all in the app.
 *
 * Caught by `useInputAssistance.localTier.component.test.tsx`'s §32 pair, which
 * seeds a policy AFTER the field is registered and got exactly inverted
 * results. Storing the declaration and resolving on demand is what makes a
 * policy change reach a field that was registered before it.
 */
interface FieldDeclaration {
  context: InputContext;
  overrides: Partial<InputFieldPolicy>;
}

const REGISTRY = new Map<string, FieldDeclaration>();

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
  REGISTRY.set(fieldId, { context, overrides: overrides ?? {} });
  // Built fresh for the caller's convenience. It is NOT what gets stored, and
  // a caller that holds onto it holds a snapshot — resolve again to see a
  // policy change.
  return buildDefaultPolicy(fieldId, context, overrides);
}

/**
 * Register a fully-formed policy object (advanced — most callers use
 * registerField).
 *
 * The object's non-derivable members are kept as OVERRIDES over its context's
 * descriptor, so a policy registered this way still tracks the authority for
 * everything it did not state explicitly. Registering a whole frozen policy
 * would reintroduce, for one field, exactly the staleness G340 removed.
 */
export function registerPolicy(policy: InputFieldPolicy): InputFieldPolicy {
  const { fieldId, context, ...rest } = policy;
  REGISTRY.set(fieldId, { context, overrides: rest });
  return buildDefaultPolicy(fieldId, context, rest);
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
  const declared = REGISTRY.get(fieldId);
  // Built on every call, from the CURRENT descriptor. See REGISTRY's header:
  // returning a stored policy would pin the field to whatever the authority
  // had said at registration time, which for every field in the app is "the
  // authority has not answered yet".
  if (declared) return buildDefaultPolicy(fieldId, declared.context, declared.overrides);
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

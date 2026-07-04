/**
 * SafeReturnSetupSheet — contact-loading logic.
 *
 * Extracted from the component's `useEffect([visible])` so that the error
 * branches can be covered by node:test without a React renderer:
 *
 *   A) both calls succeed  → returns populated contact lists, loadError: false
 *   B) getTrustedContacts throws  → returns empty lists, loadError: true
 *   C) listEmergencyContacts throws  → returns empty lists, loadError: true
 *   D) both throw together → returns empty lists, loadError: true
 *
 * The function NEVER throws. This is the invariant that guarantees the
 * component's `setContactsLoading(false)` call (which comes right after
 * `runContactLoad` returns) is always reached — so the spinner never gets stuck.
 *
 * The function is deliberately dependency-free (no React, no React Native,
 * no Supabase) so it can be imported by node:test + tsx/esm with no shimming.
 *
 * Run tests with:
 *   node --import tsx/esm --test \
 *     src/components/__tests__/SafeReturnSetupSheet.contactLoad.test.ts
 */

// ── Minimal interfaces ─────────────────────────────────────────────────────────
// Defined inline to keep this module dependency-free. The component passes its
// own service functions which satisfy these shapes at runtime.

export interface ContactLoadDeps<TC, EC> {
  getTrustedContacts: () => Promise<TC[]>;
  /** Returns `{ contacts: EC[] }` — we only read the `contacts` field. */
  listEmergencyContacts: () => Promise<{ contacts: EC[] }>;
}

export interface ContactLoadResult<TC, EC> {
  trustedContacts: TC[];
  emergencyContacts: EC[];
  /**
   * True when at least one service call threw an error.
   * Both contact lists will be empty. The form still opens — contact loading
   * failure is non-fatal.
   */
  loadError: boolean;
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Loads trusted contacts and emergency contacts in parallel.
 *
 * Never rejects. On any error both lists are empty and `loadError` is true.
 * The caller does NOT need a try/catch — the non-throwing contract is what
 * guarantees `setContactsLoading(false)` always runs in the component.
 */
export async function runContactLoad<TC, EC>(
  deps: ContactLoadDeps<TC, EC>,
): Promise<ContactLoadResult<TC, EC>> {
  try {
    const [tc, ec] = await Promise.all([
      deps.getTrustedContacts(),
      deps.listEmergencyContacts(),
    ]);
    return { trustedContacts: tc, emergencyContacts: ec.contacts, loadError: false };
  } catch {
    // Non-fatal — the user can still set up a Safe Return session without
    // pre-selected contacts.
    return { trustedContacts: [], emergencyContacts: [], loadError: true };
  }
}

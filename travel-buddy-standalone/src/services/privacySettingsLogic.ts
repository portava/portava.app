import type { PrivacySettings, ProfileResult } from './profile.ts';

export interface PrivacyChangeCallbacks {
  setPrivacy(next: PrivacySettings | null): void;
  setSaving(saving: boolean): void;
  onError(message: string): void;
}

/**
 * Applies an optimistic privacy-setting change, calls updateFn, and rolls
 * back to the previous state (+ fires onError) if the update fails.
 *
 * This is the extracted, pure business logic from the Privacy settings screen.
 * It has no React Native imports so it can be exercised in node:test suites.
 *
 * No-op guard: when `privacy` is null (settings not yet loaded, or load
 * failed) the function returns immediately without calling updateFn. This
 * means a load failure silently disables all toggles — no crash and no
 * unintended mutation.
 */
export async function applyPrivacyChange<K extends keyof PrivacySettings>(
  privacy: PrivacySettings | null,
  key: K,
  value: PrivacySettings[K],
  callbacks: PrivacyChangeCallbacks,
  updateFn: (patch: Partial<PrivacySettings>) => Promise<ProfileResult<PrivacySettings>>,
): Promise<void> {
  if (!privacy) return;
  const previous = privacy;
  callbacks.setPrivacy({ ...privacy, [key]: value });
  callbacks.setSaving(true);
  const res = await updateFn({ [key]: value } as Partial<PrivacySettings>);
  callbacks.setSaving(false);
  if (!res.ok) {
    callbacks.setPrivacy(previous);
    callbacks.onError(res.message ?? 'Could not update setting. Try again.');
  }
}

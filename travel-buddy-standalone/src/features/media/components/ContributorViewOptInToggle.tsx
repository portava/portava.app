/**
 * ContributorViewOptInToggle — Media v2 Phase 10 (§19) contributor opt-in.
 *
 * A clear, revocable setting to opt IN/OUT of being asked to contribute a live
 * view (PUT /api/v1/media/view-requests/opt-in). OFF BY DEFAULT framing: the
 * user is never a contributor until they choose to be, and can turn it off any
 * time.
 *
 * FLAG-GATED (§19 hard constraint): reads `media_request_a_view_enabled`;
 * renders NOTHING when off/unknown, so the settings screen is untouched until
 * the capability is enabled.
 *
 * The backend exposes only a WRITE (no read-back of the current opt-in), so the
 * toggle reflects the user's own last choice, persisted best-effort on-device.
 * The write is optimistic with revert-on-failure — the source of that rule is the
 * pure `resolveOptInAfterRequest` helper (unit-tested), so the UI can't drift.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFeatureFlags } from '../../../context/FeatureFlagsContext.tsx';
import { SettingsSection, ToggleRow } from '../../../components/settings/SettingsUI.tsx';
import { REQUEST_A_VIEW_FLAG } from './RequestAViewPrompt.tsx';
import { setContributorViewOptIn, resolveOptInAfterRequest } from '../services/viewRequest.ts';

/** On-device memory of the user's own last opt-in choice (no server read-back). */
export const OPT_IN_STORAGE_KEY = 'media.viewContributor.optedIn';

export interface ContributorViewOptInToggleProps {
  /** Optional city to scope the opt-in to (contributor availability is city-scoped). */
  city?: string | null;
}

export function ContributorViewOptInToggle({ city = null }: ContributorViewOptInToggleProps) {
  const { isEnabled } = useFeatureFlags();
  const enabled = isEnabled(REQUEST_A_VIEW_FLAG);

  const [optedIn, setOptedIn] = useState(false); // off by default
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Best-effort restore of the user's own last choice. Failure ⇒ stays off.
  useEffect(() => {
    if (!enabled) return;
    void AsyncStorage.getItem(OPT_IN_STORAGE_KEY)
      .then((v) => {
        if (mounted.current && v === 'true') setOptedIn(true);
      })
      .catch(() => {
        /* no-op — defaults to off */
      });
  }, [enabled]);

  const onToggle = useCallback(
    (next: boolean) => {
      const prior = optedIn;
      setOptedIn(next); // optimistic
      setBusy(true);
      void setContributorViewOptIn(next, city).then((res) => {
        if (!mounted.current) return;
        const committed = resolveOptInAfterRequest(next, prior, res.ok);
        setOptedIn(committed);
        setBusy(false);
        // Persist only what the server confirmed (or the reverted value).
        void AsyncStorage.setItem(OPT_IN_STORAGE_KEY, committed ? 'true' : 'false').catch(() => {
          /* non-fatal */
        });
      });
    },
    [optedIn, city],
  );

  if (!enabled) return null;

  return (
    <SettingsSection
      title="Contributing live views"
      subtitle="When you’re at a place, you may occasionally be asked to share a current photo so others see what’s happening now. Off by default — turn it off any time."
    >
      <ToggleRow
        title="Offer to share a live view"
        subtitle={optedIn ? 'You may be asked when you’re near a place that needs a fresh view.' : 'You won’t be asked to contribute views.'}
        value={optedIn}
        onValueChange={onToggle}
        disabled={busy}
      />
    </SettingsSection>
  );
}

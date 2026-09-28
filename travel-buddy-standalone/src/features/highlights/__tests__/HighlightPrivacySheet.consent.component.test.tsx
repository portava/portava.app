/**
 * HighlightPrivacySheet — the §10 CONSENT section, from a person's side.
 *
 * Highlights/Memories Development Architecture Spec v1 §10; census H75 (the
 * five consent dimensions) and H200 (public derivatives behind an explicit
 * publication policy).
 *
 * WHY THIS SUITE EXISTS. `consent_share = false` is a live withholding gate on
 * every non-owner surface — `consentWithholds` is asked for it on
 * `public_projection` and on `proactive_resurfacing` — and until this section
 * existed it was settable by NO USER. The word "consent" did not appear in
 * HighlightPrivacySheet.tsx at all.
 *
 * WHAT IS ASSERTED IS THE THING THAT GOES WRONG IF A CLIENT GUESSES:
 *
 *   - only the dimensions the SERVER marked `enforced` get a switch. The other
 *     three are stored and read by nothing, and a switch that changes nothing a
 *     viewer can observe is a lie told with a tick.
 *   - the list is READ, never typed. A third enforced dimension appears with no
 *     client edit — that is the whole reason `consentEnforcement` is on the
 *     wire rather than copied into this file.
 *   - `null` (never chosen) and a stored `false` are DIFFERENT and render
 *     differently. They are different claims about what the owner decided.
 *   - a save sends a PARTIAL patch naming one dimension. Sending the whole
 *     consent object would reset a dimension this build predates.
 *   - a failed save does not move the row, and `feature_disabled` is not
 *     offered a retry.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — react-native-safe-area-context needs a
// native SafeAreaProvider that jest-expo does not provide; zero insets keep the
// sheet's padding math from crashing without touching anything this suite
// asserts. Same stand-in the sibling suite in this folder uses.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { HighlightPrivacySheet, type PrivacySheetIO } from '../HighlightPrivacySheet.tsx';
import type {
  ResurfacingControlsView,
  ProjectionPolicyView,
  ConsentValue,
} from '../privacyControlsApi.ts';

const HID = '30000000-0000-4000-8000-000000000009';

const ALL_DIMENSIONS = ['STORE', 'RESURFACE', 'PERSONALIZE', 'SHARE', 'CONTRIBUTE_TO_AGGREGATE_INTEL'];

function controlsView(): ResurfacingControlsView {
  return {
    controls: [],
    unenforceableOnFeed: [],
    catalogue: [
      {
        control: 'DO_NOT_RESURFACE',
        scope: 'highlight',
        suppresses: ['proactive_resurfacing'],
        note: 'Retain and search privately; suppress proactive resurfacing.',
      },
    ],
  };
}

/**
 * The shape `GET /highlights/:id/projection-policy` actually serves today,
 * including `consentEnforcement` — derived server-side from the table the gate
 * reads (`SURFACE_CONSENT_DIMENSIONS`), not a literal there either.
 */
function policyView(over: Partial<ProjectionPolicyView> = {}): ProjectionPolicyView {
  const consent: Record<string, ConsentValue> = {};
  for (const d of ALL_DIMENSIONS) consent[d] = null;
  return {
    highlightId: HID,
    locationPrecision: null,
    personVisibility: null,
    consent,
    locationPrecisionLadder: ['EXACT', 'VENUE', 'NEIGHBORHOOD', 'CITY', 'COUNTRY', 'HIDDEN'],
    personVisibilityLadder: ['NAMED', 'PROFILE_LINKED', 'CREW_ONLY', 'ANONYMOUS_COUNT', 'HIDDEN'],
    consentDimensions: [...ALL_DIMENSIONS],
    consentEnforcement: {
      enforced: ['RESURFACE', 'SHARE'],
      unenforced: ['STORE', 'PERSONALIZE', 'CONTRIBUTE_TO_AGGREGATE_INTEL'],
      bySurface: {
        proactive_resurfacing: ['RESURFACE', 'SHARE'],
        public_projection: ['SHARE'],
      },
      note: 'An unenforced dimension is STORED and read by no surface in this repository.',
    },
    ...over,
  };
}

function io(over: Partial<PrivacySheetIO> = {}): Partial<PrivacySheetIO> {
  return {
    loadControls: jest.fn(async () => ({ ok: true, data: controlsView() })),
    loadPolicy: jest.fn(async () => ({ ok: true, data: policyView() })),
    setControl: jest.fn(async () => ({ ok: true, data: null })),
    clearControl: jest.fn(async () => ({ ok: true, data: { cleared: true } })),
    savePolicy: jest.fn(async () => ({ ok: true, data: policyView() })),
    ...over,
  } as Partial<PrivacySheetIO>;
}

function sheet(props: Partial<React.ComponentProps<typeof HighlightPrivacySheet>> = {}) {
  return (
    <HighlightPrivacySheet
      visible
      highlightId={HID}
      onClose={() => {}}
      notify={props.notify ?? (() => {})}
      confirm={props.confirm ?? (async () => true)}
      {...props}
      io={props.io ?? io()}
    />
  );
}

describe('HighlightPrivacySheet — §10 consent', () => {
  it('offers a switch for exactly the dimensions the server marked ENFORCED', async () => {
    const { findByTestId, queryByTestId } = await render(sheet());
    await findByTestId('highlight-privacy-sheet');

    expect(await findByTestId('highlight-privacy-consent-RESURFACE')).toBeTruthy();
    expect(await findByTestId('highlight-privacy-consent-SHARE')).toBeTruthy();

    // STORE, PERSONALIZE and CONTRIBUTE_TO_AGGREGATE_INTEL are stored and read
    // by nothing. Offering them would promise an effect no viewer can observe.
    expect(queryByTestId('highlight-privacy-consent-STORE')).toBeNull();
    expect(queryByTestId('highlight-privacy-consent-PERSONALIZE')).toBeNull();
    expect(queryByTestId('highlight-privacy-consent-CONTRIBUTE_TO_AGGREGATE_INTEL')).toBeNull();
  });

  it('renders a dimension the client has never heard of, because the list is READ not typed', async () => {
    // The day a third dimension is wired the server's `enforced` grows and no
    // client is edited. If this file's list were a literal, this fails.
    const loadPolicy = jest.fn(async () => ({
      ok: true,
      data: policyView({
        consentDimensions: [...ALL_DIMENSIONS, 'TRAIN_MODELS'],
        consentEnforcement: {
          enforced: ['RESURFACE', 'SHARE', 'TRAIN_MODELS'],
          unenforced: ['STORE', 'PERSONALIZE', 'CONTRIBUTE_TO_AGGREGATE_INTEL'],
          bySurface: {
            proactive_resurfacing: ['RESURFACE', 'SHARE'],
            public_projection: ['SHARE', 'TRAIN_MODELS'],
          },
          note: 'derived',
        },
      }),
    }));
    const { findByTestId } = await render(sheet({ io: io({ loadPolicy }) }));
    expect(await findByTestId('highlight-privacy-consent-TRAIN_MODELS')).toBeTruthy();
  });

  it('shows the surfaces a dimension gates, taken from the server’s bySurface map', async () => {
    const { findByTestId } = await render(sheet());
    // SHARE is asked on BOTH surfaces; RESURFACE only on the proactive one.
    const share = await findByTestId('highlight-privacy-consent-surfaces-SHARE');
    const resurface = await findByTestId('highlight-privacy-consent-surfaces-RESURFACE');
    expect(String(share.props.children)).toContain('public');
    expect(String(resurface.props.children)).not.toContain('public');
  });

  it('tells a stored WITHHELD apart from never having chosen', async () => {
    const withheld = jest.fn(async () => ({
      ok: true,
      data: policyView({
        consent: { STORE: null, RESURFACE: null, PERSONALIZE: null, SHARE: false, CONTRIBUTE_TO_AGGREGATE_INTEL: null },
      }),
    }));
    const { findByTestId } = await render(sheet({ io: io({ loadPolicy: withheld }) }));
    // A stored `false` is a DECISION. An unset dimension is not one, and the
    // two must not print the same.
    expect(await findByTestId('highlight-privacy-consent-state-SHARE-withheld')).toBeTruthy();
    expect(await findByTestId('highlight-privacy-consent-state-RESURFACE-unset')).toBeTruthy();
  });

  it('withholding one dimension sends a PARTIAL patch naming only that dimension, then re-reads', async () => {
    const savePolicy = jest.fn(async () => ({ ok: true, data: policyView() }));
    let reads = 0;
    const loadPolicy = jest.fn(async () => {
      reads += 1;
      return {
        ok: true,
        data: reads === 1
          ? policyView()
          : policyView({
              consent: { STORE: null, RESURFACE: null, PERSONALIZE: null, SHARE: false, CONTRIBUTE_TO_AGGREGATE_INTEL: null },
            }),
      };
    });
    const onChanged = jest.fn();
    const { findByTestId } = await render(sheet({ io: io({ savePolicy, loadPolicy }), onChanged }));

    await findByTestId('highlight-privacy-consent-state-SHARE-unset');
    fireEvent.press(await findByTestId('highlight-privacy-consent-withhold-SHARE'));

    await waitFor(() => expect(savePolicy).toHaveBeenCalled());
    expect(savePolicy).toHaveBeenCalledWith(HID, { consent: { SHARE: false } });
    // The tick follows the SERVER's answer, not the tap.
    expect(await findByTestId('highlight-privacy-consent-state-SHARE-withheld')).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('pressing the state already stored clears it back to not-chosen', async () => {
    const savePolicy = jest.fn(async () => ({ ok: true, data: policyView() }));
    const loadPolicy = jest.fn(async () => ({
      ok: true,
      data: policyView({
        consent: { STORE: null, RESURFACE: null, PERSONALIZE: null, SHARE: true, CONTRIBUTE_TO_AGGREGATE_INTEL: null },
      }),
    }));
    const { findByTestId } = await render(sheet({ io: io({ savePolicy, loadPolicy }) }));

    await findByTestId('highlight-privacy-consent-state-SHARE-granted');
    fireEvent.press(await findByTestId('highlight-privacy-consent-allow-SHARE'));
    await waitFor(() => expect(savePolicy).toHaveBeenCalledWith(HID, { consent: { SHARE: null } }));
  });

  it('a refused save reports itself and does not move the row', async () => {
    const savePolicy = jest.fn(async () => ({
      ok: false,
      data: null,
      errorKind: 'feature_disabled' as const,
      message: 'nope',
    }));
    const notify = jest.fn();
    const { findByTestId } = await render(sheet({ io: io({ savePolicy }), notify }));

    await findByTestId('highlight-privacy-consent-state-SHARE-unset');
    fireEvent.press(await findByTestId('highlight-privacy-consent-withhold-SHARE'));

    await waitFor(() => expect(notify).toHaveBeenCalled());
    // Permanent, so no "try again".
    expect(String(notify.mock.calls[0][1])).not.toContain('try again');
    // And the row is still where the server left it.
    expect(await findByTestId('highlight-privacy-consent-state-SHARE-unset')).toBeTruthy();
  });

  it('offers NO consent switches when the server sent no enforcement map', async () => {
    // A deployment older than `consentEnforcement`. The client cannot know
    // which dimensions bite, and guessing is exactly the second vocabulary this
    // map exists to prevent — so it says it cannot offer them rather than
    // rendering five switches of unknown effect.
    const loadPolicy = jest.fn(async () => ({
      ok: true,
      data: policyView({ consentEnforcement: undefined }),
    }));
    const { findByTestId, queryByTestId } = await render(sheet({ io: io({ loadPolicy }) }));
    await findByTestId('highlight-privacy-consent-unavailable');
    for (const d of ALL_DIMENSIONS) {
      expect(queryByTestId(`highlight-privacy-consent-${d}`)).toBeNull();
    }
  });
});

/**
 * HighlightPrivacySheet — the §10 / §11 controls, from a person's side.
 *
 * Highlights/Memories Development Architecture Spec v1 §10 and §11; census
 * §O.2, which recorded both control tables as deployed, enforced and EMPTY
 * because no surface existed to write them.
 *
 * What is asserted here is what a user would notice:
 *   - the controls offered are the ones the SERVER declared, not a list typed
 *     into the client
 *   - turning one on calls the server and then re-reads, so the tick only
 *     appears for something that was actually stored
 *   - a control the server cannot enforce on the feed says so on its own row
 *   - "not available on this deployment" and "could not save" are DIFFERENT
 *     messages, because one is permanent and one is worth retrying
 *   - the strongest control cannot be turned off without a confirmation
 *   - a failed LOAD is not an empty settings screen
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, waitFor, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — react-native-safe-area-context needs a native
// SafeAreaProvider that jest-expo does not provide; zero insets keep the sheet's
// padding math from crashing without touching anything this suite asserts.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { HighlightPrivacySheet, type PrivacySheetIO } from '../HighlightPrivacySheet.tsx';
import type { ResurfacingControlsView, ProjectionPolicyView } from '../privacyControlsApi.ts';

const HID = '30000000-0000-4000-8000-000000000002';

function controlsView(over: Partial<ResurfacingControlsView> = {}): ResurfacingControlsView {
  return {
    controls: [],
    unenforceableOnFeed: ['HIDE_TRIP'],
    catalogue: [
      { control: 'DO_NOT_RESURFACE', scope: 'highlight', suppresses: ['proactive_resurfacing'], note: 'Retain and search privately; suppress proactive resurfacing.' },
      { control: 'KEEP_PRIVATE_FOREVER', scope: 'highlight', suppresses: ['proactive_resurfacing', 'recap', 'personalization', 'public_projection'], note: 'The strongest control that is still not a delete.' },
      { control: 'HIDE_PERSON_FROM_RESURFACING', scope: 'person', suppresses: ['proactive_resurfacing', 'recap'], note: 'Keyed on a participant id.' },
      { control: 'HIDE_TRIP', scope: 'trip', suppresses: ['proactive_resurfacing', 'recap'], note: 'Keyed on a trip id.' },
    ],
    ...over,
  };
}

function policyView(over: Partial<ProjectionPolicyView> = {}): ProjectionPolicyView {
  return {
    highlightId: HID,
    locationPrecision: null,
    personVisibility: null,
    consent: { STORE: null, RESURFACE: null, PERSONALIZE: null, SHARE: null, CONTRIBUTE_TO_AGGREGATE_INTEL: null },
    locationPrecisionLadder: ['EXACT', 'VENUE', 'NEIGHBORHOOD', 'CITY', 'COUNTRY', 'HIDDEN'],
    personVisibilityLadder: ['NAMED', 'PROFILE_LINKED', 'CREW_ONLY', 'ANONYMOUS_COUNT', 'HIDDEN'],
    consentDimensions: ['STORE', 'RESURFACE', 'PERSONALIZE', 'SHARE', 'CONTRIBUTE_TO_AGGREGATE_INTEL'],
    ...over,
  };
}

function io(over: Partial<PrivacySheetIO> = {}): Partial<PrivacySheetIO> {
  return {
    loadControls: jest.fn(async () => ({ ok: true, data: controlsView() })),
    loadPolicy: jest.fn(async () => ({ ok: true, data: policyView() })),
    setControl: jest.fn(async () => ({ ok: true, data: null as any })),
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

describe('HighlightPrivacySheet', () => {
  it('offers the highlight-scoped controls the SERVER declared and no others', async () => {
    const { findByTestId, queryByTestId } = await render(sheet());
    await findByTestId('highlight-privacy-sheet');
    expect(await findByTestId('highlight-privacy-control-DO_NOT_RESURFACE')).toBeTruthy();
    expect(await findByTestId('highlight-privacy-control-KEEP_PRIVATE_FOREVER')).toBeTruthy();
    // A person- or trip-scoped control on a per-Highlight sheet would write a
    // row the database's own CHECK constraint forbids.
    expect(queryByTestId('highlight-privacy-control-HIDE_PERSON_FROM_RESURFACING')).toBeNull();
    expect(queryByTestId('highlight-privacy-control-HIDE_TRIP')).toBeNull();
  });

  it('turning a control on calls the server and shows the tick only after a re-read confirms it', async () => {
    const setControl = jest.fn(async () => ({ ok: true, data: null as any }));
    let reads = 0;
    const loadControls = jest.fn(async () => {
      reads += 1;
      // The FIRST read is the empty state; the second is what the server holds
      // after the write. A component that ticked optimistically would pass even
      // if the server had stored nothing.
      return {
        ok: true,
        data: reads === 1
          ? controlsView()
          : controlsView({ controls: [{ control: 'DO_NOT_RESURFACE', subjectType: 'highlight', subjectId: HID, createdAt: null, suppresses: ['proactive_resurfacing'], retainsRecord: true }] }),
      };
    });
    const onChanged = jest.fn();
    const { findByTestId } = await render(sheet({ io: io({ setControl, loadControls }), onChanged }));

    await findByTestId('highlight-privacy-control-state-DO_NOT_RESURFACE-off');
    fireEvent.press(await findByTestId('highlight-privacy-control-DO_NOT_RESURFACE'));

    await findByTestId('highlight-privacy-control-state-DO_NOT_RESURFACE-on');
    expect(setControl).toHaveBeenCalledWith('DO_NOT_RESURFACE', HID);
    expect(onChanged).toHaveBeenCalled();
  });

  it('a REFUSED write leaves the control off and says why, rather than ticking it', async () => {
    const notify = jest.fn();
    const setControl = jest.fn(async () => ({ ok: false, data: null, errorKind: 'degraded_unavailable' as const }));
    const { findByTestId } = await render(sheet({ io: io({ setControl }), notify }));

    fireEvent.press(await findByTestId('highlight-privacy-control-DO_NOT_RESURFACE'));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0][1]).toMatch(/could not save/i);
    // The state the user is left looking at must be the TRUE one.
    expect(await findByTestId('highlight-privacy-control-state-DO_NOT_RESURFACE-off')).toBeTruthy();
  });

  it('distinguishes "not available on this deployment" from "could not save"', async () => {
    const notify = jest.fn();
    const setControl = jest.fn(async () => ({ ok: false, data: null, errorKind: 'feature_disabled' as const }));
    const { findByTestId } = await render(sheet({ io: io({ setControl }), notify }));

    fireEvent.press(await findByTestId('highlight-privacy-control-DO_NOT_RESURFACE'));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    // Permanent, so it must NOT invite a retry. Collapsing this into the
    // transient message is how somebody keeps tapping a control that will
    // never exist on their build.
    expect(notify.mock.calls[0][1]).toMatch(/not available/i);
    expect(notify.mock.calls[0][1]).not.toMatch(/try again/i);
  });

  it('names a control the feed cannot enforce on its own row', async () => {
    // Census H90: `public.highlights` carries no trip reference, so the server
    // cannot hide ONE trip and withholds the whole proactive surface instead.
    // A switch that said nothing would promise an effect that is not delivered.
    const { findByTestId, queryByTestId } = await render(sheet({
      io: io({
        loadControls: jest.fn(async () => ({
          ok: true,
          data: controlsView({
            unenforceableOnFeed: ['DO_NOT_RESURFACE'],
          }),
        })),
      }),
    }));
    expect(await findByTestId('highlight-privacy-unenforceable-DO_NOT_RESURFACE')).toBeTruthy();
    expect(queryByTestId('highlight-privacy-unenforceable-KEEP_PRIVATE_FOREVER')).toBeNull();
  });

  it('will not turn OFF keep-private-forever without a confirmation', async () => {
    const clearControl = jest.fn(async () => ({ ok: true, data: { cleared: true } }));
    const confirm = jest.fn(async () => false);
    const { findByTestId } = await render(sheet({
      confirm,
      io: io({
        clearControl,
        loadControls: jest.fn(async () => ({
          ok: true,
          data: controlsView({ controls: [{ control: 'KEEP_PRIVATE_FOREVER', subjectType: 'highlight', subjectId: HID, createdAt: null, suppresses: ['proactive_resurfacing', 'recap', 'personalization', 'public_projection'], retainsRecord: true }] }),
        })),
      }),
    }));

    fireEvent.press(await findByTestId('highlight-privacy-control-KEEP_PRIVATE_FOREVER'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(clearControl).not.toHaveBeenCalled();
    expect(await findByTestId('highlight-privacy-control-state-KEEP_PRIVATE_FOREVER-on')).toBeTruthy();
  });

  it('clears it once the confirmation is given', async () => {
    const clearControl = jest.fn(async () => ({ ok: true, data: { cleared: true } }));
    const { findByTestId } = await render(sheet({
      confirm: async () => true,
      io: io({
        clearControl,
        loadControls: jest.fn(async () => ({
          ok: true,
          data: controlsView({ controls: [{ control: 'KEEP_PRIVATE_FOREVER', subjectType: 'highlight', subjectId: HID, createdAt: null, suppresses: ['proactive_resurfacing'], retainsRecord: true }] }),
        })),
      }),
    }));
    fireEvent.press(await findByTestId('highlight-privacy-control-KEEP_PRIVATE_FOREVER'));
    await waitFor(() => expect(clearControl).toHaveBeenCalledWith('KEEP_PRIVATE_FOREVER', HID, { confirm: true }));
  });

  it('saves a §10 precision rung and shows the one the server returned', async () => {
    const savePolicy = jest.fn(async () => ({ ok: true, data: policyView({ locationPrecision: 'COUNTRY' }) }));
    const { findByTestId } = await render(sheet({ io: io({ savePolicy }) }));

    await findByTestId('highlight-privacy-precision-state-COUNTRY-off');
    fireEvent.press(await findByTestId('highlight-privacy-precision-COUNTRY'));
    await findByTestId('highlight-privacy-precision-state-COUNTRY-on');
    expect(savePolicy).toHaveBeenCalledWith(HID, { locationPrecision: 'COUNTRY' });
  });

  it('pressing the selected rung again UNSETS it rather than re-sending the same value', async () => {
    const savePolicy = jest.fn(async () => ({ ok: true, data: policyView({ locationPrecision: null }) }));
    const { findByTestId } = await render(sheet({
      io: io({ savePolicy, loadPolicy: jest.fn(async () => ({ ok: true, data: policyView({ locationPrecision: 'CITY' }) })) }),
    }));
    fireEvent.press(await findByTestId('highlight-privacy-precision-CITY'));
    await waitFor(() => expect(savePolicy).toHaveBeenCalledWith(HID, { locationPrecision: null }));
  });

  it('renders the ladder in §10 order, coarsening downward', async () => {
    const { findByTestId } = await render(sheet());
    // The ORDER is the meaning: a screen that sorted these alphabetically would
    // render a tightening as a loosening.
    const sheetNode: any = await findByTestId('highlight-privacy-sheet');
    const ids: string[] = [];
    const walk = (n: any) => {
      const id = n?.props?.testID;
      if (typeof id === 'string' && id.startsWith('highlight-privacy-precision-') && !id.includes('-state-')) ids.push(id);
      (n?.children ?? []).forEach(walk);
    };
    walk(sheetNode);
    expect(ids).toEqual([
      'highlight-privacy-precision-EXACT',
      'highlight-privacy-precision-VENUE',
      'highlight-privacy-precision-NEIGHBORHOOD',
      'highlight-privacy-precision-CITY',
      'highlight-privacy-precision-COUNTRY',
      'highlight-privacy-precision-HIDDEN',
    ]);
  });

  it('a failed LOAD is not an empty settings screen', async () => {
    // Rendering "nothing is set" for an outage invites somebody to set a
    // control that is already set, and on the next load they see two.
    const { findByTestId, queryByTestId } = await render(sheet({
      io: io({ loadControls: jest.fn(async () => ({ ok: false, data: null, errorKind: 'degraded_unavailable' as const })) }),
    }));
    expect(await findByTestId('highlight-privacy-unavailable')).toBeTruthy();
    expect(queryByTestId('highlight-privacy-control-DO_NOT_RESURFACE')).toBeNull();
  });
});

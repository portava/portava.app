/**
 * Telegraph §4.3 at the point of authorship — the location and Memory Note
 * compose sheets.
 *
 *   §4.3  "Use approximate proximity or controlled distance buckets by
 *          default."
 *   §6.1  Location and Memory Note are two of the + menu's eight entries.
 *   §6.2  they produce LOCATION and MEMORY_NOTE messages.
 *
 * The sheet opens on "Approximate area". Choosing "Exact" is a deliberate
 * second tap, and nothing in this sheet reads the device GPS — the label is
 * what the sender types, so an exact coordinate cannot enter a thread through
 * this surface at all.
 *
 * MODAL RULE 6 (src/components/__tests__/TESTING.md): Modal-rooted components
 * get the Proxy Modal mock AND their own file — a second Modal-rooted
 * component in the same file does not mount. Measured here: with these tests
 * in `composerMenu.component.test.tsx`, every one failed with "Unable to find
 * an element with testID: telegraph-typed-compose-input" while the
 * ComposerPlusMenu tests above them passed.
 *
 * SHOWN RED before commit: `TypedComposePrompt`'s precision default changed
 * from 'area' to 'exact' → the §4.3 default test RED.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';

// NOTE: intentional stub — TESTING.md Rule 6.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'Modal') {
        const R = require('react');
        return ({ children, visible }: any) =>
          visible ? R.createElement(target.View, null, children) : null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

import * as typedCompose from '../composer/TypedComposePrompt.tsx';
import { TypedComposePrompt } from '../composer/TypedComposePrompt.tsx';

describe('§4.3 — the location sheet is coarse by default', () => {
  it('sends the APPROXIMATE precision without the sender choosing anything', async () => {
    const onSubmit = jest.fn();
    await render(<TypedComposePrompt kind="LOCATION" authorId="u1" onCancel={() => {}} onSubmit={onSubmit} />);
    await fireEvent.changeText(screen.getByTestId('telegraph-typed-compose-input'), 'An Thuong');
    await waitFor(() =>
      expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe('An Thuong'),
    );
    await fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('LOCATION', { label: 'An Thuong', precision: 'area' }),
    );
  });

  it('EXACT takes a deliberate second tap', async () => {
    const onSubmit = jest.fn();
    await render(<TypedComposePrompt kind="LOCATION" authorId="u1" onCancel={() => {}} onSubmit={onSubmit} />);
    await fireEvent.changeText(screen.getByTestId('telegraph-typed-compose-input'), 'The bridge');
    await fireEvent.press(screen.getByTestId('telegraph-precision-exact'));
    await waitFor(() =>
      expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe('The bridge'),
    );
    await fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('LOCATION', { label: 'The bridge', precision: 'exact' }),
    );
  });

  it('renders nothing with no kind', async () => {
    await render(<TypedComposePrompt kind={null} authorId="u1" onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByTestId('telegraph-typed-compose')).toBeNull();
  });
});

// ── census-telegraph T106 (§9 Active: "optional location scope") ─────────────────────────────
//
// Verifier F7 (§45.1): the coordination panel's and the safety bar's location-scope control opened
// THIS sheet in its place mode, which sends a pin — a label and a precision, no expiry, no purpose —
// so the control was relabelled "Share a place". A location SCOPE is a share with a window: §12
// `location_shares` is "purpose/audience/precision/expiry scoped", and the server's own rule is that
// `expiresAt` is what makes a LOCATION a share rather than a pin (threadEnvelopeWrites
// checkLocationShareWindow, ≤ MAX_LOCATION_SHARE_HOURS; the sweep ends it and emits
// location.expired). The scope mode below sends exactly that, coarse by default (§4.3); the place
// mode the + menu opens is unchanged (the cases above still pin `{ label, precision }`).
describe('T106 — the location SCOPE sheet sends a scoped, time-limited share, not a pin', () => {
  const MIN = 60_000;
  async function sendScoped(onSubmit: jest.Mock, label: string, taps: string[] = []) {
    await render(<TypedComposePrompt kind={'LOCATION_SCOPE' as any} authorId="u1" onCancel={() => {}} onSubmit={onSubmit} />);
    await fireEvent.changeText(screen.getByTestId('telegraph-typed-compose-input'), label);
    await waitFor(() => expect(screen.getByTestId('telegraph-typed-compose-input').props.value).toBe(label));
    for (const id of taps) await fireEvent.press(screen.getByTestId(id));
    const before = Date.now();
    await fireEvent.press(screen.getByTestId('telegraph-typed-compose-send'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [kind, payload] = onSubmit.mock.calls[0];
    return { kind, payload, before, after: Date.now() };
  }

  it('says it is time-limited, opens on Approximate area for one hour, and sends an expiry and a purpose', async () => {
    const onSubmit = jest.fn();
    const { kind, payload, before, after } = await sendScoped(onSubmit, 'Night market gate');
    expect(screen.getByText('Share where you are, for a limited time')).toBeTruthy();
    expect(screen.getByText('Ends by itself after 1 hour.')).toBeTruthy();
    expect(kind).toBe('LOCATION');
    expect(payload).toEqual({ label: 'Night market gate', precision: 'area', purpose: 'presence_in_context', expiresAt: expect.any(String) });
    const ends = Date.parse(payload.expiresAt);
    expect(ends).toBeGreaterThanOrEqual(before + 60 * MIN);
    expect(ends).toBeLessThanOrEqual(after + 60 * MIN);
  });

  it.each([
    ['telegraph-location-duration-15', 15],
    ['telegraph-location-duration-240', 240],
  ])('the sender chooses the window (%s): it ends by itself, never past the server ceiling', async (tap, minutes) => {
    const onSubmit = jest.fn();
    const { payload, before, after } = await sendScoped(onSubmit, 'Pier 3', [tap]);
    const ends = Date.parse(payload.expiresAt);
    expect(ends).toBeGreaterThanOrEqual(before + minutes * MIN);
    expect(ends).toBeLessThanOrEqual(after + minutes * MIN);
    expect(ends - after).toBeLessThanOrEqual((typedCompose as any).SCOPED_LOCATION_MAX_HOURS * 60 * MIN);
  });

  it('Exact is a deliberate tap, and a precise share names the precise purpose', async () => {
    const onSubmit = jest.fn();
    const { payload } = await sendScoped(onSubmit, 'Bench by the fountain', ['telegraph-precision-exact']);
    expect(payload).toMatchObject({ precision: 'exact', purpose: 'live_session_sharing' });
  });

  it("the client's windows, ceiling and purposes are the SERVER's (cross-tree, read from messageKinds.ts)", () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const server: string = readFileSync(join(__dirname, '../../../../../artifacts/api-server/src/services/telegraph/messageKinds.ts'), 'utf8');
    const ceiling = Number(/export const MAX_LOCATION_SHARE_HOURS = (\d+);/.exec(server)?.[1]);
    const purposes = (/export const TELEGRAPH_SHARE_PURPOSES = \[([^\]]*)\]/.exec(server)?.[1] ?? '').match(/"([a-z_]+)"/g)?.map((q) => q.slice(1, -1)) ?? [];
    expect(ceiling).toBeGreaterThan(0);
    expect((typedCompose as any).SCOPED_LOCATION_MAX_HOURS).toBe(ceiling);
    for (const m of (typedCompose as any).SCOPED_LOCATION_MINUTES as number[]) expect(m).toBeLessThanOrEqual(ceiling * 60);
    for (const p of ['area', 'venue', 'exact']) expect(purposes).toContain((typedCompose as any).scopedLocationPurpose(p));
  });
});

describe('T106 — the screen opens the SCOPE sheet from both location-scope controls; the + menu keeps the place sheet', () => {
  // Source-level: app/messages/[id].tsx cannot be mounted under jest-expo (§41.7).
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const dm: string = readFileSync(join(__dirname, '../../../../app/messages/[id].tsx'), 'utf8');
  it('the coordination panel and the safety bar open LOCATION_SCOPE; the + menu entry opens LOCATION', () => {
    const panel = dm.split('\n').find((l) => l.includes('<CoordinationPanel ')) ?? '';
    const bar = dm.split('\n').find((l) => l.includes('<SafetyModeBar ')) ?? '';
    expect(panel).toContain("onShareLocation={() => setTypedCompose('LOCATION_SCOPE')}");
    expect(bar).toContain("onLocationScope={() => setTypedCompose('LOCATION_SCOPE')}");
    expect(dm).toContain("if (entryId === 'LOCATION') { setTypedCompose('LOCATION'); return; }");
  });
});

/**
 * MapTopControls — the Recenter button dispatches RECENTER (spec §30).
 *
 * Recenter used to only call easeTo on the camera ref: the camera moved but the
 * state machine never learned control had returned to it, so it could stay in
 * FREE_EXPLORE while the map was demonstrably following the user again. The
 * button now fires onRecenter (the shell dispatches RECENTER → FOLLOW_USER)
 * ALONGSIDE the easeTo. This suite pins that both happen, and that the machine
 * intent is recorded even before the camera ref is ready to move.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { MapTopControls } from '../MapTopControls.tsx';

const AT = { lat: 14.5995, lng: 120.9842 };

describe('MapTopControls — Recenter → RECENTER', () => {
  it('dispatches RECENTER and moves the camera on tap', async () => {
    const onRecenter = jest.fn();
    const easeTo = jest.fn();
    const cameraRef = { current: { easeTo } } as unknown as React.RefObject<unknown>;

    await render(
      <MapTopControls
        cameraRef={cameraRef}
        fallbackLat={AT.lat}
        fallbackLng={AT.lng}
        onRecenter={onRecenter}
      />,
    );

    fireEvent.press(screen.getByLabelText('Recenter map'));

    expect(onRecenter).toHaveBeenCalledTimes(1);
    expect(easeTo).toHaveBeenCalledTimes(1);
    expect(easeTo.mock.calls[0][0].center).toEqual([AT.lng, AT.lat]);
  });

  it('records the RECENTER intent even when no camera ref is mounted yet', async () => {
    // The machine's FOLLOW_USER is true regardless of whether this frame can act
    // on it, so the dispatch must not be gated behind a live camera ref.
    const onRecenter = jest.fn();

    await render(
      <MapTopControls
        fallbackLat={AT.lat}
        fallbackLng={AT.lng}
        onRecenter={onRecenter}
      />,
    );

    fireEvent.press(screen.getByLabelText('Recenter map'));

    expect(onRecenter).toHaveBeenCalledTimes(1);
  });
});

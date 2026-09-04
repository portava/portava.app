/**
 * MapFloatingControls — the §3 zoom and orientation controls actually drive the
 * camera, step from the live zoom, and clamp at the ends.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import {
  MapFloatingControls,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
} from '../MapFloatingControls.tsx';

function makeCamera() {
  return { zoomTo: jest.fn(), setStop: jest.fn().mockResolvedValue(undefined) };
}

async function renderControls(zoom: number) {
  const camera = makeCamera();
  const cameraRef = { current: camera } as unknown as React.RefObject<unknown>;
  const onZoomIn = jest.fn();
  const onZoomOut = jest.fn();
  const onOrientationReset = jest.fn();
  // `render` resolves a promise in this RNTL setup; await it so the tree exists.
  await render(
    <MapFloatingControls
      cameraRef={cameraRef as never}
      zoom={zoom}
      onZoomIn={onZoomIn}
      onZoomOut={onZoomOut}
      onOrientationReset={onOrientationReset}
    />,
  );
  return { camera, onZoomIn, onZoomOut, onOrientationReset };
}

describe('MapFloatingControls', () => {
  it('zooms in one level from the live zoom', async () => {
    const { camera, onZoomIn } = await renderControls(12);

    fireEvent.press(screen.getByLabelText('Zoom in'));

    expect(camera.zoomTo).toHaveBeenCalledTimes(1);
    expect(camera.zoomTo.mock.calls[0][0]).toBe(12 + ZOOM_STEP);
    expect(onZoomIn).toHaveBeenCalledTimes(1);
  });

  it('zooms out one level from the live zoom', async () => {
    const { camera, onZoomOut } = await renderControls(12);

    fireEvent.press(screen.getByLabelText('Zoom out'));

    expect(camera.zoomTo).toHaveBeenCalledTimes(1);
    expect(camera.zoomTo.mock.calls[0][0]).toBe(12 - ZOOM_STEP);
    expect(onZoomOut).toHaveBeenCalledTimes(1);
  });

  it('resets orientation to north via a centre-less setStop', async () => {
    // setStop (not easeTo) so bearing is reset WITHOUT moving the map centre.
    const { camera, onOrientationReset } = await renderControls(12);

    fireEvent.press(screen.getByLabelText('Reset orientation to north'));

    expect(camera.setStop).toHaveBeenCalledTimes(1);
    expect(camera.setStop.mock.calls[0][0].bearing).toBe(0);
    expect(camera.setStop.mock.calls[0][0].center).toBeUndefined();
    expect(onOrientationReset).toHaveBeenCalledTimes(1);
  });

  it('does not zoom in past the max (and reports no action)', async () => {
    const { camera, onZoomIn } = await renderControls(MAX_ZOOM);

    fireEvent.press(screen.getByLabelText('Zoom in'));

    expect(camera.zoomTo).not.toHaveBeenCalled();
    expect(onZoomIn).not.toHaveBeenCalled();
  });

  it('does not zoom out past the min (and reports no action)', async () => {
    const { camera, onZoomOut } = await renderControls(MIN_ZOOM);

    fireEvent.press(screen.getByLabelText('Zoom out'));

    expect(camera.zoomTo).not.toHaveBeenCalled();
    expect(onZoomOut).not.toHaveBeenCalled();
  });

  it('does not throw when the camera ref is not yet mounted', async () => {
    const onZoomIn = jest.fn();
    await render(<MapFloatingControls cameraRef={undefined} zoom={12} onZoomIn={onZoomIn} />);

    fireEvent.press(screen.getByLabelText('Zoom in'));

    // The intent still reports even though there is no camera to move.
    expect(onZoomIn).toHaveBeenCalledTimes(1);
  });
});

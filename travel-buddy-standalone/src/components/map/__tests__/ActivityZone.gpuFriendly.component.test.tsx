/**
 * §34 "Keep animation layers GPU-friendly" — the half that needs no device.
 * (census-map M258)
 *
 * ## Why this file exists
 *
 * M258 has sat at CANNOT-VERIFY on the sentence "a rendering property of
 * MapLibre layers on a device. Static reading cannot falsify it." Half of that
 * is true — overdraw and frame cost need a handset. The other half does not, and
 * leaving the whole row behind the device hid a property that IS decidable here:
 *
 *   1. a pulsing zone must re-render ONCE PER HALF-PERIOD, not once per frame;
 *   2. across those re-renders the source geometry must keep its IDENTITY, so
 *      the pulse never re-uploads a polygon to the GPU; and
 *   3. the interpolation between the two opacities must be expressed as a
 *      MapLibre `*-opacity-transition`, i.e. handed to the GPU, rather than
 *      computed in JS.
 *
 * `ActivityZone` was written to do all three — its `useOpacityPulse` header says
 * so in as many words — and until now nothing asserted any of them. A future
 * "simplification" that replaced the interval with an `Animated` value driving
 * `line-opacity` directly, or that dropped the `useMemo` around `feature`, would
 * have been a 60-fps-per-zone regression with no failing test.
 *
 * ## Why the real component
 *
 * All three properties are lifecycle properties of this component. A pure test
 * of `zoneStyleForObject` cannot see any of them.
 *
 * ## Anti-vacuity
 *
 * The opacity is asserted to actually CHANGE across a half-period before the
 * identity and cadence assertions are made. A component that rendered a static
 * zone, or no zone at all, would fail that first — so "nothing moved" cannot
 * satisfy "nothing moved too often".
 */
import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { ActivityZone } from '../ActivityZone.tsx';
import { point, type MapObject } from '../../../types/mapObjects.ts';
import { DEFAULT_PULSE_PERIOD_MS } from '../../../features/map/render/zoneStyle.ts';

/**
 * Every `GeoJSONSource` / `Layer` render, in order, with the props MapLibre
 * would have received. The real SDK needs a native module jest-expo does not
 * provide and the repo-wide stub drops props, so the capture has to happen here.
 */
type SourceRender = { id: string; data: unknown };
type LayerRender = { id: string; paint: Record<string, unknown> };
const sources: SourceRender[] = [];
const layers: LayerRender[] = [];

// NOTE: intentional stub — @maplibre/maplibre-react-native needs a native
// module jest-expo does not provide, so requireActual crashes the suite. This
// factory is exhaustive on purpose: it must RECORD the props, which is the
// whole measurement, and the shared __mocks__ stub deliberately drops them.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const React_ = jest.requireActual('react');
  return {
    GeoJSONSource: (props: { id: string; data: unknown; children?: unknown }) => {
      sources.push({ id: props.id, data: props.data });
      return React_.createElement(RN.View, { testID: 'geojson-source' }, props.children);
    },
    Layer: (props: { id: string; paint: Record<string, unknown> }) => {
      layers.push({ id: props.id, paint: props.paint });
      return React_.createElement(RN.View, { testID: `layer:${props.id}` });
    },
  };
});

/**
 * A zone whose trend is in `MEANINGFUL_CHANGE_TRENDS`, which is what makes its
 * §6 boundary `pulsing` — the only branch that animates at all.
 */
const PULSING_ZONE: MapObject = {
  id: 'zone:z1',
  kind: 'activity_zone',
  geometry: point(16.05, 108.22),
  title: 'An Thuong',
  privacyClass: 'aggregate_only',
  renderingPriority: 40,
  activity: 'busy',
  trend: 'getting_busier',
  freshness: 'live',
  confidence: 'strong',
  observedAt: new Date().toISOString(),
};

const HALF_PERIOD_MS = DEFAULT_PULSE_PERIOD_MS / 2;

beforeEach(() => {
  sources.length = 0;
  layers.length = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

function outlineOpacities(): number[] {
  return layers
    .filter((l) => l.id.startsWith('zone-outline-'))
    .map((l) => l.paint['line-opacity'] as number);
}

describe('§34 — a pulsing zone is GPU-friendly', () => {
  it('animates: the outline opacity really does change across a half-period', async () => {
    await render(<ActivityZone object={PULSING_ZONE} />);
    const before = outlineOpacities();
    expect(before.length).toBeGreaterThan(0);

    await act(async () => {
      jest.advanceTimersByTime(HALF_PERIOD_MS + 10);
    });
    const after = outlineOpacities();
    // Anti-vacuity: without a real change, every assertion below is satisfied
    // by a component that animates nothing.
    expect(after[after.length - 1]).not.toBe(before[0]);
  });

  it('does not re-render at frame rate: a frame of elapsed time costs nothing', async () => {
    await render(<ActivityZone object={PULSING_ZONE} />);
    const before = sources.length;

    // Sixty frames at 60 fps — a full second of panning, one frame at a time.
    // A JS-driven pulse would repaint on most of them.
    for (let i = 0; i < 60; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(16);
      });
    }

    // 60 × 16 ms = 960 ms, still inside the first 1200 ms half-period, so the
    // honest answer is zero repaints.
    expect(sources.length - before).toBe(0);
  });

  it('re-renders exactly once per half-period', async () => {
    await render(<ActivityZone object={PULSING_ZONE} />);
    let seen = sources.length;

    for (let step = 1; step <= 3; step += 1) {
      await act(async () => {
        jest.advanceTimersByTime(HALF_PERIOD_MS);
      });
      const added = sources.length - seen;
      seen = sources.length;
      expect(added).toBe(1);
    }
  });

  it('never re-uploads the geometry: the source data keeps its identity', async () => {
    await render(<ActivityZone object={PULSING_ZONE} />);
    const first = sources[0].data;
    expect(first).not.toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(HALF_PERIOD_MS * 3 + 10);
    });

    expect(sources.length).toBeGreaterThan(1);
    for (const s of sources) {
      // Identity, not deep equality: a new object with the same contents is a
      // new source payload as far as the SDK is concerned.
      expect(s.data).toBe(first);
    }
  });

  it('hands the interpolation to the GPU with an opacity transition', async () => {
    await render(<ActivityZone object={PULSING_ZONE} />);
    const outline = layers.find((l) => l.id.startsWith('zone-outline-'));
    expect(outline).toBeDefined();

    const transition = outline!.paint['line-opacity-transition'] as
      | { duration: number }
      | undefined;
    expect(transition).toBeDefined();
    // The transition must span the gap between JS updates, or the GPU has
    // nothing to interpolate across and the pulse becomes a step function.
    expect(transition!.duration).toBe(HALF_PERIOD_MS);
  });

  it('still renders the zone itself', async () => {
    await render(<ActivityZone object={PULSING_ZONE} />);
    expect(screen.getByTestId('geojson-source')).toBeTruthy();
  });
});

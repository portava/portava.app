/**
 * §34 "Keep animation layers GPU-friendly" — the two flow layers
 * (census-map M258, the device-free half).
 *
 * ## Why this file exists
 *
 * M258 names THREE animated layers. `ActivityZone.gpuFriendly.component.test.tsx`
 * covers one of them and says so; `CrowdFlowLine` and `TravelerFlowLine` were
 * left entirely unasserted, and the row was carried as CANNOT-VERIFY as though
 * the whole property needed a handset. It does not. The falsifiable form the
 * census itself states —
 *
 *     "no animated layer causes a full style re-layout per frame"
 *
 * — is decidable here for all three. Overdraw and absolute frame cost are the
 * half that needs the Android GPU profiler (see
 * docs/map/device-measurement-protocol.md, §M258).
 *
 * ## What is different about these two
 *
 * `ActivityZone` pulses, so its file asserts a CADENCE: one re-render per
 * half-period, never per frame. These two do not pulse at all, and that is the
 * property worth pinning, because it is the one a plausible "improvement"
 * destroys:
 *
 *   1. ELAPSED TIME COSTS NOTHING. No timer, no `Animated` value, no
 *      `requestAnimationFrame`. A second of wall clock produces ZERO repaints.
 *      Someone adding a "flowing arrows" marquee by driving `symbol-spacing`
 *      or `line-dasharray` from JS would repaint every frame per flow, and the
 *      §10 layer can carry dozens of flows at city zoom.
 *   2. THE GEOMETRY IS NEVER RE-UPLOADED. Across parent re-renders the object
 *      handed to `GeoJSONSource` keeps its IDENTITY. Dropping the `useMemo`
 *      around `feature` / `shape` would hand MapLibre a new payload on every
 *      pass — a polyline re-upload per parent render, which on a pan is every
 *      frame.
 *   3. THE PAINT DOES NOT CHURN. Re-renders produce byte-identical paint
 *      values. A paint value that differs between passes is what forces the
 *      full style re-layout the census names.
 *
 * ## Anti-vacuity — the specific trap the census warns about
 *
 * §42.7's mutation B5 is exactly this shape: "a component that renders nothing
 * satisfies 'a frame of elapsed time costs nothing'". So every block below
 * first proves the recorder is LIVE — the component really did hand MapLibre a
 * source and a layer — and then proves that a genuine change DOES produce a new
 * render. Only between those two fences is "nothing happened" evidence.
 *
 * Run: npx jest --forceExit --testPathPattern 'FlowLines.gpuFriendly'
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { CrowdFlowLine, MIN_FLOW_COHORT } from '../CrowdFlowLine.tsx';
import { TravelerFlowLine } from '../TravelerFlowLine.tsx';
import type { AggregateFlowObject } from '../CrowdFlowLine.tsx';
import type { TravelerFlowObject } from '../TravelerFlowLine.tsx';

type SourceRender = { id: string; data: unknown };
type LayerRender = { id: string; paint: Record<string, unknown>; layout?: Record<string, unknown> };
const sources: SourceRender[] = [];
const layers: LayerRender[] = [];

// NOTE: intentional stub — @maplibre/maplibre-react-native needs native GL
// modules jest-expo does not provide, so requireActual crashes the suite. This
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
    Layer: (props: { id: string; paint: Record<string, unknown>; layout?: Record<string, unknown> }) => {
      layers.push({ id: props.id, paint: props.paint, layout: props.layout });
      return React_.createElement(RN.View, { testID: `layer:${props.id}` });
    },
  };
});

/** A §10 flow that clears all three of its gates, so it actually draws. */
const FLOW: AggregateFlowObject = {
  id: 'flow:an-thuong->my-khe',
  kind: 'crowd_flow',
  geometry: {
    type: 'LineString',
    coordinates: [
      [108.2422, 16.0544],
      [108.2481, 16.0613],
    ],
  },
  title: 'An Thuong → My Khe',
  privacyClass: 'aggregate_only',
  renderingPriority: 45,
  count: MIN_FLOW_COHORT + 3,
  activity: 'busy',
  trend: 'getting_busier',
  freshness: 'live',
  confidence: 'strong',
  observedAt: '2026-09-20T15:47:00.000Z',
} as unknown as AggregateFlowObject;

/** A §36 Phase 7 edge that clears its gates — bucketed, never counted. */
const EDGE: TravelerFlowObject = {
  id: 'edge:danang->hoian',
  kind: 'traveler_flow',
  geometry: {
    type: 'LineString',
    coordinates: [
      [108.2022, 16.0544],
      [108.335, 15.8801],
    ],
  },
  title: 'Da Nang → Hoi An',
  privacyClass: 'aggregate_only',
  renderingPriority: 20,
  freshness: 'historical',
  confidence: 'moderate',
  payload: {
    cohortBucket: 'busy',
    fromCityLabel: 'Da Nang',
    toCityLabel: 'Hoi An',
    windowDays: 30,
    singleFamily: false,
  },
} as unknown as TravelerFlowObject;

/** One second of a 60 fps pan, advanced one frame at a time. */
const FRAME_MS = 16;
const FRAMES_IN_A_SECOND = 60;

beforeEach(() => {
  sources.length = 0;
  layers.length = 0;
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function advanceOneSecondFrameByFrame() {
  for (let i = 0; i < FRAMES_IN_A_SECOND; i += 1) {
    await act(async () => {
      jest.advanceTimersByTime(FRAME_MS);
    });
  }
}

describe('§34 — CrowdFlowLine is GPU-friendly', () => {
  it('draws at all, so the measurements below are made against something', async () => {
    // The B5 fence: "nothing repainted" is only evidence once something painted.
    await render(<CrowdFlowLine object={FLOW} />);
    expect(sources).toHaveLength(1);
    expect(layers.length).toBeGreaterThan(0);
  });

  it('costs nothing over a second of elapsed time', async () => {
    await render(<CrowdFlowLine object={FLOW} />);
    const sourcesBefore = sources.length;
    const layersBefore = layers.length;

    await advanceOneSecondFrameByFrame();

    // A JS-driven marquee on the arrows would repaint on most of these frames.
    expect(sources.length - sourcesBefore).toBe(0);
    expect(layers.length - layersBefore).toBe(0);
  });

  it('never re-uploads the polyline: the source data keeps its identity', async () => {
    const r = await render(<CrowdFlowLine object={FLOW} />);
    const first = sources[0].data;

    for (let pass = 0; pass < 3; pass += 1) {
      await r.rerender(<CrowdFlowLine object={FLOW} />);
    }

    expect(sources.length).toBeGreaterThan(1);
    for (const s of sources) {
      // Identity, not deep equality: a new object with the same contents is a
      // new payload as far as the SDK is concerned, and it re-uploads.
      expect(s.data).toBe(first);
    }
  });

  it('does not churn its paint across re-renders', async () => {
    const r = await render(<CrowdFlowLine object={FLOW} />);
    const first = layers.find((l) => l.id === `flow-line-${FLOW.id}`)!.paint;

    await r.rerender(<CrowdFlowLine object={FLOW} />);

    const again = layers.filter((l) => l.id === `flow-line-${FLOW.id}`);
    expect(again.length).toBeGreaterThan(1);
    // A paint value that differs between passes is what forces the full style
    // re-layout M258 names.
    expect(again[again.length - 1].paint).toEqual(first);
  });

  it('DOES repaint when the flow genuinely changes', async () => {
    // Anti-vacuity for the two assertions above: a component that never
    // re-rendered at all would satisfy both, and would also be broken.
    const r = await render(<CrowdFlowLine object={FLOW} />);
    const first = sources[0].data;

    const moved = {
      ...FLOW,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [108.2422, 16.0544],
          [108.2601, 16.0702],
        ],
      },
    } as unknown as AggregateFlowObject;
    await r.rerender(<CrowdFlowLine object={moved} />);

    expect(sources[sources.length - 1].data).not.toBe(first);
  });

  it('reserves the dashed vocabulary for forecasts — observed movement is solid', async () => {
    // §6: dashes mean "predicted". An observed flow that borrowed them would be
    // a forecast on the map with no forecast behind it. There is deliberately
    // no branch in the component, so this pins the absence.
    await render(<CrowdFlowLine object={FLOW} />);
    const line = layers.find((l) => l.id === `flow-line-${FLOW.id}`)!;
    expect(line.paint['line-dasharray']).toBeUndefined();
  });
});

describe('§34 — TravelerFlowLine is GPU-friendly', () => {
  it('draws at all, so the measurements below are made against something', async () => {
    await render(<TravelerFlowLine object={EDGE} />);
    expect(sources).toHaveLength(1);
    expect(layers.length).toBeGreaterThan(0);
  });

  it('costs nothing over a second of elapsed time', async () => {
    await render(<TravelerFlowLine object={EDGE} />);
    const sourcesBefore = sources.length;
    const layersBefore = layers.length;

    await advanceOneSecondFrameByFrame();

    expect(sources.length - sourcesBefore).toBe(0);
    expect(layers.length - layersBefore).toBe(0);
  });

  it('never re-uploads the edge: the source data keeps its identity', async () => {
    const r = await render(<TravelerFlowLine object={EDGE} />);
    const first = sources[0].data;

    for (let pass = 0; pass < 3; pass += 1) {
      await r.rerender(<TravelerFlowLine object={EDGE} />);
    }

    expect(sources.length).toBeGreaterThan(1);
    for (const s of sources) {
      expect(s.data).toBe(first);
    }
  });

  it('does not churn its paint across re-renders', async () => {
    const r = await render(<TravelerFlowLine object={EDGE} />);
    const first = layers.find((l) => l.id === `traveler-flow-line-${EDGE.id}`)!.paint;

    await r.rerender(<TravelerFlowLine object={EDGE} />);

    const again = layers.filter((l) => l.id === `traveler-flow-line-${EDGE.id}`);
    expect(again.length).toBeGreaterThan(1);
    expect(again[again.length - 1].paint).toEqual(first);
  });

  it('DOES repaint when the edge genuinely changes', async () => {
    const r = await render(<TravelerFlowLine object={EDGE} />);
    const first = sources[0].data;

    const rerouted = {
      ...EDGE,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [108.2022, 16.0544],
          [107.5905, 16.4637],
        ],
      },
    } as unknown as TravelerFlowObject;
    await r.rerender(<TravelerFlowLine object={rerouted} />);

    expect(sources[sources.length - 1].data).not.toBe(first);
  });

  it('is not dashed either — a 30-day aggregate is observed, not predicted', async () => {
    await render(<TravelerFlowLine object={EDGE} />);
    const line = layers.find((l) => l.id === `traveler-flow-line-${EDGE.id}`)!;
    expect(line.paint['line-dasharray']).toBeUndefined();
  });
});

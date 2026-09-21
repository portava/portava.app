/**
 * §16 Crowd Flow, as a LAYER (census-map M119).
 *
 * ## What the row actually says
 *
 * M119's census wording is "the layer is real, the objects are not". That is a
 * statement about the producer, not about this code — and it is the reason the
 * layer half was never proved: with no `crowd_flow` object in existence, every
 * claim about "the crowd_flow layer renders it" was unfalsifiable, so nothing
 * asserted it. The layer plumbing could have rotted in any direction without a
 * single test going red.
 *
 * So the plumbing is proved here against a fixture this file owns, end to end:
 *
 *     projection response -> filterByLayers -> CrowdFlowLayer -> MapLibre props
 *
 * ## "Assert against kindsForLayer('crowd_flow'), not a constant"
 *
 * That instruction is the point of the first describe block. Writing
 * `expect(kinds).toEqual(['crowd_flow'])` would pin the ANSWER; what has to be
 * pinned is that the answer and the renderer agree. So the fixture's kind is
 * READ OUT of `kindsForLayer('crowd_flow')` rather than typed in, and a kind
 * added to that layer later without a renderer to match reddens this file.
 *
 * ## Anti-vacuity, in three places
 *
 *   1. The ON arm asserts a source was actually handed to MapLibre, not merely
 *      that nothing threw. A component that returns null satisfies "renders no
 *      flow when the layer is off" perfectly.
 *   2. The OFF arm is run with the SAME fixture as the ON arm, so the
 *      difference is the toggle and nothing else.
 *   3. A non-crowd-flow object is fed to the same renderer with the layer ON.
 *      If it drew that too, "the crowd_flow layer renders crowd flow" would be
 *      "this component renders everything".
 *
 * ## What still has to be re-run when Lane C lands
 *
 * The fixture below is hand-built, with the shape `crowdFlowProducer` is
 * specified to emit. It is NOT evidence that the producer emits that shape.
 * When a real `crowd_flow` object can be produced on a seeded `portava-ci`,
 * `FLOW` must be replaced by one captured from `GET /api/map/projection` and
 * this file re-run. Until then this proves the CLIENT half only.
 *
 * Run: npx jest --forceExit --testPathPattern 'CrowdFlowLayer.toggle'
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { CrowdFlowLayer, MIN_FLOW_COHORT } from '../CrowdFlowLine.tsx';
import {
  DEFAULT_LAYER_CONTEXT,
  EMPTY_LAYER_PREFERENCES,
  filterByLayers,
  kindsForLayer,
  layerForKind,
  setLayerChoice,
  type LayerPreferences,
} from '../../../features/map/layers/layerModel.ts';
import type { MapObject } from '../../../types/mapObjects.ts';

type SourceRender = { id: string; data: unknown };
type LayerRender = { id: string; type: string };
const sources: SourceRender[] = [];
const layers: LayerRender[] = [];

// NOTE: intentional stub — @maplibre/maplibre-react-native needs native GL
// modules jest-expo does not provide, so requireActual crashes the suite. It is
// exhaustive on purpose because it must RECORD the props, which is the whole
// measurement; the shared stub deliberately drops them, and against it every
// assertion below would pass with nothing drawn.
jest.mock('@maplibre/maplibre-react-native', () => {
  const RN = jest.requireActual('react-native');
  const React_ = jest.requireActual('react');
  return {
    GeoJSONSource: (props: { id: string; data: unknown; children?: unknown }) => {
      sources.push({ id: props.id, data: props.data });
      return React_.createElement(RN.View, { testID: 'geojson-source' }, props.children);
    },
    Layer: (props: { id: string; type: string }) => {
      layers.push({ id: props.id, type: props.type });
      return React_.createElement(RN.View, { testID: `layer:${props.id}` });
    },
  };
});

/**
 * The single kind §16's Crowd Flow layer carries, READ from the layer model.
 *
 * If `LAYER_FOR_KIND` ever stops mapping `crowd_flow` to the `crowd_flow`
 * layer — the `kindsForLayer('transport') === []` failure mode M122 documents,
 * one layer over — this is empty and the whole file fails on the guard below
 * rather than passing against nothing.
 */
const CROWD_FLOW_KINDS = kindsForLayer('crowd_flow');

/**
 * One aggregate flow, shaped the way §10's three gates require: a cohort at or
 * above the floor, geometry already reduced to §23's `aggregate_only` rung, and
 * a two-point LineString. Any of the three missing and `CrowdFlowLine` refuses
 * to draw — which is correct behaviour and would make this fixture useless.
 */
const FLOW: MapObject = {
  id: 'flow:an-thuong->my-khe',
  kind: CROWD_FLOW_KINDS[0],
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
  observedAt: new Date().toISOString(),
} as MapObject;

/**
 * A place pin — on a DIFFERENT layer, and the anti-vacuity control.
 *
 * `place_level` is a real rung of §23's ladder (`PRIVACY_CLASSES`). An earlier
 * draft of this fixture said `'public'`, which is not a label the ladder has;
 * `check-test-typecheck` refused it, which is exactly what that gate is for — a
 * fixture describing a shape production never emits proves nothing about
 * production.
 */
const PLACE: MapObject = {
  id: 'place:1',
  kind: 'place',
  geometry: { type: 'Point', coordinates: [108.2422, 16.0544] },
  title: 'An Thuong Coffee',
  privacyClass: 'place_level',
  renderingPriority: 30,
};

/** The shape `GET /api/map/projection` answers with, reduced to what is read. */
const PROJECTION_RESPONSE = { enabled: true, objects: [FLOW, PLACE] as MapObject[] };

const CTX = DEFAULT_LAYER_CONTEXT;
const ON: LayerPreferences = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'crowd_flow', 'on');
const OFF: LayerPreferences = setLayerChoice(EMPTY_LAYER_PREFERENCES, 'crowd_flow', 'off');

beforeEach(() => {
  sources.length = 0;
  layers.length = 0;
});

describe('§16 — the crowd_flow layer and the renderer name the same kinds', () => {
  it('carries at least one kind, so the layer is not empty by construction', () => {
    // This is M122's failure mode (`kindsForLayer('transport') === []`) applied
    // to this layer. If it ever held, every other test here would pass against
    // an empty fixture.
    expect(CROWD_FLOW_KINDS.length).toBeGreaterThan(0);
  });

  it('routes every kind it names back to itself', () => {
    for (const kind of CROWD_FLOW_KINDS) {
      expect(layerForKind(kind)).toBe('crowd_flow');
    }
  });

  it('the fixture is on this layer because the model says so, not by assertion', () => {
    expect(layerForKind(FLOW.kind)).toBe('crowd_flow');
  });
});

describe('§16 — the layer ON', () => {
  it('renders the flow from a projection response', async () => {
    const visible = filterByLayers(PROJECTION_RESPONSE.objects, ON, CTX);
    expect(visible.map((o) => o.id)).toContain(FLOW.id);

    await render(<CrowdFlowLayer objects={visible} />);

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(`flow-src-${FLOW.id}`);
    // And it is drawn as a line, which is §6's vocabulary for movement.
    expect(layers.some((l) => l.id === `flow-line-${FLOW.id}` && l.type === 'line')).toBe(true);
  });

  it('draws the §6 directional arrows along the path', async () => {
    const visible = filterByLayers(PROJECTION_RESPONSE.objects, ON, CTX);
    await render(<CrowdFlowLayer objects={visible} />);
    expect(layers.some((l) => l.id.startsWith(`flow-arrows-${FLOW.id}`) && l.type === 'symbol'))
      .toBe(true);
  });

  it('does not draw objects belonging to other layers', async () => {
    // Anti-vacuity: without this, "the crowd_flow layer renders crowd flow" is
    // satisfied by a component that renders everything it is handed.
    await render(<CrowdFlowLayer objects={[PLACE]} />);
    expect(sources).toHaveLength(0);
  });

  it('does not draw a Phase 7 traveler_flow edge, which passes every other gate', async () => {
    /*
     * Added after mutation B6 survived. The control above is a Point, so
     * `eligibleFlows` rejected it on GEOMETRY and the kind check could be
     * deleted with the suite still green. This control is a LineString on the
     * aggregate rung with a cohort above the floor — everything except the
     * kind — so only the kind check can refuse it.
     *
     * It is also the confusion that would actually happen. `traveler_flow` is
     * §36 Phase 7's city→city edge, and the two kinds carry OPPOSITE structural
     * guarantees: §10 REQUIRES a cohort count, Phase 7 FORBIDS one. Drawing a
     * Phase 7 edge with §10's renderer would put a count-bearing vocabulary on
     * an object whose whole point is that it has no count.
     */
    const edge = {
      ...FLOW,
      id: 'edge:danang->hoian',
      kind: 'traveler_flow',
    } as MapObject;
    await render(<CrowdFlowLayer objects={[edge]} />);
    expect(sources).toHaveLength(0);
  });
});

describe('§16 — the layer OFF', () => {
  it('renders none, from the same response', async () => {
    const visible = filterByLayers(PROJECTION_RESPONSE.objects, OFF, CTX);
    expect(visible.map((o) => o.id)).not.toContain(FLOW.id);

    await render(<CrowdFlowLayer objects={visible} />);
    expect(sources).toHaveLength(0);
  });

  it('leaves the other layers alone — the toggle is not a mute button', async () => {
    const visible = filterByLayers(PROJECTION_RESPONSE.objects, OFF, CTX);
    // The place pin belongs to `relevant_places`, which is `on` by default.
    expect(visible.map((o) => o.id)).toContain(PLACE.id);
  });

  it('also renders none when the component itself is told visible={false}', async () => {
    // The two gates are independent: a screen may hide the layer for a capture
    // without touching the user's stored preference.
    const visible = filterByLayers(PROJECTION_RESPONSE.objects, ON, CTX);
    await render(<CrowdFlowLayer objects={visible} visible={false} />);
    expect(sources).toHaveLength(0);
  });
});

describe('§16 — the layer on AUTOMATIC, with no user choice at all', () => {
  /*
   * Added after mutation B3 survived. The ON/OFF arms above both set an
   * EXPLICIT preference, and an explicit choice outranks the default by design
   * — so flipping `LAYER_DEFAULTS.crowd_flow` from `contextual` to `on` changed
   * nothing they could see. That flip is a real regression: it would put flow
   * arrows on a quiet viewport at every zoom, which is exactly what §17's "major
   * flow" wording and the resolver's own "Flow arrows are noise when nothing
   * moves" comment rule out. These two arms are the ones that notice.
   */
  it('draws nothing automatically on a quiet viewport', async () => {
    const visible = filterByLayers(PROJECTION_RESPONSE.objects, EMPTY_LAYER_PREFERENCES, CTX);
    expect(visible.map((o) => o.id)).not.toContain(FLOW.id);
    await render(<CrowdFlowLayer objects={visible} />);
    expect(sources).toHaveLength(0);
  });

  it('draws automatically once the shell is in CROWD_FLOW mode', async () => {
    // Anti-vacuity for the arm above: `contextual` must be a real third state
    // that can resolve either way, not a synonym for `off`.
    const inMode = { ...CTX, mode: 'CROWD_FLOW' as const };
    const visible = filterByLayers(PROJECTION_RESPONSE.objects, EMPTY_LAYER_PREFERENCES, inMode);
    expect(visible.map((o) => o.id)).toContain(FLOW.id);
    await render(<CrowdFlowLayer objects={visible} />);
    expect(sources).toHaveLength(1);
  });
});

describe('§10 — the privacy gates survive the layer being on', () => {
  it('still refuses a cohort below the floor', async () => {
    // A layer toggle is a VISIBILITY preference. It must never be able to talk
    // the renderer past §10's cohort floor.
    const thin = { ...FLOW, id: 'flow:thin', count: MIN_FLOW_COHORT - 1 } as MapObject;
    const visible = filterByLayers([thin], ON, CTX);
    expect(visible).toHaveLength(1); // the LAYER admits it …
    await render(<CrowdFlowLayer objects={visible} />);
    expect(sources).toHaveLength(0); // … and the RENDERER does not.
  });

  it('still refuses geometry that was never reduced to the aggregate rung', async () => {
    // `precise_temporary` is the sharpest rung §23 has — geometry that was
    // never reduced. The renderer cannot un-sharpen it (§18), so it refuses.
    const sharp: MapObject = { ...FLOW, id: 'flow:sharp', privacyClass: 'precise_temporary' };
    const visible = filterByLayers([sharp], ON, CTX);
    expect(visible).toHaveLength(1);
    await render(<CrowdFlowLayer objects={visible} />);
    expect(sources).toHaveLength(0);
  });
});

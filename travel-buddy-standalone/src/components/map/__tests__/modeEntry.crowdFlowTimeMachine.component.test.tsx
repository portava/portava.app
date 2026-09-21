/**
 * §30 mode entry for CROWD_FLOW and TIME_MACHINE (census-map M221, M223).
 *
 * ## The gap this closes
 *
 * `mapCapabilities.test.ts` already pins both directions of
 * `deriveMapCapabilities` — but it pins them from a HAND-WRITTEN input record
 * (`crowdFlowObjectCount: 1`, `timeMachineProducerEnabled: true`). M221 and
 * M223 are about the step BEFORE that one:
 *
 *   M221 — "With a projection response carrying >= 1 crowd_flow object,
 *           CROWD_FLOW is true and the mode is enterable; with zero such
 *           objects it is false."
 *   M223 — "With the temporal route answering enabled: true + non-null
 *           forecast, TIME_MACHINE is enterable; with the refusal envelope it
 *           is not."
 *
 * Both name a WIRE RESPONSE, and until now no function turned a wire response
 * into those inputs: the two expressions lived inline in `app/map/index.tsx`,
 * where nothing could reach them. `crowdFlowObjectCount` and
 * `temporalProducerReachable` in `mapMachine.ts` are that step, and this file
 * runs the whole chain the criteria describe:
 *
 *     wire response -> derivation -> deriveMapCapabilities -> canEnterMode
 *
 * ## Anti-vacuity
 *
 * Every positive arm has the matching negative arm run through the SAME chain,
 * so "the mode is enterable" cannot be satisfied by a gate that is simply
 * always open — which is the specific failure `deriveMapCapabilities`'s own
 * header calls out ("The easy way to fix an unreachable surface is to hardcode
 * true, which trades an unreachable surface for one that opens onto nothing").
 *
 * ## What still has to be re-run against the real producers
 *
 * The responses below are fixtures this file owns. They are the documented
 * shapes of `GET /api/map/projection` and `GET /api/map/projection/temporal`,
 * and they are NOT evidence that either route emits them. When Lane C can
 * produce a `crowd_flow` object and Lane B's temporal route answers
 * `enabled: true` on a seeded `portava-ci`, `FLOW_RESPONSE` and
 * `FORECAST_ANSWER` must be replaced with captured payloads and this file
 * re-run. Until then it proves the CLIENT gate only.
 *
 * Run: npx jest --forceExit --testPathPattern 'modeEntry.crowdFlowTimeMachine'
 */
import {
  canEnterMode,
  crowdFlowObjectCount,
  enterableModes,
  temporalProducerReachable,
} from '../../../features/map/state/mapMachine.ts';
import {
  deriveMapCapabilities,
  type MapCapabilityInputs,
} from '../../../stores/mapStore.tsx';

/** A session with nothing else available, so each arm isolates one gate. */
const BARE: MapCapabilityInputs = {
  crowdFlowObjectCount: 0,
  locateFriendsFlagEnabled: false,
  locateFriendsScopeId: null,
  viewerId: null,
  timeMachineProducerEnabled: false,
};

// ── M221 — Mode CROWD_FLOW ────────────────────────────────────────────────────

/** `GET /api/map/projection` over a viewport where the city is moving. */
const FLOW_RESPONSE = {
  enabled: true,
  objects: [
    { id: 'place:1', kind: 'place' },
    { id: 'flow:1', kind: 'crowd_flow' },
    { id: 'zone:1', kind: 'activity_zone' },
  ],
};

/** The same viewport with no aggregate movement published. */
const NO_FLOW_RESPONSE = {
  enabled: true,
  objects: [
    { id: 'place:1', kind: 'place' },
    { id: 'zone:1', kind: 'activity_zone' },
  ],
};

function capsFor(projection: { objects?: readonly { kind?: unknown }[] } | null) {
  return deriveMapCapabilities({
    ...BARE,
    crowdFlowObjectCount: crowdFlowObjectCount(projection),
  });
}

describe('M221 — CROWD_FLOW opens from the served projection', () => {
  it('is enterable when the response carries at least one crowd_flow object', () => {
    expect(crowdFlowObjectCount(FLOW_RESPONSE)).toBe(1);
    const caps = capsFor(FLOW_RESPONSE);
    expect(caps.CROWD_FLOW).toBe(true);
    expect(canEnterMode('CROWD_FLOW', caps)).toBe(true);
    expect(enterableModes(caps)).toContain('CROWD_FLOW');
  });

  it('is NOT enterable when the same response carries none', () => {
    expect(crowdFlowObjectCount(NO_FLOW_RESPONSE)).toBe(0);
    const caps = capsFor(NO_FLOW_RESPONSE);
    expect(caps.CROWD_FLOW).toBe(false);
    expect(canEnterMode('CROWD_FLOW', caps)).toBe(false);
    expect(enterableModes(caps)).not.toContain('CROWD_FLOW');
  });

  it('counts several flows without double-counting other kinds', () => {
    expect(
      crowdFlowObjectCount({
        objects: [
          { kind: 'crowd_flow' },
          { kind: 'crowd_flow' },
          { kind: 'traveler_flow' },
        ],
      }),
    ).toBe(2);
  });

  it('does not mistake a Phase 7 traveler_flow for a §10 crowd_flow', () => {
    // They are different kinds on different layers with OPPOSITE structural
    // guarantees — §10 requires a cohort count, Phase 7 forbids one. Opening
    // §10's mode on a Phase 7 edge would put the wrong renderer on the map.
    const caps = capsFor({ objects: [{ kind: 'traveler_flow' }] });
    expect(caps.CROWD_FLOW).toBe(false);
  });

  it('fails closed on a refusal, an empty body, or a malformed one', () => {
    for (const bad of [null, undefined, {}, { objects: null }, { objects: 'crowd_flow' }]) {
      expect(crowdFlowObjectCount(bad as never)).toBe(0);
    }
    // And a null/undefined member cannot throw its way past the gate.
    expect(crowdFlowObjectCount({ objects: [null, undefined, { kind: 'crowd_flow' }] as never })).toBe(1);
  });

  it('ignores a kind that merely CONTAINS the word', () => {
    // A substring match would open the mode on `crowd_flow_forecast` or any
    // future neighbouring kind. Equality, not inclusion.
    expect(crowdFlowObjectCount({ objects: [{ kind: 'crowd_flow_forecast' }] })).toBe(0);
  });
});

// ── M223 — Mode TIME_MACHINE ──────────────────────────────────────────────────

/** The criterion's own positive case: enabled, with a non-null forecast. */
const FORECAST_ANSWER = {
  ok: true,
  data: {
    enabled: true,
    objects: [],
    forecast: { events: 2, itinerary: 0, plan: { published: 1, withheld: 0, refusal: null, refusals: {} } },
    history: null,
  },
};

/** The route's fail-soft refusal — it rides `map_projection_enabled`. */
const REFUSAL_ENVELOPE = { ok: true, data: { enabled: false, objects: [], forecast: null, history: null } };

/** A PAST offset: no forecast, a history block, and still a reachable producer. */
const HISTORY_ANSWER = {
  ok: true,
  data: { enabled: true, objects: [], forecast: null, history: { available: true, covering: 4 } },
};

function capsForTemporal(probe: unknown) {
  return deriveMapCapabilities({
    ...BARE,
    timeMachineProducerEnabled: temporalProducerReachable(probe as never),
  });
}

describe('M223 — TIME_MACHINE opens from the temporal route', () => {
  it('is enterable when the route answers enabled: true with a non-null forecast', () => {
    expect(temporalProducerReachable(FORECAST_ANSWER)).toBe(true);
    const caps = capsForTemporal(FORECAST_ANSWER);
    expect(caps.TIME_MACHINE).toBe(true);
    expect(canEnterMode('TIME_MACHINE', caps)).toBe(true);
    expect(enterableModes(caps)).toContain('TIME_MACHINE');
  });

  it('is NOT enterable on the refusal envelope', () => {
    expect(temporalProducerReachable(REFUSAL_ENVELOPE)).toBe(false);
    const caps = capsForTemporal(REFUSAL_ENVELOPE);
    expect(caps.TIME_MACHINE).toBe(false);
    expect(canEnterMode('TIME_MACHINE', caps)).toBe(false);
    expect(enterableModes(caps)).not.toContain('TIME_MACHINE');
  });

  it('stays enterable for a PAST offset, which has no forecast at all', () => {
    // This is the arm that stops the criterion's wording being implemented
    // literally. Requiring a non-null forecast would close §15 for every
    // historical scrub — a regression that a test written only against the
    // criterion's two named arms would have passed.
    expect(temporalProducerReachable(HISTORY_ANSWER)).toBe(true);
    expect(capsForTemporal(HISTORY_ANSWER).TIME_MACHINE).toBe(true);
  });

  it('fails closed on a transport error, a missing body and a truthy non-boolean', () => {
    for (const bad of [
      null,
      undefined,
      { ok: false, error: 'network' },
      { ok: true, data: null },
      { ok: true },
      { ok: true, data: { enabled: 'true' } },
      { ok: true, data: { enabled: 1 } },
      { ok: 'true', data: { enabled: true } },
      { data: { enabled: true } },
    ]) {
      expect(temporalProducerReachable(bad as never)).toBe(false);
    }
  });
});

describe('the two gates are independent', () => {
  it('crowd flow does not open the time machine, and vice versa', () => {
    const flowOnly = deriveMapCapabilities({
      ...BARE,
      crowdFlowObjectCount: crowdFlowObjectCount(FLOW_RESPONSE),
      timeMachineProducerEnabled: temporalProducerReachable(REFUSAL_ENVELOPE),
    });
    expect(flowOnly.CROWD_FLOW).toBe(true);
    expect(flowOnly.TIME_MACHINE).toBe(false);

    const timeOnly = deriveMapCapabilities({
      ...BARE,
      crowdFlowObjectCount: crowdFlowObjectCount(NO_FLOW_RESPONSE),
      timeMachineProducerEnabled: temporalProducerReachable(FORECAST_ANSWER),
    });
    expect(timeOnly.CROWD_FLOW).toBe(false);
    expect(timeOnly.TIME_MACHINE).toBe(true);
  });
});

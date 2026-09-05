/**
 * longPress tests — the §25 long-press menu's decision layer.
 *
 * Written against the SPEC RULES rather than the implementation shape, because
 * the rules are what must not regress:
 *
 *   §25  seven actions, in one fixed order, for every press — so the menu
 *        cannot reflow and move a row out from under the user's thumb;
 *   §23  an object below the `approximate` rung stands for PEOPLE, so nothing
 *        that would point at a person is offered for it, and nothing names one;
 *   §37  "Do not create permanent exact-location sharing" — the share bound is
 *        capped in precision, scoped to a purpose, and always expires; no
 *        combination of inputs can widen it;
 *   §22  "Report what is here" exists only where an observation prompt does;
 *   §19  nothing here sharpens geometry, and nothing here prints one.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAP_OBJECT_KINDS,
  PRIVACY_CLASSES,
  precisionRank,
  point,
  type MapAction,
  type MapObject,
  type MapObjectKind,
} from '../../../../types/mapObjects.ts';
import type { PrecisionGrant } from '../../presence/presenceLadder.ts';
import {
  AGGREGATE_AREA_LABEL,
  BOUNDED_SHARE_CHANNEL_EXISTS,
  COORDINATE_LABEL_DECIMALS,
  NO_SHARE_CHANNEL_REASON,
  NO_SHARE_CHANNEL_TARGET_REASON,
  DEFAULT_SHARE_PURPOSE,
  LONG_PRESS_ACTION_ORDER,
  MIN_PRECISION_FOR_PINNING,
  MIN_PRECISION_FOR_PLACE_USE,
  PERSON_BEARING_KINDS,
  SHARE_MAX_TTL_MS,
  SHARE_PRECISION_CEILING,
  UNKNOWN_TARGET_LABEL,
  coordinateOf,
  coordinateTarget,
  describeTarget,
  isUsableTarget,
  longPressItemFor,
  objectTarget,
  resolveLongPressActions,
  resolveShareBound,
  type LongPressContext,
  type LongPressItem,
  type LongPressTarget,
} from '../longPress.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DA_NANG_LAT = 16.047079;
const DA_NANG_LNG = 108.220518;

function obj(over: Partial<MapObject> = {}): MapObject {
  return {
    id: over.id ?? 'o1',
    kind: over.kind ?? 'place',
    geometry: over.geometry ?? point(DA_NANG_LAT, DA_NANG_LNG),
    title: over.title ?? 'Bến Xuân Café',
    privacyClass: over.privacyClass ?? 'place_level',
    renderingPriority: over.renderingPriority ?? 40,
    ...over,
  } as MapObject;
}

/**
 * The same fixture WITH a detail surface. `add_to_trip` hands off to the plan
 * picker on the object's own page, so an object with no page cannot offer it —
 * every projected kind that lists `add_to_trip` (gems, events, trip ideas,
 * Compass picks) carries a `detailRoute`, and this is that object.
 */
function WITH_PAGE(over: Partial<MapObject> = {}): MapObject {
  const base = obj(over);
  return {
    ...base,
    interaction: {
      ...(base.interaction ?? {}),
      // `actions` is required on MapInteractionConfig and every projection
      // producer emits it. Empty is the honest value here: longPress reads an
      // object's `detailRoute`, never its action list (see the module header),
      // so an unannotated object must still afford everything its rung allows.
      actions: base.interaction?.actions ?? [],
      detailRoute: `/place/${base.id}`,
    },
  };
}

const COORD = coordinateTarget(DA_NANG_LAT, DA_NANG_LNG);
/** A checkpoint needs a group to drop into; most cases below supply one. */
const IN_GROUP: LongPressContext = { checkpointScopeId: 'event-42' };
/**
 * A context WITH the §12 session that is the share channel. `share` is offered
 * only when one exists — like a checkpoint, a share with no group has nobody to
 * reach. IN_GROUP deliberately omits it, so most cases still see `share` closed.
 */
const WITH_CHANNEL: LongPressContext = {
  checkpointScopeId: 'event-42',
  shareChannelSessionId: 'session-1',
};

function enabledSet(items: readonly LongPressItem[]): Set<MapAction> {
  return new Set(items.filter((i) => i.enabled).map((i) => i.action));
}

/**
 * The five entries that would hand the user a POSITION — a rendezvous pin, a
 * saved pin, a trip stop, a forwarded pin, a checkpoint. §23's identity line
 * (`approximate`) is the floor for all of them.
 */
const REVEALS_A_POSITION = [
  'meet_here',
  'save',
  'add_to_trip',
  'share',
  'create_checkpoint',
] as const satisfies readonly MapAction[];

function itemFor(target: LongPressTarget, action: MapAction, ctx: LongPressContext = IN_GROUP) {
  const found = longPressItemFor(resolveLongPressActions(target, ctx), action);
  assert.ok(found, `expected an entry for ${action}`);
  return found;
}

// ── §25 · The list never reflows ──────────────────────────────────────────────

describe('§25 · shape', () => {
  const targets: LongPressTarget[] = [
    COORD,
    coordinateTarget(0, 0),
    coordinateTarget(Number.NaN, Number.NaN),
    ...MAP_OBJECT_KINDS.flatMap((kind) =>
      PRIVACY_CLASSES.map((privacyClass) => objectTarget(obj({ kind, privacyClass }))),
    ),
  ];

  test('every target returns all seven actions in §25 order', () => {
    for (const target of targets) {
      const items = resolveLongPressActions(target, IN_GROUP);
      assert.equal(items.length, LONG_PRESS_ACTION_ORDER.length);
      assert.deepEqual(
        items.map((i) => i.action),
        [...LONG_PRESS_ACTION_ORDER],
      );
    }
  });

  test('a null / undefined target still returns all seven, all disabled', () => {
    for (const empty of [null, undefined]) {
      const items = resolveLongPressActions(empty, IN_GROUP);
      assert.deepEqual(
        items.map((i) => i.action),
        [...LONG_PRESS_ACTION_ORDER],
      );
      assert.equal(enabledSet(items).size, 0);
      assert.ok(items.every((i) => typeof i.reason === 'string' && i.reason.length > 0));
    }
  });

  test('a reason is present exactly when an action is disabled', () => {
    for (const target of targets) {
      for (const ctx of [IN_GROUP, {} as LongPressContext]) {
        for (const item of resolveLongPressActions(target, ctx)) {
          if (item.enabled) assert.equal(item.reason, undefined, `${item.action} enabled + reason`);
          else assert.ok(item.reason && item.reason.trim() !== '', `${item.action} has no reason`);
        }
      }
    }
  });

  test('a shareBound rides only on an ENABLED share entry', () => {
    for (const target of targets) {
      for (const item of resolveLongPressActions(target, IN_GROUP)) {
        if (item.shareBound) {
          assert.equal(item.action, 'share');
          assert.equal(item.enabled, true);
        }
      }
      const share = longPressItemFor(resolveLongPressActions(target, IN_GROUP), 'share');
      assert.ok(share);
      assert.equal(share.enabled, share.shareBound != null);
    }
  });

  test('the slug order is the one MapBottomActions already publishes', () => {
    // Read as TEXT, not imported: MapBottomActions.tsx pulls in react-native,
    // which the node:test transform cannot handle. This is the pin that stops
    // the two lists from drifting.
    // A path string, not a `new URL(...)`: the ambient DOM `URL` this program
    // sees is not `node:url`'s, so node's fs overloads reject it.
    const src = readFileSync(
      resolvePath(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../components/map/MapBottomActions.tsx',
      ),
      'utf8',
    );
    const block = /export const LONG_PRESS_ACTIONS[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
    assert.ok(block, 'LONG_PRESS_ACTIONS not found in MapBottomActions.tsx');
    const slugs = [...block[1].matchAll(/action:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(slugs, [...LONG_PRESS_ACTION_ORDER]);
  });
});

// ── §25 · The action × target matrix ──────────────────────────────────────────

describe('§25 · bare coordinate (the empty-map case)', () => {
  test('the actions that publish a POINT are legal — a press is a point', () => {
    assert.deepEqual(
      [...enabledSet(resolveLongPressActions(COORD, IN_GROUP))].sort(),
      ['ask_compass', 'create_checkpoint', 'meet_here'].sort(),
    );
  });

  test('Save and Add to Trip are not — a press is not a PLACE RECORD', () => {
    // Not §23: the pressed point is the user's own choice and carries no rung.
    // There is simply no id and no name to write a place row with, and minting
    // one from the gesture would make two presses on the same cafe two places.
    for (const action of ['save', 'add_to_trip'] as const) {
      const item = itemFor(COORD, action);
      assert.equal(item.enabled, false, action);
      assert.match(item.reason ?? '', /no place here/i, action);
    }
  });

  test('Report is not offered — a coordinate is not an observable object', () => {
    const item = itemFor(COORD, 'report');
    assert.equal(item.enabled, false);
    assert.match(item.reason ?? '', /place or event/i);
  });

  test('Create checkpoint needs a group; without one it is disabled, not hidden', () => {
    const without = itemFor(COORD, 'create_checkpoint', {});
    assert.equal(without.enabled, false);
    assert.match(without.reason ?? '', /group|event/i);
    assert.equal(itemFor(COORD, 'create_checkpoint', IN_GROUP).enabled, true);
  });

  test('an off-the-map coordinate disables everything, Ask Compass included', () => {
    for (const bad of [
      coordinateTarget(Number.NaN, 0),
      coordinateTarget(0, Number.POSITIVE_INFINITY),
      coordinateTarget(91, 0),
      coordinateTarget(0, -181),
    ]) {
      assert.equal(isUsableTarget(bad), false);
      assert.equal(enabledSet(resolveLongPressActions(bad, IN_GROUP)).size, 0);
    }
  });
});

describe('§25 · object target', () => {
  test('a place-level place with its own page affords all six that can be opened', () => {
    // Six, not seven: with IN_GROUP there is a checkpoint scope but no share
    // CHANNEL session, so `share` is refused for having nowhere to open onto
    // (see the §37 channel suite below) rather than for anything about this
    // target. WITH_CHANNEL is where the seventh row turns on.
    const target = objectTarget(WITH_PAGE({ kind: 'place', privacyClass: 'place_level' }));
    assert.deepEqual(
      [...enabledSet(resolveLongPressActions(target, IN_GROUP))].sort(),
      LONG_PRESS_ACTION_ORDER.filter((a) => a !== 'share').sort(),
    );
  });

  test('Ask Compass about here is legal for every visible object', () => {
    for (const kind of MAP_OBJECT_KINDS) {
      for (const privacyClass of PRIVACY_CLASSES) {
        if (privacyClass === 'none') continue;
        const item = itemFor(objectTarget(obj({ kind, privacyClass })), 'ask_compass');
        assert.equal(item.enabled, true, `${kind}/${privacyClass}`);
      }
    }
  });

  test('privacyClass "none" is not visible, so there is no "here" at all', () => {
    const target = objectTarget(obj({ privacyClass: 'none' }));
    assert.equal(isUsableTarget(target), false);
    assert.equal(enabledSet(resolveLongPressActions(target, IN_GROUP)).size, 0);
    assert.equal(describeTarget(target), UNKNOWN_TARGET_LABEL);
  });

  test('an object with unusable geometry is dropped rather than acted on', () => {
    const target = objectTarget(obj({ geometry: { type: 'Point', coordinates: [Number.NaN, 0] } }));
    assert.equal(isUsableTarget(target), false);
    assert.equal(coordinateOf(target), null);
    assert.equal(enabledSet(resolveLongPressActions(target, IN_GROUP)).size, 0);
  });

  test('pinning actions hold the place_level floor the rail holds', () => {
    for (const privacyClass of PRIVACY_CLASSES) {
      if (privacyClass === 'none') continue;
      const target = objectTarget(obj({ kind: 'place', privacyClass }));
      const allowed = precisionRank(privacyClass) >= precisionRank(MIN_PRECISION_FOR_PINNING);
      for (const action of ['meet_here', 'create_checkpoint'] as const) {
        assert.equal(itemFor(target, action).enabled, allowed, `${action}/${privacyClass}`);
      }
    }
  });

  test('place-treating actions hold the approximate floor (§23 identity line)', () => {
    for (const privacyClass of PRIVACY_CLASSES) {
      if (privacyClass === 'none') continue;
      // With a page, so `add_to_trip`'s handoff bar is out of the way and the
      // only thing under test here is the §23 floor.
      const target = objectTarget(WITH_PAGE({ kind: 'place', privacyClass }));
      const allowed = precisionRank(privacyClass) >= precisionRank(MIN_PRECISION_FOR_PLACE_USE);
      for (const action of ['save', 'add_to_trip'] as const) {
        assert.equal(itemFor(target, action).enabled, allowed, `${action}/${privacyClass}`);
      }
    }
  });
});

// ── §23 · An aggregate-rung object reveals nothing about a person ─────────────

describe('§23 · aggregate rung', () => {
  const social = objectTarget(
    obj({ kind: 'social_zone', privacyClass: 'aggregate_only', title: 'Mai Nguyen + 17 others' }),
  );

  test('nothing that would point at a person survives', () => {
    // Ask Compass is about the location, and Report is an AGGREGATE observation
    // §22 explicitly allows for a social zone ("how busy is it here") — neither
    // hands the user a position. Everything that would treat the cluster as a
    // place you can pin, keep, route to or forward is gone.
    assert.deepEqual(
      [...enabledSet(resolveLongPressActions(social, IN_GROUP))].sort(),
      ['ask_compass', 'report'],
    );
    for (const action of REVEALS_A_POSITION) {
      assert.equal(itemFor(social, action).enabled, false, action);
    }
  });

  test('the title line never names anybody at a rung that forbids identity', () => {
    const label = describeTarget(social);
    assert.equal(label, AGGREGATE_AREA_LABEL);
    assert.ok(!label.includes('Mai Nguyen'));
  });

  test('no object below the identity line offers anything that reveals a position', () => {
    const below = PRIVACY_CLASSES.filter(
      (c) => c !== 'none' && precisionRank(c) < precisionRank(MIN_PRECISION_FOR_PLACE_USE),
    );
    for (const kind of MAP_OBJECT_KINDS) {
      for (const privacyClass of below) {
        const target = objectTarget(obj({ kind, privacyClass, title: 'Somebody Real' }));
        for (const action of REVEALS_A_POSITION) {
          assert.equal(itemFor(target, action).enabled, false, `${kind}/${privacyClass}/${action}`);
        }
      }
    }
  });

  test('and no person-bearing object below it is named', () => {
    for (const kind of PERSON_BEARING_KINDS) {
      const target = objectTarget(obj({ kind, privacyClass: 'aggregate_only', title: 'Somebody Real' }));
      assert.equal(describeTarget(target), AGGREGATE_AREA_LABEL, kind);
    }
  });

  test('no object below the approximate rung offers a share at any purpose', () => {
    const below = PRIVACY_CLASSES.filter(
      (c) => precisionRank(c) < precisionRank(MIN_PRECISION_FOR_PLACE_USE),
    );
    for (const kind of MAP_OBJECT_KINDS) {
      for (const privacyClass of below) {
        const target = objectTarget(obj({ kind, privacyClass }));
        assert.equal(resolveShareBound(target, IN_GROUP), null, `${kind}/${privacyClass}`);
      }
    }
  });
});

// ── §37 · "Share permitted location" is bounded and can never widen ───────────

describe('§37 · share bound', () => {
  test('a bare coordinate shares at the ceiling and no further', () => {
    const bound = resolveShareBound(COORD, IN_GROUP);
    assert.ok(bound);
    assert.equal(bound.privacyClass, SHARE_PRECISION_CEILING);
    assert.equal(bound.purpose, DEFAULT_SHARE_PURPOSE);
    assert.ok(bound.ttlMs > 0 && bound.ttlMs <= SHARE_MAX_TTL_MS);
  });

  test('never exceeds the ceiling, and never exceeds the target, for any input', () => {
    const grants: (PrecisionGrant | null)[] = [
      null,
      {
        purpose: 'shared_moment',
        optedIn: true,
        scopeId: 'crew-1',
        grantedClass: 'precise_temporary',
        expiresAt: 4_000_000_000_000,
      },
      {
        purpose: 'trip_crew',
        optedIn: true,
        scopeId: 'crew-1',
        grantedClass: 'precise_temporary',
        expiresAt: 4_000_000_000_000,
      },
      {
        purpose: 'safe_return',
        optedIn: true,
        scopeId: 'sr-1',
        grantedClass: 'precise_temporary',
        expiresAt: 4_000_000_000_000,
      },
    ];
    const purposes = [
      undefined,
      'shared_moment',
      'trip_crew',
      'locate_my_friends',
      'safe_return',
      'public_stranger',
      'not_a_purpose',
    ] as const;

    for (const grant of grants) {
      for (const sharePurpose of purposes) {
        const ctx = {
          ...IN_GROUP,
          shareGrant: grant,
          now: 1_000_000_000_000,
          ...(sharePurpose ? { sharePurpose: sharePurpose as never } : {}),
        };

        const coordBound = resolveShareBound(COORD, ctx);
        if (coordBound) {
          assert.ok(
            precisionRank(coordBound.privacyClass) <= precisionRank(SHARE_PRECISION_CEILING),
            `coordinate widened past the ceiling for ${sharePurpose}`,
          );
        }

        for (const privacyClass of PRIVACY_CLASSES) {
          const target = objectTarget(obj({ kind: 'place', privacyClass }));
          const bound = resolveShareBound(target, ctx);
          if (!bound) continue;
          assert.ok(
            precisionRank(bound.privacyClass) <= precisionRank(SHARE_PRECISION_CEILING),
            `widened past the ceiling for ${privacyClass}/${sharePurpose}`,
          );
          assert.ok(
            precisionRank(bound.privacyClass) <= precisionRank(privacyClass),
            `sharpened the target's own rung for ${privacyClass}/${sharePurpose}`,
          );
        }
      }
    }
  });

  test('a live precise_temporary grant still cannot raise a map share above place_level', () => {
    const bound = resolveShareBound(COORD, {
      ...IN_GROUP,
      sharePurpose: 'shared_moment',
      now: 1_000,
      shareGrant: {
        purpose: 'shared_moment',
        optedIn: true,
        scopeId: 'moment-1',
        grantedClass: 'precise_temporary',
        expiresAt: 9_999_999,
      },
    });
    assert.ok(bound);
    assert.equal(bound.privacyClass, SHARE_PRECISION_CEILING);
    assert.notEqual(bound.privacyClass, 'precise_temporary');
  });

  test('an unrecognised purpose shares nothing (fail closed)', () => {
    assert.equal(
      resolveShareBound(COORD, { ...IN_GROUP, sharePurpose: 'anything' as never }),
      null,
    );
    const item = itemFor(COORD, 'share', { ...IN_GROUP, sharePurpose: 'anything' as never });
    assert.equal(item.enabled, false);
  });

  test('a public-stranger purpose shares nothing — §37 forbids the people tracker', () => {
    assert.equal(resolveShareBound(COORD, { ...IN_GROUP, sharePurpose: 'public_stranger' }), null);
  });

  test('the TTL is mandatory, clamps DOWN, and never up', () => {
    assert.equal(resolveShareBound(COORD, IN_GROUP)?.ttlMs, SHARE_MAX_TTL_MS);
    assert.equal(
      resolveShareBound(COORD, { ...IN_GROUP, shareTtlMs: 5 * 60_000 })?.ttlMs,
      5 * 60_000,
    );
    for (const asked of [SHARE_MAX_TTL_MS * 10, Number.POSITIVE_INFINITY, 0, -1, Number.NaN]) {
      const bound = resolveShareBound(COORD, { ...IN_GROUP, shareTtlMs: asked });
      assert.ok(bound);
      assert.ok(bound.ttlMs > 0 && bound.ttlMs <= SHARE_MAX_TTL_MS, `ttl escaped for ${asked}`);
    }
  });

  test('a person-bearing object never offers a share, however precise it is', () => {
    for (const kind of PERSON_BEARING_KINDS) {
      for (const privacyClass of ['approximate', 'place_level', 'precise_temporary'] as const) {
        const target = objectTarget(obj({ kind, privacyClass }));
        assert.equal(resolveShareBound(target, IN_GROUP), null, `${kind}/${privacyClass}`);
        const item = itemFor(target, 'share');
        assert.equal(item.enabled, false);
        assert.match(item.reason ?? '', /your own location/i);
      }
    }
  });
});

// ── §25 · "Add to Trip" needs somewhere to hand off to ────────────────────────

describe('§25 · the Add to Trip handoff', () => {
  test('an object with no page cannot offer it, and says so', () => {
    const item = itemFor(objectTarget(obj({ privacyClass: 'place_level' })), 'add_to_trip');
    assert.equal(item.enabled, false);
    assert.match(item.reason ?? '', /no page/i);
  });

  test('a blank route is no route', () => {
    for (const detailRoute of ['', '   ']) {
      const target = objectTarget(obj({ interaction: { actions: [], detailRoute } }));
      assert.equal(itemFor(target, 'add_to_trip').enabled, false, JSON.stringify(detailRoute));
    }
  });

  test('a page makes it available', () => {
    assert.equal(itemFor(objectTarget(WITH_PAGE()), 'add_to_trip').enabled, true);
  });

  test('Save carries no such bar — it writes a row, it does not navigate', () => {
    // The asymmetry is the point: `save` builds a self-contained wishlist entry
    // out of the object itself, so a page it would never open cannot gate it.
    assert.equal(itemFor(objectTarget(obj({ privacyClass: 'place_level' })), 'save').enabled, true);
  });

  test('the §23 floor still wins over the handoff — the privacy reason is the one shown', () => {
    const target = objectTarget(WITH_PAGE({ kind: 'social_zone', privacyClass: 'aggregate_only' }));
    const item = itemFor(target, 'add_to_trip');
    assert.equal(item.enabled, false);
    assert.match(item.reason ?? '', /people, not a place/i);
  });
});

// ── §37 · The bounded, expiring share channel ─────────────────────────────────

describe('§37 · share channel', () => {
  const eligibleTargets: LongPressTarget[] = [
    COORD,
    ...MAP_OBJECT_KINDS.filter((k) => !PERSON_BEARING_KINDS.includes(k)).flatMap((kind) =>
      // At or above the identity line, so a share bound exists at all.
      (['approximate', 'place_level', 'precise_temporary'] as const).map((privacyClass) =>
        objectTarget(WITH_PAGE({ kind, privacyClass })),
      ),
    ),
  ];

  test('the channel now exists', () => {
    // A bounded-TTL §12 session IS the channel; the capability is on.
    assert.equal(BOUNDED_SHARE_CHANNEL_EXISTS, true);
  });

  test('with an active session, an eligible press opens a bounded share', () => {
    for (const target of eligibleTargets) {
      const item = longPressItemFor(resolveLongPressActions(target, WITH_CHANNEL), 'share');
      assert.ok(item);
      assert.equal(item.enabled, true);
      assert.ok(item.shareBound, 'an enabled share carries its §37 bound');
      // Never above the map long-press ceiling, whatever the target.
      assert.ok(
        precisionRank(item.shareBound!.privacyClass) <= precisionRank(SHARE_PRECISION_CEILING),
      );
      assert.ok(item.shareBound!.ttlMs > 0 && item.shareBound!.ttlMs <= SHARE_MAX_TTL_MS);
    }
  });

  test('without a session channel, the row is disabled and names something the user can do', () => {
    for (const target of eligibleTargets) {
      // IN_GROUP has a checkpoint scope but NO share channel session.
      const item = longPressItemFor(resolveLongPressActions(target, IN_GROUP), 'share');
      assert.ok(item);
      assert.equal(item.enabled, false, 'no channel ⇒ no share');
      assert.equal(item.shareBound, undefined);
      assert.equal(item.reason, NO_SHARE_CHANNEL_TARGET_REASON);
    }
  });

  test('a blank session id is no channel', () => {
    for (const bad of ['', '   ']) {
      const item = itemFor(COORD, 'share', { shareChannelSessionId: bad });
      assert.equal(item.enabled, false);
      assert.equal(item.reason, NO_SHARE_CHANNEL_TARGET_REASON);
    }
  });

  test('the §37 bound is computed the same whether or not a channel is present', () => {
    // The bound is the RULE; the channel is the OFFER. The rule does not move.
    const bound = resolveShareBound(COORD, WITH_CHANNEL);
    assert.ok(bound);
    assert.equal(bound.privacyClass, SHARE_PRECISION_CEILING);
    assert.equal(bound.ttlMs, SHARE_MAX_TTL_MS);
    assert.deepEqual(resolveShareBound(COORD, IN_GROUP), bound);
  });

  test('a privacy refusal beats the channel — a person is never shareable, session or not', () => {
    // §23 is permanent and the channel is incidental; a person-bearing object is
    // refused for the reason that will still be true tomorrow, even with a live
    // session that could otherwise open a share.
    const person = objectTarget(obj({ kind: 'crew_member', privacyClass: 'place_level' }));
    assert.match(itemFor(person, 'share', WITH_CHANNEL).reason ?? '', /your own location/i);
    const aggregate = objectTarget(obj({ kind: 'place', privacyClass: 'aggregate_only' }));
    assert.match(itemFor(aggregate, 'share', WITH_CHANNEL).reason ?? '', /aggregated/i);
  });

  test('NO_SHARE_CHANNEL_REASON survives as the kill-switch message', () => {
    // Kept exported and non-empty so flipping BOUNDED_SHARE_CHANNEL_EXISTS off
    // has a reason to show. It is not the reason shown while the channel is on.
    assert.ok(typeof NO_SHARE_CHANNEL_REASON === 'string' && NO_SHARE_CHANNEL_REASON.length > 0);
  });
});

// ── §22 · "Report what is here" ───────────────────────────────────────────────

describe('§22 · report', () => {
  const NO_PROMPT_KINDS: readonly MapObjectKind[] = [
    'crew_member',
    'buddy_zone',
    'safety_notice',
    'memory',
    'prediction',
    // §36 Phase 7. Three are aggregates over many people with no place to
    // anchor an observation to, and the fourth is the viewer's own history —
    // the same reason `memory` is here. Mirrors liveTruth.KIND_PROMPTS and the
    // server's routes/mapObservations.KIND_PROMPTS.
    'world_pulse',
    'traveler_flow',
    'city_model',
    'personal_city',
  ];

  test('offered only for kinds §22 has a prompt for', () => {
    for (const kind of MAP_OBJECT_KINDS) {
      const target = objectTarget(obj({ kind, privacyClass: 'place_level' }));
      const expected = !NO_PROMPT_KINDS.includes(kind);
      assert.equal(itemFor(target, 'report').enabled, expected, kind);
    }
  });

  test('not offered where no prompt applies, and it says why', () => {
    for (const kind of NO_PROMPT_KINDS) {
      const item = itemFor(objectTarget(obj({ kind, privacyClass: 'place_level' })), 'report');
      assert.equal(item.enabled, false);
      assert.match(item.reason ?? '', /nothing here you can report/i);
    }
  });

  test('an activity_zone can still be reported — just not closed (§22 decides which)', () => {
    const zone = objectTarget(obj({ kind: 'activity_zone', privacyClass: 'place_level' }));
    assert.equal(itemFor(zone, 'report').enabled, true);
  });

  test("the projection's explicit contributable:false shuts it off", () => {
    const target = objectTarget(
      obj({ kind: 'place', privacyClass: 'place_level', interaction: { actions: [], contributable: false } }),
    );
    assert.equal(itemFor(target, 'report').enabled, false);
  });
});

// ── §19 · describeTarget prints no precision it was not given ────────────────

describe('§19 · describeTarget', () => {
  test('a coordinate is coarsened, never printed at full precision', () => {
    const label = describeTarget(COORD);
    assert.ok(!label.includes(String(DA_NANG_LAT)), label);
    assert.ok(!label.includes(String(DA_NANG_LNG)), label);
    assert.ok(!label.includes('16.047'), label);
    assert.ok(label.includes(DA_NANG_LAT.toFixed(COORDINATE_LABEL_DECIMALS)), label);
    assert.match(label, /N/);
    assert.match(label, /E/);
  });

  test('hemispheres are named rather than signed', () => {
    const label = describeTarget(coordinateTarget(-33.86, -151.2));
    assert.match(label, /S/);
    assert.match(label, /W/);
    assert.ok(!label.includes('-'), label);
  });

  test('an unusable coordinate falls back rather than printing NaN', () => {
    assert.equal(describeTarget(coordinateTarget(Number.NaN, 5)), UNKNOWN_TARGET_LABEL);
    assert.equal(describeTarget(null), UNKNOWN_TARGET_LABEL);
  });

  test('a place keeps its own title; a titleless object falls back', () => {
    assert.equal(describeTarget(objectTarget(obj({ title: 'Cong Caphe' }))), 'Cong Caphe');
    assert.equal(describeTarget(objectTarget(obj({ title: '   ' }))), UNKNOWN_TARGET_LABEL);
  });

  test('a crew member at a rung that permits identity may be named', () => {
    const target = objectTarget(
      obj({ kind: 'crew_member', privacyClass: 'approximate', title: 'Linh' }),
    );
    assert.equal(describeTarget(target), 'Linh');
  });

  test('the same crew member one rung lower is not', () => {
    const target = objectTarget(
      obj({ kind: 'crew_member', privacyClass: 'aggregate_only', title: 'Linh' }),
    );
    assert.equal(describeTarget(target), AGGREGATE_AREA_LABEL);
  });
});

// ── coordinateOf ──────────────────────────────────────────────────────────────

describe('coordinateOf', () => {
  test('a coordinate target is itself; an object target is its centroid', () => {
    assert.deepEqual(coordinateOf(COORD), { lat: DA_NANG_LAT, lng: DA_NANG_LNG });
    assert.deepEqual(coordinateOf(objectTarget(obj())), { lat: DA_NANG_LAT, lng: DA_NANG_LNG });
  });

  test('an unusable point yields null rather than a plausible zero', () => {
    assert.equal(coordinateOf(coordinateTarget(Number.NaN, 0)), null);
    assert.equal(coordinateOf(null), null);
  });
});

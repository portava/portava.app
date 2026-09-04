/**
 * Meet Here — the disclosure invariant, as a property over the WHOLE enum space.
 *
 * WHY THIS FILE IS SEPARATE FROM meetHereModel.test.ts
 * ====================================================
 * That file has example tests: "a place_level subject publishes at
 * place_level". Examples verify the cases someone thought of. They do not
 * protect the rule when a NEW subject type is added — the new case simply has
 * no test, and the suite stays green while the invariant is violated.
 *
 * This file enumerates `PRIVACY_CLASSES` and `MAP_OBJECT_KINDS` from the
 * contract itself, so adding a member to either automatically brings it under
 * the invariant. It then asserts its own coverage was exhaustive, so the
 * enumeration cannot silently shrink either.
 *
 * THE INVARIANT
 * =============
 *     effective_precision <= subject_precision
 *
 * A meeting point publishes a location to several people. It may repeat what
 * the viewer already knew, or say less. It may NEVER say more. Every other rule
 * in the model — the ceiling, the aggregate refusal, the coordinate handling —
 * exists to serve this one, so this is the test that matters if only one
 * survives.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { proposeMeetHere, MEET_POINT_CEILING, type MeetTarget } from '../meetHereModel.ts';
import {
  MAP_OBJECT_KINDS,
  PRIVACY_CLASSES,
  point,
  precisionRank,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../../../types/mapObjects.ts';

/** Every (kind x privacyClass) pair the contract can currently express. */
function everySubject(): Array<{ kind: MapObjectKind; cls: PrivacyClass; object: MapObject }> {
  const out: Array<{ kind: MapObjectKind; cls: PrivacyClass; object: MapObject }> = [];
  for (const kind of MAP_OBJECT_KINDS) {
    for (const cls of PRIVACY_CLASSES) {
      out.push({
        kind,
        cls,
        object: {
          id: `${kind}:x1`,
          kind,
          geometry: point(16.05, 108.2),
          title: `A ${kind}`,
          privacyClass: cls,
          renderingPriority: 40,
        },
      });
    }
  }
  return out;
}

describe('INVARIANT: effective_precision <= subject_precision', () => {
  test('holds for every (kind x privacyClass) the contract can express', () => {
    const subjects = everySubject();
    // Guard the guard: if the contract's enums shrink to nothing, or this
    // helper stops producing pairs, the loop below would pass vacuously.
    assert.equal(
      subjects.length,
      MAP_OBJECT_KINDS.length * PRIVACY_CLASSES.length,
      'the enumeration must cover the full cross-product',
    );
    assert.ok(subjects.length >= 13 * 5, 'suspiciously small subject space');

    const violations: string[] = [];
    for (const { kind, cls, object } of subjects) {
      const d = proposeMeetHere({ kind: 'object', object });
      if (!d.ok) continue; // a refusal discloses nothing; that is always safe
      if (precisionRank(d.proposal.sharedAs) > precisionRank(cls)) {
        violations.push(`${kind} @ ${cls} -> published at ${d.proposal.sharedAs}`);
      }
    }
    assert.deepEqual(violations, [], 'a meeting point published MORE precisely than its subject');
  });

  test('every privacy class is actually exercised — coverage cannot silently shrink', () => {
    const seen = new Set<PrivacyClass>();
    for (const { cls, object } of everySubject()) {
      proposeMeetHere({ kind: 'object', object });
      seen.add(cls);
    }
    assert.deepEqual(
      [...seen].sort(),
      [...PRIVACY_CLASSES].sort(),
      'a privacy class exists that this invariant never exercised',
    );
  });

  test('every object kind is actually exercised', () => {
    const seen = new Set<MapObjectKind>();
    for (const { kind, object } of everySubject()) {
      proposeMeetHere({ kind: 'object', object });
      seen.add(kind);
    }
    assert.deepEqual(
      [...seen].sort(),
      [...MAP_OBJECT_KINDS].sort(),
      'an object kind exists that this invariant never exercised',
    );
  });

  test('a NEW privacy class added below "approximate" must refuse, not publish', () => {
    // The rule a future editor is most likely to break: adding a coarser rung
    // and forgetting that coarser-than-approximate means "not a place".
    for (const cls of PRIVACY_CLASSES) {
      if (precisionRank(cls) >= precisionRank('approximate')) continue;
      for (const kind of MAP_OBJECT_KINDS) {
        const d = proposeMeetHere({
          kind: 'object',
          object: {
            id: `${kind}:x`,
            kind,
            geometry: point(1, 2),
            title: 'x',
            privacyClass: cls,
            renderingPriority: 10,
          },
        });
        assert.equal(
          d.ok,
          false,
          `${kind} at ${cls} is below the place threshold and must be refused, not published`,
        );
      }
    }
  });

  test('nothing anywhere in the space can reach precise_temporary', () => {
    // That rung belongs to Safe Return and to a group session the user
    // deliberately entered. A dropped pin must never reach it, whatever the
    // subject claims to be.
    for (const { kind, cls, object } of everySubject()) {
      const d = proposeMeetHere({ kind: 'object', object });
      if (!d.ok) continue;
      assert.notEqual(
        d.proposal.sharedAs,
        'precise_temporary',
        `${kind} @ ${cls} reached precise_temporary`,
      );
      assert.ok(
        precisionRank(d.proposal.sharedAs) <= precisionRank(MEET_POINT_CEILING),
        `${kind} @ ${cls} exceeded the meeting-point ceiling`,
      );
    }
  });

  test('the ceiling constant itself is not more precise than place_level', () => {
    // If someone raises MEET_POINT_CEILING, every test above still passes
    // because they compare against the constant. This pins the constant.
    assert.ok(
      precisionRank(MEET_POINT_CEILING) <= precisionRank('place_level'),
      'MEET_POINT_CEILING was raised above place_level — that is a §23 policy change, not a refactor',
    );
  });
});

describe('INVARIANT: a user-picked coordinate discloses only the user', () => {
  test('always publishes at exactly the ceiling, never above', () => {
    const targets: MeetTarget[] = [
      { kind: 'coordinate', lat: 16.05, lng: 108.2 },
      { kind: 'coordinate', lat: -33.86, lng: 151.2, label: 'The bridge' },
      { kind: 'coordinate', lat: 0, lng: 0 },
    ];
    for (const t of targets) {
      const d = proposeMeetHere(t);
      assert.ok(d.ok);
      assert.equal(d.proposal.sharedAs, MEET_POINT_CEILING);
      assert.equal(d.proposal.subjectId, null, 'a dropped pin has no subject to attribute');
    }
  });

  test('never leaks a coordinate into the human-readable title', () => {
    for (const lat of [16.05, -33.8688, 0]) {
      const d = proposeMeetHere({ kind: 'coordinate', lat, lng: 108.2 });
      assert.ok(d.ok);
      assert.doesNotMatch(
        d.proposal.title,
        /\d/,
        'a meeting-point title must be a place people read, never a coordinate',
      );
    }
  });
});

describe('INVARIANT: the decision is total', () => {
  test('every subject in the space produces a decision, never a throw', () => {
    for (const { kind, cls, object } of everySubject()) {
      assert.doesNotThrow(
        () => proposeMeetHere({ kind: 'object', object }),
        `${kind} @ ${cls} threw instead of deciding`,
      );
    }
  });

  test('malformed input decides rather than throwing', () => {
    const malformed = [
      { kind: 'object', object: { ...{}, privacyClass: undefined } },
      { kind: 'object', object: { privacyClass: 'not_a_class', geometry: null, title: '' } },
      { kind: 'coordinate', lat: undefined, lng: undefined },
    ] as unknown as MeetTarget[];
    for (const t of malformed) {
      assert.doesNotThrow(() => proposeMeetHere(t));
      assert.equal(proposeMeetHere(t).ok, false, 'malformed input must fail closed');
    }
  });
});

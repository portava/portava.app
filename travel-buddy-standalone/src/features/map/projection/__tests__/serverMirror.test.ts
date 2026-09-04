/**
 * Server-mirror guard — the client fallback projectors must emit the SAME
 * payload shape as the Map Intelligence Gateway's.
 *
 * WHY
 * ===
 * `map_projection_enabled` decides whether hidden gems and events reach the
 * renderer from the gateway (artifacts/api-server/src/lib/mapProjection.ts) or
 * from `projectGemLocal` / `projectEventLocal` here. That flag is meant to be a
 * ROLLBACK — flip it and the map behaves as it did before, not differently.
 * It only is one while both sides put the same keys on `payload`.
 *
 * Before this guard existed the two had already diverged badly: the client
 * projectors handed the WHOLE service DTO through, so gem and event cards had
 * `vibeTags`, `goingCount` and `hostName` with the flag off and nothing but
 * `title` with the flag on. Nothing failed, because nothing compared them.
 *
 * HOW
 * ===
 * The server file is read as TEXT, the same technique
 * artifacts/api-server/src/test/mapObjectsContract.test.ts uses in the other
 * direction. The app and the API server are separate packages with no shared
 * build, and the server module uses `.js` ESM specifiers that this package
 * cannot resolve — text comparison needs neither.
 *
 * If the server package is not checked out beside this one the guard SKIPS
 * rather than passes: a guard that quietly reports success when it did not run
 * is the same failure it exists to prevent.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectEventLocal, projectGemLocal } from '../clientProjection.ts';
import { placeCardPayload } from '../../../../types/mapCardPayloads.ts';
import { eventDto, FIXTURE_NOW, gemDto, placeObject } from '../../../../__fixtures__/mapEntities.ts';

const __dir = dirname(fileURLToPath(import.meta.url));
const SERVER_PROJECTION = resolve(
  __dir,
  '../../../../../../artifacts/api-server/src/lib/mapProjection.ts',
);
/** The place producer lives in its own server module (lib/mapProjectPlace). */
const SERVER_PLACE_PROJECTION = resolve(
  __dir,
  '../../../../../../artifacts/api-server/src/lib/mapProjectPlace.ts',
);

/**
 * The keys of the object literal assigned to `payload:` inside `export function
 * <name>`. Deliberately narrow: it reads the one `payload: { … }` block in that
 * function and nothing else, so an unrelated edit elsewhere in the file cannot
 * make it pass or fail by accident.
 */
function serverPayloadKeys(source: string, fnName: string): string[] {
  const fnStart = source.indexOf(`export function ${fnName}(`);
  assert.notEqual(fnStart, -1, `server projector ${fnName} not found`);
  const nextFn = source.indexOf('\nexport function ', fnStart + 1);
  const body = source.slice(fnStart, nextFn === -1 ? undefined : nextFn);

  const at = body.indexOf('payload: {');
  assert.notEqual(at, -1, `${fnName} has no object-literal payload`);

  // Walk braces from the opening one so a nested object cannot end the block early.
  let depth = 0;
  let end = -1;
  for (let i = body.indexOf('{', at); i < body.length; i += 1) {
    if (body[i] === '{') depth += 1;
    else if (body[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.notEqual(end, -1, `${fnName}'s payload literal is unbalanced`);

  const literal = body.slice(body.indexOf('{', at) + 1, end);
  // Top-level `key:` only — skip anything nested inside a deeper brace.
  const keys: string[] = [];
  let d = 0;
  for (const line of literal.split('\n')) {
    const trimmed = line.trim();
    if (d === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(trimmed);
      if (m) keys.push(m[1]);
    }
    d += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
  }
  return keys.sort();
}

const serverAvailable = existsSync(SERVER_PROJECTION) && existsSync(SERVER_PLACE_PROJECTION);
const serverSource = serverAvailable ? readFileSync(SERVER_PROJECTION, 'utf8') : '';
const serverPlaceSource = serverAvailable ? readFileSync(SERVER_PLACE_PROJECTION, 'utf8') : '';

describe('client fallback projectors mirror the gateway', { skip: !serverAvailable
  ? 'api-server package not checked out beside travel-buddy-standalone'
  : false }, () => {
  test('projectGemLocal emits exactly the keys projectGem does', () => {
    const client = Object.keys(projectGemLocal(gemDto)!.payload as object).sort();
    assert.deepEqual(client, serverPayloadKeys(serverSource, 'projectGem'));
  });

  test('projectEventLocal emits exactly the keys projectEvent does', () => {
    const client = Object.keys(projectEventLocal(eventDto, FIXTURE_NOW)!.payload as object).sort();
    assert.deepEqual(client, serverPayloadKeys(serverSource, 'projectEvent'));
  });

  test('the guard is actually reading the server file, not an empty match', () => {
    // Self-check: if serverPayloadKeys ever silently returned [], both
    // assertions above would still pass whenever the client emitted nothing.
    assert.ok(serverPayloadKeys(serverSource, 'projectGem').length >= 3);
    assert.ok(serverPayloadKeys(serverSource, 'projectEvent').length >= 3);
    assert.ok(serverPayloadKeys(serverPlaceSource, 'projectPlace').length >= 3);
  });

  // ── place: no client projector, so the CONSUMER is what mirrors ─────────────
  //
  // A canonical place has no rollback projector on the client (see
  // PlaceCardPayload for why). What must mirror the server instead is the
  // typed accessor every card, marker and action reads the payload through —
  // and the literal fixture the client tests are written against. If
  // projectPlace gains or loses a payload field, both fail here.

  test('placeCardPayload reads exactly the keys projectPlace emits', () => {
    const server = serverPayloadKeys(serverPlaceSource, 'projectPlace');
    const read = placeCardPayload(placeObject());
    assert.ok(read, 'the accessor must accept the server-shaped fixture');
    assert.deepEqual(Object.keys(read!).sort(), server);
  });

  test('the place fixture is the shape the server serves, key for key', () => {
    const server = serverPayloadKeys(serverPlaceSource, 'projectPlace');
    assert.deepEqual(Object.keys(placeObject().payload as object).sort(), server);
  });

  test('the place object id and detail route follow the server convention', () => {
    // `place:<places.id>` and `/place/<places.id>` — read off the producer.
    assert.match(serverPlaceSource, /id: `place:\$\{row\.id\}`/);
    assert.match(serverPlaceSource, /return `\/place\/\$\{encodeURIComponent\(placeId\)\}`/);
    const obj = placeObject();
    assert.match(obj.id, /^place:/);
    assert.equal(obj.interaction?.detailRoute, `/place/${obj.id.slice('place:'.length)}`);
  });
});

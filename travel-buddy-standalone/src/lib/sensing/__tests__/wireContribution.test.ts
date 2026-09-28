/**
 * wireContribution — the client produces EXACTLY the contract fixture's body.
 *
 * `docs/contracts/sensing-contribution-wire-v1.json` is read from the
 * repository root, the same file the server's sensingIngestWireContract test
 * reads. A mapper drift and a schema drift both land on this one JSON.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { toWireContribution, centi } from '../wireContribution.ts';
import type { SensingContributionPayload } from '../contributionPayload.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../../../../docs/contracts/sensing-contribution-wire-v1.json');
const contract = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  version: number;
  payload: SensingContributionPayload;
  identity: { commitment: string; rotationEpoch: number };
  body: Record<string, unknown>;
};

describe('the wire contract fixture', () => {
  test('the mapper produces the fixture body, key for key', () => {
    const body = toWireContribution(contract.payload, contract.identity);
    assert.deepEqual(JSON.parse(JSON.stringify(body)), contract.body);
  });

  test('without the acoustic pair, the wire carries no acoustic key at all', () => {
    const { acoustic: _dropped, ...noAcoustic } = contract.payload;
    void _dropped;
    const body = toWireContribution(noAcoustic as SensingContributionPayload, contract.identity);
    assert.equal('acoustic' in body.features, false);
  });

  test('floats leave as centi-ordinals; a distribution leaves as its arg-max', () => {
    assert.equal(centi(0.3471), 35);
    assert.equal(centi(1.7), 100, 'clamped, never wrapped');
    assert.equal(centi(-1), 0);
    assert.equal(centi(null), null);
    assert.equal(centi(Number.NaN), null);
    const body = toWireContribution(contract.payload, contract.identity);
    assert.equal(body.features.transportMode, 'pedestrian');
    assert.equal(body.features.transportModeCenti, 80);
  });

  test('nothing precise or identifying is on the wire', () => {
    const text = JSON.stringify(toWireContribution(contract.payload, contract.identity));
    for (const forbidden of ['time_bucket', 'timeBucket', 'sample_count', 'sampleCount', 'lat', 'lng', 'longitude', 'latitude', 'user', 'device', 'installation', 'session', 'Authorization']) {
      assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `wire body carries ${forbidden}`);
    }
    // `observedAtMs` is the bucket start the payload already carried, not a fresh instant.
    assert.equal(toWireContribution(contract.payload, contract.identity).observedAtMs, contract.payload.observed_at_ms);
    assert.equal(contract.payload.observed_at_ms, Date.parse(contract.payload.time_bucket));
  });

  test('a missing or short commitment is refused before anything is sent', () => {
    assert.throws(() => toWireContribution(contract.payload, { commitment: 'short', rotationEpoch: 1 }), /commitment/);
    assert.throws(() => toWireContribution(contract.payload, { commitment: contract.identity.commitment, rotationEpoch: -1 }), /rotationEpoch/);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateProviderParity, hashParityPolicy, PROVIDER_PROFILES } from './provider-parity.mjs';

// Entirely synthetic fixtures exercise the checker. They are NOT a model run,
// and no fixture/report here is an approval to replace a production provider.
const hash = input => createHash('sha256').update(input).digest('hex');
const now = Date.parse('2026-11-13T12:00:00Z');
function fixture(profile = 'captions') {
  const policy = { schemaVersion: 1, profile, registeredAt: '2026-11-12T00:00:00Z', heldOut: true,
    datasetSha256: hash('fixture-dataset'), requiredSegments: ['language:en', 'language:vi'],
    cases: Array.from({ length: 120 }, (_, i) => ({ caseId: `case-${i}`, inputSha256: hash(`input-${i}`), segments: [i < 60 ? 'language:en' : 'language:vi'] })) };
  const provider = { id: 'test-only', revision: 'fixture-1', configSha256: hash('config'), runtimeSha256: hash('runtime') };
  const result = () => ({ ok: true, latencyMs: 100, criticalFailures: 0, outputSha256: hash('fixture-output'),
    quality: Object.fromEntries(PROVIDER_PROFILES[profile].map(dimension => [dimension, .8])) });
  const evidence = { schemaVersion: 1, kind: 'live', policySha256: hashParityPolicy(policy), datasetSha256: policy.datasetSha256,
    startedAt: '2026-11-13T00:00:00Z', completedAt: '2026-11-13T01:00:00Z', baseline: provider,
    candidate: { ...provider, hosting: 'in_house', licenseReview: { id: 'fixture-review', approved: true } },
    review: { id: 'fixture-review', blinded: true, referenceChecked: true, completedAt: '2026-11-13T02:00:00Z' },
    pairs: policy.cases.map(row => ({ caseId: row.caseId, inputSha256: row.inputSha256, baseline: result(), candidate: result() })) };
  return { policy, evidence };
}
const run = ({ policy, evidence }) => evaluateProviderParity(policy, evidence, { now });

test('equal paired evidence only passes the offline screen, never authorizes a replacement', () => {
  const report = run(fixture());
  assert.equal(report.status, 'offline_screen_passed');
  assert.equal(report.eligibleForReplacement, false);
  assert.equal(report.comparisons.length, 3);
  assert.ok(report.remaining.includes('bounded_canary_and_rollback_review'));
});

test('a better aggregate cannot hide a language regression', () => {
  const data = fixture();
  data.evidence.pairs.forEach((pair, i) => { pair.candidate.quality.transcription = i < 60 ? 1 : .7; });
  const report = run(data);
  assert.equal(report.status, 'blocked');
  assert.ok(report.blockers.includes('language:vi:transcription:quality_regression'));
  assert.ok(report.comparisons[0].quality.transcription.difference > 0);
});

test('equal means with inconsistent paired results need more evidence', () => {
  const data = fixture();
  data.evidence.pairs.forEach((pair, i) => { pair.candidate.quality.transcription = i % 2 ? .7 : .9; });
  assert.ok(run(data).blockers.includes('overall:transcription:uncertain_parity'));
});

test('tail latency, availability and critical failures each block independently', () => {
  for (const change of [
    data => { data.evidence.pairs.slice(0, 6).forEach(pair => { pair.candidate.latencyMs = 101; }); },
    data => { const pair = data.evidence.pairs[0]; pair.candidate.ok = false; Object.keys(pair.candidate.quality).forEach(key => { pair.candidate.quality[key] = 0; }); },
    data => { data.evidence.pairs[0].candidate.criticalFailures = 1; },
  ]) { const data = fixture(); change(data); assert.equal(run(data).status, 'blocked'); }
});

test('no cherry-picking, missing dimensions, duplicated samples or mismatched work', () => {
  for (const change of [
    data => data.evidence.pairs.pop(),
    data => { data.evidence.pairs[1] = data.evidence.pairs[0]; },
    data => { data.evidence.pairs[0].inputSha256 = hash('different'); },
    data => { delete data.evidence.pairs[0].candidate.quality.timing; },
    data => { data.evidence.pairs[0].candidate.quality.language = NaN; },
    data => { data.evidence.pairs[0].candidate.ok = false; },
    data => { data.policy.cases[1].inputSha256 = data.policy.cases[0].inputSha256; },
    data => { data.policy.cases.splice(30); },
    data => { data.policy.requiredSegments.push('language:missing'); },
    data => { data.policy.cases[0].segments = ['language:unregistered']; },
    data => { data.evidence.policySha256 = hash('modified-policy'); },
    data => { data.evidence.datasetSha256 = hash('modified-dataset'); },
  ]) { const data = fixture(); change(data); assert.equal(run(data).status, 'blocked'); }
});

test('stale, synthetic, unreviewed, unpinned and managed candidates cannot qualify', () => {
  for (const change of [
    data => { data.evidence.kind = 'synthetic'; },
    data => { data.evidence.startedAt = '2026-09-01T00:00:00Z'; },
    data => { data.evidence.completedAt = '2027-01-01T00:00:00Z'; },
    data => { data.policy.heldOut = false; },
    data => { data.evidence.candidate.revision = 'latest'; },
    data => { data.evidence.candidate.hosting = 'managed'; },
    data => { data.evidence.candidate.licenseReview.approved = false; },
    data => { data.evidence.review.blinded = false; },
    data => { data.evidence.review.referenceChecked = false; },
  ]) { const data = fixture(); change(data); assert.equal(run(data).status, 'blocked'); }
});

test('each profile requires its own complete dimensions and hashes are canonical', () => {
  for (const profile of Object.keys(PROVIDER_PROFILES)) assert.equal(run(fixture(profile)).status, 'offline_screen_passed');
  const { policy } = fixture();
  assert.equal(hashParityPolicy(policy), hashParityPolicy(Object.fromEntries(Object.entries(policy).reverse())));
  for (const invalid of [null, {}, { schemaVersion: 1, profile: '__proto__' }]) assert.equal(evaluateProviderParity(invalid, null).status, 'blocked');
});

test('CLI rejects missing or malformed evidence without leaking input content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portava-parity-'));
  const cli = new URL('../check-provider-parity.mjs', import.meta.url);
  try {
    const bad = join(directory, 'bad.json'); await writeFile(bad, 'PRIVATE_RAW_CONTENT invalid JSON');
    const result = spawnSync(process.execPath, [cli.pathname, '--policy', bad, '--evidence', bad], { encoding: 'utf8' });
    assert.equal(result.status, 2); assert.ok(!`${result.stdout}${result.stderr}`.includes('PRIVATE_RAW_CONTENT'));
    const data = fixture(); data.evidence.kind = 'synthetic';
    const policy = join(directory, 'policy.json'); const evidence = join(directory, 'evidence.json');
    await writeFile(policy, JSON.stringify(data.policy)); await writeFile(evidence, JSON.stringify(data.evidence));
    const blocked = spawnSync(process.execPath, [cli.pathname, '--policy', policy, '--evidence', evidence], { encoding: 'utf8' });
    assert.equal(blocked.status, 2); assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

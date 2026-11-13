import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyRelease, canonical, sha256, sign, validateRelease } from './provider-release-events.mjs';
const registry = JSON.parse(await readFile(new URL('../config/external-integrations.json', import.meta.url)));
const pins = JSON.parse(await readFile(new URL('../artifacts/api-server/src/config/providerVersions.json', import.meta.url)));
function fixture() {
  const eventKey = 'a'.repeat(32), evaluationKey = 'b'.repeat(32), commit = 'c'.repeat(40), now = Date.now();
  const event = { id: 'release_123', provider: 'higgsfield', kind: 'model', binding: 'higgsfield-image', previous: pins.models.find(p => p.key === 'higgsfield-image').current,
    version: 'higgsfield-ai/soul/v-test/standard', publishedAt: new Date(now).toISOString(), releaseUrl: 'https://docs.higgsfield.ai/release' };
  const evidence = { schemaVersion: 1, kind: 'live', eventSha256: sha256(canonical(event)), pinsSha256: sha256(canonical(pins)), commit,
    completedAt: new Date(now).toISOString(), checks: { compatibility: 'passed', privacy: 'passed', safety: 'passed', rollback: 'passed', accountAccess: 'passed' },
    contractTests: 40, failedTests: 0, criticalFailures: 0, costRatio: 1, p95LatencyRatio: 0.8, artifactSha256: 'd'.repeat(64), contract: 'higgsfield-soul-text-image-v1',
    quality: { heldOut: true, blinded: true, referenceChecked: true, samples: 100, lowerBound: 0.01, segments: pins.models.find(p => p.key === 'higgsfield-image').requiredSegments.map(id => ({ id, samples: 100, lowerBound: 0.01 })) } };
  const input = () => ({ registry, pins, eventKey, evaluationKey, commit, now, envelope: { event, eventSignature: sign(event, eventKey), evidence, evidenceSignature: sign(evidence, evaluationKey) } });
  return { event, evidence, input };
}
test('qualified signed event is accepted without a polling or model request', () => {
  const f = fixture(); assert.equal(validateRelease(f.input()).event.version, f.event.version);
  assert.equal(registry.polling, false); assert.equal(registry.providers.length, 21);
});
test('forged events, altered evidence, stale commits and unsigned updates fail closed', () => {
  const f = fixture(); const input = f.input(); input.envelope.event.version = 'tampered'; assert.throws(() => validateRelease(input), /signature/);
  const g = fixture(); const altered = g.input(); altered.envelope.evidence.failedTests = 1; assert.throws(() => validateRelease(altered), /signature/);
  const h = fixture(); assert.throws(() => validateRelease({ ...h.input(), commit: 'e'.repeat(40) }), /baseline/);
  assert.throws(() => validateRelease({ ...h.input(), eventKey: undefined }), /signature/);
});
test('inferior quality, missing privacy, higher cost and incompatible adapters block promotion', () => {
  for (const change of [f => f.evidence.quality.lowerBound = -0.01, f => f.evidence.checks.privacy = 'missing', f => f.evidence.costRatio = 1.1,
    f => f.evidence.contract = 'other-schema', f => f.evidence.quality.samples = 99, f => f.evidence.criticalFailures = 1,
    f => f.evidence.quality.segments.pop(), f => f.evidence.quality.segments[0].lowerBound = -0.01]) {
    const f = fixture(); change(f); assert.throws(() => validateRelease(f.input()));
  }
});
test('release origin lookalikes and changes to unconfigured integrations cannot update a model', () => {
  for (const change of [f => f.event.releaseUrl = 'https://docs.higgsfield.ai.evil.test/release', f => f.event.binding = 'payments', f => f.event.provider = 'deepgram']) {
    const f = fixture(); change(f); f.evidence.eventSha256 = sha256(canonical(f.event)); assert.throws(() => validateRelease(f.input()));
  }
});
test('native SDK updates honor the instruction not to build iPhone without a request', () => {
  const f = fixture(); Object.assign(f.event, { provider: 'expo-push', kind: 'sdk', package: 'expo-notifications', version: '1.2.3', releaseUrl: 'https://docs.expo.dev/release' });
  f.evidence.eventSha256 = sha256(canonical(f.event)); assert.throws(() => validateRelease(f.input()), /native_build_not_authorized/);
});
test('a qualified model update retains the previous version and signed evaluation receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portava-provider-update-'));
  const path = join(root, 'artifacts/api-server/src/config/providerVersions.json');
  try {
    await mkdir(dirname(path), { recursive: true }); await mkdir(join(root, 'config'));
    await writeFile(path, JSON.stringify(pins)); await writeFile(join(root, 'config/external-integrations.json'), JSON.stringify(registry));
    const f = fixture(); const result = await applyRelease(root, f.input());
    assert.equal(result.status, 'candidate_prepared');
    const next = JSON.parse(await readFile(path, 'utf8'));
    const binding = next.models.find(p => p.key === f.event.binding);
    assert.equal(binding.current, f.event.version); assert.ok(binding.history.includes(f.event.previous));
    assert.equal(binding.receipt.evaluationSha256, sha256(canonical(f.evidence)));
    assert.deepEqual(next.models.filter(p => p.key !== f.event.binding), pins.models.filter(p => p.key !== f.event.binding));
    await assert.rejects(applyRelease(root, f.input()), /stale_evaluation_baseline/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('new workflows and app status subscriptions do not install scheduled polling', async () => {
  const workflow = await readFile(new URL('../.github/workflows/provider-release-events.yml', import.meta.url), 'utf8');
  const screen = await readFile(new URL('../travel-buddy-standalone/app/create-ai.tsx', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../artifacts/api-server/src/lib/media/generation/worker.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /schedule:|cron:/); assert.doesNotMatch(screen, /setInterval/); assert.doesNotMatch(worker, /setInterval/);
  assert.match(worker, /"BLOCK", 0/); assert.match(screen, /subscribeGenerationDrafts/);
});

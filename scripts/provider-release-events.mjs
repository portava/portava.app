import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pinsPath = 'artifacts/api-server/src/config/providerVersions.json';
const packagePaths = ['artifacts/api-server/package.json', 'travel-buddy-standalone/package.json', 'tools/media-worker/package.json'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function sign(value, key) { return createHmac('sha256', key).update(canonical(value)).digest('hex'); }
function verified(value, signature, key) {
  if (typeof key !== 'string' || key.length < 32 || !/^[a-f0-9]{64}$/.test(signature ?? '')) return false;
  return timingSafeEqual(Buffer.from(sign(value, key), 'hex'), Buffer.from(signature, 'hex'));
}
const requireCondition = (condition, reason) => { if (!condition) throw new Error(reason); };

/** Input is a push event from an authenticated release relay, plus a separately
 * signed evaluation receipt. Release announcements alone NEVER select a model. */
export function validateRelease({ envelope, registry, pins, eventKey, evaluationKey, commit, now = Date.now() }) {
  const { event, eventSignature, evidence, evidenceSignature } = envelope ?? {};
  requireCondition(eventKey !== evaluationKey, 'separate_signing_keys_required');
  requireCondition(verified(event, eventSignature, eventKey), 'release_signature_invalid');
  requireCondition(verified(evidence, evidenceSignature, evaluationKey), 'evaluation_signature_invalid');
  const provider = registry.providers.find(p => p.id === event.provider);
  requireCondition(provider && ['model', 'sdk', 'contract'].includes(event.kind), 'unknown_provider_or_kind');
  requireCondition(typeof event.id === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(event.id), 'invalid_event_id');
  requireCondition(Number.isFinite(Date.parse(event.publishedAt)) && Date.parse(event.publishedAt) <= now && now - Date.parse(event.publishedAt) <= 30 * 86400000, 'stale_release_event');
  const url = new URL(event.releaseUrl);
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.hash && provider.origins.some(base => url.href === base || url.href.startsWith(`${base}/`) || url.href.startsWith(`${base}?`)), 'untrusted_release_source');
  requireCondition(evidence.schemaVersion === 1 && evidence.kind === 'live' && evidence.eventSha256 === sha256(canonical(event)), 'evidence_not_bound_to_event');
  requireCondition(evidence.commit === commit && /^[a-f0-9]{40}$/.test(commit ?? '') && evidence.pinsSha256 === sha256(canonical(pins)), 'stale_evaluation_baseline');
  requireCondition(Number.isFinite(Date.parse(evidence.completedAt)) && Date.parse(evidence.completedAt) <= now && now - Date.parse(evidence.completedAt) <= 7 * 86400000, 'stale_evaluation');
  requireCondition(['compatibility', 'privacy', 'safety', 'rollback', 'accountAccess'].every(key => evidence.checks?.[key] === 'passed'), 'required_checks_incomplete');
  requireCondition(Number.isInteger(evidence.contractTests) && evidence.contractTests > 0 && evidence.failedTests === 0 && evidence.criticalFailures === 0, 'contract_regression');
  requireCondition(Number.isFinite(evidence.costRatio) && evidence.costRatio > 0 && evidence.costRatio <= 1 && Number.isFinite(evidence.p95LatencyRatio) && evidence.p95LatencyRatio > 0 && evidence.p95LatencyRatio <= 1, 'cost_or_latency_regression');
  requireCondition(typeof evidence.artifactSha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.artifactSha256), 'evaluation_artifact_missing');
  if (event.kind === 'model') {
    const binding = pins.models.find(pin => pin.key === event.binding && pin.provider === provider.id);
    requireCondition(binding && provider.models.includes(binding.key) && binding.current === event.previous && binding.contract === evidence.contract, 'model_contract_changed');
    requireCondition(typeof event.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,150}$/.test(event.version) && !event.version.includes('..') && !event.version.includes('//') && event.version !== event.previous, 'invalid_model_version');
    requireCondition(evidence.quality?.heldOut === true && evidence.quality?.blinded === true && evidence.quality?.referenceChecked === true && evidence.quality?.samples >= 100 &&
      Number.isFinite(evidence.quality?.lowerBound) && evidence.quality.lowerBound >= 0 && Array.isArray(evidence.quality?.segments) && evidence.quality.segments.length > 0 &&
      evidence.quality.segments.every(segment => typeof segment.id === 'string' && segment.samples >= 30 && Number.isFinite(segment.lowerBound) && segment.lowerBound >= 0), 'model_quality_not_established');
    requireCondition(Array.isArray(binding.requiredSegments) && binding.requiredSegments.length > 0 && binding.requiredSegments.every(required => evidence.quality.segments.some(segment => segment.id === required)), 'required_quality_segments_missing');
  } else if (event.kind === 'sdk') {
    requireCondition(provider.sdk.includes(event.package) && /^\d+\.\d+\.\d+$/.test(event.version), 'unsupported_sdk_release');
    requireCondition(!/react-native|expo-/.test(event.package), 'native_build_not_authorized');
  }
  return { event, evidence, provider };
}

export async function applyRelease(root, input) {
  const registry = JSON.parse(await readFile(resolve(root, 'config/external-integrations.json'), 'utf8'));
  const pins = JSON.parse(await readFile(resolve(root, pinsPath), 'utf8'));
  const validated = validateRelease({ ...input, registry, pins });
  const { event, evidence } = validated;
  if (event.kind === 'contract') return { status: 'adapter_migration_required', provider: event.provider, changedFiles: [] };
  const changedFiles = [];
  if (event.kind === 'model') {
    const binding = pins.models.find(pin => pin.key === event.binding);
    binding.history = [...new Set([...binding.history, binding.current])];
    binding.current = event.version;
    binding.receipt = { eventId: event.id, evaluationSha256: sha256(canonical(evidence)), artifactSha256: evidence.artifactSha256, promotedAt: new Date().toISOString() };
    await writeFile(resolve(root, pinsPath), `${JSON.stringify(pins, null, 2)}\n`); changedFiles.push(pinsPath);
  } else {
    const updates = [];
    for (const path of packagePaths) {
      const pkg = JSON.parse(await readFile(resolve(root, path), 'utf8'));
      if (!pkg.dependencies?.[event.package]) continue;
      requireCondition(pkg.dependencies[event.package] === event.previous, 'sdk_baseline_changed');
      pkg.dependencies[event.package] = event.version;
      updates.push([path, pkg]);
    }
    requireCondition(updates.length > 0, 'sdk_not_installed');
    for (const [path, pkg] of updates) { await writeFile(resolve(root, path), `${JSON.stringify(pkg, null, 2)}\n`); changedFiles.push(path); }
  }
  return { status: 'candidate_prepared', provider: event.provider, version: event.version, eventId: event.id, changedFiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const github = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH ?? process.argv[2], 'utf8'));
    const result = await applyRelease(root, { envelope: github.client_payload ?? github, eventKey: process.env.PROVIDER_RELEASE_EVENT_SECRET,
      evaluationKey: process.env.PROVIDER_EVALUATION_SECRET, commit: process.env.GITHUB_SHA });
    await writeFile(resolve(root, 'provider-update-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
    if (result.status !== 'candidate_prepared') process.exitCode = 2;
  } catch (error) { console.error(JSON.stringify({ status: 'blocked', reason: error instanceof Error ? error.message : 'invalid_release_event' })); process.exitCode = 2; }
}

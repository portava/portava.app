import { createHash } from 'node:crypto';

// Scores are reference-checked or blindly adjudicated, normalized to [0, 1]
// (higher is better). Integration tests are not provider quality evidence.
export const PROVIDER_PROFILES = Object.freeze({
  captions: ['transcription', 'timing', 'language', 'faithfulness'],
  image_understanding: ['precision', 'recall', 'abstention', 'privacy'],
  visual_search: ['relevance', 'recall', 'visibility', 'deletion'],
  input_and_compass: ['relevance', 'grounding', 'instruction_following', 'language', 'tool_correctness'],
  image_generation: ['prompt_adherence', 'visual_quality', 'safety'],
  places: ['coverage', 'freshness', 'accuracy', 'attribution'],
  geocoding: ['coverage', 'location_accuracy', 'language'],
  routing: ['route_validity', 'travel_time_accuracy', 'coverage'],
  calls: ['connection', 'audio_quality', 'video_quality', 'recovery'],
  platform: ['data_integrity', 'auth_isolation', 'storage', 'recovery'],
  cache: ['consistency', 'expiry', 'recovery'],
  observability: ['capture', 'grouping', 'alerting', 'recovery'],
  weather: ['coverage', 'freshness', 'accuracy'],
  events: ['coverage', 'freshness', 'accuracy', 'rights'],
});

const DAY = 86400000;
const EPSILON = 1e-12;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/@+-]{1,120}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value));
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hashParityPolicy = policy => createHash('sha256').update(JSON.stringify(canonical(policy))).digest('hex');
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];

function check(condition, reason) { if (!condition) throw new Error(reason); }
function identity(provider) {
  return object(provider) && name(provider.id) && name(provider.revision)
    && !/^(latest|main|master|beta)$/i.test(provider.revision)
    && sha(provider.configSha256) && sha(provider.runtimeSha256);
}

/**
 * Fail-closed OFFLINE screening, never an instruction to switch a live provider.
 * The input is a signed-off benchmark receipt, not raw user media or prompts.
 * A passing empirical comparison still needs load/canary/recovery review.
 */
export function evaluateProviderParity(policy, evidence, { now = Date.now() } = {}) {
  const blockers = [];
  const comparisons = [];
  const blocked = () => ({ schemaVersion: 1, status: 'blocked', eligibleForReplacement: false, blockers, comparisons });
  try {
    check(object(policy) && policy.schemaVersion === 1 && Object.hasOwn(PROVIDER_PROFILES, policy.profile), 'invalid_policy');
    check(timestamp(policy.registeredAt) && Date.parse(policy.registeredAt) <= now, 'invalid_registration_time');
    check(sha(policy.datasetSha256) && policy.heldOut === true, 'held_out_dataset_required');
    check(Array.isArray(policy.requiredSegments) && policy.requiredSegments.length > 0 && policy.requiredSegments.length <= 100
      && policy.requiredSegments.every(name) && new Set(policy.requiredSegments).size === policy.requiredSegments.length, 'invalid_required_segments');
    check(Array.isArray(policy.cases) && policy.cases.length >= 100 && policy.cases.length <= 50000, 'insufficient_or_excessive_cases');
    const cases = new Map(); const hashes = new Set();
    for (const row of policy.cases) {
      check(object(row) && name(row.caseId) && sha(row.inputSha256) && !cases.has(row.caseId) && !hashes.has(row.inputSha256), 'invalid_or_duplicate_case');
      check(Array.isArray(row.segments) && row.segments.length > 0 && row.segments.every(segment => policy.requiredSegments.includes(segment))
        && new Set(row.segments).size === row.segments.length, 'invalid_case_segments');
      cases.set(row.caseId, row); hashes.add(row.inputSha256);
    }
    for (const segment of policy.requiredSegments) {
      check(policy.cases.filter(row => row.segments.includes(segment)).length >= 30, 'insufficient_segment_coverage');
    }
    check(object(evidence) && evidence.schemaVersion === 1 && evidence.kind === 'live', 'live_evidence_required');
    check(evidence.policySha256 === hashParityPolicy(policy) && evidence.datasetSha256 === policy.datasetSha256, 'policy_or_dataset_mismatch');
    check(timestamp(evidence.startedAt) && timestamp(evidence.completedAt)
      && Date.parse(evidence.startedAt) > Date.parse(policy.registeredAt)
      && Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt)
      && Date.parse(evidence.completedAt) <= now && now - Date.parse(evidence.startedAt) <= 30 * DAY, 'stale_or_invalid_run_time');
    check(identity(evidence.baseline) && identity(evidence.candidate), 'pinned_provider_identity_required');
    check(evidence.candidate.hosting === 'in_house', 'in_house_candidate_required');
    check(object(evidence.candidate.licenseReview) && evidence.candidate.licenseReview.approved === true
      && name(evidence.candidate.licenseReview.id), 'license_review_required');
    check(object(evidence.review) && evidence.review.blinded === true && name(evidence.review.id)
      && evidence.review.referenceChecked === true && timestamp(evidence.review.completedAt)
      && Date.parse(evidence.review.completedAt) >= Date.parse(evidence.completedAt)
      && Date.parse(evidence.review.completedAt) <= now, 'blind_reference_review_required');
    check(Array.isArray(evidence.pairs) && evidence.pairs.length === cases.size, 'missing_or_extra_pairs');
    const seen = new Set();
    const dimensions = PROVIDER_PROFILES[policy.profile];
    for (const pair of evidence.pairs) {
      check(object(pair) && cases.has(pair.caseId) && !seen.has(pair.caseId)
        && pair.inputSha256 === cases.get(pair.caseId).inputSha256, 'unpaired_or_duplicate_input');
      seen.add(pair.caseId);
      for (const side of ['baseline', 'candidate']) {
        const result = pair[side];
        check(object(result) && typeof result.ok === 'boolean' && Number.isFinite(result.latencyMs) && result.latencyMs > 0
          && Number.isInteger(result.criticalFailures) && result.criticalFailures >= 0 && sha(result.outputSha256), 'invalid_execution_result');
        check(object(result.quality) && Object.keys(result.quality).length === dimensions.length
          && dimensions.every(key => unit(result.quality[key])), 'missing_or_invalid_quality_dimension');
        // Never omit errors/timeouts or judge only successful responses.
        check(result.ok || dimensions.every(key => result.quality[key] === 0), 'failed_request_must_score_zero');
      }
      if (pair.baseline.criticalFailures || pair.candidate.criticalFailures) blockers.push('critical_failure_requires_review');
    }
    for (const segment of [null, ...policy.requiredSegments]) {
      const pairs = evidence.pairs.filter(pair => segment === null || cases.get(pair.caseId).segments.includes(segment));
      const label = segment ?? 'overall';
      const baselineAvailability = mean(pairs.map(pair => Number(pair.baseline.ok)));
      const candidateAvailability = mean(pairs.map(pair => Number(pair.candidate.ok)));
      const baselineP95 = p95(pairs.map(pair => pair.baseline.latencyMs));
      const candidateP95 = p95(pairs.map(pair => pair.candidate.latencyMs));
      if (candidateAvailability + EPSILON < baselineAvailability) blockers.push(`${label}:availability_regression`);
      if (candidateP95 > baselineP95 + EPSILON) blockers.push(`${label}:latency_regression`);
      const quality = {};
      for (const dimension of dimensions) {
        const baseline = mean(pairs.map(pair => pair.baseline.quality[dimension]));
        const candidate = mean(pairs.map(pair => pair.candidate.quality[dimension]));
        const differences = pairs.map(pair => pair.candidate.quality[dimension] - pair.baseline.quality[dimension]);
        const difference = mean(differences);
        const variance = differences.reduce((sum, value) => sum + (value - difference) ** 2, 0) / (differences.length - 1);
        // Descriptive paired uncertainty screen, NOT a family-wise statistical
        // proof of equivalence. Reviewers must examine power and representativeness.
        const lower95Approx = difference - 1.645 * Math.sqrt(variance / differences.length);
        quality[dimension] = { baseline, candidate, difference, lower95Approx };
        if (difference < -EPSILON) blockers.push(`${label}:${dimension}:quality_regression`);
        else if (lower95Approx < -EPSILON) blockers.push(`${label}:${dimension}:uncertain_parity`);
      }
      comparisons.push({ segment: label, count: pairs.length, availability: { baseline: baselineAvailability, candidate: candidateAvailability },
        latencyP95Ms: { baseline: baselineP95, candidate: candidateP95 }, quality });
    }
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : 'invalid_evidence');
  }
  if (blockers.length) { blockers.splice(0, blockers.length, ...new Set(blockers)); return blocked(); }
  return { schemaVersion: 1, status: 'offline_screen_passed', eligibleForReplacement: false, blockers, comparisons,
    remaining: ['representative_sample_and_power_review', 'production_like_load_and_failure_tests', 'bounded_canary_and_rollback_review'],
    limitation: 'A paired empirical screen is not proof of production equivalence. No routing, flags or provider configuration changed.' };
}

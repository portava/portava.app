/**
 * Offline reference model for docs/compass/intelligence-formulas.md.
 * No runtime imports, network, storage, identity inference or production defaults.
 * Scores are utility indices, NOT probabilities or authority to publish/act.
 */
export const OBJECTIVES = Object.freeze({
  compass: Object.freeze({
    benefits: ["intentFit", "personalFit", "timingFit", "continuity", "actionability"],
    costs: ["travelFriction", "switchingCost"],
  }),
  sensing: Object.freeze({
    benefits: ["decisionRelevance", "informationGain", "novelty", "urgency", "usefulWindow"],
    costs: ["interruptionCost", "samplingCost"],
  }),
  community: Object.freeze({
    benefits: ["evidenceQuality", "decisionRelevance", "freshness", "informationGain", "coverageGain"],
    costs: ["conflict", "duplication"],
  }),
  media: Object.freeze({
    benefits: ["intentFit", "tripFit", "visualUsefulness", "discoveryValue", "socialRelevance"],
    costs: ["repetition", "irrelevance", "staleness"],
  }),
});

const GATES = ["permission", "privacy", "safety", "hardConstraints", "evidenceUse"];
const unit = (n, name) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new TypeError(`${name} must be a finite number in [0, 1]`);
  }
  return n;
};
const nonnegative = (n, name) => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new TypeError(`${name} must be finite and nonnegative`);
  return n;
};

/** Gates are supplied by existing policy owners, never invented by a score.
 * Unknown permission blocks use until verified; false excludes this candidate.
 * A safety pass means "permitted by policy", never "this place is safe". */
export function eligibility(gates = {}) {
  const blocked = [], unknown = [];
  for (const key of GATES) {
    if (gates[key] === false) blocked.push(key);
    else if (gates[key] !== true) unknown.push(key);
  }
  return { status: blocked.length ? "blocked" : unknown.length ? "needs_verification" : "eligible", blocked, unknown };
}

/**
 * U = sum(w * supportedBenefit) - sum(lambda * cost), subject to hard gates.
 * Caller supplies a complete policy; benefit weights must sum to 1.
 * Missing terms are intervals [0,1], not fabricated zero values. Weights are
 * never renormalized around missing evidence: sparse records cannot gain a bonus.
 */
export function evaluateObjective(domain, { gates, benefits = {}, costs = {}, weights }) {
  const shape = OBJECTIVES[domain];
  if (!shape) throw new TypeError("Unknown objective domain");
  const admitted = eligibility(gates);
  if (admitted.status !== "eligible") return { ...admitted, domain, lower: null, upper: null, terms: [], unknownTerms: [] };
  const terms = [], unknownTerms = [];
  let lower = 0, upper = 0, benefitTotal = 0;
  for (const [kind, keys, sign] of [["benefits", shape.benefits, 1], ["costs", shape.costs, -1]]) {
    const values = kind === "benefits" ? benefits : costs;
    for (const key of keys) {
      const weight = unit(weights?.[kind]?.[key], `weight ${key}`);
      if (sign > 0) benefitTotal += weight;
      const value = values[key];
      const missing = value === null || value === undefined;
      if (!missing) unit(value, key);
      if (missing && weight > 0) unknownTerms.push(key);
      const lo = missing ? (sign > 0 ? 0 : -weight) : sign * weight * value;
      const hi = missing ? (sign > 0 ? weight : 0) : sign * weight * value;
      lower += lo;
      upper += hi;
      terms.push({ key, kind, weight, value: missing ? null : value, lower: lo, upper: hi });
    }
  }
  if (Math.abs(benefitTotal - 1) > 1e-9) throw new TypeError("Benefit weights must sum to 1");
  return { ...admitted, domain, lower, upper, terms, unknownTerms };
}

/** Report a robust leader only if its lower bound beats every alternative's
 * upper bound, including an explicitly supplied stay/wait/do-nothing baseline.
 * Overlap is not a failure: gather decision-changing evidence or explain a
 * conditional choice, rather than claiming the ranking is certain. */
export function compareObjectives(candidates) {
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new TypeError("Candidate ids must be unique");
  if (candidates.some(c => typeof c.id !== "string" || !c.id)) throw new TypeError("Candidate ids must be nonempty strings");
  const eligible = candidates.filter(c => c.result.status === "eligible");
  if (!eligible.length) return { status: "no_eligible_candidate", winner: null, contenders: [] };
  const bestLower = Math.max(...eligible.map(c => c.result.lower));
  const contenders = eligible.filter(c => c.result.upper >= bestLower).map(c => c.id);
  const winner = eligible.find(c => eligible.every(other => c.id === other.id || c.result.lower > other.result.upper));
  return winner ? { status: "robust_leader", winner: winner.id, contenders: [winner.id] }
    : { status: "unresolved", winner: null, contenders };
}

/** Claim-family freshness. Hard validity expiry wins over smooth decay.
 * Future observation time is unknown, not fresher-than-live. */
export function evidenceFreshness({ observedAtMs, nowMs, halfLifeMs, validUntilMs }) {
  nonnegative(nowMs, "nowMs");
  if (typeof halfLifeMs !== "number" || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) throw new TypeError("halfLifeMs must be positive");
  if (observedAtMs === null || observedAtMs === undefined || validUntilMs === null || validUntilMs === undefined) return null;
  nonnegative(observedAtMs, "observedAtMs");
  nonnegative(validUntilMs, "validUntilMs");
  if (observedAtMs > nowMs || validUntilMs <= observedAtMs) return null;
  return nowMs >= validUntilMs ? 0 : 2 ** (-(nowMs - observedAtMs) / halfLifeMs);
}

/**
 * Agreement about ONE structured claim in ONE subject/time window.
 * Inputs have already passed the canonical consent/qualification boundary.
 * w = sourceReliability * directness * entityMatch * freshness.
 * Copy-related observations share a window-scoped independence group. Take the
 * strongest weight per side within that group, then cap the whole group's mass
 * at its strongest observation. Unknown independence shares one conservative
 * group. This function does not certify independence, truth class or confidence.
 */
export function aggregateClaimEvidence(reports) {
  const unknownGroup = Symbol("unknown independence");
  const groups = new Map();
  let unknownReports = 0, ignoredReports = 0;
  for (const report of reports) {
    if (report.stance !== "supports" && report.stance !== "opposes") throw new TypeError("Invalid claim stance");
    const factors = ["sourceReliability", "directness", "entityMatch", "freshness"];
    let unknown = false, weight = 1;
    for (const key of factors) {
      const value = report[key];
      if (value === null || value === undefined) unknown = true;
      else weight *= unit(value, key);
    }
    if (unknown) { unknownReports++; continue; }
    if (weight === 0) { ignoredReports++; continue; }
    const key = typeof report.independenceGroup === "string" && report.independenceGroup.trim()
      ? report.independenceGroup : unknownGroup;
    const group = groups.get(key) ?? { supports: 0, opposes: 0 };
    group[report.stance] = Math.max(group[report.stance], weight);
    groups.set(key, group);
  }
  let supportWeight = 0, oppositionWeight = 0;
  for (const group of groups.values()) {
    const cap = Math.max(group.supports, group.opposes);
    const scale = cap / (group.supports + group.opposes);
    supportWeight += group.supports * scale;
    oppositionWeight += group.opposes * scale;
  }
  const total = supportWeight + oppositionWeight;
  return {
    supportWeight, oppositionWeight,
    // Agreement is not a probability that a claim is true.
    supportShare: total > 0 ? supportWeight / total : null,
    conflictShare: total > 0 ? Math.min(supportWeight, oppositionWeight) / total : null,
    knownIndependentGroups: groups.size - (groups.has(unknownGroup) ? 1 : 0),
    independenceUnknown: groups.has(unknownGroup), unknownReports, ignoredReports,
  };
}

/** Offline slate illustration. Existing media owners retain production caps,
 * eligibility, protected-location projection and ordering. Generated fallback
 * is a separate tier; a numerical score cannot buy its way above real imagery. */
export function selectMediaSlate(candidates, { limit, maxPerAuthor, maxPerPlace }) {
  for (const [key, value] of Object.entries({ limit, maxPerAuthor, maxPerPlace })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer`);
  }
  const seen = new Set(), authors = new Map(), places = new Map();
  const ordered = candidates.filter(c => c.result.status === "eligible").map((candidate, index) => ({ ...candidate, index }))
    .sort((a, b) => Number(a.provenance === "synthetic") - Number(b.provenance === "synthetic")
      || b.result.lower - a.result.lower || a.index - b.index);
  const selected = [];
  for (const candidate of ordered) {
    if (seen.has(candidate.id)) continue;
    const author = candidate.authorId || null;
    const place = candidate.placeId || null;
    if ((authors.get(author) ?? 0) >= maxPerAuthor || (places.get(place) ?? 0) >= maxPerPlace) continue;
    selected.push(candidate.id);
    seen.add(candidate.id);
    authors.set(author, (authors.get(author) ?? 0) + 1);
    places.set(place, (places.get(place) ?? 0) + 1);
    if (selected.length === limit) break;
  }
  return selected;
}

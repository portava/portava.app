/**
 * Trips spec §12.3 — minimum-question planning, PURE (census-trips TR220).
 *
 *   "Before asking the traveler, calculate value-of-information. Ask only for
 *    unknown facts capable of materially changing feasibility, authorization,
 *    cost, or recommendation quality. Known low-impact uncertainty remains
 *    represented as uncertainty rather than becoming questionnaire friction."
 *
 * An UNKNOWN is a fact a projection could not establish (an UNCERTAIN
 * experience's hours, an unestimated travel time, a reservation with no
 * price). Its value of information is the chance the answer changes a
 * decision times how much the decision matters. Above the threshold it is
 * a question worth asking, with the question phrased; below it, it stays
 * uncertainty and is said to.
 */

export const VOI_DIMENSIONS = ["feasibility", "authorization", "cost", "recommendation_quality"] as const;
export type VoiDimension = (typeof VOI_DIMENSIONS)[number];

export interface Unknown {
  key: string;
  dimension: VoiDimension;
  /** 0..1: how likely an answer flips the decision (an UNCERTAIN top-scored option: high; a fourth-ranked one: low). */
  probabilityChangesDecision: number;
  /** 0..1: how much the decision matters (a commitment: 1; a coffee: 0.2). */
  stakes: number;
  /** The question to ask if it is worth it. */
  question: string;
  subjectIds?: string[];
}

export interface VoiVerdict {
  key: string;
  value: number;
  ask: boolean;
  question: string | null;
  dimension: VoiDimension;
  representedAs: "question" | "uncertainty";
  subjectIds: string[];
}

export const VOI_ASK_THRESHOLD = 0.25;
/** Never more questions than this per turn: friction is the thing §12.3 forbids. */
export const VOI_MAX_QUESTIONS = 2;

export function valueOfInformation(unknowns: readonly Unknown[], opts: { threshold?: number; maxQuestions?: number } = {}): { ask: VoiVerdict[]; uncertainty: VoiVerdict[] } {
  const threshold = opts.threshold ?? VOI_ASK_THRESHOLD;
  const max = opts.maxQuestions ?? VOI_MAX_QUESTIONS;
  const scored = unknowns.map((u) => {
    const value = Math.round(Math.min(1, Math.max(0, u.probabilityChangesDecision)) * Math.min(1, Math.max(0, u.stakes)) * 1000) / 1000;
    return { key: u.key, value, dimension: u.dimension, question: u.question, subjectIds: [...(u.subjectIds ?? [])] };
  }).sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const ask: VoiVerdict[] = []; const uncertainty: VoiVerdict[] = [];
  for (const s of scored) {
    if (s.value >= threshold && ask.length < max) ask.push({ ...s, ask: true, representedAs: "question" });
    else uncertainty.push({ ...s, ask: false, question: null, representedAs: "uncertainty" });
  }
  return { ask, uncertainty };
}

/**
 * The unknowns an opportunity portfolio carries: each UNCERTAIN experience,
 * with the probability it would change the decision given where it would
 * rank if executable — only one that could beat the current best is worth
 * a question.
 */
export function unknownsFromExperiences(experiences: readonly { id: string; name: string; verdict: string; reasonCodes: readonly string[]; score: number; servesGoalIds: readonly string[] }[]): Unknown[] {
  const best = experiences.filter((e) => e.verdict === "EXECUTABLE").sort((a, b) => b.score - a.score)[0] ?? null;
  const out: Unknown[] = [];
  for (const e of experiences) {
    if (e.verdict !== "UNCERTAIN") continue;
    const stakes = e.servesGoalIds.length > 0 ? 0.7 : 0.4;
    const couldWin = !best || e.servesGoalIds.length > best.servesGoalIds.length || best.score < 0.6;
    const p = couldWin ? 0.6 : 0.15;
    if (e.reasonCodes.includes("EXPERIENCE_HOURS_UNKNOWN")) out.push({ key: `hours:${e.id}`, dimension: "feasibility", probabilityChangesDecision: p, stakes, question: `Do you know when ${e.name} is open today?`, subjectIds: [e.id] });
    if (e.reasonCodes.includes("TRIP_TEMPORAL_UNKNOWN")) out.push({ key: `travel:${e.id}`, dimension: "feasibility", probabilityChangesDecision: p * 0.8, stakes, question: `How would you get to ${e.name}, and how long does that take?`, subjectIds: [e.id] });
    if (e.reasonCodes.includes("TRIP_SPATIAL_NO_COORDINATES")) out.push({ key: `where:${e.id}`, dimension: "feasibility", probabilityChangesDecision: p * 0.8, stakes, question: `Where exactly is ${e.name}?`, subjectIds: [e.id] });
  }
  return out;
}

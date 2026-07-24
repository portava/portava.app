/**
 * Criteria evaluator — Stamp Wave 3.
 *
 * evaluateCriteria(sc, userId, rule, ctx) → { met, reason, checks }
 *
 * - Resolves only referenced metrics, each at most once (memoized).
 * - Fails CLOSED: unknown metric, unknown/missing operator, bad version, or
 *   malformed shape → met=false with a reason. Never throws, never awards on a
 *   shape it doesn't understand.
 * - Pure boolean logic over resolved numbers; no side effects.
 */

import {
  CRITERIA_SCHEMA_VERSION,
  COMPARISON_OPS,
  referencedMetrics,
  isAllGroup,
  isAnyGroup,
  isNotGroup,
  isLeaf,
  type Condition,
  type CriteriaRule,
} from "./schema.js";
import { resolveMetric, isKnownMetric, type EvalContext } from "./metrics.js";

export interface CriteriaCheck {
  metric: string;
  op: string;
  target: number | boolean;
  actual: number;
  passed: boolean;
}

export interface CriteriaResult {
  met: boolean;
  reason: string;
  /** Per-leaf detail, useful for admin debugging and "why not yet" surfaces. */
  checks: CriteriaCheck[];
  /** True when the rule shape itself was invalid (vs simply not satisfied). */
  malformed?: boolean;
}

function compare(actual: number, op: string, target: number): boolean {
  switch (op) {
    case "gte": return actual >= target;
    case "lte": return actual <= target;
    case "gt":  return actual > target;
    case "lt":  return actual < target;
    case "eq":  return actual === target;
    default:    return false;
  }
}

/** Extract the single comparison operator present on a leaf, or null. */
function leafOp(leaf: any): { op: string; target: number } | { op: "is"; target: boolean } | null {
  if (typeof leaf.is === "boolean") return { op: "is", target: leaf.is };
  const present = COMPARISON_OPS.filter((o) => typeof leaf[o] === "number");
  if (present.length !== 1) return null; // exactly one operator required
  return { op: present[0], target: leaf[present[0]] as number };
}

export async function evaluateCriteria(
  sc: any,
  userId: string,
  rule: unknown,
  ctx: EvalContext = {},
): Promise<CriteriaResult> {
  const checks: CriteriaCheck[] = [];

  // ── Validate top-level shape ──
  if (!rule || typeof rule !== "object") {
    return { met: false, reason: "criteria_malformed", checks, malformed: true };
  }
  const r = rule as CriteriaRule;
  if (r.version !== CRITERIA_SCHEMA_VERSION) {
    return { met: false, reason: `criteria_version_unsupported:${(r as any).version}`, checks, malformed: true };
  }

  // Reject references to unknown metrics up front (fail-closed, explicit).
  const metrics = referencedMetrics(rule);
  if (metrics.length === 0) {
    return { met: false, reason: "criteria_empty", checks, malformed: true };
  }
  const unknown = metrics.filter((m) => !isKnownMetric(m));
  if (unknown.length > 0) {
    return { met: false, reason: `criteria_unknown_metric:${unknown.join(",")}`, checks, malformed: true };
  }

  // ── Memoized metric resolution ──
  const cache = new Map<string, number>();
  const value = async (name: string): Promise<number> => {
    if (cache.has(name)) return cache.get(name)!;
    const v = await resolveMetric(sc, userId, name, ctx);
    cache.set(name, v);
    return v;
  };

  let malformed = false;

  const evalLeaf = async (leaf: any): Promise<boolean> => {
    const opInfo = leafOp(leaf);
    if (!opInfo) { malformed = true; return false; }
    const actual = await value(leaf.metric);
    let passed: boolean;
    if (opInfo.op === "is") {
      passed = (actual !== 0) === (opInfo.target as boolean);
    } else {
      passed = compare(actual, opInfo.op, opInfo.target as number);
    }
    checks.push({ metric: leaf.metric, op: opInfo.op, target: opInfo.target, actual, passed });
    return passed;
  };

  const evalCond = async (c: Condition): Promise<boolean> => {
    if (isAllGroup(c)) {
      let ok = true;
      for (const sub of c.all) { if (!(await evalCond(sub))) ok = false; } // resolve all for full checks[]
      return ok;
    }
    if (isAnyGroup(c)) {
      let ok = false;
      for (const sub of c.any) { if (await evalCond(sub)) ok = true; }
      return ok;
    }
    if (isNotGroup(c)) {
      return !(await evalCond(c.not));
    }
    if (isLeaf(c)) {
      return evalLeaf(c);
    }
    malformed = true;
    return false;
  };

  // Top-level: a group key wins; otherwise treat the object itself as a leaf.
  let met: boolean;
  if (r.all !== undefined || r.any !== undefined || r.not !== undefined) {
    met = await evalCond(rule as Condition);
  } else {
    met = await evalLeaf(rule);
  }

  if (malformed) {
    return { met: false, reason: "criteria_malformed", checks, malformed: true };
  }
  return { met, reason: met ? "criteria_met" : "criteria_not_met", checks };
}

/**
 * Convenience: true only when the rule is present AND satisfied. A null/absent
 * rule returns { applicable: false } so callers can distinguish "no criteria
 * authored" (fall back to legacy behavior) from "criteria not met".
 */
export async function evaluateIfPresent(
  sc: any,
  userId: string,
  rule: unknown,
  ctx: EvalContext = {},
): Promise<{ applicable: boolean; result?: CriteriaResult }> {
  if (rule === null || rule === undefined) return { applicable: false };
  const result = await evaluateCriteria(sc, userId, rule, ctx);
  return { applicable: true, result };
}

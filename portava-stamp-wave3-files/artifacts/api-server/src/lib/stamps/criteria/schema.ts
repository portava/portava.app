/**
 * Stamp criteria rule schema — Stamp Wave 3.
 *
 * The `stamp_definitions.criteria` jsonb column has existed since 0081 but was
 * never evaluated: every unlock threshold lived hard-coded at ~30 award sites.
 * This is the versioned, machine-readable rule format the evaluator reads, so
 * new stamps (and event-category variants) become authorable as DATA.
 *
 * Shape (version 1):
 *
 *   Leaf condition — compares a resolved metric to a number:
 *     { "metric": "trips_completed", "gte": 5 }
 *     operators: gte | lte | gt | lt | eq
 *
 *   Boolean condition — resolves a boolean metric (usually from context):
 *     { "metric": "is_solo_trip", "is": true }
 *
 *   Groups (compose conditions):
 *     { "all": [ <cond>, ... ] }   — AND (every condition must hold)
 *     { "any": [ <cond>, ... ] }   — OR  (at least one holds)
 *     { "not": <cond> }            — negation
 *
 *   Top-level object carries the version and exactly one condition/group:
 *     { "version": 1, "all": [ { "metric": "followers_count", "gte": 50 } ] }
 *     { "version": 1, "metric": "trips_completed", "gte": 10 }   // single leaf
 *
 * Design rules:
 *   - Unknown metric, unknown operator, or malformed criteria → the evaluator
 *     fails CLOSED (not met) with a reason; it never throws and never awards on
 *     a shape it does not understand.
 *   - The evaluator resolves only the metrics a criteria actually references
 *     (lazy), each at most once (memoized per evaluation).
 */

export const CRITERIA_SCHEMA_VERSION = 1;

export type ComparisonOp = "gte" | "lte" | "gt" | "lt" | "eq";
export const COMPARISON_OPS: ComparisonOp[] = ["gte", "lte", "gt", "lt", "eq"];

export interface LeafCondition {
  metric: string;
  gte?: number;
  lte?: number;
  gt?: number;
  lt?: number;
  eq?: number;
  is?: boolean;
}

export interface AllGroup { all: Condition[] }
export interface AnyGroup { any: Condition[] }
export interface NotGroup { not: Condition }

export type Condition = LeafCondition | AllGroup | AnyGroup | NotGroup;

export interface CriteriaRule {
  version: number;
  all?: Condition[];
  any?: Condition[];
  not?: Condition;
  metric?: string;
  gte?: number;
  lte?: number;
  gt?: number;
  lt?: number;
  eq?: number;
  is?: boolean;
}

export function isAllGroup(c: any): c is AllGroup {
  return c && typeof c === "object" && Array.isArray(c.all);
}
export function isAnyGroup(c: any): c is AnyGroup {
  return c && typeof c === "object" && Array.isArray(c.any);
}
export function isNotGroup(c: any): c is NotGroup {
  return c && typeof c === "object" && c.not !== undefined && !Array.isArray(c.not);
}
export function isLeaf(c: any): c is LeafCondition {
  return c && typeof c === "object" && typeof c.metric === "string";
}

/**
 * Collect every metric name referenced by a criteria rule (deduped) so the
 * evaluator can resolve exactly what it needs. Returns [] for malformed input.
 */
export function referencedMetrics(rule: unknown): string[] {
  const out = new Set<string>();
  const walk = (c: any): void => {
    if (!c || typeof c !== "object") return;
    if (Array.isArray(c.all)) { c.all.forEach(walk); return; }
    if (Array.isArray(c.any)) { c.any.forEach(walk); return; }
    if (c.not !== undefined) { walk(c.not); return; }
    if (typeof c.metric === "string") out.add(c.metric);
  };
  walk(rule);
  return [...out];
}

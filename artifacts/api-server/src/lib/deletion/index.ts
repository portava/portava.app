/**
 * The deletion dependency graph, assembled from the committed baseline and this
 * checkout's source tree.
 *
 * `deletionGraph()` memoises: building it parses a 38k-line dump and walks the
 * source tree, which is cheap once and wasteful per call.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POST_BASELINE_TABLES } from "../deletionDispositions.js";
import { buildDeletionGraph, candidateCounts } from "./graph.js";
import { scanCodeUsage, scanRetentionRpcs } from "./codeFacts.js";
import { classifyUserLinks, userLinkCounts, type UserLinkCounts } from "./userLink.js";
import type { DeletionGraphNode, UserLinkFact } from "./types.js";

export * from "./types.js";
export { buildDeletionGraph, candidateCounts, classifyExposure, graphUserLinkCounts, assertDenominatorNotShrunk } from "./graph.js";
export {
  classifyUserLinks, userLinkCounts, manuallyRegisteredTables, isOwnershipPreserving,
  INDIRECT_OWNERSHIP_RULE, USER_ROOT_REFERENCES, USER_ROOT_TABLES, USER_NAME_HINT_RE,
  type UserLinkCounts, type UserLinkInput,
} from "./userLink.js";
export { parseSchemaFacts, statements } from "./schemaFacts.js";
export { scanCodeUsage, scanRetentionRpcs } from "./codeFacts.js";
export { classifyCandidate } from "./candidateClass.js";
export { FIELD_PROVENANCE } from "./provenance.js";
export { SIGNAL_RULES, COLUMN_ROLES } from "./signalRules.js";
export { HAND_NOTES } from "./handNotes.js";

const __dir = dirname(fileURLToPath(import.meta.url));
/** api-server package root. */
export const REPO_ROOT = resolve(__dir, "../../..");
export const BASELINE_SQL_PATH = resolve(REPO_ROOT, "baseline/20260819_baseline_structure.sql");

let cached: DeletionGraphNode[] | null = null;

export function deletionGraph(): DeletionGraphNode[] {
  if (cached) return cached;
  cached = buildDeletionGraph({
    sql: readFileSync(BASELINE_SQL_PATH, "utf8"),
    code: scanCodeUsage(REPO_ROOT),
    retentionRpcs: scanRetentionRpcs(REPO_ROOT),
    extraTables: POST_BASELINE_TABLES,
  });
  return cached;
}

/** Test seam: drop the memoised graph. */
export function _resetDeletionGraphCache(): void {
  cached = null;
  cachedLinks = null;
}

export function graphNode(table: string): DeletionGraphNode | undefined {
  return deletionGraph().find((n) => n.table === table);
}

/**
 * The six headline denominator counts over the committed baseline, plus the
 * per-table reasons. Memoised alongside the graph: the whole point of this
 * artefact is that a reviewer can ask "why is this table in scope?" and get an
 * answer measured from the dump.
 */
let cachedLinks: Map<string, UserLinkFact> | null = null;
export function baselineUserLinks(): Map<string, UserLinkFact> {
  if (!cachedLinks) {
    cachedLinks = classifyUserLinks({
      sql: readFileSync(BASELINE_SQL_PATH, "utf8"),
      extraTables: POST_BASELINE_TABLES,
    });
  }
  return cachedLinks;
}

export function baselineUserLinkCounts(): UserLinkCounts {
  return userLinkCounts(baselineUserLinks());
}

export { candidateCounts as deletionCandidateCounts };

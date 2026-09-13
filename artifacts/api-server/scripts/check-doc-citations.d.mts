// Type surface for check-doc-citations.mjs, so the node:test suite can drive
// the REAL checker rather than a re-implementation of it. Same shape as the
// existing src/lib/ciSupabaseGuard.d.mts / ciProdReadOnlyAuditGuard.d.mts
// sibling-declaration pattern.

export interface CoveredEntry {
  dir?: string;
  file?: string;
}

export interface Citation {
  file: string;
  spec: string;
  anchor: string | undefined;
  line: number;
  inherited: boolean;
}

export interface Orphan {
  line: number;
  spec: string;
}

export interface Finding {
  doc: string;
  line: number;
  cited: string;
  reason?: string;
  detail?: string;
}

export interface EvaluationResult {
  badRange: Finding[];
  badAnchor: Finding[];
  ambiguous: Finding[];
  /** Anchored citations whose anchor holds in two or more candidate files, so nothing decides which file was meant. Ratcheted at zero. */
  undecidable: Finding[];
  /** Backticked citations whose WHOLE anchor is not at the cited line. */
  badFullAnchor: Finding[];
  /** Citations in a shape no pass can bind — a bare `:NNN#anchor` whose anchor contains a space. */
  unbindable: Finding[];
  orphans: Array<Orphan & { doc: string }>;
  total: number;
  anchored: number;
  /** Of `anchored`, those written in backticks, so the anchor has an unambiguous end. */
  fullAnchored: number;
}

export const COVERED: CoveredEntry[];
export const MIN_ANCHORED_CITATIONS: number;
/** SHRINK-ONLY floor on backticked citations whose WHOLE anchor is re-read. */
export const MIN_FULL_ANCHOR_CITATIONS: number;
/** GROW-NEVER ceiling on bare `path:line` citations — the class nothing can verify. */
export const MAX_UNANCHORED_CITATIONS: number;
/** Directories the walker never enters — `.git`, `node_modules`, and `.claude` (agent worktrees carry stale copies of every cited file). Shared with src/test/docCitations.test.ts. */
export const SKIP_DIRS: Set<string>;

export function expandLineSpec(spec: string): {
  max: number;
  ranges: Array<[number, number]>;
};

export function extractCitations(text: string): {
  citations: Citation[];
  orphans: Orphan[];
};

export function anchorHolds(
  fileLines: string[],
  ranges: Array<[number, number]>,
  needle: string,
): boolean;

export function resolveCitationPath(
  citedPath: string,
  byBasename: Map<string, string[]>,
  fromDir?: string,
): string[];

export function resolveCoveredFiles(
  root: string,
  covered: CoveredEntry[],
): { files: string[]; missing: string[] };

export function evaluateCitations(args: {
  coveredFiles: string[];
  readFile: (rel: string) => string | null;
  byBasename: Map<string, string[]>;
}): EvaluationResult;

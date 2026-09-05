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
  orphans: Array<Orphan & { doc: string }>;
  total: number;
  anchored: number;
}

export const COVERED: CoveredEntry[];
export const MIN_ANCHORED_CITATIONS: number;

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

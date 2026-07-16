/**
 * Pure state helpers for the admin Schema Drift screen.
 * Mirrors the featureFlags.machine pattern: keep fetch-result → state
 * transitions pure and testable outside React.
 */

export interface MissingColumn {
  table: string;
  column: string;
  migration: string;
  impact: string;
}

export interface MissingFunction {
  fn: string;
  migration: string;
  impact: string;
}

export interface SchemaDriftReport {
  status: 'ok' | 'drift';
  missingColumns: MissingColumn[];
  missingFunctions: MissingFunction[];
  checkedAt: string;
  cached: boolean;
}

export interface LoadResult {
  report: SchemaDriftReport | null;
  error: string | null;
}

/**
 * Map an adminGet-style result into screen state.
 * Unexpected shapes are treated as errors instead of rendering a bogus "OK".
 */
export function applyDriftLoadResult(res: {
  ok: boolean;
  data?: unknown;
  error?: string;
}): LoadResult {
  if (!res.ok) {
    return { report: null, error: res.error ?? 'Failed to load schema status' };
  }
  const d = res.data as Partial<SchemaDriftReport> | undefined;
  if (
    !d ||
    (d.status !== 'ok' && d.status !== 'drift') ||
    !Array.isArray(d.missingColumns) ||
    !Array.isArray(d.missingFunctions)
  ) {
    return { report: null, error: 'Unexpected response from server' };
  }
  return {
    report: {
      status: d.status,
      missingColumns: d.missingColumns,
      missingFunctions: d.missingFunctions,
      checkedAt: typeof d.checkedAt === 'string' ? d.checkedAt : '',
      cached: d.cached === true,
    },
    error: null,
  };
}

/** Total count of drifted objects in a report. */
export function driftCount(report: SchemaDriftReport): number {
  return report.missingColumns.length + report.missingFunctions.length;
}

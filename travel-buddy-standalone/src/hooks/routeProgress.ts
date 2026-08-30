/**
 * Pure route-progress derivation for useRoutePlan.
 *
 * Extracted so the derived-state math (completedCount / progressFraction /
 * nextStop) can be unit-tested without a React renderer. useRoutePlan imports
 * deriveRouteProgress from here, so the test binds to the shipped logic rather
 * than a hand-copied mirror.
 */

export interface ProgressStop {
  checkpointStatus: string;
}

export interface RouteProgress<T> {
  completedCount: number;
  totalCount: number;
  progressFraction: number;
  nextStop: T | null;
}

export function deriveRouteProgress<T extends ProgressStop>(
  stops: readonly T[],
): RouteProgress<T> {
  const completedCount   = stops.filter((s) => s.checkpointStatus === 'arrived').length;
  const totalCount       = stops.length;
  const progressFraction = totalCount > 0 ? completedCount / totalCount : 0;
  const nextStop         = stops.find((s) => s.checkpointStatus === 'pending') ?? null;
  return { completedCount, totalCount, progressFraction, nextStop };
}

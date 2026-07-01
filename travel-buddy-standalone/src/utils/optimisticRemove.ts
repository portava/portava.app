/**
 * Optimistic-remove helpers with automatic rollback on failure.
 *
 * Two flavours match the two patterns used in this codebase:
 *
 *   withOptimisticRemoveBool — the delete operation returns a boolean.
 *     false  → failure (no throw).  Used by saved.tsx handleDelete.
 *
 *   withOptimisticRemoveThrow — the delete operation throws on failure.
 *     catch  → rollback.  Used by screens calling removeSaved().
 *
 * Both helpers are pure async functions with no React dependency so they
 * can be unit-tested in a plain Node.js environment (node:test + tsx/esm).
 */

export interface OptimisticRemoveOpts<T> {
  target: T;
  getItems: () => T[];
  setItems: (items: T[]) => void;
  match: (item: T, target: T) => boolean;
  onError: (msg: string) => void;
}

export interface OptimisticRemoveBoolOpts<T> extends OptimisticRemoveOpts<T> {
  deleteOp: (target: T) => Promise<boolean>;
  errorMessage?: string;
}

export interface OptimisticRemoveThrowOpts<T> extends OptimisticRemoveOpts<T> {
  deleteOp: (target: T) => Promise<void>;
  errorMessage?: string;
}

/**
 * Boolean-return variant.
 *
 * 1. Captures the current list as a rollback snapshot.
 * 2. Removes the target from the list immediately (optimistic).
 * 3. Calls deleteOp; if it returns false, restores the snapshot and calls onError.
 */
export async function withOptimisticRemoveBool<T>(
  opts: OptimisticRemoveBoolOpts<T>,
): Promise<void> {
  const { target, getItems, setItems, match, deleteOp, onError } = opts;
  const errorMessage = opts.errorMessage ?? "Couldn't delete — please try again.";
  const prev = getItems();
  setItems(prev.filter((item) => !match(item, target)));
  const ok = await deleteOp(target);
  if (!ok) {
    setItems(prev);
    onError(errorMessage);
  }
}

/**
 * Throw-based variant.
 *
 * 1. Captures the current list as a rollback snapshot.
 * 2. Removes the target from the list immediately (optimistic).
 * 3. Awaits deleteOp; if it throws, restores the snapshot and calls onError.
 *    The error is NOT re-thrown — callers always resolve cleanly.
 */
export async function withOptimisticRemoveThrow<T>(
  opts: OptimisticRemoveThrowOpts<T>,
): Promise<void> {
  const { target, getItems, setItems, match, deleteOp, onError } = opts;
  const errorMessage = opts.errorMessage ?? "Couldn't remove — please try again.";
  const prev = getItems();
  setItems(prev.filter((item) => !match(item, target)));
  try {
    await deleteOp(target);
  } catch {
    setItems(prev);
    onError(errorMessage);
  }
}

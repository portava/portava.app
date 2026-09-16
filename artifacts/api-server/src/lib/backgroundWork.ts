export interface BackgroundWorkLogger {
  error(context: Record<string, unknown>, message: string): void;
}

export interface BackgroundWorkOptions {
  label: string;
  logger?: BackgroundWorkLogger | null;
  logMessage?: string;
  context?: Record<string, unknown>;
}

export interface BackgroundWorkFailure {
  label: string;
  error: unknown;
}

interface TrackingSession {
  inFlight: Set<Promise<void>>;
  failures: BackgroundWorkFailure[];
}

let activeSession: TrackingSession | null = null;

function reportFailure(
  failure: BackgroundWorkFailure,
  options: BackgroundWorkOptions,
  session: TrackingSession | null,
): void {
  try {
    options.logger?.error(
      { ...options.context, err: failure.error, backgroundWork: failure.label },
      options.logMessage ?? "background work failed",
    );
  } catch (loggingError) {
    try {
      console.error("background work failure logger threw", {
        backgroundWork: failure.label,
        error: failure.error,
        loggingError,
      });
    } catch {
      // Failure handling must never create another unhandled rejection.
    }
  }
  session?.failures.push(failure);
}

/**
 * Starts a Promise without extending request latency.
 *
 * Production only attaches rejection handling. Tests explicitly enable tracking
 * so they can await real completion instead of sleeping for an estimated delay.
 */
export function trackBackgroundWork(
  work: PromiseLike<unknown>,
  options: BackgroundWorkOptions,
): void {
  const session = activeSession;
  const observed = Promise.resolve(work)
    .then(() => undefined)
    .catch((error: unknown) => {
      reportFailure({ label: options.label, error }, options, session);
    });

  if (!session) return;

  session.inFlight.add(observed);
  const cleanup = () => session.inFlight.delete(observed);
  observed.then(cleanup, cleanup);
}

export function enableBackgroundWorkTrackingForTests(): void {
  if (activeSession) return;
  activeSession = { inFlight: new Set(), failures: [] };
}

export function disableBackgroundWorkTrackingForTests(): void {
  activeSession = null;
}

/**
 * Waits until the tracker remains empty. The loop also catches work registered
 * by another tracked operation while the first batch is settling.
 */
export async function awaitBackgroundWork(): Promise<void> {
  const session = activeSession;
  if (!session) return;

  while (session.inFlight.size > 0) {
    await Promise.all([...session.inFlight]);
  }

  if (session.failures.length === 0) return;

  const captured = session.failures.splice(0, session.failures.length);
  throw new AggregateError(
    captured.map((failure) => failure.error),
    `Background work failed: ${captured.map((failure) => failure.label).join(", ")}`,
  );
}
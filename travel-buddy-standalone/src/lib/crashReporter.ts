/**
 * crashReporter — structured crash capture for ErrorBoundary onError callbacks.
 *
 * This module is the single place to wire in a real crash-reporting service
 * (e.g. Sentry). Until that service is configured, crashes are written to the
 * structured console so they appear in EAS build logs and device log streams.
 *
 * HOW TO ADD SENTRY:
 *   1. `pnpm --filter @workspace/travel-buddy add @sentry/react-native`
 *   2. Initialize Sentry once in app/_layout.tsx.
 *   3. Replace the TODO block below with:
 *        import * as Sentry from '@sentry/react-native';
 *        Sentry.withScope(scope => {
 *          if (context.userId) scope.setUser({ id: context.userId });
 *          scope.setExtra('componentStack', componentStack);
 *          Sentry.captureException(error);
 *        });
 */

export interface CrashContext {
  userId?: string;
}

export interface CrashReport {
  timestamp: string;
  errorMessage: string;
  errorStack: string | undefined;
  componentStack: string;
  userId: string | undefined;
}

/**
 * Report a React render error captured by an ErrorBoundary.
 *
 * - In development: logs a detailed object to console.error.
 * - In production: writes a JSON-serialised entry to console.error so it
 *   appears in EAS / device log streams, then hits the TODO hook for a real
 *   reporting service.
 *
 * PRIVACY: only userId (not email, name, or any other PII) is included.
 */
export function reportCrash(
  error: Error,
  componentStack: string,
  context: CrashContext = {},
): void {
  const report: CrashReport = {
    timestamp: new Date().toISOString(),
    errorMessage: error.message,
    errorStack: error.stack,
    componentStack,
    userId: context.userId,
  };

  if (__DEV__) {
    console.error('[CrashReporter]', report);
    return;
  }

  // Production: structured log visible in EAS build logs.
  console.error('[CrashReporter]', JSON.stringify(report));

  // TODO: replace the console.error above with a real service call.
  // See the HOW TO ADD SENTRY section at the top of this file.
}

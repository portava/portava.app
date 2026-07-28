/**
 * crashReporter — structured crash capture for ErrorBoundary onError callbacks.
 *
 * Crash reports are sent to the API server's POST /api/crash-report endpoint,
 * where they are written to the structured server log (visible in EAS device
 * logs and any log aggregator connected to the API server).
 *
 * Crashes are also forwarded to Sentry via Sentry.captureException so that
 * stack traces (with source maps uploaded during EAS builds) are available in
 * the Sentry dashboard without tailing server logs.
 */

import * as Sentry from '@sentry/react-native';

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
 * - In development: logs a detailed object to console.error only.
 * - In production: POSTs to POST /api/crash-report so the error appears in
 *   the API server log, then also writes to console.error for device logs,
 *   and forwards to Sentry with userId and componentStack attached.
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

  // Production: write to device log stream.
  console.error('[CrashReporter]', JSON.stringify(report));

  // Production: forward to Sentry so readable stack traces appear in the
  // Sentry dashboard (source maps uploaded via @sentry/react-native EAS hook).
  Sentry.withScope(scope => {
    if (context.userId) scope.setUser({ id: context.userId });
    scope.setExtra('componentStack', componentStack);
    Sentry.captureException(error);
  });

  // Production: also POST to the API server so crashes appear in server logs
  // and any log aggregator / alerting pipeline connected to the API.
  const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (apiBase) {
    fetch(`${apiBase}/api/crash-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => {
      // Fire-and-forget — never let the reporter itself crash.
    });
  }
}

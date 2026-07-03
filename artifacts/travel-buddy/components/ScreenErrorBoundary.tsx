import React, { useCallback, type PropsWithChildren } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ScreenErrorFallback } from "@/components/ScreenErrorFallback";
import { reportCrash } from "@/src/lib/crashReporter";
import { useSession } from "@/src/context/SessionContext";

/**
 * Per-screen ErrorBoundary with crash reporting pre-wired.
 *
 * Wrap any high-risk screen's inner component with this instead of composing
 * ErrorBoundary + ScreenErrorFallback + onError manually:
 *
 *   function MyScreen() { ... }
 *   export default function MyScreenWrapper() {
 *     return <ScreenErrorBoundary><MyScreen /></ScreenErrorBoundary>;
 *   }
 *
 * When a crash occurs:
 *   - reportCrash() is called with the error, component stack, and the
 *     current user's ID (no email or name — no PII beyond the opaque ID).
 *   - ScreenErrorFallback is shown: "Try Again" remounts only this screen;
 *     "Go Back" navigates away. The tab bar and other screens stay active.
 */
export function ScreenErrorBoundary({ children }: PropsWithChildren) {
  const { userId } = useSession();

  const handleError = useCallback(
    (error: Error, componentStack: string) => {
      reportCrash(error, componentStack, { userId: userId ?? undefined });
    },
    [userId],
  );

  return (
    <ErrorBoundary FallbackComponent={ScreenErrorFallback} onError={handleError}>
      {children}
    </ErrorBoundary>
  );
}

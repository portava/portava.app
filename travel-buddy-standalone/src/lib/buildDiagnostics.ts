/**
 * buildDiagnostics — one line a TEST build shows on the sign-in screen so a
 * report from a phone says which backend it talked to.
 *
 * The first Personal Team build (docs/eas-runbook.md "Local build with a
 * Personal Team") went onto a phone on 2026-11-04 and the report that came back
 * was "i cant log into any of the accounts": no error text, and no way to tell
 * whether the binary had been built against production or beta, or against
 * nothing at all (an empty EXPO_PUBLIC_SUPABASE_URL reads as "Backend not
 * configured"). Those are three different problems with three different fixes.
 *
 * Store builds never show this line: `personalTeam` is recorded by
 * app.config.ts only for the free-team build, and the rule here returns null
 * for everything else. Pure, so node:test covers it; the inlined env reads stay
 * at the call site (src/lib/buildCapabilities.ts), as every EXPO_PUBLIC_* read
 * must.
 */
import { knownDeploymentFor } from './deploymentConsistency.ts';

/** `extra` as app.config.ts recorded it; only an explicit `personalTeam: true` marks the test build. */
export function isPersonalTeamBuildFrom(extra: Record<string, unknown> | null | undefined): boolean {
  return extra?.personalTeam === true;
}

export interface BuildDiagnosticsInput {
  /** `extra.personalTeam` as the binary recorded it; only this build shows the line. */
  personalTeam: boolean;
  supabaseUrl?: string;
  apiBaseUrl?: string;
  version?: string;
}

function hostOf(url: string | undefined): string | null {
  const v = (url ?? '').trim();
  if (!v) return null;
  try {
    return new URL(v).hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

/** The diagnostics line for a test build, or null for every other build. */
export function testBuildDiagnostics(input: BuildDiagnosticsInput): string | null {
  if (!input.personalTeam) return null;
  const deployment = knownDeploymentFor(input.supabaseUrl);
  const supabaseHost = hostOf(input.supabaseUrl);
  const backend = deployment
    ? `${deployment.name} (${deployment.supabaseRef})`
    : supabaseHost
      ? `unknown project at ${supabaseHost}`
      : 'not configured';
  const api = hostOf(input.apiBaseUrl) ?? 'not configured';
  const version = input.version?.trim() ? ` v${input.version.trim()}` : '';
  return `Test build${version} · backend ${backend} · API ${api}`;
}

export interface BrowserSignInClosedInput {
  /** `extra.personalTeam` as the binary recorded it; only this build shows the line. */
  personalTeam: boolean;
  /** "Google": the provider whose browser session ended. */
  provider: string;
  /** How WebBrowser.openAuthSessionAsync said the session ended: 'cancel' or 'dismiss'. */
  outcome: string;
  /** The return address the session was waiting for (travelbuddy://auth/callback on a device). */
  redirectTo: string;
}

/**
 * The line a TEST build shows when a browser sign-in ends without ever
 * returning to the app, or null for every other build.
 *
 * On iOS a redirect the backend refuses (the return address is not on its
 * allow-list) sends the browser to the Site URL instead: the sheet shows the
 * website, the person closes it, and the session ends as 'cancel'. The screen
 * treats a cancel as the person's own choice and shows nothing, which on the
 * first Personal Team build read as "google sign in doesnt work" with no error
 * to report. Store builds keep that silence; a test build names the outcome
 * and the address, so the next report says which of the two it was.
 */
export function testBuildBrowserSignInClosed(input: BrowserSignInClosedInput): string | null {
  if (!input.personalTeam) return null;
  const outcome = input.outcome.trim() || 'cancel';
  return `${input.provider} sign-in closed without returning to the app (browser result: ${outcome}). ` +
    `If the sheet showed the website instead of coming back here, the backend's redirect allow-list is missing ${input.redirectTo}.`;
}

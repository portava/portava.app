/**
 * deploymentConsistency — a build whose database and API belong to different
 * deployments must not run.
 *
 * The app inlines three public addresses at build time (EXPO_PUBLIC_SUPABASE_URL,
 * EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_WEB_ORIGIN). They come from eas.json's
 * build profile and from the EAS environment the profile reads, and Expo does
 * not document which wins for a plain `eas build` (docs/eas-runbook.md
 * § "Private beta build"). A half-overridden build — beta's database with
 * production's API, or the reverse — would send a person's session to one
 * deployment and their data requests to the other. This rule catches that
 * whichever side wins, and the root layout (app/_layout.tsx, at its foot)
 * shows a clear error screen instead of the app.
 *
 *   - Each address is mapped to a KNOWN deployment when it names one
 *     (production: Supabase ref ajrurzioarfkagpuxfnb, host portava.replit.app;
 *     beta: ref emfpckykpzfturllshly, host portava-beta.replit.app). Addresses
 *     that name neither (a dev server, localhost, a test origin) are not judged.
 *   - Two known deployments among the three → refused.
 *   - EXPO_PUBLIC_DEPLOYMENT_ENV (set only by the `beta` profile in eas.json, so
 *     no EAS environment can supply it) demands that every address name that
 *     deployment: a beta build fully overridden to production is refused too.
 *
 * Pure: the caller passes the inlined values (Expo inlines only literal
 * `process.env.EXPO_PUBLIC_*` reads, so the reads stay at the call site).
 */

export interface KnownDeployment {
  name: 'production' | 'beta';
  supabaseRef: string;
  apiHost: string;
}

export const KNOWN_DEPLOYMENTS: readonly KnownDeployment[] = [
  { name: 'production', supabaseRef: 'ajrurzioarfkagpuxfnb', apiHost: 'portava.replit.app' },
  { name: 'beta', supabaseRef: 'emfpckykpzfturllshly', apiHost: 'portava-beta.replit.app' },
];

export interface DeploymentAddresses {
  supabaseUrl?: string;
  apiBaseUrl?: string;
  webOrigin?: string;
  deploymentEnv?: string;
}

/**
 * The project ref of any Supabase URL — `http://` or `https://`, with or without
 * a path, port or trailing slash (verifier N7): the host `<ref>.supabase.co`
 * decides, not the URL's exact spelling. Anything else → null (not judged).
 */
function supabaseRef(url: string | undefined): string | null {
  const host = hostOf(url);
  const m = host ? /^([a-z0-9]+)\.supabase\.co$/.exec(host) : null;
  return m ? m[1] : null;
}

function hostOf(url: string | undefined): string | null {
  const v = (url ?? '').trim();
  if (!v) return null;
  try {
    return new URL(v).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** null when the addresses are consistent; otherwise a sentence for the error screen (no secrets in it). */
export function deploymentConsistencyProblem(a: DeploymentAddresses): string | null {
  const ref = supabaseRef(a.supabaseUrl);
  const apiHost = hostOf(a.apiBaseUrl);
  const webHost = hostOf(a.webOrigin);
  const byRef = KNOWN_DEPLOYMENTS.find((d) => d.supabaseRef === ref)?.name ?? null;
  const byApi = KNOWN_DEPLOYMENTS.find((d) => d.apiHost === apiHost)?.name ?? null;
  const byWeb = KNOWN_DEPLOYMENTS.find((d) => d.apiHost === webHost)?.name ?? null;

  const label = (a.deploymentEnv ?? '').trim();
  if (label) {
    const want = KNOWN_DEPLOYMENTS.find((d) => d.name === label);
    if (!want) return `This build declares an unknown deployment ("${label}").`;
    const wrong = [
      byRef !== want.name ? `its database (${ref ?? 'not a known project'})` : null,
      byApi !== want.name ? `its API (${apiHost ?? 'not set'})` : null,
      webHost !== null && byWeb !== want.name ? `its web origin (${webHost})` : null,
    ].filter(Boolean);
    return wrong.length ? `This is a ${want.name} build, but ${wrong.join(' and ')} ${wrong.length > 1 ? 'are' : 'is'} not ${want.name}'s.` : null;
  }

  const names = new Set([byRef, byApi, byWeb].filter((n): n is KnownDeployment['name'] => n !== null));
  if (names.size > 1) {
    return `This build's database is ${byRef ?? 'unknown'} but its API is ${byApi ?? 'unknown'}${byWeb ? ` and its web origin is ${byWeb}` : ''}.`;
  }
  return null;
}

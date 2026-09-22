/**
 * The refusal vocabulary every provider adapter in this directory answers with.
 *
 * ── THE DEFECT THIS EXISTS TO MAKE UNREPRESENTABLE ───────────────────────────
 * Both of this tree's outbound primitives RESOLVE rather than throw on failure.
 * `fetch` resolves a 500. `supabase-js` resolves a database error, and
 * postgrest-js catches network failures itself and resolves those too. So the
 * natural shape —
 *
 *     const rows = await read();           // resolved, with an error inside
 *     return rows.data ?? [];              // []
 *
 * — turns "we could not find out" into "we found out, and the answer is none".
 * `[]` and `0` and `null` then travel onward as CONFIDENT CLAIMS ABOUT THE
 * WORLD. This repository has been bitten by that repeatedly and has the
 * receipts in its own headers: `expireOldSessions` returning `0` for a sweep
 * that never ran; `getSession` turning an unreadable table into 404 "Session
 * not found"; `listOpenSessions` making a call sweep that could read nothing
 * byte-identical to one with nothing to do.
 *
 * For a travel-time provider the same collapse is worse than a wrong number,
 * because the consumer is a FEASIBILITY decision: an absent route rendered as
 * zero minutes makes every schedule feasible, which is the exact failure the
 * §7 port was built to prevent.
 *
 * So there is no success shape in this file that can be reached by accident. A
 * provider that cannot answer returns a `ProviderRefusal` with a `reason` from
 * a closed set, and the type system gives a consumer nowhere to put it except
 * an explicit branch.
 *
 * ── WHY A CREDENTIAL REFUSAL IS ITS OWN REASON, AND NOT AN OUTAGE ────────────
 * `CREDENTIAL_ABSENT`, `CREDENTIAL_EMPTY` and `PROVIDER_NOT_ENABLED` are three
 * different facts needing three different people:
 *
 *   CREDENTIAL_ABSENT     nobody set the variable. The secret needs creating.
 *   CREDENTIAL_EMPTY      somebody set it TO AN EMPTY STRING. The secret exists,
 *                         appears configured in every list that shows names
 *                         rather than values, and does nothing. This is the
 *                         dangerous one precisely because it looks done.
 *   PROVIDER_NOT_ENABLED  the credential is fine and an operator has not opted
 *                         this deployment in to a BILLABLE call. Not a fault.
 *
 * The first two are `lib/apiKeyState.ts`'s distinction, reused rather than
 * re-derived — that module was written for exactly this and its header argues
 * the case at length. What this file adds is that the distinction survives all
 * the way to the consumer instead of being flattened at the call site.
 *
 * ── NOTHING HERE EVER TOUCHES A KEY VALUE ────────────────────────────────────
 * A refusal names the VARIABLE, never the value. No function in this file
 * accepts, returns, logs or interpolates a secret, and `envVar` is a name. The
 * value is never needed to describe the fault.
 */
import { classifyApiKey, type ApiKeyState } from "../apiKeyState.js";

/**
 * Why a provider could not answer. Closed set, and each member is DISTINCT
 * because each calls for a different action from a different person. Collapsing
 * them into one "unavailable" throws away everything an operator needs.
 */
export const PROVIDER_REFUSAL_REASONS = [
  /** The variable naming this provider's credential is not set at all. */
  "CREDENTIAL_ABSENT",
  /** The variable IS set and its value is empty or whitespace. */
  "CREDENTIAL_EMPTY",
  /**
   * Credentials are fine; this deployment has not opted in. Used where calling
   * the provider spends money, so that turning it on is a deliberate act and
   * never a side effect of a key happening to be present in the environment.
   */
  "PROVIDER_NOT_ENABLED",
  /** No adapter is bound at all — this deployment has no such provider. */
  "PROVIDER_UNBOUND",
  /** The provider was called and failed, timed out, or returned nothing. */
  "PROVIDER_UNAVAILABLE",
  /** The provider answered with something this code cannot interpret. */
  "PROVIDER_MALFORMED",
  /** The provider refused the request itself — auth, quota, or a bad argument. */
  "PROVIDER_REJECTED",
  /** The request was missing something the provider requires. */
  "REQUEST_INCOMPLETE",
  /** A value was found and is past its own expiry. */
  "ANSWER_STALE",
] as const;
export type ProviderRefusalReason = (typeof PROVIDER_REFUSAL_REASONS)[number];

/**
 * A named refusal.
 *
 * `detail` is for an operator and is never a substitute for `reason`: a
 * consumer branches on the reason and shows the detail, never the reverse.
 */
export interface ProviderRefusal {
  ok: false;
  reason: ProviderRefusalReason;
  /** The adapter that refused, for a provenance trail. */
  provider: string;
  detail: string;
  /**
   * The environment variable involved, when the refusal is about one. A NAME,
   * never a value. `null` for refusals that are not about a credential.
   */
  envVar: string | null;
}

/** The success half. Kept generic so every port in this directory shares one shape. */
export interface ProviderAnswer<T> {
  ok: true;
  value: T;
}

export type ProviderResult<T> = ProviderAnswer<T> | ProviderRefusal;

export function answer<T>(value: T): ProviderAnswer<T> {
  return { ok: true, value };
}

export function refuse(
  provider: string,
  reason: ProviderRefusalReason,
  detail: string,
  envVar: string | null = null,
): ProviderRefusal {
  return { ok: false, reason, provider, detail, envVar };
}

/**
 * Classify one credential without ever reading its value into a return.
 *
 * Returns `null` when the credential is usable, and a refusal otherwise. The
 * caller's shape is therefore:
 *
 *     const bad = credentialRefusal("flight-feed", "AERO_API_KEY");
 *     if (bad) return bad;
 *
 * which makes "I forgot to check" a compile error at the point it matters,
 * because the only other way to reach the request below is to have the key.
 *
 * `read` is injectable so a test can prove all three states without mutating
 * `process.env`, which is shared across the whole `--test` process and is how
 * one suite silently changes another's behaviour.
 */
export function credentialRefusal(
  provider: string,
  envVar: string,
  read: (name: string) => string | undefined = (name) => process.env[name],
): ProviderRefusal | null {
  const state: ApiKeyState = classifyApiKey(read(envVar));
  if (state === "present") return null;
  if (state === "absent") {
    return refuse(
      provider,
      "CREDENTIAL_ABSENT",
      `${envVar} is not set in this environment. No request will be attempted. Every ` +
        `call refuses by name rather than returning an empty or default answer, because an ` +
        `absent measurement rendered as a number is indistinguishable from a real one.`,
      envVar,
    );
  }
  return refuse(
    provider,
    "CREDENTIAL_EMPTY",
    `${envVar} IS SET BUT ITS VALUE IS EMPTY. This is not the same as "not configured": the ` +
      `secret exists and appears configured in any list that shows names rather than values, ` +
      `so the fault looks like the code's rather than the configuration's. Set a real value.`,
    envVar,
  );
}

/**
 * The opt-in gate for a provider whose calls cost money.
 *
 * WHY THIS IS SEPARATE FROM THE CREDENTIAL CHECK, and why it is not merely
 * belt-and-braces: several credentials in this tree are shared across products
 * on one vendor account. `GOOGLE_MAPS_API_KEY` is already set wherever Places
 * photos work, and a routing adapter that treated "the key is present" as
 * "routing is wanted here" would start billing the moment it was imported, on
 * every deployment that already had the key, with no code change and no review.
 * `GoogleRoutesTravelTimeProvider`'s header records the near-miss version of
 * this defect: its first cut read the key with `!== undefined` and "a deployment
 * that happened to export GOOGLE_MAPS_API_KEY would have made a billable call
 * on a code path written to make none."
 *
 * So spending is gated on a variable whose ONLY meaning is "an operator decided
 * to spend here". Anything other than an explicit affirmative is off.
 */
export function enablementRefusal(
  provider: string,
  envVar: string,
  read: (name: string) => string | undefined = (name) => process.env[name],
): ProviderRefusal | null {
  const raw = read(envVar);
  const on = typeof raw === "string" && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
  if (on) return null;
  return refuse(
    provider,
    "PROVIDER_NOT_ENABLED",
    `${envVar} is not set to an affirmative value, so ${provider} will not be called. ` +
      `Calls to this provider are billed per request and there is no spend ceiling anywhere ` +
      `in this repository, so enabling it is an owner decision taken deliberately — never a ` +
      `side effect of a credential being present for some other product on the same account.`,
    envVar,
  );
}

/** True when a refusal is about configuration rather than about the provider being unwell. */
export function isConfigurationRefusal(r: ProviderRefusal): boolean {
  return (
    r.reason === "CREDENTIAL_ABSENT" ||
    r.reason === "CREDENTIAL_EMPTY" ||
    r.reason === "PROVIDER_NOT_ENABLED" ||
    r.reason === "PROVIDER_UNBOUND"
  );
}

/**
 * One line an operator can act on, with no secret in it.
 *
 * Deliberately NOT a user-facing string. A traveller is never told which
 * environment variable is unset; the consumer surfaces "we could not check
 * this" and carries the unknown, which is what every consumer of these ports is
 * already obliged to do.
 */
export function describeRefusal(r: ProviderRefusal): string {
  const where = r.envVar ? ` (${r.envVar})` : "";
  return `${r.provider}: ${r.reason}${where} — ${r.detail}`;
}

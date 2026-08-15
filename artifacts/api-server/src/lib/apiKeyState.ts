/**
 * apiKeyState — "nobody configured this" and "somebody configured this to
 * nothing" are different facts, and a falsy check cannot tell them apart.
 *
 * WHY THIS EXISTS
 * ===============
 * `if (!key)` treats an ABSENT variable and a PRESENT-BUT-EMPTY one as the same
 * thing, and both routes here reported the same `no_*_key` reason for each. The
 * two need different actions from different people:
 *
 *   ABSENT           nobody has set it. The secret needs creating.
 *   PRESENT, EMPTY   somebody HAS set it — to an empty string. The secret
 *                    exists in the dashboard, looks configured in every list
 *                    that shows names rather than values, and does nothing.
 *
 * The second is the dangerous one precisely because it looks done. An operator
 * who has just added the secret sees the same failure as before, and the system
 * says "no key" — which reads as "you did not add it", the one thing they know
 * is false. So they doubt the report instead of the value.
 *
 * That is this workstream's governing invariant in a new place: a configured
 * key that is empty produces exactly the evidence of an unconfigured one, and
 * the difference is destroyed at the `!key` check rather than at the source.
 *
 * A THIRD CASE THIS FILE DOES NOT PRETEND TO SEE
 * ==============================================
 * A key that is present, non-empty and WRONG is indistinguishable from a valid
 * one until the upstream rejects it. That is not knowable here and this module
 * does not guess — the upstream's own 401/403 reason carries it.
 */

/** What we can actually establish about a configured secret, locally. */
export type ApiKeyState = "absent" | "empty" | "present";

/**
 * Classify one environment variable.
 *
 * Whitespace-only counts as EMPTY: a value of " " is a paste accident, not a
 * key, and treating it as present would send a blank Authorization header
 * upstream and turn a local misconfiguration into a remote auth error.
 */
export function classifyApiKey(raw: string | undefined): ApiKeyState {
  if (raw === undefined) return "absent";
  if (raw.trim() === "") return "empty";
  return "present";
}

/**
 * The machine-readable `reason` for a key that cannot be used.
 *
 * `envVar` is the NAME of the variable, never its value. Nothing in this module
 * accepts, returns, logs or interpolates a key value — the name is the whole
 * point, and the value is never needed to describe the fault.
 */
export function apiKeyFailureReason(state: "absent" | "empty", provider: "google" | "foursquare"): string {
  // ABSENT keeps its existing wire string. That contract predates this module,
  // clients already classify it, and renaming it would churn a working signal
  // to no benefit — the defect was never that "absent" was misnamed, it was
  // that EMPTY had no name of its own and borrowed this one.
  if (state === "absent") {
    return provider === "google" ? "no_google_maps_key" : "no_foursquare_key";
  }
  return `${provider}_key_present_but_empty`;
}

/**
 * The operator-facing sentence. Says which variable, which state, and what to
 * do — without ever quoting the value.
 */
export function apiKeyFailureMessage(state: "absent" | "empty", envVar: string): string {
  if (state === "absent") {
    return (
      `${envVar} is not set in this environment. No request will be attempted and every ` +
      `lookup will return no photo, which is indistinguishable from a place that has none. ` +
      `Set the secret, then redeploy.`
    );
  }
  return (
    `${envVar} IS SET BUT ITS VALUE IS EMPTY. This is not the same as "not configured": the ` +
    `secret exists and appears configured in any list that shows names rather than values, ` +
    `yet it cannot authenticate anything. Nothing will be sent upstream. Check the secret's ` +
    `VALUE, not its presence, then redeploy.`
  );
}

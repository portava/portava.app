/**
 * publicIdentity — the single choke point for the universal display-name rule.
 *
 * RULE: any reference to another user defaults to their @handle. A user's
 * real/display name is only included in API responses when that user has
 * explicitly opted in via profile_privacy_settings.show_real_name.
 *
 * Enforcement is server-side (redaction), not client-side (styling): a hidden
 * name must never leave the API in any response that describes another user.
 * The authenticated viewer always sees their own full identity.
 *
 * Avatars, verified badges, trust indicators and other metadata are NOT
 * affected by this rule.
 *
 * FAIL-CLOSED: if the privacy table/column is missing or the lookup errors,
 * every name is treated as hidden (empty allow-set). Opt-in default is false,
 * so this is also the correct behavior for rows that don't exist yet.
 */

export interface IdentityRow {
  id?: string | null;
  name?: string | null;
  display_name?: string | null;
  full_name?: string | null;
  handle?: string | null;
  username?: string | null;
  [k: string]: any;
}

/**
 * Column-drift shim: some profile rows were written under the legacy
 * handle/name columns, others under the newer username/full_name columns —
 * both sets currently coexist live and are inconsistently populated per row.
 * Always resolve through these helpers rather than reading handle/name/
 * username/full_name directly, or a row populated under only one column
 * family will render as "Unknown"/no handle.
 */
export function resolveHandle(row: IdentityRow | null | undefined): string | null {
  if (!row) return null;
  const h = row.handle ?? row.username ?? null;
  return typeof h === "string" && h.trim().length > 0 ? h : null;
}

/**
 * What a single profile read established about an ACTOR's handle.
 *
 * `handle: null` means NO HANDLE IS KNOWN, and `unreadable` says which kind of
 * not-known it is — the same two-field shape, and the same house rule (AN
 * UNREADABLE X IS NOT AN EMPTY X), that `SenderLanguagePreference` uses one
 * layer down in `services/messageTranslation.ts`.
 */
export interface ActorHandleClaim {
  /** The handle we may print, or null when none is known. */
  readonly handle: string | null;
  /** True ONLY when the read failed — never "this user has no handle". */
  readonly unreadable: boolean;
}

/**
 * actorHandleFrom — the interpreter of a "who did this?" profile read.
 *
 * WHAT THIS REPLACES, at the mention-notification site in `routes/messaging.ts`:
 *
 *     const { data: taggerProfile } = await sc.from('profiles')
 *       .select('handle, username').eq('id', user.id).single();
 *     const taggerHandle = resolveHandle(taggerProfile as any) ?? 'someone';
 *
 * supabase-js RESOLVES on a database error, so `data` was null and the error was
 * never bound, and `'someone'` was then written into a notification that every
 * mentioned user reads. Three worlds arrived at that literal: the tagger has no
 * handle, the tagger has no profile row, and `profiles` COULD NOT BE READ.
 *
 * `.single()` is why binding the error is not on its own enough, and it is the
 * reason census-telegraph §16.4 left this site alone: `.single()` returns
 * PGRST116 when NO ROW MATCHES as well as when the table is unreadable, so a
 * caller that merely checked `error` would report a handle-less tagger as an
 * outage. The call site moves to `.maybeSingle()` and asks this function, which
 * is the only place the three worlds are told apart.
 *
 * `error` is typed `unknown` on purpose: callers pass a PostgrestError and the
 * only thing this needs from it is whether it is there.
 */
export function actorHandleFrom(
  row: IdentityRow | null | undefined,
  error: unknown,
): ActorHandleClaim {
  // The read failed. We do not know who this is, and no handle may be claimed
  // from a row we cannot trust — including one a caller happened to pass in.
  if (error) return { handle: null, unreadable: true };
  return { handle: resolveHandle(row), unreadable: false };
}

/**
 * Batched lookup: which of these users have opted in to showing their name?
 * One query regardless of list size. Errors → empty set (fail closed).
 */
export async function nameVisibilitySet(sc: any, userIds: Array<string | null | undefined>): Promise<Set<string>> {
  const ids = [...new Set(userIds.filter((x): x is string => typeof x === "string" && x.length > 0))];
  if (ids.length === 0) return new Set();
  try {
    const { data, error } = await sc
      .from("profile_privacy_settings")
      .select("user_id")
      .in("user_id", ids)
      .eq("show_real_name", true);
    if (error) return new Set();
    return new Set((((data as any[]) ?? []).map((r) => r.user_id as string)));
  } catch {
    return new Set();
  }
}

/** Convenience for single-user routes. */
export async function nameVisibleFor(sc: any, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return (await nameVisibilitySet(sc, [userId])).has(userId);
}

/**
 * The presented name for a user, honoring the rule:
 * display_name/name when allowed, otherwise null (callers show @handle).
 */
export function presentedName(row: IdentityRow | null | undefined, allowed: boolean): string | null {
  if (!row || !allowed) return null;
  const n = (row.display_name ?? row.name ?? row.full_name ?? null);
  return typeof n === "string" && n.trim().length > 0 ? n : null;
}

/**
 * Redact name fields on a profile-like row IN PLACE-SAFE COPY unless allowed.
 * `viewerId` short-circuits: users always see themselves unredacted.
 * Only name/display_name are touched — handle, username, avatar_url, badges,
 * ids and all other fields pass through untouched.
 */
export function sanitizeIdentity<T extends IdentityRow | null | undefined>(
  row: T,
  allowedSet: Set<string>,
  viewerId?: string | null,
): T {
  if (!row) return row;
  const id = row.id ?? null;
  if (id && viewerId && id === viewerId) return row;
  if (id && allowedSet.has(id)) return row;
  const copy: any = { ...row };
  if ("name" in copy) copy.name = null;
  if ("display_name" in copy) copy.display_name = null;
  if ("full_name" in copy) copy.full_name = null;
  return copy;
}

/**
 * Sanitize a camelCase API-shape object (name/displayName/hostName style keys)
 * when the owner of the identity is known. Returns a copy.
 */
export function sanitizeIdentityKeys<T extends Record<string, any>>(
  obj: T,
  ownerId: string | null | undefined,
  keys: string[],
  allowedSet: Set<string>,
  viewerId?: string | null,
): T {
  if (!obj || !ownerId) return obj;
  if (viewerId && ownerId === viewerId) return obj;
  if (allowedSet.has(ownerId)) return obj;
  const copy: any = { ...obj };
  for (const k of keys) if (k in copy) copy[k] = null;
  return copy;
}

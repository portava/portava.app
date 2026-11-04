/**
 * hotPathCache — what ONE API instance remembers between requests on the
 * authentication and feature-flag hot path, and the rules that stop each memory
 * from outliving the fact it remembers.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * Every authenticated request paid two network round trips before a route ran:
 * Supabase Auth's `getUser` (GoTrue) to verify the bearer token, then the
 * `profiles` + embedded `user_account_states` read behind the ban gate
 * (lib/accountStateGate.ts). Every shared flag reader in lib/featureFlags.ts
 * read `feature_flags` on every call, and getServiceClient (lib/supabase.ts)
 * built a new supabase-js client on every call. Nothing was remembered.
 *
 * ── WHAT IS REMEMBERED ───────────────────────────────────────────────────────
 *   verified tokens   key    sha256(bearer token), hex. The raw token is never
 *                            stored, logged or used as a key.
 *                     value  the User `auth.getUser` answered (a structured
 *                            clone, and a fresh clone on every hit, so no route
 *                            can mutate another request's identity).
 *                     TTL    min(30s, the token's own `exp` − 5s). A token whose
 *                            `exp` cannot be read, or that has 5s or less left,
 *                            is never stored: it is re-verified every time.
 *   account state     key    user id.
 *                     value  NOTHING but "readable, unrestricted, active": the
 *                            map holds an expiry instant and no answer, so it
 *                            cannot hold a refusal even by mistake.
 *                     TTL    30s.
 *   flag rows         key    (selected columns, flag name).
 *                     value  the row `maybeSingle()` answered, or "no row".
 *                     TTL    15s.
 * Each map is bounded (MAX_* below) and evicts its OLDEST entry first.
 *
 * ── WHAT IS NEVER REMEMBERED ─────────────────────────────────────────────────
 * Any failure or unreadable answer. A rejected or expired token, the auth
 * service's banned refusal (GoTrue `user_banned`), an Auth call that threw, a
 * token of a revoked device session; an unreadable account state, a ban or
 * suspension in force, any `account_status` other than `active` (deleted,
 * deactivated, pending_deletion are read every time); a flag read that errored
 * or threw. So every fail-closed branch in lib/http.ts, lib/accountStateGate.ts
 * and lib/featureFlags.ts still runs on every failure: an unreadable state is
 * still a 503, and `isKillSwitchEngaged` still ENGAGES on a failed read, because
 * a failed read is never turned into a remembered answer.
 *
 * ── INVALIDATION ON THIS INSTANCE ────────────────────────────────────────────
 *   invalidateUserAuthCache(userId)  drops the user's verified tokens AND their
 *     account state. Called after: a device-session revocation, which is also
 *     the API's sign-out (lib/deviceRevocation.ts revokeDevice); a verification
 *     that finds its token's session revoked (lib/accountStateGate.ts — the path
 *     that ends that session in GoTrue); a ban or suspension write
 *     (lib/accountModeration.ts applyAccountRestriction, the one writer every
 *     admin moderation route goes through); account deletion
 *     (AccountDeletionService, after the tombstone and after the auth user is
 *     deleted).
 *   invalidateFeatureFlagCache()  drops every remembered flag row. Called after
 *     every flag write the API makes (routes/admin.ts PATCH
 *     /admin/feature-flags/:flag, .../:flag/metadata and /admin/safe-return/config;
 *     routes/adminVisuals.ts, adminCompass.ts, adminRankingConfig.ts,
 *     notifications.ts, circle.ts). It also advances `featureFlagWriteEpoch()`,
 *     which the older per-client flag caches (lib/discoveryStopGate.ts,
 *     lib/discoveryCandidates/pipelineFlags.ts, lib/telegraphOutboxDrainScheduler.ts)
 *     compare, so a write on this instance ends their entries too.
 * Invalidation runs AFTER the write it follows has returned, and advances a
 * generation counter: a read that was already in flight when it ran (and may
 * have seen the state from before the write) is not stored when it lands.
 *
 * ── THE CROSS-INSTANCE BOUND ─────────────────────────────────────────────────
 * Instances do NOT share these maps and nothing tells one instance what another
 * wrote. The TTL is therefore the bound for every change made elsewhere — on
 * another instance, or outside the API altogether (GoTrue directly, a SQL
 * console, a migration): a ban, suspension, device revocation, sign-out or
 * account deletion takes effect here within 30s; a flag change within 15s. On
 * the instance that made the change through the API, it takes effect on the
 * next request. A request served from memory in that window is served exactly
 * as it would have been served the moment before the change.
 *
 * ── WHICH CLIENTS ────────────────────────────────────────────────────────────
 * Only answers from a client lib/supabase.ts built (the one service client,
 * `markHotPathCacheableClient`) are remembered, because the maps are keyed by
 * token / user / flag and not by client: an answer from anything else — a
 * write-suppressed shadow client, a hand-built client, a test double — could
 * otherwise be served to the real path. Every other client reads through, as it
 * always did, which is also what keeps the existing test suites isolated: a
 * suite that changes its fake between cases sees every read. A suite that means
 * to exercise the caches opts its double in with `_markHotPathCacheableForTest`
 * and empties them with `_resetHotPathCachesForTest` (lib/supabase.ts's
 * `_setTestServiceClient` empties them too, on every injection).
 */
import crypto from "node:crypto";
import type { User } from "@supabase/supabase-js";
import { originalLayoverAuditClient } from "./layoverServiceAudit.js";

/** Longest a verified token is remembered. */
export const VERIFIED_TOKEN_MAX_TTL_MS = 30_000;
/** A token is remembered only until this long before its own `exp`, and not at all with less left. */
export const VERIFIED_TOKEN_EXPIRY_MARGIN_MS = 5_000;
/** How long a readable, unrestricted, active account state is remembered. */
export const ACCOUNT_STATE_TTL_MS = 30_000;
/** How long a flag row is remembered. */
export const FLAG_ROW_TTL_MS = 15_000;

export const MAX_VERIFIED_TOKENS = 5_000;
export const MAX_ACCOUNT_STATES = 10_000;
export const MAX_FLAG_ROWS = 2_000;

// ── Which clients ────────────────────────────────────────────────────────────

const cacheableClients = new WeakSet<object>();

/** Called by lib/supabase.ts for the client it builds. Nothing else may call it. */
export function markHotPathCacheableClient(client: object): void {
  cacheableClients.add(client);
}

/** Test-only: let a double's answers be remembered, to exercise the caches. */
export function _markHotPathCacheableForTest(client: object): void {
  cacheableClients.add(client);
}

/** Whether answers read through `client` may be remembered (see WHICH CLIENTS). */
export function isHotPathCacheableClient(client: unknown): boolean {
  if (!client || typeof client !== "object") return false;
  return cacheableClients.has(client) || cacheableClients.has(originalLayoverAuditClient(client) as object);
}

// ── Generations ──────────────────────────────────────────────────────────────

let authGeneration = 0;
let flagGeneration = 0;
let flagWriteEpoch = 0;

/** Read BEFORE a verification or account-state read; pass to the matching remember* call. */
export function authCacheGeneration(): number {
  return authGeneration;
}

/** Read BEFORE a flag read; pass to rememberFlagRow. */
export function flagCacheGeneration(): number {
  return flagGeneration;
}

/** Advances on every invalidateFeatureFlagCache (a flag write on this instance), and on nothing else. */
export function featureFlagWriteEpoch(): number {
  return flagWriteEpoch;
}

// ── Bounded maps ─────────────────────────────────────────────────────────────

/** Insert as the NEWEST entry, evicting the oldest while over `max`. A Map iterates in insertion order. */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

// ── Verified tokens ──────────────────────────────────────────────────────────

interface VerifiedEntry { userId: string; user: User; until: number }
const verifiedTokens = new Map<string, VerifiedEntry>();

/** sha256 of the bearer token, hex: the only form in which a token is ever kept. */
export function tokenCacheKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The token's `exp` claim in ms, or null. Read only to BOUND how long a token
 * GoTrue has just verified may be remembered; it never admits anything.
 */
function tokenExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const exp = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** How long this token may be remembered from `nowMs`: 0 means never. */
export function verifiedTokenTtlMs(token: string, nowMs: number = Date.now()): number {
  const expMs = tokenExpiryMs(token);
  if (expMs === null) return 0;
  const ttl = Math.min(VERIFIED_TOKEN_MAX_TTL_MS, expMs - nowMs - VERIFIED_TOKEN_EXPIRY_MARGIN_MS);
  return ttl > 0 ? ttl : 0;
}

/** The remembered verified user for this token (a fresh clone), or null. */
export function rememberedVerifiedUser(token: string, nowMs: number = Date.now()): User | null {
  const key = tokenCacheKey(token);
  const entry = verifiedTokens.get(key);
  if (!entry) return null;
  if (nowMs >= entry.until) {
    verifiedTokens.delete(key);
    return null;
  }
  return structuredClone(entry.user);
}

/**
 * Remember a SUCCESSFUL verification. The caller passes only a user `getUser`
 * answered with no error, for a token whose session is not revoked; anything
 * else is the caller's bug, so the shape is checked again here. Returns whether
 * it was stored.
 */
export function rememberVerifiedUser(token: string, user: User, generation: number, nowMs: number = Date.now()): boolean {
  if (generation !== authGeneration) return false; // an invalidation ran while this was in flight
  if (!user || typeof user !== "object" || typeof user.id !== "string" || user.id === "") return false;
  const ttl = verifiedTokenTtlMs(token, nowMs);
  if (ttl <= 0) return false;
  let copy: User;
  try { copy = structuredClone(user); } catch { return false; }
  setBounded(verifiedTokens, tokenCacheKey(token), { userId: user.id, user: copy, until: nowMs + ttl }, MAX_VERIFIED_TOKENS);
  return true;
}

// ── Account state ────────────────────────────────────────────────────────────

const activeAccounts = new Map<string, number>(); // user id → remembered-until

/** Whether this user's state was last read readable, unrestricted and active, less than ACCOUNT_STATE_TTL_MS ago. */
export function isAccountStateRememberedActive(userId: string, nowMs: number = Date.now()): boolean {
  const until = activeAccounts.get(userId);
  if (until === undefined) return false;
  if (nowMs >= until) {
    activeAccounts.delete(userId);
    return false;
  }
  return true;
}

/** Remember that the gate's read answered readable, unrestricted, active. Nothing else can be remembered. */
export function rememberAccountStateActive(userId: string, generation: number, nowMs: number = Date.now()): boolean {
  if (generation !== authGeneration) return false;
  if (typeof userId !== "string" || userId === "") return false;
  setBounded(activeAccounts, userId, nowMs + ACCOUNT_STATE_TTL_MS, MAX_ACCOUNT_STATES);
  return true;
}

// ── Flag rows ────────────────────────────────────────────────────────────────

const flagRows = new Map<string, { row: unknown; until: number }>();

export function flagRowCacheKey(columns: string, flag: string): string {
  return `${columns}\u0000${flag}`;
}

/** The remembered row (a fresh clone; null = no such row), or undefined when nothing fresh is remembered. */
export function rememberedFlagRow(key: string, nowMs: number = Date.now()): { row: unknown } | undefined {
  const entry = flagRows.get(key);
  if (!entry) return undefined;
  if (nowMs >= entry.until) {
    flagRows.delete(key);
    return undefined;
  }
  return { row: structuredClone(entry.row) };
}

/** Remember a flag read that SUCCEEDED: `row` is the row, or null for no row. Errors are never passed here. */
export function rememberFlagRow(key: string, row: unknown, generation: number, nowMs: number = Date.now()): boolean {
  if (generation !== flagGeneration) return false;
  let copy: unknown;
  try { copy = structuredClone(row); } catch { return false; }
  setBounded(flagRows, key, { row: copy, until: nowMs + FLAG_ROW_TTL_MS }, MAX_FLAG_ROWS);
  return true;
}

// ── Invalidation ─────────────────────────────────────────────────────────────

/** Forget everything remembered about this user's admission. Call AFTER the write that changed it. */
export function invalidateUserAuthCache(userId: string | null | undefined): void {
  authGeneration += 1;
  if (typeof userId !== "string" || userId === "") return;
  activeAccounts.delete(userId);
  for (const [key, entry] of verifiedTokens) {
    if (entry.userId === userId) verifiedTokens.delete(key);
  }
}

/** Forget every remembered flag row. Call AFTER a flag write, whatever its outcome. */
export function invalidateFeatureFlagCache(): void {
  flagGeneration += 1;
  flagWriteEpoch += 1;
  flagRows.clear();
}

// ── Test hooks ───────────────────────────────────────────────────────────────

/** Test-only: empty every map. Opted-in clients stay opted in. */
export function _resetHotPathCachesForTest(): void {
  authGeneration += 1;
  flagGeneration += 1;
  verifiedTokens.clear();
  activeAccounts.clear();
  flagRows.clear();
}

/** Test-only: what is held, so a suite can prove the raw token is not a key and the bounds hold. */
export function _hotPathCacheContentsForTest(): { tokenKeys: string[]; accountUserIds: string[]; flagKeys: string[] } {
  return { tokenKeys: [...verifiedTokens.keys()], accountUserIds: [...activeAccounts.keys()], flagKeys: [...flagRows.keys()] };
}

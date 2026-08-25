/**
 * Prompt-pause storage for Intelligence Gathering capture prompts.
 *
 * The spec requires the traveler can silence capture prompts at three scopes:
 *   • per session   — until the app is next launched (in-memory, never persisted)
 *   • per category  — a venue category (nightlife, restaurant, …) permanently
 *   • permanent     — every capture prompt, everywhere
 *
 * Follows the app's `*Storage.ts` convention: a pure module that takes a
 * `StorageLike`, JSON-encodes values, swallows write errors (fire-and-forget),
 * validates on read (bad/missing → defaults), and keeps a synchronous
 * module-level cache so a screen can seed `useState` without a defaults flash.
 *
 * RUNTIME EFFECT: NONE beyond AsyncStorage reads/writes. This does not itself
 * suppress anything — `useIntelPrompts` reads it and decides.
 */
import type { VenueCategory } from './contracts.ts';

export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** The persisted (durable) part of the pause state. */
export interface PersistedPromptPause {
  /** Silence every capture prompt everywhere. */
  pausedAll: boolean;
  /** Venue categories (plus 'general') silenced permanently. */
  pausedCategories: string[];
}

export const PROMPT_PAUSE_STORAGE_KEY = 'intel_prompt_pause_v1';

const DEFAULTS: PersistedPromptPause = { pausedAll: false, pausedCategories: [] };

// Synchronous cache for lazy useState init (avoids a defaults flash on remount).
let _memoryCache: PersistedPromptPause = { ...DEFAULTS };
// Session pause is intentionally in-memory only: it must not survive a relaunch.
let _sessionPaused = false;

export function cachedPromptPause(): PersistedPromptPause {
  return { pausedAll: _memoryCache.pausedAll, pausedCategories: [..._memoryCache.pausedCategories] };
}

function sanitize(raw: unknown): PersistedPromptPause {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const pausedAll = r.pausedAll === true;
  const pausedCategories = Array.isArray(r.pausedCategories)
    ? r.pausedCategories.filter((c): c is string => typeof c === 'string')
    : [];
  return { pausedAll, pausedCategories };
}

export async function loadPromptPause(storage: StorageLike): Promise<PersistedPromptPause> {
  try {
    const raw = await storage.getItem(PROMPT_PAUSE_STORAGE_KEY);
    if (!raw) {
      _memoryCache = { ...DEFAULTS };
      return cachedPromptPause();
    }
    _memoryCache = sanitize(JSON.parse(raw));
    return cachedPromptPause();
  } catch {
    _memoryCache = { ...DEFAULTS };
    return cachedPromptPause();
  }
}

export function savePromptPause(storage: StorageLike, state: PersistedPromptPause): void {
  _memoryCache = { pausedAll: state.pausedAll, pausedCategories: [...state.pausedCategories] };
  storage.setItem(PROMPT_PAUSE_STORAGE_KEY, JSON.stringify(_memoryCache)).catch(() => {});
}

// ── Category helpers ─────────────────────────────────────────────────────────
export function isCategoryPaused(state: PersistedPromptPause, category: VenueCategory | 'general'): boolean {
  return state.pausedCategories.includes(category);
}

export function setCategoryPaused(
  state: PersistedPromptPause,
  category: VenueCategory | 'general',
  paused: boolean,
): PersistedPromptPause {
  const set = new Set(state.pausedCategories);
  if (paused) set.add(category);
  else set.delete(category);
  return { ...state, pausedCategories: [...set] };
}

// ── Session pause (in-memory) ────────────────────────────────────────────────
export function isSessionPaused(): boolean {
  return _sessionPaused;
}
export function setSessionPaused(paused: boolean): void {
  _sessionPaused = paused;
}

// ── The combined decision ────────────────────────────────────────────────────
/**
 * True when a capture prompt should be suppressed for this scope. `permanent`
 * and `category` come from the durable state; `session` is the in-memory flag.
 */
export function isPromptPaused(
  state: PersistedPromptPause,
  category?: VenueCategory | 'general',
): boolean {
  if (_sessionPaused) return true;
  if (state.pausedAll) return true;
  if (category && state.pausedCategories.includes(category)) return true;
  return false;
}

/** Reset everything (test seam + a "resume all" affordance). */
export async function clearPromptPause(storage: StorageLike): Promise<void> {
  _memoryCache = { ...DEFAULTS };
  _sessionPaused = false;
  try {
    await storage.removeItem(PROMPT_PAUSE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * useAvailabilityEditor — data hook for the Passport Availability editor
 * (spec §6/§7/§8, TABLE 7/8/9/10).
 *
 * It edits three real backend surfaces the availability router already exposes
 * (all reused, none rebuilt):
 *
 *   1. The §8 AvailabilityWindow — the current one-time "Open to Plans" window
 *      with intents, group preference, travel distance and a social-availability
 *      level. Persisted through the /api/me/availability-windows endpoints, which
 *      always stamp source='explicit' (this hook also sends it explicitly).
 *   2. The §6 weekly recurring grid (weekday → time blocks) via
 *      GET/PATCH /api/me/availability.
 *
 * Two spec rules are load-bearing and enforced here, not just at the server:
 *
 *   §7  Only an EXPLICIT user answer becomes public/shared availability. The
 *       screen's "Set Availability" action IS that explicit answer, so writes go
 *       out with source='explicit'. An INFERRED (plan_derived) window is never
 *       surfaced as the current public status — `pickCurrentWindow` filters to
 *       source==='explicit'. If the only active window is inferred, the hook
 *       exposes it separately as a PRIVATE "Free tonight?" prompt instead.
 *   §31 Never render an expired window as current. `pickCurrentWindow` re-checks
 *       expiry against COALESCE(expiresAt, endAt) on every read; a window past
 *       that horizon is never returned as current, regardless of server sweeps.
 *
 * The pure helpers (`isWindowExpired`, `pickCurrentWindow`, `pickInferredPrompt`,
 * `defaultTonightWindow`) are exported for direct unit/component testing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getMyAvailability,
  patchMyAvailability,
  getMyAvailabilityWindows,
  createMyAvailabilityWindow,
  patchMyAvailabilityWindow,
  deleteMyAvailabilityWindow,
  type AvailabilityWindow,
  type IntentType,
  type GroupPreference,
  type SocialAvailability,
  type VisibilityPolicy,
  type Weekday,
  type TimeBlock,
} from '../../services/availability.ts';

// ── Pure expiry helpers (§31) — no I/O, safe to unit-test ──────────────────────

/** The instant a window stops being current: its TTL if set, else its end. */
export function effectiveExpiryMs(w: Pick<AvailabilityWindow, 'endAt' | 'expiresAt'>): number {
  const end = Date.parse(w.endAt);
  if (w.expiresAt) {
    const ttl = Date.parse(w.expiresAt);
    if (!Number.isNaN(ttl)) return Number.isNaN(end) ? ttl : Math.min(end, ttl);
  }
  return end;
}

/** §31: a window is expired once now >= COALESCE(expiresAt, endAt). */
export function isWindowExpired(w: Pick<AvailabilityWindow, 'endAt' | 'expiresAt'>, nowMs: number): boolean {
  const horizon = effectiveExpiryMs(w);
  if (Number.isNaN(horizon)) return true; // unparseable → treat as not-current
  return nowMs >= horizon;
}

/**
 * The window to display as the CURRENT public/shared availability status.
 *
 * §7: only source==='explicit' windows qualify — an inferred window is never
 * presented as a public status. §31: expired windows are excluded. Among the
 * qualifying windows, the soonest-ending one is chosen so "current" always tracks
 * the nearest live commitment.
 */
export function pickCurrentWindow(
  windows: readonly AvailabilityWindow[],
  nowMs: number,
): AvailabilityWindow | null {
  const live = windows
    .filter((w) => w.source === 'explicit' && !isWindowExpired(w, nowMs))
    .sort((a, b) => effectiveExpiryMs(a) - effectiveExpiryMs(b));
  return live[0] ?? null;
}

/**
 * §7 inference path: the active INFERRED (plan_derived) window, if any, that
 * should drive a PRIVATE "Free tonight?" prompt — never a public status. Returns
 * null when there is none (or when an explicit window already covers the moment).
 */
export function pickInferredPrompt(
  windows: readonly AvailabilityWindow[],
  nowMs: number,
): AvailabilityWindow | null {
  const inferred = windows
    .filter((w) => w.source === 'plan_derived' && !isWindowExpired(w, nowMs))
    .sort((a, b) => effectiveExpiryMs(a) - effectiveExpiryMs(b));
  return inferred[0] ?? null;
}

/** Default one-time window: tonight 8 PM → 1 AM (local), per TABLE 9. */
export function defaultTonightWindow(nowMs: number = Date.now()): { startAt: string; endAt: string } {
  const start = new Date(nowMs);
  start.setHours(20, 0, 0, 0);
  const end = new Date(nowMs);
  end.setHours(25, 0, 0, 0); // 1 AM the next day
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

// ── Editable draft ─────────────────────────────────────────────────────────────

export interface AvailabilityDraft {
  openToPlans: boolean;
  intents: IntentType[];
  groupPreference: GroupPreference | null;
  maxTravelMinutes: number | null;
  socialAvailability: SocialAvailability;
  startAt: string;
  endAt: string;
  /** §6: "Available does not mean open to strangers" — default is not public. */
  visibility: VisibilityPolicy;
}

function draftFromWindow(w: AvailabilityWindow): AvailabilityDraft {
  return {
    openToPlans: w.openToPlans,
    intents: [...w.intents],
    groupPreference: w.groupPreference,
    maxTravelMinutes: w.maxTravelMinutes,
    socialAvailability: w.socialAvailability ?? 'not_open',
    startAt: w.startAt,
    endAt: w.endAt,
    visibility: w.visibility,
  };
}

function emptyDraft(nowMs: number): AvailabilityDraft {
  const { startAt, endAt } = defaultTonightWindow(nowMs);
  return {
    openToPlans: false,
    intents: [],
    groupPreference: null,
    maxTravelMinutes: null,
    socialAvailability: 'not_open',
    startAt,
    endAt,
    visibility: 'followers',
  };
}

// ── Hook result ────────────────────────────────────────────────────────────────

export interface SaveResult {
  ok: boolean;
  /** false when the Open-to-Plans window feature flag is off server-side. */
  enabled: boolean;
  message?: string;
}

export interface UseAvailabilityEditorResult {
  loading: boolean;
  error: string | null;
  saving: boolean;
  /** Whether the §8 window feature is enabled server-side (flag-gated). */
  windowsEnabled: boolean;

  /** The current explicit, non-expired window (§7/§31) or null. */
  currentWindow: AvailabilityWindow | null;
  /** An inferred window driving a PRIVATE "Free tonight?" prompt (§7) or null. */
  inferredPrompt: AvailabilityWindow | null;

  draft: AvailabilityDraft;
  weeklyDays: Partial<Record<Weekday, TimeBlock[]>>;

  // Window draft mutators (local until save)
  setOpenToPlans: (on: boolean) => void;
  toggleIntent: (i: IntentType) => void;
  setGroupPreference: (g: GroupPreference | null) => void;
  setMaxTravelMinutes: (m: number | null) => void;
  setSocialAvailability: (s: SocialAvailability) => void;

  // Weekly grid mutator (local until save)
  toggleWeeklyBlock: (day: Weekday, block: TimeBlock) => void;

  /** Persist the EXPLICIT answer: window (create/patch) + weekly grid. */
  save: () => Promise<SaveResult>;
  /** §8 explicit clear: delete the current window. */
  clearWindow: () => Promise<void>;
  reload: () => Promise<void>;
}

/** Toggle a value's membership in an array (add if absent, remove if present). */
function toggleInArray<T>(arr: readonly T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

export function useAvailabilityEditor(): UseAvailabilityEditorResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [windowsEnabled, setWindowsEnabled] = useState(false);

  const [windows, setWindows] = useState<AvailabilityWindow[]>([]);
  const [weeklyDays, setWeeklyDays] = useState<Partial<Record<Weekday, TimeBlock[]>>>({});
  const [draft, setDraft] = useState<AvailabilityDraft>(() => emptyDraft(Date.now()));

  // Derived: §7/§31 current + inferred selection is recomputed on every render.
  const nowMs = Date.now();
  const currentWindow = useMemo(() => pickCurrentWindow(windows, nowMs), [windows, nowMs]);
  const inferredPrompt = useMemo(() => pickInferredPrompt(windows, nowMs), [windows, nowMs]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [gridRes, winRes] = await Promise.all([
      getMyAvailability(),
      getMyAvailabilityWindows(),
    ]);

    if (!gridRes.ok && !winRes.ok) {
      setError(gridRes.message ?? winRes.message ?? 'Could not load your availability');
      setLoading(false);
      return;
    }

    // Weekly grid (§6). Null data (dev / unconfigured) leaves an empty grid.
    if (gridRes.ok && gridRes.data) {
      setWeeklyDays(gridRes.data.weeklyDays ?? {});
    }

    // §8 windows. `enabled:false` (flag off) still resolves ok with no windows.
    const envelope = winRes.ok ? winRes.data : null;
    const list = envelope?.windows ?? [];
    setWindows(list);
    setWindowsEnabled(envelope?.enabled ?? false);

    // Seed the draft from the current explicit window (§7/§31), else a fresh one.
    const now = Date.now();
    const cur = pickCurrentWindow(list, now);
    setDraft(cur ? draftFromWindow(cur) : emptyDraft(now));

    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Draft mutators ────────────────────────────────────────────────────────
  const setOpenToPlans = useCallback((on: boolean) => {
    setDraft((d) => ({ ...d, openToPlans: on }));
  }, []);
  const toggleIntent = useCallback((i: IntentType) => {
    setDraft((d) => ({ ...d, intents: toggleInArray(d.intents, i) }));
  }, []);
  const setGroupPreference = useCallback((g: GroupPreference | null) => {
    setDraft((d) => ({ ...d, groupPreference: g }));
  }, []);
  const setMaxTravelMinutes = useCallback((m: number | null) => {
    setDraft((d) => ({ ...d, maxTravelMinutes: m }));
  }, []);
  const setSocialAvailability = useCallback((s: SocialAvailability) => {
    setDraft((d) => ({ ...d, socialAvailability: s }));
  }, []);

  const toggleWeeklyBlock = useCallback((day: Weekday, block: TimeBlock) => {
    setWeeklyDays((prev) => {
      const blocks = prev[day] ?? [];
      const next = toggleInArray(blocks, block);
      const copy = { ...prev };
      if (next.length === 0) delete copy[day];
      else copy[day] = next;
      return copy;
    });
  }, []);

  // ── Persist (the EXPLICIT answer, §7) ─────────────────────────────────────
  const save = useCallback(async (): Promise<SaveResult> => {
    setSaving(true);
    try {
      // 1. Weekly recurring grid (§6) — NOT flag-gated.
      const gridRes = await patchMyAvailability({ weeklyDays });
      if (!gridRes.ok) {
        return { ok: false, enabled: windowsEnabled, message: gridRes.message };
      }

      // 2. Current §8 window. Patch the existing explicit window in place; else
      //    create a fresh one-time window. source='explicit' is stamped by the
      //    service (and the server) either way (§7).
      const cur = pickCurrentWindow(windows, Date.now());
      let enabled = windowsEnabled;
      if (cur) {
        const res = await patchMyAvailabilityWindow(cur.id, {
          openToPlans: draft.openToPlans,
          intents: draft.intents,
          groupPreference: draft.groupPreference,
          maxTravelMinutes: draft.maxTravelMinutes,
          socialAvailability: draft.socialAvailability,
          endAt: draft.endAt,
          visibility: draft.visibility,
        });
        if (!res.ok) return { ok: false, enabled, message: res.message };
        if (res.data && res.data.enabled === false) enabled = false;
      } else {
        const res = await createMyAvailabilityWindow({
          type: 'one_time',
          startAt: draft.startAt,
          endAt: draft.endAt,
          openToPlans: draft.openToPlans,
          intents: draft.intents,
          groupPreference: draft.groupPreference,
          maxTravelMinutes: draft.maxTravelMinutes,
          socialAvailability: draft.socialAvailability,
          visibility: draft.visibility,
          source: 'explicit',
        });
        if (!res.ok) return { ok: false, enabled, message: res.message };
        if (res.data && res.data.enabled === false) enabled = false;
      }

      await load();
      return { ok: true, enabled };
    } finally {
      setSaving(false);
    }
  }, [weeklyDays, windows, windowsEnabled, draft, load]);

  const clearWindow = useCallback(async () => {
    const cur = pickCurrentWindow(windows, Date.now());
    if (cur) await deleteMyAvailabilityWindow(cur.id);
    await load();
  }, [windows, load]);

  return {
    loading,
    error,
    saving,
    windowsEnabled,
    currentWindow,
    inferredPrompt,
    draft,
    weeklyDays,
    setOpenToPlans,
    toggleIntent,
    setGroupPreference,
    setMaxTravelMinutes,
    setSocialAvailability,
    toggleWeeklyBlock,
    save,
    clearWindow,
    reload: load,
  };
}
